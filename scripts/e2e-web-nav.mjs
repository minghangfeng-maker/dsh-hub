#!/usr/bin/env node
/**
 * 手机网页版「返回键 / 生命周期 / 键盘」e2e（WP54 / W2）。
 *
 * 目标：网页构建（`VITE_TARGET=web` → `IS_WEB_BUILD`）下，浏览器返回、侧滑返回、
 * Android 系统返回的效果和 APK 的物理返回键一模一样；切前后台、bfcache 恢复、
 * 键盘弹出也都有 APK 的等价行为。
 *
 * 覆盖：
 *  A. 环境：网页构建标记、历史守卫常驻、整页回弹/下拉刷新关掉、输入框字号 ≥16px；
 *  B. 返回键：抽屉 → back 关闭；底部弹层（模型弹层）→ back 关闭；抽屉 + 会话长按菜单
 *     连开两层 → back 两次逐层关；× / 遮罩关闭后 back 不离开页面；首页 back 停在首页并给提示；
 *     对话页 back 回首页；整个过程历史长度不增长（不按层堆积、不多退一步）；
 *     长按期间浏览器不给选字/系统菜单；
 *  C. 生命周期：隐藏 → 断开通道；可见 → 重连探活；bfcache 的 `pageshow persisted` → 重连；
 *     Page Lifecycle 的 freeze → 断开、resume → 重连（都看真 Hub 的通道数 + 诊断事件）；
 *  D. 键盘：`visualViewport` 缩小（无 `interactive-widget` meta 的形态）→ 整壳缩到可视高度，
 *     输入框仍在可视区；恢复后回到全高；布局视口自己缩（有 meta 的形态）时不额外缩壳。
 *
 * 用法（必须先带 VITE_TARGET=web 起 vite；`scripts/e2e-run.sh web-nav` 已经这么做了）：
 *   VITE_TARGET=web VITE_HUB_ORIGIN=http://127.0.0.1:5410 \
 *     (cd packages/mobile-ui && ./node_modules/.bin/vite --port 5411 --strictPort --host 127.0.0.1)
 *   TICK_MS=12 PORT=5410 node apps/mock-hub/server.mjs
 *   node scripts/e2e-web-nav.mjs --app http://127.0.0.1:5411 --hub http://127.0.0.1:5410 \
 *     --cdp 9410 --out /tmp/e2e-web-nav
 *
 * **无法在 headless Chrome 里验证的部分**（留给真机）：
 *  - iOS Safari 真实键盘弹出时的 visualViewport 尺寸/滚动时序（这里用假 height + resize 事件模拟）；
 *  - iOS 的橡皮筋与下拉刷新（Chrome headless 不做 overscroll 手势）；
 *  - Android 系统/侧滑返回手势（这里用 `history.back()`，与浏览器返回走同一条 popstate）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9410)
const APP_URL = (args.app ?? 'http://127.0.0.1:5411').replace(/\/$/, '')
const HUB_URL = (args.hub ?? 'http://127.0.0.1:5410').replace(/\/$/, '')
const OUT = args.out ?? 'e2e-web-nav-output'
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
/** 假键盘高度（模拟 Chrome 默认 resizes-visual / iOS Safari 的 320px 键盘）。 */
const KEYBOARD_PX = 320

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
  const shown =
    detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? '✓' : '✗'} ${name}${shown}`)
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

async function touchStart(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
}
async function touchEnd(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 元素中心点（真实触摸命中，不走 DOM click）。 */
async function centerOf(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
  })()`)
  if (!rect) throw new Error(`找不到元素：${selector}`)
  return rect
}

async function tap(cdp, selector) {
  const point = await centerOf(cdp, selector)
  await tapPoint(cdp, point.x, point.y)
}

/** 点坐标（遮罩那种「中心点其实在抽屉上」的情况用）。 */
async function tapPoint(cdp, x, y) {
  await touchStart(cdp, x, y)
  await sleep(60)
  await touchEnd(cdp)
  await sleep(220)
}

/** 按住 700ms（长按阈值 500ms）再松手。 */
async function longPress(cdp, selector, holdMs = 700) {
  const point = await centerOf(cdp, selector)
  await touchStart(cdp, point.x, point.y)
  await sleep(holdMs)
  await touchEnd(cdp)
  await sleep(300)
}

async function hubStatus() {
  return (await fetch(`${HUB_URL}/__test/status?user=demo`)).json()
}

/** 浏览器返回 / 侧滑返回 / Android 系统返回在网页里都是同一个动作。 */
async function browserBack(cdp) {
  await cdp.eval('history.back()')
  await sleep(320)
}

let cdpRef = null

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const cdp = await Cdp.attach(CDP_PORT)
  cdpRef = cdp
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  const consoleErrors = []
  const onConsole = (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  }
  cdp.listeners.set('Runtime.consoleAPICalled', new Set([onConsole]))

  // ── 0. 干净状态 + 登录 ────────────────────────────────────────────────────
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1000)

  const isWebBuild = await cdp.eval(
    `document.documentElement.classList.contains('is-web') && !!window.__dshHub`,
  )
  if (!isWebBuild) {
    throw new Error(
      '这个构建不是网页版：vite 必须带 VITE_TARGET=web 起（web-nav 已登记在 scripts/e2e-run.sh）',
    )
  }

  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
  expect(`构建产物指向本机 mock Hub（${origin}）`, origin === HUB_URL, origin)

  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo'); set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: '通道连上' })
  await waitFor(cdp, `window.__dshHub.chat.sessions.length >= 2`, {
    timeout: 15000,
    label: '会话列表',
  })
  await cdp.eval(`window.__dshHub.router.replace('/')`)
  await waitFor(cdp, `window.__dshHub.router.currentRoute.value.name === 'home'`, {
    label: '首页',
  })
  await sleep(400)
  // 用一个不随组件重渲染丢失的标记判断「页面有没有被重新加载/离开」
  const probe = await cdp.eval(`(window.__webNavProbe = Math.random().toString(36).slice(2))`)
  await cdp.shot('01-home')

  // ── 1. A 组：网页构建的基本环境 ──────────────────────────────────────────
  const env = await cdp.eval(`(() => {
    const root = document.documentElement
    return {
      isWeb: root.classList.contains('is-web'),
      guard: root.ownerDocument.defaultView.history.state,
      overscrollHtml: getComputedStyle(root).overscrollBehavior,
      overscrollBody: getComputedStyle(document.body).overscrollBehaviorY,
      overscrollThread: (() => { const t = document.createElement('div'); t.className = 'thread'; document.body.appendChild(t); const v = getComputedStyle(t).overscrollBehaviorY; t.remove(); return v })(),
      historyLength: history.length,
      href: location.href,
      probe: window.__webNavProbe,
    }
  })()`)
  expect('网页构建：<html class="is-web">', env.isWeb === true, env.isWeb)
  expect(
    '历史栈顶常驻守卫记录（URL 不变，返回先交给 App）',
    env.guard?.__dshBackGuard === 1,
    env.guard,
  )
  expect('整页下拉刷新/橡皮筋关掉（html overscroll-behavior: none）', env.overscrollHtml === 'none', env.overscrollHtml)
  expect('列表内部滚动保留（.thread overscroll-behavior-y: contain）', env.overscrollThread === 'contain', env.overscrollThread)

  const composerFont = await cdp.eval(
    `(() => { const el = document.querySelector('.composer__input'); return el ? getComputedStyle(el).fontSize : null })()`,
  )
  expect('输入框字号 ≥16px（iOS 聚焦不放大页面）', parseFloat(composerFont ?? '0') >= 16, composerFont)

  // ── 2. B 组：抽屉 → back 关闭；长按菜单两层逐层关 ───────────────────────
  const historyBeforeDrawer = await cdp.eval('history.length')
  await tap(cdp, '.app-header .icon-btn[aria-label="打开抽屉"]')
  await waitFor(cdp, `window.__dshHub.ui.drawerOpen === true`, { label: '抽屉打开' })
  const afterOpen = await cdp.eval(`({ len: history.length, state: history.state })`)
  expect(
    '打开抽屉不新增历史记录（层层 pushState 会越积越多）',
    afterOpen.len === historyBeforeDrawer,
    { before: historyBeforeDrawer, after: afterOpen.len },
  )
  const searchFont = await cdp.eval(
    `getComputedStyle(document.querySelector('.drawer__search input')).fontSize`,
  )
  expect('抽屉搜索框字号也 ≥16px（组件 scoped 样式被网页版规则压过）', parseFloat(searchFont) >= 16, searchFont)
  await cdp.shot('02-drawer')

  // 长按会话：进入「dialog」层（抽屉 → 长按菜单 两层同时打开）
  const convSel = '.drawer__conv'
  // 诊断：记录这一下按压里浏览器到底发了哪些事件（长按不灵时一眼看出是谁先取消了）
  await cdp.eval(`(() => {
    window.__pressLog = []
    const el = document.querySelector(${JSON.stringify(convSel)})
    if (!el) return false
    const t0 = performance.now()
    for (const name of ['pointerdown','pointermove','pointerup','pointercancel','contextmenu','click','touchstart','touchend','touchcancel'])
      el.addEventListener(name, () => window.__pressLog.push(name + '@' + Math.round(performance.now() - t0)), true)
    return true
  })()`)
  const pressPoint = await centerOf(cdp, convSel)
  await touchStart(cdp, pressPoint.x, pressPoint.y)
  await sleep(200) // 还没到 500ms 的长按阈值
  const pressing = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(convSel)})
    const snapshot = {
      pressing: document.documentElement.classList.contains('long-pressing'),
      userSelect: getComputedStyle(el).userSelect,
      sheetOpenYet: window.__dshHub.ui.sessionAction !== null,
    }
    window.__pressingSeen = snapshot
    return snapshot
  })()`)
  await sleep(450) // 越过 500ms：长按计时器触发
  // 计时器已经触发过了，这时再补一个 contextmenu：只该被 preventDefault（不该重复开菜单）
  const contextMenuPrevented = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(convSel)})
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  })()`)
  await touchEnd(cdp)
  try {
    await waitFor(cdp, `window.__dshHub.ui.sessionAction !== null`, {
      timeout: 6000,
      label: '会话长按菜单',
    })
  } catch (error) {
    const diag = await cdp.eval(`({
      pressLog: window.__pressLog,
      pressingSeen: window.__pressingSeen ?? null,
      drawerOpen: window.__dshHub.ui.drawerOpen,
      sessionAction: window.__dshHub.ui.sessionAction,
      route: window.__dshHub.router.currentRoute.value.name,
      convRows: document.querySelectorAll('.drawer__conv').length,
      recentRows: document.querySelectorAll('.drawer__recent .drawer__conv').length,
      stillPressing: document.documentElement.classList.contains('long-pressing'),
      htmlClasses: [...document.documentElement.classList],
    })`)
    console.error('长按诊断：', JSON.stringify(diag))
    throw error
  }
  const twoLayers = await cdp.eval(
    `({ drawer: window.__dshHub.ui.drawerOpen, dialog: window.__dshHub.ui.sessionAction !== null })`,
  )
  expect(
    '按住还没到长按阈值：浏览器选字被压住（html.long-pressing）、菜单未开',
    pressing.pressing === true && pressing.sheetOpenYet === false,
    pressing,
  )
  expect('长按的会话行 user-select: none', pressing.userSelect === 'none', pressing.userSelect)
  expect('长按的 contextmenu 被 preventDefault（不弹系统菜单、也不重复开菜单）', contextMenuPrevented === true, contextMenuPrevented)
  expect('长按打开了会话菜单（dialog 层），抽屉还在（两层同时打开）', twoLayers.drawer && twoLayers.dialog, twoLayers)
  const released = await cdp.eval(`document.documentElement.classList.contains('long-pressing')`)
  expect('松手后恢复文本选择', released === false, released)
  await cdp.shot('03-two-layers')

  // 第一次 back：只关最上层的会话菜单，抽屉仍在
  await browserBack(cdp)
  await waitFor(cdp, `window.__dshHub.ui.sessionAction === null`, { label: '会话菜单关闭' })
  const afterFirstBack = await cdp.eval(`({ drawer: window.__dshHub.ui.drawerOpen, href: location.href })`)
  expect('连开两层：第 1 次 back 只关最上层（会话菜单）', afterFirstBack.drawer === true, afterFirstBack)
  expect('第 1 次 back 没有离开页面（URL 不变）', afterFirstBack.href === env.href, afterFirstBack.href)
  await cdp.shot('04-after-first-back')

  // 第二次 back：关抽屉
  await browserBack(cdp)
  await waitFor(cdp, `window.__dshHub.ui.drawerOpen === false`, { label: '抽屉关闭' })
  const afterSecondBack = await cdp.eval(`({ href: location.href, probe: window.__webNavProbe, len: history.length })`)
  expect('第 2 次 back 关抽屉（URL 仍是首页）', afterSecondBack.href === env.href, afterSecondBack.href)
  expect(
    '历史长度没有随「开/关层」增长（守卫复用，不按层堆积）',
    afterSecondBack.len <= historyBeforeDrawer + 1,
    { start: historyBeforeDrawer, now: afterSecondBack.len },
  )
  expect('页面没有被重新加载（同一个 JS 上下文）', afterSecondBack.probe === probe, afterSecondBack.probe)

  // ── 3. B 组：界面上的 × / 遮罩关闭后再 back 也不离开页面 ─────────────────
  const beforeClose = await cdp.eval('history.length')
  await tap(cdp, '.app-header .icon-btn[aria-label="打开抽屉"]')
  await waitFor(cdp, `window.__dshHub.ui.drawerOpen === true`, { label: '抽屉再次打开' })
  // 遮罩中心点其实压在抽屉上（抽屉宽 330/412），点抽屉右侧的遮罩区
  await tapPoint(cdp, VIEWPORT.width - 12, Math.round(VIEWPORT.height / 2))
  await waitFor(cdp, `window.__dshHub.ui.drawerOpen === false`, { label: '遮罩关闭抽屉' })
  const afterClose = await cdp.eval('history.length')
  expect('用遮罩/× 关闭不压历史、也不退一步', afterClose === beforeClose, {
    before: beforeClose,
    after: afterClose,
  })
  await browserBack(cdp)
  const afterCloseBack = await cdp.eval(
    `({ href: location.href, probe: window.__webNavProbe, len: history.length })`,
  )
  expect('× 关闭后按 back 仍停在首页（不会离开 /m/）', afterCloseBack.href === env.href, afterCloseBack.href)
  expect('× 关闭后按 back 没有重新加载页面', afterCloseBack.probe === probe, afterCloseBack.probe)

  // ── 4. B 组：首页 back 不离开，并给「已经在首页了」提示 ───────────────────
  const beforeHomeBack = await cdp.eval('history.length')
  await browserBack(cdp)
  await sleep(300)
  const homeBack = await cdp.eval(`({
    href: location.href,
    probe: window.__webNavProbe,
    toast: window.__dshHub.ui.toastText,
    route: window.__dshHub.router.currentRoute.value.name,
    len: history.length,
    guard: history.state,
  })`)
  expect('首页 back 不离开页面', homeBack.href === env.href && homeBack.probe === probe, homeBack)
  expect('首页 back 给提示「已经在首页了」（APK 是退到桌面，网页里不能真退）', homeBack.toast === '已经在首页了', homeBack.toast)
  expect('首页 back 后仍在首页路由', homeBack.route === 'home', homeBack.route)
  expect('首页 back 后守卫仍在栈顶、历史长度不变', homeBack.guard?.__dshBackGuard === 1 && homeBack.len === beforeHomeBack, {
    guard: homeBack.guard,
    before: beforeHomeBack,
    after: homeBack.len,
  })
  await cdp.shot('05-home-back-toast')

  // ── 5. B 组：底部弹层（模型弹层）→ back 关闭；对话页 back 回首页 ──────────
  // 先种 4 轮对话：让问题导航条（≥3 条提问才出现）在键盘那节真的挂在页面上
  await fetch(`${HUB_URL}/__test/seed-thread?session=s_mock_plan&turns=4`, { method: 'POST' })
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await waitFor(cdp, `window.__dshHub.router.currentRoute.value.name === 'conversation'`, {
    label: '对话页',
  })
  await waitFor(cdp, `document.querySelector('.composer__input')`, { label: '输入卡' })
  await sleep(600)
  await tap(cdp, '.chip__part--model')
  await waitFor(cdp, `window.__dshHub.ui.modelSheetOpen === true`, { label: '模型弹层' })
  await cdp.shot('06-model-sheet')
  await browserBack(cdp)
  await waitFor(cdp, `window.__dshHub.ui.modelSheetOpen === false`, { label: '模型弹层关闭' })
  const sheetBack = await cdp.eval(
    `({ route: window.__dshHub.router.currentRoute.value.name, probe: window.__webNavProbe })`,
  )
  expect('底部弹层 → back 关闭', sheetBack.route === 'conversation', sheetBack)
  expect('关闭弹层后仍在对话页、没有重新加载', sheetBack.probe === probe, sheetBack.probe)

  // 对话页 back → 首页（与 APK 的「对话页回首页」一致）
  await browserBack(cdp)
  await waitFor(cdp, `window.__dshHub.router.currentRoute.value.name === 'home'`, {
    timeout: 8000,
    label: '对话页 back 回首页',
  })
  const convBack = await cdp.eval(`({ route: window.__dshHub.router.currentRoute.value.name, probe: window.__webNavProbe })`)
  expect('对话页 back 回首页（与 APK 一致，不是退到浏览器上一页）', convBack.route === 'home', convBack)
  expect('对话页 back 没有重新加载页面', convBack.probe === probe, convBack.probe)

  // ── 6. C 组：生命周期（隐藏断开 / 可见重连 / bfcache / freeze-resume）──────
  const hideExpr = `(() => {
    window.__fakeHidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__fakeHidden })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__fakeHidden ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    return true
  })()`
  const showExpr = `(() => {
    window.__fakeHidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    return true
  })()`
  const restoreVisibility = `(() => {
    delete document.hidden
    delete document.visibilityState
    return true
  })()`

  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: '回首页后仍连着' })
  const channelsBefore = (await hubStatus()).channels
  await cdp.eval(hideExpr)
  await waitFor(cdp, `window.__dshHub.chat.link !== 'connected'`, { timeout: 8000, label: '切后台断开通道' })
  await sleep(600)
  const hidden = await cdp.eval(`({ link: window.__dshHub.chat.link })`)
  const channelsHidden = (await hubStatus()).channels
  expect('切到后台（visibilitychange hidden）干净断开通道，不伪装还连着', hidden.link !== 'connected', {
    link: hidden.link,
    channels: channelsHidden,
  })

  await cdp.eval(showExpr)
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: '回前台重连' })
  const shown = await cdp.eval(`(() => {
    const raw = localStorage.getItem('dsh-hub:diagnostics:v1')
    const events = raw ? JSON.parse(raw) : []
    return {
      link: window.__dshHub.chat.link,
      channels: null,
      lifecycle: events.filter((e) => e.name === 'lifecycle').map((e) => e.detail).slice(-4),
    }
  })()`)
  const channelsVisible = (await hubStatus()).channels
  expect('回前台（visibilitychange visible）重新连上通道', shown.link === 'connected', {
    link: shown.link,
    channelsBefore,
    channelsVisible,
  })
  expect('通道数真的回到了 Hub（0 → 1）', channelsVisible === 1, { channelsHidden, channelsVisible })
  expect(
    '诊断里记下了 lifecycle:visibility:active（排查「回前台怎么没重连」用）',
    shown.lifecycle.includes('visibility:active') && shown.lifecycle.includes('visibility:inactive'),
    shown.lifecycle,
  )

  // bfcache 恢复：页面还在（没重新加载），WebSocket 早就断了 —— pageshow(persisted) 必须触发重连
  await cdp.eval(hideExpr)
  await waitFor(cdp, `window.__dshHub.chat.link !== 'connected'`, { timeout: 8000, label: '进 bfcache 前断开' })
  await sleep(400)
  const afterHideAgain = await cdp.eval(`window.__dshHub.chat.link`)
  await cdp.eval(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`)
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: 'bfcache 恢复后重连' })
  const bfcache = await cdp.eval(`(() => {
    const raw = localStorage.getItem('dsh-hub:diagnostics:v1')
    const events = raw ? JSON.parse(raw) : []
    return {
      link: window.__dshHub.chat.link,
      probe: window.__webNavProbe,
      lifecycle: events.filter((e) => e.name === 'lifecycle').map((e) => e.detail).slice(-4),
    }
  })()`)
  expect('bfcache 的 pageshow(persisted) 触发重连（断开时页面并没有重新加载）', afterHideAgain !== 'connected' && bfcache.link === 'connected', {
    before: afterHideAgain,
    after: bfcache.link,
  })
  expect('bfcache 恢复沿用同一个 JS 上下文（不是整页 reload 的假象）', bfcache.probe === probe, bfcache.probe)
  expect('诊断里记下了 lifecycle:pageshow:active', bfcache.lifecycle.includes('pageshow:active'), bfcache.lifecycle)

  // Page Lifecycle：freeze 断开、resume 强制重连
  await cdp.eval(restoreVisibility)
  await cdp.eval(`document.dispatchEvent(new Event('freeze'))`)
  await waitFor(cdp, `window.__dshHub.chat.link !== 'connected'`, { timeout: 8000, label: 'freeze 断开' })
  await cdp.eval(`document.dispatchEvent(new Event('resume'))`)
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: 'resume 重连' })
  const frozenResumed = await cdp.eval(`window.__dshHub.chat.link`)
  expect('Page Lifecycle 的 freeze → 断开、resume → 重连', frozenResumed === 'connected', frozenResumed)
  await cdp.shot('07-after-lifecycle')

  // ── 7. D 组：键盘（visualViewport）────────────────────────────────────────
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await waitFor(cdp, `document.querySelector('.composer__input')`, { label: '对话页输入卡' })
  await waitFor(cdp, `document.querySelector('.rail')`, { timeout: 15000, label: '问题导航条' })
  await sleep(500)

  const threadBefore = await cdp.eval(
    `Math.round(document.querySelector('.thread').getBoundingClientRect().height)`,
  )
  const keyboardLayout = await cdp.eval(`(() => {
    const vv = window.visualViewport
    Object.defineProperty(vv, 'height', { configurable: true, get: () => ${VIEWPORT.height - KEYBOARD_PX} })
    vv.dispatchEvent(new Event('resize'))
    const shell = document.querySelector('.app-shell')
    const input = document.querySelector('.composer__input')
    const card = document.querySelector('.composer__card')
    const thread = document.querySelector('.thread')
    const rail = document.querySelector('.rail')
    const visibleBottom = window.innerHeight - ${KEYBOARD_PX}
    const inputRect = input.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      appHeightVar: document.documentElement.style.getPropertyValue('--app-height'),
      kbInsetVar: document.documentElement.style.getPropertyValue('--kb-inset'),
      kbState: document.documentElement.dataset.kb ?? null,
      shellHeight: Math.round(shell.getBoundingClientRect().height),
      innerHeight: window.innerHeight,
      visibleBottom,
      threadHeight: Math.round(thread.getBoundingClientRect().height),
      inputTop: Math.round(inputRect.top),
      inputBottom: Math.round(inputRect.bottom),
      cardBottom: Math.round(cardRect.bottom),
      inputInView: inputRect.top >= 0 && inputRect.bottom <= visibleBottom + 1,
      railInView: rail ? rail.getBoundingClientRect().bottom <= visibleBottom + 1 : null,
    }
  })()`)
  const expectedHeight = VIEWPORT.height - KEYBOARD_PX
  expect('键盘弹起（无 interactive-widget meta 的形态）→ 整壳缩到可视高度', keyboardLayout.shellHeight === expectedHeight, keyboardLayout)
  expect(`--app-height = ${expectedHeight}px、--kb-inset = 0px（不叠加补偿）`, keyboardLayout.appHeightVar === `${expectedHeight}px` && keyboardLayout.kbInsetVar === '0px', keyboardLayout)
  expect('dataset.kb = open（真机可用它排查键盘时序）', keyboardLayout.kbState === 'open', keyboardLayout.kbState)
  expect('输入框仍在可视区内（没被键盘挡住）', keyboardLayout.inputInView === true, keyboardLayout)
  expect(
    '对话区（发送锚定的量高基准）跟着键盘变矮，问题导航条也在可视区内',
    keyboardLayout.threadHeight < threadBefore && keyboardLayout.railInView === true,
    { threadBefore, threadAfter: keyboardLayout.threadHeight, railInView: keyboardLayout.railInView },
  )
  await cdp.shot('08-keyboard-open')

  const restoredLayout = await cdp.eval(`(() => {
    const vv = window.visualViewport
    delete vv.height
    vv.dispatchEvent(new Event('resize'))
    return {
      appHeightVar: document.documentElement.style.getPropertyValue('--app-height'),
      shellHeight: Math.round(document.querySelector('.app-shell').getBoundingClientRect().height),
      kbState: document.documentElement.dataset.kb ?? null,
    }
  })()`)
  expect('键盘收起 → 壳回到全高', restoredLayout.shellHeight === VIEWPORT.height && restoredLayout.appHeightVar === '' && restoredLayout.kbState === 'closed', restoredLayout)

  // 有 meta 的形态：布局视口自己缩（resizes-content）→ 不额外缩壳，输入框照样在可视区
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height - KEYBOARD_PX,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await sleep(500)
  const withMeta = await cdp.eval(`(() => {
    const input = document.querySelector('.composer__input')
    const rect = input.getBoundingClientRect()
    return {
      appHeightVar: document.documentElement.style.getPropertyValue('--app-height'),
      innerHeight: window.innerHeight,
      visualHeight: Math.round(window.visualViewport.height),
      inputInView: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
      kbState: document.documentElement.dataset.kb ?? null,
    }
  })()`)
  expect('有 meta 的形态（布局视口自己缩）：不叠加缩壳，输入框仍在可视区', withMeta.appHeightVar === '' && withMeta.inputInView === true && withMeta.kbState === 'closed', withMeta)
  await cdp.shot('09-keyboard-meta-layout')

  // 恢复视口，回到首页收尾
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await sleep(300)
  await cdp.eval(`window.__dshHub.router.replace('/')`)
  await sleep(400)

  // ── 8. 收尾：无控制台 error ─────────────────────────────────────────────
  expect('无控制台 error', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const report = {
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    isWebBuild,
    checks,
    failed: checks.filter((c) => !c.ok),
    consoleErrors,
    finalState: await cdp.eval(`({
      route: window.__dshHub.router.currentRoute.value.name,
      guard: history.state,
      link: window.__dshHub.chat.link,
      historyLength: history.length,
      url: location.href,
    })`),
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${checks.length - report.failed.length}/${checks.length} 通过（report.json 在 ${OUT}）`)
  cdp.ws.close()
  process.exit(report.failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  try {
    cdpRef?.ws.close()
  } catch {
    /* ignore */
  }
  // 显式退出：CDP 的 WebSocket 还在时 node 不会自己结束（会白等运行器 600 秒超时）
  process.exit(1)
})
