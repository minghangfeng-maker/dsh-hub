#!/usr/bin/env node
/**
 * 管理座舱「嵌入模式」e2e（WP56d / docs/24 §6）。
 *
 * 为什么用「父页面 + 同源 iframe」跑：真实形态就是 Hub 的 `/admin` 页面把
 * `/m/?embed=cockpit#code=…` 嵌进来，然后两边用 postMessage 说话。所以这里：
 *   1. 跑 `scripts/build-web.sh` 出 `dist-web`（`VITE_TARGET=web`）；
 *   2. 让 mock hub 用 `--web-dist` 在 `/m/` 下托管它，并额外提供 `/__cockpit/parent`
 *      （一个同源的假「/admin 父页面」：换码写进 iframe 的 hash、记录收到的 postMessage）；
 *   3. Chrome 打开父页面，用 CDP + 同源属性访问驱动/断言 iframe 里的 App。
 *
 * 覆盖（docs/24 §1「舰桥布局」+ §6）：
 *   A. 进入：`?embed=cockpit&theme=bridge#code=…` → 换令牌 → 认证成功 → 通道连上 → 会话列表；
 *   B. 码只用一次、且立刻从地址栏抹掉；座舱令牌只进 sessionStorage（cockpit 键），
 *      普通 `/m/` 的 localStorage 登录不受影响；
 *   C. 舰桥主题：`html.cockpit-bridge` + 强制深色 + **背景透明**（不能出现白底）+ 等宽数字；
 *   D. 节点固定 `cloud:ops`，没有节点切换 / 账号设置 / 抽屉 / 安装提示；
 *   E. 会话列表收进顶部「航行日志」（标题 / 发起人 / 更新时间 / + 新会话），不占栏；
 *   F. postMessage 双向：ready / session / turn / focus-canvas / focus-proposal 上行，
 *      prefill / focus-session / handoff 下行（跨源消息被丢弃）；
 *   G. 过程行：一轮里 3 次 canvas_show（左、左、右）+ 1 次 ops_call 出方案 →
 *      「⟶ 已投放左舷/右舷：…」「⟶ 方案 #12 · 待确认（右舷）」，点击各发对应消息；
 *   H. 令牌过期：发 cockpit.auth-expired、不出现登录页；父页面 handoff 新码后静默续上；
 *   I. 普通 `/m/`（非嵌入）仍然是登录页、也不带舰桥主题。
 *
 * 用法（一般交给运行器）：bash scripts/e2e-run.sh cockpit-embed
 * 手工：
 *   node scripts/e2e-cockpit-embed.mjs --hub-port 5271 --cdp 9311 --out /tmp/e2e-cockpit
 *   node scripts/e2e-cockpit-embed.mjs --no-spawn --hub http://127.0.0.1:5271 --cdp 9311 --out /tmp/x
 *   node scripts/e2e-cockpit-embed.mjs --skip-build          # 复用已有 dist-web
 */

import fs from 'node:fs/promises'
import os from 'node:os'
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
const SPAWN = !process.argv.includes('--no-spawn')
const SKIP_BUILD = process.argv.includes('--skip-build')
const HUB_PORT = Number(args['hub-port'] ?? 5271)
const CDP_PORT = Number(args.cdp ?? 9311)
const HUB_URL = (args.hub ?? `http://127.0.0.1:${HUB_PORT}`).replace(/\/+$/, '')
const OUT = path.resolve(args.out ?? 'e2e-cockpit-embed-output')
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
// 重型构建锁：默认不锁；需要串行时用 HEAVY_BUILD_LOCK=<文件> 指定
const LOCK = process.env.HEAVY_BUILD_LOCK ?? ''
const PARENT_URL = `${HUB_URL}/__cockpit/parent`
/** 中控台常见的两档宽度（docs/24 §1：520–760 px，居中；窄屏再收）。 */
const CONSOLE_WIDE = { width: 760, height: 860, dpr: 1 }
const CONSOLE_NARROW = { width: 420, height: 860, dpr: 2 }
const UA_DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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
      throw new Error(
        `eval 失败: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      )
    }
    return res.result?.value
  }
  async shot(name) {
    await fs.mkdir(OUT, { recursive: true })
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
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
  return ok
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

async function waitHttp(url, { tries = 200, label = url } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error(`服务没起来：${label}`)
}

// ── 起服务：build → 拷产物 → mock hub → Chrome ─────────────────────────────

const children = []
let profileDir = ''
let servedDir = ''

function pipeOutput(child, logFile) {
  const chunks = []
  child.stdout?.on('data', (buf) => chunks.push(buf))
  child.stderr?.on('data', (buf) => chunks.push(buf))
  child.on('close', () => {
    if (logFile) fs.writeFile(logFile, Buffer.concat(chunks)).catch(() => {})
  })
}

/**
 * 构建环境：本机 `XDG_RUNTIME_DIR` 默认指向 `/run/user/1000`（**沙箱不可写**），
 * 而 build-web.sh 会用它给 pnpm 放 store 操作锁 —— 不改的话第一步就
 * `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK: Permission denied`。
 * 所以这里把 pnpm 的运行时/临时目录显式指到仓库外的临时目录（可被 XDG_RUNTIME_DIR /
 * TMPDIR 覆盖）。
 */
async function buildEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), 'dsh-hub-runtime')
  const tmp = process.env.TMPDIR ?? path.join(os.tmpdir(), 'dsh-hub-pnpm')
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 }).catch(() => {})
  await fs.mkdir(tmp, { recursive: true }).catch(() => {})
  const env = { ...process.env, NODE_ENV: 'development', XDG_RUNTIME_DIR: runtime, TMPDIR: tmp }
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
    delete env[key]
  }
  return env
}

async function buildWeb() {
  if (SKIP_BUILD) {
    console.log('[e2e] 跳过构建（--skip-build），复用 packages/mobile-ui/dist-web')
    return
  }
  console.log('[e2e] 构建网页版：flock … bash scripts/build-web.sh')
  const args = LOCK
    ? ['flock', LOCK, 'bash', path.join(ROOT, 'scripts/build-web.sh')]
    : ['bash', path.join(ROOT, 'scripts/build-web.sh')]
  const child = spawn(args[0], args.slice(1), {
    cwd: ROOT,
    env: await buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (buf) => (output += buf.toString()))
  child.stderr.on('data', (buf) => (output += buf.toString()))
  const code = await new Promise((resolve) => child.on('close', resolve))
  await fs.mkdir(OUT, { recursive: true })
  await fs.writeFile(path.join(OUT, 'build-web.log'), output)
  if (code !== 0) {
    console.error(output.slice(-4000))
    throw new Error(`build-web.sh 失败（exit ${code}）`)
  }
  for (const line of output.split('\n')) {
    if (/version\.json|网页版产物|失败/.test(line)) console.log(`  ${line}`)
  }
}

async function startServers() {
  await fs.mkdir(OUT, { recursive: true })
  await buildWeb()

  const dist = path.join(ROOT, 'packages/mobile-ui/dist-web')
  try {
    await fs.access(path.join(dist, 'index.html'))
  } catch {
    throw new Error('packages/mobile-ui/dist-web/index.html 不存在（先跑 scripts/build-web.sh）')
  }
  servedDir = await fs.mkdtemp(path.join(OUT, 'served-'))
  await fs.cp(dist, servedDir, { recursive: true })

  if (!SPAWN) {
    await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
    return
  }

  console.log(`[e2e] 起 mock hub :${HUB_PORT}（--web-dist 同源托管 /m/）`)
  const hub = spawn(
    process.execPath,
    [path.join(ROOT, 'apps/mock-hub/server.mjs'), '--port', String(HUB_PORT), '--web-dist', servedDir],
    {
      env: { ...process.env, PORT: String(HUB_PORT), TICK_MS: '12', WAKE_MS: '1200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(hub)
  pipeOutput(hub, path.join(OUT, 'hub.log'))
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })

  profileDir = await fs.mkdtemp(path.join(OUT, 'chrome-profile-'))
  console.log(`[e2e] 起 headless Chrome :${CDP_PORT}`)
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
  if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

// ── mock hub 控制面 ────────────────────────────────────────────────────────

async function hubReset() {
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
}
async function requestCode() {
  const res = await fetch(`${HUB_URL}/__test/cockpit-handoff`, { method: 'POST' })
  if (!res.ok) throw new Error(`发交接码失败：${res.status}`)
  return (await res.json()).code
}
async function cockpitState() {
  return (await fetch(`${HUB_URL}/__test/cockpit-state`)).json()
}
/** iframe 里的诊断环形缓冲（只事件名 + 极短细节）：断言新加的「主动建连」路径真的跑了。 */
async function cockpitDiag(cdp) {
  const raw = await cdp.eval(inFrame(`return w.localStorage.getItem('dsh-hub:diagnostics:v1')`))
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
async function expireCockpit() {
  return (await fetch(`${HUB_URL}/__test/cockpit-expire`, { method: 'POST' })).json()
}
/** 直接调一次交换接口（验证「码只能用一次」）。 */
async function exchangeDirect(code) {
  const res = await fetch(`${HUB_URL}/api/mobile/auth/cockpit-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** 按谓词等 iframe 的诊断环形缓冲（诊断写盘与 link 状态有一拍延迟）。 */
async function waitCockpitDiag(cdp, predicate, { timeout = 10000, label = 'cockpit diag' } = {}) {
  const started = Date.now()
  let last = []
  while (Date.now() - started < timeout) {
    last = await cockpitDiag(cdp)
    if (predicate(last)) return last
    await sleep(100)
  }
  throw new Error(`等待超时：${label}（最后 ${last.map((e) => `${e.name}:${e.detail}`).join(',')}）`)
}

/** 座舱节点「冷启动窗口」开关（WP56e3）：`connectable:false` + `ms` → 这段时间内不可连接。 */
async function setCockpitNode(connectable, ms = 0) {
  const res = await fetch(`${HUB_URL}/__test/cockpit-node`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectable, ms }),
  })
  if (!res.ok) throw new Error(`设置座舱节点状态失败：${res.status}`)
  return res.json()
}

/** 按谓词等 `/__test/cockpit-state`（通道侧证据都在这里；不在页面里轮询）。 */
async function waitCockpitState(predicate, { timeout = 20000, label = 'cockpit state' } = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeout) {
    last = await cockpitState()
    if (predicate(last)) return last
    await sleep(150)
  }
  throw new Error(`等待超时：${label}（最后状态 ${JSON.stringify(last?.node ?? null)}）`)
}

/** 在 iframe 里打开一个会话（路由 + store 一起到位）。 */
async function openCockpitSession(cdp, sessionId) {
  await cdp.eval(
    inFrame(`void w.__dshHub.router.push('/c/' + ${JSON.stringify(sessionId)}); return true`),
  )
  await waitFor(
    cdp,
    inFrame(
      `return w.__dshHub.chat.activeId === ${JSON.stringify(sessionId)} && w.__dshHub.router.currentRoute.value.name === 'conversation'`,
    ),
    { timeout: 20000, label: `打开会话 ${sessionId}` },
  )
}

/**
 * 用输入卡真发一条消息，并等**一条新的**助手回复落到对话里（返回回复正文）。
 *
 * 计数而不是「文本里有 alice」：同一个会话会被多段 e2e 复用，历史回复里也有 alice，
 * 那样会在发送前就判成功（假绿）。
 */
async function sendCockpitMessage(cdp, text) {
  await waitFor(
    cdp,
    inFrame(`return !!w.document.querySelector('.composer__input') && !!w.document.querySelector('.send-btn')`),
    { label: '输入卡' },
  )
  const before = await cdp.eval(
    inFrame(
      `return (w.__dshHub.chat.state?.messages ?? []).filter((m) => m.role === 'assistant').length`,
    ),
  )
  await cdp.eval(
    inFrame(`const d = w.document; const el = d.querySelector('.composer__input');
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      return true`),
  )
  await cdp.eval(inFrame(`w.document.querySelector('.send-btn').click(); return true`))
  await waitFor(
    cdp,
    inFrame(
      `return (w.__dshHub.chat.state?.messages ?? []).filter((m) => m.role === 'assistant').length > ${before ?? 0}`,
    ),
    { timeout: 30000, label: '助手回复' },
  )
  return await cdp.eval(
    inFrame(`const msgs = w.__dshHub.chat.state?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      return last ? String(last.text || '') : ''`),
  )
}

// ── 页面里的助手（全部走同源属性访问；测试脚本只读状态，不改 App 逻辑）─────────

/** 在父页面里对 iframe 求值：`frameName` 是 iframe 元素的 id。 */
function inFrame(body) {
  return `(() => { const f = document.getElementById('app'); if (!f || !f.contentWindow) return null; const w = f.contentWindow; try { return (function(){ ${body} }).call(w) } catch (e) { return { __error: String(e) } } })()`
}

let cdpRef = null

async function main() {
  await startServers()
  const cdp = await Cdp.attach(CDP_PORT)
  cdpRef = cdp
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  // 中控台在真舰桥里是 520–760 px 宽的一栏，外面两舷由 Hub 前端画。
  // 这里按「宽一点的中控台」跑（760），窄屏那一节再切到 420。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: CONSOLE_WIDE.width,
    height: CONSOLE_WIDE.height,
    deviceScaleFactor: CONSOLE_WIDE.dpr,
    mobile: false,
  })
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: UA_DESKTOP,
    platform: 'Linux x86_64',
    acceptLanguage: 'zh-CN,zh;q=0.9',
  })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ── 0. 打开父页面，用一次性交接码把 iframe 挂起来 ─────────────────────────
  await hubReset()
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(200)
  await cdp.send('Page.navigate', { url: PARENT_URL })
  await waitFor(cdp, `document.getElementById('app')`, { label: '父页面 iframe' })

  const firstCode = await requestCode()
  await cdp.eval(`window.loadApp(${JSON.stringify(firstCode)})`)
  await waitFor(cdp, inFrame(`return !!w.__dshHub && w.__dshHub.auth.phase === 'authenticated'`), {
    timeout: 25000,
    label: '嵌入模式认证成功',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 20000,
    label: '通道连上',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.sessions.length >= 2`), {
    timeout: 20000,
    label: '会话列表',
  })
  await sleep(300)
  await cdp.shot('01-console-wide')

  // ── 1. A 组：进入 + 入口处理 ─────────────────────────────────────────────
  const entry = await cdp.eval(
    inFrame(`return {
      isWebBuild: w.document.documentElement.classList.contains('is-web'),
      embed: w.__dshHub.cockpit.embed,
      bridgeTheme: w.__dshHub.cockpit.bridgeTheme,
      attached: w.__dshHub.cockpit.attached,
      route: w.__dshHub.router.currentRoute.value.name,
      search: w.location.search,
      hash: w.location.hash,
      topIsParent: w !== w.top,
    }`),
  )
  expect('iframe 里是网页构建（is-web）', entry?.isWebBuild === true, entry?.isWebBuild)
  expect(
    '识别为嵌入座舱模式（?embed=cockpit&theme=bridge）',
    entry?.embed === true &&
      typeof entry.search === 'string' &&
      entry.search.includes('embed=cockpit') &&
      entry.search.includes('theme=bridge'),
    entry?.search,
  )
  expect('识别为舰桥主题（theme=bridge）', entry?.bridgeTheme === true, entry?.bridgeTheme)
  expect('iframe 确实嵌在父页面里（不是顶层打开）', entry?.topIsParent === true, entry?.topIsParent)
  expect('桥已挂上（cockpit.attached）', entry?.attached === true, entry?.attached)
  expect(
    '交接码已从地址栏抹掉（hash 里没有 code）',
    typeof entry?.hash === 'string' && !entry.hash.includes('code'),
    entry?.hash,
  )

  const firstState = await cockpitState()
  const firstExchange = firstState.exchanges.filter((item) => item.code === firstCode)
  expect(
    '交接码只被用了一次（mock 侧记录 1 次成功换码）',
    firstExchange.length === 1 && firstExchange[0].ok === true,
    firstExchange,
  )
  const reuse = await exchangeDirect(firstCode)
  expect(
    '同一个码再用一次被拒绝（一次性）',
    reuse.status === 400 && reuse.body?.error?.code === 'INVALID_REQUEST',
    { status: reuse.status, body: reuse.body },
  )

  // ── 2. B 组：令牌存储隔离 ────────────────────────────────────────────────
  const storage = await cdp.eval(
    inFrame(`return {
      session: Object.keys(w.sessionStorage).sort(),
      cockpitToken: w.sessionStorage.getItem('dshm.cockpit.auth-v1') !== null,
      normalToken: w.localStorage.getItem('dshm.web.auth-v1') !== null,
      cockpitInLocal: w.localStorage.getItem('dshm.cockpit.auth-v1') !== null,
    }`),
  )
  expect('座舱令牌在 sessionStorage 的 cockpit 键里', storage?.cockpitToken === true, storage?.session)
  expect(
    'localStorage 里没有座舱令牌（也不碰普通 /m/ 的登录键）',
    storage?.cockpitInLocal === false && storage?.normalToken === false,
    storage,
  )

  // ── 3. C 组：舰桥主题（深色 + 透明背景，不能有白底）────────────────────────
  const theme = await cdp.eval(
    inFrame(`const root = w.document.documentElement;
      const body = w.document.body;
      const shell = w.document.querySelector('.app-shell');
      const pick = (el) => el ? w.getComputedStyle(el).backgroundColor : null;
      return {
        cls: root.classList.contains('cockpit-bridge'),
        dataTheme: root.dataset.theme,
        bgVar: w.getComputedStyle(root).getPropertyValue('--bg').trim(),
        bodyBg: pick(body),
        shellBg: pick(shell),
        textColor: w.getComputedStyle(body).color,
        tabular: w.getComputedStyle(root).fontVariantNumeric,
      }`),
  )
  expect('html 上有 cockpit-bridge 类', theme?.cls === true, theme?.cls)
  expect('强制深色（data-theme=dark，不管用户原来选的是浅色）', theme?.dataTheme === 'dark', theme?.dataTheme)
  expect(
    '页面背景透明（白底会从舰桥里露出来）',
    theme?.bgVar === 'transparent' &&
      (theme.bodyBg === 'rgba(0, 0, 0, 0)' || theme.bodyBg === 'transparent') &&
      (theme.shellBg === 'rgba(0, 0, 0, 0)' || theme.shellBg === 'transparent'),
    { bgVar: theme?.bgVar, bodyBg: theme?.bodyBg, shellBg: theme?.shellBg },
  )
  expect('文字是偏冷的近白（不是深色主题下的黑字）', /rgb\(2[0-9]{2}|rgb\(1[5-9][0-9]/.test(String(theme?.textColor)), theme?.textColor)
  expect('数字统一等宽（tabular-nums）', String(theme?.tabular).includes('tabular-nums'), theme?.tabular)
  await cdp.shot('02-bridge-theme')

  // ── 4. D 组：节点固定、入口隐藏（docs/24 §6）──────────────────────────────
  const chrome = await cdp.eval(
    inFrame(`const d = w.document;
      return {
        backend: w.__dshHub.backend.selectedBackendId,
        backends: w.__dshHub.auth.backends.map((b) => b.id),
        drawerButtons: d.querySelectorAll('[aria-label="打开抽屉"]').length,
        logButtons: d.querySelectorAll('[data-testid="nav-log-button"]').length,
        installHint: d.querySelectorAll('.install-hint').length,
        desktopEntry: d.body.innerText.includes('打开桌面版') || d.body.innerText.includes('电脑版'),
        settingsLink: d.querySelectorAll('[aria-label="设置"]').length,
        mic: !!d.querySelector('.composer__mic'),
        logVisible: !!d.querySelector('[data-testid="cockpit-log"]'),
      }`),
  )
  expect('节点固定为 cloud:ops', chrome?.backend === 'cloud:ops', chrome?.backend)
  expect(
    '后端列表只有 cloud:ops（没有可切换的第二个节点）',
    Array.isArray(chrome?.backends) && chrome.backends.length === 1 && chrome.backends[0] === 'cloud:ops',
    chrome?.backends,
  )
  expect(
    '有「航行日志」按钮、没有抽屉按钮（会话列表不占栏）',
    chrome?.logButtons === 1 && chrome?.drawerButtons === 0,
    { logButtons: chrome?.logButtons, drawerButtons: chrome?.drawerButtons },
  )
  expect('航行日志默认收起', chrome?.logVisible === false, chrome?.logVisible)
  expect('没有安装 PWA 的提示', chrome?.installHint === 0, chrome?.installHint)
  expect('没有账号/设置入口', chrome?.settingsLink === 0, chrome?.settingsLink)
  expect('没有「打开桌面版/电脑版」入口', chrome?.desktopEntry === false, chrome?.desktopEntry)
  expect('保留语音输入（按住说话）', chrome?.mic === true, chrome?.mic)

  const settingsRedirect = await cdp.eval(
    inFrame(`return (async () => {
      await w.__dshHub.router.push('/settings').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 120));
      return w.__dshHub.router.currentRoute.value.name;
    })()`),
  )
  expect('直接访问 /settings 会被重定向（座舱没有设置页）', settingsRedirect === 'home', settingsRedirect)

  const modelSheet = await cdp.eval(
    inFrame(`const d = w.document;
      w.__dshHub.ui.openModelSheet();
      return new Promise((resolve) => setTimeout(() => {
        const items = d.querySelectorAll('.sheet__item.backend').length;
        w.__dshHub.ui.closeModelSheet();
        resolve({ items });
      }, 150))`),
  )
  expect('模型弹层里没有节点切换项', modelSheet?.items === 0, modelSheet)

  // ── 5. E 组：航行日志（标题 / 发起人 / 更新时间 / + 新会话）────────────────
  await cdp.eval(inFrame(`w.document.querySelector('[data-testid="nav-log-button"]').click(); return true`))
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-testid="cockpit-log"]')`), {
    label: '航行日志打开',
  })
  const log = await cdp.eval(
    inFrame(`const d = w.document; const panel = d.querySelector('[data-testid="cockpit-log"]');
      const rows = [...panel.querySelectorAll('[data-session-row]')];
      return {
        rows: rows.length,
        titles: rows.map((r) => r.querySelector('.session-row__title').textContent.trim()),
        who: rows.map((r) => r.querySelector('.session-row__who')?.textContent?.trim() ?? null),
        times: rows.map((r) => r.querySelector('.session-row__time').textContent.trim()),
        hasNew: !!panel.querySelector('.cockpit-log__new'),
        hasSettings: panel.querySelectorAll('[aria-label="设置"]').length,
      }`),
  )
  expect('航行日志里是座舱的共享会话列表', log?.rows >= 2 && log.titles.includes('本周用量'), log?.titles)
  expect(
    '会话行显示发起人（接口给了 initiator）',
    Array.isArray(log?.who) && log.who.includes('admin') && log.who.includes('ops-lee'),
    log?.who,
  )
  expect(
    '会话行显示更新时间（短格式，等宽数字）',
    Array.isArray(log?.times) && log.times.every((t) => /^(\d{2}:\d{2}|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$/u.test(t)),
    log?.times,
  )
  expect('日志里有「+ 新会话」', log?.hasNew === true, log?.hasNew)
  expect('日志里没有账号/设置入口', log?.hasSettings === 0, log?.hasSettings)
  await cdp.shot('03-nav-log')

  // ── 6. E 组：父页面收到的上行消息 ────────────────────────────────────────
  const ready = await cdp.eval(`window.lastOfType('cockpit.ready')`)
  expect('父页面收到 cockpit.ready', ready !== null, ready)
  const sessionMsg = await cdp.eval(`window.lastOfType('cockpit.session')`)
  // 启动时停在中控台首页（没有打开的会话）→ sessionId 为 null 是契约允许的（`sessionId|null`）
  expect(
    '父页面收到 cockpit.session（启动时没有打开的会话 → sessionId:null）',
    sessionMsg !== null && sessionMsg.sessionId === null,
    sessionMsg,
  )

  // 跨源消息必须被丢弃（App 侧校验 event.origin）
  await cdp.eval(`(() => {
    const frame = document.getElementById('app');
    frame.contentWindow.dispatchEvent(new MessageEvent('message', {
      data: { type: 'cockpit.prefill', text: '跨源注入' },
      origin: 'https://evil.invalid',
      source: frame.contentWindow,
    }));
    return true;
  })()`)
  await sleep(150)
  const prefillAfterCross = await cdp.eval(
    inFrame(`return w.document.querySelector('.composer__input').value`),
  )
  expect('跨源（origin 不符）的 postMessage 被丢弃', prefillAfterCross === '', prefillAfterCross)

  // ── 7. 从日志切会话 → 父页面拿到 session ──────────────────────────────────
  const otherSession = 's_mock_cockpit_ops'
  await cdp.eval(
    inFrame(`const rows = [...w.document.querySelectorAll('[data-session-id]')];
      rows.find((r) => r.getAttribute('data-session-id') === '${otherSession}').click();
      return true`),
  )
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.activeId === '${otherSession}'`), {
    label: '切到「插件升级」会话',
  })
  await waitFor(
    cdp,
    inFrame(`return w.__dshHub.router.currentRoute.value.name === 'conversation'`),
    { label: '对话页' },
  )
  const sessionAfterSwitch = await cdp.eval(`window.lastOfType('cockpit.session')`)
  expect(
    '切会话后父页面收到 cockpit.session（同一个 id）',
    sessionAfterSwitch?.sessionId === otherSession,
    sessionAfterSwitch,
  )
  const logClosed = await cdp.eval(
    inFrame(`return {
      open: w.__dshHub.cockpit.logOpen,
      panel: !!w.document.querySelector('[data-testid="cockpit-log"]'),
    }`),
  )
  expect('选中会话后日志自动收起', logClosed?.open === false && logClosed?.panel === false, logClosed)

  // ── 8. F 组：回合 → 3 次投放 + 1 次方案（docs/24 §1/§6）───────────────────
  const draftText = '给我看近 7 天用量，然后把 dsh-memory 下发给所有人'
  await cdp.eval(
    inFrame(`const d = w.document; const el = d.querySelector('.composer__input');
      el.value = ${JSON.stringify(draftText)};
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      return true`),
  )
  await cdp.eval(inFrame(`w.document.querySelector('.send-btn').click(); return true`))
  await waitFor(
    cdp,
    inFrame(`return w.document.querySelectorAll('[data-testid="process-canvas"]').length === 3`),
    { timeout: 25000, label: '三条投放行' },
  )
  await waitFor(
    cdp,
    inFrame(`return w.document.querySelector('[data-testid="process-proposal"]') !== null`),
    { timeout: 25000, label: '方案行' },
  )
  const actions = await cdp.eval(
    inFrame(`const d = w.document;
      const canvases = [...d.querySelectorAll('[data-testid="process-canvas"]')].map((el) => ({
        text: el.querySelector('.process__action-text').textContent.replace(/\s+/g, ' ').trim(),
        id: el.getAttribute('data-canvas-id'),
      }));
      const proposal = d.querySelector('[data-testid="process-proposal"]');
      return {
        canvases,
        proposal: proposal ? {
          text: proposal.querySelector('.process__action-text').textContent.replace(/\s+/g, ' ').trim(),
          id: proposal.getAttribute('data-proposal-id'),
        } : null,
      }`),
  )
  expect(
    '三次 canvas_show 的过程行：左舷 / 左舷 / 右舷',
    JSON.stringify(actions?.canvases?.map((item) => item.text)) ===
      JSON.stringify([
        '⟶ 已投放左舷：近 7 天积分消耗',
        '⟶ 已投放左舷：Top 5 用户',
        '⟶ 已投放右舷：下发进度 #88',
      ]),
    actions?.canvases,
  )
  expect(
    'ops_call 出方案 → 「⟶ 方案 #12 · 待确认（右舷）」',
    actions?.proposal?.id === '12' &&
      actions.proposal.text === '⟶ 方案 #12 · 待确认（右舷）',
    actions?.proposal,
  )
  await waitFor(cdp, inFrame(`return (w.__dshHub.chat.streamingText || '').includes('alice')`), {
    timeout: 25000,
    label: '座舱回合正文',
  })
  expect('座舱回合的正文到了（带用量结论）', true, '含 alice')
  await cdp.shot('04-process-actions')

  // 回合开始/结束（父页面据此区分「本回合」的卡）
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.turnRunning === false`), {
    timeout: 25000,
    label: '回合结束',
  })
  const turns = await cdp.eval(`window.received.filter((m) => m && m.type === 'cockpit.turn')`)
  expect(
    '父页面收到 cockpit.turn：先 true 后 true→false',
    Array.isArray(turns) && turns.some((m) => m.running === true) && turns[turns.length - 1]?.running === false,
    turns,
  )

  // (a) 首次进入（节点已就绪）：不只看 UI —— Hub 侧必须真的有 ticket、经通道的 send 与助手回复。
  const proofA = await cockpitState()
  const ticketA = proofA.tickets.filter((item) => item.ok)
  expect(
    '（a）首次进入：App 向 Hub 申请过通道 ticket（节点 cloud:ops）',
    ticketA.length >= 1 && ticketA.every((item) => item.nodeId === 'cloud:ops'),
    proofA.tickets.slice(-3),
  )
  const turnA = proofA.turns.filter((item) => item.text === draftText)
  expect(
    '（a）消息经 WS 通道到达 Hub（mock 收到 send 帧，不是只改了 UI）',
    turnA.length === 1 && turnA[0].sessionId === otherSession,
    turnA,
  )
  const replyA = proofA.replies.filter(
    (item) =>
      item.sessionId === otherSession &&
      item.at >= (turnA[0]?.at ?? 0) &&
      String(item.text).includes('alice'),
  )
  expect('（a）mock 回合产生助手回复（经通道回到 App）', replyA.length >= 1, replyA.slice(-1))

  // 点投放行 → focus-canvas；点方案行 → focus-proposal
  await cdp.eval(
    inFrame(`w.document.querySelector('[data-testid="process-canvas"]').click(); return true`),
  )
  await waitFor(cdp, `window.lastOfType('cockpit.focus-canvas') !== null`, {
    label: '父页面收到 focus-canvas',
  })
  const focusCanvas = await cdp.eval(`window.lastOfType('cockpit.focus-canvas')`)
  expect('点投放行 → cockpit.focus-canvas{id:cv_mock_1}', focusCanvas?.id === 'cv_mock_1', focusCanvas)

  await cdp.eval(
    inFrame(`w.document.querySelector('[data-testid="process-proposal"]').click(); return true`),
  )
  await waitFor(cdp, `window.lastOfType('cockpit.focus-proposal') !== null`, {
    label: '父页面收到 focus-proposal',
  })
  const focusProposal = await cdp.eval(`window.lastOfType('cockpit.focus-proposal')`)
  expect(
    '点方案行 → cockpit.focus-proposal{id:12}',
    focusProposal?.id === 12,
    focusProposal,
  )

  // ── 9. G 组：prefill / focus-session（父 → 子）────────────────────────────
  const prefillText = '近 7 天中转站用量，按用户排一下'
  await cdp.eval(`window.sendToApp({ type: 'cockpit.prefill', text: ${JSON.stringify(prefillText)} })`)
  await waitFor(
    cdp,
    inFrame(`return w.document.querySelector('.composer__input').value === ${JSON.stringify(prefillText)}`),
    { label: 'prefill 填进输入框' },
  )
  expect('父页面 cockpit.prefill → 填进输入框（不自动发送）', true, prefillText)

  await cdp.eval(`window.sendToApp({ type: 'cockpit.focus-session', sessionId: 's_mock_cockpit' })`)
  await waitFor(
    cdp,
    inFrame(`return w.__dshHub.chat.activeId === 's_mock_cockpit' && w.__dshHub.router.currentRoute.value.name === 'conversation'`),
    { label: 'focus-session 切会话' },
  )
  const sessionAfterFocus = await cdp.eval(`window.lastOfType('cockpit.session')`)
  expect(
    '父页面 cockpit.focus-session → 切到该会话（并回发 cockpit.session）',
    sessionAfterFocus?.sessionId === 's_mock_cockpit',
    sessionAfterFocus,
  )
  await waitFor(
    cdp,
    inFrame(`return w.document.querySelectorAll('[data-testid="process-canvas"]').length >= 1 && w.document.querySelector('[data-testid="process-proposal"]') !== null`),
    { timeout: 15000, label: '历史会话里的投放/方案行' },
  )
  const historyActions = await cdp.eval(
    inFrame(`return [...w.document.querySelectorAll('.process__action-text')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())`),
  )
  expect(
    '重进历史会话：过程行里仍有「⟶ 已投放左舷」与「⟶ 方案 #12」（工具帧补发）',
    Array.isArray(historyActions) &&
      historyActions.some((text) => text === '⟶ 已投放左舷：近 7 天积分消耗') &&
      historyActions.some((text) => text === '⟶ 方案 #12 · 待确认（右舷）'),
    historyActions,
  )

  // ── 9.5 (b) 冷启动：cloud:ops 先不可连接，容器起来后自动建通道并完成一轮 ────────
  //
  // 真 Hub 里座舱容器是 /admin 打开时才拉起的，60–90 秒内 connectable:false。
  // 这里用 mock 的冷启动窗口（8 秒）复现同一时序；断言必须落到「ticket + 经通道的 send +
  // 助手回复」，只看 iframe 里的 UI 会漏掉「从不发通道」这种 bug（WP56e2 就是这么漏的）。
  const coldCode = await requestCode()
  // 8 秒足够覆盖 App 的 2.5 秒轮询两拍（真 Hub 是 60–90 秒；这里只要证明「先不可连接、
  // 起来之后会自动接上」，不必真的等一分半）。
  const coldWindowMs = 8000
  const coldSetting = await setCockpitNode(false, coldWindowMs)
  expect('mock 侧进入座舱冷启动窗口（cloud:ops 暂不可连接）', coldSetting.connectable === false, coldSetting)
  const coldMark = Date.now()
  // 清掉座舱令牌：这一次必须用新交接码换令牌，等价于「Hub 刚打开 /admin」
  await cdp.eval(inFrame(`w.sessionStorage.clear(); return true`))
  await cdp.eval(`window.loadApp(${JSON.stringify(coldCode)})`)
  await waitFor(
    cdp,
    inFrame(`return !!w.__dshHub && w.__dshHub.auth.phase === 'authenticated'`),
    { timeout: 25000, label: '(b) 冷启动：交接码换令牌成功' },
  )
  const coldSeen = await waitCockpitState(
    (state) =>
      state.node.connectable === false &&
      state.bootstraps.some((item) => item.at >= coldMark && item.connectable === false),
    { label: '(b) 冷启动：bootstrap 明确 connectable:false' },
  )
  expect(
    '（b）冷启动窗口里 bootstrap 是 connectable:false',
    coldSeen.bootstraps.some((item) => item.at >= coldMark && item.connectable === false),
    coldSeen.bootstraps.filter((item) => item.at >= coldMark),
  )
  expect(
    '（b）节点不可连接时 App 不发起通道（窗口内没有 ticket 请求）',
    coldSeen.tickets.filter((item) => item.at >= coldMark).length === 0,
    coldSeen.tickets.filter((item) => item.at >= coldMark),
  )
  await waitFor(cdp, inFrame(`return w.__dshHub.backend.wakeState === 'blocked'`), {
    timeout: 15000,
    label: '(b) 冷启动：等待容器（blocked）',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 30000,
    label: '(b) 冷启动结束：通道自动建起来',
  })
  const coldBooted = await cockpitState()
  const coldBoots = coldBooted.bootstraps.filter((item) => item.at >= coldMark)
  expect(
    '（b）冷启动窗口结束后 connectable 变成 true（且都被 App 看到了）',
    coldBoots.some((item) => item.connectable === false) && coldBoots.some((item) => item.connectable === true),
    coldBoots,
  )
  const coldTickets = coldBooted.tickets.filter((item) => item.at >= coldMark)
  expect(
    '（b）节点可连接之后 App 主动申请 ticket（cloud:ops）并连上',
    coldTickets.some((item) => item.ok && item.nodeId === 'cloud:ops'),
    coldTickets,
  )
  const coldDiag = (
    await waitCockpitDiag(
      cdp,
      (events) =>
        events.some(
          (event) => event.at >= coldMark && event.name === 'cockpit:hello' && event.detail === 'connected',
        ),
      { label: '(b) cockpit:hello(connected)' },
    )
  ).filter((event) => event.at >= coldMark)
  expect(
    '（b）诊断里有 cockpit:ready 与 cockpit:hello(connected)（走的是新加的主动建连路径）',
    coldDiag.some((event) => event.name === 'cockpit:ready') &&
      coldDiag.some((event) => event.name === 'cockpit:hello' && event.detail === 'connected'),
    coldDiag.map((event) => `${event.name}:${event.detail}`),
  )
  const coldText = '冷启动结束后的一条：把近 7 天用量按用户排一下（e2e-b）'
  await openCockpitSession(cdp, otherSession)
  const coldReply = await sendCockpitMessage(cdp, coldText)
  expect('（b）冷启动后发的消息收到助手回复（对话里）', String(coldReply).includes('alice'), String(coldReply).slice(0, 60))
  const coldAfter = await cockpitState()
  const coldTurn = coldAfter.turns.filter((item) => item.text === coldText)
  expect(
    '（b）消息经 WS 通道到达 Hub（mock 收到 send 帧）',
    coldTurn.length === 1 && coldTurn[0].sessionId === otherSession,
    coldTurn,
  )
  const coldReplyAt = coldAfter.replies.filter(
    (item) =>
      item.sessionId === otherSession &&
      item.at >= (coldTurn[0]?.at ?? 0) &&
      String(item.text).includes('alice'),
  )
  expect('（b）mock 回合产生助手回复（经通道回到 App）', coldReplyAt.length >= 1, coldReplyAt.slice(-1))
  await cdp.shot('08-cold-start-connected')

  // ── 9.6 (c) iframe 整页重载：从 sessionStorage 恢复令牌，自动重连并完成一轮 ────────
  await setCockpitNode(true)
  const beforeReload = await cockpitState()
  const exchangesBefore = beforeReload.exchanges.length
  const reloadMark = Date.now()
  await cdp.eval(inFrame(`w.__e2eReloadMark = 1; return true`))
  await cdp.eval(
    `(() => { const f = document.getElementById('app'); f.contentWindow.location.reload(); return true })()`,
  )
  await waitFor(
    cdp,
    inFrame(`return !!w.__dshHub && !w.__e2eReloadMark && w.__dshHub.auth.phase === 'authenticated'`),
    { timeout: 25000, label: '(c) 重载后恢复登录态（sessionStorage）' },
  )
  const reloadStorage = await cdp.eval(
    inFrame(`return {
      token: w.sessionStorage.getItem('dshm.cockpit.auth-v1') !== null,
      embed: w.__dshHub.cockpit.embed,
      hash: w.location.hash,
    }`),
  )
  expect(
    '（c）整页重载后从 sessionStorage 恢复座舱令牌（不再有交接码）',
    reloadStorage?.token === true && reloadStorage.embed === true && !String(reloadStorage.hash).includes('code'),
    reloadStorage,
  )
  const afterReloadBoot = await cockpitState()
  expect(
    '（c）重载没有消耗新的交接码（换码次数不变）',
    afterReloadBoot.exchanges.length === exchangesBefore,
    { before: exchangesBefore, after: afterReloadBoot.exchanges.length },
  )
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 25000,
    label: '(c) 重载后自动重连',
  })
  const reloadConnected = await cockpitState()
  const reloadTickets = reloadConnected.tickets.filter((item) => item.at >= reloadMark)
  expect(
    '（c）重载后 App 重新申请了通道 ticket 并连上',
    reloadTickets.some((item) => item.ok && item.nodeId === 'cloud:ops'),
    reloadTickets,
  )
  const reloadDiag = (
    await waitCockpitDiag(
      cdp,
      (events) =>
        events.some(
          (event) => event.at >= reloadMark && event.name === 'cockpit:hello' && event.detail === 'connected',
        ),
      { label: '(c) cockpit:hello(connected)' },
    )
  ).filter((event) => event.at >= reloadMark)
  expect(
    '（c）诊断里有新的 boot 与 cockpit:hello(connected)（重载后主动重连）',
    reloadDiag.some((event) => event.name === 'boot') &&
      reloadDiag.some((event) => event.name === 'cockpit:hello' && event.detail === 'connected'),
    reloadDiag.map((event) => `${event.name}:${event.detail}`),
  )
  const reloadText = 'iframe 重载之后的一条：再看一次近 7 天用量（e2e-c）'
  await openCockpitSession(cdp, otherSession)
  const reloadReply = await sendCockpitMessage(cdp, reloadText)
  expect('（c）重载后发的消息收到助手回复（对话里）', String(reloadReply).includes('alice'), String(reloadReply).slice(0, 60))
  const reloadAfter = await cockpitState()
  const reloadTurn = reloadAfter.turns.filter((item) => item.text === reloadText)
  expect(
    '（c）重载后的消息经 WS 通道到达 Hub',
    reloadTurn.length === 1 && reloadTurn[0].sessionId === otherSession,
    reloadTurn,
  )
  const reloadReplyAt = reloadAfter.replies.filter(
    (item) =>
      item.sessionId === otherSession &&
      item.at >= (reloadTurn[0]?.at ?? 0) &&
      String(item.text).includes('alice'),
  )
  expect('（c）重载后的 mock 回合产生助手回复（经通道回到 App）', reloadReplyAt.length >= 1, reloadReplyAt.slice(-1))
  await cdp.shot('09-reload-reconnected')

  // ── 9b. 密钥不进对话（docs/24 §0-4）：像密钥的片段在 App 侧打码后才发 ─────────
  const leakKey = 'sk-e2e-0123456789abcdef0123456789abcdef'
  const leakText = `加一个中转站渠道，key 是 ${leakKey}（e2e-mask）`
  await sendCockpitMessage(cdp, leakText)
  const maskAfter = await cockpitState()
  const maskTurn = maskAfter.turns.filter((item) => String(item.text).includes('e2e-mask'))
  expect(
    '密钥打码：经通道到达 Hub 的正文里没有明文 key，换成了 [已隐藏]',
    maskTurn.length === 1 && !String(maskTurn[0].text).includes(leakKey) && String(maskTurn[0].text).includes('[已隐藏]'),
    maskTurn.map((item) => item.text),
  )
  const bubbleHasKey = await cdp.eval(inFrame(`return document.body.innerText.includes(${JSON.stringify(leakKey)})`))
  expect('密钥打码：对话气泡里也看不到明文 key', bubbleHasKey === false, bubbleHasKey)

  // ── 10. H 组：令牌过期 → auth-expired → handoff 续上 ──────────────────────
  const expired = await expireCockpit()
  expect('mock 侧让座舱令牌全部失效', expired.removed >= 2, expired)
  await cdp.eval(inFrame(`void w.__dshHub.auth.refreshBootstrap(); return true`))
  await waitFor(cdp, `window.lastOfType('cockpit.auth-expired') !== null`, {
    timeout: 20000,
    label: 'cockpit.auth-expired',
  })
  const afterExpire = await cdp.eval(
    inFrame(`return {
      phase: w.__dshHub.auth.phase,
      waiting: w.__dshHub.cockpit.waiting,
      overlay: !!w.document.querySelector('[data-testid="cockpit-wait"]'),
      login: !!w.document.querySelector('.login'),
      route: w.__dshHub.router.currentRoute.value.name,
      token: w.sessionStorage.getItem('dshm.cockpit.auth-v1'),
    }`),
  )
  expect('令牌过期 → 发 cockpit.auth-expired（父页面收到）', true)
  expect(
    '过期后**不弹登录页**，停在等待交接状态',
    afterExpire?.phase === 'anonymous' &&
      afterExpire.waiting === true &&
      afterExpire.overlay === true &&
      afterExpire.login === false &&
      afterExpire.route !== 'login',
    afterExpire,
  )
  expect('过期后本地座舱令牌已清掉', afterExpire?.token === null, afterExpire?.token)
  await cdp.shot('05-auth-expired-wait')

  const secondCode = await requestCode()
  await cdp.eval(`window.sendToApp({ type: 'cockpit.handoff', code: ${JSON.stringify(secondCode)} })`)
  await waitFor(cdp, inFrame(`return w.__dshHub.auth.phase === 'authenticated'`), {
    timeout: 20000,
    label: 'handoff 后恢复登录态',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 20000,
    label: 'handoff 后通道重连',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.sessions.length >= 2`), {
    timeout: 20000,
    label: 'handoff 后会话列表回来',
  })
  const afterHandoff = await cdp.eval(
    inFrame(`return {
      phase: w.__dshHub.auth.phase,
      waiting: w.__dshHub.cockpit.waiting,
      overlay: !!w.document.querySelector('[data-testid="cockpit-wait"]'),
      token: w.sessionStorage.getItem('dshm.cockpit.auth-v1') !== null,
      backend: w.__dshHub.backend.selectedBackendId,
    }`),
  )
  expect(
    'handoff 新码 → 静默续上（不再有等待提示、令牌回到 sessionStorage）',
    afterHandoff?.phase === 'authenticated' &&
      afterHandoff.waiting === false &&
      afterHandoff.overlay === false &&
      afterHandoff.token === true &&
      afterHandoff.backend === 'cloud:ops',
    afterHandoff,
  )
  const secondExchange = (await cockpitState()).exchanges.filter((item) => item.code === secondCode)
  expect('第二个交接码也用且仅用了一次', secondExchange.length === 1 && secondExchange[0].ok, secondExchange)
  await cdp.shot('06-handoff-resumed')

  // ── 11. 窄中控台（420 px）：布局不塌，日志仍然可用 ────────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: CONSOLE_NARROW.width,
    height: CONSOLE_NARROW.height,
    deviceScaleFactor: CONSOLE_NARROW.dpr,
    mobile: true,
  })
  await sleep(400)
  const narrow = await cdp.eval(
    inFrame(`const d = w.document;
      return {
        logButtons: d.querySelectorAll('[data-testid="nav-log-button"]').length,
        drawerButtons: d.querySelectorAll('[aria-label="打开抽屉"]').length,
        inputVisible: (() => { const el = d.querySelector('.composer__input'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom <= w.innerHeight + 1; })(),
      }`),
  )
  expect('窄中控台仍只有「航行日志」（没有抽屉按钮）', narrow?.logButtons === 1 && narrow?.drawerButtons === 0, narrow)
  expect('窄中控台里输入卡仍然在可视区内', narrow?.inputVisible === true, narrow?.inputVisible)
  await cdp.eval(inFrame(`w.document.querySelector('[data-testid="nav-log-button"]').click(); return true`))
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-testid="cockpit-log"]')`), {
    label: '窄屏日志打开',
  })
  const narrowLog = await cdp.eval(
    inFrame(`const panel = w.document.querySelector('[data-testid="cockpit-log"]');
      const r = panel.getBoundingClientRect();
      return { width: Math.round(r.width), inView: r.left >= 0 && r.right <= w.innerWidth + 1, rows: panel.querySelectorAll('[data-session-row]').length }`),
  )
  expect(
    '窄屏日志面板不溢出（宽度受限、行仍在）',
    (narrowLog?.width ?? 9999) <= CONSOLE_NARROW.width && narrowLog?.inView === true && narrowLog?.rows >= 2,
    narrowLog,
  )
  await cdp.eval(inFrame(`w.__dshHub.cockpit.closeLog(); return true`))
  await cdp.shot('07-console-narrow')

  // ── 11.5 WP58 控制台主题（?embed=cockpit&theme=console，docs/26 §3/§5）──────
  //
  // 与管理台 AI 助手页配套的一整套：强制浅色、桌面控件、会话列表可常驻左栏、整体可缩放。
  // 这里故意把系统颜色方案切成深色，并在 localStorage 里留了「用户选深色」——
  // 断言仍然是浅色（docs/26 §3.1 的第一条验收）。
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await cdp.eval(
    inFrame(
      `w.localStorage.setItem('dsh-hub:ui:v1', JSON.stringify({ theme: 'dark' })); w.sessionStorage.clear(); return true`,
    ),
  )
  const consoleCode = await requestCode()
  // 先标记旧文档：loadApp 只是改 src，导航是异步的；只看 __dshHub 会命中**旧**文档（假绿）
  await cdp.eval(inFrame(`w.__wp58StaleDoc = 1; return true`))
  await cdp.eval(`window.loadApp(${JSON.stringify(consoleCode)}, 'console')`)
  await waitFor(
    cdp,
    inFrame(
      `return !w.__wp58StaleDoc && !!w.__dshHub && w.__dshHub.auth.phase === 'authenticated'`,
    ),
    { timeout: 25000, label: '控制台主题：认证成功' },
  )
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 25000,
    label: '控制台主题：通道连上',
  })
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.sessions.length >= 2`), {
    timeout: 20000,
    label: '控制台主题：会话列表',
  })
  await sleep(300)

  const consoleLook = await cdp.eval(
    inFrame(`const root = w.document.documentElement;
      const pick = (el) => (el ? w.getComputedStyle(el).backgroundColor : null);
      return {
        consoleClass: root.classList.contains('cockpit-console'),
        bridgeClass: root.classList.contains('cockpit-bridge'),
        dataTheme: root.dataset.theme,
        bgVar: w.getComputedStyle(root).getPropertyValue('--bg').trim(),
        bodyBg: pick(w.document.body),
        shellBg: pick(w.document.querySelector('.app-shell')),
        systemDark: w.matchMedia('(prefers-color-scheme: dark)').matches,
        userTheme: JSON.parse(w.localStorage.getItem('dsh-hub:ui:v1') || '{}').theme,
        consoleTheme: w.__dshHub.cockpit.consoleTheme,
        safeBottom: w.getComputedStyle(root).getPropertyValue('--safe-bottom').trim(),
      }`),
  )
  expect('控制台主题：html 上有 cockpit-console 类（没有 cockpit-bridge）', consoleLook?.consoleClass === true && consoleLook?.bridgeClass === false, consoleLook)
  expect('控制台主题：store 认出了 console', consoleLook?.consoleTheme === true, consoleLook?.consoleTheme)
  expect(
    '控制台主题强制浅色（系统深色 + 用户设了深色 → 仍 data-theme=light）',
    consoleLook?.dataTheme === 'light' && consoleLook?.systemDark === true && consoleLook?.userTheme === 'dark',
    { dataTheme: consoleLook?.dataTheme, systemDark: consoleLook?.systemDark, userTheme: consoleLook?.userTheme },
  )
  expect(
    '控制台主题背景透明（透出 Hub 卡片，不能有暖白底）',
    consoleLook?.bgVar === 'transparent' &&
      (consoleLook.bodyBg === 'rgba(0, 0, 0, 0)' || consoleLook.bodyBg === 'transparent') &&
      (consoleLook.shellBg === 'rgba(0, 0, 0, 0)' || consoleLook.shellBg === 'transparent'),
    { bgVar: consoleLook?.bgVar, bodyBg: consoleLook?.bodyBg, shellBg: consoleLook?.shellBg },
  )
  expect('控制台主题没有底部安全区留白（桌面窗口）', consoleLook?.safeBottom === '0px', consoleLook?.safeBottom)

  const controls = await cdp.eval(
    inFrame(`const d = w.document;
      const seg = d.querySelector('[data-testid="console-effort-seg"]');
      return {
        mic: d.querySelectorAll('.composer__mic').length,
        attach: !!d.querySelector('[data-testid="console-attach"]'),
        modelBtn: !!d.querySelector('[data-testid="console-model-btn"]'),
        modelBtnText: (d.querySelector('[data-testid="console-model-btn"]')?.textContent || '').trim(),
        effortSeg: !!seg,
        effortTiers: seg ? [...seg.querySelectorAll('[data-tier]')].map((b) => b.textContent.trim()) : [],
        placeholder: d.querySelector('.composer__input')?.placeholder ?? '',
        plus: d.querySelectorAll('.circle-btn').length,
        chip: d.querySelectorAll('.chip').length,
        installHint: d.querySelectorAll('.install-hint').length,
        updateBars: d.querySelectorAll('.web-update, .update-overlay').length,
      }`),
  )
  expect('控制台主题：没有麦克风（按住说话是手机交互）', controls?.mic === 0, controls?.mic)
  expect('控制台主题：回形针在、手机上的「+」不在', controls?.attach === true && controls?.plus === 0, controls)
  expect(
    '控制台主题：模型按钮显示短名（不是手机芯片）',
    controls?.modelBtn === true && controls?.chip === 0 && String(controls?.modelBtnText).includes('DeepSeek'),
    { modelBtnText: controls?.modelBtnText, chip: controls?.chip },
  )
  expect(
    '控制台主题：思考程度是分段控件「低|中|高|超高」',
    controls?.effortSeg === true &&
      JSON.stringify(controls?.effortTiers) === JSON.stringify(['低', '中', '高', '超高']),
    controls?.effortTiers,
  )
  expect(
    '控制台主题：占位文字带快捷键说明',
    String(controls?.placeholder).includes('Enter 发送') &&
      String(controls?.placeholder).includes('Shift+Enter'),
    controls?.placeholder,
  )
  expect(
    '控制台主题不出现安装提示 / 更新提示条',
    controls?.installHint === 0 && controls?.updateBars === 0,
    { installHint: controls?.installHint, updateBars: controls?.updateBars },
  )

  // 空态：标题 + 副标题 + 4 个示例（点了填进输入框，不发送）
  const emptyState = await cdp.eval(
    inFrame(`const d = w.document;
      const box = d.querySelector('[data-testid="console-empty"]');
      return {
        box: !!box,
        title: (box?.querySelector('.console-empty__title')?.textContent || '').trim(),
        sub: (box?.querySelector('.console-empty__sub')?.textContent || '').trim(),
        examples: [...d.querySelectorAll('[data-console-example]')].map((b) => b.textContent.trim()),
        greeting: d.body.innerText.includes('今天想聊点什么'),
        messages: (w.__dshHub.chat.state?.messages ?? []).length,
        activeId: w.__dshHub.chat.activeId,
        composer: d.querySelector('.composer__input')?.value ?? null,
      }`),
  )
  expect('控制台空态：标题「有什么要处理的？」+ 副标题', emptyState?.box === true && emptyState?.title === '有什么要处理的？' && emptyState?.sub === '说清楚要做什么，AI 出方案，你确认后执行', emptyState)
  expect('控制台空态：4 个示例按钮（不是手机上的问候语）', emptyState?.examples?.length === 4 && emptyState?.greeting === false, emptyState?.examples)
  await cdp.eval(inFrame(`w.document.querySelector('[data-console-example]').click(); return true`))
  await waitFor(
    cdp,
    inFrame(`return (w.document.querySelector('.composer__input')?.value || '').length > 0`),
    { label: '示例填进输入框' },
  )
  const filled = await cdp.eval(
    inFrame(`return {
      value: w.document.querySelector('.composer__input')?.value ?? '',
      messages: (w.__dshHub.chat.state?.messages ?? []).length,
      activeId: w.__dshHub.chat.activeId,
    }`),
  )
  expect(
    '控制台空态：点示例只填进输入框（不发消息、不建会话）',
    filled?.value === emptyState?.examples?.[0] &&
      filled?.messages === emptyState?.messages &&
      filled?.activeId === null,
    filled,
  )
  await cdp.eval(inFrame(`const el = w.document.querySelector('.composer__input'); el.value = ''; el.dispatchEvent(new w.Event('input', { bubbles: true })); return true`))

  // 模型下拉：锚定在按钮上方，键盘 ↑↓ / Enter / Esc
  await cdp.eval(inFrame(`w.document.querySelector('[data-testid="console-model-btn"]').click(); return true`))
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-testid="console-model-menu"]')`), {
    label: '模型下拉打开',
  })
  const menuInfo = await cdp.eval(
    inFrame(`const menu = w.document.querySelector('[data-testid="console-model-menu"]');
      const btn = w.document.querySelector('[data-testid="console-model-btn"]');
      const mr = menu.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      return {
        rows: menu.querySelectorAll('[data-model-row]').length,
        selected: menu.querySelectorAll('[data-model-row].is-selected').length,
        aboveButton: mr.bottom <= br.top + 1,
        inView: mr.left >= 0 && mr.right <= w.innerWidth + 1 && mr.top >= 0,
        search: !!menu.querySelector('.model-menu__input'),
        selectionKey: w.__dshHub.models.selection
          ? w.__dshHub.models.selection.provider + '/' + w.__dshHub.models.selection.model
          : null,
      }`),
  )
  expect('模型下拉：是真下拉（面板在按钮上方、在视口内）', menuInfo?.aboveButton === true && menuInfo?.inView === true, menuInfo)
  expect('模型下拉：列出模型且当前项打勾', (menuInfo?.rows ?? 0) >= 2 && menuInfo?.selected === 1, menuInfo)
  expect('模型下拉：模型不超过 8 个时不出搜索框', menuInfo?.search === false, menuInfo)

  // ↑↓ 换光标，Enter 选中（选中后菜单关闭、选择真的变了）
  await cdp.eval(
    inFrame(`const menu = w.document.querySelector('[data-testid="console-model-menu"]');
      menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      return true`),
  )
  const activeRow = await cdp.eval(
    inFrame(`const menu = w.document.querySelector('[data-testid="console-model-menu"]');
      return menu.querySelector('[data-model-row].is-active')?.getAttribute('data-model-key') ?? null`),
  )
  expect('模型下拉：↑↓ 能在行间移动', activeRow !== menuInfo?.selectionKey, { activeRow, before: menuInfo?.selectionKey })
  await cdp.eval(
    inFrame(`const menu = w.document.querySelector('[data-testid="console-model-menu"]');
      menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true`),
  )
  await waitFor(cdp, inFrame(`return !w.document.querySelector('[data-testid="console-model-menu"]')`), {
    label: 'Enter 选中后菜单关闭',
  })
  const afterPick = await cdp.eval(
    inFrame(`const s = w.__dshHub.models.selection;
      return {
        key: s ? s.provider + '/' + s.model : null,
        effort: s ? s.effortTier : null,
        label: (w.document.querySelector('[data-testid="console-model-btn"]')?.textContent || '').trim(),
      }`),
  )
  expect('模型下拉：Enter 真的换了模型（按钮文字跟着变）', afterPick?.key !== null && afterPick?.key !== menuInfo?.selectionKey, afterPick)
  await cdp.shot('10-console-model-menu')

  // Esc 关闭
  await cdp.eval(inFrame(`w.document.querySelector('[data-testid="console-model-btn"]').click(); return true`))
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-testid="console-model-menu"]')`), {
    label: '再开一次模型下拉',
  })
  await cdp.eval(
    inFrame(`const menu = w.document.querySelector('[data-testid="console-model-menu"]');
      menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true`),
  )
  await waitFor(cdp, inFrame(`return !w.document.querySelector('[data-testid="console-model-menu"]')`), {
    label: 'Esc 关闭模型下拉',
  })
  expect('模型下拉：Esc 关闭（不换模型）', true)

  // 思考分段：点一下就切（沿用 chat.pushModelSelection）
  const effortPick = await cdp.eval(
    inFrame(`const d = w.document;
      const btn = d.querySelector('[data-testid="console-effort-seg"] [data-tier="high"]');
      if (!btn) return { ok: false };
      const disabled = btn.disabled;
      if (!disabled) btn.click();
      return { ok: true, disabled, before: w.__dshHub.models.selection?.effortTier ?? null }`),
  )
  expect('思考分段：四档都在、当前档可点', effortPick?.ok === true, effortPick)
  await waitFor(cdp, inFrame(`return w.__dshHub.models.selection?.effortTier === 'high'`), {
    label: '思考分段切到「高」',
  })
  const effortState = await cdp.eval(
    inFrame(`const d = w.document;
      const seg = d.querySelector('[data-testid="console-effort-seg"]');
      const active = seg.querySelector('[data-tier].is-active');
      const disabled = [...seg.querySelectorAll('[data-tier]')].filter((b) => b.disabled);
      return {
        active: active?.getAttribute('data-tier') ?? null,
        pressed: active?.getAttribute('aria-pressed') ?? null,
        disabled: disabled.map((b) => ({ tier: b.getAttribute('data-tier'), title: b.getAttribute('title') })),
      }`),
  )
  expect(
    '思考分段：当前档高亮，不支持的档置灰并带悬停原因',
    effortState?.active === 'high' &&
      effortState?.pressed === 'true' &&
      Array.isArray(effortState?.disabled) &&
      effortState.disabled.every((item) => typeof item.title === 'string' && item.title.length > 0),
    effortState,
  )
  await cdp.shot('11-console-effort-seg')

  // 布局：cockpit.layout 的收缩放 + 会话列表形态（docs/26 §5）
  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 1.25, sessions: 'menu' })`)
  await waitFor(cdp, inFrame(`return w.document.documentElement.style.zoom === '1.25'`), {
    label: '缩放 1.25 应用到 <html>',
  })
  const scaled = await cdp.eval(
    inFrame(`return {
      zoom: w.document.documentElement.style.zoom,
      scale: w.__dshHub.cockpit.layoutScale,
      sessions: w.__dshHub.cockpit.layoutSessions,
      rail: !!w.document.querySelector('[data-testid="cockpit-session-rail"]'),
      logButtons: w.document.querySelectorAll('[data-testid="nav-log-button"]').length,
    }`),
  )
  expect(
    'cockpit.layout(1.25, menu)：写了 zoom、会话列表保持下拉',
    scaled?.zoom === '1.25' &&
      scaled?.scale === 1.25 &&
      scaled?.sessions === 'menu' &&
      scaled?.rail === false &&
      scaled?.logButtons === 1,
    scaled,
  )

  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 1.25, sessions: 'docked' })`)
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-testid="cockpit-session-rail"]')`), {
    label: '会话列表变常驻左栏',
  })
  const docked = await cdp.eval(
    inFrame(`const d = w.document;
      const rail = d.querySelector('[data-testid="cockpit-session-rail"]');
      const r = rail.getBoundingClientRect();
      return {
        // zoom 会让 getBoundingClientRect 返回放大后的值：这里读 inline 宽度（= 缩放前的 CSS px）
        width: Math.round(r.width),
        cssWidth: rail.style.width,
        rows: rail.querySelectorAll('[data-session-row]').length,
        hasNew: !!d.querySelector('[data-testid="cockpit-rail-new"]'),
        logButtons: d.querySelectorAll('[data-testid="nav-log-button"]').length,
        logs: d.querySelectorAll('[data-testid="cockpit-log"]').length,
        composerInView: (() => { const el = d.querySelector('.composer__card'); if (!el) return false; const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= w.innerWidth + 1; })(),
      }`),
  )
  expect(
    'cockpit.layout(1.25, docked)：会话列表常驻左栏（280px，缩放前）',
    docked?.cssWidth === '280px' && docked?.width === 350,
    docked,
  )
  expect(
    '常驻左栏里有会话行和「＋ 新会话」，顶部「航行日志」按钮收起',
    (docked?.rows ?? 0) >= 2 && docked?.hasNew === true && docked?.logButtons === 0 && docked?.logs === 0,
    docked,
  )
  expect('常驻左栏时内容列仍在视口内（zoom 不撑破）', docked?.composerInView === true, docked)
  await cdp.shot('12-console-docked')

  // 常驻左栏里的悬停「⋯」：重命名 / 删除（替代长按）
  await cdp.eval(
    inFrame(`const row = w.document.querySelector('[data-testid="cockpit-session-rail"] [data-session-row]');
      row.querySelector('[data-session-more]').click();
      return true`),
  )
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('[data-session-action="rename"]')`), {
    label: '会话行「⋯」菜单',
  })
  const moreMenu = await cdp.eval(
    inFrame(`const items = [...w.document.querySelectorAll('[data-session-action]')];
      return { items: items.map((b) => b.textContent.trim()), enabled: items.map((b) => !b.disabled) }`),
  )
  expect(
    '会话行悬停「⋯」：重命名 / 删除两项都可用',
    JSON.stringify(moreMenu?.items) === JSON.stringify(['重命名', '删除']) && moreMenu?.enabled?.every(Boolean) === true,
    moreMenu,
  )
  await cdp.eval(inFrame(`w.document.querySelector('[data-session-action="rename"]').click(); return true`))
  await waitFor(cdp, inFrame(`return !!w.document.querySelector('.session-row__input')`), {
    label: '行内重命名输入框',
  })
  await cdp.eval(
    inFrame(`const input = w.document.querySelector('.session-row__input');
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true`),
  )
  await waitFor(cdp, inFrame(`return !w.document.querySelector('.session-row__input')`), {
    label: 'Esc 取消重命名',
  })
  expect('会话行「⋯」：重命名是行内输入框（Esc 取消）', true)
  await cdp.shot('13-console-session-more')

  // 越界夹取：scale 9 → 1.5；scale 1 → 删掉 zoom
  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 9, sessions: 'docked' })`)
  await waitFor(cdp, inFrame(`return w.document.documentElement.style.zoom === '1.5'`), {
    label: 'scale 9 夹到 1.5',
  })
  expect('cockpit.layout：越界的 scale 夹到 1.5', true)
  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 1, sessions: 'docked' })`)
  await waitFor(cdp, inFrame(`return !w.document.documentElement.style.zoom`), {
    label: 'scale 1 删掉 zoom',
  })
  const reset = await cdp.eval(
    inFrame(`const rail = w.document.querySelector('[data-testid="cockpit-session-rail"]');
      return { zoom: w.document.documentElement.style.zoom || null, railWidth: Math.round(rail.getBoundingClientRect().width) }`),
  )
  expect('cockpit.layout：scale=1 时 zoom 被删掉、左栏回到 248', reset?.zoom === null && reset?.railWidth === 248, reset)
  // 形状不合法的父消息整条丢掉（不缩放、不换形态）
  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 1.25 })`)
  await sleep(120)
  const badLayout = await cdp.eval(
    inFrame(`return { zoom: w.document.documentElement.style.zoom || null, scale: w.__dshHub.cockpit.layoutScale }`),
  )
  expect('cockpit.layout：缺 sessions 的消息被丢弃（不生效）', badLayout?.zoom === null && badLayout?.scale === 1, badLayout)

  // 协议：ready 的 caps + status 的阶段顺序
  const readyCaps = await cdp.eval(`window.lastOfType('cockpit.ready')`)
  expect(
    'cockpit.ready 带 caps：[status, layout, console]（仅 theme=console）',
    JSON.stringify(readyCaps?.caps) === JSON.stringify(['status', 'layout', 'console']),
    readyCaps,
  )
  const statusPhases = await cdp.eval(
    `window.received.filter((m) => m && m.type === 'cockpit.status').map((m) => m.phase)`,
  )
  const order = ['auth', 'waking', 'connecting', 'ready', 'offline', 'blocked']
  const monotonic = statusPhases.every(
    (phase, index) => index === 0 || order.indexOf(phase) >= order.indexOf(statusPhases[index - 1]),
  )
  const noDup = statusPhases.every((phase, index) => index === 0 || phase !== statusPhases[index - 1])
  expect(
    'cockpit.status：冷启动按 auth → … → ready 的顺序发（无重复 phase）',
    statusPhases.length >= 2 &&
      statusPhases[0] === 'auth' &&
      statusPhases[statusPhases.length - 1] === 'ready' &&
      monotonic &&
      noDup,
    statusPhases,
  )
  const statusPayload = await cdp.eval(
    `window.received.filter((m) => m && m.type === 'cockpit.status').map((m) => m.message || '')`,
  )
  expect(
    'cockpit.status：每条都带一句中文说明（不含令牌）',
    Array.isArray(statusPayload) && statusPayload.every((text) => typeof text === 'string' && text.length > 0),
    statusPayload,
  )

  // 控制台主题的过程行（docs/26，10-30 用户反馈）：没有两舷，投放 / 方案都说「右侧」
  await cdp.eval(`window.sendToApp({ type: 'cockpit.focus-session', sessionId: 's_mock_cockpit' })`)
  await waitFor(
    cdp,
    inFrame(`return w.__dshHub.chat.activeId === 's_mock_cockpit' && w.document.querySelectorAll('[data-testid="process-canvas"]').length >= 1 && w.document.querySelector('[data-testid="process-proposal"]') !== null`),
    { timeout: 15000, label: '控制台主题：历史会话的投放/方案行' },
  )
  const consoleActions = await cdp.eval(
    inFrame(`return [...w.document.querySelectorAll('.process__action-text')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())`),
  )
  expect(
    '控制台主题：过程行说「已放到右侧」「待确认（右侧）」，不出现「舷」',
    Array.isArray(consoleActions) &&
      consoleActions.some((text) => text === '⟶ 已放到右侧：近 7 天积分消耗') &&
      consoleActions.some((text) => text === '⟶ 方案 #12 · 待确认（右侧）') &&
      consoleActions.every((text) => !text.includes('舷')),
    consoleActions,
  )

  // 不传 theme（老父页面 / 老 App 的 URL）：不带 caps、不进控制台主题、不缩放
  await requestCode()
  await cdp.eval(inFrame(`w.__wp58StaleDoc = 1; return true`))
  await cdp.eval(`window.loadApp('', '')`)
  await waitFor(
    cdp,
    inFrame(
      `return !w.__wp58StaleDoc && !!w.__dshHub && w.__dshHub.auth.phase === 'authenticated'`,
    ),
    { timeout: 25000, label: '不传 theme：认证' },
  )
  await waitFor(cdp, inFrame(`return w.__dshHub.chat.link === 'connected'`), {
    timeout: 25000,
    label: '不传 theme：通道',
  })
  const legacy = await cdp.eval(
    inFrame(`const root = w.document.documentElement;
      return {
        consoleClass: root.classList.contains('cockpit-console'),
        bridgeClass: root.classList.contains('cockpit-bridge'),
        consoleTheme: w.__dshHub.cockpit.consoleTheme,
        zoom: root.style.zoom || null,
        dpr: w.devicePixelRatio,
      }`),
  )
  expect(
    '不传 theme：两个主题都不进、不缩放（老父页面的行为）',
    legacy?.consoleClass === false &&
      legacy?.bridgeClass === false &&
      legacy?.consoleTheme === false &&
      legacy?.zoom === null,
    legacy,
  )
  const legacyReady = await cdp.eval(`window.lastOfType('cockpit.ready')`)
  expect(
    '不传 theme：cockpit.ready 不带 caps（老形状一字不改）',
    legacyReady !== null && legacyReady.caps === undefined,
    legacyReady,
  )
  // 清一次收到的消息再静置：切文档时上一个（控制台）页面可能刚好又发了一条，
  // 那是上一个文档的尾巴，不是这一页的行为。
  await cdp.eval(`(() => { window.received = []; return true })()`)
  await sleep(500)
  const legacyStatus = await cdp.eval(
    `window.received.filter((m) => m && m.type === 'cockpit.status').length`,
  )
  expect('不传 theme：不发 cockpit.status', legacyStatus === 0, legacyStatus)

  // 收尾：把主题与缩放复原，后面的「普通 /m/」一节仍按浅色跑
  await cdp.eval(`window.sendToApp({ type: 'cockpit.layout', scale: 1, sessions: 'menu' })`)
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })

  // ── 12. 普通 /m/ 不受影响（座舱令牌不会漏成普通登录）──────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: CONSOLE_WIDE.width,
    height: CONSOLE_WIDE.height,
    deviceScaleFactor: CONSOLE_WIDE.dpr,
    mobile: false,
  })
  await cdp.send('Page.navigate', { url: `${HUB_URL}/m/` })
  await waitFor(cdp, `document.querySelector('.login')`, { timeout: 20000, label: '普通 /m/ 登录页' })
  const plain = await cdp.eval(`(() => ({
    login: !!document.querySelector('.login'),
    bridgeClass: document.documentElement.classList.contains('cockpit-bridge'),
    sessionTokens: Object.keys(sessionStorage).sort(),
    localToken: localStorage.getItem('dshm.web.auth-v1') !== null,
  }))()`)
  expect(
    '普通 /m/ 打开仍是登录页（同一个标签页的 sessionStorage 座舱令牌不参与）',
    plain.login === true && plain.localToken === false,
    plain,
  )
  expect('普通 /m/ 不会被舰桥主题影响', plain.bridgeClass === false, plain.bridgeClass)

  // ── 13. 收尾：没有控制台 error ───────────────────────────────────────────
  expect('无控制台 error', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const report = {
    app: PARENT_URL,
    hub: HUB_URL,
    viewport: CONSOLE_WIDE,
    checks,
    failed: checks.filter((c) => !c.ok),
    consoleErrors,
    cockpit: await cockpitState(),
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${checks.length - report.failed.length}/${checks.length} 通过（report.json 在 ${OUT}）`)
  await stopServers()
  cdp.ws.close()
  process.exit(report.failed.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  try {
    cdpRef?.ws.close()
  } catch {
    /* ignore */
  }
  await stopServers().catch(() => {})
  process.exit(1)
})
