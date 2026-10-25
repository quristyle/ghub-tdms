import { Errors } from '../../core/errors.js'
import * as q from './queries.js'

export async function create(kind: string, payload: unknown, userId: number): Promise<number> {
  return q.enqueue(kind, payload, userId)
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
