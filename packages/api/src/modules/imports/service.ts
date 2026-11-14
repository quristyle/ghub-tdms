import type pg from 'pg'
import {
  approveOutcome, branchApprovalBlocked, buildIssueDetail, determineRevBranch, diagnoseIssue,
  duplicateExtGroups, fallbackDetailText, fileExtOf, fileStem, type IncomingEntry, type IssueDetail,
  nameKeys, newNameTailProblem, reasonText, rejectLetter, revLabel, revName, safeZipSegment, strayDetail,
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
  opts: { distributionId?: number | null } = {},
): Promise<UploadOutcome> {
  if (files.length === 0) throw Errors.invalid('NO_FILES', '올릴 파일이 없습니다.')
  return tx((c) => registerRevisionIn(c, documentId, files, vendor, projectId, userId, opts))
}

/** registerRevision 의 본체 — 부르는 쪽 트랜잭션 안에서 돈다(재검수가 항목 닫기와 한 번에 묶는다) */
export async function registerRevisionIn(
  c: pg.PoolClient,
  documentId: number,
  files: IncomingFile[],
  vendor: { id: number | null; name: string },
  projectId: number | null,
  userId: number,
  opts: { distributionId?: number | null } = {},
): Promise<UploadOutcome> {
  if (files.length === 0) throw Errors.invalid('NO_FILES', '올릴 파일이 없습니다.')
  {
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
    if (firstFileId !== null) {
      await q.closeDistribution(c, documentId, vendor.id, firstFileId, opts.distributionId ?? null)
    }

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
  }
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
  const items = [...groups.values()]

  // 분기(중복반출) 건은 '몇 건 중 몇 건이 들어왔는지' 를 함께 적는다 — 화면의 '1-a(2/3)'.
  // 자료 수만큼 질의하지 않고 한 번에 받아 온다.
  const branchDocIds = [...new Set(items.filter((g) => g.isBranch).map((g) => g.documentId))]
  if (branchDocIds.length) {
    const progress = new Map(
      (await q.branchProgressMany(branchDocIds)).map((r) => [r.documentId, r]),
    )
    for (const g of items) {
      const p = g.isBranch ? progress.get(g.documentId) : undefined
      if (!p || p.expected === 0) continue
      g.branchExpected = p.expected
      g.branchArrived = p.arrived
      // 반출된 것이 전부 돌아오기 전에는 승인할 수 없다 (승인 때 서버가 다시 막는다)
      g.canApprove = p.arrived >= p.expected
    }
  }

  return { items }
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
    category: r.category,
    folderPath: r.folderNames ? r.folderNames.join(' > ') : null,
    distributedExts: r.distributedExts ?? [],
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
    /** 지금 바로 승인할 수 있는가 — 분기본은 전부 돌아와야 한다 */
    canApprove: true,
    hasWarning: r.revMismatch,
    currentPdfFileId: r.currentPdfFileId,
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
// 기존 imports.py 의 save_issue · list_import_issues · resolve · reattach · recheck · discard.
// 항목 하나 = 자료 하나(원본 + PDF) 또는 반출 대상이 아닌 파일 묶음. 파일은 blob 으로 보관한다.

/** 자료 폴더 경로 → 반출 Zip 안 폴더 경로 (워커 zipbuild 와 같은 규칙) */
export function zipFolderPath(names: readonly string[] | null | undefined): string {
  return (names ?? []).map(safeZipSegment).join('/')
}

export function toIssueFile(f: { sha256: Buffer; filename: string; ext: string; byteSize: number; folder: string | null }): q.IssueFile {
  return { sha256: f.sha256.toString('hex'), filename: f.filename, ext: f.ext, byteSize: f.byteSize, folder: f.folder }
}

/** 확인 필요 한 건을 만든다 (기존 save_issue) */
export function saveIssue(
  c: pg.PoolClient,
  v: {
    files: q.IssueFile[]; reasons: string[]; detail: IssueDetail
    intendedDocumentId: number | null; vendorId: number | null; vendorName: string | null
    projectId: number | null; zipPath?: string | null; jobId?: number | null; userId: number
  },
): Promise<number> {
  return q.insertIssue(c, {
    ...v,
    detailText: v.detail.text,
    zipPath: v.zipPath ?? null,
    jobId: v.jobId ?? null,
  })
}

export async function issues() {
  const rows = await q.listIssues()
  return { items: rows.map(toIssue) }
}

function toIssue(i: q.IssueRow) {
  const guessed = i.detail?.actualStems?.[0] ?? fileStem(i.filename)
  const drawingNo = i.suggestedDrawingNo ?? guessed
  let reasons = i.reasons.length ? i.reasons : i.reason.split(',').filter(Boolean)
  let detailText = i.detail?.text || i.reasonDetail || fallbackDetailText(reasons, drawingNo)
  // 그 사이 정상 반입됐으면 '기 반입 완료'로 덮어 보여 준다 — 놔둬도 바로잡힌다는 CM 요구
  if (i.reimportedAfter) {
    reasons = ['ALREADY_IMPORTED']
    detailText = `'${drawingNo}'은(는) 이후 정상적으로 반입되었습니다. 이 항목은 반려(버림) 처리하셔도 됩니다.`
  }
  const files = i.files.length
    ? i.files.map((f) => ({ filename: f.filename, ext: f.ext, byteSize: f.byteSize, folder: f.folder }))
    : [{ filename: i.filename, ext: fileExtOf(i.filename), byteSize: i.byteSize, folder: null }]
  return {
    id: i.id,
    filename: i.filename,
    originalFilename: i.originalFilename,
    byteSize: i.byteSize,
    reason: reasons.join(','),
    reasonDetail: i.reasonDetail,
    reasons,
    detailText,
    displayName: i.suggestedDrawingNo !== null ? revName(i.suggestedDrawingNo, i.suggestedCurrentRev ?? 0) : guessed,
    files,
    hasPdf: files.some((f) => f.ext === 'pdf'),
    vendorName: i.vendorName,
    projectId: i.projectId,
    projectName: i.projectName,
    suggestedDocumentId: i.suggestedDocumentId,
    suggestedDrawingNo: i.suggestedDrawingNo,
    folderPath: i.folderNames ? i.folderNames.join(' > ') : null,
    currentPdfFileId: i.currentPdfFileId,
    createdAt: i.createdAt.toISOString(),
    createdBy: i.createdBy,
  }
}

async function openIssue(c: pg.PoolClient, issueId: number): Promise<q.IssueRecord> {
  const issue = await q.lockIssue(c, issueId)
  if (!issue) throw Errors.notFound('확인 필요 항목')
  if (issue.state !== 'OPEN') throw Errors.conflict('ALREADY_RESOLVED', '이미 처리된 항목입니다.')
  return issue
}

/**
 * 경로 재선택 — 이 파일이 실제로 어느 자료인지 CM 이 지정한다.
 * 여기서는 대상만 바꿔 둔다. 등록은 [재검수]에서 — 재첨부와 경로 재선택을 둘 다 한 뒤 한 번에
 * 다시 검사할 수 있어야 하고, CM 이 고른 자료가 맞는지도 재검수가 그대로 다시 본다(CM 확정).
 */
export async function resolveIssue(issueId: number, documentId: number) {
  return tx(async (c) => {
    await openIssue(c, issueId)
    const doc = await q.documentForDiagnosis(c, documentId)
    if (!doc) throw Errors.notFound('지정한 자료')
    const where = doc.folder_names?.join('/') || '경로 없음'
    const text =
      `대상 도면을 '${doc.drawing_no}'(${where})(으)로 다시 지정했습니다. [재검수]를 누르면 이 도면 기준으로 ` +
      `자료명·경로·원본/사본 보유 여부를 다시 확인합니다.`
    await q.retargetIssue(c, issueId, doc.id, text)
    return {
      documentId: doc.id,
      drawingNo: doc.drawing_no,
      message: `대상 도면을 '${doc.drawing_no}'(으)로 지정했습니다. [재검수]를 눌러 다시 검사해주세요.`,
    }
  })
}

/** 자료 재첨부 — 파일만 갈아끼운다. 다시 검사는 [재검수]가 한다. */
export async function reattachIssue(issueId: number, files: q.IssueFile[]) {
  if (!files.length) throw Errors.invalid('NO_FILES', '파일을 선택해주세요.')
  return tx(async (c) => {
    const issue = await openIssue(c, issueId)
    await q.addFileRefs(c, files, 1)
    await q.addFileRefs(c, issue.files, -1)
    await q.replaceIssueFiles(c, issueId, files)
    return {
      fileCount: files.length,
      message: `파일을 다시 첨부했습니다 (${files.map((f) => f.filename).join(', ')}). [재검수]를 눌러 다시 검사해주세요.`,
    }
  })
}

/**
 * 재검수 — 재첨부한 파일 / 다시 고른 자료로 처음부터 다시 검사한다.
 *   · 문제가 없으면 검수 대기로 올리고 이 항목은 닫는다
 *   · 아직 문제가 있으면 이 항목은 닫고 새 사유로 새 항목을 만든다(기존 동작, 기록은 남는다)
 */
export async function recheckIssue(issueId: number, userId: number) {
  return tx(async (c) => {
    const issue = await openIssue(c, issueId)
    if (!issue.files.length) throw Errors.invalid('NO_FILE', '첨부된 파일이 없습니다. 재첨부가 필요합니다.')

    // 대상 자료 — 정해져 있지 않으면 이름 그대로, 안 되면 꼬리를 뗀 이름으로 찾는다
    let docId = issue.suggested_document_id
    if (docId === null) {
      for (const pick of [0, -1]) {
        const stems = new Set(issue.files.map((f) => nameKeys(f.filename).at(pick) ?? ''))
        if (stems.size !== 1) continue
        docId = await q.findOutstandingByName(c, [...stems][0]!, issue.vendor_name, issue.project_id)
        if (docId !== null) {
          await q.setIssueSuggestion(c, issueId, docId)
          break
        }
      }
    }

    const doc = docId !== null ? await q.documentForDiagnosis(c, docId) : undefined
    const dist = doc ? await q.modifyDistributionFor(c, doc.id, issue.vendor_name) : undefined
    const target = doc
      ? { drawingNo: doc.drawing_no, folderPath: dist && !dist.keep_paths ? '' : zipFolderPath(doc.folder_names) }
      : null
    const entries: IncomingEntry[] = issue.files.map((f) => ({ folder: f.folder, filename: f.filename, ext: f.ext }))
    const { reasons, importedExts, missingExts } = diagnoseIssue(
      target,
      dist ? { revAtDistribution: dist.rev_at_distribution, returned: dist.returned } : null,
      doc?.current_rev ?? 0,
      dist?.exts ?? [],
      entries,
    )

    const vendor = {
      id: issue.vendor_id ?? dist?.vendor_id ?? null,
      name: issue.vendor_name ?? dist?.vendor_name ?? '미상',
    }

    if (!reasons.length && doc) {
      const out = await registerRevisionIn(
        c, doc.id,
        issue.files.map((f) => ({ sha256: Buffer.from(f.sha256, 'hex'), originalFilename: f.filename, fileExt: f.ext })),
        vendor, issue.project_id ?? dist?.project_id ?? null, userId,
        { distributionId: dist && !dist.returned ? dist.id : null },
      )
      await q.closeIssue(c, issueId, 'RESOLVED', userId, { documentId: doc.id })
      await q.addFileRefs(c, issue.files, -1)
      return {
        resolved: true,
        documentId: doc.id,
        message: `재검수 통과 — '${doc.drawing_no}' ${out.revLabel}(으)로 검수 대기에 등록했습니다.`,
      }
    }

    // 아직 문제가 있다 → 옛 항목을 닫고 새 항목을 만든다. folder 를 그대로 이어받아야
    // 다음 재검수에서도 경로를 계속 확인할 수 있다.
    const detail = doc
      ? buildIssueDetail(
          {
            documentId: doc.id, drawingNo: doc.drawing_no, folderPath: target!.folderPath,
            distributionId: dist?.id ?? null, vendorId: vendor.id, vendorName: vendor.name,
            projectId: issue.project_id, revAtDistribution: dist ? dist.rev_at_distribution : doc.current_rev,
            currentRev: doc.current_rev, distributedExts: [...importedExts, ...missingExts],
            alreadyReturned: reasons.includes('ALREADY_IMPORTED'),
          },
          entries, reasons, importedExts, missingExts,
        )
      : strayDetail(fileStem(issue.filename), importedExts)

    const newId = await saveIssue(c, {
      files: issue.files, reasons, detail, intendedDocumentId: doc?.id ?? null,
      vendorId: issue.vendor_id, vendorName: issue.vendor_name, projectId: issue.project_id,
      zipPath: issue.zip_path, userId,
    })
    await q.closeIssue(c, issueId, 'SUPERSEDED', userId, { supersededBy: newId })
    await q.addFileRefs(c, issue.files, -1)
    return {
      resolved: false,
      documentId: doc?.id ?? null,
      message: `재검수했지만 아직 문제가 있습니다 (${reasonText(reasons)}). '확인 필요' 목록에 새 항목으로 다시 올렸습니다.`,
    }
  })
}

/** 반려 — 정식 기록을 만든 적이 없으니 지우지 않고 상태만 바꾼다(감사 추적) */
export async function discardIssue(issueId: number, note: string | null, userId: number) {
  await tx(async (c) => {
    const issue = await openIssue(c, issueId)
    await q.closeIssue(c, issueId, 'DISCARDED', userId, { note })
    await q.addFileRefs(c, issue.files, -1)
  })
}

/** 확인 필요 항목의 PDF (미리보기·비교) */
export async function issuePdf(issueId: number) {
  const row = await q.findIssueFiles(issueId)
  if (!row) throw Errors.notFound('확인 필요 항목')
  const pdf = row.files.find((f) => f.ext === 'pdf')
  if (!pdf) throw Errors.notFound('PDF')
  return { sha256: Buffer.from(pdf.sha256, 'hex'), byteSize: pdf.byteSize ?? undefined, filename: `${row.displayName}.pdf` }
}

// ── 신규 자료 등록 ──────────────────────────────────────────────────────

export interface RegisterNewInput {
  folderId: number
  drawingNo: string
  title: string | null
  category: string | null
  discipline: string | null
  docType: string | null
  isblOsbl: string | null
  elevation: string | null
  area: string | null
  vendorName: string | null
  projectId: number | null
}

/**
 * 공유폴더에 없던 자료를 새로 만든다 (기존 /documents/register-new). CM 이 직접 올리는 것이라
 * 검수 없이 Rev00 승인·현재본이 된다.
 *   · 파일 세트에 PDF 가 있어야 한다 (D-19)
 *   · 같은 형식 파일은 하나씩 — 현재본은 확장자마다 하나다(0021)
 *   · 자료명에 리비전 표기를 적지 않는다 — 시스템이 붙인다
 */
export async function registerNew(input: RegisterNewInput, files: IncomingFile[], userId: number) {
  const drawingNo = input.drawingNo.trim()
  if (!drawingNo) throw Errors.invalid('DRAWING_NO_REQUIRED', '자료명(도면번호)을 적어 주세요.')
  const tail = newNameTailProblem(drawingNo)
  if (tail) throw Errors.invalid('REV_TAIL_IN_NAME', tail)
  if (!files.length) throw Errors.invalid('NO_FILES', '올릴 파일이 없습니다.')
  if (!files.some((f) => f.fileExt === 'pdf')) {
    throw Errors.invalid('PDF_REQUIRED', '파일 세트에 PDF가 없습니다. 원본과 PDF를 함께 올려야 등록됩니다 (D-19).')
  }
  const dup = duplicateExtGroups(files.map((f) => ({ ext: f.fileExt })))
  if (dup.length) {
    throw Errors.invalid('DUPLICATE_FILE', `같은 형식(${dup.join(', ')})의 파일이 2개 이상입니다. 원본 1개와 PDF 1개만 올려 주세요.`)
  }

  return tx(async (c) => {
    const folder = await q.folderForNew(c, input.folderId)
    if (!folder || folder.doc_class !== 'TDB' || folder.is_archived) throw Errors.notFound('TDB 폴더')
    const same = await q.sameNameInFolder(c, input.folderId, drawingNo)
    if (same !== null) {
      throw Errors.conflict('DUPLICATE_DRAWING_NO', `같은 폴더에 '${drawingNo}' 자료가 이미 있습니다.`, { documentId: same })
    }

    const documentId = await q.insertDocument(c, {
      folderId: input.folderId,
      drawingNo,
      title: input.title?.trim() || drawingNo,
      category: input.category, discipline: input.discipline, docType: input.docType,
      isblOsbl: input.isblOsbl, elevation: input.elevation, area: input.area,
      projectId: input.projectId,
      isIsometric: /isometric/i.test(input.docType ?? ''),
    })
    const setId = await q.createRevisionSet(c, { documentId, rev: 0, branch: null, reason: '신규 등록', userId })
    for (const f of files) {
      await q.insertApprovedFile(c, {
        documentId, revisionSetId: setId, sha256: f.sha256, fileExt: f.fileExt,
        displayName: `${revName(drawingNo, 0)}.${f.fileExt}`, originalFilename: f.originalFilename,
        vendorName: input.vendorName, projectId: input.projectId, userId,
      })
    }
    await q.refreshDocumentFlags(c, documentId)
    return { documentId, drawingNo, revLabel: revLabel(0, null), fileCount: files.length }
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
