#!/usr/bin/env node
/**
 * 샘플 파일 적재 — 상세 화면·PDF 뷰어·다운로드 경로를 실제로 돌려 보기 위한 것.
 *
 * content-addressed 저장 규칙(packages/api/src/core/blob.ts)을 그대로 따른다:
 *   blobs/{hex[0:2]}/{hex[2:4]}/{hex}
 *
 * 사용: node db/tools/seed-files.mjs
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { readFileSync, existsSync as exists } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (exists(join(ROOT, '.env'))) {
  for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const STORAGE = process.env.STORAGE_ROOT
const BLOBS = join(STORAGE, 'blobs')

/** 최소한의 유효한 PDF 한 장. 뷰어가 실제로 열 수 있어야 하므로 직접 만든다. */
function makePdf(title) {
  const text = title.replace(/[()\\]/g, '')
  const content = `BT /F1 20 Tf 60 760 Td (${text}) Tj ET\n`
    + `BT /F1 11 Tf 60 730 Td (GHub TDMS - sample drawing for viewer verification) Tj ET\n`
    + `2 w 50 60 m 545 60 l S  50 60 m 50 790 l S  545 60 m 545 790 l S  50 790 m 545 790 l S\n`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

async function storeBlob(buf) {
  const hex = createHash('sha256').update(buf).digest('hex')
  const path = join(BLOBS, hex.slice(0, 2), hex.slice(2, 4), hex)
  await mkdir(dirname(path), { recursive: true })
  try { await stat(path) } catch { await writeFile(path, buf) }
  return { hex, size: buf.length }
}

const c = new pg.Client({
  host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})
await c.connect()
await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

const { rows: docs } = await c.query(
  `SELECT id, drawing_no, title, current_rev, folder_id FROM documents
    WHERE NOT is_isometric AND id NOT IN (SELECT document_id FROM files)
    ORDER BY id LIMIT 12`)

const { rows: [u] } = await c.query(`SELECT id FROM users WHERE login_id='admin'`)
const { rows: [v] } = await c.query(`SELECT id, name FROM vendors ORDER BY id LIMIT 1`)
const { rows: [p] } = await c.query(`SELECT id FROM projects ORDER BY id LIMIT 1`)

let files = 0, revs = 0, dists = 0
for (const d of docs) {
  // 리비전 0..current_rev 를 차례로 만든다 (이력 탭 검증용)
  for (let rev = 0; rev <= d.current_rev; rev++) {
    const isCurrent = rev === d.current_rev
    const { rows: [rs] } = await c.query(
      `INSERT INTO revision_sets (document_id, rev, reason, created_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [d.id, rev, rev === 0 ? '최초 등록' : `업체 수정본 반영 (Rev${rev})`, u.id])
    if (!rs) continue
    revs++

    const pdf = makePdf(`${d.drawing_no}  Rev${rev}`)
    const b = await storeBlob(pdf)
    await c.query(
      `INSERT INTO blobs (sha256, byte_size) VALUES (decode($1,'hex'), $2)
       ON CONFLICT (sha256) DO NOTHING`, [b.hex, b.size])
    await c.query(
      `INSERT INTO files (document_id, revision_set_id, blob_sha256, rev, file_ext,
                          display_name, original_filename, review_status, is_current, uploaded_by)
       VALUES ($1,$2,decode($3,'hex'),$4,'pdf',$5,$6,'APPROVED',$7,$8)`,
      [d.id, rs.id, b.hex, rev, `${d.drawing_no}_Rev${String(rev).padStart(2,'0')}.pdf`,
       `${d.drawing_no}.pdf`, isCurrent, u.id])
    files++
    await c.query(`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = decode($1,'hex')`, [b.hex])
  }

  // 일부에 반출 이력 (미반납 1건 포함 — '대여중' 표시와 미입고 검증용)
  if (d.id % 3 === 0) {
    await c.query(
      `INSERT INTO distributions (document_id, rev_at_distribution, vendor_id, vendor_name,
                                  project_id, purpose, distributed_by, distributed_at, returned_at)
       VALUES ($1,$2,$3,$4,$5,'MODIFY',$6, now() - interval '20 days', now() - interval '5 days'),
              ($1,$2,$3,$4,$5,'REFERENCE',$6, now() - interval '3 days', NULL)`,
      [d.id, d.current_rev, v.id, v.name, p.id, u.id])
    dists += 2
  }
  await c.query(`UPDATE documents SET has_pdf = true WHERE id = $1`, [d.id])
}

console.log(`리비전 ${revs} / 파일 ${files} / 반출 ${dists} 생성 (문서 ${docs.length}건)`)
await c.end()
