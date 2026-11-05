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

export type ProgressFn = (percent: number, note?: string) => Promise<void>

/**
 * 작업 행을 running 으로 만들고, 응답을 보낸 뒤 fn 을 백그라운드에서 돌린다.
 * 진행률은 jobs.progress 로 나가 화면(JobProgress)이 SSE 로 받는다. 하트비트는 30초마다 —
 * 2분 넘게 끊기면 워커의 좀비 회수가 '실패'로 닫는다.
 * fn 이 돌려준 {result, note} 로 끝내고(note 가 완료 안내문), 던지면 그 메시지로 실패 처리한다.
 */
export async function runInApi(
  kind: string,
  payload: unknown,
  userId: number,
  fn: (jobId: number, progress: ProgressFn) => Promise<{ result: unknown; note: string }>,
  log?: { error: (obj: unknown, msg?: string) => void },
): Promise<number> {
  const jobId = await q.insertRunning(kind, payload, userId)

  let last = -1
  let lastAt = 0
  const progress: ProgressFn = async (percent, note) => {
    const p = Math.max(0, Math.min(99, Math.round(percent)))
    const now = Date.now()
    // 같은 값을 반복해서 쓰지 않는다 — 쓰기 증폭을 막는다
    if (!note && (p === last || (now - lastAt < 300 && p - last < 5))) return
    last = p
    lastAt = now
    await q.updateProgress(jobId, p, note ?? null)
  }

  setImmediate(() => {
    const beat = setInterval(() => void q.heartbeat(jobId).catch(() => {}), 30_000)
    fn(jobId, progress)
      .then(({ result, note }) => q.markDone(jobId, result, note))
      .catch(async (e: unknown) => {
        log?.error({ err: e, jobId }, `${kind} 작업 실패`)
        await q.markFailed(jobId, (e instanceof Error ? e.message : String(e)).slice(0, 4000)).catch(() => {})
      })
      .finally(() => clearInterval(beat))
  })
  return jobId
}
