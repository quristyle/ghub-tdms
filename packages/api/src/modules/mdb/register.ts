import type pg from 'pg'
import { tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'
import { invalidate } from '../../core/cache.js'
import {
  bucketUploads, duplicateGroups, pairingFolderForExt, splitBucketKey, yearFromTopFolder,
  type UploadEntry,
} from './grouping.js'

/**
 * MDB 자료 등록 — 신규추가(여러 파일) · Zip 폴더 업로드 · 파일 교체가 함께 쓰는 저장 규칙.
 * (기존 mdb_editor.py 의 bucket_uploads / store_uploads / replace_file)
 *
 *   · 같은 폴더에 이름이 같고 확장자만 다른 파일(A.xls + A.pdf)은 자료 1건 — 묻지 않고 합친다
 *   · 같은 이름이 **같은 형식**으로 2개 이상이면 비정상이라 먼저 확인을 받는다
 *   · 같은 자리에 같은 자료명이 이미 있으면 새 자료를 만들지 않는다 — 없는 형식만 붙이고
 *     이미 있는 형식은 덮어쓰지 않고 건너뛴다 (같은 Zip 을 두 번 올려도 두 벌이 생기지 않는다)
 *   · 기존 자료에 붙는 파일은 자료 단위 정보(설비유형·자료유형·Note·공사·연도·Tag)를 물려받는다
 */

/** 이미 blob 으로 저장된 파일 하나 */
export interface StoredFile {
  sha256: Buffer
  byteSize: number
}

export type RegisterEntry = UploadEntry<StoredFile>

export interface RegisterOutcome {
  created: number
  attached: number
  foldersCreated: number
  skipped: string[]
}

/** 확장자만 믿지 않는다 — 앞머리 바이트로 한 번 더 본다 (imports/routes.ts 와 같은 규칙) */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  dwg: (b) => b.subarray(0, 2).toString('latin1') === 'AC',
}

/** 쓸 만한 파일인지 — 문제가 있으면 사유 문자열, 괜찮으면 null */
export function unusableReason(stored: { byteSize: number; head: Buffer }, ext: string): string | null {
  if (stored.byteSize === 0) return '내용이 비어 있습니다'
  const check = MAGIC[ext]
  if (check && !check(stored.head)) return `내용이 .${ext} 형식이 아닙니다`
  return null
}

export function checkDuplicates(entries: { folder: string; filename: string; ext: string }[]) {
  return duplicateGroups(
    bucketUploads(entries.map((e) => ({ ...e, pairing: null, data: null }))),
  )
}

export async function assertTargetFolder(c: pg.PoolClient | null, folderId: number | null) {
  if (folderId === null) return
  const run = async (cl: pg.PoolClient) => {
    const r = await cl.query<{ doc_class: string; is_archived: boolean }>(
      'SELECT doc_class, is_archived FROM folders WHERE id = $1', [folderId],
    )
    const f = r.rows[0]
    if (!f || f.is_archived) throw Errors.notFound('등록할 폴더')
    if (f.doc_class !== 'MDB') throw Errors.invalid('CLASS_MISMATCH', 'MDB 폴더가 아닙니다.')
  }
  if (c) await run(c)
  else await tx(run)
}

// ── 폴더 · 공사 · 연도 ──────────────────────────────────────────────────

class FolderResolver {
  private cache = new Map<string, number | null>()
  private topCache = new Map<number, { projectId: number | null; year: number | null }>()
  created = 0

  constructor(private c: pg.PoolClient, private rootId: number | null, private userId: number) {}

  /** 대상 폴더 기준 상대 경로("/" 구분) → 폴더 id. 없으면 만든다. 쓸 수 없으면 null. */
  async resolve(rel: string): Promise<number | null> {
    if (this.cache.has(rel)) return this.cache.get(rel)!
    let id: number | null
    if (!rel) {
      id = this.rootId
    } else {
      const parts = rel.split('/')
      const name = parts.pop()!
      const parent = await this.resolve(parts.join('/'))
      if (parent === null && parts.length) id = null
      else id = await this.childOf(parent, name)
    }
    this.cache.set(rel, id)
    return id
  }

  private async childOf(parentId: number | null, name: string): Promise<number | null> {
    const r = await this.c.query<{ id: number; doc_class: string; is_archived: boolean }>(
      `SELECT id, doc_class, is_archived FROM folders
        WHERE parent_id IS NOT DISTINCT FROM $1 AND name = $2 LIMIT 1`,
      [parentId, name],
    )
    const f = r.rows[0]
    if (f) {
      // 보관함에 들어간 폴더나 TDB 폴더와 이름이 겹치면 그 아래는 등록하지 않는다
      if (f.is_archived || f.doc_class !== 'MDB') return null
      return f.id
    }
    const made = await this.c.query<{ id: number }>(
      'SELECT folder_create($1,$2,$3,$4) AS id', ['MDB', parentId, name, this.userId],
    )
    this.created += 1
    return made.rows[0]!.id
  }

  /** MDB 폴더 최상위 = 공사. 최상위 이름이 공사명과 같으면 그 공사, 앞에 붙은 연도는 연도. */
  async projectAndYear(folderId: number) {
    const hit = this.topCache.get(folderId)
    if (hit) return hit
    const r = await this.c.query<{ name: string; project_id: number | null }>(
      `SELECT r.name,
              (SELECT p.id FROM projects p WHERE lower(p.name) = lower(trim(r.name)) LIMIT 1) AS project_id
         FROM folders f
         JOIN folders r ON r.id = subpath(f.path, 0, 1)::text::bigint
        WHERE f.id = $1`,
      [folderId],
    )
    const row = r.rows[0]
    const out = { projectId: row?.project_id ?? null, year: row ? yearFromTopFolder(row.name) : null }
    this.topCache.set(folderId, out)
    return out
  }
}

interface ExistingRow {
  id: number
  file_ext: string
  pairing_folder: string | null
  equipment_type: string | null
  doc_type: string | null
  note: string | null
  project_id: number | null
  year: number | null
  is_shared: boolean
  needs_check: boolean
}

export function groupRows(c: pg.PoolClient, folderId: number, title: string) {
  return c.query<ExistingRow>(
    `SELECT id, file_ext, pairing_folder, equipment_type, doc_type, note, project_id, year,
            is_shared, needs_check
       FROM mdb_files
      WHERE folder_id = $1 AND title = $2 AND NOT is_archived
      ORDER BY id`,
    [folderId, title],
  )
}

async function insertFile(
  c: pg.PoolClient,
  v: {
    folderId: number; sha256: Buffer; title: string; filename: string; ext: string
    pairing: string | null; userId: number
    equipmentType: string | null; docType: string | null; note: string | null
    projectId: number | null; year: number | null; isShared: boolean; needsCheck: boolean
  },
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO mdb_files
       (folder_id, blob_sha256, title, display_name, original_filename, file_ext, pairing_folder,
        equipment_type, doc_type, note, project_id, year, is_shared, needs_check, uploaded_by)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      v.folderId, v.sha256, v.title, v.filename, v.ext, v.pairing,
      v.equipmentType, v.docType, v.note, v.projectId, v.year, v.isShared, v.needsCheck, v.userId,
    ],
  )
  await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [v.sha256])
  return r.rows[0]!.id
}

async function copyTags(c: pg.PoolClient, fromId: number, toId: number) {
  await c.query(
    `INSERT INTO mdb_file_tags (mdb_file_id, tag_no)
     SELECT $2::bigint, tag_no FROM mdb_file_tags WHERE mdb_file_id = $1
     ON CONFLICT DO NOTHING`,
    [fromId, toId],
  )
}

/**
 * 모아둔 파일들을 자료 단위로 등록한다. 한 트랜잭션 — 반쪽만 들어가는 일이 없다.
 * onProgress(i, n) 은 자료 묶음 하나를 처리할 때마다 불린다.
 */
export async function storeEntries(
  rootFolderId: number | null,
  entries: RegisterEntry[],
  userId: number,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<RegisterOutcome> {
  const buckets = bucketUploads(entries)
  const out = await tx(async (c) => {
    const folders = new FolderResolver(c, rootFolderId, userId)
    let created = 0
    let attached = 0
    const skipped: string[] = []
    let i = 0

    for (const [key, items] of buckets) {
      i += 1
      if (onProgress && i % 20 === 0) await onProgress(i, buckets.size)
      const { folder, name } = splitBucketKey(key)
      const label = folder ? `${folder}/${name}` : name

      const folderId = await folders.resolve(folder)
      if (folderId === null) {
        skipped.push(
          folder ? `${label} (등록할 수 없는 폴더)` : `${name} (최상위에는 자료를 둘 수 없습니다 — 폴더를 고르세요)`,
        )
        continue
      }

      const existing = (await groupRows(c, folderId, name)).rows
      const exts = new Set(existing.map((r) => r.file_ext.toLowerCase()))
      const isNew = existing.length === 0
      const base = existing[0]
      const top = base ? null : await folders.projectAndYear(folderId)
      let insertedAny = false

      for (const it of items) {
        if (exts.has(it.ext)) { skipped.push(`${label}.${it.ext}`); continue }
        exts.add(it.ext)
        const pairing = base
          ? pairingFolderForExt(existing.map((r) => ({ fileExt: r.file_ext, pairingFolder: r.pairing_folder })), it.ext)
          : it.pairing
        const filename = it.ext ? `${name}.${it.ext}` : name
        const id = await insertFile(c, {
          folderId, sha256: it.data.sha256, title: name, filename, ext: it.ext, pairing, userId,
          equipmentType: base?.equipment_type ?? null,
          docType: base?.doc_type ?? null,
          note: base?.note ?? null,
          projectId: base ? base.project_id : top!.projectId,
          year: base ? base.year : top!.year,
          isShared: base?.is_shared ?? false,
          // 새 자료는 Tag No 도 설비유형도 없다 → 확인필요 (미분류 정리에서 채운다)
          needsCheck: base ? base.needs_check : true,
        })
        insertedAny = true
        if (base) {
          await copyTags(c, base.id, id)
          attached += 1
        }
      }
      if (isNew && insertedAny) created += 1
    }
    return { created, attached, skipped, foldersCreated: folders.created }
  })
  await invalidate('cache_tree')
  return out
}

// ── 파일 교체 ───────────────────────────────────────────────────────────

/**
 * 이름·Tag No·설비유형 등은 그대로 두고 내용만 바꾼다.
 * 올린 파일과 **형식이 같은 쪽**을 바꾸고, 그 형식이 없는 자료면 자료명에 맞춰 새로 붙인다.
 */
export async function replaceFile(fileId: number, file: StoredFile, ext: string, userId: number) {
  const out = await tx(async (c) => {
    const me = await c.query<{ folder_id: number; title: string; is_archived: boolean }>(
      'SELECT folder_id, title, is_archived FROM mdb_files WHERE id = $1 FOR UPDATE', [fileId],
    )
    const row = me.rows[0]
    if (!row || row.is_archived) throw Errors.notFound('자료')
    const rows = (await groupRows(c, row.folder_id, row.title)).rows
    const target = rows.find((r) => r.file_ext.toLowerCase() === ext)

    if (target) {
      const old = await c.query<{ blob_sha256: Buffer }>(
        'SELECT blob_sha256 FROM mdb_files WHERE id = $1', [target.id],
      )
      await c.query(
        'UPDATE mdb_files SET blob_sha256 = $2, updated_at = now() WHERE id = $1',
        [target.id, file.sha256],
      )
      await c.query('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = $1', [file.sha256])
      await c.query(
        'UPDATE blobs SET refcount = GREATEST(0, refcount - 1) WHERE sha256 = $1',
        [old.rows[0]!.blob_sha256],
      )
      return {
        fileId: target.id, added: false, title: row.title,
        message: `자료를 교체했습니다. (${ext.toUpperCase()})`,
      }
    }

    const base = rows[0]!
    const filename = ext ? `${row.title}.${ext}` : row.title
    const id = await insertFile(c, {
      folderId: row.folder_id, sha256: file.sha256, title: row.title, filename, ext,
      pairing: pairingFolderForExt(rows.map((r) => ({ fileExt: r.file_ext, pairingFolder: r.pairing_folder })), ext),
      userId,
      equipmentType: base.equipment_type, docType: base.doc_type, note: base.note,
      projectId: base.project_id, year: base.year, isShared: base.is_shared, needsCheck: base.needs_check,
    })
    await copyTags(c, base.id, id)
    return {
      fileId: id, added: true, title: row.title,
      message: `이 자료에 ${ext.toUpperCase()} 가 없어 새로 추가했습니다. (저장 이름: ${filename})`,
    }
  })
  await invalidate('cache_tree')
  return out
}
