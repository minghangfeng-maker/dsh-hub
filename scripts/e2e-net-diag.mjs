#!/usr/bin/env node
/**
 * 登录页「网络检测」e2e（0.4.9）。
 *
 * 背景：登录报「网络连接失败」时，用户分不清是手机没网、App 被 ROM 禁止联网，还是服务器连不上。
 * 这个脚本把「Hub 真的挂了」这一种场景完整走一遍（浏览器回退路径，非原生环境）：
 *
 *   A. 一切正常时，登录页**没有**「网络检测」按钮；
 *   B. 把 mock Hub 停掉 → 登录报「网络连接失败」→ 按钮出现；
 *   C. 点开弹层：三行（手机网络 / 互联网 / DSH Hub）依次出结果，Hub 行 ✗，
 *      结论是「服务器暂时连不上，不是手机的问题」，且非原生环境**没有**设置类按钮；
 *   C2. 对照站点也不通时结论变成「网络受限」，设置类按钮依然不显示（这就是非原生的过滤）；
 *   D. 恢复 Hub 后点「重新检测」→ 三行全 ✓、结论「网络正常」→ 点「重新登录」真的能登进去。
 *
 * 对照站点不依赖外网：脚本自己起一个只回 200 的本地 HTTP 服务，通过
 * `window.__dshNetDiagControlSites` 注入（与页面里的 `controlSites()` 对应）。
 * 慢路径 `/__test/slow?ms=` 用来把「检测中」那一帧停住，好截图。
 *
 * 用法（脚本默认自己拉起 mock hub 5301 / vite 5302 / headless Chrome 9301，跑完按 PID 关掉）：
 *
 *   node scripts/e2e-net-diag.mjs --out /tmp/e2e-net-diag/out
 *
 * 已经手工起好服务时：
 *
 *   node scripts/e2e-net-diag.mjs --no-spawn --app http://127.0.0.1:5302 \
 *     --hub http://127.0.0.1:5301 --cdp 9301
 *
 * 截图（390×844 / DPR 3 / 亮色 → 写进 `--out`）：`01-login-error`（登录页错误 + 按钮）、
 * `02-sheet-checking`（弹层检测中）、`03-sheet-server`（服务器连不上）、`04-sheet-ok`（网络正常）。
 */

import fs from 'node:fs/promises'
import http from 'node:http'
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
const HUB_PORT = Number(args['hub-port'] ?? 5301)
const APP_PORT = Number(args['app-port'] ?? 5302)
const CDP_PORT = Number(args.cdp ?? 9301)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-net-diag-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
/** 移动端视口（iPhone 12/13/14 = 390×844）。 */
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

// ── 本地「对照站点」（不碰外网）─────────────────────────────────────────────

let controlServer = null
let controlPort = 0
let controlHits = 0

function startControlServer() {
  return new Promise((resolve, reject) => {
    controlServer = http.createServer((req, res) => {
      controlHits++
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${controlPort}`)
      const reply = () => {
        try {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('ok')
        } catch {
          /* 服务在关的时候可能已经断了 */
        }
      }
      if (url.pathname === '/__test/slow') {
        const ms = Math.min(8000, Number(url.searchParams.get('ms') ?? '1500') || 1500)
        setTimeout(reply, ms).unref?.()
        return
      }
      if (url.pathname === '/__test/slowfail') {
        // 慢慢失败：用来把「检测中（按钮禁用）」那一小段时间停住
        const ms = Math.min(8000, Number(url.searchParams.get('ms') ?? '1200') || 1200)
        setTimeout(() => {
          try {
            req.socket.destroy()
          } catch {
            /* ignore */
          }
        }, ms).unref?.()
        return
      }
      reply()
    })
    controlServer.on('error', reject)
    controlServer.listen(0, '127.0.0.1', () => {
      controlPort = controlServer.address().port
      resolve()
    })
  })
}

const fastControl = () => `http://127.0.0.1:${controlPort}/__test/health`
const slowControl = () => `http://127.0.0.1:${controlPort}/__test/slow?ms=2000`
const slowFailControl = () => `http://127.0.0.1:${controlPort}/__test/slowfail?ms=1200`

/** 把对照站点注入到页面（浏览器回退没有别的办法覆盖默认的百度/腾讯）。 */
async function setControlSites(cdp, sites) {
  await cdp.eval(
    `(() => { window.__dshNetDiagControlSites = ${JSON.stringify(sites)}; return true })()`,
  )
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

async function waitHttpDown(url, { timeout = 5000 } = {}) {
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
}

async function startChrome() {
  profileDir = `/tmp/e2e-profile-net-diag-${Date.now()}`
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
  if (controlServer) {
    await new Promise((resolve) => controlServer.close(resolve))
    controlServer = null
  }
  if (profileDir) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 页面读取 ────────────────────────────────────────────────────────────────

const ROW_STATES = `(() => {
  const out = {}
  for (const el of document.querySelectorAll('[data-step]')) {
    out[el.getAttribute('data-step')] = el.getAttribute('data-state')
  }
  return out
})()`

const SHEET = `(() => {
  const title = document.querySelector('.diag__title')
  const detail = document.querySelector('.diag__detail')
  const btn = [...document.querySelectorAll('.diag__btn')]
  return {
    open: !!document.querySelector('.sheet'),
    title: title ? title.innerText.trim() : '',
    detail: detail ? detail.innerText.trim() : '',
    actions: [...document.querySelectorAll('[data-action]')].map((el) => el.getAttribute('data-action')),
    labels: [...document.querySelectorAll('.diag__btn')].map((el) => el.innerText.trim()),
    disabled: btn.length > 0 ? btn.every((el) => el.disabled) : null,
  }
})()`

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

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  await startControlServer()
  console.log(`[e2e] 本地对照站点 :${controlPort}（不依赖外网）`)
  await startServers()

  const cdp = await Cdp.attach(CDP_PORT)
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

  // 干净登录页（只改 hash 不会重载 SPA，先走 about:blank）
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload')
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
  expect(`构建产物指向本机 mock Hub（当前 ${origin}）`, origin === HUB_URL, origin)

  // ── A. 一切正常时没有「网络检测」按钮
  const initialButton = await cdp.eval(`!!document.querySelector('.login__diag')`)
  expect('A 正常时登录页没有「网络检测」按钮', initialButton === false)

  // ── B. Hub 停掉 → 登录报网络错误 → 按钮出现
  await stopHub()
  await fillLogin(cdp, 'demo', 'demo1234')
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(
    cdp,
    `document.querySelector('.login__error')?.innerText.includes('网络连接失败')`,
    { label: '登录报网络错误' },
  )
  const errorText = await cdp.eval(`document.querySelector('.login__error').innerText.trim()`)
  expect('B 登录报出网络错误', errorText.includes('网络连接失败'), errorText)
  const afterErrorButton = await cdp.eval(`!!document.querySelector('.login__diag')`)
  expect('B 报网络错误后出现「网络检测」按钮', afterErrorButton === true)
  await cdp.shot('01-login-error')

  // ── C. 点开弹层：检测中 → 三行结果 → 服务器结论
  await setControlSites(cdp, [slowControl()])
  const hitsBefore = controlHits
  await cdp.eval(`document.querySelector('.login__diag').click()`)
  await waitFor(cdp, `document.querySelector('.sheet')`, { label: '弹层' })
  await sleep(260)
  const midRows = await cdp.eval(ROW_STATES)
  const midSheet = await cdp.eval(SHEET)
  expect(
    'C 检测中：手机网络这一行已经出结果',
    midRows.phone === 'ok' || midRows.phone === 'fail',
    midRows,
  )
  expect('C 检测中：互联网行还在跑', midRows.internet === 'running', midRows)
  expect('C 检测中：还没有结论', midSheet.title === '', midSheet)
  await cdp.shot('02-sheet-checking')

  await waitFor(cdp, `document.querySelector('.diag__title')`, { label: '检测结论' })
  const rowsC = await cdp.eval(ROW_STATES)
  const sheetC = await cdp.eval(SHEET)
  expect('C 手机网络行 ✓', rowsC.phone === 'ok', rowsC)
  expect('C 互联网行 ✓（注入的本地对照站点）', rowsC.internet === 'ok', rowsC)
  expect('C DSH Hub 行 ✗', rowsC.hub === 'fail', rowsC)
  expect(
    'C 结论是「服务器暂时连不上，不是手机的问题」',
    sheetC.title.includes('服务器暂时连不上') && sheetC.title.includes('不是手机的问题'),
    sheetC.title,
  )
  expect('C 非原生环境没有「去设置」', !sheetC.actions.includes('openAppSettings'), sheetC.actions)
  expect(
    'C 非原生环境没有「打开网络设置」',
    !sheetC.actions.includes('openNetworkSettings'),
    sheetC.actions,
  )
  expect('C 有「重新检测」按钮', sheetC.actions.includes('retry'), sheetC.actions)
  expect(
    'C 对照站点用的是注入地址（没有走外网）',
    controlHits > hitsBefore,
    `hits ${hitsBefore} → ${controlHits}`,
  )
  await cdp.shot('03-sheet-server')

  // ── C2. 对照站点也不通（本地慢失败端点）→ 网络受限；设置类按钮仍不显示
  await setControlSites(cdp, [slowFailControl()])
  await cdp.eval(`document.querySelector('[data-action="retry"]').click()`)
  await sleep(220)
  const busySheet = await cdp.eval(SHEET)
  expect('C2 重新检测期间按钮禁用', busySheet.disabled === true, busySheet)
  await waitFor(
    cdp,
    `document.querySelector('.diag__title')?.innerText.includes('受限')`,
    { label: '网络受限结论' },
  )
  const sheetC2 = await cdp.eval(SHEET)
  expect('C2 两组都不通 → 结论「网络受限」', sheetC2.title.includes('受限'), sheetC2.title)
  expect(
    'C2 受限结论本来带「打开网络设置」，非原生被过滤掉',
    !sheetC2.actions.includes('openNetworkSettings') && sheetC2.actions.includes('retry'),
    sheetC2.actions,
  )

  // ── D. 恢复 Hub → 重新检测 → 网络正常 → 重新登录成功
  await startHub()
  await setControlSites(cdp, [fastControl()])
  await cdp.eval(`document.querySelector('[data-action="retry"]').click()`)
  await waitFor(
    cdp,
    `document.querySelector('.diag__title')?.innerText.includes('网络正常')`,
    { label: '网络正常结论' },
  )
  const rowsD = await cdp.eval(ROW_STATES)
  const sheetD = await cdp.eval(SHEET)
  expect('D 手机网络行 ✓', rowsD.phone === 'ok', rowsD)
  expect('D 互联网行 ✓', rowsD.internet === 'ok', rowsD)
  expect('D DSH Hub 行 ✓', rowsD.hub === 'ok', rowsD)
  expect('D 结论「网络正常」', sheetD.title.includes('网络正常'), sheetD.title)
  await cdp.shot('04-sheet-ok')

  await cdp.eval(`document.querySelector('[data-action="relogin"]').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    timeout: 20000,
    label: '重新登录成功',
  })
  const phase = await cdp.eval(`window.__dshHub?.auth.phase ?? ''`)
  expect('D 点「重新登录」后真的登进去了', phase === 'authenticated', phase)
  const sheetGone = await cdp.eval(`!!document.querySelector('.sheet')`)
  expect('D 弹层已关闭', sheetGone === false)

  const passed = checks.filter((item) => item.ok).length
  const report = { at: new Date().toISOString(), viewport: VIEWPORT, checks }
  await fs.writeFile(path.join(OUT, 'net-diag-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'net-diag-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

main()
  .catch((error) => {
    console.error('e2e 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServers()
  })
