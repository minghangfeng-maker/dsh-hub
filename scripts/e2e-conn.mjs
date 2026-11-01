#!/usr/bin/env node
/**
 * 连接状态提示 e2e（0.4.1 §1/§2/§3）：**真连不上才显示**。
 *
 * 用户反馈：锁屏解锁回 App，最上方先闪一下「正在连接你的助手…」，很快又消失。验收四件事：
 *
 *   A. 断开后 2 秒内恢复：**全程没有顶部条**（宽限期 4 秒把这一下闪消掉）；
 *   B. 断开超过 4 秒：出现中性提示「正在连接服务器…」（不带「第 N 次」）；
 *   C. 断开超过 15 秒：升级成警示「暂时连不上服务器」+ 重试按钮；点「重试」立刻重连；
 *   D. 未连上时发消息：**消息下方**出现「与服务器连接中…」（顶部条不重复），连上后自动发出。
 *   G. 切后台期间容器被 Hub 休眠（`POST /__test/sleep`）：回前台自动唤醒并重连，不用杀 App。
 *
 * 怎么模拟「一直连不上」：mock hub 的 `POST /__test/hold {ms}` 把 WS 握手挂起
 * （见 apps/mock-hub/server.mjs），客户端就停在 reconnecting；`ms: 0` 释放（掐断挂着的握手，
 * 让客户端按正常退避重连）。
 *
 * 用法（脚本默认自己拉起 mock hub 5253 / vite 5254 / headless Chrome 9287，跑完按 PID 关掉）：
 *
 *   node scripts/e2e-conn.mjs --out /tmp/e2e-conn/shots
 *
 * 已经手工起好服务时：
 *
 *   TICK_MS=12 PORT=5253 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5253 ./node_modules/.bin/vite --port 5254 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9287 \
 *     --user-data-dir=/tmp/e2e-profile-conn about:blank &
 *   node scripts/e2e-conn.mjs --no-spawn --app http://127.0.0.1:5254 --hub http://127.0.0.1:5253 --cdp 9287
 *
 * 截图（412×915 / DPR 2.625 / 亮色）：C-message-connecting、C-neutral、C-warning、
 * C-message-timeout —— 直接写进 `--out` 目录。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SPAWN = args.spawn !== 'false' && !process.argv.includes('--no-spawn')
const HUB_PORT = Number(args['hub-port'] ?? 5253)
const APP_PORT = Number(args['app-port'] ?? 5254)
const CDP_PORT = Number(args.cdp ?? 9287)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-conn-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

/** 这条消息在断开期间发出：它下面应该出现「与服务器连接中…」。 */
const MSG = '断线的时候发的：连上之后应该自己发出去'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
  }
  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的 page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    ws.addEventListener('message', (ev) => cdp.onMessage(JSON.parse(ev.data)))
    return cdp
  }
  onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      return
    }
    const cbs = this.listeners.get(msg.method)
    if (cbs) for (const cb of cbs) cb(msg.params)
  }
  send(method, params = {}) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`eval 失败: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result?.value
  }
  async shot(name) {
    await fs.mkdir(OUT, { recursive: true })
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(OUT, `${name}.png`)
    await fs.writeFile(file, Buffer.from(res.data, 'base64'))
    console.log(`  · 截图 ${file}`)
    return file
  }
}

const checks = []
function expect(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(
    `${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  )
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

async function sleepUntil(at) {
  const left = at - Date.now()
  if (left > 0) await sleep(left)
}

/** 顶部条 + 错误条 + 队列气泡的现场快照（判定全部用这个）。 */
const SNAPSHOT = `(() => {
  const h = window.__dshHub
  const strips = Array.from(document.querySelectorAll('.wake-strip')).map((el) => el.innerText.replace(/\\n/g, ' ').trim())
  const banner = h.chat.connectionBanner
  return {
    at: Date.now(),
    link: h.chat.link,
    statusText: h.chat.statusText,
    statusTone: h.chat.statusTone,
    bannerShow: banner.show,
    bannerText: banner.text,
    bannerAction: banner.action ?? '',
    strips,
    stripAction: document.querySelector('.wake-strip__action')?.innerText.trim() ?? '',
    errorBar: !!document.querySelector('.error-bar'),
    bubbles: Array.from(document.querySelectorAll('.msg-user')).map((el) => el.innerText.replace(/\\n/g, ' ').trim()),
    outbox: h.chat.outbox.map((entry) => entry.text),
    theme: document.documentElement.dataset.theme ?? '',
  }
})()`

const CONN_TEXT = /正在连接|正在唤醒|暂时连不上|不可连接|与服务器连接中/

/** 输入卡里打一行字并点发送（与真机同一条路径）。 */
async function typeAndSend(cdp, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    if (!el) return false
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(120)
  const clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('.send-btn')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) throw new Error('找不到发送按钮（.send-btn）')
  await sleep(200)
}

/** 模拟切后台 / 回前台：改写 document.hidden 并派发 visibilitychange。 */
async function setHidden(cdp, hidden) {
  await cdp.eval(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${hidden ? 'hidden' : 'visible'}' })
    document.dispatchEvent(new Event('visibilitychange'))
    return true
  })()`)
}

async function hold(ms) {
  const res = await fetch(`${HUB_URL}/__test/hold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms }),
  })
  return res.json()
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  await startServers()
  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 亮色（App 默认跟随系统；CDP 把 prefers-color-scheme 固定成 light）
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ---- 0. 干净登录（全新 profile：localStorage / IndexedDB 都清一遍）
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(async () => {
    try { localStorage.clear() } catch {}
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name)
    } catch {}
    return true
  })()`)
  await cdp.send('Page.reload')
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(100)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功', timeout: 30000 })
  await waitFor(cdp, `window.__dshHub?.chat?.link === 'connected'`, { label: '通道连上', timeout: 40000 })
  await waitFor(cdp, `window.__dshHub.chat.sessions.length >= 1`, { label: '会话列表', timeout: 20000 })
  const ready = await cdp.eval(SNAPSHOT)
  expect('已连上时顶部没有连接条（正常状态安静）', ready.statusText === '' && ready.strips.length === 0, {
    statusText: ready.statusText,
    strips: ready.strips,
  })
  expect('亮色主题（截图基线）', ready.theme === 'light', ready.theme)

  // ---- A. 断开后 2 秒内恢复：全程不出现顶部条
  await fetch(`${HUB_URL}/__test/disconnect`, { method: 'POST' })
  const windowMs = 2600
  const startedAt = Date.now()
  const samples = []
  let sawDisconnect = false
  while (Date.now() - startedAt < windowMs) {
    const snap = await cdp.eval(SNAPSHOT)
    samples.push(snap)
    if (snap.link !== 'connected') sawDisconnect = true
    await sleep(60)
  }
  const last = samples[samples.length - 1]
  const flashed = samples.filter(
    (snap) => snap.statusText !== '' || snap.bannerShow || snap.strips.some((text) => CONN_TEXT.test(text)),
  )
  expect('A1 确实断开过（link 离开 connected）', sawDisconnect, samples.find((s) => s.link !== 'connected')?.link)
  expect('A2 2 秒内恢复到 connected', last.link === 'connected', last.link)
  expect(
    'A3 断开→恢复全过程顶部一条都没有（没有闪现「正在连接…」）',
    flashed.length === 0,
    flashed.slice(0, 3).map((s) => ({ link: s.link, statusText: s.statusText, strips: s.strips })),
  )
  expect(
    'A4 全过程没有冒出连接相关的红色错误条',
    samples.every((snap) => !snap.errorBar),
    samples.filter((snap) => snap.errorBar).length,
  )

  // ---- B/C. 断开超过 4 秒 → 中性提示；超过 15 秒 → 警示 + 重试
  await hold(40_000) // 握手挂起：接下来一直连不上
  await fetch(`${HUB_URL}/__test/disconnect`, { method: 'POST' })
  const t0 = Date.now()

  // ---- D. 未连上时发一条消息：连接状态只出现在消息下方
  await typeAndSend(cdp, MSG)
  await waitFor(cdp, `window.__dshHub.chat.outbox.length === 1`, { label: '消息进了发送队列', timeout: 8000 })
  const queuedSnap = await cdp.eval(SNAPSHOT)
  expect('D1 未连上发出的消息在队列里（还没发出去）', queuedSnap.outbox.length === 1, queuedSnap.outbox)
  expect(
    'D2 消息下方出现「与服务器连接中…」',
    queuedSnap.bubbles.some((text) => text.includes('与服务器连接中…')),
    queuedSnap.bubbles,
  )
  expect('D3 顶部此时还没有条（不足 4 秒，不在上面重复）', queuedSnap.statusText === '', {
    statusText: queuedSnap.statusText,
    strips: queuedSnap.strips,
  })
  await cdp.shot('C-message-connecting')

  await sleepUntil(t0 + 4_800)
  const neutral = await cdp.eval(SNAPSHOT)
  expect('B1 断开 4 秒后出现中性提示「正在连接服务器…」', neutral.statusText === '正在连接服务器…', {
    statusText: neutral.statusText,
    tone: neutral.statusTone,
  })
  expect('B2 中性提示是 info 语气、没有按钮', neutral.statusTone === 'info' && neutral.stripAction === '', {
    tone: neutral.statusTone,
    action: neutral.stripAction,
  })
  expect('B3 不再显示「第 N 次」重连次数', !/第\s*\d+\s*次|重连/.test(neutral.strips.join(' ')), neutral.strips)
  expect(
    'B4 消息下方仍是「与服务器连接中…」（这条自己才排了几秒）',
    neutral.bubbles.some((text) => text.includes('与服务器连接中…')),
    neutral.bubbles,
  )
  await cdp.shot('C-neutral')

  await sleepUntil(t0 + 16_600)
  const warned = await cdp.eval(SNAPSHOT)
  expect('C1 断开 15 秒后升级成警示「暂时连不上服务器」', warned.statusText === '暂时连不上服务器', {
    statusText: warned.statusText,
    tone: warned.statusTone,
  })
  expect('C2 警示带「重试」按钮（warn 语气）', warned.statusTone === 'warn' && warned.stripAction === '重试', {
    tone: warned.statusTone,
    action: warned.stripAction,
  })
  expect(
    'C3 消息下方同步升级成「暂时连不上服务器，连上后自动发送 · 重试」',
    warned.bubbles.some((text) => text.includes('暂时连不上服务器，连上后自动发送') && text.includes('重试')),
    warned.bubbles,
  )
  await cdp.shot('C-warning')
  await cdp.shot('C-message-timeout')

  // ---- C4. 点「重试」：立刻重新建链（服务端又收到一次被挂起的握手）
  const heldBefore = await hold(40_000)
  const clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('.wake-strip__action')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await sleep(1_400)
  const heldAfter = await hold(40_000)
  expect(
    'C4 点「重试」立刻重连（挂起的握手又多了）',
    clicked === true && heldAfter.held > heldBefore.held,
    { before: heldBefore.held, after: heldAfter.held },
  )

  // ---- E. 释放：连上 → 顶部条消失、消息自动发出
  await hold(0)
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { label: '恢复连接', timeout: 30000 })
  await waitFor(cdp, `window.__dshHub.chat.outbox.length === 0`, { label: '队列清空（消息自动发出）', timeout: 30000 })
  await waitFor(
    cdp,
    `(window.__dshHub.chat.state?.messages ?? []).some((m) => m.role === 'user' && m.text === ${JSON.stringify(MSG)})`,
    { label: '消息落库（canonical）', timeout: 30000 },
  )
  await sleep(400)
  const after = await cdp.eval(SNAPSHOT)
  expect('E1 连上后顶部条立刻消失', after.statusText === '' && after.strips.length === 0, {
    statusText: after.statusText,
    strips: after.strips,
  })
  expect(
    'E2 消息下方不再显示连接状态（已自动发出）',
    !after.bubbles.some((text) => CONN_TEXT.test(text)),
    after.bubbles,
  )
  expect('E3 队列清空（没有重复排队）', after.outbox.length === 0, after.outbox)

  // ---- F. 连上之后再断开又很快恢复：仍然不闪（宽限期每次都在）
  await fetch(`${HUB_URL}/__test/disconnect`, { method: 'POST' })
  const samples2 = []
  const started2 = Date.now()
  while (Date.now() - started2 < 2_400) {
    samples2.push(await cdp.eval(SNAPSHOT))
    await sleep(60)
  }
  expect(
    'F1 再次掉线（2 秒内恢复）仍然全程不显示顶部条',
    samples2.every((snap) => snap.statusText === '' && !snap.bannerShow),
    samples2.filter((snap) => snap.statusText !== '').slice(0, 3).map((snap) => snap.statusText),
  )
  expect('F2 最后还是连着的', samples2[samples2.length - 1].link === 'connected', samples2[samples2.length - 1].link)

  // ---- G. 切后台期间容器被休眠，回前台要自己唤醒并重连（2026-10-29 真机：只能杀 App 重开）
  //      浏览器里用「document.hidden + visibilitychange」模拟前后台（Capacitor App 的网页实现
  //      与 App.vue 的兜底都听这个事件），与真机走同一套回调。
  await setHidden(cdp, true)
  await waitFor(cdp, `window.__dshHub.chat.link !== 'connected'`, { label: '切后台后断开', timeout: 8000 })
  await fetch(`${HUB_URL}/__test/sleep`, { method: 'POST' })
  const slept = await (await fetch(`${HUB_URL}/__test/status`)).json()
  expect('G1 mock hub 实例已休眠（stopped）', slept.instance === 'stopped', slept.instance)
  await sleep(500)
  await setHidden(cdp, false)
  let woke = true
  try {
    await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { label: '回前台后重连', timeout: 20000 })
  } catch {
    woke = false
  }
  const resumed = await cdp.eval(`({
    link: window.__dshHub.chat.link,
    wakeState: window.__dshHub.backend.wakeState,
    instance: window.__dshHub.auth.instance?.status ?? null,
  })`)
  expect('G2 回前台后自动唤醒并重新连上（不用杀 App）', woke && resumed.wakeState === 'ready', resumed)
  expect('G3 实例回到 running', resumed.instance === 'running', resumed.instance)

  expect('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'conn-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'conn-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

// ── 起服务（脚本自己能跑完，不用手工开三个终端）──────────────────────────────

const children = []
let profileDir = null

async function waitHttp(url, { timeout = 40000, label = url } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error(`等待服务超时：${label}`)
}

function pipeStdout(label, child) {
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    if (process.env.E2E_VERBOSE === '1' || /error|Error|ERR/.test(text)) {
      process.stdout.write(`[${label}] ${text}`)
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
}

async function startServers() {
  if (!SPAWN) {
    await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
    await waitHttp(`${APP_URL}/`, { label: 'vite' })
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
    return
  }
  console.log(`[e2e] 起 mock hub :${HUB_PORT}`)
  const hub = spawn(process.execPath, [path.join(ROOT, 'apps/mock-hub/server.mjs')], {
    env: { ...process.env, PORT: String(HUB_PORT), TICK_MS: '12', WAKE_MS: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(hub)
  pipeStdout('hub', hub)
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })

  console.log(`[e2e] 起 vite :${APP_PORT}（VITE_HUB_ORIGIN=${HUB_URL}）`)
  const vite = spawn(
    path.join(ROOT, 'packages/mobile-ui/node_modules/.bin/vite'),
    ['--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'packages/mobile-ui'),
      env: { ...process.env, VITE_HUB_ORIGIN: HUB_URL, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })

  profileDir = `/tmp/e2e-profile-conn-${Date.now()}`
  console.log(`[e2e] 起 headless Chrome :${CDP_PORT}（profile ${profileDir}）`)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  children.push(chrome)
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
}

/** 按 PID 关掉自己起的进程（不用 pkill/pgrep），再清掉临时 profile。 */
async function stopServers() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  await sleep(300)
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  if (profileDir) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

main()
  .catch((error) => {
    console.error('e2e 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServers()
  })
