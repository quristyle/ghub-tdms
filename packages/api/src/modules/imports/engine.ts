import {
  baseName, buildIssueDetail, detectWrapperPrefix, diagnoseImport, type ExpectedDrawing, fileExtOf,
  type ImportRunResult, importRunMessage, type IncomingEntry, isManifestName, parseManifestRows,
  reasonText, splitZipPath, strayDetail,
} from '@tdms/contracts'
import { registerBlob, storeStream } from '../../core/blob.js'
import { tx } from '../../core/db.js'
import { blobAbsPath } from '../../core/files.js'
import type { ProgressFn } from '../jobs/service.js'
import * as q from './queries.js'
import * as svc from './service.js'
import { ALLOWED_IN_ZIP, contentProblem, isJunkEntry } from './upload.js'
import { readFirstSheet } from './xlsx.js'
import { fileSource, openEntry, readEntries, readEntryBuffer, type ZipEntry, type ZipSource } from './zip.js'

/**
 * 반입 실행 (기존 imports.py bulk_upload_revisions · upload_revisions_by_selection).
 *
 *   반입 Zip   반출 때 받은 Zip(반출목록.xlsx + 폴더 구조 + 도면)을 그대로 올린다.
 *              반출목록의 문서ID·업체로 어느 반출 건인지 고르고, 폴더·이름으로 대조한다.
 *   반입 자료  Zip 없이 반출 건(또는 Zip 묶음 이름)을 고르고 파일을 올린다. 이름으로만 대조한다.
 *
 * 둘 다 API 안의 작업(jobs, locked_by='api')으로 돈다 — 진단이 깨끗한 세트는 리비전 등록
 * (service.registerRevision)을 그대로 써야 하기 때문이다. 진단은 @tdms/contracts/importMatch.
 */

/** 반입 파일 하나 — blob 에 이미 들어가 있다 */
export interface StoredIncoming extends IncomingEntry {
  sha256: Buffer
  byteSize: number
  zipPath: string
}

const MANIFEST_MAX = 20 * 1024 * 1024

function toExpected(r: q.ExpectedRow): ExpectedDrawing {
  return {
    documentId: r.documentId,
    drawingNo: r.drawingNo,
    // 경로 없이 반출했으면 Zip 루트에 놓였다
    folderPath: r.keepPaths ? svc.zipFolderPath(r.folderNames) : '',
    distributionId: r.distributionId,
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    projectId: r.projectId,
    revAtDistribution: r.revAtDistribution,
    currentRev: r.currentRev,
    distributedExts: r.exts,
    alreadyReturned: r.returned,
  }
}

function toIssueFiles(files: readonly StoredIncoming[]): q.IssueFile[] {
  return files.map((f) => svc.toIssueFile(f))
}

// ── 진단 → 등록 / 확인 필요 ─────────────────────────────────────────────

export async function runImport(a: {
  expected: ExpectedDrawing[]
  incoming: StoredIncoming[]
  matchByPath: boolean
  defaultVendor: { id: number | null; name: string }
  defaultProjectId: number | null
  userId: number
  jobId: number | null
  skipped: string[]
  progress: ProgressFn
  from: number
}): Promise<ImportRunResult> {
  const { sets, strays } = diagnoseImport(a.expected, a.incoming, a.matchByPath)
  const matched: ImportRunResult['matched'] = []
  const issues: ImportRunResult['issues'] = []
  const total = sets.length + strays.length || 1
  let done = 0

  for (const s of sets) {
    const e = s.expected
    let reasons: string[] = s.reasons
    let detail = reasons.length ? buildIssueDetail(e, s.files, reasons, s.importedExts, s.missingExts) : null

    if (!reasons.length) {
      try {
        const out = await svc.registerRevision(
          e.documentId,
          s.files.map((f) => ({ sha256: f.sha256, originalFilename: f.filename, fileExt: f.ext })),
          { id: e.vendorId, name: e.vendorName }, e.projectId, a.userId,
          { distributionId: e.distributionId },
        )
        matched.push({
          documentId: e.documentId, drawingNo: e.drawingNo, revLabel: out.revLabel,
          fileCount: out.created, branched: out.branched,
        })
      } catch (err) {
        // 진단은 통과했는데 등록에서 막혔다 — 파일을 잃지 않게 확인 필요로 보낸다
        reasons = ['REGISTER_FAILED']
        const base = buildIssueDetail(e, s.files, [], s.importedExts, s.missingExts)
        detail = { ...base, text: `'${e.drawingNo}' 검수 대기 등록 실패: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    if (reasons.length && detail) {
      await tx((c) => svc.saveIssue(c, {
        files: toIssueFiles(s.files), reasons, detail: detail!, intendedDocumentId: e.documentId,
        vendorId: e.vendorId, vendorName: e.vendorName, projectId: e.projectId,
        zipPath: s.files[0]?.zipPath ?? null, jobId: a.jobId, userId: a.userId,
      }))
      issues.push({ drawingNo: e.drawingNo, reasons, reasonText: reasonText(reasons) })
    }
    await a.progress(a.from + ((99 - a.from) * ++done) / total, `${done.toLocaleString()}/${total.toLocaleString()}건 진단`)
  }

  // 어느 반출 자료와도 안 맞은 파일 → 이름별로 묶어 '반출 대상 아님'
  for (const g of strays) {
    const reasons = ['NOT_DISTRIBUTED']
    await tx((c) => svc.saveIssue(c, {
      files: toIssueFiles(g.files), reasons, detail: strayDetail(g.stem, g.files.map((f) => f.ext)),
      intendedDocumentId: null, vendorId: a.defaultVendor.id, vendorName: a.defaultVendor.name,
      projectId: a.defaultProjectId, zipPath: g.files[0]?.zipPath ?? null, jobId: a.jobId, userId: a.userId,
    }))
    issues.push({ drawingNo: g.stem, reasons, reasonText: reasonText(reasons) })
    await a.progress(a.from + ((99 - a.from) * ++done) / total, `${done.toLocaleString()}/${total.toLocaleString()}건 진단`)
  }

  let message = importRunMessage(matched.length, issues.length)
  if (a.skipped.length) message += ` 받지 않은 파일 ${a.skipped.length}개: ${a.skipped.slice(0, 5).join(', ')}${a.skipped.length > 5 ? ' …' : ''}`
  return { matched, issues, skipped: a.skipped, message }
}

// ── Zip 풀기 ────────────────────────────────────────────────────────────

/** Zip 항목들을 blob 으로 꺼낸다. 군더더기는 조용히, 받을 수 없는 형식은 skipped 에 적고 건너뛴다. */
async function extractEntries(
  src: ZipSource, entries: ZipEntry[], wrapper: string, keepFolder: boolean,
  skipped: string[], progress: ProgressFn, from: number, to: number,
): Promise<StoredIncoming[]> {
  const out: StoredIncoming[] = []
  const totalBytes = entries.reduce((n, e) => n + e.uncompressedSize, 0) || 1
  let doneBytes = 0
  for (const e of entries) {
    const { folder, filename } = splitZipPath(e.name, wrapper)
    const ext = fileExtOf(filename)
    if (!ALLOWED_IN_ZIP.has(ext)) {
      skipped.push(`${e.name} (받을 수 없는 형식)`)
      continue
    }
    const stored = await storeStream(await openEntry(src, e), e.uncompressedSize)
    const problem = contentProblem(stored, ext, filename)
    if (problem) {
      skipped.push(problem.message)
      continue
    }
    await tx((c) => registerBlob(c, stored))
    out.push({
      folder: keepFolder ? folder : null, filename, ext,
      sha256: stored.sha256, byteSize: stored.byteSize, zipPath: e.name,
    })
    doneBytes += e.uncompressedSize
    await progress(from + ((to - from) * doneBytes) / totalBytes, `압축 푸는 중 ${out.length.toLocaleString()}개`)
  }
  return out
}

function usableEntries(entries: ZipEntry[]): ZipEntry[] {
  return entries.filter((e) => !e.isDir && !isJunkEntry(e.name))
}

/** 반입 Zip — 반출목록으로 반출 건을 고르고 폴더·이름으로 대조한다 */
export async function runZipImport(
  jobId: number, zipSha256: Buffer, userId: number, progress: ProgressFn,
): Promise<{ result: ImportRunResult; note: string }> {
  await progress(1, 'Zip 목록을 읽는 중')
  const src = await fileSource(blobAbsPath(zipSha256))
  try {
    const entries = usableEntries(await readEntries(src))
    const manifests = entries.filter((e) => isManifestName(e.name)).sort((x, y) => x.name.localeCompare(y.name))
    if (!manifests.length) {
      throw new Error('Zip 안에 반출목록 엑셀이 없습니다. 반출할 때 받은 Zip 을 그대로 올려주세요.')
    }
    const rows = parseManifestRows(await readFirstSheet(await readEntryBuffer(src, manifests[0]!, MANIFEST_MAX)))
    if (!rows.length) throw new Error('반출목록 엑셀에서 자료 정보(문서ID)를 읽지 못했습니다.')

    // 같은 자료가 두 줄이면 첫 줄만
    const seen = new Set<number>()
    const uniq = rows.filter((r) => (seen.has(r.documentId) ? false : (seen.add(r.documentId), true)))
    const expected = (await tx((c) => q.expectedFromManifest(
      c, uniq.map((r) => r.documentId), uniq.map((r) => r.vendorName),
    ))).rows.map(toExpected)

    const wrapper = detectWrapperPrefix(manifests.map((m) => m.name))
    const manifestNames = new Set(manifests.map((m) => m.name))
    const skipped: string[] = []
    const incoming = await extractEntries(
      src, entries.filter((e) => !manifestNames.has(e.name)), wrapper, true, skipped, progress, 3, 70,
    )

    const result = await runImport({
      expected, incoming, matchByPath: true,
      defaultVendor: expected[0] ? { id: expected[0].vendorId, name: expected[0].vendorName } : { id: null, name: '미상' },
      defaultProjectId: expected[0]?.projectId ?? null,
      userId, jobId, skipped, progress, from: 70,
    })
    return { result, note: result.message }
  } finally {
    await src.close()
  }
}

export interface SelectionPayload {
  distributionIds: number[]
  zipName: string | null
  /** 낱개로 올린 파일 */
  uploads: { sha256: string; filename: string; byteSize: number }[]
  /** 함께 올린 Zip — 풀어서 낱개처럼 쓴다(폴더는 보지 않는다) */
  zips: string[]
}

/** 반입 자료 — 고른 반출 건에 파일을 이름으로 배정한다 */
export async function runSelectionImport(
  jobId: number, p: SelectionPayload, userId: number, progress: ProgressFn,
): Promise<{ result: ImportRunResult; note: string }> {
  await progress(1, '반출 건을 읽는 중')
  const rows = await tx((c) => (p.zipName
    ? q.expectedFromZipName(c, p.zipName)
    : q.expectedFromDistributions(c, p.distributionIds)))
  const expected = rows.rows.map(toExpected)
  if (!expected.length) throw new Error('선택한 반출 건을 찾을 수 없습니다.')

  const skipped: string[] = []
  const incoming: StoredIncoming[] = p.uploads.map((u) => ({
    folder: null, filename: u.filename, ext: fileExtOf(u.filename),
    sha256: Buffer.from(u.sha256, 'hex'), byteSize: u.byteSize, zipPath: u.filename,
  }))

  for (const [i, sha] of p.zips.entries()) {
    const src = await fileSource(blobAbsPath(Buffer.from(sha, 'hex')))
    try {
      const entries = usableEntries(await readEntries(src)).filter((e) => !isManifestName(baseName(e.name)))
      const span = 60 / p.zips.length
      incoming.push(...await extractEntries(src, entries, '', false, skipped, progress, 5 + span * i, 5 + span * (i + 1)))
    } finally {
      await src.close()
    }
  }

  const result = await runImport({
    expected, incoming, matchByPath: false,
    defaultVendor: { id: expected[0]!.vendorId, name: expected[0]!.vendorName },
    defaultProjectId: expected[0]!.projectId,
    userId, jobId, skipped, progress, from: 70,
  })
  return { result, note: result.message }
}
