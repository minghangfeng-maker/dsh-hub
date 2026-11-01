#!/usr/bin/env node
/**
 * 手机网页版 e2e（WP54 / `web-smoke`）：**同源**跑一遍真实链路。
 *
 * 与其它 e2e 的区别：别的脚本都是「vite dev server + 跨源 mock hub」，网页版的生产形态是
 * **Hub 同源托管在 `/m/`**（契约 C2/C4），所以这里：
 *   1. 先跑 `scripts/build-web.sh` 产出 `packages/mobile-ui/dist-web`（`VITE_TARGET=web`，不带
 *      `VITE_HUB_ORIGIN`）—— 正式产物的构建方式，不是 dev server；
 *   2. 把产物拷一份到临时目录（测试要改 `version.json`，不能弄脏仓库的构建产物）；
 *   3. 让 mock hub 用 `--web-dist` 在 `/m/` 下托管它（缓存头按契约 C6）；
 *   4. Chrome 直接打开 `http://127.0.0.1:<hub>/m/`（412×915 / DPR 2.625 / 手机 UA）。
 *
 * 断言（契约条目在括号里）：
 *   - 入口 = 页面 origin，单入口（C4）；登录页可用；
 *   - 登录 → 首页（C11：`platform=web`、`deviceName=手机网页版 · Chrome · Android`）；
 *   - 令牌在 localStorage 且键名带 `dshm.web.` 前缀（C10）；
 *   - 打开会话 → 发一句 → 收到流式回复；
 *   - 刷新页面仍是已登录状态（令牌恢复，不是重新登录）；
 *   - 改 `version.json` 后切前台（visibilitychange）→ `webUpdateAvailable` 变 true（C7）。
 *
 * 用法（一般交给运行器）：
 *   bash scripts/e2e-run.sh web-smoke
 *
 * 手工：
 *   node scripts/e2e-web-smoke.mjs --hub-port 5261 --cdp 9291 --out .e2e-runs/web-smoke
 *   node scripts/e2e-web-smoke.mjs --no-spawn --hub http://127.0.0.1:5261 --cdp 9291 --out /tmp/x
 *   node scripts/e2e-web-smoke.mjs --skip-build          # 复用已有 dist-web（调试时省时间）
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
const SPAWN = !process.argv.includes('--no-spawn')
const SKIP_BUILD = process.argv.includes('--skip-build')
const HUB_PORT = Number(args['hub-port'] ?? 5261)
const CDP_PORT = Number(args.cdp ?? 9291)
const HUB_URL = (args.hub ?? `http://127.0.0.1:${HUB_PORT}`).replace(/\/+$/, '')
/** 网页版页面地址：**Hub 自己的 `/m/`**（同源，不是 vite）。 */
const APP_URL = args.app ?? `${HUB_URL}/m/`
const OUT = path.resolve(args.out ?? 'e2e-web-smoke-output')
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
// 重型构建锁：默认不锁；需要串行时用 HEAVY_BUILD_LOCK=<文件> 指定
const LOCK = process.env.HEAVY_BUILD_LOCK ?? ''
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

/** 手机 Chrome / Android 的 UA：deviceName 断言依赖它（C11）。 */
const UA_ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const EXPECTED_DEVICE_NAME = '手机网页版 · Chrome · Android'

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
  async eval(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
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

function pipeStdout(tag, child, logFile) {
  const chunks = []
  child.stdout?.on('data', (buf) => chunks.push(buf))
  child.stderr?.on('data', (buf) => chunks.push(buf))
  child.on('close', () => {
    if (logFile) fs.writeFile(logFile, Buffer.concat(chunks)).catch(() => {})
  })
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
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (buf) => (output += buf.toString()))
  child.stderr.on('data', (buf) => (output += buf.toString()))
  const code = await new Promise((resolve) => child.on('close', resolve))
  await fs.writeFile(path.join(OUT, 'build-web.log'), output)
  if (code !== 0) {
    console.error(output.slice(-4000))
    throw new Error(`build-web.sh 失败（exit ${code}）`)
  }
  // 只打印关键两行，别把 vite 的整份产物清单刷进 e2e 日志
  for (const line of output.split('\n')) {
    if (/version\.json|通过|网页版产物|失败/.test(line)) console.log(`  ${line}`)
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
  // 拷一份再托管：测试会改 version.json（C7），不能弄脏仓库里的构建产物
  servedDir = await fs.mkdtemp(path.join(OUT, `served-`))
  await fs.cp(dist, servedDir, { recursive: true })
  console.log(`[e2e] 托管目录：${servedDir}`)

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
  pipeStdout('hub', hub, path.join(OUT, 'hub.log'))
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })

  profileDir = await fs.mkdtemp(path.join(OUT, `chrome-profile-`))
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
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  children.push(chrome)
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
}

/** 按 PID 关掉自己起的进程（不用 pkill/pgrep），再清掉临时 profile 与托管副本。 */
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

/** 读 mock hub 记下的最近一次登录请求（platform/deviceName/installId）。 */
async function lastLogin() {
  const res = await fetch(`${HUB_URL}/__test/last-login`, { signal: AbortSignal.timeout(5_000) })
  const body = await res.json()
  return body.lastLogin
}

async function readServedVersion() {
  return JSON.parse(await fs.readFile(path.join(servedDir, 'version.json'), 'utf8'))
}

async function writeServedVersion(info) {
  await fs.writeFile(path.join(servedDir, 'version.json'), `${JSON.stringify(info)}\n`)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  await startServers()
  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  // 亮色 + 手机视口 + 手机 UA（UA 决定 deviceName，C11）
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
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: UA_ANDROID_CHROME,
    platform: 'Android',
    acceptLanguage: 'zh-CN,zh;q=0.9',
  })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })
  /** version.json 被拉了几次（C7 的轮询证据）。 */
  let versionRequests = 0
  cdp.listeners.set('Network.requestWillBeSent', new Set())
  cdp.listeners.get('Network.requestWillBeSent').add((p) => {
    if (p.request?.url?.includes('version.json')) versionRequests += 1
  })

  // ---- 0. 打开 /m/（同源）：未登录 → 登录页
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(200)
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor(cdp, `document.querySelector('.login')`, { timeout: 30000, label: '登录页' })
  await cdp.shot('01-login')

  // ---- 1. 入口（C4）：单入口 = 页面自己的 origin，不是生产双入口
  const entry = await cdp.eval(`(() => ({
    href: location.href,
    pageOrigin: location.origin,
    hubOrigin: window.__dshHub?.auth.origin ?? null,
    origins: [...(window.__dshHub?.hubOrigin?.origins ?? [])],
    base: document.baseURI,
  }))()`)
  expect(`页面就在 Hub 同源的 /m/（${APP_URL}）`, entry.pageOrigin === HUB_URL, entry.pageOrigin)
  expect('入口 = 页面 origin（C4：不用生产/多入口列表）', entry.hubOrigin === HUB_URL, entry.hubOrigin)
  expect('只有一个候选入口（C4：单入口，不做切换）', entry.origins.length === 1, entry.origins)

  // ---- 2. 登录（C11：platform=web、deviceName=手机网页版 · Chrome · Android）
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    timeout: 30000,
    label: '登录成功',
  })
  await waitFor(cdp, `document.querySelector('.home-view')`, { timeout: 20000, label: '首页' })
  await cdp.shot('02-home')

  const login = await lastLogin()
  expect('登录请求 platform=web（C11）', login?.platform === 'web', login?.platform ?? null)
  expect(
    `登录请求 deviceName=${EXPECTED_DEVICE_NAME}（C11）`,
    login?.deviceName === EXPECTED_DEVICE_NAME,
    login?.deviceName ?? null,
  )
  expect(
    '登录请求带 installId（8..64，字母数字_-；C11）',
    typeof login?.installId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(login.installId),
    login?.installId ?? null,
  )

  // ---- 3. 令牌落 localStorage（C10：dshm.web. 前缀；APK 的 Keystore 路径在网页版不存在）
  const storage = await cdp.eval(`(() => {
    const keys = Object.keys(localStorage)
    return {
      keys,
      hasToken: keys.includes('dshm.web.auth-v1'),
      hasInstall: keys.includes('dshm.web.install-id'),
      leakedPlain: keys.some((k) => k === 'dsh_hub_auth_v1'),
    }
  })()`)
  expect('令牌在 localStorage 且键名带 dshm.web. 前缀（C10）', storage.hasToken === true, storage.keys)
  expect('installId 在 localStorage（dshm.web. 前缀）', storage.hasInstall === true, storage.keys)
  expect('没有把令牌写进 APK 的 SecureStorage 键名', storage.leakedPlain === false)

  // ---- 4. 打开会话 → 发一句 → 收到流式回复
  // 会话列表要等通道连上（bootstrap → 唤醒 → WS），不是登录完就有
  await waitFor(cdp, `(window.__dshHub?.chat?.sessions?.length ?? 0) >= 1`, {
    timeout: 40000,
    label: '会话列表',
  })
  const sessionId = await cdp.eval(
    `window.__dshHub?.chat?.sessions?.[0]?.sessionId ?? null`,
  )
  expect('首页拿到了会话列表', typeof sessionId === 'string', sessionId)
  await cdp.eval(`(() => { location.hash = '#/c/' + ${JSON.stringify(sessionId)} })()`)
  await waitFor(cdp, `!!document.querySelector('.thread')`, { timeout: 20000, label: '对话页' })
  const REPLY = await (await fetch(`${HUB_URL}/__test/script`)).json()
  const text = '网页版同源联调：这是一条测试消息'
  // 流式采样器：每帧记一次「这一轮长到多长了」，用来证明是**增量**推送而不是一次性贴上去。
  // （不能只看流式开始那一刻的正文长度：v2 回合先出思考/工具块，正文晚一点才开始。）
  await cdp.eval(`(() => {
    window.__webSmoke = { samples: [], on: true }
    const loop = () => {
      const c = window.__dshHub?.chat
      const r = window.__webSmoke
      if (!c || !r || !r.on) return
      r.samples.push({
        streaming: c.streamingText.length,
        reasoning: c.streamingReasoning.length,
        tools: c.toolCards.length,
        isStreaming: c.isStreaming === true,
      })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    return true
  })()`)
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
  await waitFor(cdp, `window.__dshHub?.chat?.isStreaming === true`, {
    timeout: 20000,
    label: '开始流式',
  })
  await cdp.shot('03-streaming')
  await waitFor(
    cdp,
    `window.__dshHub.chat.isStreaming === false && window.__dshHub.chat.displayMessages.some((m) => m.role === 'assistant' && (m.text ?? '').length > 20)`,
    { timeout: 40000, label: '流式结束且收到正文' },
  )
  const lastAssistant = await cdp.eval(`(() => {
    const list = window.__dshHub.chat.displayMessages.filter((m) => m.role === 'assistant')
    const last = list[list.length - 1]
    return { text: last?.text ?? '', count: list.length }
  })()`)
  const streamProof = await cdp.eval(`(() => {
    const r = window.__webSmoke
    if (!r) return null
    r.on = false
    const samples = r.samples
    const totals = samples.map((s) => s.streaming + s.reasoning + s.tools)
    const growth = new Set(totals).size
    return {
      samples: samples.length,
      streamingSeen: samples.some((s) => s.isStreaming),
      growthSteps: growth,
      maxBody: Math.max(0, ...samples.map((s) => s.streaming)),
    }
  })()`)
  expect('收到完整的流式回复（与 mock hub 的正文一致）', lastAssistant.text.includes(REPLY.reply.slice(0, 12)), lastAssistant.text.length)
  expect(
    '回复是流式增量到达的（同一轮里内容涨了多步，不是一次性贴上去）',
    streamProof !== null && streamProof.streamingSeen === true && streamProof.growthSteps >= 3,
    streamProof,
  )
  await cdp.shot('04-reply')

  // ---- 5. 刷新页面：仍是已登录（localStorage 令牌恢复，C10）
  await cdp.send('Page.reload')
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    timeout: 30000,
    label: '刷新后仍登录',
  })
  const afterReload = await cdp.eval(`(() => ({
    phase: window.__dshHub.auth.phase,
    username: window.__dshHub.auth.user?.username ?? null,
    hash: location.hash,
    loginVisible: !!document.querySelector('.login'),
  }))()`)
  expect(
    '刷新后仍是已登录状态（令牌从 localStorage 恢复）',
    afterReload.phase === 'authenticated' && afterReload.username === 'demo',
    afterReload,
  )
  expect('刷新后没有回到登录页', afterReload.loginVisible === false, afterReload.hash)
  await cdp.shot('05-after-reload')

  // ---- 6. 托管语义（C6，与 Hub WP54b 对齐）：带扩展名缺失 → 404；无扩展名 → index.html
  const webIndex = await fetch(`${APP_URL}version.json`, { cache: 'no-store' })
  expect(
    '/m/version.json 是 no-store 的 JSON（C6/C7）',
    webIndex.status === 200 &&
      /no-store/.test(webIndex.headers.get('cache-control') ?? '') &&
      /json/.test(webIndex.headers.get('content-type') ?? ''),
    {
      status: webIndex.status,
      cache: webIndex.headers.get('cache-control'),
      type: webIndex.headers.get('content-type'),
    },
  )
  const missingAsset = await fetch(`${APP_URL}assets/nope-000000.js`)
  expect(
    '带扩展名但缺失的资源 → 404（不会拿 index.html 冒充，C6）',
    missingAsset.status === 404 &&
      !/text\/html/.test(missingAsset.headers.get('content-type') ?? ''),
    { status: missingAsset.status, type: missingAsset.headers.get('content-type') },
  )
  const spaFallback = await fetch(`${APP_URL}some-route`)
  expect(
    '不带扩展名的路径 → 兜底 index.html 且 no-store（C6）',
    spaFallback.status === 200 &&
      /text\/html/.test(spaFallback.headers.get('content-type') ?? '') &&
      /no-store/.test(spaFallback.headers.get('cache-control') ?? ''),
    {
      status: spaFallback.status,
      cache: spaFallback.headers.get('cache-control'),
      type: spaFallback.headers.get('content-type'),
    },
  )

  // ---- 7. 版本检查（C7）：改 version.json → 切前台 → webUpdateAvailable
  const builtIn = await cdp.eval(
    `window.__dshHubAppUpdate ? { available: window.__dshHubAppUpdate.webUpdateAvailable, watching: window.__dshHubAppUpdate.watching, canReload: typeof window.__dshHubAppUpdate.reloadToUpdate === 'function' } : null`,
  )
  expect('网页版挂上了版本观察（W4 的 reloadToUpdate 存在）', builtIn?.watching === true && builtIn?.canReload === true, builtIn)
  expect('启动时 version.json 与内置一致 → 不提示更新（无假阳性）', builtIn?.available === false, builtIn)
  expect('启动时已经拉过 ./version.json（C7）', versionRequests >= 1, versionRequests)

  /**
   * 模拟「切后台再回前台」：dispatch visibilitychange（页面本来就是 visible）。
   * 客户端有 3 秒最小间隔，所以循环触发，最多等 `timeoutMs`。
   */
  const foreground = async (timeoutMs = 20000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      await cdp.eval(`(() => {
        try { document.dispatchEvent(new Event('visibilitychange')) } catch {}
        return true
      })()`)
      if (await cdp.eval(`window.__dshHubAppUpdate?.webUpdateAvailable === true`)) return true
      await sleep(1000)
    }
    return false
  }

  // ---- 7a. 反例：version.json 404（Hub 未部署 / 部署中间态）→ 静默跳过，不提示更新
  await fs.rename(path.join(servedDir, 'version.json'), path.join(servedDir, 'version.json.bak'))
  const requestsBefore404 = versionRequests
  const updateOn404 = await foreground(8000)
  expect('version.json 404 时静默跳过、不提示更新（C7）', updateOn404 === false)
  expect(
    '404 时客户端确实重新拉了一次（下个周期会再试）',
    versionRequests > requestsBefore404,
    { before: requestsBefore404, after: versionRequests },
  )
  const noErrorBar = await cdp.eval(`!!document.querySelector('.error-bar')`)
  expect('404 没有弹错误条（静默）', noErrorBar === false)

  // ---- 7b. 正例：线上换成新构建 → 切前台出现 webUpdateAvailable
  await fs.rename(path.join(servedDir, 'version.json.bak'), path.join(servedDir, 'version.json'))
  const served = await readServedVersion()
  await writeServedVersion({
    version: '9.9.9',
    build: 'e2eupd',
    builtAt: new Date().toISOString(),
  })
  console.log(`  · 已改 version.json：${served.version}/${served.build} → 9.9.9/e2eupd`)
  const beforeRequests = versionRequests
  const updateSeen = await foreground(20000)
  expect('改 version.json 后切前台出现 webUpdateAvailable（C7）', updateSeen === true)
  expect(
    '切前台确实重新拉了一次 version.json（no-store）',
    versionRequests > beforeRequests,
    { before: beforeRequests, after: versionRequests },
  )
  const diagnostics = await cdp.eval(
    `(() => (window.__dshHub?.ui?.diagnostics ?? []).map((e) => e.name + '=' + e.detail).filter((s) => s.startsWith('web:version')).slice(-3))()`,
  )
  console.log(`  · 诊断：${JSON.stringify(diagnostics)}`)
  await cdp.shot('06-web-update')

  // 收尾：截图之外再记一份报告，方便排查
  const report = {
    generatedAt: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    checks,
    consoleErrors: consoleErrors.filter((line) => !/favicon/.test(line)),
  }
  await fs.writeFile(path.join(OUT, 'web-smoke.json'), JSON.stringify(report, null, 2))

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) console.error('失败项：', failed.map((c) => c.name))
  cdp.ws.close()
  return failed.length
}

main()
  .then((failed) => {
    process.exitCode = failed > 0 ? 1 : 0
  })
  .catch((error) => {
    console.error('e2e 失败：', error)
    process.exitCode = 1
  })
  .finally(stopServers)
