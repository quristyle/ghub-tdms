// 개발서버 제어판 — 브라우저 쪽.
// 서버(panel.mjs)가 dev.sh 를 불러 주고, 여기서는 상태를 그리고 출력을 흘린다.

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const consoleEl = $('#console')
const runLabel = $('#run-label')

let currentStream = null   // 실행 결과 SSE
let logStream = null       // 로그 따라가기 SSE
let busy = false

// ── 콘솔 ────────────────────────────────────────────────────────────────
function clearConsole(placeholder) {
  consoleEl.textContent = ''
  if (placeholder) consoleEl.append(el('span', 'muted', placeholder))
}

/** 줄 앞머리를 보고 색을 고른다 — dev.sh 가 ✓ ✗ ! · 로 표시한다 */
function lineClass(line) {
  const t = line.trim()
  if (t.startsWith('✓')) return 'ok'
  if (t.startsWith('✗')) return 'bad'
  if (t.startsWith('!')) return 'warn'
  if (/^[가-힣A-Za-z].*$/.test(t) && !t.startsWith('·') && line === line.trimStart()) return 'head'
  return ''
}

function appendLine(line) {
  const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 30
  if (consoleEl.firstChild?.classList?.contains('muted')) consoleEl.textContent = ''
  consoleEl.append(el('div', lineClass(line), line || ' '))
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight
}

function appendDone(code) {
  const okRun = code === 0
  consoleEl.append(
    el('div', okRun ? 'done-ok' : 'done-bad',
       okRun ? '— 끝났습니다 —' : `— 실패했습니다 (종료 코드 ${code}) —`),
  )
  consoleEl.scrollTop = consoleEl.scrollHeight
}

// ── 버튼 잠금 ───────────────────────────────────────────────────────────
function setBusy(on, label) {
  busy = on
  for (const b of document.querySelectorAll('button[data-cmd], button[data-svc]')) b.disabled = on
  runLabel.textContent = on ? `${label} 실행 중…` : ''
  const card = $('.console-card')
  const existing = card.querySelector('.running-bar')
  if (on && !existing) card.insertBefore(el('div', 'running-bar'), card.querySelector('.console'))
  if (!on && existing) existing.remove()
}

// ── 명령 실행 ───────────────────────────────────────────────────────────
async function run(cmd, service) {
  if (busy) return
  selectTab('')
  clearConsole()

  let res
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Devctl': '1' },
      body: JSON.stringify({ cmd, service }),
    }).then((r) => r.json())
  } catch {
    appendLine('✗ 제어판 서버에 닿지 못했습니다')
    return
  }
  if (res.error) { appendLine(`✗ ${res.error}`); return }

  setBusy(true, res.label)
  currentStream?.close()
  currentStream = new EventSource(`/api/stream?id=${res.runId}`)
  currentStream.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.type === 'line') appendLine(m.line)
    else if (m.type === 'done') {
      appendDone(m.code)
      currentStream.close()
      currentStream = null
      setBusy(false)
      refresh()
    }
  }
  currentStream.onerror = () => {
    currentStream?.close()
    currentStream = null
    setBusy(false)
    refresh()
  }
}

// ── 로그 따라가기 ───────────────────────────────────────────────────────
function selectTab(svc) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.log === svc)
  logStream?.close()
  logStream = null
  if (!svc) return

  clearConsole(`${svc} 로그를 따라갑니다…`)
  logStream = new EventSource(`/api/logs?svc=${svc}`)
  logStream.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.type === 'line') appendLine(m.line)
  }
  logStream.onerror = () => appendLine('✗ 로그 연결이 끊겼습니다')
}

// ── 상태 그리기 ─────────────────────────────────────────────────────────
const STATE_LABEL = { running: '동작', stopped: '정지', unavailable: '환경 없음' }

function renderServices(list) {
  const box = $('#services')
  box.textContent = ''

  for (const s of list) {
    const card = el('div', 'svc')

    const top = el('div', 'svc-top')
    top.append(el('span', `dot ${s.state}`))
    top.append(el('span', 'svc-name', s.label))
    top.append(el('span', 'grow'))
    top.append(el('span', `badge ${s.state}`, STATE_LABEL[s.state] ?? s.state))
    card.append(top)

    const meta = el('div', 'svc-meta')
    if (s.port) meta.append(el('span', '', `포트 ${s.port}`))
    if (s.pid) meta.append(el('span', '', `pid ${s.pid}`))
    if (s.uptime) meta.append(el('span', '', `가동 ${s.uptime}`))
    if (s.state === 'running' && !s.owned) meta.append(el('span', '', '제어판 밖에서 시작됨'))
    if (!meta.childElementCount) meta.append(el('span', '', '—'))
    card.append(meta)

    if (s.state === 'unavailable') {
      card.append(el('div', 'svc-hint',
        '파이썬 가상환경이 없습니다. [워커 환경 준비] 를 누르거나 터미널에서 ./dev.sh setup-worker'))
      const act = el('div', 'svc-actions')
      const b = el('button', 'btn btn-sm', '워커 환경 준비')
      b.dataset.cmd = 'setup-worker'
      act.append(b)
      card.append(act)
      box.append(card)
      continue
    }

    const act = el('div', 'svc-actions')
    const mk = (label, cmd, cls) => {
      const b = el('button', `btn btn-sm${cls ? ' ' + cls : ''}`, label)
      b.dataset.svc = s.name
      b.dataset.cmd = cmd
      return b
    }
    if (s.state === 'running') {
      act.append(mk('다시 시작', 'restart'), mk('중지', 'stop', 'danger'))
    } else {
      act.append(mk('시작', 'start', 'primary'))
    }
    const logBtn = el('button', 'btn btn-sm', '로그')
    logBtn.addEventListener('click', () => selectTab(s.name))
    act.append(logBtn)

    if (s.url && s.state === 'running') {
      const a = el('a', 'btn btn-sm', s.name === 'web' ? '화면 열기' : '열기')
      a.href = s.url
      a.target = '_blank'
      a.rel = 'noopener'
      act.append(a)
    }
    card.append(act)
    box.append(card)
  }
}

function renderDb(db) {
  const box = $('#db')
  box.textContent = ''
  box.classList.remove('muted')

  if (!db?.ok) {
    box.append(el('div', 'pill bad', '접속할 수 없습니다'))
    box.append(el('div', 'small muted', `${db?.host ?? ''}/${db?.database ?? ''}`))
    return
  }

  const dl = el('dl', 'kv')
  const add = (k, v, node) => {
    dl.append(el('dt', '', k))
    const dd = el('dd')
    if (node) dd.append(node)
    else dd.textContent = v
    dl.append(dd)
  }

  add('접속', `${db.host}/${db.database} · 스키마 ${db.schema}`)
  add('표', `${db.tables}개`)

  const mig = db.migPending > 0
    ? el('span', 'pill warn', `대기 ${db.migPending}개 (${db.migApplied}/${db.migTotal})`)
    : el('span', 'pill', `최신 (${db.migApplied}/${db.migTotal})`)
  add('마이그레이션', null, mig)

  add('자료', `도면 ${db.documents.toLocaleString()} · MDB ${db.mdbFiles.toLocaleString()} · 계정 ${db.users}`)

  const q = db.queued > 0
    ? el('span', 'pill warn', `${db.queued}건 대기`)
    : el('span', 'pill', '비어 있음')
  add('작업 큐', null, q)

  box.append(dl)

  if (db.queued > 0) {
    box.append(el('div', 'svc-hint',
      '워커가 돌고 있지 않으면 작업이 쌓이기만 합니다. 서비스에서 워커 상태를 확인하세요.'))
  }
}

async function refresh() {
  try {
    const s = await fetch('/api/status', { cache: 'no-store' }).then((r) => r.json())
    if (s.error) { $('#services').textContent = s.error; return }
    renderServices(s.services)
    renderDb(s.db)
    $('#clock').textContent = `갱신 ${s.env.now}`
  } catch {
    $('#clock').textContent = '제어판 서버와 끊김'
  }
}

// ── 붙이기 ──────────────────────────────────────────────────────────────
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-cmd]')
  if (!b) return
  run(b.dataset.cmd, b.dataset.svc)
})

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => selectTab(t.dataset.log))
}

$('#refresh').addEventListener('click', refresh)
$('#clear').addEventListener('click', () => clearConsole('비웠습니다.'))

refresh()
setInterval(() => { if (!busy) refresh() }, 4000)
