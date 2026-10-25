#!/usr/bin/env node
/**
 * 운영 화면 흐름 검증 (실제 API 호출).
 *
 *   ① 시스템 로그 — 검색, 사용자 조회 권한(남의 id 차단)
 *   ② 사용자 관리 — 추가(초기 비밀번호 규칙), 수정, 마지막 관리자 보호, 비밀번호 초기화
 *   ③ 권한 관리 — 트리 36리프, 통째 교체, 트리에 없는 키 거부, 즉시 반영
 *   ④ 백업 관리 — 상태, 만들기(워커), 파일 삭제해도 이력은 남는가
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT,'.env'))) for (const l of readFileSync(join(ROOT,'.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }

const BASE='http://127.0.0.1:8080'; let pass=0, fail=0
const check=(ok,label,extra='')=>{console.log(`  ${ok?'✓':'✗'} ${label}${extra?` — ${extra}`:''}`);ok?pass++:fail++}
function session(){let c=''
  return async(m,p,b)=>{const h={Cookie:c,Origin:BASE};if(b)h['Content-Type']='application/json'
    const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined})
    const sc=r.headers.get('set-cookie');if(sc)c=sc.split(';')[0]
    const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t}
    return {status:r.status, body:j}}}

const db=new pg.Client({host:process.env.PGHOST,port:+process.env.PGPORT,database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD})

async function cleanup(){
  await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'admtest%')`)
  await db.query(`DELETE FROM users WHERE login_id LIKE 'admtest%'`)
  await db.query(`DELETE FROM group_permissions WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'ADMTEST%')`)
  await db.query(`UPDATE users SET group_id=NULL WHERE group_id IN (SELECT id FROM groups WHERE name LIKE 'ADMTEST%')`)
  await db.query(`DELETE FROM groups WHERE name LIKE 'ADMTEST%'`)
  // backup_runs.job_id 가 jobs 를 참조한다 — 이력을 먼저 지운다
  await db.query(`DELETE FROM backup_runs`)
  await db.query(`DELETE FROM jobs WHERE kind='backup'`)
}

const main=async()=>{
  await db.connect(); await db.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)
  const admin=session()
  await admin('POST','/auth/login',{loginId:'admin',password:'ghubadmin'})
  await admin('POST','/auth/password/defer')
  await cleanup()

  // ── ① 시스템 로그 ───────────────────────────────────────────────
  console.log('\n① 시스템 로그')
  const log = await admin('GET','/audit-log?limit=5')
  check(log.status===200 && log.body.total > 0, '기록이 보인다', `${log.body.total}건`)
  check(log.body.items[0].occurredAt && log.body.items[0].action, '시각·동작이 담긴다',
        log.body.items[0].action)

  const lmeta = (await admin('GET','/audit-log/meta')).body
  check(lmeta.screens.length > 0 && lmeta.actions.length > 0, '검색 선택지를 실제 기록에서 뽑는다',
        `화면 ${lmeta.screens.length} 동작 ${lmeta.actions.length}`)

  const byAction = await admin('GET','/audit-log?limit=50&action=' + encodeURIComponent('로그인'))
  check(byAction.body.items.every(a=>a.action==='로그인'), '동작으로 거른다', `${byAction.body.total}건`)

  // 권한 없는 사용자는 자기 것만
  await db.query(`DELETE FROM group_permissions
                   WHERE group_id=(SELECT id FROM groups WHERE name='설비기술팀')
                     AND permission_key='screen.audit.viewer.other_user'`)
  await db.query(`SELECT pg_notify('cache_perm','')`)
  await new Promise(r=>setTimeout(r,400))
  const cm=session()
  await cm('POST','/auth/login',{loginId:'cm',password:'ghubcm'}); await cm('POST','/auth/password/defer')
  const peek = await cm('GET','/audit-log?limit=5&userId=1')
  check(peek.status===403, '주소로 남의 id 를 넣으면 막는다', peek.body.code)
  const mine = await cm('GET','/audit-log?limit=50')
  check(mine.body.items.every(a=>a.userName==='설비기술팀 CM' || a.userName===null),
        '권한이 없으면 자기 기록만 보인다', `${mine.body.total}건`)
  await db.query(`INSERT INTO group_permissions VALUES
    ((SELECT id FROM groups WHERE name='설비기술팀'),'screen.audit.viewer.other_user')
    ON CONFLICT DO NOTHING`)
  await db.query(`SELECT pg_notify('cache_perm','')`)

  // ── ② 사용자 관리 ───────────────────────────────────────────────
  console.log('\n② 사용자 관리')
  const made = await admin('POST','/users',{loginId:'admtest1', name:'시험 계정', role:'VIEWER'})
  check(made.status===200 && made.body.id>0, '계정을 만든다', `id=${made.body.id}`)

  // 초기 비밀번호 규칙이 실제로 통하는가
  const probe=session()
  const login = await probe('POST','/auth/login',{loginId:'admtest1', password:'ghubadmtest1'})
  check(login.status===200 && login.body.mustChangePassword,
        '초기 비밀번호 ghub+아이디 로 로그인되고 변경을 요구한다')

  const dup = await admin('POST','/users',{loginId:'admtest1', name:'중복', role:'VIEWER'})
  check(dup.status===409, '같은 아이디는 거부한다', dup.body.code)

  await admin('PATCH',`/users/${made.body.id}`,{name:'이름 바뀜', isActive:false})
  const list = (await admin('GET','/users')).body
  const u = list.items.find(x=>x.loginId==='admtest1')
  check(u.name==='이름 바뀜' && !u.isActive, '수정된다', `${u.name} / 사용=${u.isActive}`)

  const { rows:[sess] } = await db.query(
    `SELECT count(*)::int n FROM sessions WHERE user_id=$1`,[made.body.id])
  check(sess.n===0, '사용 중지하면 그 사람의 로그인이 끊긴다')

  // 마지막 관리자 보호
  const { rows:[adminUser] } = await db.query(`SELECT id FROM users WHERE login_id='admin'`)
  const demote = await admin('PATCH',`/users/${adminUser.id}`,{role:'VIEWER'})
  check(demote.status===409 && demote.body.code==='LAST_ADMIN',
        '마지막 관리자는 내릴 수 없다', demote.body.code)

  const reset = await admin('POST',`/users/${made.body.id}/reset-password`)
  check(reset.status===200 && reset.body.rule.includes('ghub'), '비밀번호를 초기화한다')

  // ── ③ 권한 관리 ─────────────────────────────────────────────────
  console.log('\n③ 권한 관리')
  const tree = (await admin('GET','/groups/permission-tree')).body
  const leaves = (function count(ns){return ns.reduce((a,n)=>a+(n.children?.length?count(n.children):1),0)})(tree.tree)
  check(leaves===36, '권한 트리의 리프가 36개다', `${leaves}개`)

  const grp = await admin('POST','/groups',{name:'ADMTEST 그룹', description:'시험'})
  check(grp.body.id>0, '그룹을 만든다')

  const saved = await admin('PUT',`/groups/${grp.body.id}/permissions`,
    {granted:['screen.tdb_list.access','screen.mdb_list.access']})
  check(saved.body.granted.length===2, '권한을 저장한다', `${saved.body.granted.length}개`)

  const replaced = await admin('PUT',`/groups/${grp.body.id}/permissions`,
    {granted:['screen.audit.access']})
  check(replaced.body.granted.length===1 && replaced.body.granted[0]==='screen.audit.access',
        '통째로 갈아 끼운다 (화면이 보낸 것이 전부다)')

  const bad = await admin('PUT',`/groups/${grp.body.id}/permissions`,{granted:['screen.없는기능']})
  check(bad.status===422 && bad.body.code==='UNKNOWN_PERMISSION',
        '트리에 없는 키는 거부한다 — 없는 기능에 권한이 생기지 않는다', bad.body.code)

  // 즉시 반영: 시험 계정을 그 그룹에 넣고 메뉴를 본다
  await db.query(`UPDATE users SET is_active=true, group_id=$2 WHERE id=$1`,[made.body.id, grp.body.id])
  await db.query(`SELECT pg_notify('cache_perm','')`)
  await new Promise(r=>setTimeout(r,400))
  const t=session()
  await t('POST','/auth/login',{loginId:'admtest1', password:'ghubadmtest1'})
  await t('POST','/auth/password/defer')
  const me1 = (await t('GET','/auth/me')).body
  check(me1.menu.length===1 && me1.menu[0].label==='시스템 로그',
        '권한대로 메뉴가 내려온다', me1.menu.map(m=>m.label).join(','))

  await admin('PUT',`/groups/${grp.body.id}/permissions`,
    {granted:['screen.audit.access','screen.backup.access']})
  await new Promise(r=>setTimeout(r,300))
  const me2 = (await t('GET','/auth/me')).body
  check(me2.menu.length===2, '권한을 바꾸면 다시 로그인하지 않아도 바로 반영된다',
        me2.menu.map(m=>m.label).join(','))

  const members = (await admin('GET',`/groups/${grp.body.id}/members`)).body
  check(members.items.length===1, '구성원을 보여준다', members.items[0]?.name)

  // ── ④ 백업 관리 ─────────────────────────────────────────────────
  console.log('\n④ 백업 관리')
  const st = (await admin('GET','/backup/status')).body
  check(st.dbTables > 20 && st.fileCount > 0, '지금 상태를 센다',
        `표 ${st.dbTables} 파일 ${st.fileCount}`)

  const run = await admin('POST','/backup/run',{kind:'FULL', scope:['DB','FILES'], compressed:true})
  check(run.status===200 && run.body.runId>0 && run.body.jobId>0,
        '백업을 만들고 워커 작업으로 넘긴다', `run=${run.body.runId} job=${run.body.jobId}`)

  const runs = (await admin('GET','/backup/runs')).body
  const r1 = runs.items.find(x=>x.id===run.body.runId)
  check(r1?.seq===1 && r1.state==='PREPARING', '회차가 매겨지고 준비 중으로 뜬다', `${r1?.seq}회차`)
  check(r1?.scope.join(',')==='DB,FILES', '담을 항목이 기록된다', r1?.scope.join(','))

  await admin('POST',`/backup/runs/${run.body.runId}/note`,{note:'월간 백업'})
  await admin('POST',`/backup/runs/${run.body.runId}/delete-file`)
  const after = (await admin('GET','/backup/runs')).body.items.find(x=>x.id===run.body.runId)
  check(after?.state==='FILE_DELETED', '파일을 삭제 표시한다', after?.state)
  check(after?.note==='월간 백업', '이력 줄과 비고는 남는다 — 어떤 경우에도 안 지워진다')

  await cleanup(); await db.end()
  console.log(`\n${pass} 통과 / ${fail} 실패`)
  process.exit(fail?1:0)
}
main().catch(async e=>{console.error('오류:',e.message);await db.end().catch(()=>{});process.exit(1)})
