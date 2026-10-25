import type pg from 'pg'
import type { TagHistoryCreateRequest } from '@tdms/contracts'
import { many, one } from '../../core/db.js'
import { tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'

/**
 * MDB Tag 이력.
 *
 * 설비 Tag 가 바뀌면(설비 교체·체계 변경·오기 정정) 그 자료들의 Tag 를 한꺼번에 고친다.
 * **되돌릴 수 있어야 하므로 어느 자료의 어느 Tag 를 바꿨는지 낱낱이 남긴다**
 * (mdb_tag_history_items). 일괄 UPDATE 만 하고 끝내면 복구할 방법이 없다.
 *
 * 흐름: DRAFT 등록 → 대상 미리보기 → APPLIED 적용 → (필요하면) REVERTED 되돌리기
 */

interface HistRow {
  id: number
  baseTag: string
  oldTag: string | null
  newTag: string | null
  reason: string | null
  reasonDetail: string | null
  projectName: string | null
  state: string
  appliedCount: number
  createdBy: string | null
  createdAt: Date
  appliedAt: Date | null
  revertedAt: Date | null
}

const SELECT_HIST = `
  SELECT h.id,
         h.base_tag      AS "baseTag",
         h.old_tag       AS "oldTag",
         h.new_tag       AS "newTag",
         h.reason, h.reason_detail AS "reasonDetail",
         p.name          AS "projectName",
         h.state,
         h.applied_count AS "appliedCount",
         u.name          AS "createdBy",
         h.created_at    AS "createdAt",
         h.applied_at    AS "appliedAt",
         h.reverted_at   AS "revertedAt"
    FROM mdb_tag_histories h
    LEFT JOIN projects p ON p.id = h.project_id
    LEFT JOIN users u    ON u.id = h.created_by`

export async function list() {
  const rows = await many<HistRow>(`${SELECT_HIST} ORDER BY h.created_at DESC`, [], 'tag_hist_list')
  return {
    items: rows.map((h) => ({
      ...h,
      state: h.state as never,
      createdAt: h.createdAt.toISOString(),
      appliedAt: h.appliedAt ? h.appliedAt.toISOString() : null,
      revertedAt: h.revertedAt ? h.revertedAt.toISOString() : null,
    })),
  }
}

export async function create(v: TagHistoryCreateRequest, userId: number) {
  const row = await one<{ id: number }>(
    `INSERT INTO mdb_tag_histories
       (base_tag, old_tag, new_tag, reason, reason_detail, project_id, folder_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [v.baseTag, v.oldTag, v.newTag, v.reason, v.reasonDetail, v.projectId, v.folderId, userId],
  )
  return { id: row!.id }
}

/** 적용하면 무엇이 바뀌는가 — 먼저 보여준다 */
async function targetsOf(c: pg.PoolClient, historyId: number) {
  const r = await c.query<{
    mdbFileId: number; title: string; folderName: string; currentTag: string
  }>(
    `SELECT t.mdb_file_id AS "mdbFileId", m.title, f.name AS "folderName", t.tag_no AS "currentTag"
       FROM mdb_tag_histories h
       JOIN mdb_file_tags t ON t.tag_no = coalesce(h.old_tag, h.base_tag)
       JOIN mdb_files m     ON m.id = t.mdb_file_id AND NOT m.is_archived
       JOIN folders f       ON f.id = m.folder_id
      WHERE h.id = $1
        AND (h.project_id IS NULL OR m.project_id = h.project_id)
        AND (h.folder_id IS NULL
             OR EXISTS (SELECT 1 FROM folders r
                         WHERE r.id = h.folder_id AND f.path <@ r.path))
      ORDER BY m.title`,
    [historyId],
  )
  return r.rows
}

export async function targets(historyId: number) {
  return tx(async (c) => ({ items: await targetsOf(c, historyId) }))
}

export async function apply(historyId: number) {
  return tx(async (c) => {
    const h = await findHistory(c, historyId)
    if (h.state !== 'DRAFT') {
      throw Errors.conflict('ALREADY_APPLIED', '이미 적용되었거나 되돌린 이력입니다.')
    }
    if (!h.new_tag) throw Errors.invalid('NO_NEW_TAG', '바꿀 Tag 가 비어 있습니다.')

    const rows = await targetsOf(c, historyId)
    if (!rows.length) throw Errors.invalid('NO_TARGET', '바꿀 대상이 없습니다.')

    // 되돌릴 수 있도록 어느 자료의 어느 Tag 를 바꿨는지 낱낱이 남긴다
    await c.query(
      `INSERT INTO mdb_tag_history_items (history_id, mdb_file_id, old_tag, new_tag)
       SELECT $1::bigint, u.id, u.old, $2::text
         FROM unnest($3::bigint[], $4::text[]) AS u(id, old)
       ON CONFLICT (history_id, mdb_file_id) DO NOTHING`,
      [historyId, h.new_tag, rows.map((r) => r.mdbFileId), rows.map((r) => r.currentTag)],
    )

    // 같은 자료에 새 Tag 가 이미 있으면 중복이 되므로 먼저 지운다
    await c.query(
      `DELETE FROM mdb_file_tags
        WHERE mdb_file_id = ANY($1::bigint[]) AND tag_no = $2`,
      [rows.map((r) => r.mdbFileId), h.new_tag],
    )
    const upd = await c.query(
      `UPDATE mdb_file_tags SET tag_no = $2
        WHERE mdb_file_id = ANY($1::bigint[]) AND tag_no = $3`,
      [rows.map((r) => r.mdbFileId), h.new_tag, h.old_tag ?? h.base_tag],
    )

    await c.query(
      `UPDATE mdb_tag_histories
          SET state = 'APPLIED', applied_at = now(), applied_count = $2 WHERE id = $1`,
      [historyId, upd.rowCount ?? 0],
    )
    return { applied: upd.rowCount ?? 0, historyId }
  })
}

export async function revert(historyId: number) {
  return tx(async (c) => {
    const h = await findHistory(c, historyId)
    if (h.state !== 'APPLIED') {
      throw Errors.conflict('NOT_APPLIED', '적용된 이력만 되돌릴 수 있습니다.')
    }

    // 남겨 둔 기록대로 하나씩 돌려놓는다 (일괄 UPDATE 로는 원래 값을 알 수 없다)
    const items = await c.query<{ mdb_file_id: number; old_tag: string | null; new_tag: string | null }>(
      'SELECT mdb_file_id, old_tag, new_tag FROM mdb_tag_history_items WHERE history_id = $1',
      [historyId],
    )
    let reverted = 0
    for (const it of items.rows) {
      if (!it.old_tag || !it.new_tag) continue
      const r = await c.query(
        'UPDATE mdb_file_tags SET tag_no = $2 WHERE mdb_file_id = $1 AND tag_no = $3',
        [it.mdb_file_id, it.old_tag, it.new_tag],
      )
      reverted += r.rowCount ?? 0
    }

    await c.query(
      `UPDATE mdb_tag_histories SET state = 'REVERTED', reverted_at = now() WHERE id = $1`,
      [historyId],
    )
    return { reverted }
  })
}

export async function updateNote(historyId: number, reasonDetail: string | null) {
  await tx(async (c) => {
    await findHistory(c, historyId)
    await c.query('UPDATE mdb_tag_histories SET reason_detail = $2 WHERE id = $1',
      [historyId, reasonDetail])
  })
}

async function findHistory(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; base_tag: string; old_tag: string | null; new_tag: string | null; state: string
  }>(
    'SELECT id, base_tag, old_tag, new_tag, state FROM mdb_tag_histories WHERE id = $1 FOR UPDATE',
    [id],
  )
  const row = r.rows[0]
  if (!row) throw Errors.notFound('Tag 이력')
  return row
}
