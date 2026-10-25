#!/usr/bin/env node
/**
 * 반출이력 흐름 검증 (실제 API 호출).
 *
 *   ① 반출 실행 — Zip 이름 부여, 워커 작업 생성, 중복반출 경고
 *   ② 자료별 / Zip별 목록, 상태 라벨
 *   ③ 미입고 — 미반납 + 검수 전을 함께 센다
 *   ④ 반납 처리 / 수정없이 반납처리(권한)
 *   ⑤ 반입 대상
 *   ⑥ 반출자 조회 권한 — 권한 없으면 남의 것을 못 본다
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT,'.env'))) for (const l of readFileSync(join(ROOT,'.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }

const BASE = 'http://127.0.0.1:8080'
let pass = 0, fail = 0
const check = (ok, label, extra='') => { console.log(`  ${ok?'✓':'✗'} ${label}${extra?` — ${extra}`:''}`); ok?pass++:fail++ }

function session() {
  let cookie = ''
  return async (m, p, b) => {
    const h = { Cookie: cookie, Origin: BASE }; if (b) h['Content-Type'] = 'application/json'
    const r = await fetch(BASE+p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined })
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
    const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
    return { status: r.status, body: j }
  }
}

const db = new pg.Client({ host: process.env.PGHOST, port: +process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD })

/** 삭제 순서가 중요하다 — distributions → files → revision_sets → documents 참조 순서를 거슬러 올라간다. */
async function cleanup() {
  const docs = `SELECT id FROM documents WHERE drawing_no LIKE 'DIST-TEST-%'`
  await db.query(`DELETE FROM jobs WHERE kind='zip_build' AND payload->>'vendorName' LIKE 'DIST-TEST%'`)
  await db.query(`UPDATE distributions SET returned_file_id=NULL WHERE vendor_name LIKE 'DIST-TEST%'`)
  await db.query(`DELETE FROM distributions WHERE vendor_name LIKE 'DIST-TEST%' OR document_id IN (${docs})`)
  await db.query(`DELETE FROM files WHERE document_id IN (${docs})`)
  await db.query(`DELETE FROM revision_sets WHERE document_id IN (${docs})`)
  await db.query(`DELETE FROM documents WHERE drawing_no LIKE 'DIST-TEST-%'`)
}

const main = async () => {
  await db.connect(); await db.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)
  const admin = session()
  await admin('POST','/auth/login',{loginId:'admin',password:'ghubadmin'})
  await admin('POST','/auth/password/defer')
  await cleanup()

  const { rows:[folder] } = await db.query(`SELECT id FROM folders WHERE doc_class='TDB' ORDER BY id LIMIT 1`)
  const mk = async (no, rev=2) => (await db.query(
    `INSERT INTO documents (folder_id, drawing_no, title, current_rev, status)
     VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [folder.id, no, `${no} 시험`, rev])).rows[0].id
  const d1 = await mk('DIST-TEST-001'), d2 = await mk('DIST-TEST-002'), d3 = await mk('DIST-TEST-003')

  // ── ① 반출 실행 ─────────────────────────────────────────────────
  console.log('\n① 반출 실행')
  const made = await admin('POST','/distributions',{
    documentIds:[d1,d2,d3], vendorName:'DIST-TEST 대한', purpose:'MODIFY', keepPaths:true })
  check(made.status === 200 && made.body.created === 3, '3건을 반출한다', `${made.body.created}건`)
  check(/^\d{14}_/.test(made.body.zipName), 'Zip 이름에 시각이 붙는다', made.body.zipName)
  check(made.body.jobId > 0, 'Zip 만들기는 워커 작업으로 넘어간다', `job=${made.body.jobId}`)
  check(made.body.duplicateWarnings.length === 0, '처음 반출이라 중복 경고가 없다')

  const { rows:[snap] } = await db.query(
    `SELECT document_label, rev_at_distribution FROM distributions WHERE document_id=$1`, [d1])
  check(snap.document_label === 'DIST-TEST-001' && snap.rev_at_distribution === 2,
        '자료명과 반출 당시 Rev 를 스냅샷한다', `${snap.document_label} Rev${snap.rev_at_distribution}`)

  // 다른 업체에 같은 자료를 또 반출 → 경고 (막지는 않는다)
  const dup = await admin('POST','/distributions',{
    documentIds:[d1], vendorName:'DIST-TEST 한성', purpose:'MODIFY', keepPaths:true })
  check(dup.body.created === 1, '중복반출을 막지 않는다 (A·B 분기 흐름이 성립해야 한다)')
  check(dup.body.duplicateWarnings.length === 1
        && dup.body.duplicateWarnings[0].vendorName === 'DIST-TEST 대한',
        '이미 수정 중인 업체를 경고한다', dup.body.duplicateWarnings[0]?.vendorName)

  // ── ② 목록 ──────────────────────────────────────────────────────
  console.log('\n② 자료별 / Zip별 목록')
  const list = await admin('GET','/distributions?limit=50&q=DIST-TEST')
  check(list.body.total === 4, '자료별 목록에 4건이 보인다', `${list.body.total}건`)
  check(list.body.items.every(r => r.state === 'INCOMPLETE'), '전부 반입미완료 상태다')
  check(list.body.items[0].daysOut === 0, '나간 일수를 센다', `${list.body.items[0].daysOut}일`)

  const zips = await admin('GET','/distributions/zip-exports?limit=50')
  const myZip = zips.body.items.find(z => z.zipName === made.body.zipName)
  check(myZip?.itemCount === 3 && myZip.returnedCount === 0 && !myZip.complete,
        'Zip별 보기는 묶음 단위로 센다', `${myZip?.itemCount}건 중 ${myZip?.returnedCount}건 반입`)

  const status = await admin('GET',`/distributions/zip-status?zipName=${encodeURIComponent(made.body.zipName)}`)
  check(status.body.items.length === 3, 'Zip 상세 현황이 자료를 모두 보여준다', `${status.body.items.length}건`)

  // ── ③ 미입고 ────────────────────────────────────────────────────
  console.log('\n③ 미입고 — 미반납 + 검수 전을 함께 센다')
  const out1 = await admin('GET','/distributions/outstanding')
  const mine = out1.body.items.filter(r => r.vendorName.startsWith('DIST-TEST'))
  check(mine.length === 4, '미반납 4건이 미입고에 뜬다', `${mine.length}건`)
  check(out1.body.summary.byVendor.some(v => v.vendorName === 'DIST-TEST 대한'),
        '업체별 집계를 낸다')

  // 검수 전 상태로 돌아온 건도 미입고에 남아야 한다
  const { rows:[blob] } = await db.query(`SELECT sha256 FROM blobs LIMIT 1`)
  const { rows:[rs] } = await db.query(
    `INSERT INTO revision_sets (document_id, rev) VALUES ($1,3) RETURNING id`, [d2])
  const { rows:[pf] } = await db.query(
    `INSERT INTO files (document_id, revision_set_id, blob_sha256, rev, file_ext, display_name,
                        original_filename, review_status, uploaded_by)
     VALUES ($1,$2,$3,3,'pdf','x.pdf','x.pdf','PENDING',1) RETURNING id`, [d2, rs.id, blob.sha256])
  await db.query(`UPDATE distributions SET returned_at=now(), returned_file_id=$2
                   WHERE document_id=$1 AND vendor_name='DIST-TEST 대한'`, [d2, pf.id])

  const out2 = await admin('GET','/distributions/outstanding')
  const still = out2.body.items.find(r => r.documentLabel === 'DIST-TEST-002')
  check(!!still && still.state === 'REVIEWING',
        '돌아왔어도 검수 전이면 미입고에 남는다 (승인되면 리비전이 바뀌므로)', still?.state)

  // 승인되면 빠진다
  await db.query(`UPDATE files SET review_status='APPROVED' WHERE id=$1`, [pf.id])
  const out3 = await admin('GET','/distributions/outstanding')
  check(!out3.body.items.some(r => r.documentLabel === 'DIST-TEST-002'),
        '검수까지 끝나면 미입고에서 빠진다')

  // ── ④ 반납 처리 ─────────────────────────────────────────────────
  console.log('\n④ 반납 처리')
  const { rows: toReturn } = await db.query(
    `SELECT id FROM distributions WHERE vendor_name='DIST-TEST 대한' AND returned_at IS NULL`)
  const ret = await admin('POST','/distributions/return',
    { distributionIds: toReturn.map(r => r.id), manual: true, note: '수정 없이 반납' })
  check(ret.body.returned === toReturn.length, '수정없이 반납처리가 된다', `${ret.body.returned}건`)

  const again = await admin('POST','/distributions/return',
    { distributionIds: [toReturn[0].id], manual: true, note: null })
  check(again.body.returned === 0 && again.body.skipped[0]?.reason.includes('이미'),
        '이미 반납된 건은 건너뛰고 이유를 돌려준다', again.body.skipped[0]?.reason)

  const { rows:[mr] } = await db.query(`SELECT manual_return FROM distributions WHERE id=$1`,[toReturn[0].id])
  check(mr.manual_return === true, '수정없이 반납한 것은 표시가 남는다')

  // ── ⑤ 반입 대상 ─────────────────────────────────────────────────
  console.log('\n⑤ 반입 대상')
  const fi = await admin('GET','/distributions/for-import?vendorName=' + encodeURIComponent('DIST-TEST 한성'))
  check(fi.body.items.length === 1, '업체별 반출 목록을 돌려준다', `${fi.body.items.length}건`)
  check(fi.body.items[0].state === 'INCOMPLETE', '반입미완료만 반입 대상이 된다', fi.body.items[0]?.state)

  // ── ⑥ 반출자 조회 권한 ──────────────────────────────────────────
  console.log('\n⑥ 반출자 조회 권한')
  await db.query(`DELETE FROM group_permissions
                   WHERE group_id=(SELECT id FROM groups WHERE name='설비기술팀')
                     AND permission_key='screen.tdb_distributions.viewer.other_user'`)
  await db.query(`SELECT pg_notify('cache_perm','')`)
  await new Promise(r => setTimeout(r, 400))

  const cm = session()
  await cm('POST','/auth/login',{loginId:'cm',password:'ghubcm'}); await cm('POST','/auth/password/defer')
  const opts = await cm('GET','/distributions/filter-options')
  check(opts.body.canSelectOtherUser === false, '권한이 없으면 다른 사용자를 고를 수 없다')
  check(opts.body.distributors.length === 1, '반출자 목록에 자기 이름만 나온다',
        opts.body.distributors[0]?.name)

  const peek = await cm('GET','/distributions?distributedBy=1&limit=5')
  check(peek.status === 403 && peek.body.requiredPermission?.includes('other_user'),
        '주소로 남의 id 를 넣어도 막는다 (화면이 거르게 두지 않는다)', peek.body.code)

  await db.query(`INSERT INTO group_permissions VALUES
    ((SELECT id FROM groups WHERE name='설비기술팀'),'screen.tdb_distributions.viewer.other_user')
    ON CONFLICT DO NOTHING`)
  await db.query(`SELECT pg_notify('cache_perm','')`)

  // 수정없이 반납처리 권한
  await db.query(`DELETE FROM group_permissions
                   WHERE group_id=(SELECT id FROM groups WHERE name='설비기술팀')
                     AND permission_key='screen.tdb_distributions.confirm.manual_return'`)
  await db.query(`SELECT pg_notify('cache_perm','')`)
  await new Promise(r => setTimeout(r, 400))
  const cm2 = session()
  await cm2('POST','/auth/login',{loginId:'cm',password:'ghubcm'}); await cm2('POST','/auth/password/defer')
  const { rows:[open1] } = await db.query(
    `SELECT id FROM distributions WHERE vendor_name='DIST-TEST 한성' AND returned_at IS NULL LIMIT 1`)
  const blocked = await cm2('POST','/distributions/return',{distributionIds:[open1.id], manual:true})
  check(blocked.status === 403, '수정없이 반납처리는 별도 권한이 막는다', blocked.body.code)
  const normal = await cm2('POST','/distributions/return',{distributionIds:[open1.id], manual:false})
  check(normal.body?.returned === 1, '보통 반납처리는 통과한다')

  await db.query(`INSERT INTO group_permissions VALUES
    ((SELECT id FROM groups WHERE name='설비기술팀'),'screen.tdb_distributions.confirm.manual_return')
    ON CONFLICT DO NOTHING`)
  await db.query(`SELECT pg_notify('cache_perm','')`)

  await cleanup(); await db.end()
  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail ? 1 : 0)
}
main().catch(async e => { console.error('오류:', e.message); await db.end().catch(()=>{}); process.exit(1) })
