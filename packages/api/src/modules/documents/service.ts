import type { DocumentListQuery, DocumentNavQuery, FolderDocumentsQuery } from '@tdms/contracts'
import { Errors } from '../../core/errors.js'
import { encodeCursor } from '../../core/cursor.js'
import * as folders from '../folders/service.js'
import * as archive from '../archive/service.js'
import * as q from './queries.js'

export async function list(qp: DocumentListQuery) {
  const folderIds = await folders.scopeIds('TDB', qp.folderId, qp.recursive)

  const rows = await q.listDocuments(folderIds, qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows

  const last = items.at(-1)
  // 커서는 **정렬 칸의 값**을 담는다. updated_at 으로 고정하면 다른 칸으로 정렬했을 때
  // 다음 쪽이 엉뚱한 곳에서 이어진다.
  const nextCursor =
    hasMore && last ? encodeCursor({ sortValue: q.sortValueOf(last, qp.sort), id: last.id }) : null

  // 총 건수는 비싸다 — 첫 페이지에서만 센다
  const total = qp.cursor ? null : await q.countDocuments(folderIds, qp)

  return {
    items: items.map(toListItem),
    nextCursor,
    total,
  }
}

export async function detail(id: number) {
  const row = await q.findDocument(id)
  if (!row) throw Errors.notFound('자료')

  const [chain, files] = await Promise.all([
    folders.ancestorChain(row.folderId),
    q.listDocumentFiles(id),
  ])

  return {
    ...toListItem(row),
    category: row.category,
    discipline: row.discipline,
    isblOsbl: row.isblOsbl,
    elevation: row.elevation,
    area: row.area,
    equipmentTag: row.equipmentTag,
    projectName: row.projectName,
    note: row.note,
    folderPath: chain,
    files: files.map((f) => ({
      ...f,
      uploadedAt: f.uploadedAt.toISOString(),
    })),
  }
}

function toListItem(r: q.DocumentListRow) {
  return {
    id: r.id,
    drawingNo: r.drawingNo,
    title: r.title,
    folderId: r.folderId,
    folderName: r.folderName,
    docType: r.docType,
    currentRev: r.currentRev,
    status: r.status as never,
    isIsometric: r.isIsometric,
    hasDwg: r.hasDwg,
    hasPdf: r.hasPdf,
    hasXlsx: r.hasXlsx,
    hasEtc: r.hasEtc,
    updatedAt: r.updatedAt.toISOString(),
    isModified: r.isModified,
    lentTo: r.lentTo,
    lentAt: r.lentAt ? r.lentAt.toISOString() : null,
  }
}

// ── Revision 이력 / 반출 이력 ───────────────────────────────────────────

export async function revisions(documentId: number) {
  const [revs, files] = await Promise.all([
    q.listRevisions(documentId),
    q.listFilesByRevision(documentId),
  ])

  // 파일을 리비전별로 묶는다 (N+1 대신 두 번 조회 후 메모리에서 결합)
  const byRev = new Map<string, q.RevisionFileRow[]>()
  for (const f of files) {
    const key = `${f.rev}|${f.branch ?? ''}`
    const list = byRev.get(key)
    if (list) list.push(f)
    else byRev.set(key, [f])
  }

  return {
    items: revs.map((r) => ({
      rev: r.rev,
      branch: r.branch,
      label: `Rev${r.rev}${r.branch ? `-${r.branch}` : ''}`,
      isCurrent: r.isCurrent,
      reason: r.reason,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      files: (byRev.get(`${r.rev}|${r.branch ?? ''}`) ?? []).map((f) => ({
        id: f.id,
        fileExt: f.fileExt,
        displayName: f.displayName,
        byteSize: f.byteSize,
        reviewStatus: f.reviewStatus as never,
        uploadedAt: f.uploadedAt.toISOString(),
      })),
    })),
  }
}

export async function distributions(documentId: number) {
  const rows = await q.listDistributions(documentId)
  return {
    items: rows.map((x) => ({
      id: x.id,
      revAtDistribution: x.revAtDistribution,
      vendorName: x.vendorName,
      projectName: x.projectName,
      purpose: x.purpose as never,
      purposeNote: x.purposeNote,
      zipName: x.zipName,
      distributedBy: x.distributedBy,
      distributedAt: x.distributedAt.toISOString(),
      returnedAt: x.returnedAt ? x.returnedAt.toISOString() : null,
      returnNote: x.returnNote,
      manualReturn: x.manualReturn,
      note: x.note,
      state: distributionState(x),
    })),
  }
}

/** 화면 라벨: 반입완료 / 반입미완료 / 확인필요 / 검수대기 */
function distributionState(x: q.DistributionRow): 'RETURNED' | 'OUTSTANDING' | 'ISSUE' | 'PENDING_REVIEW' {
  if (x.returnedAt === null) return 'OUTSTANDING'
  if (x.returnedFileReview === 'ISSUE') return 'ISSUE'
  if (x.returnedFileReview === 'PENDING') return 'PENDING_REVIEW'
  return 'RETURNED'
}

export async function setRevisionNote(
  documentId: number, rev: number, branch: string | null, note: string | null,
) {
  await q.updateRevisionNote(documentId, rev, branch, note)
}

export async function setDistributionNote(distributionId: number, note: string | null) {
  await q.updateDistributionNote(distributionId, note)
}

export async function neighbors(documentId: number) {
  const r = await q.neighborIds(documentId)
  return { prevId: r?.prevId ?? null, nextId: r?.nextId ?? null }
}

// ── 처음·이전·다음·끝 ───────────────────────────────────────────────────

export async function nav(qp: DocumentNavQuery) {
  const folderIds = await folders.scopeIds('TDB', qp.folderId, qp.recursive)
  const r = await q.navigate(folderIds, qp, { id: qp.id, at: qp.at })
  return {
    currentId: r?.currentId ?? null,
    position: r?.position ?? null,
    total: r?.total ?? 0,
    firstId: r?.firstId ?? null,
    prevId: r?.prevId ?? null,
    nextId: r?.nextId ?? null,
    lastId: r?.lastId ?? null,
  }
}

// ── 폴더 반출 ───────────────────────────────────────────────────────────

export async function folderDocuments(qp: FolderDocumentsQuery) {
  const folderIds = await folders.scopeIds('TDB', qp.folderId, qp.recursive)
  const rows = await q.listFolderDocuments(folderIds, qp.includeIsometric)
  // 반출 한 번에 5000건까지다 — 그보다 많으면 담아 봐야 반출에서 막힌다. 하위 폴더로 나눠 담게 한다.
  if (rows.length > q.FOLDER_CART_MAX) {
    throw Errors.invalid('TOO_MANY_DOCUMENTS',
      `이 폴더의 자료가 ${q.FOLDER_CART_MAX}건을 넘습니다. 한 번에 ${q.FOLDER_CART_MAX}건까지 반출할 수 있으니 하위 폴더로 나눠 담으세요.`)
  }
  return { items: rows.map(toListItem) }
}

// ── 폐기 보관함 (보기 전용) ─────────────────────────────────────────────
// 일반 사용자도 폐기 이력을 볼 수 있어야 한다 (기존 2026-08-30 CM 확정).
// 복구·비고는 TDB 관리 화면의 권한으로만 한다 — 여기는 목록만 준다.

export function retiredBox() {
  return archive.listBox('TDB', 'RETIRE')
}

// ── TDB 수정 (최근수정본) ───────────────────────────────────────────────

export async function recentChanges(days: number) {
  const rows = await q.listRecentChanges(days)
  const items = rows.map((r) => ({
    id: r.id,
    drawingNo: r.drawingNo,
    title: r.title,
    category: r.category,
    path: r.path ?? '',
    updatedAt: r.updatedAt.toISOString(),
    currentRev: r.currentRev,
    changeKind: (r.revTo !== null ? 'REVISION' : 'INFO') as 'REVISION' | 'INFO',
    revFrom: r.revTo !== null ? Math.max(r.revTo - 1, 0) : null,
    revTo: r.revTo,
    vendorName: r.vendorName,
    projectName: r.projectName,
    changedBy: r.changedBy,
  }))
  return {
    days,
    total: items.length,
    revisionCount: items.filter((i) => i.changeKind === 'REVISION').length,
    items,
  }
}

export async function recentChangesSummary(days: number) {
  return { count: await q.countRecentChanges(days) }
}
