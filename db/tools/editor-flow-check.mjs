#!/usr/bin/env node
/**
 * TDB 관리 흐름 검증 (실제 API 호출).
 *
 *   ① 폴더 만들기 / 이름 변경 / 이동 — DB 작업만으로 끝나는가
 *   ② 자기 하위로 옮기기·이름 충돌을 막는가
 *   ③ 자료 이동 — 충돌 건만 건너뛰고 나머지는 옮기는가
 *   ④ 삭제 보관함 — 폴더째 묶여 한 줄, 복구 가능
 *   ⑤ 폐기 보관함 — 자료 1건 = 이력 1건, 복구만 가능 (완전 삭제 거부)
 *   ⑥ 완전 삭제 — 삭제 보관함만. 자료는 사라지고 반출 기록은 남는가
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// API 와 같게 bigint 를 숫자로 받는다 (안 하면 문자열로 와서 요청이 검증에 걸린다)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT, '.env'))) for (const l of readFileSync(join(ROOT,'.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }

const BASE = 'http://127.0.0.1:8080'
let cookie = '', pass = 0, fail = 0
const check = (ok, label, extra='') => { console.log(`  ${ok?'✓':'✗'} ${label}${extra?` — ${extra}`:''}`); ok?pass++:fail++ }
const call = async (m, p, b) => {
  const h = { Cookie: cookie, Origin: BASE }; if (b) h['Content-Type'] = 'application/json'
  const r = await fetch(BASE+p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, body: j }
}

const db = new pg.Client({ host: process.env.PGHOST, port: +process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD })

async function cleanup() {
  const w = `folder_id IN (SELECT id FROM folders WHERE name LIKE 'EDIT-TEST%')`
  await db.query(`UPDATE distributions SET returned_file_id=NULL WHERE document_id IN (SELECT id FROM documents WHERE ${w})`)
  await db.query(`DELETE FROM distributions WHERE document_id IN (SELECT id FROM documents WHERE ${w})`)
  await db.query(`DELETE FROM distributions WHERE document_label LIKE 'EDIT-TEST%'`)
  await db.query(`DELETE FROM files WHERE document_id IN (SELECT id FROM documents WHERE ${w})`)
  await db.query(`DELETE FROM revision_sets WHERE document_id IN (SELECT id FROM documents WHERE ${w})`)
  await db.query(`DELETE FROM documents WHERE ${w}`)
  // archive_batches 를 지우기 전에 folders 의 참조를 먼저 끊는다 (운영에는 삭제가 없다)
  await db.query(`UPDATE folders SET archive_batch_id=NULL WHERE name LIKE 'EDIT-TEST%'`)
  await db.query(`DELETE FROM archive_batches WHERE label LIKE 'EDIT-TEST%' OR label LIKE '자료 %건'`)
  await db.query(`DELETE FROM folders WHERE name LIKE 'EDIT-TEST%'`)
}

const main = async () => {
  await db.connect(); await db.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)
  await call('POST','/auth/login',{loginId:'admin',password:'ghubadmin'}); await call('POST','/auth/password/defer')
  await cleanup()

  // ── ① 폴더 만들기 / 이름 변경 / 이동 ─────────────────────────────
  console.log('\n① 폴더 만들기 · 이름 변경 · 이동')
  const root = (await call('POST','/editor/folders',{docClass:'TDB',parentId:null,name:'EDIT-TEST 루트'})).body
  check(root.folderId > 0, '폴더를 만든다', `id=${root.folderId}`)

  const child = (await call('POST','/editor/folders',{docClass:'TDB',parentId:root.folderId,name:'EDIT-TEST 하위'})).body
  const gchild = (await call('POST','/editor/folders',{docClass:'TDB',parentId:child.folderId,name:'EDIT-TEST 손자'})).body

  const { rows:[before] } = await db.query('SELECT path::text, depth FROM folders WHERE id=$1',[gchild.folderId])
  check(before.path === `${root.folderId}.${child.folderId}.${gchild.folderId}`,
        'ltree path 라벨이 폴더 id 다', before.path)

  const t0 = Date.now()
  await call('PATCH',`/editor/folders/${child.folderId}`,{name:'EDIT-TEST 이름바꿈'})
  const renameMs = Date.now()-t0
  const { rows:[after] } = await db.query('SELECT name, path::text FROM folders WHERE id=$1',[gchild.folderId])
  check(after.path === before.path, '이름을 바꿔도 하위 path 가 그대로다 (갱신 불필요)', `${renameMs}ms`)

  const moved = (await call('POST',`/editor/folders/${gchild.folderId}/move`,{newParentId:root.folderId})).body
  const { rows:[mv] } = await db.query('SELECT path::text, depth FROM folders WHERE id=$1',[gchild.folderId])
  check(mv.path === `${root.folderId}.${gchild.folderId}` && mv.depth === 2,
        '이동하면 path 접두어가 바뀐다', mv.path)
  void moved

  // ── ② 막아야 하는 것 ────────────────────────────────────────────
  console.log('\n② 막아야 하는 것')
  const circular = await call('POST',`/editor/folders/${root.folderId}/move`,{newParentId:gchild.folderId})
  check(circular.status === 422 && circular.body.code === 'CIRCULAR_MOVE', '자기 하위로는 못 옮긴다', circular.body.code)

  const dup = await call('POST','/editor/folders',{docClass:'TDB',parentId:root.folderId,name:'EDIT-TEST 손자'})
  check(dup.status === 409 && dup.body.code === 'NAME_TAKEN', '같은 자리 같은 이름은 거부한다', dup.body.code)

  // ── ③ 자료 이동 ─────────────────────────────────────────────────
  console.log('\n③ 자료 이동 — 충돌 건만 건너뛴다')
  const mk = async (fid, no) => (await db.query(
    `INSERT INTO documents (folder_id, drawing_no, title, status) VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
    [fid, no, `${no} 시험`])).rows[0].id
  const d1 = await mk(child.folderId, 'EDIT-TEST-001')
  const d2 = await mk(child.folderId, 'EDIT-TEST-002')
  await mk(gchild.folderId, 'EDIT-TEST-002')   // 대상 폴더에 같은 번호가 이미 있다

  const mvCall = await call('POST','/editor/documents/move',
    {documentIds:[d1,d2], targetFolderId: gchild.folderId})
  if (mvCall.status !== 200) { console.log('    응답:', mvCall.status, JSON.stringify(mvCall.body).slice(0,300)) }
  const mvRes = mvCall.body
  check(mvRes.moved === 1 && mvRes.skipped.length === 1,
        '충돌하는 1건만 건너뛰고 나머지는 옮긴다', `moved=${mvRes.moved} skipped=${mvRes.skipped.length}`)
  check(mvRes.skipped[0].reason.includes('EDIT-TEST-002'), '건너뛴 이유를 돌려준다')

  // ── ④ 삭제 보관함 ───────────────────────────────────────────────
  console.log('\n④ 삭제 보관함 — 폴더째 한 줄, 복구 가능')
  const trashed = (await call('POST','/editor/trash',{folderId: gchild.folderId, reason:'시험'})).body
  check(trashed.batchIds.length === 1, '폴더째 보내면 묶음이 하나다', `${trashed.archived}건`)

  const box = (await call('GET','/editor/trash')).body
  const batch = box.items.find(b => b.id === trashed.batchIds[0])
  check(!!batch && batch.label === 'EDIT-TEST 손자', '묶음 이름이 폴더명이다', batch?.label)
  check(!!batch?.originalPath, '원래 자리를 기록한다', batch?.originalPath)

  const { rows:[hidden] } = await db.query(
    `SELECT count(*)::int n FROM documents WHERE folder_id=$1 AND is_archived`, [gchild.folderId])
  check(hidden.n > 0, '자료가 보관 상태로 감춰진다', `${hidden.n}건`)

  const restored = (await call('POST','/editor/trash/restore',{batchIds: trashed.batchIds})).body
  check(restored.restored > 0 && !restored.blocked.length, '복구된다', `${restored.restored}건`)

  // ── ⑤ 폐기 보관함 ───────────────────────────────────────────────
  console.log('\n⑤ 폐기 보관함 — 자료 1건 = 이력 1건, 완전 삭제 없음')
  const retired = (await call('POST','/editor/retired',{documentIds:[d1,d2], reason:'리비전 후 불필요'})).body
  check(retired.batchIds.length === 2, '자료마다 이력이 따로 남는다 (삭제 보관함과 다름)',
        `${retired.batchIds.length}줄`)

  const rbox = (await call('GET','/editor/retired')).body
  check(rbox.items.every(b => b.itemCount === 1), '폐기 묶음은 전부 1건짜리다')
  check(rbox.items.some(b => b.label.startsWith('EDIT-TEST')), '묶음 이름이 자료명이다',
        rbox.items[0]?.label)

  const { rows:[rstat] } = await db.query('SELECT status FROM documents WHERE id=$1',[d1])
  check(rstat.status === 'RETIRED', '폐기 자료의 상태가 RETIRED 다', rstat.status)

  const badPurge = await call('POST','/editor/trash/purge',{batchIds: retired.batchIds, confirm:true})
  check(badPurge.status === 422 && badPurge.body.code === 'PURGE_NOT_ALLOWED',
        '폐기 보관함은 완전 삭제를 거부한다', badPurge.body.code)

  const rrestore = (await call('POST','/editor/retired/restore',{batchIds:[retired.batchIds[0]]})).body
  const { rows:[back] } = await db.query('SELECT status, is_archived FROM documents WHERE id=$1',[d1])
  check(rrestore.restored === 1 && back.status === 'ACTIVE' && !back.is_archived,
        '복구하면 다시 정상 상태가 된다', `${back.status}`)

  // ── ⑥ 완전 삭제 ─────────────────────────────────────────────────
  console.log('\n⑥ 완전 삭제 — 삭제 보관함만')
  const d3 = await mk(child.folderId, 'EDIT-TEST-PURGE')
  await db.query(`INSERT INTO distributions (document_id, rev_at_distribution, vendor_name, purpose, distributed_by)
                  VALUES ($1,0,'대한엔지니어링','MODIFY',1)`, [d3])
  const t2 = (await call('POST','/editor/trash',{documentIds:[d3], reason:'오류 자료'})).body
  const purgeCall = await call('POST','/editor/trash/purge',{batchIds: t2.batchIds, confirm:true})
  if (purgeCall.status !== 200) console.log('    응답:', purgeCall.status, JSON.stringify(purgeCall.body).slice(0,200))
  const purged = purgeCall.body
  check(purged.purged === 1, '완전 삭제되면 자료 행이 사라진다', `${purged.purged}건`)

  const { rows:[gone] } = await db.query('SELECT count(*)::int n FROM documents WHERE id=$1',[d3])
  check(gone.n === 0, '자료를 다시 찾을 수 없다')
  // 자료는 사라져도 반출 기록은 남는다 — document_id 는 끊기고 자료명 스냅샷이 남는다
  const { rows:[dist] } = await db.query(
    `SELECT count(*)::int n, max(document_label) AS label
       FROM distributions WHERE document_label = 'EDIT-TEST-PURGE'`)
  check(dist.n === 1, '반출 기록은 남는다 — 누가 받아 갔는지는 알아야 한다', `${dist.n}건`)
  check(dist.label === 'EDIT-TEST-PURGE', '자료명 스냅샷으로 무엇이었는지 알 수 있다', dist.label)
  const { rows:[orphan] } = await db.query(
    `SELECT document_id FROM distributions WHERE document_label = 'EDIT-TEST-PURGE'`)
  check(orphan.document_id === null, '사라진 자료를 가리키던 연결은 끊긴다')

  await cleanup(); await db.end()
  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail ? 1 : 0)
}
main().catch(async e => { console.error('오류:', e.message); await db.end().catch(()=>{}); process.exit(1) })
