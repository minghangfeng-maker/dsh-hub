#!/usr/bin/env node
/**
 * `session-state` 快照 + 待回答角标端到端探针（0.3.0 / WP46，M6 §2）。
 *
 * 覆盖两件事：
 *  A. **提问等待中断线**：提问卡出现 → 断开通道（模拟切后台/网络断）→ 重连 →
 *     提问卡仍在并且能回答 → 回答后卡片消失、Hub 收到答案；
 *     顺带验证「回合在跑时断线重连，快照把 turnRunning 校正回来」。
 *  B. **待回答角标**：另一个会话里有未决提问（App 没订阅它）→ 抽屉里显示「待回答」角标、
 *     顶部细提示「有 N 个对话在等你回答」→ 点开即是那个会话，提问卡在，回答后角标消失。
 *
 * 用法（TICK_MS 小一点，断线重连窗口短；不需要改 WAKE_MS）：
 *   TICK_MS=12 PORT=5249 node apps/mock-hub/server.mjs
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5249 ./node_modules/.bin/vite --port 5250
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9249 \
 *     --user-data-dir=/tmp/e2e-profile-state about:blank      # 必须是全新 profile
 *   node scripts/e2e-session-state.mjs --app http://127.0.0.1:5250 --hub http://127.0.0.1:5249 --cdp 9249
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9249)
const APP_URL = args.app ?? 'http://127.0.0.1:5250'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5249'
const OUT = args.out ?? 'e2e-session-state-output'
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
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(OUT, `${name}.png`)
    await fs.writeFile(file, Buffer.from(res.data, 'base64'))
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

async function hubStatus(user = 'demo') {
  const res = await fetch(`${HUB_URL}/__test/status?user=${user}`)
  return res.json()
}

async function hubPost(pathname) {
  const res = await fetch(`${HUB_URL}${pathname}`, { method: 'POST' })
  return res.json()
}

async function ensureLoggedIn(cdp) {
  await sleep(400)
  if (await cdp.eval(`!!document.querySelector('.login')`)) {
    await cdp.eval(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('input[name=username]', 'demo')
      set('input[name=password]', 'demo1234')
      return true
    })()`)
    await sleep(100)
    await cdp.eval(`document.querySelector('.login__submit').click()`)
  }
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功', timeout: 30000 })
}

async function typeAndSend(cdp, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    if (!el) return false
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(120)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
  await sleep(150)
}

/** 回答当前页面上的提问卡（全选第一个选项 + 提交）。 */
async function answerQuestion(cdp) {
  await cdp.eval(`(() => {
    document.querySelectorAll('.question__option').forEach((el) => el.click())
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.question-card__submit').click()`)
  await sleep(400)
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

  // ---- 0. 干净登录
  await hubPost('/__test/reset')
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(700)
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
  await ensureLoggedIn(cdp)
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道连接', timeout: 30000 })

  const features = await cdp.eval(`Array.from(window.__dshHub.chat.features)`)
  expect('协商到 session-state 特性', Array.isArray(features) && features.includes('session-state'), features)

  // ---- A. 提问等待中断线：卡片仍在、可回答
  // 走路由进对话页（ConversationView 才会挂提问卡；直接调 openSession 只是数据层打开）
  await cdp.eval(`(() => { location.hash = '#/c/s_mock_plan'; return true })()`)
  await waitFor(cdp, `window.__dshHub.chat.activeId === 's_mock_plan'`, { label: '打开会话' })
  await waitFor(cdp, `document.querySelector('.thread')`, { label: '对话页挂载' })
  await sleep(600)
  await hubPost('/__test/question?session=s_mock_plan')
  await waitFor(cdp, `document.querySelector('.question-card')`, { label: '提问卡出现' })
  const beforeDrop = await cdp.eval(`(() => ({
    questions: window.__dshHub.chat.questions.length,
    callId: window.__dshHub.chat.questions[0]?.callId ?? null,
  }))()`)
  expect('提问卡出现（Hub 暂存了未决提问）', beforeDrop.questions === 1, beforeDrop)

  // 断开通道（模拟切后台/网络断）：mock 会 terminate 所有 WS
  const dropped = await hubPost('/__test/disconnect')
  expect('模拟断线：通道被服务端掐断', dropped.disconnected >= 1, dropped)
  await waitFor(cdp, `window.__dshHub.chat.link !== 'connected'`, { label: '客户端感知断线', timeout: 10000 })
  const duringDrop = await cdp.eval(`(() => ({
    link: window.__dshHub.chat.link,
    questions: window.__dshHub.chat.questions.length,
    cards: document.querySelectorAll('.question-card').length,
  }))()`)
  expect(
    '断线期间提问卡**没有被清掉**（协商了 session-state，Hub 侧暂存）',
    duringDrop.questions === 1 && duringDrop.cards === 1,
    duringDrop,
  )
  await cdp.shot('01-question-while-disconnected')

  // 重连：快照把未决提问带回来
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { label: '自动重连', timeout: 30000 })
  await sleep(500)
  const afterReconnect = await cdp.eval(`(() => ({
    questions: window.__dshHub.chat.questions.length,
    cards: document.querySelectorAll('.question-card').length,
    callId: window.__dshHub.chat.questions[0]?.callId ?? null,
  }))()`)
  expect(
    '重连后提问卡仍在（快照带回，且是同一张卡）',
    afterReconnect.questions === 1 && afterReconnect.cards === 1 && afterReconnect.callId === beforeDrop.callId,
    afterReconnect,
  )

  await answerQuestion(cdp)
  await waitFor(cdp, `window.__dshHub.chat.questions.length === 0`, { label: '回答后提问卡消失' })
  const afterAnswer = await hubStatus()
  expect(
    '回答提问后 Hub 收到 answers',
    Array.isArray(afterAnswer.lastAnswers?.answers) && afterAnswer.lastAnswers.answers.length === 1,
    afterAnswer.lastAnswers,
  )
  const pendingLeft = afterAnswer.pendingInteractions ?? {}
  expect('回答后 Hub 侧未决交互清零', !pendingLeft.s_mock_plan, pendingLeft)
  await cdp.shot('02-answered-after-reconnect')

  // ---- A2. 回合在跑时断线重连：快照把 turnRunning 校正回来
  await typeAndSend(cdp, '跑一个长回合，中途断线看看')
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === true`, { label: '回合开始' })
  await hubPost('/__test/disconnect')
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { label: '重连（回合进行中）', timeout: 30000 })
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === true`, { label: '快照校正：回合仍在跑', timeout: 10000 })
  const running = await cdp.eval(`(() => ({
    running: window.__dshHub.chat.turnRunning,
    stopVisible: !!document.querySelector('.composer__stop, .stop-btn, .send-btn--stop'),
  }))()`)
  expect('回合进行中重连：turnRunning 由快照校正为 true（停止按钮还在）', running.running === true, running)
  // 停掉这个回合，别让后续断言被长文本干扰
  await cdp.eval(`window.__dshHub.chat.stop()`)
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '停止后回到空闲', timeout: 20000 })

  // ---- B. 待回答角标：另一个会话有未决提问
  await hubPost('/__test/question?session=s_mock_blank')
  await cdp.eval(`window.__dshHub.chat.refreshSessions()`)
  await waitFor(
    cdp,
    `(window.__dshHub.chat.sessions.find((s) => s.sessionId === 's_mock_blank')?.pendingInteractions ?? 0) > 0`,
    { label: '会话行带 pendingInteractions', timeout: 15000 },
  )
  const row = await cdp.eval(`(() => {
    const s = window.__dshHub.chat.sessions.find((item) => item.sessionId === 's_mock_blank')
    return { pending: s?.pendingInteractions ?? 0, badgeCount: window.__dshHub.chat.pendingAnswerCount }
  })()`)
  expect('会话行的 pendingInteractions 生效（其它会话在等你回答）', row.pending === 1 && row.badgeCount === 1, row)
  expect(
    '当前会话的提问不算进角标（卡片就在页面上）',
    await cdp.eval(`window.__dshHub.chat.pendingAnswerSessions.every((s) => s.sessionId !== window.__dshHub.chat.activeId)`),
  )

  // 抽屉里的「待回答」角标
  await cdp.eval(`window.__dshHub.ui.openDrawer()`)
  await waitFor(cdp, `document.querySelector('.drawer')`, { label: '抽屉打开' })
  const drawer = await cdp.eval(`(() => {
    const badges = Array.from(document.querySelectorAll('.drawer .conv-badge')).map((el) => el.textContent.trim())
    const rows = Array.from(document.querySelectorAll('.drawer__conv')).map((el) => el.innerText.replace(/\\n/g, ' ').trim())
    return { badges, rows }
  })()`)
  expect('抽屉里出现「待回答」角标', drawer.badges.includes('待回答'), drawer)
  await cdp.shot('03-drawer-badge')
  await cdp.eval(`window.__dshHub.ui.closeDrawer()`)

  // 顶部细提示 + 点它打开第一个待回答会话
  await waitFor(cdp, `document.body.innerText.includes('个对话在等你回答')`, { label: '顶部细提示' })
  const hint = await cdp.eval(`(() => {
    const strip = Array.from(document.querySelectorAll('.wake-strip')).find((el) => el.innerText.includes('个对话在等你回答'))
    return strip ? strip.innerText.replace(/\\n/g, ' ').trim() : null
  })()`)
  expect('顶部细提示「有 N 个对话在等你回答」', typeof hint === 'string' && hint.includes('1 个对话'), hint)
  await cdp.eval(`(() => {
    const strip = Array.from(document.querySelectorAll('.wake-strip')).find((el) => el.innerText.includes('个对话在等你回答'))
    strip.querySelector('.wake-strip__action').click()
    return true
  })()`)
  await waitFor(cdp, `location.hash === '#/c/s_mock_blank'`, { label: '打开第一个待回答会话' })
  await waitFor(cdp, `window.__dshHub.chat.questions.length === 1`, { label: '该会话的提问卡由快照带回' })
  const other = await cdp.eval(`(() => ({
    activeId: window.__dshHub.chat.activeId,
    questions: window.__dshHub.chat.questions.length,
    badgeCount: window.__dshHub.chat.pendingAnswerCount,
  }))()`)
  expect('打开另一个会话后：提问卡在、角标清空（当前会话不算）', other.activeId === 's_mock_blank' && other.questions === 1, other)
  await cdp.shot('04-other-session-question')
  await answerQuestion(cdp)
  await waitFor(cdp, `window.__dshHub.chat.pendingAnswerCount === 0`, { label: '回答后角标消失' })
  const finalStatus = await hubStatus()
  expect(
    '回答后 Hub 侧未决交互清零（角标不会再冒出来）',
    !(finalStatus.pendingInteractions ?? {}).s_mock_blank,
    finalStatus.pendingInteractions ?? {},
  )

  expect('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = { at: new Date().toISOString(), app: APP_URL, hub: HUB_URL, checks, passed, total: checks.length }
  await fs.writeFile(path.join(OUT, 'session-state-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'session-state-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

main().catch((error) => {
  console.error('e2e 失败：', error)
  process.exitCode = 1
})
