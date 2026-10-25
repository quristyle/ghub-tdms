#!/usr/bin/env node
/**
 * 개발서버 제어판 — 브라우저 UI.
 *
 * 의존성 없이 node:http 만 쓴다. 판정 로직은 여기에 복사하지 않고
 * `dev.sh` 를 불러 그 결과를 전달한다 — 터미널과 브라우저가 같은 것을 본다.
 *
 * 안전
 *   · 127.0.0.1 에만 묶는다 (바깥에서 닿지 않는다)
 *   · Host 머리글을 확인한다 (DNS 재바인딩 차단)
 *   · 바꾸는 요청은 X-Devctl 머리글을 요구한다 (다른 페이지의 폼 전송 차단)
 *   · 실행할 수 있는 명령은 아래 허용 목록뿐이다 — 임의 문자열을 받지 않는다
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const PUBLIC = join(HERE, 'public')
const DEV_SH = join(ROOT, 'dev.sh')

const PORT = Number(process.env.DEVCTL_PORT || 7070)
const HOST = '127.0.0.1'

/** 색 코드 지우개 — 브라우저에서는 쓸모없다 */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '').replace(/\r/g, '')

/** 실행할 수 있는 명령. 여기 없는 것은 거부한다. */
const COMMANDS = {
  start: { args: (s) => ['start', ...(s ? [s] : [])], label: '시작' },
  stop: { args: (s) => ['stop', ...(s ? [s] : [])], label: '중지' },
  restart: { args: (s) => ['restart', ...(s ? [s] : [])], label: '다시 시작' },
  doctor: { args: () => ['doctor'], label: '환경 점검' },
  verify: { args: () => ['verify'], label: '검증' },
  migrate: { args: () => ['migrate'], label: '마이그레이션 적용' },
  db: { args: () => ['db'], label: '마이그레이션 상태' },
  seed: { args: () => ['seed'], label: '시험 자료 넣기' },
  build: { args: () => ['build'], label: '빌드' },
  'setup-worker': { args: () => ['setup-worker'], label: '워커 환경 준비' },
}
const SERVICES = new Set(['api', 'web', 'worker'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

// ── 실행 중인 작업 ──────────────────────────────────────────────────────
let nextRunId = 1
/** id → { label, lines[], done, code, listeners:Set<res> } */
const runs = new Map()

function emit(run, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of run.listeners) res.write(data)
}

function startRun(cmd, service) {
  const spec = COMMANDS[cmd]
  const id = String(nextRunId++)
  const run = {
    id,
    label: spec.label + (service ? ` (${service})` : ''),
    lines: [],
    done: false,
    code: null,
    listeners: new Set(),
    startedAt: Date.now(),
  }
  runs.set(id, run)

  const child = spawn('bash', [DEV_SH, ...spec.args(service)], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  })

  const push = (chunk) => {
    for (const raw of strip(chunk).split('\n')) {
      if (raw === '' && run.lines.at(-1) === '') continue
      run.lines.push(raw)
      emit(run, { type: 'line', line: raw })
    }
    if (run.lines.length > 2000) run.lines.splice(0, run.lines.length - 2000)
  }

  child.stdout.on('data', push)
  child.stderr.on('data', push)
  child.on('close', (code) => {
    run.done = true
    run.code = code
    emit(run, { type: 'done', code })
    for (const res of run.listeners) res.end()
    run.listeners.clear()
    setTimeout(() => runs.delete(id), 10 * 60_000) // 오래된 기록은 치운다
  })

  return run
}

// ── dev.sh status --json ────────────────────────────────────────────────
function devStatus() {
  return new Promise((resolve) => {
    const child = spawn('bash', [DEV_SH, 'status', '--json'], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve({ error: '상태를 읽지 못했습니다', raw: out.slice(0, 500) })
      }
    })
  })
}

// ── 로그 따라가기 ───────────────────────────────────────────────────────
function tailLog(svc, res) {
  const file = join(ROOT, 'devctl/logs', `${svc}.log`)
  if (!existsSync(file)) {
    res.write(`data: ${JSON.stringify({ type: 'line', line: '(로그 파일이 아직 없습니다)' })}\n\n`)
    return () => {}
  }
  const child = spawn('tail', ['-n', '200', '-f', file])
  const send = (chunk) => {
    for (const line of strip(chunk).split('\n')) {
      if (line === '') continue
      res.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`)
    }
  }
  child.stdout.on('data', send)
  child.stderr.on('data', send)
  return () => child.kill()
}

// ── 요청 처리 ───────────────────────────────────────────────────────────
function guard(req, res) {
  // 루프백 이름으로 들어온 것만 받는다 (DNS 재바인딩 차단)
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('제어판은 이 컴퓨터에서만 열 수 있습니다.')
    return false
  }
  return true
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (name.includes('..')) return sendJson(res, { error: 'bad path' }, 400)
  const file = join(PUBLIC, name)
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('없음')
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
}

const server = createServer(async (req, res) => {
  if (!guard(req, res)) return

  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = url.pathname

  try {
    if (p === '/api/status') return sendJson(res, await devStatus())

    if (p === '/api/run' && req.method === 'POST') {
      // 다른 페이지가 몰래 보낸 폼 전송을 막는다
      if (req.headers['x-devctl'] !== '1') return sendJson(res, { error: 'forbidden' }, 403)
      let body = ''
      for await (const c of req) body += c
      let cmd, service
      try {
        ({ cmd, service } = JSON.parse(body || '{}'))
      } catch {
        return sendJson(res, { error: '잘못된 요청' }, 400)
      }
      if (!COMMANDS[cmd]) return sendJson(res, { error: `쓸 수 없는 명령입니다: ${cmd}` }, 400)
      if (service && !SERVICES.has(service)) return sendJson(res, { error: '알 수 없는 서비스' }, 400)
      const run = startRun(cmd, service)
      return sendJson(res, { runId: run.id, label: run.label })
    }

    if (p === '/api/stream') {
      const run = runs.get(url.searchParams.get('id'))
      if (!run) return sendJson(res, { error: '작업을 찾을 수 없습니다' }, 404)
      sseHead(res)
      for (const line of run.lines) res.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`)
      if (run.done) {
        res.write(`data: ${JSON.stringify({ type: 'done', code: run.code })}\n\n`)
        return res.end()
      }
      run.listeners.add(res)
      req.on('close', () => run.listeners.delete(res))
      return
    }

    if (p === '/api/logs') {
      const svc = url.searchParams.get('svc')
      if (!SERVICES.has(svc)) return sendJson(res, { error: '알 수 없는 서비스' }, 400)
      sseHead(res)
      const stop = tailLog(svc, res)
      req.on('close', stop)
      return
    }

    return serveStatic(res, p)
  } catch (e) {
    sendJson(res, { error: String(e?.message ?? e) }, 500)
  }
})

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`
  console.log(`\n  개발서버 제어판 — ${url}`)
  console.log('  Ctrl+C 로 제어판을 닫습니다 (서비스는 계속 돕니다)\n')

  if (process.env.DEVCTL_OPEN !== '0') {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  포트 ${PORT} 가 이미 쓰이고 있습니다.`)
    console.error(`  이미 열린 제어판이 있는지 보세요: http://localhost:${PORT}`)
    console.error(`  다른 포트로 열려면: DEVCTL_PORT=7071 ./dev.sh\n`)
    process.exit(1)
  }
  throw e
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  제어판을 닫습니다.')
    server.close(() => process.exit(0))
  })
}
