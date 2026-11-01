#!/usr/bin/env node
/**
 * A1 端到端探针：真实 HTTP/WS（本地 mock Hub）走完整流程，并在流式期间量手感指标。
 *
 * 覆盖：
 *   登录错误码（待审批）→ 登录 → 唤醒状态条 → bootstrap 后端/会话 → 三段弹层
 *   → 发送 → 流式（帧率/长任务）→ 上滑停止吸底 + 回到底部 → 停止
 *   → 断线重连 + assistant-baseline 续传（逐字对拍）→ 设置页（无服务器地址/默认模型）
 *
 * 用法：
 *   node scripts/e2e-a1.mjs --app http://127.0.0.1:5242 --hub http://127.0.0.1:5245 \
 *        --cdp 9241 --out ../mobile-plan/v2/artifacts/a1-screenshots
 *
 * 前置：mock Hub 与 Web（dev 或 preview）已启动，Chrome 开着 CDP 端口。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9241)
const APP_URL = args.app ?? 'http://127.0.0.1:5242'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5245'
const OUT = args.out ?? 'e2e-a1-output'
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
const CLOUD = 'cloud:self'

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
function expect(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

async function state(cdp) {
  return cdp.eval(`(() => {
    const s = window.__dshHub
    if (!s) return null
    const c = s.chat
    return {
      auth: s.auth.phase,
      user: s.auth.user?.username ?? null,
      points: s.auth.points ? { balance: s.auth.points.balance, enabled: s.auth.points.enabled } : null,
      backends: s.auth.backends.map(b => ({ id: b.id, kind: b.kind, name: b.name, connectable: b.connectable, reason: b.reason ?? null, status: b.status })),
      selectedBackendId: s.backend.selectedBackendId,
      wake: s.backend.wakeState,
      link: c.link,
      sessions: c.sessions.map(x => x.sessionId),
      activeId: c.activeId,
      messages: c.displayMessages.map(m => ({ role: m.role, text: m.text, seq: m.seq, localId: m.localId, pending: m.pending, unknown: m.unknown })),
      streamingLength: c.streamingText.length,
      streamingText: c.streamingText,
      turnRunning: c.turnRunning,
      stopRequested: c.stopRequested,
      // WP46 起发送队列下沉到 core 的 Outbox（chat store 不再有 queue），
      // 探针里的统计口径不变：还是「待发条数」。
      queue: c.outbox.length,
      pendingSendCount: c.pendingSendCount,
      error: c.workspaceError ? { code: c.workspaceError.code, message: c.workspaceError.message } : null,
    }
  })()`)
}

const FPS_RECORDER = `(() => {
  window.__a1 = { frames: [], longtasks: [], on: true, stops: [], marks: [], startedAt: performance.now() }
  window.__a1.mark = (name) => window.__a1.marks.push({ name, t: Math.round(performance.now()) })
  // 页面侧记录「本轮真正结束时」的时刻：不要用探针自己的 mark（它会因为后面的
  // 滚动/截图晚好几秒，把结束后的高亮也算进流式窗口）。
  const watchTurn = () => {
    const c = window.__dshHub?.chat
    const r = window.__a1
    if (!r) return
    if (c?.isStreaming) r.streamStarted = true
    else if (r.streamStarted && r.turnEndAt == null) r.turnEndAt = performance.now()
    requestAnimationFrame(watchTurn)
  }
  requestAnimationFrame(watchTurn)
  const loop = (ts) => {
    const r = window.__a1
    if (!r.on) return
    r.frames.push(ts)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50 && entry.startTime >= window.__a1.startedAt) {
          window.__a1.longtasks.push({
            duration: Math.round(entry.duration),
            name: entry.name,
            start: Math.round(entry.startTime),
            attribution: (entry.attribution ?? []).map((a) => a.name).slice(0, 2),
          })
        }
      }
    })
    // 不要 buffered:true —— 那会把预热/首屏阶段的旧任务也带进来
    obs.observe({ type: 'longtask', buffered: false })
  } catch {}
  return true
})()`

const SCROLL_RECORDER = `(() => {
  const el = document.querySelector('.thread')
  window.__a1rec = { s: [], on: true }
  const loop = () => {
    const r = window.__a1rec
    if (!r.on) return
    r.s.push({ t: Math.round(performance.now()), top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), jump: !!document.querySelector('.to-bottom') })
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  return true
})()`

function analyse(samples, yankPx = 3) {
  let reversals = 0
  let maxBack = 0
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].top - samples[i - 1].top
    if (d < -yankPx) {
      reversals++
      maxBack = Math.max(maxBack, Math.abs(d))
    }
  }
  return {
    frames: samples.length,
    start: samples[0]?.top ?? null,
    end: samples[samples.length - 1]?.top ?? null,
    delta: (samples[samples.length - 1]?.top ?? 0) - (samples[0]?.top ?? 0),
    reversals,
    maxBackJumpPx: maxBack,
    monotonicPct:
      samples.length > 1 ? Math.round((100 * (samples.length - 1 - reversals)) / (samples.length - 1)) : 100,
  }
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

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  const startedAt = Date.now()
  const t = {}

  // ---- 0. 干净状态 + 登录页
  // 干净的服务端状态（实例 stopped、会话与归档重置），否则第二遍跑看不到唤醒过程
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  // 先到 about:blank 再进 App：只改 hash 不会重新加载 SPA，会带上一轮的登录态。
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(800)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  // 先确认这一份 dist 真的指向本机 mock Hub：构建参数忘了给时会连生产地址，
  // 表现是「登录网络错误」，很容易被误判成后端挂了。
  if ('.') {
    const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
    expect(`构建产物指向本机 mock Hub（当前 ${origin}）`, origin === HUB_URL, origin)
  }
  t.loginPage = Date.now() - startedAt
  await cdp.shot('01-login')

  // 这个 e2e 用 VITE_HUB_ORIGIN 指定了 Hub，所以登录页**不展开**服务器地址输入框
  // （只在没有任何内置入口时才展开）；底部仍留一个「服务器地址」按钮用于换服务器。
  const serverInputShown = await cdp.eval(`!!document.querySelector('[data-login-server]')`)
  expect('有内置入口时登录页不展开服务器地址输入框', !serverInputShown)
  const serverToggleShown = await cdp.eval(`document.body.innerText.includes('服务器地址')`)
  expect('登录页保留「服务器地址」入口（换服务器用）', serverToggleShown)

  // ---- 1. 待审批错误码 → 中文提示
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'pending'); set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150) // 等 Vue 把按钮从 disabled 变可用
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `document.querySelector('.login__error')?.innerText.includes('审批')`, {
    label: '待审批错误',
  })
  const pendingError = await cdp.eval(`document.querySelector('.login__error')?.innerText ?? ''`)
  expect('待审批错误提示为中文', pendingError.includes('审批'), pendingError)
  await cdp.shot('02-login-pending')

  // ---- 1.1 限流倒计时（429 + details.retryAfterSec）
  await cdp.eval(`(() => {
    const el = document.querySelector('input[name=username]')
    el.value = 'ratelimit'; el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `document.querySelector('.login__error')?.innerText.includes('秒后可重试')`, {
    label: '限流倒计时',
  })
  const rateText = await cdp.eval(`document.querySelector('.login__error').innerText`)
  const submitDisabled = await cdp.eval(`document.querySelector('.login__submit').disabled`)
  expect('限流显示倒计时', /\d+ 秒后可重试/.test(rateText), rateText)
  expect('倒计时期间登录按钮禁用', submitDisabled === true)
  await cdp.shot('02b-login-rate-limited')
  await waitFor(cdp, `document.querySelector('.login__submit').disabled === false`, {
    timeout: 8000,
    label: '倒计时结束',
  })

  // ---- 2. 正常登录 → 首页 + 唤醒状态条
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo'); set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })
  t.login = Date.now() - startedAt
  await waitFor(cdp, `document.querySelector('.home-view')`, { label: '首页' })
  const wakeTexts = []
  const wakeStates = []
  for (let i = 0; i < 100; i++) {
    const snapshot = await cdp.eval(`(() => ({
      text: document.querySelector('.wake-strip')?.innerText ?? '',
      state: window.__dshHub?.backend?.wakeState ?? '',
      instance: window.__dshHub?.auth.instance?.status ?? '',
    }))()`)
    if (snapshot.text) wakeTexts.push(snapshot.text)
    if (snapshot.state) wakeStates.push(snapshot.state)
    if (snapshot.text.includes('正在唤醒') || snapshot.state === 'waking') break
    if (snapshot.instance === 'running') break
    await sleep(50)
  }
  expect(
    '登录后出现唤醒状态条（或观察到 waking）',
    wakeTexts.some((x) => x.includes('正在唤醒')) || wakeStates.includes('waking'),
    { wakeTexts: wakeTexts.slice(-3), wakeStates: wakeStates.slice(-3) },
  )
  await cdp.shot('03-home-waking')

  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: '通道连上' })
  await waitFor(cdp, `window.__dshHub.chat.sessions.length >= 2`, { timeout: 15000, label: '会话列表' })
  const s1 = await state(cdp)
  expect('积分余额可见（bootstrap）', s1.points?.balance === 1280.5, s1.points)
  expect('后端列表来自 bootstrap', s1.backends.length === 2 && s1.backends[0].id === CLOUD, s1.backends)
  expect('桌面后端不可连接并带原因', s1.backends[1].connectable === false, s1.backends[1])
  expect('会话列表已拉取（2 条 mock 会话）', s1.sessions.length >= 2, s1.sessions)
  await cdp.shot('04-home-ready')

  // ---- 3. 芯片两段 + 模型弹层 + 强度拖动条弹层（Codex 风格）
  const chipHome = await cdp.eval(`(() => ({
    text: document.querySelector('.chip').innerText.replace(/\\s+/g, ' ').trim(),
    model: document.querySelector('.chip__part--model')?.innerText.trim() ?? '',
    effort: document.querySelector('.chip__part--effort')?.innerText.trim() ?? '',
    legacy: !!document.querySelector('.chip--legacy'),
  }))()`)
  expect('芯片是「模型 + 强度」两段式', !chipHome.legacy && chipHome.model.length > 0 && chipHome.effort.length > 0, chipHome)
  expect('芯片模型段用短名（无版本号）', /^[A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5 .]*$/.test(chipHome.model) && !/V\d/.test(chipHome.model), chipHome.model)
  expect('芯片强度段为英文短名', ['Low', 'Medium', 'High', 'Max'].includes(chipHome.effort), chipHome.effort)

  await cdp.eval(`document.querySelector('.chip__part--model').click()`)
  await waitFor(cdp, `document.querySelector('.sheet')`, { label: '模型弹层' })
  const sheet = await cdp.eval(`(() => ({
    text: document.querySelector('.sheet')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    titles: [...document.querySelectorAll('.sheet__title')].map(e => e.innerText.trim()),
    backends: [...document.querySelectorAll('.sheet .backend')].map(e => ({ text: e.innerText.replace(/\\s+/g, ' ').trim(), disabled: e.classList.contains('is-disabled') })),
    models: [...document.querySelectorAll('.sheet__item.model')].map(e => ({ name: e.querySelector('.model__name')?.innerText.trim() ?? '', selected: e.classList.contains('is-selected') })),
  }))()`)
  expect('模型弹层两段：后端 / 模型', JSON.stringify(sheet.titles) === JSON.stringify(['后端', '模型']), sheet.titles)
  // 真机反馈（2026-10-26）：离线/下线的桌面端不再展示，后端段只留可用的
  expect(
    '后端段只展示可用的（云服务器；离线桌面端不出现）',
    sheet.backends.length === 1 && !sheet.backends[0].disabled && sheet.backends[0].text.includes('云服务器'),
    sheet.backends,
  )
  expect('后端段没有离线桌面端', !sheet.text.includes('书房的 Windows') && !sheet.text.includes('电脑端没有连上 Hub'), sheet.text.slice(0, 200))
  expect('模型列表展示 catalog 短名（去掉版本号）', sheet.models.some((m) => m.name === 'DeepSeek Flash'), sheet.models)
  expect('当前模型有选中态', sheet.models.filter((m) => m.selected).length === 1, sheet.models)
  await cdp.shot('05-model-sheet')
  await cdp.eval(`document.querySelector('.sheet-mask').click()`)
  await sleep(250)

  await cdp.eval(`document.querySelector('.chip__part--effort').click()`)
  await waitFor(cdp, `document.querySelector('.effort__slider')`, { label: '强度弹层' })
  const effortSheet = await cdp.eval(`(() => {
    const el = document.querySelector('.effort__slider')
    return {
      labels: [...document.querySelectorAll('.effort__label')].map(e => e.querySelector('.effort__label-cn')?.innerText.trim() ?? ''),
      min: el.getAttribute('aria-valuemin'),
      max: el.getAttribute('aria-valuemax'),
      now: el.getAttribute('aria-valuenow'),
    }
  })()`)
  const effortLabels = ['低', '中等', '高', '超高']
  expect('四档思考程度齐全', effortLabels.every((x, i) => effortSheet.labels[i] === x), effortSheet.labels)
  expect('拖动条 role=slider 且 aria-valuemin/max/now 完整', effortSheet.min === '1' && effortSheet.max === '4' && effortSheet.now === '3', effortSheet)
  await cdp.shot('05b-effort-sheet')
  await cdp.eval(`document.querySelector('.sheet-mask').click()`)
  await sleep(250)

  // ---- 4. 发送 → 流式（量帧率 + 吸底）
  const sendMessage = async (text) => {
    await cdp.eval(`document.querySelector('.composer__input').value = ''`)
    await cdp.eval(`(() => {
      const el = document.querySelector('.composer__input')
      el.value = ${JSON.stringify(text)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(120)
    await cdp.eval(`document.querySelector('.send-btn').click()`)
    await waitFor(cdp, `location.hash.startsWith('#/c/')`, { label: '进入对话页' })
  }

  await cdp.eval(FPS_RECORDER)
  await cdp.eval(`window.__a1.mark('send')`)
  await sendMessage('帮我整理一下今天的计划')
  await waitFor(cdp, `window.__dshHub.chat.streamingText.length > 20`, { timeout: 15000, label: '开始流式' })
  t.firstStream = Date.now() - startedAt
  await cdp.eval(`window.__a1.mark('firstStream')`)

  // 吸底 + 用户回看（真实触摸）：等滚动区间够大，再向下拖 260px（不会撞到顶部边界）
  await waitFor(
    cdp,
    // v2 回合会先出思考块与工具卡，再出正文：内容高度增长比 A1 的纯文本模式更早也更快。
    // 手势开始前必须有足够的**可回看空间**（>700px），否则「下滑看历史」在 max=413 时
    // 根本没有可滚的余量，手势本身做不了，后面的断言会误判成「吸底没停」。
    `(() => {
      const el = document.querySelector('.thread')
      if (!el) return false
      const max = el.scrollHeight - el.clientHeight
      return max > 700 && Math.abs(el.scrollTop - max) < 8
    })()`,
    { timeout: 25000, label: '内容长到可回看且仍在吸底' },
  )
  await cdp.eval(`window.__a1.mark('scrollStart')`)
  await cdp.eval(SCROLL_RECORDER)
  const scrollBefore = await cdp.eval(
    `(() => { const el = document.querySelector('.thread'); return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) } })()`,
  )
  await touchStart(cdp, 200, 240)
  for (let i = 1; i <= 10; i++) {
    await touchMove(cdp, 200, 240 + i * 26)
    await sleep(40)
  }
  await touchEnd(cdp)
  await sleep(1200)
  const scrollAfter = await cdp.eval(`(() => {
    const el = document.querySelector('.thread')
    return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), jump: !!document.querySelector('.to-bottom') }
  })()`)
  const rec = await cdp.eval(`(() => { window.__a1rec.on = false; return window.__a1rec.s })()`)
  // 3px 以下的重排抖动不算「被拽回」；真正的自动吸底会一次跳几十到几百 px。
  const fling = { ...analyse(rec, 3), yanks: analyse(rec, 30), samples: rec }
  expect('回看后离开底部（不再吸底）', scrollAfter.top < scrollAfter.max - 80, { scrollBefore, scrollAfter })
  expect('跟手：拖动 260px → 内容滚动 ≥150px', Math.abs(fling.delta) >= 150, fling)
  expect('拖动过程没有被自动吸底拽回（≥30px 的反向跳动为 0）', fling.yanks.reversals === 0, fling.yanks)
  expect('出现「回到底部」按钮', scrollAfter.jump === true, scrollAfter)
  await cdp.shot('06-scrolled-up')

  // 松手后继续流式 1.2s：位置不许被自动拽走
  const topBeforeDrift = scrollAfter.top
  await sleep(1200)
  const topAfterDrift = await cdp.eval(
    `Math.round(document.querySelector('.thread').scrollTop)`,
  )
  expect('松开后不再自动吸底（1.2s 内漂移 ≤2px）', Math.abs(topAfterDrift - topBeforeDrift) <= 2, {
    topBeforeDrift,
    topAfterDrift,
  })

  await cdp.eval(`window.__a1.mark('jumpBack')`)
  await cdp.eval(`document.querySelector('.to-bottom').click()`)
  await sleep(700)
  const distance = await cdp.eval(
    `(() => { const el = document.querySelector('.thread'); return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) })()`,
  )
  expect('点回到底部后距底 < 24px', distance < 24, distance)

  // 流式稳态采样（至少 6s）
  await sleep(1500)
  const perf = await cdp.eval(`(() => {
    const r = window.__a1
    r.on = false
    const turnEnd = r.turnEndAt ?? (r.marks.find((m) => m.name === 'turnEnd') ?? {}).t ?? performance.now()
    const frames = r.frames.filter((t) => t <= turnEnd)
    const deltas = []
    for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1])
    deltas.sort((a, b) => a - b)
    const span = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0
    return {
      windowEnd: Math.round(turnEnd),
      postTurnLongtasks: r.longtasks.filter((e) => e.start > turnEnd),
      streamStarted: !!r.streamStarted,
      turnEndAt: r.turnEndAt ? Math.round(r.turnEndAt) : null,
      frames: frames.length,
      spanMs: Math.round(span),
      fps: span > 0 ? Math.round((1000 * (frames.length - 1)) / span) : 0,
      p95: deltas.length ? Math.round(deltas[Math.floor(deltas.length * 0.95)]) : 0,
      max: deltas.length ? Math.round(deltas[deltas.length - 1]) : 0,
      longtasks: r.longtasks.filter((e) => e.start <= turnEnd),
      marks: r.marks,
      shiki: window.__shikiLog ?? [],
      streamingLength: window.__dshHub.chat.streamingText.length,
      pinned: (() => { const el = document.querySelector('.thread'); return el.scrollHeight - el.scrollTop - el.clientHeight < 24 })(),
    }
  })()`)
  expect('流式帧率 ≥ 55fps', perf.fps >= 55, perf)
  expect('流式期间无 >50ms 长任务', perf.longtasks.length === 0, perf.longtasks)
  expect('回到吸底后继续跟随', perf.pinned === true, perf)
  await cdp.shot('07-streaming')

  // ---- 5. 停止（独立一条消息，避免受采样时长影响）
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { timeout: 20000, label: '首条回复完成' })
  await cdp.eval(`window.__a1.mark('turnEnd')`)
  await sendMessage('这条用来测试停止')
  await waitFor(cdp, `(window.__dshHub.chat.streamingText ?? '').length > 40`, {
    timeout: 15000,
    label: '第二次流式',
  })
  await cdp.eval(`document.querySelector('.send-btn--stop').click()`)
  await waitFor(
    cdp,
    `window.__dshHub.chat.turnRunning === false && window.__dshHub.chat.stopRequested === false`,
    { timeout: 5000, label: '停止完成' },
  )
  const afterStop = await state(cdp)
  await sleep(900)
  const afterStop2 = await state(cdp)
  const assistantAfterStop = afterStop2.messages.filter((m) => m.role === 'assistant').at(-1)
  expect('停止后回合结束、内容不再增长', afterStop2.turnRunning === false && afterStop2.streamingText.length === 0, {
    stoppedLen: afterStop.streamingText.length,
  })
  expect('停止保留已生成的部分回复', (assistantAfterStop?.text.length ?? 0) > 0, assistantAfterStop?.text.length)
  await cdp.shot('08-stopped')

  // ---- 6. 断线重连 + baseline 续传
  await sendMessage('断线续传测试')
  await waitFor(cdp, `(window.__dshHub.chat.streamingText ?? '').length > 60`, {
    timeout: 15000,
    label: '第三次流式',
  })
  const beforeDrop = await cdp.eval(`window.__dshHub.chat.streamingText`)
  const drop = await fetch(`${HUB_URL}/__test/disconnect`, { method: 'POST' }).then((r) => r.json())
  expect('mock Hub 已模拟掉线', drop.disconnected >= 1, drop)
  await waitFor(
    cdp,
    `window.__dshHub.chat.link === 'reconnecting' || window.__dshHub.chat.link === 'connected'`,
    { timeout: 6000, label: '进入重连' },
  )
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 10000, label: '重连成功' })
  await waitFor(
    cdp,
    `window.__dshHub.chat.turnRunning === false && (window.__dshHub.chat.streamingText ?? '').length === 0`,
    { timeout: 25000, label: '续传后回合结束' },
  )
  const resumed = await state(cdp)
  const lastAssistant = resumed.messages.filter((m) => m.role === 'assistant').at(-1)
  const script = await fetch(`${HUB_URL}/__test/script`).then((r) => r.json())
  expect('续传后正文与 mock 脚本逐字一致', lastAssistant?.text === script.reply, {
    got: lastAssistant?.text.length,
    want: script.reply.length,
  })
  expect('续传后没有重复前半段', (lastAssistant?.text.indexOf(script.reply.slice(0, 20), 1) ?? -1) === -1)
  expect('掉线前收到的内容是新正文的前缀', (lastAssistant?.text ?? '').startsWith(beforeDrop), {
    beforeDrop: beforeDrop.length,
  })
  await cdp.shot('09-resumed')

  // ---- 7. 设置页
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` })
  await waitFor(cdp, `document.querySelector('.page__group')`, { label: '设置页' })
  await sleep(300)
  const settingsText = await cdp.eval(`document.body.innerText`)
  expect('设置页没有服务器地址', !settingsText.includes('服务器地址'))
  expect('设置页没有默认模型', !settingsText.includes('默认模型'))
  expect('设置页有积分余额', settingsText.includes('积分余额') && settingsText.includes('1280.5'))
  expect('设置页有退出登录与吊销本设备', settingsText.includes('退出登录') && settingsText.includes('吊销本设备'))
  expect('设置页有外观/关于/隐私', settingsText.includes('外观') && settingsText.includes('关于和版本') && settingsText.includes('隐私说明'))
  await cdp.shot('10-settings')

  // ---- 7.1 全部会话 → 已归档筛选（D5）
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/all` })
  await waitFor(cdp, `document.querySelector('.session-tabs')`, { label: '会话页签' })
  const defaultTitles = await cdp.eval(
    `[...document.querySelectorAll('.conv-row__title')].map(e => e.innerText.trim())`,
  )
  expect('默认会话列表不含已归档', !defaultTitles.includes('上个月的复盘'), defaultTitles)
  await cdp.eval(`(() => { const tabs = [...document.querySelectorAll('.session-tabs button')]; tabs.find(t => t.innerText.includes('已归档')).click(); return true })()`)
  await sleep(800)
  const archivedTitles = await cdp.eval(
    `[...document.querySelectorAll('.conv-row__title')].map(e => e.innerText.trim())`,
  )
  expect('已归档筛选能拉到归档会话', archivedTitles.includes('上个月的复盘'), archivedTitles)
  await cdp.shot('11-archived')

  // ---- 8. 控制台错误
  await sleep(300)
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('Download the Vue Devtools'),
  )
  expect('控制台无错误', realErrors.length === 0, realErrors.slice(0, 5))

  const summary = {
    generatedAt: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    timings: t,
    perf,
    fling: { scrollBefore, scrollAfter, analysis: fling, distanceAfterJump: distance },
    checks,
    consoleErrors: realErrors,
  }
  const jsonPath = path.join(OUT, 'a1-e2e.json')
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2))
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过，报告 ${jsonPath}`)
  if (failed.length > 0) console.error('失败项：', failed.map((c) => c.name))
  // 收尾必须显式 close + exit：CDP 的 WebSocket 不断开时 node 会一直挂在事件循环上
  // （0.3.x 起这个脚本在报告写完之后仍然不退出，CI/回归里只能靠外部超时杀掉）。
  cdp.ws.close()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error('e2e 失败：', error)
  try {
    await fs.mkdir(OUT, { recursive: true })
    await fs.writeFile(path.join(OUT, 'a1-e2e-error.json'), JSON.stringify({ error: String(error), checks }, null, 2))
  } catch {}
  process.exit(1)
})
