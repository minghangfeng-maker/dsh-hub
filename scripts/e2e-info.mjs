#!/usr/bin/env node
/**
 * 对话页 ⋮ 菜单、右侧全屏面板与首页/对话页顶栏的 e2e（0.4.0 A 部分：§1.1–§1.4）。
 *
 * 覆盖：
 *   1. 对话页顶栏：左侧 ☰ 打开抽屉、**中间没有标题**、右上「新对话」+「⋮」，热区 44×44、图标 24px；
 *   2. ⋮ 菜单：锚右上、宽 220、160ms 弹出、标题行 + 四项（重命名 / Token 用量 / 连接诊断 / 归档），
 *      归档是红色；首页没有 ⋮；
 *   3. 重命名：菜单项 → 居中对话框（预填标题、空标题禁用保存）→ 保存 → chat.renameSession + Hub 标题变化；
 *   4. Token 用量面板：从右滑入、满屏、← 返回；八项数据、loading/失败重试/暂无数据三种状态；
 *      打开调 loadSessionUsage，关闭调 clearSessionUsage；
 *   5. 连接诊断面板：链路状态 + 事件列表 + 事件总数；「复制诊断信息」生成的文本含版本/事件、不含会话标题；
 *   6. 面板右滑关闭；
 *   7. 返回键层级：面板 → 菜单 → 对话框 逐层被吃掉（真实 store + 真实 DOM）；
 *   8. 归档：菜单 → 二次确认（说明可找回）→ 确认 → Hub 归档集合 + 回首页 + 会话从列表消失；
 *   9. 能力降级：features 缺 rename/archive 时两项置灰并给出提示；
 *  10. 顶栏滚动提示：内容滚动后出现 0.5px 发丝线；
 *  11. 控制台无 error。
 *
 * 用法（mock Hub + vite dev/preview + Chrome CDP 先起好；端口按本机空闲情况替换）：
 *   TICK_MS=12 PORT=5243 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5243 ./node_modules/.bin/vite --port 5244 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9251 \
 *     --user-data-dir=/tmp/chrome-profile about:blank &
 *   node scripts/e2e-info.mjs --app http://127.0.0.1:5244 --hub http://127.0.0.1:5243 --cdp 9251 \
 *        --out ../mobile-plan/v2/artifacts/info-menu
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9242)
const APP_URL = args.app ?? 'http://127.0.0.1:5243'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5246'
const OUT = args.out ?? 'e2e-info-output'
/** 0.4.0 验收口径：412×915 / DPR 2.625（与交付截图一致）。 */
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

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
    return file
  }
}

const checks = []
function expect(name, ok, detail) {
  checks.push({ name, ok, detail })
  const shown = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
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
async function touchMove(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
}
async function touchEnd(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 元素中心点（用于真实触摸命中测试）。 */
async function centerOf(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  })()`)
  if (!rect) throw new Error(`找不到元素：${selector}`)
  return rect
}

/**
 * 真触摸点按（不是 DOM click）：能覆盖按钮的命中区域与 WebView 的默认行为。
 *
 * 目标在可视区外时先滚到中间再点——触摸事件按坐标派发，滚出屏幕的元素点不到。
 */
async function tap(cdp, selector) {
  let point = await centerOf(cdp, selector)
  const vh = await cdp.eval(`window.innerHeight`)
  if (point.y < 4 || point.y > vh - 4) {
    await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`)
    await sleep(220)
    point = await centerOf(cdp, selector)
  }
  await touchStart(cdp, point.x, point.y)
  await sleep(60)
  await touchEnd(cdp)
  await sleep(260)
}

async function hubStatus() {
  return (await fetch(`${HUB_URL}/__test/status`)).json()
}

/** 打开 ⋮ 菜单并等它出现。 */
async function openMenu(cdp) {
  await tap(cdp, 'button[aria-label="会话菜单"]')
  await waitFor(cdp, `document.querySelector('.session-menu')`, { label: '⋮ 菜单展开' })
  await sleep(200)
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
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
  // 固定浅色主题：断言里用到具体色值（白卡片 / 红色的归档）
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ── 0. 干净状态 + 登录 + 进对话页 ────────────────────────────────────────
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(900)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1000)
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
  await waitFor(
    cdp,
    `window.__dshHub.models.features.includes('rename') && window.__dshHub.models.features.includes('archive')`,
    { timeout: 15000, label: 'rename/archive 能力' },
  )

  // ── 1. 首页顶栏：☰ + 「新对话」置灰（空白新对话），没有 ⋮ ────────────────
  await waitFor(cdp, `document.querySelector('[data-header="home"]')`, { label: '首页顶栏' })
  const homeHeader = await cdp.eval(`(() => {
    const el = document.querySelector('[data-header="home"]')
    const buttons = [...el.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect()
      return {
        label: b.getAttribute('aria-label'),
        disabled: b.disabled === true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left),
        right: Math.round(r.right),
        icon: Math.round(b.querySelector('svg')?.getBoundingClientRect().width ?? 0),
      }
    })
    return { buttons, vw: window.innerWidth, activeId: window.__dshHub.chat.activeId }
  })()`)
  const homeDrawer = homeHeader.buttons.find((b) => b.label === '打开抽屉')
  const homeNew = homeHeader.buttons.find((b) => b.label === '新对话')
  expect(
    '首页顶栏：左侧 ☰、右上「新对话」（已空白新对话 → 置灰），没有 ⋮',
    !!homeDrawer && !!homeNew && homeHeader.buttons.length === 2 &&
      !homeHeader.buttons.some((b) => b.label === '会话菜单'),
    homeHeader.buttons,
  )
  expect(
    '首页「新对话」置灰（chat.activeId=null）+ 热区 44×44 + 图标 24px',
    homeHeader.activeId === null && homeNew?.disabled === true &&
      homeNew.w === 44 && homeNew.h === 44 && homeNew.icon === 24 &&
      homeDrawer?.w === 44 && homeDrawer?.h === 44 && homeDrawer?.icon === 24,
    { new: homeNew, drawer: homeDrawer },
  )
  await cdp.shot('00-home-header')

  // 进对话页
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await sleep(700)
  await waitFor(cdp, `document.querySelector('.thread')`, { label: '对话页' })
  await sleep(400)

  // ── 2. 对话页顶栏：☰ + 无标题 + 「新对话」+「⋮」 ─────────────────────────
  const convHeader = await cdp.eval(`(() => {
    const el = document.querySelector('[data-header="conversation"]')
    if (!el) return { exists: false }
    const buttons = [...el.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect()
      return {
        label: b.getAttribute('aria-label'),
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
        icon: Math.round(b.querySelector('svg')?.getBoundingClientRect().width ?? 0),
      }
    })
    const title = el.querySelector('.app-header__title')
    return {
      exists: true,
      buttons,
      titleText: title ? title.textContent.trim() : 'no-title-el',
      vw: window.innerWidth,
      headerH: Math.round(el.getBoundingClientRect().height),
      dividerOpacity: getComputedStyle(el, '::after').opacity,
    }
  })()`)
  const drawerBtn = convHeader.buttons.find((b) => b.label === '打开抽屉')
  const newBtn = convHeader.buttons.find((b) => b.label === '新对话')
  const menuBtn = convHeader.buttons.find((b) => b.label === '会话菜单')
  expect(
    '对话页顶栏三个按钮：☰（左）/ 新对话 / ⋮（最右）',
    convHeader.exists === true && convHeader.buttons.length === 3 &&
      !!drawerBtn && !!newBtn && !!menuBtn &&
      drawerBtn.left < VIEWPORT.width / 2 && menuBtn.right > VIEWPORT.width - 60 &&
      newBtn.right <= menuBtn.left + 1,
    convHeader.buttons,
  )
  expect(
    '对话页顶栏没有标题（§1.1：标题去掉）',
    convHeader.titleText === '',
    convHeader.titleText,
  )
  expect(
    '顶栏按钮热区 44×44、图标 24px',
    [drawerBtn, newBtn, menuBtn].every((b) => b && b.w === 44 && b.h === 44 && b.icon === 24),
    convHeader.buttons.map((b) => ({ label: b.label, w: b.w, h: b.h, icon: b.icon })),
  )
  expect('顶栏高度 52px、初始没有分隔线', convHeader.headerH === 52 && convHeader.dividerOpacity === '0', {
    h: convHeader.headerH,
    divider: convHeader.dividerOpacity,
  })
  await cdp.shot('01-conversation-header')

  // 滚动提示：内容滚到顶栏下方 → 出现 0.5px 发丝线（scaleY(0.5)）
  // mock 会话的内容可能不满一屏（不可滚动），临时塞一个占位块制造真实滚动；
  // 这里要验的是「滚动 → 发丝线」这条联动，不是内容本身。
  const scrollProbe = await cdp.eval(`(() => {
    const inner = document.querySelector('.thread__inner')
    const spacer = document.createElement('div')
    spacer.id = 'e2e-scroll-spacer'
    spacer.style.height = '900px'
    inner.appendChild(spacer)
    const el = document.querySelector('.thread')
    el.scrollTop = 400
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  })()`)
  await sleep(350)
  const scrolledHeader = await cdp.eval(`(() => {
    const el = document.querySelector('[data-header="conversation"]')
    const cs = getComputedStyle(el, '::after')
    return { cls: el.classList.contains('is-scrolled'), opacity: cs.opacity, transform: cs.transform }
  })()`)
  expect(
    '内容滚到顶栏下方时出现 0.5px 发丝线（scaleY(0.5)）',
    scrollProbe.scrollTop > 0 && scrolledHeader.cls === true &&
      scrolledHeader.opacity === '1' && /0\.5/.test(scrolledHeader.transform),
    { ...scrolledHeader, scroll: scrollProbe },
  )
  // 收起占位块并回到顶部：发丝线应该消失
  await cdp.eval(`(() => {
    document.getElementById('e2e-scroll-spacer')?.remove()
    document.querySelector('.thread').scrollTop = 0
    return true
  })()`)
  await sleep(400)
  const resetHeader = await cdp.eval(`(() => {
    const el = document.querySelector('[data-header="conversation"]')
    return { cls: el.classList.contains('is-scrolled'), opacity: getComputedStyle(el, '::after').opacity }
  })()`)
  expect('回到顶部后发丝线消失', resetHeader.cls === false && resetHeader.opacity === '0', resetHeader)

  // ── 3. ⋮ 菜单：位置、宽度、动画、项 ──────────────────────────────────────
  const menuPoint = await centerOf(cdp, 'button[aria-label="会话菜单"]')
  await touchStart(cdp, menuPoint.x, menuPoint.y)
  await sleep(50)
  await touchEnd(cdp)
  await sleep(50)
  // 动画中途采样：入场过渡只在这 160ms 内挂在元素上
  const menuAnim = await cdp.eval(`(() => {
    const el = document.querySelector('.session-menu')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { transform: cs.transform, duration: cs.transitionDuration, property: cs.transitionProperty }
  })()`)
  await sleep(320)
  const menu = await cdp.eval(`(() => {
    const el = document.querySelector('.session-menu')
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      exists: true,
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      title: el.querySelector('.session-menu__title')?.innerText.trim() ?? '',
      items: [...el.querySelectorAll('.session-menu__item')].map((b) => ({
        label: b.innerText.trim(),
        action: b.dataset.action,
        disabled: b.disabled === true,
        color: getComputedStyle(b).color,
      })),
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
      width: Math.round(r.width),
      vw: window.innerWidth,
      bg: cs.backgroundColor,
      radius: cs.borderTopLeftRadius,
      hasShadow: cs.boxShadow !== 'none',
      originX: Number.parseFloat(cs.transformOrigin),
      originY: Number.parseFloat(cs.transformOrigin.split(' ')[1] ?? '0'),
    }
  })()`)
  expect(
    '点 ⋮ 从右上角展开菜单（role=menu / 白底圆角卡片 / 带阴影）',
    menu.exists && menu.role === 'menu' && menu.aria === '会话菜单' &&
      menu.bg === 'rgb(255, 255, 255)' && menu.hasShadow === true && menu.radius === '16px',
    { role: menu.role, aria: menu.aria, bg: menu.bg, radius: menu.radius },
  )
  // transform-origin 的 px 值相对元素自身的 border box：右上角 = (width, 0)
  expect(
    '菜单宽 220px、贴右上（right=vw-8、top=52）、锚点在右上角',
    menu.width === 220 && menu.right === VIEWPORT.width - 8 && menu.top === 52 &&
      Math.abs(menu.originX - menu.width) <= 1 && Math.abs(menu.originY) <= 1,
    { width: menu.width, right: menu.right, top: menu.top, originX: menu.originX, originY: menu.originY },
  )
  const animScale = (() => {
    const m = /matrix\(([^)]+)\)/.exec(menuAnim?.transform ?? '')
    return m ? Number(m[1].split(',')[0]) : 1
  })()
  expect(
    '菜单弹出动画 160ms（scale 0.92 → 1 + 淡入）',
    !!menuAnim && menuAnim.duration.split(',').every((d) => d.trim() === '0.16s') &&
      /opacity/.test(menuAnim.property) && /transform/.test(menuAnim.property) &&
      animScale > 0 && animScale < 1,
    { anim: menuAnim, scale: animScale },
  )
  expect(
    '菜单从上到下：标题行 + 重命名 / Token 用量 / 连接诊断 / 归档',
    menu.title === '今天的计划' &&
      menu.items.map((i) => i.label).join(',') === '重命名,Token 用量,连接诊断,归档',
    { title: menu.title, items: menu.items },
  )
  expect(
    '「归档」用红色文字（破坏性动作）',
    menu.items[3]?.color === 'rgb(192, 57, 43)',
    menu.items[3]?.color,
  )
  expect('菜单项都可点（mock Hub 支持 rename/archive）', menu.items.every((i) => !i.disabled), menu.items)
  await cdp.shot('02-menu-open')

  // 点遮罩关闭
  await cdp.eval(`document.querySelector('.session-menu__mask').click()`)
  await waitFor(cdp, `!document.querySelector('.session-menu')`, { label: '点遮罩关菜单' })
  expect('点遮罩关闭菜单', true)

  // ── 4. 重命名：菜单项 → 居中对话框 → 保存 ────────────────────────────────
  const patched = await cdp.eval(`(() => {
    const s = window.__dshHub.chat
    window.__probe = { loads: 0, clears: 0, renameCalls: [], renameResults: [] }
    const load = s.loadSessionUsage
    const clear = s.clearSessionUsage
    const rename = s.renameSession
    s.loadSessionUsage = function (...a) { window.__probe.loads += 1; return load.apply(this, a) }
    s.clearSessionUsage = function (...a) { window.__probe.clears += 1; return clear.apply(this, a) }
    s.renameSession = function (...a) {
      window.__probe.renameCalls.push({ sessionId: a[0], title: a[1] })
      const p = rename.apply(this, a)
      if (p && typeof p.then === 'function') p.then((ok) => window.__probe.renameResults.push(ok))
      return p
    }
    return {
      loadPatched: String(s.loadSessionUsage).includes('__probe'),
      clearPatched: String(s.clearSessionUsage).includes('__probe'),
      renamePatched: String(s.renameSession).includes('__probe'),
    }
  })()`)
  expect('探针安装成功（load/clear/rename）', patched.loadPatched && patched.clearPatched && patched.renamePatched, patched)

  await openMenu(cdp)
  await tap(cdp, '[data-action="rename"]')
  await waitFor(cdp, `document.querySelector('.dialog')`, { label: '重命名对话框' })
  await sleep(250)
  const renameStart = await cdp.eval(`(() => {
    const dialog = document.querySelector('.dialog')
    const input = dialog.querySelector('.dialog__input')
    const save = dialog.querySelector('.dialog__btn--primary')
    const r = dialog.getBoundingClientRect()
    return {
      aria: dialog.getAttribute('aria-label'),
      role: dialog.getAttribute('role'),
      title: dialog.querySelector('.dialog__title')?.innerText.trim(),
      value: input.value,
      focused: document.activeElement === input,
      saveText: save.innerText.trim(),
      saveDisabled: save.disabled === true,
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
      height: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight,
      menuOpen: !!document.querySelector('.session-menu'),
    }
  })()`)
  expect(
    '菜单项「重命名」打开居中对话框（role=dialog / aria=重命名），菜单已收起',
    renameStart.aria === '重命名' && renameStart.role === 'dialog' &&
      renameStart.title === '重命名会话' && renameStart.menuOpen === false,
    renameStart,
  )
  expect(
    '对话框居中（左右留白对称、垂直居中）',
    Math.abs(renameStart.left - (renameStart.vw - renameStart.right)) <= 2 &&
      Math.abs(renameStart.top + renameStart.height / 2 - renameStart.vh / 2) <= 2,
    renameStart,
  )
  expect(
    '输入框预填当前标题并聚焦，「保存」可点',
    renameStart.value === '今天的计划' && renameStart.focused === true &&
      renameStart.saveText === '保存' && renameStart.saveDisabled === false,
    renameStart,
  )
  await cdp.shot('03-rename-dialog')

  // 空标题禁用保存
  await cdp.eval(`(() => {
    const input = document.querySelector('.dialog__input')
    input.value = '   '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  const emptyDisabled = await cdp.eval(`document.querySelector('.dialog__btn--primary')?.disabled === true`)
  expect('空标题禁用「保存」', emptyDisabled === true, { disabled: emptyDisabled })

  // 取消关闭
  await tap(cdp, '.dialog__btn--ghost')
  await waitFor(cdp, `!document.querySelector('.dialog')`, { label: '取消关对话框' })
  const afterCancel = await cdp.eval(`({ calls: window.__probe.renameCalls.length, title: window.__dshHub.chat.title })`)
  expect('取消不发 rename 请求，标题不变', afterCancel.calls === 0 && afterCancel.title === '今天的计划', afterCancel)

  // 保存
  await openMenu(cdp)
  await tap(cdp, '[data-action="rename"]')
  await waitFor(cdp, `document.querySelector('.dialog__input')`, { label: '再次打开重命名' })
  await sleep(200)
  await cdp.eval(`(() => {
    const input = document.querySelector('.dialog__input')
    input.value = '菜单重命名测试'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await tap(cdp, '.dialog__btn--primary')
  await waitFor(cdp, `!document.querySelector('.dialog')`, { label: '保存后关对话框' })
  await waitFor(cdp, `window.__dshHub.chat.title === '菜单重命名测试'`, { timeout: 10000, label: 'store 标题更新' })
  let hubRenamed = null
  for (let i = 0; i < 100; i += 1) {
    const status = await hubStatus()
    hubRenamed = status.sessions.find((s) => s.sessionId === 's_mock_plan')?.title ?? null
    if (hubRenamed === '菜单重命名测试') break
    await sleep(100)
  }
  const probeAfterRename = await cdp.eval(`window.__probe.renameCalls`)
  expect(
    '保存调用 chat.renameSession(sessionId, trim 后的标题)',
    Array.isArray(probeAfterRename) && probeAfterRename.length === 1 &&
      probeAfterRename[0].sessionId === 's_mock_plan' && probeAfterRename[0].title === '菜单重命名测试',
    probeAfterRename,
  )
  expect('Hub 侧标题已改名（rename 帧真的发出去了）', hubRenamed === '菜单重命名测试', hubRenamed)

  // ── 5. Token 用量面板 ───────────────────────────────────────────────────
  const loadsBefore = await cdp.eval(`window.__probe.loads`)
  await openMenu(cdp)
  const menuTitleAfterRename = await cdp.eval(`document.querySelector('.session-menu__title')?.innerText.trim()`)
  expect('菜单标题行跟着重命名更新', menuTitleAfterRename === '菜单重命名测试', menuTitleAfterRename)
  const morePoint = await centerOf(cdp, '[data-action="usage"]')
  await touchStart(cdp, morePoint.x, morePoint.y)
  await sleep(40)
  await touchEnd(cdp)
  await sleep(60)
  const midAnim = await cdp.eval(`(() => {
    const el = document.querySelector('.side-panel')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { transform: cs.transform, duration: cs.transitionDuration, property: cs.transitionProperty }
  })()`)
  await sleep(450)
  await waitFor(cdp, `document.querySelector('.side-panel')`, { label: '用量面板' })
  const midX = (() => {
    const m = /matrix\(([^)]+)\)/.exec(midAnim?.transform ?? '')
    return m ? Number(m[1].split(',')[4]) : 0
  })()
  const usagePanel = await cdp.eval(`(() => {
    const el = document.querySelector('.side-panel')
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const back = el.querySelector('button[aria-label="返回"]')
    const backRect = back?.getBoundingClientRect()
    return {
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      title: el.querySelector('.side-panel__title')?.innerText.trim(),
      left: Math.round(r.left), top: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
      bd: cs.backgroundColor,
      zIndex: cs.zIndex,
      transform: cs.transform,
      duration: cs.transitionDuration,
      backLabel: backRect ? { w: Math.round(backRect.width), h: Math.round(backRect.height) } : null,
      menuOpen: !!document.querySelector('.session-menu'),
      hero: el.querySelector('.usage__hero-value')?.innerText.trim(),
      rows: [...el.querySelectorAll('.usage__row')].map((row) => ({
        key: row.dataset.key,
        label: row.querySelector('dt')?.innerText.trim(),
        value: row.querySelector('dd')?.innerText.trim(),
      })),
      hint: el.querySelector('.usage__hint')?.innerText.trim() ?? '',
    }
  })()`)
  expect(
    '「Token 用量」从右向左滑入（动画中途 translateX > 0）并占满全屏',
    midX > 5 && usagePanel.left === 0 && usagePanel.top === 0 &&
      usagePanel.width === VIEWPORT.width && usagePanel.height === VIEWPORT.height,
    { mid: midAnim?.transform, x: midX, panel: { l: usagePanel.left, w: usagePanel.width, h: usagePanel.height } },
  )
  expect(
    '面板 role=dialog / aria=Token 用量 / 顶部标题 + ← 返回（44×44）',
    usagePanel.role === 'dialog' && usagePanel.aria === 'Token 用量' &&
      usagePanel.title === 'Token 用量' && usagePanel.backLabel?.w === 44 && usagePanel.backLabel?.h === 44,
    { role: usagePanel.role, aria: usagePanel.aria, title: usagePanel.title, back: usagePanel.backLabel },
  )
  expect('面板滑入节奏 0.22s，打开时菜单已收起', midAnim?.duration === '0.22s' && usagePanel.menuOpen === false, {
    duration: midAnim?.duration,
    menuOpen: usagePanel.menuOpen,
  })
  expect(
    '打开面板调用了 chat.loadSessionUsage()',
    (await cdp.eval(`window.__probe.loads`)) > loadsBefore,
    { before: loadsBefore, after: await cdp.eval(`window.__probe.loads`) },
  )
  const usageState = await cdp.eval(`(() => {
    const s = window.__dshHub.chat.sessionUsage
    return s ? { totalTokens: s.totalTokens, turns: s.turns } : null
  })()`)
  const fmt = new Intl.NumberFormat('zh-CN')
  expect(
    'mock Hub 的 usage 帧已落到面板：主数值 = 总计 tokens（千分位）',
    !!usageState && usagePanel.hero === fmt.format(usageState.totalTokens),
    { hero: usagePanel.hero, usage: usageState },
  )
  expect(
    '用量八项齐全（输入/输出/缓存命中/缓存命中率/积分消耗/回合数/用户消息数 + 总计主数值）',
    usagePanel.rows.map((r) => r.key).join(',') ===
      'inputTokens,outputTokens,cacheReadTokens,cacheHitRate,pointsMicro,turns,userMessages',
    usagePanel.rows,
  )
  const rowMap = Object.fromEntries(usagePanel.rows.map((r) => [r.key, r.value]))
  expect(
    '数值格式：千分位 + 缓存命中率带 %',
    /^[\d,]+$/.test(rowMap.inputTokens) && /^[\d,]+$/.test(rowMap.outputTokens) &&
      /^\d+\.\d%$/.test(rowMap.cacheHitRate),
    rowMap,
  )
  await cdp.eval(`window.__dshHub.ui.toastText = ''`)
  await cdp.shot('04-usage-panel')

  // 失败态 + 重试
  await cdp.eval(`window.__dshHub.chat.applySessionUsage(null, '统计失败：网络中断')`)
  await sleep(250)
  const usageError = await cdp.eval(`(() => {
    const box = document.querySelector('.usage__error')
    return {
      text: box?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      retry: !!document.querySelector('.usage__retry'),
      loads: window.__probe.loads,
    }
  })()`)
  expect('用量失败时显示错误文本 + 「重试」', usageError.text.includes('统计失败：网络中断') && usageError.retry, usageError)
  await tap(cdp, '.usage__retry')
  await sleep(250)
  expect('点「重试」再次请求用量', (await cdp.eval(`window.__probe.loads`)) > usageError.loads, {
    before: usageError.loads,
    after: await cdp.eval(`window.__probe.loads`),
  })

  // 暂无数据
  await cdp.eval(`window.__dshHub.chat.applySessionUsage(null, null)`)
  await sleep(250)
  const usageEmpty = await cdp.eval(`document.querySelector('.usage__state')?.innerText.trim() ?? ''`)
  expect('没有数据时显示「暂无用量数据」', usageEmpty === '暂无用量数据', usageEmpty)

  // ── 6. 返回键：面板优先被吃掉，并清空用量 ───────────────────────────────
  const clearsBefore = await cdp.eval(`window.__probe.clears`)
  const consumedPanel = await cdp.eval(`(() => {
    const consumed = window.__dshHub.ui.consumeOverlay()
    return { consumed, open: window.__dshHub.ui.sidePanelOpen }
  })()`)
  await waitFor(cdp, `!document.querySelector('.side-panel')`, { label: '返回键关面板' })
  await sleep(250)
  const afterPanelClose = await cdp.eval(`({
    clears: window.__probe.clears,
    usage: window.__dshHub.chat.sessionUsage,
    loading: window.__dshHub.chat.sessionUsageLoading,
  })`)
  expect(
    '返回键优先关右侧面板（面板 → 菜单 → 对话框 → 抽屉 → 弹层）',
    consumedPanel.consumed === true && consumedPanel.open === false,
    consumedPanel,
  )
  expect(
    '关面板调用 chat.clearSessionUsage() 并清空数据',
    afterPanelClose.clears > clearsBefore && afterPanelClose.usage === null && afterPanelClose.loading === false,
    afterPanelClose,
  )

  // ── 7. 连接诊断面板 + 复制诊断信息 ───────────────────────────────────────
  await openMenu(cdp)
  await tap(cdp, '[data-action="diagnostics"]')
  await waitFor(cdp, `document.querySelector('[data-panel="diagnostics"]')`, { label: '诊断面板' })
  await sleep(400)
  const diag = await cdp.eval(`(() => {
    const el = document.querySelector('.side-panel')
    return {
      aria: el.getAttribute('aria-label'),
      title: el.querySelector('.side-panel__title')?.innerText.trim(),
      link: el.querySelector('[data-key="link"]')?.innerText.trim(),
      cardSub: el.querySelector('.diag__card-sub')?.innerText.replace(/\\s+/g, ' ').trim(),
      rows: el.querySelectorAll('.diag__row').length,
      more: el.querySelector('.diag__more')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      firstEvents: [...el.querySelectorAll('.diag__row')].slice(0, 3).map((r) => r.innerText.replace(/\\s+/g, ' ').trim()),
      copyBtn: !!el.querySelector('button[aria-label="复制诊断信息"]'),
      note: el.querySelector('.diag__note')?.innerText.trim(),
    }
  })()`)
  expect(
    '「连接诊断」面板：标题 / 链路状态 / 事件列表 / 复制按钮',
    diag.aria === '连接诊断' && diag.title === '连接诊断' && diag.link === '已连接' &&
      diag.rows >= 1 && diag.rows <= 12 && diag.copyBtn === true,
    diag,
  )
  expect(
    '事件超过 12 条时只画最近 12 条并说明可复制全部',
    diag.rows === 12 ? /只显示最近 12 条（共 \d+ 条）/.test(diag.more) : diag.rows < 12,
    { rows: diag.rows, more: diag.more },
  )
  expect(
    '诊断显示事件总数与版本',
    /事件 \d+ 条/.test(diag.cardSub ?? '') && /版本 \d+\.\d+\.\d+/.test(diag.cardSub ?? ''),
    diag.cardSub,
  )
  await cdp.shot('05-diagnostics-panel')

  // 复制诊断信息：拦下 writeText，检查内容（不含对话正文/标题）
  const copied = await cdp.eval(`(() => {
    window.__copied = null
    const stub = { writeText: async (t) => { window.__copied = t } }
    Object.defineProperty(navigator, 'clipboard', { value: stub, configurable: true })
    return true
  })()`)
  await tap(cdp, 'button[aria-label="复制诊断信息"]')
  await sleep(350)
  const copyText = await cdp.eval(`window.__copied`)
  expect(
    '「复制诊断信息」生成纯文本报告（版本 + 事件名）',
    copied === true && typeof copyText === 'string' &&
      copyText.includes('DSH Hub App 诊断信息') && /版本 \d+\.\d+\.\d+ · 链路 已连接/.test(copyText) &&
      /boot/.test(copyText),
    typeof copyText === 'string' ? copyText.split('\n').slice(0, 5) : copyText,
  )
  expect(
    '报告不含对话正文与会话标题（只含版本/链路/事件）',
    typeof copyText === 'string' && !copyText.includes('菜单重命名测试') &&
      !copyText.includes('pelican') && !copyText.includes('今天的计划'),
    typeof copyText === 'string' ? copyText.slice(0, 200) : copyText,
  )
  const copyToast = await cdp.eval(`window.__dshHub.ui.toastText`)
  expect('复制后 toast 提示「诊断信息已复制」', copyToast === '诊断信息已复制', copyToast)
  await cdp.eval(`window.__dshHub.ui.toastText = ''`)

  // ── 8. 面板右滑关闭（§1.3）─────────────────────────────────────────────
  await touchStart(cdp, 40, 320)
  await sleep(30)
  await touchMove(cdp, 120, 324)
  await sleep(30)
  await touchMove(cdp, 260, 328)
  await sleep(30)
  await touchEnd(cdp)
  await waitFor(cdp, `!document.querySelector('.side-panel')`, { timeout: 5000, label: '右滑关面板' })
  expect('在面板上向右滑可以关闭面板', true)

  // ── 9. 菜单/对话框的返回键层级 ─────────────────────────────────────────
  await openMenu(cdp)
  const consumedMenu = await cdp.eval(`(() => {
    const consumed = window.__dshHub.ui.consumeOverlay()
    return { consumed, open: window.__dshHub.ui.sessionMenuOpen }
  })()`)
  await waitFor(cdp, `!document.querySelector('.session-menu')`, { label: '返回键关菜单' })
  expect('返回键关 ⋮ 菜单', consumedMenu.consumed === true && consumedMenu.open === false, consumedMenu)

  await openMenu(cdp)
  await tap(cdp, '[data-action="archive"]')
  await waitFor(cdp, `document.querySelector('.dialog')`, { label: '归档确认框' })
  await sleep(250)
  const confirm = await cdp.eval(`(() => {
    const dialog = document.querySelector('.dialog')
    const text = dialog.innerText.replace(/\\s+/g, ' ').trim()
    return {
      aria: dialog.getAttribute('aria-label'),
      title: dialog.querySelector('.confirm__title')?.innerText.trim(),
      text,
      dangerBtn: dialog.querySelector('.confirm__btn--danger')?.innerText.trim(),
      menuOpen: !!document.querySelector('.session-menu'),
    }
  })()`)
  expect(
    '菜单项「归档」弹出二次确认（说明可找回）',
    confirm.aria === '归档会话' && confirm.title === '归档这个会话？' &&
      confirm.text.includes('全部会话') && confirm.text.includes('已归档') &&
      confirm.text.includes('找回') && confirm.menuOpen === false,
    confirm,
  )
  await cdp.shot('06-archive-confirm')
  const consumedDialog = await cdp.eval(`(() => {
    const consumed = window.__dshHub.ui.consumeOverlay()
    return { consumed, open: window.__dshHub.ui.archiveConfirmOpen }
  })()`)
  await waitFor(cdp, `!document.querySelector('.dialog')`, { label: '返回键关确认框' })
  expect('返回键关归档确认框（不执行归档）', consumedDialog.consumed === true && consumedDialog.open === false, consumedDialog)
  const notArchived = await hubStatus()
  expect('取消后 Hub 归档集合不变', !notArchived.archived.includes('s_mock_plan'), notArchived.archived)

  // ── 10. 归档：确认 → Hub 归档集合 + 回首页 + 列表消失 ───────────────────
  await openMenu(cdp)
  await tap(cdp, '[data-action="archive"]')
  await waitFor(cdp, `document.querySelector('.confirm__btn--danger')`, { label: '确认归档按钮' })
  await sleep(200)
  await tap(cdp, '.confirm__btn--danger')
  await waitFor(cdp, `!document.querySelector('.dialog')`, { timeout: 15000, label: '归档后确认框关闭' })
  await waitFor(cdp, `window.__dshHub.router.currentRoute.value.path === '/'`, { timeout: 10000, label: '回到首页' })
  await waitFor(cdp, `document.querySelector('[data-header="home"]')`, { label: '首页顶栏' })
  let hubArchived = []
  for (let i = 0; i < 100; i += 1) {
    const status = await hubStatus()
    hubArchived = status.archived
    if (Array.isArray(hubArchived) && hubArchived.includes('s_mock_plan')) break
    await sleep(100)
  }
  const afterArchive = await cdp.eval(`({
    sessions: window.__dshHub.chat.sessions.map((s) => s.sessionId),
    activeId: window.__dshHub.chat.activeId,
    hash: location.hash,
    menuOpen: window.__dshHub.ui.sessionMenuOpen,
    panelOpen: window.__dshHub.ui.sidePanelOpen,
  })`)
  expect('确认归档后 Hub 归档集合包含该会话', Array.isArray(hubArchived) && hubArchived.includes('s_mock_plan'), hubArchived)
  // 会话列表要等 Hub 的下一帧 sessions 回来（archive 帧本身只回 archived 集合）
  let listed = afterArchive.sessions
  for (let i = 0; i < 80; i += 1) {
    if (!listed.includes('s_mock_plan')) break
    await sleep(100)
    listed = await cdp.eval(`window.__dshHub.chat.sessions.map((s) => s.sessionId)`)
  }
  expect(
    '归档后回到首页、当前会话清空、菜单/面板都收起',
    afterArchive.hash === '#/' && afterArchive.activeId === null &&
      afterArchive.menuOpen === false && afterArchive.panelOpen === false,
    afterArchive,
  )
  expect('归档后会话从列表消失', !listed.includes('s_mock_plan'), listed)
  await sleep(400)
  await cdp.shot('07-after-archive')

  // ── 11. 能力降级：features 无 rename/archive ────────────────────────────
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_blank')`)
  await waitFor(cdp, `document.querySelector('.thread')`, { label: '另一个对话页' })
  await sleep(500)
  const saved = await cdp.eval(`(() => {
    const models = window.__dshHub.models
    const savedFeatures = [...models.features]
    window.__origApplyFeatures = models.applyFeatures
    models.applyFeatures = () => {}
    models.features = []
    return savedFeatures
  })()`)
  await sleep(300)
  await openMenu(cdp)
  const degraded = await cdp.eval(`(() => {
    const el = document.querySelector('.session-menu')
    const items = [...el.querySelectorAll('.session-menu__item')].map((b) => ({
      action: b.dataset.action,
      disabled: b.disabled === true,
    }))
    return {
      items,
      hint: el.querySelector('.session-menu__hint')?.innerText.trim() ?? '',
      title: el.querySelector('.session-menu__title')?.innerText.trim(),
    }
  })()`)
  const disabledMap = Object.fromEntries(degraded.items.map((i) => [i.action, i.disabled]))
  expect(
    'features 缺 rename/archive 时「重命名」「归档」置灰（仍在菜单里）',
    disabledMap.rename === true && disabledMap.archive === true &&
      disabledMap.usage === false && disabledMap.diagnostics === false &&
      degraded.items.length === 4,
    degraded.items,
  )
  expect('置灰时给出一行提示', degraded.hint === '当前后端不支持重命名、归档', degraded.hint)
  await cdp.eval(`document.querySelector('.session-menu__mask')?.click()`)
  await waitFor(cdp, `!document.querySelector('.session-menu')`, { label: '关闭降级菜单' })
  await cdp.eval(`(() => {
    const models = window.__dshHub.models
    if (window.__origApplyFeatures) models.applyFeatures = window.__origApplyFeatures
    models.features = ${JSON.stringify(saved)}
    return true
  })()`)
  await waitFor(cdp, `window.__dshHub.models.features.includes('rename')`, { label: '能力恢复' })

  // ── 12. 控制台无错误 ───────────────────────────────────────────────────
  expect('无控制台 error', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    passed,
    total: checks.length,
    checks,
    failed: checks.filter((c) => !c.ok),
    consoleErrors,
    screenshots: (await fs.readdir(OUT)).filter((f) => f.endsWith('.png')).sort(),
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${passed}/${checks.length} 通过；截图与 report.json 在 ${OUT}`)
  cdp.ws.close()
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
