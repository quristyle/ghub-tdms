import type pg from 'pg'
import type { MdbListQuery, MdbUnclassifiedQuery, MdbUpdateRequest } from '@tdms/contracts'
import { docName, fileExtOf, normalizeTypes } from './grouping.js'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { encodeCursor } from '../../core/cursor.js'
import { Errors } from '../../core/errors.js'
import * as archive from '../archive/service.js'
import * as folders from '../folders/service.js'
import * as folderQ from '../folders/queries.js'
import * as q from './queries.js'

const DOC_CLASS = 'MDB' as const

// ── 조회 ────────────────────────────────────────────────────────────────

function toItem(r: q.MdbRow) {
  return {
    id: r.id,
    title: r.title,
    displayName: r.displayName,
    folderId: r.folderId,
    folderName: r.folderName,
    fileExt: r.fileExt,
    byteSize: r.byteSize,
    equipmentType: r.equipmentType,
    docType: r.docType,
    projectName: r.projectName,
    year: r.year,
    isShared: r.isShared,
    needsCheck: r.needsCheck,
    tagCount: r.tagCount,
    files: r.files ?? [{ id: r.id, fileExt: r.fileExt }],
    hasDwg: r.hasDwg,
    hasXlsx: r.hasXlsx,
    hasEtc: r.hasEtc,
    hasPdf: r.hasPdf,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function list(qp: MdbListQuery) {
  const folderIds = await folders.scopeIds(DOC_CLASS, qp.folderId, qp.recursive)
  const rows = await q.listMdb(folderIds, qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows
  const last = items.at(-1)

  return {
    items: items.map(toItem),
    // 커서는 정렬 칸의 값을 담는다 — 안 그러면 다른 칸으로 정렬했을 때 다음 쪽이 어긋난다
    nextCursor:
      hasMore && last ? encodeCursor({ sortValue: q.sortValueOf(last, qp.sort), id: last.id }) : null,
    total: qp.cursor ? null : await q.countMdb(folderIds, qp),
  }
}

export async function detail(id: number) {
  const row = await q.findMdb(id)
  if (!row) throw Errors.notFound('자료')
  const [chain, tags] = await Promise.all([folders.ancestorChain(row.folderId), q.listTags(id)])
  return {
    ...toItem(row),
    originalFilename: row.originalFilename,
    note: row.note,
    folderPath: chain,
    tags: tags.map((t) => t.tag_no),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function meta() {
  const [equip, docTypes, projects, years] = await q.meta()
  return {
    equipmentTypes: equip.map((r) => r.v),
    docTypes: docTypes.map((r) => r.v),
    projects,
    years: years.map((r) => r.v),
  }
}

export async function suggestTags(prefix: string) {
  return { items: (await q.suggestTags(prefix)).map((r) => r.tag_no) }
}

// ── 관리 ────────────────────────────────────────────────────────────────

/**
 * 자료 정보 수정 (기존 update-info).
 *
 * 자료에 원본과 PDF 사본이 함께 있으면 **양쪽 파일에 똑같이 적용한다** — 자료명을 바꾸면
 * 파일마다 자기 확장자는 그대로 두고 이름 부분만 바뀌고(A.xls·A.pdf → B.xls·B.pdf),
 * Tag No·설비유형·자료유형·Note 도 두 파일에 같은 값이 들어간다.
 *
 *   · 설비유형·자료유형은 "Pump/Strainer" 처럼 이어 붙인 값 — 중복을 정리하고 자료유형은 정렬
 *   · Tag No 는 적은 그대로 두되 대소문자만 다른 것은 하나만 남긴다
 *   · 공용/확인필요 표시를 따로 주지 않으면 Tag No·설비유형으로 다시 정한다
 */
export async function update(id: number, v: MdbUpdateRequest) {
  await tx(async (c) => {
    const found = await q.mdbBrief(c, [id])
    const me = found.rows[0]
    if (!me) throw Errors.notFound('자료')

    // 같은 폴더 + 같은 자료명 = 자료 1건. 보관함 안의 행이면 그 행만 고친다.
    const group = me.is_archived
      ? [id]
      : (await c.query<{ id: number }>(
          `SELECT id FROM mdb_files WHERE folder_id = $1 AND title = $2 AND NOT is_archived`,
          [me.folder_id, me.title],
        )).rows.map((r) => r.id)

    let title = v.title?.trim()
    if (title) {
      title = docName(title, fileExtOf(title)) // 확장자가 딸려 왔으면 뗀다
      if (title !== me.title) {
        const clash = await c.query(
          `SELECT 1 FROM mdb_files
            WHERE folder_id = $1 AND upper(title) = upper($2) AND NOT is_archived
              AND NOT (id = ANY($3::bigint[])) LIMIT 1`,
          [me.folder_id, title, group],
        )
        if (clash.rowCount) {
          throw Errors.conflict('NAME_TAKEN', `같은 폴더에 "${title}" 자료가 이미 있습니다.`)
        }
        await c.query(
          `UPDATE mdb_files
              SET title = $2,
                  display_name = CASE WHEN file_ext = '' THEN $2 ELSE $2 || '.' || file_ext END,
                  original_filename = CASE WHEN file_ext = '' THEN $2 ELSE $2 || '.' || file_ext END,
                  updated_at = now()
            WHERE id = ANY($1::bigint[])`,
          [group, title],
        )
      }
    }

    const tags = v.tags === undefined ? undefined : dedupeTags(v.tags)
    const fields = {
      ...v,
      title: undefined,
      equipmentType: v.equipmentType === undefined ? undefined : normalizeTypes(v.equipmentType),
      docType: v.docType === undefined ? undefined : normalizeTypes(v.docType, true),
      note: v.note === undefined ? undefined : (v.note ?? '').trim() || null,
    }
    for (const fid of group) {
      await q.updateMdb(c, fid, fields)
      if (tags !== undefined) await q.replaceTags(c, fid, tags)
    }

    // 분류(전용/공용/확인필요)는 Tag No·설비유형으로 정해진다 — 직접 주지 않았으면 다시 맞춘다
    if ((v.tags !== undefined || v.equipmentType !== undefined)
        && v.isShared === undefined && v.needsCheck === undefined) {
      await c.query(
        `UPDATE mdb_files m
            SET is_shared   = (t.n = 0 AND coalesce(m.equipment_type, '') <> ''),
                needs_check = (t.n = 0 AND coalesce(m.equipment_type, '') = '')
           FROM (SELECT f.id, (SELECT count(*) FROM mdb_file_tags x WHERE x.mdb_file_id = f.id) AS n
                   FROM mdb_files f WHERE f.id = ANY($1::bigint[])) t
          WHERE m.id = t.id`,
        [group],
      )
    }
  })
}

function dedupeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    const t = r.trim()
    if (!t || seen.has(t.toUpperCase())) continue
    seen.add(t.toUpperCase())
    out.push(t)
  }
  return out.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()))
}

// ── 미분류 자료 정리 ────────────────────────────────────────────────────

export async function unclassified(v: MdbUnclassifiedQuery) {
  const rows = await q.unclassified(v)
  return {
    items: rows.map(({ total: _t, ...r }) => r),
    total: rows[0]?.total ?? 0,
  }
}

export async function move(fileIds: number[], targetFolderId: number) {
  const out = await tx(async (c) => {
    const target = await folderQ.findById(targetFolderId)
    if (!target || target.isPlaceholder === undefined) throw Errors.notFound('옮길 폴더')

    // 같은 이름이 이미 있는 건만 건너뛴다 — 전체를 막지 않는다
    const conflicts = await q.conflictingTitles(c, targetFolderId, fileIds)
    const skip = new Set(conflicts.rows.map((r) => r.id))
    const movable = fileIds.filter((id) => !skip.has(id))

    return {
      updated: movable.length ? await q.moveMdb(c, movable, targetFolderId) : 0,
      skipped: conflicts.rows.map((r) => ({
        fileId: r.id,
        reason: `옮길 폴더에 "${r.title}" 이(가) 이미 있습니다.`,
      })),
    }
  })
  await invalidate('cache_tree')
  return out
}

/** 설비유형 일괄 변경 — 기존 화면의 전용 기능 */
export async function bulkEquipmentType(fileIds: number[], equipmentType: string | null) {
  const updated = await tx((c) => q.bulkEquipmentType(c, fileIds, equipmentType))
  return { updated, skipped: [] }
}

// ── 보관함 (기구는 modules/archive 공용) ────────────────────────────────

async function briefOf(c: pg.PoolClient, ids: number[]) {
  const r = await q.mdbBrief(c, ids)
  return r.rows.map((m) => ({
    id: m.id, label: m.title, folderId: m.folder_id, isArchived: m.is_archived,
  }))
}

export function sendToTrash(
  v: { fileIds: number[]; folderId: number | null; reason: string | null }, userId: number,
) {
  return archive.sendToTrash(
    DOC_CLASS, { itemIds: v.fileIds, folderId: v.folderId, reason: v.reason }, userId, briefOf,
  )
}

export function retire(fileIds: number[], reason: string | null, userId: number) {
  return archive.retire(DOC_CLASS, fileIds, reason, userId, briefOf)
}

export function listBox(kind: 'TRASH' | 'RETIRE') {
  return archive.listBox(DOC_CLASS, kind)
}

export function purge(batchIds: number[], userId: number) {
  return archive.purge(batchIds, userId, (c, id) => q.purgeBatch(c, id))
}

export const setNote = archive.setNote
export const restore = archive.restore
