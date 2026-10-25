#!/usr/bin/env node
/**
 * 반입·검수 전체 흐름 검증 (실제 API 호출).
 *
 * 단위 테스트(packages/contracts revision.test.ts)가 상태 머신의 규칙을 검증한다면,
 * 이 스크립트는 그 규칙이 **DB·파일 저장소와 묶였을 때도** 같게 동작하는지 본다.
 *
 *   ① 단독 반입 → 승인 → 현재본 교체, Rev 상승
 *   ② 반려 → 글자가 붙고 정수는 그대로, 반출은 미반납으로 되돌아감
 *   ③ 중복반출 → 분기 a/b → 각각 승인 → 문서가 '병합 필요'
 *   ④ 분기가 다 안 들어왔으면 승인이 막힘
 *   ⑤ 병합본 승인 → 분기 닫히고 정식 Rev 로 현재본 교체
 *
 * 사용: node db/tools/import-flow-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// API 와 같게 bigint 를 숫자로 받는다 (안 하면 문자열로 와서 요청이 검증에 걸린다)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT, '.env'))) {
  for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const BASE = 'http://127.0.0.1:8080'
let cookie = ''
let pass = 0, fail = 0

const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  ok ? pass++ : fail++
}

async function call(method, path, body, isForm = false) {
  const headers = { Cookie: cookie, Origin: BASE }
  if (body && !isForm) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, {
    method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

function pdfBlob(label) {
  const content = `BT /F1 18 Tf 60 740 Td (${label}) Tj ET\n`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'; const offs = []
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i+1} 0 obj\n${o}\nendobj\n` })
  const x = pdf.length
  pdf += `xref\n0 ${objs.length+1}\n0000000000 65535 f \n`
  for (const o of offs) pdf += `${String(o).padStart(10,'0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return new Blob([Buffer.from(pdf, 'latin1')], { type: 'application/pdf' })
}

async function upload(docId, filename, vendorName, label) {
  const fd = new FormData()
  fd.set('vendorName', vendorName)
  fd.append('file', pdfBlob(label), filename)
  return call('POST', `/documents/${docId}/revisions`, fd, true)
}

const db = new pg.Client({
  host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

/** 시험용 자료를 지운다.
 *  삭제 순서가 중요하다 — distributions.returned_file_id 가 files 를 참조하므로
 *  반출의 참조를 먼저 끊지 않으면 외래키에 걸린다. (운영 코드에는 삭제가 없다) */
async function cleanup() {
  const where = `document_id IN (SELECT id FROM documents WHERE drawing_no LIKE 'FLOW-TEST-%')`
  await db.query(`UPDATE distributions SET returned_file_id = NULL WHERE ${where}`)
  await db.query(`DELETE FROM distributions WHERE ${where}`)
  await db.query(`DELETE FROM files WHERE ${where}`)
  await db.query(`DELETE FROM revision_sets WHERE ${where}`)
  await db.query(`DELETE FROM documents WHERE drawing_no LIKE 'FLOW-TEST-%'`)
}

const main = async () => {
  await db.connect()
  await db.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

  // admin 으로 로그인 (권한 전부)
  await call('POST', '/auth/login', { loginId: 'admin', password: 'ghubadmin' })
  await call('POST', '/auth/password/defer')

  // ── 깨끗한 시험용 자료 2건을 만든다 ──────────────────────────────
  await cleanup()

  const { rows: [folder] } = await db.query(`SELECT id FROM folders WHERE doc_class='TDB' ORDER BY id LIMIT 1`)
  const mk = async (no) => (await db.query(
    `INSERT INTO documents (folder_id, drawing_no, title, current_rev, status)
     VALUES ($1,$2,$3,0,'ACTIVE') RETURNING id`, [folder.id, no, `${no} 시험용`])).rows[0].id
  const docA = await mk('FLOW-TEST-A')
  const docB = await mk('FLOW-TEST-B')

  // ── ⓪ 업로드가 내용을 잃지 않는가 (회귀) ────────────────────────
  // 한때 매직바이트 검사용 'data' 리스너가 pipeline 보다 먼저 청크를 삼켜
  // 모든 업로드가 0바이트 blob 으로 저장됐다. 다시 들어오면 여기서 잡힌다.
  console.log('\n⓪ 업로드 무결성 (회귀 검사)')
  const probe = await upload(docA, 'FLOW-TEST-A_Rev01.pdf', '대한엔지니어링', 'probe')
  const { rows: [blob] } = await db.query(
    `SELECT b.byte_size, encode(b.sha256,'hex') AS sha
       FROM files f JOIN blobs b ON b.sha256 = f.blob_sha256
      WHERE f.document_id = $1 ORDER BY f.id DESC LIMIT 1`, [docA])
  check(blob && blob.byte_size > 0, '업로드한 파일의 크기가 0 이 아니다', `${blob?.byte_size} bytes`)
  check(blob?.sha !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        '빈 입력의 sha256 이 아니다 (내용이 유실되지 않았다)')

  const dl = await fetch(`${BASE}/files/${(await call('GET','/revisions/pending-review')).body
    .items.find(g => g.drawingNo === 'FLOW-TEST-A').files[0].id}/download`, { headers: { Cookie: cookie } })
  const bytes = Buffer.from(await dl.arrayBuffer())
  check(bytes.subarray(0, 5).toString('latin1') === '%PDF-', '받은 파일이 올바른 PDF 다', `${bytes.length} bytes`)

  // 0바이트 파일은 거부한다
  const emptyFd = new FormData()
  emptyFd.set('vendorName', '대한엔지니어링')
  emptyFd.append('file', new Blob([], { type: 'application/pdf' }), 'empty.pdf')
  const emptyRes = await call('POST', `/documents/${docA}/revisions`, emptyFd, true)
  check(emptyRes.status === 422 && emptyRes.body.code === 'EMPTY_FILE', '빈 파일은 거부한다',
        emptyRes.body.code)

  // 확장자만 바꾼 파일도 거부한다
  const fakeFd = new FormData()
  fakeFd.set('vendorName', '대한엔지니어링')
  fakeFd.append('file', new Blob([Buffer.from('이건 PDF 가 아니다')]), 'fake.pdf')
  const fakeRes = await call('POST', `/documents/${docA}/revisions`, fakeFd, true)
  check(fakeRes.status === 422 && fakeRes.body.code === 'CONTENT_MISMATCH',
        '확장자만 PDF 인 파일은 거부한다', fakeRes.body.code)

  // 탐침으로 올린 건을 치우고 본 시나리오를 시작한다
  await db.query(`UPDATE distributions SET returned_file_id = NULL WHERE document_id = $1`, [docA])
  await db.query(`DELETE FROM files WHERE document_id = $1`, [docA])
  await db.query(`DELETE FROM revision_sets WHERE document_id = $1`, [docA])
  await db.query(`UPDATE documents SET current_rev = 0, status = 'ACTIVE' WHERE id = $1`, [docA])
  void probe

  // ── ① 단독 반입 → 승인 ──────────────────────────────────────────
  console.log('\n① 단독 반입 → 승인')
  const up1 = await upload(docA, 'FLOW-TEST-A_Rev01.pdf', '대한엔지니어링', 'A Rev1')
  check(up1.status === 200 && up1.body.revLabel === 'Rev1' && !up1.body.branched,
        '반입하면 Rev1, 분기 없음', `${up1.body.revLabel} branched=${up1.body.branched}`)

  const pend1 = await call('GET', '/revisions/pending-review')
  const g1 = pend1.body.items.find(g => g.drawingNo === 'FLOW-TEST-A')
  check(!!g1 && g1.files.length === 1, '검수 대기 목록에 한 세트로 뜬다', `${g1?.revLabel}`)
  check(g1?.vendorName === '대한엔지니어링', '업체명이 반입 당시 그대로 보존된다', g1?.vendorName)
  check(g1?.files[0].byteSize > 0, '목록에 보이는 파일 크기가 0 이 아니다', `${g1?.files[0].byteSize} B`)

  const rev1 = await call('POST', `/revisions/${g1.files[0].id}/review`, { action: 'APPROVE', note: '확인' })
  check(rev1.body.status === 'approved' && rev1.body.documentStatus === 'ACTIVE',
        '승인하면 정상 상태로 돌아간다')

  const { rows: [a1] } = await db.query('SELECT current_rev, status FROM documents WHERE id=$1', [docA])
  check(a1.current_rev === 1 && a1.status === 'ACTIVE', '현재 Rev 가 1 로 올랐다', `rev=${a1.current_rev}`)
  const { rows: [cur] } = await db.query(`SELECT count(*)::int n FROM files WHERE document_id=$1 AND is_current`, [docA])
  check(cur.n === 1, '현재본이 정확히 하나다')

  // ── ② 반려 → 정수 유지, 글자 부여 ───────────────────────────────
  console.log('\n② 반려 → 정수는 그대로, 글자가 붙는다')
  const up2 = await upload(docA, 'FLOW-TEST-A_Rev02.pdf', '대한엔지니어링', 'A Rev2 시도1')
  check(up2.body.revLabel === 'Rev2', '다음 시도는 Rev2')
  const pend2 = await call('GET', '/revisions/pending-review')
  const g2 = pend2.body.items.find(g => g.drawingNo === 'FLOW-TEST-A')
  const rej = await call('POST', `/revisions/${g2.files[0].id}/review`, { action: 'REJECT', note: '치수 누락' })
  check(rej.body.status === 'rejected' && rej.body.revLabel === 'Rev2-a',
        '반려하면 글자가 붙어 이력에 남는다', rej.body.revLabel)

  const { rows: [a2] } = await db.query('SELECT current_rev FROM documents WHERE id=$1', [docA])
  check(a2.current_rev === 1, '반려는 리비전 정수를 올리지 않는다', `rev=${a2.current_rev}`)

  const up3 = await upload(docA, 'FLOW-TEST-A_Rev02.pdf', '대한엔지니어링', 'A Rev2 시도2')
  check(up3.body.revLabel === 'Rev2', '재시도도 같은 정수 Rev2 를 향한다', up3.body.revLabel)

  const { rows: rejRows } = await db.query(
    `SELECT review_status, branch FROM files WHERE document_id=$1 AND rev=2 ORDER BY id`, [docA])
  check(rejRows.some(r => r.review_status === 'REJECTED' && r.branch === 'a'),
        '반려본이 지워지지 않고 이력에 남는다 (D-6)')

  // ── ③ 중복반출 → 분기 a / b ─────────────────────────────────────
  console.log('\n③ 중복반출 → 분기 a / b')
  await db.query(
    `INSERT INTO distributions (document_id, rev_at_distribution, vendor_name, purpose, distributed_by)
     VALUES ($1,0,'대한엔지니어링','MODIFY',1), ($1,0,'한성플랜트','MODIFY',1)`, [docB])

  const dup = await call('GET', `/documents/${docB}/duplicate-distributions`)
  check(dup.body.vendorCount === 2, '중복반출로 인식한다 (서로 다른 업체 2곳 미반납)',
        `업체 ${dup.body.vendorCount}곳`)

  const upA = await upload(docB, 'FLOW-TEST-B_Rev01.pdf', '대한엔지니어링', 'B Rev1-a')
  check(upA.body.revLabel === 'Rev1-a' && upA.body.branched, 'A사 반입은 분기 a', upA.body.revLabel)

  const upB = await upload(docB, 'FLOW-TEST-B_Rev01.pdf', '한성플랜트', 'B Rev1-b')
  check(upB.body.revLabel === 'Rev1-b', 'B사 반입은 분기 b', upB.body.revLabel)

  // ── ④ 전부 안 들어왔으면 분기 승인이 막힌다 ─────────────────────
  console.log('\n④ 반출이 전부 돌아오기 전에는 분기 승인이 막힌다')
  await db.query(`UPDATE distributions SET returned_at=NULL, returned_file_id=NULL
                   WHERE document_id=$1 AND vendor_name='한성플랜트'`, [docB])
  const pend3 = await call('GET', '/revisions/pending-review')
  const gA = pend3.body.items.find(g => g.drawingNo === 'FLOW-TEST-B' && g.branch === 'a')
  const blocked = await call('POST', `/revisions/${gA.files[0].id}/review`, { action: 'APPROVE', note: null })
  check(blocked.status === 422 && blocked.body.code === 'BRANCH_INCOMPLETE',
        '덜 들어왔으면 422 로 막는다', blocked.body.message?.slice(0, 40))

  // 전부 들어온 것으로 만들고 다시 승인
  await db.query(`UPDATE distributions SET returned_at=now() WHERE document_id=$1`, [docB])
  const okA = await call('POST', `/revisions/${gA.files[0].id}/review`, { action: 'APPROVE', note: null })
  check(okA.body.status === 'approved' && okA.body.documentStatus === 'MERGE_REQUIRED',
        '분기본은 승인해도 현재본이 되지 않고 "병합 필요" 가 된다', okA.body.documentStatus)

  const { rows: [b1] } = await db.query('SELECT current_rev, status FROM documents WHERE id=$1', [docB])
  check(b1.current_rev === 0 && b1.status === 'MERGE_REQUIRED',
        '분기 승인으로는 Rev 가 오르지 않는다', `rev=${b1.current_rev} ${b1.status}`)

  // ── ⑤ 병합본 승인 ───────────────────────────────────────────────
  console.log('\n⑤ 사람이 통합한 본을 올려 정식 Rev 로 승인')
  const fd = new FormData()
  fd.append('file', pdfBlob('B Rev1 통합본'), 'FLOW-TEST-B_Rev01_merged.pdf')
  const merged = await call('POST', `/documents/${docB}/branch-merge`, fd, true)
  check(merged.status === 200 && merged.body.revLabel === 'Rev1',
        '통합본은 분기 없는 정식 Rev 가 된다', merged.body.revLabel)

  const { rows: [b2] } = await db.query('SELECT current_rev, status FROM documents WHERE id=$1', [docB])
  check(b2.current_rev === 1 && b2.status === 'ACTIVE', '현재 Rev 가 1, 상태는 정상', `rev=${b2.current_rev} ${b2.status}`)

  const { rows: branches } = await db.query(
    `SELECT review_status FROM files WHERE document_id=$1 AND branch IS NOT NULL`, [docB])
  check(branches.length > 0 && branches.every(r => r.review_status === 'MERGED'),
        '열려 있던 분기본이 전부 "통합됨" 으로 닫힌다', `${branches.length}건`)

  const { rows: [bcur] } = await db.query(`SELECT count(*)::int n FROM files WHERE document_id=$1 AND is_current`, [docB])
  check(bcur.n === 1, '현재본은 통합본 하나뿐이다')

  await cleanup()
  await db.end()

  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => { console.error('오류:', e); await db.end().catch(()=>{}); process.exit(1) })
