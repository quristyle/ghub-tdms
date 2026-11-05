import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import yauzl from 'yauzl'
import type {
  AlreadyExists, DuplicateGroup, ExistingRevLookup, PartialItem, RegisterResult,
  ReplaceBulkResult, ReplaceResult, ZipRegisterCheck,
} from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'
import { AppError, Errors } from '../../core/errors.js'
import { registerBlob, storeStream, type StoredBlob } from '../../core/blob.js'
import { blobAbsPath } from '../../core/files.js'
import * as jobs from '../jobs/service.js'
import * as q from './queries.js'
import * as fq from './fileQueries.js'
import {
  displayName, duplicateExts, newUploadName, registrationName, splitName,
  uploadBaseName, uploadTailProblem,
} from './revName.js'
import { planZip, ZIP_LIMITS, ZipLimitError, type PlannedGroup, type ZipEntryInfo } from './zipPlan.js'

/**
 * TDB 관리 — 자료 교체 · 신규 등록 · Zip 폴더 업로드.
 *
 * 기존 editor.py 의 replace / replace-bulk / register / zip-register 를 옮긴 것.
 * CM 본인이 하는 편집이라 검수 대기 없이 바로 승인·현재본으로 반영한다.
 *
 * 확인이 필요한 경우(같은 형식 2개, 이름 불일치, 한쪽만 있음)는 **아무것도 바꾸지 않고**
 * needsConfirmation 으로 돌려보낸다. 화면이 확인을 받은 뒤 confirm* 를 켜서 다시 보낸다.
 */

/** 업로드 상한. nginx 의 client_max_body_size 와 맞춘다. */
export const MAX_UPLOAD = 2 * 1024 * 1024 * 1024

/** 확장자만 믿지 않는다 — 앞머리 바이트로 한 번 더 본다 (imports/routes.ts 와 같은 규칙) */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  dwg: (b) => b.subarray(0, 2).toString('latin1') === 'AC',
}

/** 관리 화면에서 받는 형식 (Zip 은 Zip 폴더 업로드에서만) */
export const ALLOWED = new Set(['pdf', 'dwg', 'dxf', 'xlsx', 'xls', 'docx', 'pptx'])

export function assertUsable(stored: { byteSize: number; head: Buffer }, ext: string, filename: string): void {
  if (stored.byteSize === 0) {
    throw Errors.invalid('EMPTY_FILE', `내용이 비어 있습니다: ${filename}`)
  }
  const check = MAGIC[ext]
  if (check && !check(stored.head)) {
    throw Errors.invalid('CONTENT_MISMATCH', `내용이 .${ext} 형식이 아닙니다: ${filename}`)
  }
}

export interface Incoming {
  sha256: Buffer
  filename: string
  stem: string
  ext: string
}

export function incomingOf(stored: StoredBlob, filename: string): Incoming {
  const [stem, ext] = splitName(filename)
  return { sha256: stored.sha256, filename, stem, ext }
}

const SCREEN_REASON = 'TDB 관리'

// ── 공통: 자료 하나에 파일 반영 ──────────────────────────────────────────

/** 같은 확장자가 여럿이면 마지막 것만 쓴다 (확인을 받고 진행한 경우) */
function lastPerExt(files: Incoming[]): Incoming[] {
  const m = new Map<string, Incoming>()
  for (const f of files) m.set(f.ext, f)
  return [...m.values()]
}

/**
 * 자료 교체.
 *  keepRev=true  ("Rev 유지") — 리비전을 올리지 않고 현재본 내용만 바꾼다. 없던 형식은 지금 Rev 로 붙인다.
 *  keepRev=false ("Rev 변경") — Rev 를 하나 올려 새 리비전으로 등록하고 현재본으로 올린다.
 */
async function applyReplace(
  c: pg.PoolClient, doc: fq.EditDoc, files: Incoming[], keepRev: boolean, userId: number,
): Promise<number> {
  const list = lastPerExt(files)
  if (keepRev) {
    const cur = await fq.currentFiles(c, doc.id)
    let setId: number | null = null
    for (const f of list) {
      const ex = cur.find((x) => x.file_ext === f.ext)
      if (ex) {
        await fq.swapBlob(c, ex.id, ex.blob_sha256, f.sha256, f.filename, userId)
      } else {
        setId ??= await fq.ensureRevisionSet(c, doc.id, doc.current_rev, `${SCREEN_REASON} 자료 교체`, userId)
        await fq.insertApprovedFile(c, {
          documentId: doc.id, revisionSetId: setId, sha256: f.sha256, rev: doc.current_rev,
          fileExt: f.ext, displayName: displayName(doc.drawing_no, doc.current_rev, f.ext, null),
          originalFilename: f.filename, isCurrent: true, userId,
        })
      }
    }
    await fq.refreshDoc(c, doc.id)
    return doc.current_rev
  }

  const rev = doc.current_rev + 1
  const setId = await fq.ensureRevisionSet(c, doc.id, rev, `${SCREEN_REASON} 자료 교체 (Rev 변경)`, userId)
  await fq.demoteCurrent(c, doc.id)
  for (const f of list) {
    await fq.insertApprovedFile(c, {
      documentId: doc.id, revisionSetId: setId, sha256: f.sha256, rev,
      fileExt: f.ext, displayName: displayName(doc.drawing_no, rev, f.ext, null),
      originalFilename: f.filename, isCurrent: true, userId,
    })
  }
  await fq.refreshDoc(c, doc.id, rev)
  return rev
}

interface GroupOutcome { created: boolean; attached: number; rejected: string[] }

/**
 * 신규 등록 · Zip 등록 공통 — 이름 하나(같은 이름으로 묶인 파일들)를 폴더에 넣는다.
 *
 * 같은 폴더에 같은 이름의 자료가 이미 있으면 새로 만들지 않고 **아직 없는 형식만** 붙인다
 * (그 자료의 지금 Rev 로 — 원본·사본이 다른 Rev 를 가리키면 안 되므로).
 * 이미 갖고 있는 형식은 덮어쓰지 않고 거절한다 — 내용을 바꾸려면 [자료 교체]를 쓴다.
 */
async function registerGroup(
  c: pg.PoolClient, folderId: number, folderPath: string, name: string,
  files: Incoming[], rev: number, userId: number,
): Promise<GroupOutcome> {
  const existing = await fq.docsByNameInFolder(c, folderId, name)
  if (existing.length > 1) {
    // 같은 이름이 둘 이상이면 어디에 붙일지 정할 수 없다 — 잘못 붙이느니 멈춘다
    return { created: false, attached: 0, rejected: [...new Set(files.map((f) => f.ext))] }
  }
  if (existing.length === 1) {
    const doc = (await fq.lockDocs(c, [existing[0]!.id]))[0]!
    const owned = new Set((await fq.currentFiles(c, doc.id)).map((f) => f.file_ext))
    const rejected: string[] = []
    let attached = 0
    let setId: number | null = null
    for (const f of files) {
      if (owned.has(f.ext)) { if (!rejected.includes(f.ext)) rejected.push(f.ext); continue }
      setId ??= await fq.ensureRevisionSet(c, doc.id, doc.current_rev, `${SCREEN_REASON} 신규 등록`, userId)
      await fq.insertApprovedFile(c, {
        documentId: doc.id, revisionSetId: setId, sha256: f.sha256, rev: doc.current_rev,
        fileExt: f.ext, displayName: displayName(doc.drawing_no, doc.current_rev, f.ext, folderPath),
        originalFilename: f.filename, isCurrent: true, userId,
      })
      owned.add(f.ext)
      attached++
    }
    if (attached) await fq.refreshDoc(c, doc.id)
    return { created: false, attached, rejected }
  }

  const docId = await fq.createDocument(c, folderId, name, rev)
  const setId = await fq.ensureRevisionSet(c, docId, rev, `${SCREEN_REASON} 신규 등록`, userId)
  for (const f of files) {
    await fq.insertApprovedFile(c, {
      documentId: docId, revisionSetId: setId, sha256: f.sha256, rev,
      fileExt: f.ext, displayName: displayName(name, rev, f.ext, folderPath),
      originalFilename: f.filename, isCurrent: true, userId,
    })
  }
  await fq.refreshDoc(c, docId)
  await fq.unmarkPlaceholder(c, folderId)
  return { created: true, attached: 0, rejected: [] }
}

function tailError(problems: string[]): AppError {
  return Errors.invalid('REV_TAIL', problems.join('\n'), { problems })
}

async function editableFolder(c: pg.PoolClient, folderId: number) {
  const f = await q.folderById(c, folderId)
  if (!f || f.is_archived || f.doc_class !== 'TDB') throw Errors.notFound('등록할 폴더')
  return { folder: f, path: await q.folderPathText(c, folderId) }
}

// ── 자료 교체 (1건) ─────────────────────────────────────────────────────

export async function replaceOne(
  documentId: number, files: Incoming[],
  o: { keepRev: boolean; confirmDuplicates: boolean }, userId: number,
): Promise<ReplaceResult> {
  if (!files.length) throw Errors.invalid('NO_FILE', '교체할 파일을 골라 주세요.')
  const base: ReplaceResult = {
    needsConfirmation: false, message: '', documentId, rev: null, fileCount: 0, duplicateExts: [],
  }

  // 원본과 PDF 를 함께 올릴 때 이름이 서로 다르면 어느 게 맞는지 알 수 없어 막는다
  const stems = [...new Set(files.map((f) => uploadBaseName(f.stem)))]
  if (stems.length > 1) {
    throw Errors.invalid('STEM_MISMATCH',
      `첨부한 파일들의 이름이 서로 다릅니다 (${stems.sort().join(', ')}). `
      + '원본과 PDF는 확장자만 다르고 이름은 같아야 교체할 수 있습니다.')
  }

  const out = await tx(async (c) => {
    const doc = (await fq.lockDocs(c, [documentId]))[0]
    if (!doc || doc.is_archived) throw Errors.notFound('자료')
    const folderPath = await q.folderPathText(c, doc.folder_id)

    const target = o.keepRev ? doc.current_rev : doc.current_rev + 1
    const problems = files
      .map((f) => uploadTailProblem(f.stem, doc.drawing_no, folderPath, target))
      .filter((p): p is string => p !== null)
    if (problems.length) throw tailError(problems)

    const dups = duplicateExts(files.map((f) => f.ext))
    if (dups.length && !o.confirmDuplicates) {
      return { ...base, needsConfirmation: true, duplicateExts: dups,
               message: '같은 형식의 파일이 2개 이상 첨부되었습니다.' }
    }

    const rev = await applyReplace(c, doc, files, o.keepRev, userId)
    const label = `Rev${String(rev).padStart(2, '0')}`
    return {
      ...base, rev, fileCount: lastPerExt(files).length,
      message: o.keepRev ? `자료를 교체했습니다 (${label} 유지).` : `자료를 교체했습니다 (${label}).`,
    }
  })
  return out
}

// ── 일괄 교체 ───────────────────────────────────────────────────────────

export async function replaceBulk(
  documentIds: number[], files: Incoming[],
  o: { keepRev: boolean; confirmDuplicates: boolean; confirmMismatch: boolean; confirmPartial: boolean },
  userId: number,
): Promise<ReplaceBulkResult> {
  if (!documentIds.length) throw Errors.invalid('NO_TARGET', '교체할 자료를 골라 주세요.')
  if (!files.length) throw Errors.invalid('NO_FILE', '교체할 파일을 골라 주세요.')
  const base: ReplaceBulkResult = {
    needsConfirmation: false, message: '', replaced: 0, duplicateExts: [],
    unmatchedDocs: [], unmatchedFiles: [], partial: [],
  }

  // 내려받은 파일(`도면번호_Rev00.dwg`)을 그대로 올려도 짝이 지어지게 정상 꼬리를 떼고 묶는다
  const groups = new Map<string, Incoming[]>()
  for (const f of files) {
    const k = uploadBaseName(f.stem)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(f)
  }

  return tx(async (c) => {
    const docs = (await fq.lockDocs(c, documentIds)).filter((d) => !d.is_archived)
    const byName = new Map(docs.map((d) => [d.drawing_no, d]))

    const dupAll = [...new Set([...groups.values()].flatMap((g) => duplicateExts(g.map((f) => f.ext))))].sort()
    if (dupAll.length && !o.confirmDuplicates) {
      return { ...base, needsConfirmation: true, duplicateExts: dupAll,
               message: '같은 형식의 파일이 2개 이상 첨부된 자료가 있습니다.' }
    }

    const matched = [...groups.keys()].filter((k) => byName.has(k)).sort()
    const unmatchedFiles = [...groups.keys()].filter((k) => !byName.has(k)).sort()
    const unmatchedDocs = docs.filter((d) => !groups.has(d.drawing_no)).map((d) => d.drawing_no).sort()

    const problems: string[] = []
    for (const k of matched) {
      const doc = byName.get(k)!
      const folderPath = await q.folderPathText(c, doc.folder_id)
      const target = o.keepRev ? doc.current_rev : doc.current_rev + 1
      for (const f of groups.get(k)!) {
        const p = uploadTailProblem(f.stem, doc.drawing_no, folderPath, target)
        if (p) problems.push(p)
      }
    }
    if (problems.length) throw tailError(problems)

    if ((unmatchedFiles.length || unmatchedDocs.length) && !o.confirmMismatch) {
      return { ...base, needsConfirmation: true, unmatchedDocs, unmatchedFiles,
               message: '첨부한 파일 이름과 선택한 자료명이 서로 맞지 않는 항목이 있습니다.' }
    }

    const partial: PartialItem[] = matched
      .filter((k) => new Set(groups.get(k)!.map((f) => f.ext)).size === 1)
      .map((k) => ({ stem: k, ext: groups.get(k)![0]!.ext, folder: null }))
    if (partial.length && !o.confirmPartial) {
      return { ...base, needsConfirmation: true, partial,
               message: '원본과 사본(PDF) 중 한쪽만 있는 자료가 있습니다.' }
    }

    for (const k of matched) await applyReplace(c, byName.get(k)!, groups.get(k)!, o.keepRev, userId)

    let message = `자료 ${matched.length}건을 교체했습니다.`
    if (!o.keepRev) message += ' (각 자료의 Rev가 1씩 올랐습니다)'
    return { ...base, replaced: matched.length, message }
  })
}

// ── 기존 Rev 조회 · 신규 등록 ────────────────────────────────────────────

/**
 * 신규 등록 팝업의 Rev 매칭용 — 등록하려는 폴더에 같은 이름(다른 형식)의 자료가 이미 있으면
 * 그 자료의 현재 Rev 를 알려준다. 조회 전용이고, 실제 강제는 등록 시점(registerGroup)에서 한다.
 */
export async function existingRev(folderId: number, stem: string): Promise<ExistingRevLookup> {
  const none = { found: false, documentId: null, currentRev: null, exts: [] }
  const s = stem.trim()
  if (!s) return none
  return tx(async (c) => {
    const { path } = await editableFolder(c, folderId)
    const docs = await fq.docsByNameInFolder(c, folderId, registrationName(s, path))
    if (docs.length !== 1) return none
    const d = docs[0]!
    const exts = [...new Set((await fq.currentFiles(c, d.id)).map((f) => f.file_ext))].sort()
    return { found: true, documentId: d.id, currentRev: d.current_rev, exts }
  })
}

export async function register(
  folderId: number, files: Incoming[],
  o: { rev: number; confirmDuplicates: boolean; confirmPartial: boolean }, userId: number,
): Promise<RegisterResult> {
  if (!files.length) throw Errors.invalid('NO_FILE', '등록할 파일을 골라 주세요.')
  const base: RegisterResult = {
    needsConfirmation: false, message: '', created: 0, attached: 0,
    alreadyExists: [], duplicates: [], partial: [],
  }

  const out = await tx(async (c) => {
    const { path } = await editableFolder(c, folderId)

    // 리비전 꼬리(`_Rev00`)는 떼고 묶는다 — 꼬리는 자료명이 아니다
    const groups = new Map<string, Incoming[]>()
    for (const f of files) {
      const k = registrationName(f.stem, path)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(f)
    }

    const duplicates: DuplicateGroup[] = []
    for (const [stem, g] of groups) {
      const d = duplicateExts(g.map((f) => f.ext))
      if (d.length) duplicates.push({ stem, folder: null, exts: d })
    }
    if (duplicates.length && !o.confirmDuplicates) {
      return { ...base, needsConfirmation: true, duplicates,
               message: '같은 이름의 파일이 형식별로 2개 이상 있어 어느 게 맞는 파일인지 알 수 없습니다.' }
    }
    // 확인을 받아도 어느 게 맞는 파일인지는 알 수 없으므로 그 자료는 건너뛴다
    for (const d of duplicates) groups.delete(d.stem)

    const partial: PartialItem[] = [...groups]
      .filter(([, g]) => new Set(g.map((f) => f.ext)).size === 1)
      .map(([stem, g]) => ({ stem, ext: g[0]!.ext, folder: null }))
    if (partial.length && !o.confirmPartial) {
      return { ...base, needsConfirmation: true, partial, duplicates,
               message: '원본과 사본(PDF) 중 한쪽만 있는 자료가 있습니다.' }
    }

    const problems: string[] = []
    for (const [stem, g] of groups) {
      const ex = await fq.docsByNameInFolder(c, folderId, stem)
      const target = ex.length === 1 ? ex[0]!.current_rev : o.rev
      for (const f of g) {
        const [, p] = newUploadName(f.stem, path, target)
        if (p) problems.push(p)
      }
    }
    if (problems.length) throw tailError(problems)

    let created = 0
    let attached = 0
    const alreadyExists: AlreadyExists[] = []
    for (const [stem, g] of groups) {
      const r = await registerGroup(c, folderId, path, stem, g, o.rev, userId)
      if (r.created) created++
      attached += r.attached
      if (r.rejected.length) alreadyExists.push({ stem, exts: r.rejected })
    }

    let message = `신규 자료 ${created}건이 등록되었습니다.`
    if (attached) message += ` 같은 이름의 기존 자료에 파일 ${attached}개를 추가했습니다.`
    if (alreadyExists.length) {
      message += ` 같은 이름·같은 형식으로 이미 있어 올리지 않은 자료 ${alreadyExists.length}건`
        + ' (내용을 바꾸려면 [자료 교체]를 쓰세요).'
    }
    if (duplicates.length) message += ` 같은 형식 중복으로 건너뛴 자료 ${duplicates.length}건.`
    return { ...base, created, attached, alreadyExists, duplicates, partial, message }
  })
  await invalidate('cache_tree')
  return out
}

// ── Zip 폴더 업로드 ─────────────────────────────────────────────────────
//
// ① 올린 Zip 을 blob 으로 저장하고 목록(central directory)만 읽어 계획을 세운다 — 풀지 않는다.
// ② 확인이 필요하면 token 과 함께 200 으로 돌려보낸다. 다시 보낼 때 Zip 을 또 올리지 않는다.
// ③ 진행하면 작업 행을 running 으로 만들고 202 로 먼저 답한 뒤 같은 프로세스에서 푼다.

interface ZipTicket { sha256: Buffer; filename: string; userId: number; expires: number }
const tickets = new Map<string, ZipTicket>()
const TICKET_TTL = 30 * 60 * 1000

function issueTicket(t: Omit<ZipTicket, 'expires'>): string {
  const now = Date.now()
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k)
  const token = randomBytes(18).toString('base64url')
  tickets.set(token, { ...t, expires: now + TICKET_TTL })
  return token
}

export function redeemTicket(token: string, userId: number): { sha256: Buffer; filename: string } {
  const t = tickets.get(token)
  if (!t || t.expires < Date.now() || t.userId !== userId) {
    throw Errors.invalid('ZIP_EXPIRED', '확인 시간이 지났습니다. Zip 파일을 다시 올려 주세요.')
  }
  return { sha256: t.sha256, filename: t.filename }
}

/** 파일 이름 해석 — UTF-8 표시가 없으면 한국어 Windows 기본(CP949)으로 본다 */
function decodeName(e: yauzl.Entry): string {
  const raw = e.fileNameRaw ?? (e.fileName as unknown as Buffer)
  const hasUnicodeExtra = e.extraFields.some((x) => x.id === 0x7075)
  if ((e.generalPurposeBitFlag & 0x800) !== 0 || hasUnicodeExtra) {
    return yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, raw, e.extraFields, false)
  }
  if (raw.every((b) => b < 0x80)) return raw.toString('latin1')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return new TextDecoder('euc-kr').decode(raw)
  }
}

interface OpenedZip { zip: yauzl.ZipFile; entries: yauzl.Entry[]; infos: ZipEntryInfo[] }

async function openZip(sha256: Buffer): Promise<OpenedZip> {
  let zip: yauzl.ZipFile
  try {
    zip = await yauzl.openPromise(blobAbsPath(sha256), {
      lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true,
    })
  } catch {
    throw Errors.invalid('BAD_ZIP', '올바른 Zip 파일이 아닙니다.')
  }
  const entries: yauzl.Entry[] = []
  const infos: ZipEntryInfo[] = []
  try {
    for await (const e of zip.eachEntry()) {
      if (entries.length >= ZIP_LIMITS.maxEntries) {
        throw new ZipLimitError(`압축 안 파일이 너무 많습니다 (상한 ${ZIP_LIMITS.maxEntries}개).`)
      }
      if (e.isEncrypted()) throw Errors.invalid('ZIP_ENCRYPTED', '암호가 걸린 Zip 은 받을 수 없습니다.')
      entries.push(e)
      infos.push({ path: decodeName(e), uncompressedSize: e.uncompressedSize, compressedSize: e.compressedSize })
    }
  } catch (err) {
    zip.close()
    if (err instanceof ZipLimitError) throw Errors.invalid('ZIP_LIMIT', err.message)
    if (err instanceof AppError) throw err
    throw Errors.invalid('BAD_ZIP', '올바른 Zip 파일이 아닙니다.')
  }
  return { zip, entries, infos }
}

/** 선택한 폴더 아래 경로의 폴더 id — 없으면 null (create 면 만든다) */
async function resolveFolder(
  c: pg.PoolClient, rootId: number, segments: string[], userId: number, create: boolean,
): Promise<number | null> {
  let cur = rootId
  for (const name of segments) {
    const f = await fq.childFolder(c, cur, name)
    if (f) {
      if (f.is_archived) {
        throw Errors.conflict('FOLDER_ARCHIVED', `"${name}" 폴더가 보관함에 있어 그 아래에 넣을 수 없습니다.`)
      }
      cur = f.id
      continue
    }
    if (!create) return null
    cur = await q.createFolder(c, 'TDB', cur, name, userId)
  }
  return cur
}

export interface ZipRegisterOptions {
  folderId: number
  rev: number
  confirmUnsafePaths: boolean
  confirmDuplicates: boolean
  confirmPartial: boolean
}

/** 계획만 세운다. 확인이 필요하면 ZipRegisterCheck, 아니면 null. */
export async function zipCheck(
  zipBlob: { sha256: Buffer; filename: string }, o: ZipRegisterOptions, userId: number,
): Promise<{ check: ZipRegisterCheck | null; groups: number }> {
  const { zip, infos } = await openZip(zipBlob.sha256)
  zip.close()

  const { path } = await tx((c) => editableFolder(c, o.folderId))
  let plan: ReturnType<typeof planZip>
  try {
    plan = planZip(infos, path, o.rev)
  } catch (e) {
    if (e instanceof ZipLimitError) throw Errors.invalid('ZIP_LIMIT', e.message)
    throw e
  }
  if (!plan.groups.length && !plan.duplicates.length) {
    throw Errors.invalid('ZIP_EMPTY', '압축 안에 등록할 수 있는 파일(DWG·PDF 등)이 없습니다.')
  }

  const needs = (plan.unsafePaths.length && !o.confirmUnsafePaths)
    || (plan.duplicates.length && !o.confirmDuplicates)
    || (plan.partial.length && !o.confirmPartial)

  // 꼬리 검사 — 이미 있는 폴더·자료는 그 자료의 Rev 를 기준으로 본다
  if (!needs) {
    const existing = new Map<PlannedGroup, number | null>()
    await tx(async (c) => {
      for (const g of plan.groups) {
        const fid = await resolveFolder(c, o.folderId, g.folder, userId, false)
        const docs = fid === null ? [] : await fq.docsByNameInFolder(c, fid, g.name)
        existing.set(g, docs.length === 1 ? docs[0]!.current_rev : null)
      }
    })
    const problems = plan.tailCheck((g) => existing.get(g) ?? null)
    if (problems.length) throw tailError(problems.slice(0, 50))
    return { check: null, groups: plan.groups.length }
  }

  return {
    groups: plan.groups.length,
    check: {
      needsConfirmation: true,
      token: issueTicket({ sha256: zipBlob.sha256, filename: zipBlob.filename, userId }),
      unsafePaths: plan.unsafePaths,
      duplicates: plan.duplicates,
      partial: plan.partial,
      pairFolders: plan.pairFolders,
    },
  }
}

/** 202 로 답한 뒤 부른다. 예외를 밖으로 던지지 않는다 — 작업 행에 실패로 남긴다. */
export async function runZipRegister(
  jobId: number, zipBlob: { sha256: Buffer; filename: string }, o: ZipRegisterOptions, userId: number,
): Promise<void> {
  let opened: OpenedZip | null = null
  let lastPct = 0
  // 오래 걸리는 파일 하나를 푸는 동안에도 heartbeat 가 끊기지 않게 한다
  const beat = setInterval(() => { void jobs.progress(jobId, lastPct).catch(() => {}) }, 30_000)
  try {
    opened = await openZip(zipBlob.sha256)
    const { path } = await tx((c) => editableFolder(c, o.folderId))
    const plan = planZip(opened.infos, path, o.rev)

    let created = 0
    let attached = 0
    const alreadyExists: AlreadyExists[] = []
    const failed: string[] = []

    for (let i = 0; i < plan.groups.length; i++) {
      const g = plan.groups[i]!
      // 파일 먼저 blob 으로 — 실패해도 refcount 0 고아라 야간 GC 가 수거한다
      const files: Incoming[] = []
      try {
        for (const pf of g.files) {
          const entry = opened.entries[pf.index]!
          const stream = await opened.zip.openReadStreamPromise(entry)
          const stored = await storeStream(stream, ZIP_LIMITS.maxEntryBytes)
          assertUsable(stored, pf.ext, pf.filename)
          await tx((c) => registerBlob(c, stored))
          files.push(incomingOf(stored, pf.filename))
        }

        const r = await tx(async (c) => {
          const fid = await resolveFolder(c, o.folderId, g.folder, userId, true)
          const fpath = [path, ...g.folder].join(' › ')
          return registerGroup(c, fid!, fpath, g.name, files, o.rev, userId)
        })
        if (r.created) created++
        attached += r.attached
        if (r.rejected.length) alreadyExists.push({ stem: g.name, exts: r.rejected })
      } catch (e) {
        failed.push(`${[...g.folder, g.name].join('/')}: ${e instanceof Error ? e.message : '처리하지 못했습니다.'}`)
      }

      const pct = Math.floor(((i + 1) / plan.groups.length) * 99)
      if (pct !== lastPct || i === plan.groups.length - 1) {
        lastPct = pct
        await jobs.progress(jobId, pct, `${i + 1} / ${plan.groups.length}건 처리`)
      }
    }

    await invalidate('cache_tree')
    let note = `신규 ${created}건 등록`
    if (attached) note += `, 기존 자료에 파일 ${attached}개 추가`
    if (alreadyExists.length) note += `, 이미 있어 건너뜀 ${alreadyExists.length}건`
    if (plan.duplicates.length) note += `, 형식 중복으로 건너뜀 ${plan.duplicates.length}건`
    if (plan.ignored.length) note += `, 받지 않는 형식 ${plan.ignored.length}개`
    if (failed.length) note += `, 실패 ${failed.length}건`
    await jobs.finish(jobId, {
      note, created, attached,
      alreadyExists, duplicates: plan.duplicates, ignored: plan.ignored.slice(0, 200),
      failed: failed.slice(0, 200), pairFolders: plan.pairFolders,
    })
  } catch (e) {
    await jobs.fail(jobId, e instanceof Error ? e.message : '처리하지 못했습니다.').catch(() => {})
  } finally {
    clearInterval(beat)
    opened?.zip.close()
  }
}
