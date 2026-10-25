import { many, one, query } from '../../core/db.js'

export interface JobRow {
  id: number
  kind: string
  state: string
  progress: number
  progressNote: string | null
  error: string | null
  result: { filename?: string; sha256?: string; byteSize?: number } | null
  requestedBy: number | null
  createdAt: Date
  finishedAt: Date | null
}

const SELECT_JOB = `
  SELECT id, kind, state, progress,
         progress_note AS "progressNote",
         error, result,
         requested_by  AS "requestedBy",
         created_at    AS "createdAt",
         finished_at   AS "finishedAt"
    FROM jobs`

export async function enqueue(
  kind: string,
  payload: unknown,
  requestedBy: number,
  priority = 100,
): Promise<number> {
  // INSERT 트리거가 pg_notify('job_enqueued') 를 보낸다 — 워커가 폴링하지 않는다
  const row = await one<{ id: number }>(
    `INSERT INTO jobs (kind, payload, requested_by, priority)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [kind, JSON.stringify(payload), requestedBy, priority],
  )
  return row!.id
}

export function findJob(id: number) {
  return one<JobRow>(`${SELECT_JOB} WHERE id = $1`, [id], 'job_by_id')
}

/** 자기가 요청한 작업만 볼 수 있다 (ADMIN 은 라우트에서 예외 처리) */
export function listMyJobs(userId: number, limit = 20) {
  return many<JobRow>(
    `${SELECT_JOB} WHERE requested_by = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
    'jobs_mine',
  )
}

export function cancelJob(id: number, userId: number) {
  return query(
    `UPDATE jobs SET state = 'canceled', finished_at = now()
      WHERE id = $1 AND requested_by = $2 AND state = 'queued'`,
    [id, userId],
  )
}

/** heartbeat 가 2분 이상 끊긴 running 작업을 큐로 되돌린다 (좀비 회수) */
export function reviveZombies() {
  return query(
    `UPDATE jobs
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            error = CASE WHEN attempts >= max_attempts
                         THEN '워커가 응답하지 않아 중단되었습니다' ELSE error END,
            locked_by = NULL
      WHERE state = 'running' AND heartbeat_at < now() - interval '2 minutes'`,
  )
}
