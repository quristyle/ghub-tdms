import { Errors } from '../../core/errors.js'
import * as folders from '../folders/service.js'
import * as q from './queries.js'

export async function create(kind: string, payload: unknown, userId: number): Promise<number> {
  let enrichedPayload = payload
  if (kind === 'excel_export' && typeof payload === 'object' && payload !== null) {
    const p = payload as { target?: string; filters?: Record<string, unknown> }
    if (p.target === 'tdb_documents' && p.filters) {
      const folderId = p.filters.folderId
      if (folderId && !p.filters.folderIds) {
        // 화면의 [하위폴더 전체보기] 를 따른다 — 안 보냈으면 예전처럼 하위 포함
        const folderIds = await folders.scopeIds('TDB', Number(folderId), p.filters.recursive !== false)
        enrichedPayload = {
          ...p,
          filters: {
            ...p.filters,
            folderIds,
          },
        }
      }
    }
  }
  return q.enqueue(kind, enrichedPayload, userId)
}

function toDetail(j: q.JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    state: j.state as never,
    progress: j.progress,
    progressNote: j.progressNote,
    error: j.error,
    resultFilename: j.result?.filename ?? null,
    resultByteSize: j.result?.byteSize ?? null,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  }
}

export async function detail(id: number, userId: number, isAdmin: boolean) {
  const j = await q.findJob(id)
  if (!j) throw Errors.notFound('작업')
  if (!isAdmin && j.requestedBy !== userId) throw Errors.forbidden()
  return toDetail(j)
}

export async function raw(id: number, userId: number, isAdmin: boolean) {
  const j = await q.findJob(id)
  if (!j) throw Errors.notFound('작업')
  if (!isAdmin && j.requestedBy !== userId) throw Errors.forbidden()
  return j
}

export async function mine(userId: number) {
  return { items: (await q.listMyJobs(userId)).map(toDetail) }
}

export async function cancel(id: number, userId: number) {
  await q.cancelJob(id, userId)
}

// ── API 프로세스가 직접 처리하는 작업 (Zip 폴더 업로드 등) ───────────────
// 202 로 먼저 답한 뒤 같은 프로세스에서 처리한다. 화면은 같은 SSE(JobProgress)로 본다.

export function createRunning(kind: string, payload: unknown, userId: number): Promise<number> {
  return q.insertRunning(kind, payload, userId)
}

/** 진행률 갱신. heartbeat 도 함께 갱신된다. */
export async function progress(jobId: number, pct: number, note: string | null = null): Promise<void> {
  await q.updateProgress(jobId, pct, note)
}

/** 완료. result.note 가 있으면 진행 안내문으로도 보여 준다. */
export async function finish(jobId: number, result: unknown): Promise<void> {
  const note = typeof result === 'object' && result !== null && 'note' in result
    ? String((result as { note: unknown }).note) : null
  await q.markDone(jobId, result, note)
}

export async function fail(jobId: number, message: string): Promise<void> {
  await q.markFailed(jobId, message)
}
