#!/usr/bin/env node
/**
 * MDB 흐름 검증 (실제 API 호출).
 *
 *   ① 조회 — 트리 범위, 검색 3종(자료명·폴더명·Tag), 필터 5종
 *   ② 상세 — Tag 목록, 경로
 *   ③ 자료 편집 — 수정, Tag 교체, 이동(충돌 건너뛰기), 설비유형 일괄변경
 *   ④ 보관함 2종 — TDB 와 같은 기구, 서로 섞이지 않는가
 *   ⑤ Tag 이력 — 등록 → 대상 미리보기 → 적용 → 되돌리기
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT,'.env'))) for (const l of readFileSync(join(ROOT,'.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }

const BASE='http://127.0.0.1:8080'; let cookie='', pass=0, fail=0
const check=(ok,label,extra='')=>{console.log(`  ${ok?'✓':'✗'} ${label}${extra?` — ${extra}`:''}`);ok?pass++:fail++}
const call=async(m,p,b)=>{const h={Cookie:cookie,Origin:BASE};if(b)h['Content-Type']='application/json'
  const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined})
  const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0]
  const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}
  return {status:r.status, body:j}}

const db=new pg.Client({host:process.env.PGHOST,port:+process.env.PGPORT,database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD})

/**
 * 시험 흔적을 지운다.
 *
 * 삭제 순서가 중요하다 — folders 를 가리키는 참조(mdb_files.folder_id,
 * archive_batches.folder_id)를 전부 끊은 뒤에야 폴더를 지울 수 있다.
 * (운영 코드에는 폴더 삭제가 없다. 보관함으로 옮길 뿐이다.)
 */
async function cleanup(){
  const testFolders = `SELECT id FROM folders WHERE name LIKE 'MDBTEST%'`

  await db.query(`DELETE FROM mdb_tag_history_items WHERE history_id IN
                   (SELECT id FROM mdb_tag_histories WHERE base_tag LIKE 'MDBTEST%')`)
  await db.query(`DELETE FROM mdb_tag_histories WHERE base_tag LIKE 'MDBTEST%'`)
  await db.query(`DELETE FROM mdb_file_tags WHERE tag_no LIKE 'MDBTEST%'`)

  // 보관 상태를 풀고 자료를 원래 자리로 돌려놓는다
  await db.query(`UPDATE mdb_files SET archive_batch_id=NULL, is_archived=false
                   WHERE archive_batch_id IN (SELECT id FROM archive_batches WHERE label LIKE 'MDBTEST%')`)
  await db.query(`UPDATE folders SET archive_batch_id=NULL, is_archived=false
                   WHERE archive_batch_id IN (SELECT id FROM archive_batches WHERE label LIKE 'MDBTEST%')`)
  await db.query(`UPDATE mdb_files SET folder_id =
                    (SELECT id FROM folders WHERE doc_class='MDB' AND parent_id IS NOT NULL
                      AND name NOT LIKE 'MDBTEST%' ORDER BY id LIMIT 1)
                   WHERE folder_id IN (${testFolders})`)

  // 폴더를 가리키는 참조를 끊고 묶음을 지운다
  await db.query(`UPDATE archive_batches SET folder_id=NULL WHERE folder_id IN (${testFolders})`)
  await db.query(`DELETE FROM archive_batches WHERE label LIKE 'MDBTEST%'`)
  await db.query(`DELETE FROM folders WHERE name LIKE 'MDBTEST%'`)
}

const main=async()=>{
  await db.connect(); await db.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)
  await call('POST','/auth/login',{loginId:'admin',password:'ghubadmin'}); await call('POST','/auth/password/defer')
  await cleanup()

  // ── ① 조회 ──────────────────────────────────────────────────────
  console.log('\n① 조회 — 검색·필터')
  const all = await call('GET','/mdb?limit=5')
  check(all.status===200 && all.body.total >= 240, '전체 목록이 보인다', `${all.body.total}건`)

  const meta = (await call('GET','/mdb/meta')).body
  check(meta.equipmentTypes.length >= 5 && meta.docTypes.length >= 4,
        '검색 선택지를 실제 값에서 뽑는다', `설비 ${meta.equipmentTypes.length} 자료 ${meta.docTypes.length}`)
  check(meta.years.length >= 6 && meta.years[0] > meta.years.at(-1), '연도는 최신순이다', meta.years.slice(0,3).join(','))

  const byEquip = await call('GET','/mdb?limit=3&equipmentType=' + encodeURIComponent('Pump'))
  check(byEquip.body.items.every(i=>i.equipmentType==='Pump'), '설비유형으로 거른다', `${byEquip.body.total}건`)

  const byShared = await call('GET','/mdb?limit=3&shared=true')
  check(byShared.body.items.every(i=>i.isShared), '공용/전용으로 거른다', `공용 ${byShared.body.total}건`)
  const byPrivate = await call('GET','/mdb?limit=3&shared=false')
  check(byPrivate.body.items.every(i=>!i.isShared) && byPrivate.body.total !== byShared.body.total,
        'shared=false 가 제대로 false 로 읽힌다 (BoolParam)', `전용 ${byPrivate.body.total}건`)

  const byYear = await call('GET','/mdb?limit=3&year=2023')
  check(byYear.body.items.every(i=>i.year===2023), '연도로 거른다', `${byYear.body.total}건`)

  const byTitle = await call('GET','/mdb?limit=3&q=' + encodeURIComponent('Compressor'))
  check(byTitle.body.total > 0 && byTitle.body.items[0].title.includes('Compressor'), '자료명으로 찾는다')

  const sampleTag = (await call('GET','/mdb/tags/suggest?q=P-10')).body.items[0]
  const byTag = await call('GET','/mdb?limit=5&searchTarget=tag&q=' + encodeURIComponent(sampleTag))
  check(byTag.body.total > 0, 'Tag No 로 찾는다', `${sampleTag} → ${byTag.body.total}건`)
  check((await call('GET','/mdb/tags/suggest?q=P-')).body.items.length > 1, 'Tag 자동완성이 동작한다')

  // ── ② 상세 ──────────────────────────────────────────────────────
  console.log('\n② 상세')
  // 목록이 알려 준 Tag 개수와 상세의 Tag 개수가 맞는지 본다
  // (특정 자료의 Tag 수를 못박으면 앞선 시험의 잔여 상태에 흔들린다)
  const first = all.body.items.find(i => i.tagCount > 0) ?? all.body.items[0]
  const det = (await call('GET',`/mdb/${first.id}`)).body
  check(det.tags.length === first.tagCount && det.tags.length > 0,
        '목록의 Tag 개수와 상세의 Tag 목록이 일치한다', `${det.tags.length}개: ${det.tags.join(',')}`)
  check(det.folderPath.length >= 2, '폴더 경로를 준다', det.folderPath.map(f=>f.name).join(' › '))

  // ── ③ 자료 편집 ─────────────────────────────────────────────────
  console.log('\n③ 자료 편집')
  await call('PATCH',`/mdb-editor/files/${first.id}`,
    { title:'MDBTEST 바뀐제목', needsCheck:true, tags:['MDBTEST-1','MDBTEST-2','MDBTEST-2',' '] })
  const after = (await call('GET',`/mdb/${first.id}`)).body
  check(after.title==='MDBTEST 바뀐제목' && after.needsCheck, '자료를 수정한다')
  check(after.tags.length===2 && after.tags.includes('MDBTEST-1'),
        'Tag 를 교체하고 중복·빈값을 걸러낸다', after.tags.join(','))

  const folder = (await call('POST','/mdb-editor/folders',
    {docClass:'MDB', parentId:null, name:'MDBTEST 폴더'})).body
  check(folder.folderId > 0, 'MDB 폴더를 만든다 (TDB 와 같은 기구)')

  const ids = all.body.items.slice(0,3).map(i=>i.id)
  const moved = (await call('POST','/mdb-editor/files/move',
    {fileIds: ids, targetFolderId: folder.folderId})).body
  check(moved.updated === 3, '자료를 옮긴다', `${moved.updated}건`)

  const bulk = (await call('POST','/mdb-editor/files/equipment-type',
    {fileIds: ids, equipmentType:'Tank'})).body
  check(bulk.updated === 3, '설비유형을 일괄 변경한다', `${bulk.updated}건`)
  const { rows:[eq] } = await db.query(
    `SELECT count(*)::int n FROM mdb_files WHERE id = ANY($1) AND equipment_type='Tank'`,[ids])
  check(eq.n === 3, '실제로 바뀌었다')

  // ── ④ 보관함 ────────────────────────────────────────────────────
  console.log('\n④ 보관함 2종 — TDB 와 섞이지 않는가')
  const tdbBefore = (await call('GET','/editor/retired')).body.count
  const ret = (await call('POST','/mdb-editor/retired',{documentIds: ids, reason:'시험'})).body
  check(ret.batchIds.length === 3, 'MDB 폐기도 자료 1건 = 이력 1건', `${ret.batchIds.length}줄`)

  const mdbBox = (await call('GET','/mdb-editor/retired')).body
  check(mdbBox.count >= 3, 'MDB 폐기 보관함에 담긴다', `${mdbBox.count}건`)
  const tdbAfter = (await call('GET','/editor/retired')).body.count
  check(tdbAfter === tdbBefore, 'TDB 보관함에는 섞이지 않는다', `TDB ${tdbBefore}→${tdbAfter}`)

  const hidden = await call('GET','/mdb?limit=3&folderId=' + folder.folderId)
  check(hidden.body.total === 0, '폐기한 자료는 목록에서 사라진다')

  const badPurge = await call('POST','/mdb-editor/trash/purge',{batchIds: ret.batchIds, confirm:true})
  check(badPurge.status === 422 && badPurge.body.code === 'PURGE_NOT_ALLOWED',
        'MDB 폐기 보관함도 완전 삭제를 거부한다', badPurge.body.code)

  const back = (await call('POST','/mdb-editor/retired/restore',{batchIds: ret.batchIds})).body
  check(back.restored === 3, '복구된다', `${back.restored}건`)

  // ── ⑤ Tag 이력 ──────────────────────────────────────────────────
  console.log('\n⑤ Tag 이력 — 등록 → 미리보기 → 적용 → 되돌리기')
  const hist = (await call('POST','/mdb-tag-history',
    {baseTag:'MDBTEST-1', newTag:'MDBTEST-CHANGED', reason:'설비 교체'})).body
  check(hist.id > 0, 'Tag 이력을 등록한다 (DRAFT)')

  const targets = (await call('GET',`/mdb-tag-history/${hist.id}/targets`)).body
  check(targets.items.length === 1, '적용 전에 바뀔 대상을 보여준다', `${targets.items.length}건`)
  check(targets.items[0].currentTag === 'MDBTEST-1', '현재 Tag 를 보여준다')

  const applied = (await call('POST',`/mdb-tag-history/${hist.id}/apply`)).body
  check(applied.applied === 1, '적용하면 Tag 가 바뀐다', `${applied.applied}건`)
  const { rows: changed } = await db.query(
    `SELECT tag_no FROM mdb_file_tags WHERE mdb_file_id=$1 ORDER BY tag_no`,[first.id])
  check(changed.some(t=>t.tag_no==='MDBTEST-CHANGED'), '실제로 새 Tag 가 붙었다',
        changed.map(t=>t.tag_no).join(','))

  const { rows:[items] } = await db.query(
    `SELECT count(*)::int n FROM mdb_tag_history_items WHERE history_id=$1`,[hist.id])
  check(items.n === 1, '되돌릴 수 있도록 낱낱이 기록한다 (일괄 UPDATE 만 하면 복구 불가)', `${items.n}건`)

  const twice = await call('POST',`/mdb-tag-history/${hist.id}/apply`)
  check(twice.status === 409, '두 번 적용할 수 없다', twice.body.code)

  const rev = (await call('POST',`/mdb-tag-history/${hist.id}/revert`)).body
  check(rev.reverted === 1, '되돌린다', `${rev.reverted}건`)
  const { rows: restored } = await db.query(
    `SELECT tag_no FROM mdb_file_tags WHERE mdb_file_id=$1 ORDER BY tag_no`,[first.id])
  check(restored.some(t=>t.tag_no==='MDBTEST-1') && !restored.some(t=>t.tag_no==='MDBTEST-CHANGED'),
        '원래 Tag 로 정확히 돌아온다', restored.map(t=>t.tag_no).join(','))

  const revTwice = await call('POST',`/mdb-tag-history/${hist.id}/revert`)
  check(revTwice.status === 409, '두 번 되돌릴 수 없다', revTwice.body.code)

  // 정리 — 제목과 Tag 를 시험 전으로 되돌린다
  await db.query(`UPDATE mdb_files SET title=$2, needs_check=false WHERE id=$1`,[first.id, det.title])
  await db.query(`DELETE FROM mdb_file_tags WHERE mdb_file_id=$1`,[first.id])
  for (const t of det.tags) {
    await db.query(`INSERT INTO mdb_file_tags (mdb_file_id, tag_no) VALUES ($1,$2)
                    ON CONFLICT DO NOTHING`,[first.id, t])
  }
  await cleanup(); await db.end()
  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail?1:0)
}
main().catch(async e=>{console.error('오류:',e.message);await db.end().catch(()=>{});process.exit(1)})
