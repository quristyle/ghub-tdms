import type pg from 'pg'
import {
  approveOutcome, branchApprovalBlocked, determineRevBranch,
  rejectLetter, revLabel,
} from '@tdms/contracts'
import { tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

/**
 * 반입·검수.
 *
 * 상태 머신 자체는 @tdms/contracts/revision 의 순수 함수에 있다(전수 테스트 대상).
 * 이 파일은 그 결정을 DB 트랜잭션에 묶는 일만 한다.
 */

// ── 반입 등록 ───────────────────────────────────────────────────────────

export interface IncomingFile {
  sha256: Buffer
  originalFilename: string
  fileExt: string
}

export interface UploadOutcome {
  documentId: number
  revLabel: string
  created: number
  warning: boolean
  branched: boolean
  reason: string
}

/** 업체가 파일명에 적어 온 리비전 표기를 뽑는다. 예: "T11-116-10_Rev03.pdf" → "Rev03" */
export function extractLabeledRev(filename: string): string | null {
  const m = /[_\-\s]?(Rev\.?\s*\d{1,3}[A-Za-z]?)/i.exec(filename)
  return m?.[1] ? m[1].replace(/\s+/g, '') : null
}

export function labeledRevNumber(labeled: string | null): number | null {
  if (!labeled) return null
  const m = /(\d{1,3})/.exec(labeled)
  return m?.[1] ? Number(m[1]) : null
}

export async function registerRevision(
  documentId: number,
  files: IncomingFile[],
  vendor: { id: number | null; name: string },
  projectId: number | null,
  userId: number,
): Promise<UploadOutcome> {
  if (files.length === 0) throw Errors.invalid('NO_FILES', '올릴 파일이 없습니다.')

  return tx(async (c) => {
    const locked = await q.lockDocument(c, documentId)
    const doc = locked.rows[0]
    if (!doc) throw Errors.notFound('자료')

    const [existing, dists] = await Promise.all([
      q.filesForDecision(c, documentId),
      q.openDistributions(c, documentId),
    ])

    const decision = determineRevBranch(doc.current_rev, existing, dists, vendor.name)
    if (decision.backfillToA) await q.backfillBranchA(c, documentId, decision.rev)

    const setId = await q.createRevisionSet(c, {
      documentId,
      rev: decision.rev,
      branch: decision.branch,
      reason: `${vendor.name} 반입`,
      userId,
    })

    let warning = false
    let firstFileId: number | null = null

    for (const f of files) {
      const labeled = extractLabeledRev(f.originalFilename)
      const labeledNum = labeledRevNumber(labeled)
      // 업체 표기와 시스템이 매긴 rev 가 다르면 경고만 띄운다 — 막지는 않는다
      const mismatch = labeled !== null && labeledNum !== decision.rev
      if (mismatch) warning = true

      const id = await q.insertPendingFile(c, {
        documentId,
        revisionSetId: setId,
        sha256: f.sha256,
        rev: decision.rev,
        branch: decision.branch,
        fileExt: f.fileExt,
        displayName: `${doc.drawing_no}_Rev${String(decision.rev).padStart(2, '0')}${decision.branch ?? ''}.${f.fileExt}`,
        originalFilename: f.originalFilename,
        vendorId: vendor.id,
        vendorName: vendor.name,
        projectId,
        vendorLabeledRev: labeled,
        revMismatch: mismatch,
        userId,
      })
      firstFileId ??= id
    }

    // 이 반입이 어느 반출을 닫는지 기록한다 (반려되면 되돌린다)
    if (firstFileId !== null) await q.closeDistribution(c, documentId, vendor.id, firstFileId)

    // 검수 대기 중임을 자료 상태에 표시한다
    if (doc.status === 'ACTIVE') await q.setDocumentStatus(c, documentId, 'PENDING')

    return {
      documentId,
      revLabel: revLabel(decision.rev, decision.branch),
      created: files.length,
      warning,
      branched: decision.branch !== null,
      reason: decision.reason,
    }
  })
}

// ── 검수 대기 목록 ──────────────────────────────────────────────────────

export async function pendingReview(filters: { q?: string; vendorId?: number; projectId?: number }) {
  const rows = await q.listPending(filters)

  // 같은 문서·rev·branch 를 한 줄로 묶는다 (DWG+PDF 가 한 세트)
  const groups = new Map<string, ReturnType<typeof toGroup>>()
  for (const r of rows) {
    const key = `${r.documentId}|${r.rev}|${r.branch ?? ''}`
    const g = groups.get(key)
    if (g) {
      g.files.push(toFile(r))
      g.hasWarning ||= r.revMismatch
    } else {
      groups.set(key, toGroup(r))
    }
  }
  return { items: [...groups.values()] }
}

function toFile(r: q.PendingRow) {
  return {
    id: r.fileId,
    fileExt: r.fileExt,
    displayName: r.displayName,
    originalFilename: r.originalFilename,
    byteSize: r.byteSize,
    vendorLabeledRev: r.vendorLabeledRev,
    revMismatch: r.revMismatch,
  }
}

function toGroup(r: q.PendingRow) {
  return {
    documentId: r.documentId,
    drawingNo: r.drawingNo,
    title: r.title,
    folderName: r.folderName,
    rev: r.rev,
    branch: r.branch,
    revLabel: revLabel(r.rev, r.branch),
    distributedRev: r.distributedRev,
    vendorName: r.vendorName,
    projectName: r.projectName,
    uploadedAt: r.uploadedAt.toISOString(),
    uploadedBy: r.uploadedBy,
    files: [toFile(r)],
    isBranch: r.branch !== null,
    branchArrived: null as number | null,
    branchExpected: null as number | null,
    hasWarning: r.revMismatch,
  }
}

// ── 승인 · 반려 ─────────────────────────────────────────────────────────

export interface ReviewOutcome {
  status: 'approved' | 'rejected'
  revLabel: string
  documentStatus: string
}

export async function review(
  fileId: number,
  action: 'APPROVE' | 'REJECT',
  note: string | null,
  can: (key: 'approve' | 'reject') => boolean,
): Promise<ReviewOutcome> {
  return tx(async (c) => {
    const target = await q.fileForReview(c, fileId)
    if (!target) throw Errors.notFound('파일')

    // 두 사람이 같은 순간에 같은 자료를 처리해도 한 번만 되도록 자료를 먼저 잠근다.
    // 잠금 순서는 언제나 '자료 먼저' — 파일부터 잠그면 같은 세트를 서로 쥐고 기다리는 교착이 생긴다.
    await q.lockDocument(c, target.document_id)

    const fresh = await q.fileForReview(c, fileId)
    if (!fresh || fresh.review_status !== 'PENDING') {
      throw Errors.conflict('ALREADY_REVIEWED', '이미 검수 처리된 건입니다.')
    }

    if (!can(action === 'APPROVE' ? 'approve' : 'reject')) throw Errors.forbidden()

    const set = await q.setFiles(c, fresh.document_id, fresh.rev, fresh.branch)
    const ids = set.map((f) => f.id)
    if (ids.length === 0) throw Errors.conflict('EMPTY_SET', '처리할 파일이 없습니다.')

    if (action === 'REJECT') {
      // 반려된 파일이 닫았던 반출을 다시 미반납으로 되돌린다
      await q.reopenDistributions(c, ids)

      const existing = await q.filesForDecision(c, fresh.document_id)
      const letter = rejectLetter({ rev: fresh.rev, branch: fresh.branch }, existing)
      await q.markReviewed(c, ids, 'REJECTED', note, letter)

      // 반려는 현재 자료를 바꾸지 않는다 — updated_at 을 건드리면 수정 없이 끝난 자료가
      // 최근수정 현황에 오늘 날짜로 뜬다 (기존 시스템 2026-10-01 수정 사항)
      const stillPending = (await q.setFiles(c, fresh.document_id, fresh.rev, fresh.branch)).length
      if (stillPending === 0) await q.setDocumentStatus(c, fresh.document_id, 'ACTIVE')

      return {
        status: 'rejected' as const,
        revLabel: revLabel(fresh.rev, letter),
        documentStatus: 'ACTIVE',
      }
    }

    // APPROVE
    const outcome = approveOutcome(
      { branch: fresh.branch },
      set.map((f) => f.vendor_name ?? ''),
    )

    if (fresh.branch !== null) {
      // 분기본은 반출된 것이 전부 돌아오기 전에는 승인할 수 없다
      const { expected, arrived } = await q.branchProgress(c, fresh.document_id)
      const blocked = branchApprovalBlocked(expected, arrived)
      if (blocked) throw Errors.invalid('BRANCH_INCOMPLETE', blocked)
    }

    await q.markReviewed(c, ids, 'APPROVED', note)

    if (outcome.promoteToCurrent) {
      await q.promoteToCurrent(c, fresh.document_id, ids, fresh.rev)
      if (outcome.closeBranchSiblings) await q.closeBranchSiblings(c, fresh.document_id)
    } else {
      await q.setDocumentStatus(c, fresh.document_id, outcome.documentStatus)
    }

    return {
      status: 'approved' as const,
      revLabel: revLabel(fresh.rev, fresh.branch),
      documentStatus: outcome.documentStatus,
    }
  })
}

// ── 확인 필요 ───────────────────────────────────────────────────────────

export async function issues() {
  const rows = await q.listIssues()
  return {
    items: rows.map((i) => ({
      ...i,
      createdAt: i.createdAt.toISOString(),
    })),
  }
}

/** 경로 재선택 — 어느 자료에 붙일지 정해 주면 그 자료의 리비전 세트로 넘긴다 */
export async function resolveIssue(
  issueId: number,
  documentId: number,
  vendor: { id: number | null; name: string },
  projectId: number | null,
  userId: number,
): Promise<UploadOutcome> {
  const issue = await tx(async (c) => {
    const row = await q.findIssue(c, issueId)
    if (!row) throw Errors.notFound('확인 필요 건')
    if (row.state !== 'OPEN') throw Errors.conflict('ALREADY_RESOLVED', '이미 처리된 건입니다.')
    return row
  })

  if (!issue.blob_sha256) throw Errors.invalid('NO_FILE', '첨부된 파일이 없습니다. 재첨부가 필요합니다.')

  const ext = issue.filename.split('.').pop()?.toLowerCase() ?? 'bin'
  const out = await registerRevision(
    documentId,
    [{ sha256: issue.blob_sha256, originalFilename: issue.filename, fileExt: ext }],
    vendor, projectId, userId,
  )

  await tx((c) => q.closeIssue(c, issueId, 'RESOLVED', userId))
  return out
}

/** 재검수 — 파일명으로 자료를 다시 찾아 본다. 찾으면 바로 붙인다. */
export async function recheckIssue(issueId: number, userId: number) {
  return tx(async (c) => {
    const issue = await q.findIssue(c, issueId)
    if (!issue) throw Errors.notFound('확인 필요 건')
    if (issue.state !== 'OPEN') throw Errors.conflict('ALREADY_RESOLVED', '이미 처리된 건입니다.')

    const stem = issue.filename.replace(/\.[^.]+$/, '').replace(/[_\-\s]?Rev\.?\s*\d{1,3}[A-Za-z]?$/i, '')
    const found = await q.findDocumentByName(c, stem)

    if (found.rows.length === 1) {
      await q.setIssueSuggestion(c, issueId, found.rows[0]!.id)
      return {
        resolved: false,
        documentId: found.rows[0]!.id,
        message: `"${found.rows[0]!.drawing_no}" 로 보입니다. 경로 재선택에서 확인해 주세요.`,
      }
    }
    if (found.rows.length > 1) {
      return { resolved: false, documentId: null, message: '같은 이름의 자료가 둘 이상입니다. 직접 골라 주세요.' }
    }
    void userId
    return { resolved: false, documentId: null, message: '이름이 맞는 자료를 찾지 못했습니다.' }
  })
}

export async function discardIssue(issueId: number, userId: number) {
  await tx(async (c) => {
    const issue = await q.findIssue(c, issueId)
    if (!issue) throw Errors.notFound('확인 필요 건')
    await q.closeIssue(c, issueId, 'DISCARDED', userId)
  })
}

// ── 중복반출 현황 ───────────────────────────────────────────────────────

export async function duplicateDistributions(documentId: number) {
  const doc = await q.documentBrief(documentId)
  if (!doc) throw Errors.notFound('자료')
  const rows = await q.listDuplicateDistributions(documentId)
  const vendors = new Set(rows.filter((r) => r.returnedAt === null).map((r) => r.vendorName))

  return {
    documentId,
    drawingNo: doc.drawingNo,
    vendorCount: vendors.size,
    items: rows.map((r) => ({
      distributionId: r.distributionId,
      vendorName: r.vendorName,
      projectName: r.projectName,
      revAtDistribution: r.revAtDistribution,
      distributedAt: r.distributedAt.toISOString(),
      returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
      arrived: r.returnedAt !== null,
      branch: r.branch,
    })),
  }
}

// ── 병합본 첨부 후 승인 ─────────────────────────────────────────────────

/**
 * 사람이 CAD 로 통합한 본을 올려 정식 Rev 로 승인한다.
 * 시스템이 합쳐 주는 것이 아니다 — 통합본 파일을 받아 '사내' 이름으로 등록할 뿐이다.
 */
export async function branchMerge(
  documentId: number,
  files: IncomingFile[],
  projectId: number | null,
  userId: number,
) {
  const { INTERNAL_VENDOR } = await import('@tdms/contracts')
  const uploaded = await registerRevision(
    documentId, files, { id: null, name: INTERNAL_VENDOR }, projectId, userId,
  )

  // 바로 승인한다 — 통합본은 CM 본인이 올리는 것이라 검수 대상이 아니다
  const set = await tx((c) => q.setFiles(c, documentId, Number(uploaded.revLabel.replace(/\D/g, '')), null))
  if (set.length === 0) throw Errors.conflict('EMPTY_SET', '등록된 파일이 없습니다.')

  const result = await review(set[0]!.id, 'APPROVE', '분기 통합본', () => true)
  const closed = await tx((c) => q.closeBranchSiblings(c, documentId))

  return { documentId, revLabel: result.revLabel, closedBranches: closed }
}
