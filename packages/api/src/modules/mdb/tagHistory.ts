import type pg from 'pg'
import type { TagHistoryCreateRequest, TagHistoryUpdateRequest } from '@tdms/contracts'
import { many, one } from '../../core/db.js'
import { tx } from '../../core/db.js'
import { Errors } from '../../core/errors.js'
import { yearFromTopFolder } from './grouping.js'
import { visibleNames } from './typeLists.js'

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
  folderId: number | null
  folderName: string | null
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
         h.folder_id     AS "folderId",
         f.name          AS "folderName",
         h.state,
         h.applied_count AS "appliedCount",
         u.name          AS "createdBy",
         h.created_at    AS "createdAt",
         h.applied_at    AS "appliedAt",
         h.reverted_at   AS "revertedAt"
    FROM mdb_tag_histories h
    LEFT JOIN projects p ON p.id = h.project_id
    LEFT JOIN users u    ON u.id = h.created_by
    LEFT JOIN folders f  ON f.id = h.folder_id`

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
    // 되돌린 이력은 [다시 적용] 할 수 있다 — 그 사이 들어온 자료까지 함께 바뀐다
    if (h.state === 'APPLIED') {
      throw Errors.conflict('ALREADY_APPLIED', '이미 적용된 이력입니다.')
    }
    return applyIn(c, h, false)
  })
}

async function applyIn(
  c: pg.PoolClient,
  h: { id: number; base_tag: string; old_tag: string | null; new_tag: string | null },
  allowEmpty: boolean,
) {
  const historyId = h.id
  if (!h.new_tag) throw Errors.invalid('NO_NEW_TAG', '바꿀 Tag 가 비어 있습니다.')

  const rows = await targetsOf(c, historyId)
  if (!rows.length && !allowEmpty) throw Errors.invalid('NO_TARGET', '바꿀 대상이 없습니다.')

  // 예전 적용 기록(되돌린 것)은 지우고 새로 남긴다
  await c.query('DELETE FROM mdb_tag_history_items WHERE history_id = $1', [historyId])
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
        SET state = 'APPLIED', applied_at = now(), reverted_at = NULL, applied_count = $2
      WHERE id = $1`,
    [historyId, upd.rowCount ?? 0],
  )
  return { applied: upd.rowCount ?? 0, historyId }
}

export async function revert(historyId: number) {
  return tx(async (c) => {
    const h = await findHistory(c, historyId)
    if (h.state !== 'APPLIED') {
      throw Errors.conflict('NOT_APPLIED', '적용된 이력만 되돌릴 수 있습니다.')
    }
    return revertIn(c, historyId)
  })
}

async function revertIn(c: pg.PoolClient, historyId: number) {
  // 남겨 둔 기록대로 하나씩 돌려놓는다 (일괄 UPDATE 로는 원래 값을 알 수 없다)
  const items = await c.query<{ mdb_file_id: number; old_tag: string | null; new_tag: string | null }>(
    'SELECT mdb_file_id, old_tag, new_tag FROM mdb_tag_history_items WHERE history_id = $1',
    [historyId],
  )
  let reverted = 0
  for (const it of items.rows) {
    if (!it.old_tag || !it.new_tag) continue
    // 원래 Tag 가 이미 다시 붙어 있으면(그 사이 사람이 달았으면) 새 Tag 만 뗀다
    await c.query(
      'DELETE FROM mdb_file_tags WHERE mdb_file_id = $1 AND tag_no = $2 AND EXISTS (SELECT 1 FROM mdb_file_tags x WHERE x.mdb_file_id = $1 AND x.tag_no = $3)',
      [it.mdb_file_id, it.new_tag, it.old_tag],
    )
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
}

/**
 * 이력 수정 (기존 PATCH /mdb-tag-history/:id).
 *
 * 적용된 이력의 Tag·범위를 고치면 "기존에 반영되었던 이력이 수정된 내용으로 바뀐다" —
 * 예전 적용분을 기록대로 되돌린 뒤 새 내용으로 다시 적용한다. 한 트랜잭션이라 반쪽이 없다.
 * 사유·비고만 고치면 자료는 건드리지 않는다. 되돌린 이력은 내용만 고친다.
 */
export async function update(historyId: number, v: TagHistoryUpdateRequest) {
  return tx(async (c) => {
    const h = await findHistory(c, historyId)
    const reasonDetail = v.reasonDetail !== undefined ? v.reasonDetail : v.note
    const baseTag = v.baseTag?.trim() || h.base_tag
    const newTag = v.newTag?.trim() || h.new_tag
    const folderId = v.folderId !== undefined ? v.folderId : h.folder_id
    const scopeChanged =
      baseTag !== h.base_tag || newTag !== h.new_tag || folderId !== h.folder_id

    let reapplied: { applied: number } | null = null
    if (scopeChanged && h.state === 'APPLIED') await revertIn(c, historyId)

    await c.query(
      `UPDATE mdb_tag_histories
          SET base_tag = $2, new_tag = $3, folder_id = $4,
              reason = CASE WHEN $5::boolean THEN $6 ELSE reason END,
              reason_detail = CASE WHEN $7::boolean THEN $8 ELSE reason_detail END,
              old_tag = CASE WHEN $9::boolean THEN NULL ELSE old_tag END
        WHERE id = $1`,
      [
        historyId, baseTag, newTag, folderId,
        v.reason !== undefined, v.reason ?? null,
        reasonDetail !== undefined, reasonDetail ?? null,
        baseTag !== h.base_tag,
      ],
    )

    if (scopeChanged && h.state === 'APPLIED') {
      reapplied = await applyIn(c, {
        id: historyId, base_tag: baseTag,
        old_tag: baseTag !== h.base_tag ? null : h.old_tag, new_tag: newTag,
      }, true)
    }
    return { ok: true as const, reapplied: reapplied?.applied ?? null }
  })
}

export async function updateNote(historyId: number, reasonDetail: string | null) {
  await update(historyId, { reasonDetail })
}

// ── 등록 팝업 보조 ──────────────────────────────────────────────────────

/** 목록 거르기 · 등록 팝업의 선택지 */
export async function meta() {
  const [reasons, years, projects] = await Promise.all([
    visibleNames('mdb-tag-reasons'),
    many<{ y: number }>(
      `SELECT DISTINCT extract(year FROM created_at)::int AS y FROM mdb_tag_histories ORDER BY 1 DESC`,
    ),
    many<{ n: string }>(
      `SELECT DISTINCT coalesce(f.name, p.name) AS n
         FROM mdb_tag_histories h
    LEFT JOIN folders f  ON f.id = h.folder_id
    LEFT JOIN projects p ON p.id = h.project_id
        WHERE coalesce(f.name, p.name) IS NOT NULL
        ORDER BY 1`,
    ),
  ])
  return { reasons, years: years.map((r) => r.y), projects: projects.map((r) => r.n) }
}

/** 공사 드롭다운 — MDB 폴더 트리 최상위 폴더 (빈 폴더도 고를 수 있어야 트리와 어긋나지 않는다) */
export async function projectFolders() {
  const rows = await many<{ id: number; name: string }>(
    `SELECT id, name FROM folders
      WHERE doc_class = 'MDB' AND parent_id IS NULL AND NOT is_archived
      ORDER BY name`,
  )
  return { items: rows.map((r) => ({ folderId: r.id, name: r.name, year: yearFromTopFolder(r.name) })) }
}

/** 등록 전에 "이 Tag No 가 붙은 자료가 몇 건인지" 먼저 보여준다 */
export async function preview(tag: string, folderId: number | null) {
  const items = await many<{ mdbFileId: number; title: string; folderName: string; currentTag: string }>(
    `SELECT t.mdb_file_id AS "mdbFileId", m.title, f.name AS "folderName", t.tag_no AS "currentTag"
       FROM mdb_file_tags t
       JOIN mdb_files m ON m.id = t.mdb_file_id AND NOT m.is_archived
       JOIN folders f   ON f.id = m.folder_id
      WHERE t.tag_no = $1
        AND ($2::bigint IS NULL
             OR EXISTS (SELECT 1 FROM folders r WHERE r.id = $2 AND f.path <@ r.path))
      ORDER BY m.title
      LIMIT 1000`,
    [tag.trim(), folderId],
  )
  return { items }
}

async function findHistory(c: pg.PoolClient, id: number) {
  const r = await c.query<{
    id: number; base_tag: string; old_tag: string | null; new_tag: string | null; state: string
    folder_id: number | null
  }>(
    'SELECT id, base_tag, old_tag, new_tag, state, folder_id FROM mdb_tag_histories WHERE id = $1 FOR UPDATE',
    [id],
  )
  const row = r.rows[0]
  if (!row) throw Errors.notFound('Tag 이력')
  return row
}
