#!/usr/bin/env node
/**
 * 多入口自动切换 e2e。
 *
 * 真实现场：主入口被中间层拦截（域名未备案的 HTML 403 / TLS RST），备用入口是同一个 Hub
 * 后端的另一个域名。这个脚本在浏览器里完整走一遍：
 *
 *   A. 主入口处于「拦截页」模式（mock hub 场景：所有 `/api/*` 回 403 HTML，`/api/health` 也不通），
 *      备用入口正常。App 首选主入口 → 登录请求被拦 → 探测备用 `/api/health` → 切过去并重放：
 *      用户看不到「网络连接失败」，登录直接成功。
 *   B. 切换后：当前入口 = 备用、持久化「上次可用入口」、通道 WebSocket 连到备用入口
 *      （并且**没有重新登录**：设备令牌两个入口通用）。
 *   C. 重新打开 App（同一份 localStorage）：直接用上次可用的备用入口，不再撞主入口
 *      （主入口的 `/api` 拦截计数不再增加）。
 *   D. 主入口恢复后回前台（`hubOrigin.ensurePrimary()`，与 App.vue 的 appStateChange 同一个入口）：
 *      自动切回主入口，通道重连过去（备用入口的旧通道断开），持久化也切回。
 *   E. 网络检测页（登录报网络错误后打开）：两个入口各一行、有连通性结果、标出「当前」。
 *
 * 两个入口背后必须是**同一个 hub 进程**（设备令牌通用）。做法：主入口直接连 mock hub
 * （`MOCK_ORIGIN_BLOCKED=1`，拦截页模式）；备用入口是本脚本内一个极简反向代理，转发时带
 * `X-DSH-Mock-Ingress: backup`，mock hub 对它放行（见 apps/mock-hub/server.mjs）。
 *
 * 入口注入：`window.__dshHubOrigins = [主入口, 备用入口]`（`Page.addScriptToEvaluateOnNewDocument`，
 * 与 `__dshNetDiagControlSites` 同一套测试钩子；见 packages/mobile-core/src/config.ts）。
 *
 * 用法（脚本自己拉起 mock hub / 备用代理 / vite / headless Chrome，跑完按 PID 收干净）：
 *
 *   node scripts/e2e-origin.mjs --hub-port 5411 --app-port 5412 --cdp 9411 --out /tmp/e2e-origin
 *
 * 已手工起好服务时（hub 要带 MOCK_ORIGIN_BLOCKED=1）：
 *
 *   MOCK_ORIGIN_BLOCKED=1 PORT=5411 node apps/mock-hub/server.mjs &
 *   (cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5412 ./node_modules/.bin/vite --port 5412) &
 *   node scripts/e2e-origin.mjs --no-spawn --app http://127.0.0.1:5412 \
 *     --hub http://127.0.0.1:5411 --cdp 9411
 */

import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
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
const HUB_PORT = Number(args['hub-port'] ?? 5411)
const APP_PORT = Number(args['app-port'] ?? 5412)
const CDP_PORT = Number(args.cdp ?? 9411)
const OUT = args.out ?? 'e2e-origin-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
/** 备用入口：脚本内的反向代理（同一条网络路径的另一个入口，指向同一个 hub 进程）。 */
let BACKUP_URL = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 极简 CDP（与其它 e2e 脚本一致）──────────────────────────────────────────

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
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `（${detail}）`}`)
}

async function waitUntil(fn, timeout = 8000, interval = 100) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (fn()) return true
    await sleep(interval)
  }
  return false
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr, interval = 100 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(interval)
  }
  throw new Error(`等待超时：${label}`)
}

async function waitHttp(url, { label = url, timeout = 20000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (res.status < 500) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(120)
  }
  throw new Error(`服务没起来：${label}`)
}

// ── 进程 / 服务 ─────────────────────────────────────────────────────────────

const children = []
let profileDir = null
let backupProxy = null

function pipeStdout(label, child) {
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[${label}] ${text}`)
  })
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[${label}!] ${text}`)
  })
}

async function freePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if ([HUB_PORT, APP_PORT, CDP_PORT].includes(port)) continue
    const ok = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error('没有空闲端口')
}

async function startHub() {
  console.log(`[e2e] 起 mock hub :${HUB_PORT}（主入口：拦截页模式）`)
  const hub = spawn(process.execPath, [path.join(ROOT, 'apps/mock-hub/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(HUB_PORT),
      TICK_MS: '12',
      WAKE_MS: '1200',
      MOCK_ORIGIN_BLOCKED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(hub)
  pipeStdout('hub', hub)
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
}

/**
 * 备用入口代理：把请求原样转给 hub，只加一个 `X-DSH-Mock-Ingress: backup` 标记
 * （hub 的「主入口不可达」场景对它放行）。HTTP 与 WebSocket 升级都转发。
 */
async function startBackupProxy() {
  const port = await freePort(HUB_PORT + 2)
  const target = new URL(HUB_URL)
  const targetPort = Number(target.port) || 80
  const state = { http: 0, ws: 0, openWs: 0, upgradeFailed: 0 }

  const server = http.createServer((req, res) => {
    state.http += 1
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${targetPort}`,
          'x-dsh-mock-ingress': 'backup',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    state.ws += 1
    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
        'x-dsh-mock-ingress': 'backup',
      },
      agent: false,
    })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const raw = upRes.rawHeaders
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead && upHead.length > 0) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      // 记录「还开着的」通道：切回主入口后备用入口这边应该归零。
      state.openWs += 1
      let closed = false
      const onClose = () => {
        if (closed) return
        closed = true
        state.openWs -= 1
      }
      upSocket.on('close', onClose)
      socket.on('close', onClose)
    })
    upstream.on('response', () => {
      state.upgradeFailed += 1
      socket.destroy()
    })
    upstream.on('error', () => {
      state.upgradeFailed += 1
      socket.destroy()
    })
    upstream.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  backupProxy = { server, state }
  console.log(`[e2e] 起备用入口代理 :${port} → ${HUB_URL}（ingress=backup）`)
  return `http://127.0.0.1:${port}`
}

async function startVite() {
  console.log(`[e2e] 起 vite :${APP_PORT}（VITE_HUB_ORIGIN=${BACKUP_URL}）`)
  const vite = spawn(
    path.join(ROOT, 'packages/mobile-ui/node_modules/.bin/vite'),
    ['--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'packages/mobile-ui'),
      env: { ...process.env, VITE_HUB_ORIGIN: BACKUP_URL, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })
}

async function startChrome() {
  profileDir = `/tmp/e2e-profile-origin-${Date.now()}`
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
  if (backupProxy) {
    await new Promise((resolve) => backupProxy.server.close(() => resolve()))
    backupProxy = null
  }
  if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

// ── Hub 控制面 ──────────────────────────────────────────────────────────────

async function hubStatus(user = 'demo') {
  const res = await fetch(`${HUB_URL}/__test/status?user=${user}`)
  return res.json()
}

async function setOriginMode(blocked) {
  const res = await fetch(`${HUB_URL}/__test/origin-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked }),
  })
  return res.json()
}

async function originMode() {
  return (await fetch(`${HUB_URL}/__test/origin-mode`)).json()
}

// ── 页面操作 ────────────────────────────────────────────────────────────────

async function fillLogin(cdp) {
  await cdp.eval(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel)
      if (!el) return
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(160)
}

const ORIGIN_STATE = `(() => {
  const store = window.__dshHub?.hubOrigin
  return store ? { current: store.current, origins: [...store.origins] } : null
})()`

const SAVED_ORIGIN = `(() => {
  try { return localStorage.getItem('dsh-hub:origin:v1') } catch { return null }
})()`

async function openApp(cdp) {
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(250)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await waitFor(cdp, `window.__dshHub?.hubOrigin`, { label: 'App 启动' })
  await sleep(400)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/** 失败诊断用：当前页面连接（main 里赋值）。 */
let activeCdp = null

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  if (SPAWN) {
    await startHub()
    BACKUP_URL = await startBackupProxy()
    await startVite()
    await startChrome()
  } else {
    console.log('[e2e] --no-spawn：使用外部 mock hub / vite / Chrome')
    await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
    await waitHttp(`${APP_URL}/`, { label: 'vite' })
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
    BACKUP_URL = await startBackupProxy()
  }

  const primary = HUB_URL
  const backup = BACKUP_URL

  // 场景成立：主入口是拦截页模式
  const mode = await originMode()
  expect('主入口处于「拦截页」模式', mode.blocked === true, JSON.stringify(mode))

  const cdp = await Cdp.attach(CDP_PORT)
  activeCdp = cdp
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__dshHubOrigins = ${JSON.stringify([primary, backup])}`,
  })

  // ── A. 主入口被拦：登录无感切到备用入口 ────────────────────────────────
  await openApp(cdp)
  const boot = await cdp.eval(ORIGIN_STATE)
  expect('启动时首选主入口', boot?.current === primary, JSON.stringify(boot))
  expect('候选里有两个入口', boot?.origins?.length === 2, JSON.stringify(boot?.origins))
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  await fillLogin(cdp)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    label: '登录成功（无感切换）',
    timeout: 30000,
  })
  const afterLogin = await cdp.eval(ORIGIN_STATE)
  expect('切换到了备用入口', afterLogin?.current === backup, JSON.stringify(afterLogin))
  const blockedAfterLogin = (await originMode()).blockedRequests
  expect('主入口的登录请求确实被拦截过', blockedAfterLogin >= 1, `blockedRequests=${blockedAfterLogin}`)
  expect(
    '没有重新登录（令牌两个入口通用）',
    (await cdp.eval(`window.__dshHub?.auth.phase`)) === 'authenticated',
  )
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道连上备用入口' })
  const statusAfterLogin = await hubStatus()
  expect(
    '通道 WebSocket 连在备用入口',
    backupProxy.state.openWs >= 1,
    `backup openWs=${backupProxy.state.openWs}`,
  )
  expect('Hub 侧有 1 条通道', statusAfterLogin.channels >= 1, `channels=${statusAfterLogin.channels}`)

  const saved = await cdp.eval(SAVED_ORIGIN)
  expect('持久化「上次可用入口」= 备用入口', saved === backup, String(saved))
  await cdp.shot('01-switched-to-secondary')

  // ── B. 重新打开：直接用备用入口，不再撞主入口 ──────────────────────────
  const blockedBeforeReopen = (await originMode()).blockedRequests
  const backupHttpBeforeReopen = backupProxy.state.http
  await openApp(cdp)
  await waitFor(cdp, `window.__dshHub?.hubOrigin.current === ${JSON.stringify(backup)}`, {
    label: '恢复上次可用入口',
  })
  expect('重开时直接用备用入口', true)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页（重开）' })
  await fillLogin(cdp)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    label: '重开后登录成功',
    timeout: 30000,
  })
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '重开后通道连上' })
  const blockedAfterReopen = (await originMode()).blockedRequests
  expect(
    '重开时没有再去撞主入口',
    blockedAfterReopen === blockedBeforeReopen,
    `blockedRequests ${blockedBeforeReopen} → ${blockedAfterReopen}`,
  )
  expect(
    '重开的请求都走了备用入口',
    backupProxy.state.http > backupHttpBeforeReopen,
    `backup http ${backupHttpBeforeReopen} → ${backupProxy.state.http}`,
  )

  // ── C. 主入口恢复 → 回前台切回首选 ────────────────────────────────────
  await setOriginMode(false)
  expect('主入口恢复为正常', true)
  const switchedBack = await cdp.eval(`window.__dshHub.hubOrigin.ensurePrimary()`)
  expect('回前台后切回首选入口', switchedBack === true, String(switchedBack))
  await waitFor(cdp, `window.__dshHub?.hubOrigin.current === ${JSON.stringify(primary)}`, {
    label: '当前入口回到首选',
  })
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道连回主入口' })
  const backupClosed = await waitUntil(() => backupProxy.state.openWs === 0, 8000)
  expect('备用入口上的旧通道已断开', backupClosed, `backup openWs=${backupProxy.state.openWs}`)
  const statusBack = await hubStatus()
  expect('Hub 侧仍有通道（已连回主入口）', statusBack.channels >= 1, `channels=${statusBack.channels}`)
  const savedAfterBack = await cdp.eval(SAVED_ORIGIN)
  expect('持久化也切回首选入口', savedAfterBack === primary, String(savedAfterBack))
  await cdp.shot('02-back-to-primary')

  // ── D. 网络检测页：两个入口各自一行 + 标出当前 ──────────────────────────
  // 让两个入口都不通（登录报网络错误才会出现「网络检测」按钮）。WebView/浏览器回退探测
  // 只能区分「到达/没到达」，所以这里只断言「两行 + 当前标记」这类结构性事实。
  await setOriginMode(true)
  await new Promise((resolve) => {
    backupProxy.server.closeAllConnections?.()
    backupProxy.server.close(() => resolve())
  })
  await cdp.eval(`window.__dshHub.auth.forceLogout('e2e-origin')`)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '退出回登录页', timeout: 15000 })
  await fillLogin(cdp)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `document.querySelector('.login__diag')`, { label: '登录报错后的网络检测入口' })
  await cdp.eval(`document.querySelector('.login__diag').click()`)
  await waitFor(cdp, `document.querySelectorAll('.diag__entry').length === 2`, {
    label: '网络检测页的两个入口',
  })
  const rows = await cdp.eval(`[...document.querySelectorAll('.diag__entry')].map((el) => ({
    origin: el.getAttribute('data-origin'),
    current: el.getAttribute('data-current'),
    state: el.getAttribute('data-state'),
    text: el.innerText.trim(),
  }))`)
  expect('网络检测页显示两个入口', rows.length === 2, JSON.stringify(rows.map((row) => row.origin)))
  expect(
    '标出当前在用的入口',
    rows.filter((row) => row.current === '1').length === 1 &&
      rows.find((row) => row.current === '1')?.origin === primary,
    JSON.stringify(rows.map((row) => [row.origin, row.current])),
  )
  expect(
    '两个入口都有连通性结果',
    rows.every((row) => row.state === 'ok' || row.state === 'fail') &&
      rows.every((row) => row.text.length > 0),
    JSON.stringify(rows.map((row) => row.text)),
  )
  await cdp.shot('03-net-diag-entries')

  const passed = checks.filter((check) => check.ok).length
  console.log(`\n结果：${passed}/${checks.length} 通过`)
  return passed === checks.length
}

let ok = false
try {
  ok = await main()
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  try {
    const cdp = activeCdp ?? (await Cdp.attach(CDP_PORT))
    const state = await cdp.eval(`(() => {
      const app = window.__dshHub
      if (!app) return null
      return {
        origin: app.hubOrigin?.current ?? null,
        link: app.chat?.state?.link ?? null,
        error: app.chat?.state?.error ?? null,
        phase: app.auth?.phase ?? null,
      }
    })()`)
    console.error(`App 状态：${JSON.stringify(state)}`)
  } catch {
    /* 页面都没起来就没什么可打的 */
  }
  try {
    console.error(`Hub 状态：${JSON.stringify(await originMode())}`)
    if (backupProxy) console.error(`备用代理：${JSON.stringify(backupProxy.state)}`)
  } catch {
    /* ignore */
  }
  ok = false
} finally {
  await stopServers()
}
process.exit(ok ? 0 : 1)
