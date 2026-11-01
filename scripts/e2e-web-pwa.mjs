#!/usr/bin/env node
/**
 * W5「手机网页版：PWA 与安装体验」探针。
 *
 * 覆盖三件事：
 *   1. 可安装性 —— 不猜文档，直接问 Chrome：`Page.getAppManifest`（浏览器真正解析出来的
 *      manifest + 解析错误）、`Page.getInstallabilityErrors`（它认为「还不能装」的原因），
 *      再把每个图标真的下载一遍、对一遍 PNG 尺寸。为了证明这两条断言不是永远返回空，
 *      最后拿一个**没有 manifest** 的页面回一次，必须报错（见「断言有效性」一节）。
 *   2. 首页「添加到桌面」引导 —— Android Chrome（含 beforeinstallprompt → 按钮 → prompt()
 *      被调用）、iOS Safari（图文说明）、微信内置浏览器（换浏览器）、桌面（不出现）；
 *      关掉后刷新不再出现、清掉记录后又出现；模拟 standalone（`Emulation.setEmulatedMedia`
 *      的 display-mode）时不出现。
 *   3. APK 不回归 —— 再跑一次**不带 VITE_TARGET** 的 `vite build`，产物里要么没有引导文案，
 *      要么只剩不可达的死代码（`IS_WEB_BUILD` 是构建期常量 false）：把这份产物用临时静态
 *      服务器发出去、真的登录进首页，确认 `.install-hint` 从不出现。
 *
 * 前置：由 `scripts/e2e-run.sh web-pwa` 拉起 —— 它起 mock Hub + `vite` dev（带
 * `VITE_TARGET=web`）+ 带 CDP 端口的 Chrome，并把 `--app --hub --cdp --out` 传进来。
 * 单独跑也可以：node scripts/e2e-web-pwa.mjs --app http://127.0.0.1:5242 --hub http://127.0.0.1:5245 --cdp 9241 --out /tmp/pwa
 */

import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import http from 'node:http'
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

const CDP_PORT = Number(args.cdp ?? 9241)
const APP_URL = args.app ?? 'http://127.0.0.1:5242'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5245'
const OUT = args.out ?? 'e2e-web-pwa-output'
const VIEWPORT = { width: 390, height: 844, dpr: 3 }

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = path.join(REPO, 'packages', 'ui')
const VITE_BIN = path.join(UI_DIR, 'node_modules', '.bin', 'vite')
const APK_DIST = path.join(UI_DIR, '.e2e-dist-apk')
const WEB_DIST = path.join(UI_DIR, '.e2e-dist-web')
const HINT_KEY = 'dsh-hub:install-hint:v1'

/**
 * Hub `/m/` 下发的 CSP —— 与 WP54b（`apps/api/src/server/static.ts`）的
 * `MOBILE_WEB_CONTENT_SECURITY_POLICY` **逐字一致**。改那边时这里要跟着改。
 */
const MOBILE_WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ')

/**
 * CSP 探针：文档一起手就挂上（早于页面里的任何脚本）。
 *  - 记 CSP 违规（securitypolicyviolation）；
 *  - 记 `data-theme` 的第一次赋值 —— 如果 theme-boot 是解析期执行的，这一次赋值的
 *    `readyState` 会是 'loading'（还没轮到 defer 的 module 脚本）；
 *  - 记首帧（第一个 rAF）时的主题与背景色。
 */
const CSP_PROBE = `(() => {
  window.__csp = { violations: [], themeTimeline: [], firstFrame: null }
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__csp.violations.push({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      sample: (event.sample ?? '').slice(0, 60),
      source: (event.sourceFile ?? '').replace(location.origin, ''),
      line: event.lineNumber,
      column: event.columnNumber,
      at: Math.round(performance.now()),
    })
  })
  const watchTheme = () => {
    const html = document.documentElement
    if (!html) {
      setTimeout(watchTheme, 0)
      return
    }
    new MutationObserver(() => {
      window.__csp.themeTimeline.push({
        theme: html.dataset.theme ?? null,
        readyState: document.readyState,
        bg: html.style.background || getComputedStyle(html).backgroundColor,
      })
    }).observe(html, { attributes: true, attributeFilter: ['data-theme'] })
  }
  watchTheme()
  const capture = () => {
    if (!window.__csp.firstFrame) {
      const html = document.documentElement
      window.__csp.firstFrame = {
        theme: html?.dataset.theme ?? null,
        bg: html ? getComputedStyle(html).backgroundColor : null,
      }
    }
  }
  requestAnimationFrame(capture)
})()`

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  wechat:
    'Mozilla/5.0 (Linux; Android 13; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x2800313D) WeChat/arm64',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      throw new Error(`eval 失败: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result?.value
  }
  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(OUT, `${name}.png`)
    await fs.writeFile(file, Buffer.from(res.data, 'base64'))
    return file
  }
}

const checks = []

/** 只记录、不计入通过数（例如构建产物的现状说明）。 */
function note(text) {
  console.log(`· ${text}`)
}

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

/** 清掉「关过」记录与主题偏好（换 UA / 重跑场景前用）。 */
async function resetPageState(cdp) {
  await cdp.eval(`(() => {
    try {
      localStorage.removeItem(${JSON.stringify(HINT_KEY)})
      localStorage.removeItem('dsh-hub:ui:v1')
    } catch {}
    return true
  })()`)
}

async function login(cdp) {
  // W1 起网页版令牌持久在 localStorage：刷新后可能直接回到首页，已登录就不用再填表
  await waitFor(cdp, `document.querySelector('.login') || document.querySelector('.home-view')`, {
    label: '登录页或首页',
  })
  if (await cdp.eval(`!!document.querySelector('.home-view')`)) return
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo'); set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  // 只看 DOM：正式构建（NODE_ENV=production）里没有 window.__dshHub 这个调试出口
  await waitFor(cdp, `document.querySelector('.home-view')`, { label: '登录后进首页' })
}

/** 首页引导的现场（文案 / 目标 / 有没有按钮 / 本地「关过」记录）。 */
async function hintState(cdp) {
  return cdp.eval(`(() => {
    const el = document.querySelector('.install-hint')
    const state = {
      present: !!el,
      target: el?.dataset.target ?? null,
      title: el?.querySelector('.install-hint__title')?.innerText.trim() ?? '',
      text: el?.querySelector('.install-hint__text')?.innerText.trim() ?? '',
      action: el?.querySelector('.install-hint__install')?.innerText.trim() ?? null,
      hasClose: !!el?.querySelector('.install-hint__close'),
      glyphIsSvg: !!el?.querySelector('.install-hint__glyph svg'),
      // 卡片收起来之后也要能核「关过」这件事
      dismissedAt: (() => {
        try {
          const raw = JSON.parse(localStorage.getItem(${JSON.stringify(HINT_KEY)}) || 'null')
          return typeof raw?.at === 'number' ? raw.at : null
        } catch { return 'bad' }
      })(),
      now: Date.now(),
    }
    return state
  })()`)
}

/** 硬刷新；令牌已持久化时直接回首页，否则重新登录。 */
async function reloadAndLogin(cdp) {
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(400)
  await login(cdp)
  // 首页挂载 → InstallHint 挂载 → 读偏好 → 决定显不显示：给它一拍
  await sleep(350)
}

/** 换 UA 再进（`Emulation.setUserAgentOverride` 只影响之后的导航）。 */
async function withUserAgent(cdp, userAgent) {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent, platform: 'Linux armv8l' })
  await reloadAndLogin(cdp)
}

// ── 临时静态服务器（把 APK 构建产物发出去，真跑一遍）─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

async function serveDir(root, extraHeaders = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const file = path.join(root, path.normalize(rel))
      if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (url.pathname === '/no-manifest.html') {
        // 「断言有效性」用的空白页：没有 manifest，Chrome 必须报不可安装
        res.writeHead(200, { 'content-type': MIME['.html'] })
        res.end('<!doctype html><title>no manifest</title><h1>no manifest</h1>')
        return
      }
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        ...extraHeaders,
      })
      createReadStream(file).pipe(res)
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

/**
 * 跑一次 `vite build`：`target: 'web'` 带 VITE_TARGET=web（网页版产物），
 * 不带就是 APK 那一条路径。都和 build-apk.sh 一样摘代理、共用重型构建锁。
 */
async function viteBuild({ outDir, target }) {
  // 网页版产物按**发版**的方式构建（NODE_ENV=production）：Hub 托管的就是这一份，
  // CSP 检查也只看这一份。APK 那条路径照 build-apk.sh 的 NODE_ENV=development。
  const env = {
    ...process.env,
    VITE_HUB_ORIGIN: HUB_URL,
    NODE_ENV: target === 'web' ? 'production' : (process.env.NODE_ENV ?? 'development'),
  }
  if (target === 'web') env.VITE_TARGET = 'web'
  else delete env.VITE_TARGET
  const buildArgs = ['build', '--outDir', outDir]
  // 和 scripts/build-web.sh / build-apk.sh 共用同一把重型构建锁（设了 HEAVY_BUILD_LOCK 才加锁）
  const lock = process.env.HEAVY_BUILD_LOCK ?? ''
  const useLock = lock !== '' && existsSync(path.dirname(lock))
  const [cmd, cmdArgs] = useLock
    ? ['flock', [lock, VITE_BIN, ...buildArgs]]
    : [VITE_BIN, buildArgs]
  const started = Date.now()
  const child = spawn(cmd, cmdArgs, { cwd: UI_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stdout += d))
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, stdout, seconds: Math.round((Date.now() - started) / 100) / 10, locked: useLock }
}

async function grepHintCopy(dir) {
  const files = await fs.readdir(path.join(dir, 'assets')).catch(() => [])
  const needles = ['安装到桌面', '加到主屏幕', 'install-hint__title']
  const hits = []
  for (const name of files) {
    if (!name.endsWith('.js')) continue
    const text = await fs.readFile(path.join(dir, 'assets', name), 'utf8').catch(() => '')
    for (const needle of needles) if (text.includes(needle)) hits.push({ file: name, needle })
  }
  return hits
}

// ── 主体 ────────────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA.androidChrome })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  const report = { generatedAt: new Date().toISOString(), app: APP_URL, hub: HUB_URL, viewport: VIEWPORT }
  const startedAt = Date.now()

  // ---- 0. 干净状态进 App（这一版网页令牌还没落地，每次刷新都要重登）
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(250)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(700)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })

  // ---- 1. Chrome 自己怎么看这份 manifest
  const manifestInfo = await cdp.send('Page.getAppManifest')
  let parsed = manifestInfo.parsed
  if (!parsed && typeof manifestInfo.data === 'string') {
    try {
      parsed = JSON.parse(manifestInfo.data)
    } catch {
      parsed = null
    }
  }
  const manifestErrors = (manifestInfo.errors ?? []).filter((e) => e.message || e.critical)
  expect('manifest 已声明并被 Chrome 取到', !!manifestInfo.url && manifestInfo.url.endsWith('/manifest.webmanifest'), manifestInfo.url)
  expect('manifest 解析无错误', manifestErrors.length === 0, manifestErrors)

  // 原始字段用页面自己的 fetch 对（Chrome 会把 start_url 解析成绝对地址，原值看不到了）
  const manifestUrl = new URL('./manifest.webmanifest', manifestInfo.url ?? `${APP_URL}/`).href
  const manifestRaw = await cdp.eval(
    `fetch(${JSON.stringify(manifestUrl)}).then(r => r.json())`,
    { awaitPromise: true },
  )
  expect('manifest name / short_name = DSH Hub', manifestRaw.name === 'DSH Hub' && manifestRaw.short_name === 'DSH Hub', {
    name: manifestRaw.name,
    short_name: manifestRaw.short_name,
  })
  expect('manifest start_url / scope 都是 ./（挂在 /m/ 下也对）', manifestRaw.start_url === './' && manifestRaw.scope === './', {
    start_url: manifestRaw.start_url,
    scope: manifestRaw.scope,
  })
  expect('manifest display=standalone、orientation=portrait', manifestRaw.display === 'standalone' && manifestRaw.orientation === 'portrait', {
    display: manifestRaw.display,
    orientation: manifestRaw.orientation,
  })
  // 品牌「星座鲸」的夜空底色：安装/启动闪屏用 #080E3D（与图标底板同色）；
  // 运行期的状态栏颜色仍由 index.html 的两条 meta theme-color（亮 #F9F8F6 / 暗 #17171A）决定。
  expect(
    'manifest 配色 = 品牌夜空底（#080E3D）',
    manifestRaw.background_color === '#080E3D' && manifestRaw.theme_color === '#080E3D',
    { background_color: manifestRaw.background_color, theme_color: manifestRaw.theme_color },
  )

  const icons = Array.isArray(manifestRaw.icons) ? manifestRaw.icons : []
  const iconSpec = (want) =>
    icons.filter((icon) => icon.sizes === want.size && (icon.purpose ?? 'any') === want.purpose).length
  expect(
    'manifest 图标：192 any / 512 any / 512 maskable',
    iconSpec({ size: '192x192', purpose: 'any' }) === 1 &&
      iconSpec({ size: '512x512', purpose: 'any' }) === 1 &&
      iconSpec({ size: '512x512', purpose: 'maskable' }) === 1,
    icons,
  )

  // 每个图标真的下载一遍：状态码 / content-type / PNG 头 / IHDR 尺寸
  const iconResults = await cdp.eval(
    `Promise.all(${JSON.stringify(
      icons.map((icon) => ({ url: new URL(icon.src, manifestUrl).href, sizes: icon.sizes })),
    )}.map(async (expected) => {
      const url = expected.url
      try {
        const res = await fetch(url)
        const buf = new Uint8Array(await res.arrayBuffer())
        const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
        const view = new DataView(buf.buffer)
        return {
          url: url.replace(location.origin, ''),
          status: res.status,
          type: res.headers.get('content-type'),
          bytes: buf.byteLength,
          isPng,
          width: isPng ? view.getUint32(16) : null,
          height: isPng ? view.getUint32(20) : null,
          want: expected.sizes,
        }
      } catch (error) {
        return { url: expected.url, error: String(error) }
      }
    }))`,
    { awaitPromise: true },
  )
  for (const icon of iconResults) {
    const [wantW, wantH] = String(icon.want ?? '0x0').split('x').map(Number)
    expect(
      `图标可下载、是 PNG 且尺寸与声明一致：${icon.url}（${icon.want}）`,
      icon.status === 200 &&
        /image\/png/.test(icon.type ?? '') &&
        icon.isPng === true &&
        icon.width === wantW &&
        icon.height === wantH,
      icon,
    )
  }

  const installability = await cdp.send('Page.getInstallabilityErrors')
  const installabilityErrors = installability.installabilityErrors ?? []
  expect('Chrome 判定可安装（InstallabilityErrors 为空）', installabilityErrors.length === 0, installabilityErrors)

  // ---- 2. index.html 的头部标签
  const head = await cdp.eval(`(() => {
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content') ?? null
    const link = (sel) => {
      const el = document.querySelector(sel)
      return el ? { href: el.getAttribute('href'), sizes: el.getAttribute('sizes'), rel: el.getAttribute('rel') } : null
    }
    return {
      viewport: meta('meta[name=viewport]'),
      manifest: link('link[rel=manifest]'),
      appleTouch: link('link[rel=apple-touch-icon]'),
      mobileCapable: meta('meta[name=mobile-web-app-capable]'),
      appleCapable: meta('meta[name=apple-mobile-web-app-capable]'),
      statusBar: meta('meta[name=apple-mobile-web-app-status-bar-style]'),
      appleTitle: meta('meta[name=apple-mobile-web-app-title]'),
      themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map((el) => ({
        content: el.getAttribute('content'),
        media: el.getAttribute('media'),
      })),
    }
  })()`)
  expect(
    'viewport：viewport-fit=cover + interactive-widget=resizes-content 都在',
    (head.viewport ?? '').includes('viewport-fit=cover') &&
      (head.viewport ?? '').includes('interactive-widget=resizes-content'),
    head.viewport,
  )
  expect('manifest 链接是相对路径 ./manifest.webmanifest', head.manifest?.href === './manifest.webmanifest', head.manifest)
  expect(
    'apple-touch-icon：180×180 相对路径',
    head.appleTouch?.href === './apple-touch-icon-180.png' && head.appleTouch?.sizes === '180x180',
    head.appleTouch,
  )
  expect(
    'iOS standalone 三个 meta 齐全（capable / status-bar-style / title）',
    head.appleCapable === 'yes' && head.statusBar === 'black-translucent' && head.appleTitle === 'DSH Hub',
    { appleCapable: head.appleCapable, statusBar: head.statusBar, appleTitle: head.appleTitle },
  )
  expect('Android 也认 mobile-web-app-capable', head.mobileCapable === 'yes', head.mobileCapable)
  expect(
    'theme-color 两条 media（亮 #F9F8F6 / 暗 #17171A）',
    head.themeColors.length === 2 &&
      head.themeColors.some((m) => m.media?.includes('light') && m.content === '#F9F8F6') &&
      head.themeColors.some((m) => m.media?.includes('dark') && m.content === '#17171A'),
    head.themeColors,
  )

  // 强制深色主题（系统仍是亮色）时，两条 theme-color 都要改成深色，否则状态栏留白边
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })
  await cdp.eval(
    `localStorage.setItem('dsh-hub:ui:v1', JSON.stringify({ theme: 'dark' })), true`,
  )
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(900)
  const forcedDark = await cdp.eval(
    `[...document.querySelectorAll('meta[name="theme-color"]')].map(el => el.getAttribute('content'))`,
  )
  expect(
    'App 强制深色 + 系统亮色 → 两条 theme-color 都是深色（状态栏不留白边）',
    forcedDark.length === 2 && forcedDark.every((value) => value === '#17171A'),
    forcedDark,
  )
  await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  await cdp.eval(`(() => { localStorage.removeItem('dsh-hub:ui:v1'); return true })()`)

  // ---- 3. 首页引导：Android Chrome
  await reloadAndLogin(cdp)
  const androidHint = await hintState(cdp)
  expect('登录后首页出现「添加到桌面」引导', androidHint.present === true, androidHint)
  expect('Android Chrome：目标判定为 android-chrome', androidHint.target === 'android-chrome', androidHint.target)
  expect(
    '引导标题/正文/关闭按钮齐全',
    androidHint.title === '加到主屏幕' && androidHint.text.includes('全屏打开') && androidHint.hasClose === true,
    androidHint,
  )
  // Chrome 只在「真的可安装」时才派发 beforeinstallprompt，而且只派发一次；它出现在首页按钮上，
  // 说明 lib/pwa-install.ts 在模块加载时就把事件接住了（组件挂载晚于事件也能拿到）。
  expect(
    'Chrome 真的派发了 beforeinstallprompt（可安装的直接证据，且被提前接住）',
    androidHint.action === '安装到桌面',
    androidHint,
  )
  await cdp.shot('01-home-install-hint')

  // 合成一个 beforeinstallprompt：按钮应出现，点它要真的调到 prompt()
  // 用合成事件替掉真事件：真事件的 prompt() 会在 headless 里弹系统安装框，没法断言
  await cdp.eval(`(() => {
    window.__pwa = { prompts: 0, prevented: null }
    const event = new Event('beforeinstallprompt', { cancelable: true })
    event.prompt = async () => { window.__pwa.prompts += 1 }
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' })
    window.dispatchEvent(event)
    window.__pwa.prevented = event.defaultPrevented
    return true
  })()`)
  await sleep(250)
  const withButton = await hintState(cdp)
  expect(
    '收到 beforeinstallprompt 后出现「安装到桌面」按钮',
    withButton.action === '安装到桌面',
    withButton,
  )
  const prevented = await cdp.eval(`window.__pwa.prevented`)
  expect('拦掉了 Chrome 自己的 mini-infobar（preventDefault）', prevented === true, prevented)
  await cdp.shot('02-home-install-button')

  await cdp.eval(`document.querySelector('.install-hint__install').click()`)
  await sleep(400)
  const prompts = await cdp.eval(`window.__pwa.prompts`)
  const afterInstall = await hintState(cdp)
  expect('点「安装到桌面」调用了 prompt()', prompts === 1, prompts)
  expect('装好后引导消失', afterInstall.present === false, afterInstall)
  expect(
    '关闭/安装记录写进了偏好（30 天）',
    afterInstall.dismissedAt !== null && Math.abs(afterInstall.now - afterInstall.dismissedAt) < 60_000,
    { dismissedAt: afterInstall.dismissedAt, now: afterInstall.now },
  )

  // 刷新后（30 天内）不再出现
  await reloadAndLogin(cdp)
  const afterReload = await hintState(cdp)
  expect('刷新后 30 天内不再出现', afterReload.present === false, afterReload)

  // 清掉记录 → 又出现；再点关闭按钮 → 消失并记下时间
  await resetPageState(cdp)
  await reloadAndLogin(cdp)
  const backAgain = await hintState(cdp)
  expect('清掉记录后重新出现（不是永久隐藏）', backAgain.present === true, backAgain)
  await cdp.eval(`document.querySelector('.install-hint__close').click()`)
  await sleep(300)
  const closed = await hintState(cdp)
  expect('点关闭后立刻消失并记下时间', closed.present === false && typeof closed.dismissedAt === 'number', closed)

  // ---- 4. 模拟 standalone（从桌面图标打开）时不出现
  //
  // `Emulation.setEmulatedMedia` 对 display-mode 不生效（Blink 的 display-mode 读的是真实窗口
  // 模式，不走 emulated media feature），所以在页面里补一层 matchMedia：只有
  // `(display-mode: …standalone…)` 返回 true，其余查询原样透传。
  await resetPageState(cdp)
  const standaloneScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const result = real(query)
        if (String(query).includes('display-mode') && String(query).includes('standalone')) {
          Object.defineProperty(result, 'matches', { get: () => true, configurable: true })
        }
        return result
      }
    })()`,
  })
  await reloadAndLogin(cdp)
  const displayMode = await cdp.eval(
    `({ standalone: matchMedia('(display-mode: standalone)').matches, browser: matchMedia('(display-mode: browser)').matches, hint: !!document.querySelector('.install-hint') })`,
  )
  expect('模拟 standalone：display-mode 媒体查询为真', displayMode.standalone === true, displayMode)
  expect('模拟 standalone（已经像 App 一样全屏）时引导不出现', displayMode.hint === false, displayMode)
  await cdp.shot('03-standalone-no-hint')
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: standaloneScript.identifier,
  })

  // ---- 4.1 深色下的观感（截图交付；顺带验证主题切换后 theme-color 同步）
  await cdp.eval(`localStorage.setItem('dsh-hub:ui:v1', JSON.stringify({ theme: 'dark' })), true`)
  await reloadAndLogin(cdp)
  const darkHint = await hintState(cdp)
  const darkMeta = await cdp.eval(
    `[...document.querySelectorAll('meta[name="theme-color"]')].map(el => el.getAttribute('content'))`,
  )
  expect('深色主题下引导同样出现（配色走设计令牌）', darkHint.present === true, darkHint)
  expect(
    '深色主题 + 系统浅色 → 状态栏配色也跟着变深',
    darkMeta.length === 2 && darkMeta.every((value) => value === '#17171A'),
    darkMeta,
  )
  await cdp.shot('03b-home-install-hint-dark')
  await cdp.eval(`(() => { localStorage.removeItem('dsh-hub:ui:v1'); return true })()`)

  // ---- 5. iOS Safari：分享 → 添加到主屏幕（图文说明，没有按钮）
  await withUserAgent(cdp, UA.iphoneSafari)
  const iosHint = await hintState(cdp)
  expect('iOS Safari：目标判定为 ios-safari', iosHint.target === 'ios-safari', iosHint)
  expect(
    'iOS Safari：文案指向「分享按钮 → 添加到主屏幕」且没有按钮',
    iosHint.text.includes('分享') && iosHint.text.includes('添加到主屏幕') && iosHint.action === null,
    iosHint,
  )
  expect('iOS Safari：左侧是分享图标（内联 svg）', iosHint.glyphIsSvg === true, iosHint)
  await cdp.shot('04-ios-install-hint')

  // ---- 6. 微信内置浏览器：请用户换浏览器
  await resetPageState(cdp)
  await withUserAgent(cdp, UA.wechat)
  const wechatHint = await hintState(cdp)
  expect('微信内置浏览器：目标判定为 other', wechatHint.target === 'other', wechatHint)
  expect(
    '微信内置浏览器：提示用 Safari / Chrome 打开',
    wechatHint.title.includes('浏览器') && wechatHint.text.includes('Safari') && wechatHint.action === null,
    wechatHint,
  )
  await cdp.shot('05-wechat-install-hint')

  // ---- 7. 桌面浏览器：不打扰
  await resetPageState(cdp)
  await withUserAgent(cdp, UA.desktopChrome)
  const desktopHint = await hintState(cdp)
  expect('桌面浏览器不显示引导', desktopHint.present === false, desktopHint)

  // ---- 8. 网页版产物（VITE_TARGET=web）：挂到 /m/ 下要能直接用
  const webBuild = await viteBuild({ outDir: '.e2e-dist-web', target: 'web' })
  expect(
    `网页版构建（VITE_TARGET=web）成功${webBuild.locked ? '（flock 串行）' : ''}`,
    webBuild.code === 0,
    { code: webBuild.code, seconds: webBuild.seconds, tail: webBuild.stdout.split('\n').slice(-3).join(' | ') },
  )
  const webHtml = await fs.readFile(path.join(WEB_DIST, 'index.html'), 'utf8').catch(() => '')
  expect(
    '网页版产物的图标/manifest/theme-boot 都是相对路径（挂在 /m/ 下也不会 404）',
    webHtml.includes('href="./manifest.webmanifest"') &&
      webHtml.includes('href="./apple-touch-icon-180.png"') &&
      webHtml.includes('href="./icon-192.png"') &&
      webHtml.includes('src="./theme-boot.js"'),
    webHtml.match(/href="\.\/[^"]+"/g),
  )
  const webFiles = await fs.readdir(WEB_DIST).catch(() => [])
  expect(
    'public/ 的 manifest、三个图标与 theme-boot.js 被拷到了产物根',
    ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon-180.png', 'theme-boot.js'].every(
      (name) => webFiles.includes(name),
    ),
    webFiles.filter((name) => /png|webmanifest|theme-boot/.test(name)),
  )
  const webHintHits = await grepHintCopy(WEB_DIST)
  expect('网页版产物里带着首页引导（IS_WEB_BUILD=true）', webHintHits.length > 0, webHintHits.slice(0, 2))

  // ---- 8.5 生产 CSP（Hub /m/ 下发的那一份）下不能有任何违规
  //
  // 手机网页版的 index.html 里「首屏定主题」是**同源独立脚本**（public/theme-boot.js）而不是
  // 内联 <script>：`script-src 'self'` 会整段拦掉内联脚本（暗色用户首屏闪浅色 + 控制台报错）。
  // 这一节把**网页版构建产物**按逐字相同的 CSP 发出去，用文档起手就挂上的监听抓
  // securitypolicyviolation，并核对暗色偏好下第一帧就是暗色。
  //
  // 覆盖范围说明：生产里网页版与 Hub 同源，而 e2e 里 mock Hub 在另一个端口（跨源，
  // `connect-src 'self'` 会拦住），所以这里只跑到登录页 —— 正是内联脚本/CSS 会违规的地方；
  // 登录之后的页面由 W1 的 `web-smoke`（同源托管）那套再覆盖。
  const cspServer = await serveDir(WEB_DIST, { 'content-security-policy': MOBILE_WEB_CSP })
  const cspProbeId = (
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_PROBE })
  ).identifier
  try {
    // 暗色偏好 + 不存主题（走 system），theme-boot 应该直接把首屏定成暗色
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
    await cdp.send('Page.navigate', { url: `${cspServer.url}/#/login` })
    await waitFor(cdp, `document.querySelector('.login')`, { label: 'CSP 下的登录页' })
    await sleep(250)
    const csp = await cdp.eval(`window.__csp`)
    const firstTheme = csp.themeTimeline?.[0] ?? null
    const zodDiag = await cdp.eval(
      `({ zodConfig: globalThis.__zod_globalConfig ?? null, readyState: document.readyState })`,
    )
    expect(
      '生产 CSP 下没有任何 securitypolicyviolation（内联脚本已挪成同源 theme-boot.js）',
      (csp.violations ?? []).length === 0,
      { violations: csp.violations, zod: zodDiag },
    )
    expect(
      'theme-boot.js 是解析期执行的（第一次写 data-theme 时文档还在 loading）',
      firstTheme?.theme === 'dark' && firstTheme?.readyState === 'loading',
      firstTheme,
    )
    expect(
      '暗色偏好下首帧就是暗色（theme-boot 设的 html 背景 #17171A）',
      csp.firstFrame?.theme === 'dark' && csp.firstFrame?.bg === 'rgb(23, 23, 26)',
      csp.firstFrame,
    )
    // 断言有效性：同一份 CSP 必须真的能拦内联脚本，否则上面「0 违规」是白拿的
    await cdp.eval(`(() => {
      const script = document.createElement('script')
      script.textContent = 'window.__cspInlineRan = true'
      document.head.appendChild(script)
      return true
    })()`)
    await sleep(250)
    const teeth = await cdp.eval(
      `({ inlineRan: window.__cspInlineRan === true, violations: window.__csp.violations.length, theme: document.documentElement.dataset.theme })`,
    )
    expect(
      '断言有效性：同样的 CSP 会拦掉内联脚本并报违规（说明上面 0 违规不是白拿的）',
      teeth.inlineRan === false && teeth.violations >= 1,
      teeth,
    )
    await cdp.shot('07-csp-dark-first-paint')
  } finally {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cspProbeId })
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
    await cspServer.close()
  }


  // ---- 9. APK 构建（不带 VITE_TARGET）不能把这个引导带出来
  const build = await viteBuild({ outDir: '.e2e-dist-apk', target: 'apk' })
  expect(
    `APK 构建（不带 VITE_TARGET）成功${build.locked ? '（flock 串行）' : ''}`,
    build.code === 0,
    { code: build.code, seconds: build.seconds, tail: build.stdout.split('\n').slice(-3).join(' | ') },
  )
  expect('APK 构建产物仍有 index.html（共享的头部标签）', existsSync(path.join(APK_DIST, 'index.html')))
  const apkHtml = await fs.readFile(path.join(APK_DIST, 'index.html'), 'utf8')
  expect(
    'APK 产物里 manifest 链接存在（WebView 不读，属无害标签）',
    apkHtml.includes('manifest.webmanifest'),
  )
  const hintHits = await grepHintCopy(APK_DIST)
  // 两种结论都可接受：Rollup 把组件整块摇掉（没有文案），或者只剩「IS_WEB_BUILD 构建期
  // 为 false」永远进不去的死代码。真假由下面把产物真跑一遍来兜 —— 这里只如实记录。
  note(
    hintHits.length === 0
      ? 'APK 产物里没有引导文案（整块被摇掉）'
      : `APK 产物里还留着引导文案（死代码，IS_WEB_BUILD 构建期为 false）：${hintHits
          .map((hit) => `${hit.file}:${hit.needle}`)
          .slice(0, 3)
          .join('，')}`,
  )

  // 把 APK 产物发出去、真的登录进首页：引导不许出现
  const apkServer = await serveDir(APK_DIST)
  let apkState = { present: false }
  try {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA.androidChrome })
    // 先清掉上一步给 dev server 攒下的本地状态（localStorage 按源隔离，这里只是保守起见）
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
    await cdp.send('Page.navigate', { url: `${apkServer.url}/#/login` })
    await sleep(900)
    await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(600)
    if (await cdp.eval(`!!document.querySelector('.login')`)) await login(cdp)
    apkState = await hintState(cdp)
    const apkHome = await cdp.eval(`({ home: !!document.querySelector('.home-view'), hint: !!document.querySelector('.install-hint') })`)
    expect('APK 产物能正常起来并进到首页', apkHome.home === true, apkHome)
    expect('APK 产物里首页不出现「添加到桌面」引导（IS_WEB_BUILD=false）', apkState.present === false && apkHome.hint === false, apkState)
    await cdp.shot('06-apk-build-no-hint')
  } finally {
    await apkServer.close()
  }

  // ---- 10. 断言有效性：没有 manifest 的页面必须被判定为不可安装
  const probe = await serveDir(APK_DIST)
  try {
    await cdp.send('Page.navigate', { url: `${probe.url}/no-manifest.html` })
    await sleep(500)
    const blankManifest = await cdp.send('Page.getAppManifest')
    const blankErrors = await cdp.send('Page.getInstallabilityErrors')
    const blankInstall = blankErrors.installabilityErrors ?? []
    expect(
      '断言有效性：没有 manifest 的页面会被 Chrome 判成不可安装（说明上面那条空数组不是白拿的）',
      (blankManifest.errors ?? []).length > 0 || blankInstall.length > 0,
      {
        manifestUrl: blankManifest.url ?? null,
        manifestErrors: (blankManifest.errors ?? []).map((e) => e.message),
        installability: blankInstall,
      },
    )
  } finally {
    await probe.close()
  }

  // ---- 11. 控制台错误
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('Download the Vue Devtools') && !e.includes('Failed to load resource'),
  )
  expect('控制台无脚本错误', realErrors.length === 0, realErrors.slice(0, 5))

  report.durationMs = Date.now() - startedAt
  report.manifest = { url: manifestInfo.url, errors: manifestErrors, raw: manifestRaw, icons: iconResults }
  report.installability = installabilityErrors
  report.webBuild = { code: webBuild.code, seconds: webBuild.seconds, hintHits: webHintHits }
  report.csp = { policy: MOBILE_WEB_CSP }
  report.apkBuild = { code: build.code, seconds: build.seconds, hintHits }
  report.hints = { androidHint, iosHint, wechatHint, desktopHint, apkHint: apkState }
  report.checks = checks
  report.consoleErrors = realErrors
  const jsonPath = path.join(OUT, 'web-pwa-e2e.json')
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2))
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过，报告 ${jsonPath}`)
  if (failed.length > 0) console.error('失败项：', failed.map((c) => c.name))
  cdp.ws.close()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error('e2e 失败：', error)
  try {
    await fs.mkdir(OUT, { recursive: true })
    await fs.writeFile(
      path.join(OUT, 'web-pwa-e2e-error.json'),
      JSON.stringify({ error: String(error), checks }, null, 2),
    )
  } catch {}
  process.exit(1)
})
