#!/usr/bin/env node
/**
 * 手机网页版「页面差异」e2e（WP54 / W4）。
 *
 * 被测的是**网页构建**：脚本自己起 mock hub + `VITE_TARGET=web` 的 vite（同一个 worktree）+ headless
 * Chrome，不需要在 shell 里设环境变量（运行器传的端口照收）。覆盖 W4 的六件事：
 *
 *   A. 登录页：网页版**没有**「记住账号密码」开关；表单是真 `<form>`（method=post）、
 *      用户名/密码带 `autocomplete="username"` / `"current-password"`；
 *   B. 用**表单提交**（`form.requestSubmit()`，不是点按钮）真的能登进去 —— 浏览器保存密码靠的就是这条路径；
 *   C. 设置页：版本区是「手机网页版 <app-info 的 APP_VERSION>」（没有 versionCode）、有「下载 App」「电脑版」、
 *      **没有** APK 的「检查更新」；「下载 App」在取不到地址时给提示而不是乱跳；
 *   D. 诊断面板：平台 `web` + 浏览器 UA + 是否 standalone；
 *   E. 「有新版本」：CDP 拦截 `version.json` 回一个不同的 build，再触发回前台（W1 的 WebVersionWatch）
 *      → 底部出现「有新版本，点此刷新」，点一下真的 reload；
 *   F. 网络检测：停掉 Hub 让登录报网络错误 → 打开弹层 → **只有一个入口**（没有多入口列表），
 *      第一行叫「本机网络」，文案里没有 APK 相关说法。
 *
 * 用法（默认自己拉起全部服务，跑完按 PID 收干净）：
 *   node scripts/e2e-web-settings.mjs --hub-port 5311 --app-port 5312 --cdp 9311 --out /tmp/web-settings
 * 已经手工起好服务时（注意 vite 必须是 `VITE_TARGET=web` 起的）：
 *   node scripts/e2e-web-settings.mjs --no-spawn --app http://127.0.0.1:5312 \
 *     --hub http://127.0.0.1:5311 --cdp 9311 --out /tmp/web-settings
 *
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
/** 期望的版本号直接读 app-info（版本 bump 时不用再改这个脚本） */
const APP_VERSION = (await fs.readFile(path.join(ROOT, 'packages/mobile-ui/src/lib/app-info.ts'), 'utf8')).match(
  /export const APP_VERSION = '([^']+)'/,
)[1]
const SPAWN = args.spawn !== 'false' && !process.argv.includes('--no-spawn')
const HUB_PORT = Number(args['hub-port'] ?? 5311)
const APP_PORT = Number(args['app-port'] ?? 5312)
const CDP_PORT = Number(args.cdp ?? 9311)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-web-settings-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
/** 手机视口：iPhone 12/13/14 = 390×844 / DPR 3。 */
const VIEWPORT = { width: 390, height: 844, dpr: 3 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 极简 CDP 客户端（与其它 e2e 脚本一致）──────────────────────────────────

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
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(80)
  }
  throw new Error(`等待超时：${label}`)
}

// ── 服务进程 ────────────────────────────────────────────────────────────────

const children = []
let headHub = null
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

async function waitHttpDown(url, { timeout = 6000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      await fetch(url)
    } catch {
      return true
    }
    await sleep(100)
  }
  return false
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

async function startHub() {
  console.log(`[e2e] 起 mock hub :${HUB_PORT}`)
  const hub = spawn(process.execPath, [path.join(ROOT, 'apps/mock-hub/server.mjs')], {
    env: { ...process.env, PORT: String(HUB_PORT), TICK_MS: '12', WAKE_MS: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  headHub = hub
  children.push(hub)
  pipeStdout('hub', hub)
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
}

/** 停掉 Hub（模拟服务器不可达），并等到端口真的连不上。 */
async function stopHub() {
  const hub = headHub
  headHub = null
  if (!hub) return
  hub.kill('SIGTERM')
  await new Promise((resolve) => {
    if (hub.exitCode !== null) return resolve()
    hub.once('exit', resolve)
    setTimeout(resolve, 3000).unref?.()
  })
  const down = await waitHttpDown(`${HUB_URL}/__test/health`)
  if (!down) throw new Error('mock hub 停不下来')
  console.log('[e2e] mock hub 已停')
}

async function startVite() {
  // 关键：网页构建。运行器不传 VITE_TARGET 也要能跑，所以这里显式给上。
  console.log(`[e2e] 起 vite :${APP_PORT}（VITE_TARGET=web, VITE_HUB_ORIGIN=${HUB_URL}）`)
  const vite = spawn(
    path.join(ROOT, 'packages/mobile-ui/node_modules/.bin/vite'),
    ['--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'packages/mobile-ui'),
      env: {
        ...process.env,
        VITE_TARGET: 'web',
        VITE_HUB_ORIGIN: HUB_URL,
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })
}

async function startChrome() {
  profileDir = `/tmp/e2e-profile-web-settings-${Date.now()}`
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

async function startServers() {
  if (!SPAWN) {
    await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
    await waitHttp(`${APP_URL}/`, { label: 'vite' })
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
    return
  }
  await startHub()
  await startVite()
  await startChrome()
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

// ── 页面操作 ────────────────────────────────────────────────────────────────

async function fillLogin(cdp, username, password) {
  await cdp.eval(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel)
      if (!el) return
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('input[name=username]', ${JSON.stringify(username)})
    set('input[name=password]', ${JSON.stringify(password)})
    return true
  })()`)
  await sleep(160)
}

/** 干净进入登录页（清掉上次运行留下的偏好：记住的用户名、诊断事件……）。 */
async function freshLoginPage(cdp) {
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(280)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload')
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
}

/** 用**表单提交**登录（不是点按钮）：证明 <form> 真的接上了 submit。 */
async function submitLoginViaForm(cdp) {
  await cdp.eval(`document.querySelector('form.login__form').requestSubmit()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, {
    timeout: 15000,
    label: '通道连上',
  })
}

async function goto(cdp, route, readyExpr) {
  await cdp.eval(`window.__dshHub.router.push(${JSON.stringify(route)})`)
  await waitFor(cdp, readyExpr, { label: route })
  await sleep(200)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  await startServers()

  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' }).catch(() => {})
  await freshLoginPage(cdp)

  // ── A. 登录页：没有「记住账号密码」，表单 autocomplete 正确 ────────────────
  const loginForm = await cdp.eval(`(() => {
    const form = document.querySelector('form.login__form')
    const username = document.querySelector('input[name=username]')
    const password = document.querySelector('input[name=password]')
    return {
      isForm: form ? form.tagName === 'FORM' : false,
      method: form ? form.method : '',
      rememberCheckbox: !!document.querySelector('input[name=remember]'),
      rememberBlock: !!document.querySelector('.login__remember'),
      text: document.querySelector('.login')?.innerText ?? '',
      usernameAutocomplete: username?.getAttribute('autocomplete') ?? null,
      passwordAutocomplete: password?.getAttribute('autocomplete') ?? null,
      usernameName: username?.getAttribute('name') ?? null,
      passwordType: password?.getAttribute('type') ?? null,
      submitIsSubmit: document.querySelector('.login__submit')?.getAttribute('type') ?? null,
      links: [...document.querySelectorAll('.login__links button')].map((b) => b.innerText.trim()),
    }
  })()`)

  expect(
    'A 登录页没有「记住账号密码」开关（网页版交给浏览器密码管理器）',
    loginForm.rememberCheckbox === false &&
      loginForm.rememberBlock === false &&
      !loginForm.text.includes('记住账号密码'),
    {
      checkbox: loginForm.rememberCheckbox,
      block: loginForm.rememberBlock,
    },
  )
  expect(
    'A 表单是真 <form>（method=post），浏览器才认这是登录表单',
    loginForm.isForm === true && loginForm.method === 'post',
    { isForm: loginForm.isForm, method: loginForm.method },
  )
  expect(
    'A 用户名 autocomplete=username / 密码 autocomplete=current-password',
    loginForm.usernameAutocomplete === 'username' &&
      loginForm.passwordAutocomplete === 'current-password' &&
      loginForm.usernameName === 'username' &&
      loginForm.passwordType === 'password',
    {
      username: loginForm.usernameAutocomplete,
      password: loginForm.passwordAutocomplete,
    },
  )
  expect(
    'A 登录按钮是 type=submit；注册/忘记密码链接仍在',
    loginForm.submitIsSubmit === 'submit' &&
      loginForm.links.includes('注册账号') &&
      loginForm.links.includes('忘记密码'),
    { submit: loginForm.submitIsSubmit, links: loginForm.links },
  )
  await cdp.shot('01-login-web')

  // ── B. 表单提交登录 ──────────────────────────────────────────────────────
  await fillLogin(cdp, 'demo', 'demo1234')
  await submitLoginViaForm(cdp)
  const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
  expect(`B 表单提交登录成功（入口 ${origin}）`, origin === HUB_URL, origin)

  // ── C. 设置页：网页版版本区 + 下载 App / 电脑版，没有 APK 检查更新 ─────────
  await goto(cdp, '/settings', `document.querySelector('[data-version]')`)
  const settings = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.page__row')]
    const desktop = document.querySelector('[data-web-desktop]')
    return {
      version: document.querySelector('[data-version]')?.innerText.trim() ?? '',
      labels: [...document.querySelectorAll('.page__label')].map((el) => el.innerText.trim()),
      rowTexts: rows.map((el) => el.innerText.trim()),
      desktopHref: desktop ? desktop.getAttribute('href') : null,
      desktopTag: desktop ? desktop.tagName : null,
      downloadApp: document.querySelector('[data-web-download-app]')?.innerText.trim() ?? '',
      hasUpdateRow: !!document.querySelector('[data-web-update-row]'),
      logout: rows.some((el) => el.innerText.includes('退出登录')),
      revoke: rows.some((el) => el.innerText.includes('吊销本设备')),
      bodyText: document.querySelector('.page')?.innerText ?? '',
    }
  })()`)

  expect(
    `C 版本区是「手机网页版 ${APP_VERSION}」（没有 versionCode）`,
    settings.version === `手机网页版 ${APP_VERSION}`,
    settings.version,
  )
  expect(
    'C 有「下载 App」入口',
    settings.downloadApp.includes('下载 App'),
    settings.downloadApp,
  )
  expect(
    'C 有「电脑版」入口，指向 /?view=desktop（C8，同页跳转）',
    settings.desktopTag === 'A' &&
      typeof settings.desktopHref === 'string' &&
      settings.desktopHref.endsWith('/?view=desktop'),
    { tag: settings.desktopTag, href: settings.desktopHref },
  )
  expect(
    'C 没有 APK 的「检查更新 / 下载安装」',
    !settings.rowTexts.some((text) => text === '检查更新' || text.includes('检查更新…')) &&
      !settings.bodyText.includes('检查更新') &&
      !settings.bodyText.includes('下载安装'),
    settings.rowTexts,
  )
  expect(
    'C 退出登录 / 吊销本设备照旧（网页里同样吊销本设备令牌）',
    settings.logout === true && settings.revoke === true,
    { logout: settings.logout, revoke: settings.revoke },
  )
  // 截图取到「其他」那一组（下载 App / 电脑版在首屏之外）
  await cdp.eval(`(() => {
    const page = document.querySelector('.page')
    if (page) page.scrollTop = 0
    const group = document.querySelector('[data-web-desktop]')
    group?.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(320)
  const otherGroup = await cdp.eval(`(() => {
    const desktop = document.querySelector('[data-web-desktop]')
    const rect = desktop ? desktop.getBoundingClientRect() : null
    return {
      visible: rect !== null && rect.top > 0 && rect.bottom < window.innerHeight,
      rows: [...document.querySelectorAll('.page__group')].map((el) => el.innerText.trim()),
    }
  })()`)
  expect(
    'C 「下载 App」「电脑版」都在「其他」组里，且能滚到（手机一屏放得下）',
    otherGroup.visible === true &&
      otherGroup.rows.some((text) => text.includes('下载 App') && text.includes('电脑版')),
    otherGroup.rows.slice(-2),
  )
  await cdp.shot('02-settings-web')

  // 「下载 App」：dev 是跨源 mock Hub，没有那个匿名接口 → 只提示，不乱跳
  const hrefBefore = await cdp.eval(`location.href`)
  await cdp.eval(`document.querySelector('[data-web-download-app]').click()`)
  await sleep(700)
  const afterDownload = await cdp.eval(`(() => ({
    toast: document.querySelector('.toast')?.innerText.trim() ?? '',
    href: location.href,
    stillSettings: !!document.querySelector('[data-version]'),
  }))()`)
  expect(
    'C 取不到 APK 地址时只提示，不跳走（也不会原地打转到 /m/）',
    afterDownload.toast.includes('暂时没有可下载的 App') &&
      afterDownload.href === hrefBefore &&
      afterDownload.stillSettings === true,
    { toast: afterDownload.toast, moved: afterDownload.href !== hrefBefore },
  )
  await cdp.shot('03-settings-download-toast')
  await sleep(2000) // 等 toast 自己消失，后面的截图干净一点

  // ── D. 诊断面板：平台 web + 浏览器 UA + standalone ────────────────────────
  await goto(cdp, '/c/s_mock_plan', `document.querySelector('.thread')`)
  await cdp.eval(`document.querySelector('button[aria-label="会话菜单"]').click()`)
  await waitFor(cdp, `document.querySelector('.session-menu')`, { label: '⋮ 菜单' })
  await sleep(200)
  await cdp.eval(`document.querySelector('.session-menu__item[data-action="diagnostics"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-panel="diagnostics"]')`, { label: '诊断面板' })
  await sleep(350)
  const diag = await cdp.eval(`(() => {
    const meta = document.querySelector('[data-diag-meta]')
    const ua = document.querySelector('[data-web-ua]')
    return {
      meta: meta ? meta.innerText.trim() : '',
      ua: ua ? ua.innerText.trim() : '',
    }
  })()`)
  expect(
    'D 诊断面板写明平台 web + 版本 + 不是 standalone（浏览器标签页）',
    diag.meta.includes('web') &&
      diag.meta.includes(`手机网页版 ${APP_VERSION}`) &&
      diag.meta.includes('浏览器标签页'),
    diag.meta,
  )
  expect(
    'D 诊断面板给出浏览器 UA',
    diag.ua.includes('Chrome/') && diag.ua.includes('HeadlessChrome/'),
    diag.ua.slice(0, 120),
  )
  await cdp.shot('04-diagnostics-web')
  await cdp.eval(`document.querySelector('.side-panel__back')?.click()`)
  await waitFor(cdp, `!document.querySelector('[data-panel="diagnostics"]')`, {
    label: '关闭诊断面板',
  })

  // ── E. 模拟「有新版本」→ 轻提示 → 点一下 reload ───────────────────────────
  await goto(cdp, '/settings', `document.querySelector('[data-version]')`)
  // W1 合入后走真实链路：CDP 拦截 `version.json` 回一个不同的 build，再触发「回前台」，
  // 由 W1 的 WebVersionWatch 判定出新版本（不再用 W4 的 `__dshWebUpdate` 桩）。
  const hasHook = await cdp.eval(
    `typeof window.__dshHubAppUpdate === 'object' && window.__dshHubAppUpdate.watching === true`,
  )
  expect('E 网页版的版本检查在运行（W1 的 __dshHubAppUpdate.watching）', hasHook === true)
  if (hasHook === true) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*version.json*', requestStage: 'Request' }] })
    cdp.listeners.set('Fetch.requestPaused', [
      (params) => {
        const body = JSON.stringify({ version: '9.9.9', build: 'e2enew0', builtAt: new Date().toISOString() })
        void cdp.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from(body).toString('base64'),
        })
      },
    ])
    // WebVersionWatch 有 3s 最小间隔：等过去再发「回前台」
    await sleep(3200)
    await cdp.eval(`document.dispatchEvent(new Event('visibilitychange')), true`)
    await waitFor(cdp, `document.querySelector('[data-web-update]')`, { label: '新版本轻提示' })
    await sleep(250)
    const updateUi = await cdp.eval(`(() => {
      const banner = document.querySelector('[data-web-update]')
      const row = document.querySelector('[data-web-update-row]')
      const overlay = document.querySelector('.update-overlay')
      return {
        banner: banner ? banner.innerText.trim() : '',
        row: row ? row.innerText.trim() : '',
        hasApkOverlay: !!overlay,
        bannerRect: banner
          ? (() => {
              const r = banner.getBoundingClientRect()
              return {
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
                height: Math.round(r.height),
                left: Math.round(r.left),
                right: Math.round(r.right),
                vw: window.innerWidth,
                vh: window.innerHeight,
              }
            })()
          : null,
      }
    })()`)
    expect(
      'E 底部轻提示「有新版本，点此刷新」',
      updateUi.banner.includes('有新版本，点此刷新'),
      updateUi.banner,
    )
    expect(
      'E 设置页版本区同时多一行「有新版本，点此刷新」',
      updateUi.row.includes('有新版本，点此刷新'),
      updateUi.row,
    )
    expect('E 网页版不出 APK 的强更弹层', updateUi.hasApkOverlay === false)
    expect(
      'E 轻提示是底部横条（贴底、不挡整页，不是弹窗）',
      updateUi.bannerRect !== null &&
        updateUi.bannerRect.height > 0 &&
        updateUi.bannerRect.height < 80 &&
        updateUi.bannerRect.bottom > updateUi.bannerRect.vh - 40 &&
        updateUi.bannerRect.left > 0,
      updateUi.bannerRect,
    )
    await cdp.shot('05-web-update-banner')

    // 先撤掉 version.json 拦截：刷新后拿到的是真实 version.json（或 dev 下的非 JSON），提示应当消失
    await cdp.send('Fetch.disable')
    cdp.listeners.delete('Fetch.requestPaused')

    // 点「刷新」：真的 reload（用 sessionStorage 记号 + navigation type 双重确认）
    await cdp.eval(`(() => {
      sessionStorage.setItem('e2e-web-reload', '1')
      setTimeout(() => { document.querySelector('[data-web-update] .web-update__action')?.click() }, 60)
      return true
    })()`)
    await sleep(1800)
    // W1 起网页版令牌存 localStorage，刷新后仍是登录态、停在原来的设置页
    await waitFor(
      cdp,
      `document.querySelector('[data-version]') || document.querySelector('.login') || document.querySelector('.home')`,
      { label: '刷新后页面回来' },
    )
    const reloaded = await cdp.eval(`(() => ({
      navType: performance.getEntriesByType('navigation')[0]?.type ?? '',
      marker: sessionStorage.getItem('e2e-web-reload') ?? '',
      hasBanner: !!document.querySelector('[data-web-update]'),
    }))()`)
    expect(
      'E 点「点此刷新」真的重新加载了页面（navigation type=reload，提示随之消失）',
      reloaded.navType === 'reload' && reloaded.marker === '1' && reloaded.hasBanner === false,
      reloaded,
    )
  }

  // ── F. 网络检测：只有一个入口 ─────────────────────────────────────────────
  await freshLoginPage(cdp)
  // 对照站点指回 vite 自己：不依赖外网，也不受「Hub 已停」影响
  await cdp.eval(`(() => {
    window.__dshNetDiagControlSites = [${JSON.stringify(`${APP_URL}/`)}]
    return true
  })()`)
  await stopHub()
  await fillLogin(cdp, 'demo', 'demo1234')
  await cdp.eval(`document.querySelector('form.login__form').requestSubmit()`)
  await waitFor(
    cdp,
    `document.querySelector('.login__error')?.innerText.includes('网络连接失败')`,
    { label: '登录报网络错误' },
  )
  await waitFor(cdp, `document.querySelector('.login__diag')`, { label: '「网络检测」按钮' })
  await cdp.eval(`document.querySelector('.login__diag').click()`)
  await waitFor(cdp, `document.querySelector('[data-step="hub"]')`, { label: '检测弹层' })
  await waitFor(
    cdp,
    `document.querySelector('[data-step="hub"]')?.getAttribute('data-state') !== 'running'`,
    { timeout: 15000, label: 'Hub 行出结果' },
  )
  await sleep(300)
  const diagSheet = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-step]')].map((el) => ({
      key: el.getAttribute('data-step'),
      state: el.getAttribute('data-state'),
      label: el.querySelector('.diag__label')?.innerText.trim() ?? '',
      note: el.querySelector('.diag__note')?.innerText.trim() ?? '',
    }))
    return {
      rows,
      originList: !!document.querySelector('[data-testid="diag-origins"]'),
      entries: document.querySelectorAll('.diag__entry').length,
      title: document.querySelector('.diag__title')?.innerText.trim() ?? '',
      detail: document.querySelector('.diag__detail')?.innerText.trim() ?? '',
      actions: [...document.querySelectorAll('[data-action]')].map((el) =>
        el.getAttribute('data-action'),
      ),
      sheetText: document.querySelector('.sheet')?.innerText ?? '',
    }
  })()`)
  expect(
    'F 只有当前这一个入口：没有多入口列表、没有「当前」标记行',
    diagSheet.originList === false && diagSheet.entries === 0,
    { originList: diagSheet.originList, entries: diagSheet.entries },
  )
  expect(
    'F 三行检测项，第一行叫「本机网络」（浏览器没有 Wi-Fi/移动数据之分）',
    diagSheet.rows.length === 3 && diagSheet.rows[0]?.label === '本机网络',
    diagSheet.rows.map((row) => row.label),
  )
  expect(
    'F Hub 行出结论（服务器连不上）',
    diagSheet.rows.find((row) => row.key === 'hub')?.state === 'fail' &&
      diagSheet.title.includes('服务器'),
    { title: diagSheet.title, detail: diagSheet.detail },
  )
  expect(
    'F 文案里没有 APK 相关说法（应用详情 / 联网权限 / 禁止联网）',
    !diagSheet.sheetText.includes('应用详情') &&
      !diagSheet.sheetText.includes('禁止联网') &&
      !diagSheet.sheetText.includes('WLAN'),
    diagSheet.sheetText.slice(0, 160),
  )
  expect(
    'F 浏览器里没有「去设置 / 打开网络设置」（这些是原生才有的动作）',
    !diagSheet.actions.includes('openAppSettings') &&
      !diagSheet.actions.includes('openNetworkSettings'),
    diagSheet.actions,
  )
  await cdp.shot('06-net-diag-web')

  // ── 控制台 ──────────────────────────────────────────────────────────────
  const noisy = /favicon|Download the Vue Devtools|net::ERR_CONNECTION_REFUSED|Failed to fetch|WebSocket/i
  const realErrors = consoleErrors.filter((line) => !noisy.test(line))
  expect('无控制台 error', realErrors.length === 0, realErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    build: 'VITE_TARGET=web',
    viewport: VIEWPORT,
    passed,
    total: checks.length,
    checks,
    failed: checks.filter((c) => !c.ok),
    consoleErrors: realErrors,
    screenshots: (await fs.readdir(OUT)).filter((f) => f.endsWith('.png')).sort(),
  }
  await fs.writeFile(path.join(OUT, 'web-settings.json'), JSON.stringify(report, null, 2))
  const failed = report.failed
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'web-settings.json')}`)
  if (failed.length > 0) console.error('失败项：', failed.map((c) => c.name))

  // 收尾必须显式 close + exit（CDP 的 WebSocket 不断开时 node 会挂在事件循环上）
  cdp.ws.close()
  await stopServers()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error('e2e 失败：', error)
  try {
    await fs.mkdir(OUT, { recursive: true })
    await fs.writeFile(
      path.join(OUT, 'web-settings-error.json'),
      JSON.stringify({ error: String(error), checks }, null, 2),
    )
  } catch {}
  await stopServers()
  process.exit(1)
})
