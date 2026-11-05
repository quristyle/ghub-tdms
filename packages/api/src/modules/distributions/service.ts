import type {
  CreateDistributionRequest, DistributionListQuery, DistributionState, ForImportQuery,
} from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { encodeCursor } from '../../core/cursor.js'
import { AppError, Errors } from '../../core/errors.js'
import * as jobs from '../jobs/service.js'
import * as q from './queries.js'

/**
 * 반출이력.
 *
 * 협력사는 시스템에 들어오지 않는다 — CM 이 Zip 으로 묶어 반출하고 수정본을 받아 반입한다.
 * 그래서 반납은 반입·검수와 맞물린다: 반입된 파일이 반려되면 그 반출은 다시 미반납이 된다
 * (imports 모듈의 reopenDistributions).
 */

/** 화면 라벨: 반입완료 / 반입미완료 / 확인필요 / 검수대기 */
function stateOf(r: q.DistRow): DistributionState {
  if (r.returnedAt === null) return 'INCOMPLETE'
  if (r.returnedFileReview === 'ISSUE') return 'ISSUE'
  if (r.returnedFileReview === 'PENDING') return 'REVIEWING'
  return 'DONE'
}

function daysOut(r: q.DistRow): number | null {
  if (r.returnedAt !== null) return null
  return Math.floor((Date.now() - r.distributedAt.getTime()) / 86_400_000)
}

function toRow(r: q.DistRow) {
  return {
    id: r.id,
    documentId: r.documentId,
    documentLabel: r.documentLabel,
    title: r.title,
    revAtDistribution: r.revAtDistribution,
    vendorName: r.vendorName,
    projectName: r.projectName,
    purpose: r.purpose as never,
    purposeNote: r.purposeNote,
    zipName: r.zipName,
    distributedBy: r.distributedBy,
    distributedAt: r.distributedAt.toISOString(),
    returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
    returnNote: r.returnNote,
    manualReturn: r.manualReturn,
    note: r.note,
    state: stateOf(r),
    daysOut: daysOut(r),
  }
}

export async function list(qp: DistributionListQuery) {
  const rows = await q.listDistributions(qp)
  const hasMore = rows.length > qp.limit
  const items = hasMore ? rows.slice(0, qp.limit) : rows
  const last = items.at(-1)

  return {
    items: items.map(toRow),
    nextCursor:
      hasMore && last
        ? encodeCursor({ sortValue: last.distributedAt.toISOString(), id: last.id })
        : null,
    total: qp.cursor ? null : await q.countDistributions(qp),
  }
}

export async function zipExports(qp: DistributionListQuery) {
  const rows = await q.listZipExports(qp)
  return {
    items: rows.map((z) => ({
      zipName: z.zipName,
      vendorName: z.vendorName,
      projectName: z.projectName,
      purpose: z.purpose as never,
      distributedBy: z.distributedBy,
      distributedAt: z.distributedAt.toISOString(),
      itemCount: z.itemCount,
      returnedCount: z.returnedCount,
      complete: z.returnedCount >= z.itemCount,
      hasFile: z.hasFile,
    })),
  }
}

export async function zipStatus(zipName: string) {
  const rows = await q.listByZip(zipName)
  if (!rows.length) throw Errors.notFound('Zip 묶음')
  return {
    zipName,
    vendorName: rows[0]!.vendorName,
    itemCount: rows.length,
    returnedCount: rows.filter((r) => r.returnedAt !== null).length,
    items: rows.map(toRow),
  }
}

export async function outstanding() {
  const [rows, summary, byVendor] = await Promise.all([
    q.listOutstanding(),
    q.outstandingSummary(),
    q.outstandingByVendor(),
  ])
  return {
    items: rows.map(toRow),
    summary: {
      total: summary?.total ?? 0,
      notReturned: summary?.notReturned ?? 0,
      reviewing: summary?.reviewing ?? 0,
      oldestDays: summary?.oldestDays ?? null,
      byVendor,
    },
  }
}

export async function forImport(qp: ForImportQuery) {
  return { items: (await q.listForImport(qp)).map(toRow) }
}

// ── 반납 처리 ───────────────────────────────────────────────────────────

export async function markReturned(ids: number[], manual: boolean, note: string | null) {
  return tx(async (c) => {
    const found = await q.findForReturn(c, ids)
    const byId = new Map(found.map((f) => [f.id, f]))

    const skipped: { id: number; reason: string }[] = []
    const targets: number[] = []
    for (const id of ids) {
      const f = byId.get(id)
      if (!f) { skipped.push({ id, reason: '반출 기록을 찾을 수 없습니다.' }); continue }
      if (f.returned_at !== null) { skipped.push({ id, reason: '이미 반납 처리된 건입니다.' }); continue }
      targets.push(id)
    }

    const returned = targets.length ? await q.markReturned(c, targets, manual, note) : 0
    return { returned, skipped }
  })
}

/**
 * Zip 단위 '수정없이 반납처리' (기존 distributions.py zip-return).
 *
 * Zip 하나에 이미 반납된 수정용 자료가 섞여 있으면 그 Zip 은 건드리지 않고 사유를 돌려준다
 * (기존 CM 확정 — 일부만 수정본이 들어온 묶음을 통째로 '수정없음' 으로 닫으면 안 된다).
 * 참조용·기타는 애초에 반입 대상이 아니라 건드리지 않는다.
 */
export async function returnZips(zipNames: string[]) {
  return tx(async (c) => {
    let returned = 0
    const skipped: { zipName: string; reason: string }[] = []
    for (const zipName of zipNames) {
      const rows = await q.findZipForReturn(c, zipName)
      if (!rows.length) { skipped.push({ zipName, reason: '해당 Zip 을 찾을 수 없습니다.' }); continue }
      const modify = rows.filter((r) => r.purpose === 'MODIFY')
      if (!modify.length) {
        skipped.push({ zipName, reason: '이 Zip 에는 반입 대상(수정용) 자료가 없습니다.' })
        continue
      }
      const already = modify.filter((r) => r.returned_at !== null)
      if (already.length) {
        skipped.push({
          zipName,
          reason: `이미 반입 처리된 자료가 있어 처리할 수 없습니다 — ${already.slice(0, 5).map((r) => r.label).join(', ')}`
            + (already.length > 5 ? ` 외 ${already.length - 5}건` : ''),
        })
        continue
      }
      returned += await q.markReturned(c, modify.map((r) => r.id), true, '수정 없이 반입 처리(Zip 일괄)')
    }
    return { returned, skipped }
  })
}

/** Zip 다시 받기 — 만든 적이 없으면(워커 미완료·실패) 분명히 알린다 */
export async function zipFile(zipName: string) {
  const r = await q.findZipBlob(zipName)
  if (!r || r.rowCount === 0) throw Errors.notFound('Zip 묶음')
  if (!r.blobSha256) {
    throw new AppError('ZIP_NOT_BUILT', 404,
      'Zip 파일이 아직 만들어지지 않았습니다. 반출 직후라면 잠시 뒤 다시 받으세요. 계속 안 되면 반출 작업이 실패한 것입니다.')
  }
  return { sha256: r.blobSha256, byteSize: r.byteSize ?? undefined }
}

// ── 반출 실행 ───────────────────────────────────────────────────────────

/** 같은 순간에 두 번 눌러도 이름이 겹치지 않게 한다 */
function makeZipName(vendorName: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const safe = vendorName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  return `${stamp}_${safe}`
}

export async function create(body: CreateDistributionRequest, userId: number) {
  const out = await tx(async (c) => {
    const found = await q.documentsForDistribution(c, body.documentIds)
    const usable = found.rows.filter((d) => !d.is_archived)
    if (!usable.length) throw Errors.invalid('NO_DOCUMENTS', '반출할 자료가 없습니다.')

    // 이미 다른 업체가 수정 중이면 경고만 한다 — 막지 않는다(기존 정책).
    // 그래야 A·B 분기 흐름이 성립한다.
    const dups = await q.duplicateWarnings(c, usable.map((d) => d.id), body.vendorName)

    const zipName = makeZipName(body.vendorName, new Date())
    const created = await q.insertDistributions(c, {
      docs: usable,
      vendorId: body.vendorId,
      vendorName: body.vendorName,
      projectId: body.projectId,
      purpose: body.purpose,
      purposeNote: body.purposeNote,
      zipName,
      keepPaths: body.keepPaths,
      userId,
    })

    return {
      zipName,
      created,
      duplicateWarnings: dups.rows.map((d) => ({
        documentId: d.document_id,
        drawingNo: d.drawing_no,
        vendorName: d.vendor_name,
        distributedAt: d.distributed_at.toISOString(),
      })),
      documentIds: usable.map((d) => d.id),
    }
  })

  // Zip 은 워커가 만든다 — 요청 스레드에서 수백 개 파일을 압축하지 않는다
  const jobId = await jobs.create(
    'zip_build',
    {
      zipName: out.zipName,
      documentIds: out.documentIds,
      keepPaths: body.keepPaths,
      vendorName: body.vendorName,
    },
    userId,
  )

  return {
    zipName: out.zipName,
    created: out.created,
    jobId,
    duplicateWarnings: out.duplicateWarnings,
  }
}

// ── 검색 보조 ───────────────────────────────────────────────────────────

export async function filterOptions(canSelectOtherUser: boolean, selfId: number, selfName: string) {
  const [vendors, projects, distributors] = await q.filterOptions()
  return {
    vendors,
    projects,
    // 다른 사용자를 고를 권한이 없으면 자기 이름만 내려준다 (기존 정책: "N 선택시 이름만 조회 가능")
    distributors: canSelectOtherUser ? distributors : [{ id: selfId, name: selfName }],
    canSelectOtherUser,
  }
}
