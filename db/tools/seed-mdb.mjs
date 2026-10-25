#!/usr/bin/env node
/** MDB 샘플 자료 — 화면·검색 확인용 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
if (existsSync(join(ROOT,'.env'))) for (const l of readFileSync(join(ROOT,'.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }
const BLOBS = join(process.env.STORAGE_ROOT, 'blobs')

function pdf(t){const c=`BT /F1 16 Tf 60 740 Td (${t}) Tj ET\n`
 const o=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
 `<< /Length ${c.length} >>\nstream\n${c}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
 let s='%PDF-1.4\n';const f=[];o.forEach((x,i)=>{f.push(s.length);s+=`${i+1} 0 obj\n${x}\nendobj\n`})
 const x=s.length;s+=`xref\n0 ${o.length+1}\n0000000000 65535 f \n`;for(const q of f)s+=`${String(q).padStart(10,'0')} 00000 n \n`
 s+=`trailer\n<< /Size ${o.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
 return Buffer.from(s,'latin1')}

async function store(buf){const hex=createHash('sha256').update(buf).digest('hex')
 const p=join(BLOBS,hex.slice(0,2),hex.slice(2,4),hex)
 await mkdir(dirname(p),{recursive:true}); try{await stat(p)}catch{await writeFile(p,buf)}
 return {hex,size:buf.length}}

const c=new pg.Client({host:process.env.PGHOST,port:+process.env.PGPORT,database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:process.env.PGPASSWORD})
await c.connect(); await c.query(`SET search_path TO ${process.env.PGSCHEMA}, public`)

const { rows:[u] } = await c.query(`SELECT id FROM users WHERE login_id='admin'`)
const { rows: folders } = await c.query(`SELECT id, name FROM folders WHERE doc_class='MDB' AND parent_id IS NOT NULL ORDER BY id`)
const { rows: projects } = await c.query(`SELECT id FROM projects ORDER BY id`)
const { rows:[n] } = await c.query(`SELECT count(*)::int n FROM mdb_files`)
if (n.n > 0) { console.log('MDB 자료가 이미 있습니다 — 건너뜀'); await c.end(); process.exit(0) }

const EQUIP=['Pump','Compressor','Vessel','Heat Exchanger','Tank']
const TYPES=['Mechanical Data Book','Inspection Data Book','안전관련','마감보고서']
let made=0, tagged=0
for (let i=1;i<=240;i++){
  const f=folders[i%folders.length], eq=EQUIP[i%EQUIP.length], dt=TYPES[i%TYPES.length]
  const title=`${eq} ${String(i).padStart(3,'0')} ${dt}`
  const b=await store(pdf(title))
  await c.query(`INSERT INTO blobs (sha256, byte_size) VALUES (decode($1,'hex'),$2) ON CONFLICT DO NOTHING`,[b.hex,b.size])
  const { rows:[m] } = await c.query(
    `INSERT INTO mdb_files (folder_id, blob_sha256, title, display_name, original_filename, file_ext,
                            equipment_type, doc_type, project_id, year, is_shared, needs_check, uploaded_by)
     VALUES ($1,decode($2,'hex'),$3,$4,$5,'pdf',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [f.id,b.hex,title,`${title}.pdf`,`${title}.pdf`,eq,dt,
     projects[i%projects.length].id, 2020+(i%6), i%3===0, i%17===0, u.id])
  await c.query(`UPDATE blobs SET refcount=refcount+1 WHERE sha256=decode($1,'hex')`,[b.hex])
  made++
  // Tag 를 붙인다 (자동완성·Tag 이력 검증용)
  const tags=[`${eq.slice(0,1).toUpperCase()}-${1000+(i%60)}`, `${eq.slice(0,1).toUpperCase()}-${2000+(i%25)}`]
  for (const t of tags) {
    await c.query(`INSERT INTO mdb_file_tags (mdb_file_id, tag_no) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[m.id,t])
    tagged++
  }
}
console.log(`MDB 자료 ${made}건 / Tag ${tagged}개 생성`)
await c.end()
