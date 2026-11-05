import type pg from 'pg'
import { many, tx } from '../../core/db.js'
import { invalidate } from '../../core/cache.js'

/**
 * MDB 원본·사본(DWG·PDF) 폴더 병합 (기존 mdb_editor.py /pair-folders/*).
 *
 * 한 폴더 바로 밑에 DWG 폴더와 PDF 폴더가 **둘 다** 있는 자리만 후보다. 양쪽에
 * **대소문자까지 같은** 자료명이 있으면 그 둘을 상위 폴더의 자료 1건으로 합친다
 * (파일은 상위 폴더로 옮기고 pairing_folder 에 원래 폴더 이름을 남긴다).
 *
 * TDB 쪽(modules/editor)과 달리 폴더 전체를 통째로 올리지 않는다 — 짝이 없는 자료까지
 * 올리면 "원본만 있는 자료" 가 상위 폴더에 섞여 보인다. 합칠 수 없는 것은 사유와 함께 남긴다.
 *   · 같은 형식(확장자)이 양쪽에 다 있다
 *   · 상위 폴더에 같은 이름 자료가 이미 있다
 * 대소문자만 다른 이름은 합치지 않고 알려만 준다 (이름을 바로잡게 한다).
 */

interface PairRow {
  parentId: number
  parentName: string
  parentPath: string
  dwgFolderId: number
  dwgFolderName: string
  pdfFolderId: number
  pdfFolderName: string
  dwgTitles: string[] | null
  pdfTitles: string[] | null
}

function pairRows(c: pg.PoolClient | null, parentIds: number[] | null) {
  const sql = `
    SELECT DISTINCT ON (p.id)
           p.id AS "parentId", p.name AS "parentName",
           (SELECT string_agg(a.name, ' / ' ORDER BY a.depth)
              FROM folders a WHERE a.path @> p.path) AS "parentPath",
           dwg.id AS "dwgFolderId", dwg.name AS "dwgFolderName",
           pdf.id AS "pdfFolderId", pdf.name AS "pdfFolderName",
           (SELECT array_agg(DISTINCT m.title) FROM mdb_files m
             WHERE m.folder_id = dwg.id AND NOT m.is_archived) AS "dwgTitles",
           (SELECT array_agg(DISTINCT m.title) FROM mdb_files m
             WHERE m.folder_id = pdf.id AND NOT m.is_archived) AS "pdfTitles"
      FROM folders p
      JOIN folders dwg ON dwg.parent_id = p.id AND upper(dwg.name) = 'DWG' AND NOT dwg.is_archived
      JOIN folders pdf ON pdf.parent_id = p.id AND upper(pdf.name) = 'PDF' AND NOT pdf.is_archived
     WHERE p.doc_class = 'MDB' AND NOT p.is_archived
       AND ($1::bigint[] IS NULL OR p.id = ANY($1::bigint[]))
     ORDER BY p.id, dwg.id, pdf.id`
  if (c) return c.query<PairRow>(sql, [parentIds]).then((r) => r.rows)
  return many<PairRow>(sql, [parentIds])
}

function analyse(r: PairRow) {
  const dwg = new Set(r.dwgTitles ?? [])
  const pdf = new Set(r.pdfTitles ?? [])
  const mergeable = [...dwg].filter((t) => pdf.has(t)).sort()
  const pdfByLower = new Map<string, string[]>()
  for (const t of pdf) {
    if (dwg.has(t)) continue
    const k = t.toLowerCase()
    pdfByLower.set(k, [...(pdfByLower.get(k) ?? []), t])
  }
  const caseMismatch: string[] = []
  for (const t of dwg) {
    if (pdf.has(t)) continue
    const others = pdfByLower.get(t.toLowerCase()) ?? []
    if (others.length === 1) caseMismatch.push(`${t} ↔ ${others[0]}`)
  }
  caseMismatch.sort()
  return { dwgCount: dwg.size, pdfCount: pdf.size, mergeable, caseMismatch }
}

export async function candidates() {
  const rows = await pairRows(null, null)
  const items = rows
    .map((r) => ({ r, a: analyse(r) }))
    // 합칠 게 0건이어도 대소문자만 다른 것이 있으면 보여준다 — 둘 다 0일 때만 뺀다
    .filter(({ a }) => a.mergeable.length || a.caseMismatch.length)
    .map(({ r, a }) => ({
      parentId: r.parentId,
      parentName: r.parentName,
      parentPath: r.parentPath,
      dwgFolderId: r.dwgFolderId,
      dwgFolderName: r.dwgFolderName,
      pdfFolderId: r.pdfFolderId,
      pdfFolderName: r.pdfFolderName,
      dwgCount: a.dwgCount,
      pdfCount: a.pdfCount,
      mergeableCount: a.mergeable.length,
      caseMismatchCount: a.caseMismatch.length,
      caseMismatchNames: a.caseMismatch.slice(0, 50),
    }))
    .sort((x, y) => x.parentPath.localeCompare(y.parentPath))
  return { items }
}

export async function merge(parentIds: number[]) {
  const out = await tx(async (c) => {
    let merged = 0
    const skipped: { parentId: number; name: string; reason: string }[] = []
    const emptied: number[] = []

    for (const r of await pairRows(c, [...new Set(parentIds)])) {
      const { mergeable } = analyse(r)
      for (const name of mergeable) {
        const files = await c.query<{ id: number; file_ext: string }>(
          `SELECT id, lower(file_ext) AS file_ext FROM mdb_files
            WHERE folder_id IN ($1, $2) AND title = $3 AND NOT is_archived FOR UPDATE`,
          [r.dwgFolderId, r.pdfFolderId, name],
        )
        const exts = files.rows.map((f) => f.file_ext)
        if (exts.length !== new Set(exts).size) {
          skipped.push({ parentId: r.parentId, name, reason: '같은 형식(확장자) 파일이 양쪽에 있어 합칠 수 없습니다' })
          continue
        }
        const taken = await c.query(
          'SELECT 1 FROM mdb_files WHERE folder_id = $1 AND title = $2 AND NOT is_archived LIMIT 1',
          [r.parentId, name],
        )
        if (taken.rowCount) {
          skipped.push({ parentId: r.parentId, name, reason: '상위 폴더에 같은 이름 자료가 이미 있습니다' })
          continue
        }
        await c.query(
          `UPDATE mdb_files
              SET pairing_folder = CASE WHEN folder_id = $2 THEN $4 ELSE $5 END,
                  folder_id = $1, updated_at = now()
            WHERE id = ANY($3::bigint[])`,
          [r.parentId, r.dwgFolderId, files.rows.map((f) => f.id), r.dwgFolderName, r.pdfFolderName],
        )
        merged += 1
      }
      emptied.push(r.dwgFolderId, r.pdfFolderId)
    }

    // 다 빠져나간 DWG·PDF 폴더는 지우지 않고 표시용 빈 폴더로 남긴다
    if (emptied.length) {
      await c.query(
        `UPDATE folders f SET is_placeholder = true, updated_at = now()
          WHERE f.id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM mdb_files m WHERE m.folder_id = f.id AND NOT m.is_archived)
            AND NOT EXISTS (SELECT 1 FROM folders ch WHERE ch.parent_id = f.id AND NOT ch.is_archived)`,
        [emptied],
      )
    }
    return { merged, skipped }
  })
  await invalidate('cache_tree')
  return out
}
