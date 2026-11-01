#!/usr/bin/env node
/**
 * 发送锚定 e2e（0.4.8）：**发出新问题时把这条用户消息顶到对话区顶部**，像开始了一个新会话。
 *
 * 覆盖（对应设计要求的 A–H）：
 *   A. 长历史会话里发新问题 → 平滑滚动结束后该用户消息顶部距 `.thread` 顶部 = RAIL_JUMP_OFFSET
 *      （12px，±4px），且滚动过程有中间帧（不是瞬间跳过去）；
 *   B. 回复流式输出期间多次采样：锚点位置不变（±4px），scrollTop 不动（没有跟随滚动）；
 *   C. 回复超过一屏后仍不自动滚动 → 出现「回到底部」；点它以后恢复吸底跟随（距底 < 24px
 *      并继续跟着新内容走）；
 *   D. 回合结束（流式块落成正式消息）后锚点仍在原位（±4px）；
 *   E. 锚定期间真实手指上滑（CDP 触摸）→ 退出锚定，之后流式继续也不被程序滚动拉回；
 *   F. 短回复时留白存在（`.thread-spacer`），而且「把锚点放顶部」之后不能再往下滚出多余空白
 *      （scrollHeight − clientHeight ≈ 锚点位置，±2px）；
 *   G. 切到别的会话再回来：位于底部、没有多余留白；
 *   H. 发消息时键盘弹起/收起（改视口高度模拟）后锚点仍在顶部。
 *
 * mock hub 的 `POST /__test/reply { text, plain, tickMs, chunk }` 控制下一条回复的长度与速度
 * （`plain` 只发正文，没有工具卡/交付物干扰高度）。
 *
 * 用法（脚本默认自己拉起 mock hub 5271 / vite 5272 / headless Chrome 9293，跑完按 PID 关掉）：
 *
 *   node scripts/e2e-send-anchor.mjs --out /tmp/e2e-send-anchor/shots
 *
 * 已经手工起好服务时：
 *
 *   TICK_MS=12 PORT=5271 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5271 ./node_modules/.bin/vite --port 5272 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9293 \
 *     --user-data-dir=/tmp/e2e-profile-anchor about:blank &
 *   node scripts/e2e-send-anchor.mjs --no-spawn --app http://127.0.0.1:5272 \
 *     --hub http://127.0.0.1:5271 --cdp 9293
 *
 * 截图（390×844 / DPR 3 / 亮色 → 写进 `--out`）：`B-01-send-anchor`（发送瞬间后）、
 * `B-02-streaming`（回复流式中）、`B-03-done`（回复完成后）。
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
const SPAWN = args.spawn !== 'false' && !process.argv.includes('--no-spawn')
const HUB_PORT = Number(args['hub-port'] ?? 5271)
const APP_PORT = Number(args['app-port'] ?? 5272)
const CDP_PORT = Number(args.cdp ?? 9293)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-send-anchor-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
/** 移动端视口（iPhone 12/13/14）。 */
const VIEWPORT = { width: 390, height: 844, dpr: 3 }
/** 与 ui/src/lib/question-rail.ts 的 RAIL_JUMP_OFFSET 一致（e2e-thread 也是硬编码 12）。 */
const OFFSET = 12
/** 锚点位置容差（设计要求 ±4px）。 */
const TOL = 4

/** 一段约 38 字的中文：拼出长短不同的回复，验证留白/跟随。 */
const PARA = '发送锚定把这条提问顶到对话区顶部，下面用留白补足一屏，回复继续往下长而视图保持不动。'
const makeReply = (paragraphs, times) =>
  Array.from({ length: paragraphs }, (_, i) => `第 ${i + 1} 段。${PARA.repeat(times)}`).join('\n\n')

/** 长回复：约 960 字，肯定超过一屏（390×844 一屏约 26 行 ≈ 570 字）。 */
const LONG_REPLY = makeReply(6, 4)
/** 中等回复：约 320 字，短于一屏 → 留白 > 0。 */
const MEDIUM_REPLY = makeReply(4, 2)
/** 短回复：几行。 */
const SHORT_REPLY = '好的，这条回复只有一行多一点，留白会把这一屏补满。'

const PROMPT_A = '先按新的发送锚定发一条，验证问题停在顶部'
const PROMPT_C = '这一条用来验证回复超过一屏也不会自动跟随'
const PROMPT_E = '这一条用来验证手指一碰就退出锚定'
const PROMPT_F = '这一条是短回复，验证留白只补足不多给'
const PROMPT_H = '这一条验证键盘弹起收起时锚点还在顶部'

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
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(80)
  }
  throw new Error(`等待超时：${label}`)
}

async function hubPost(pathname, body) {
  const res = await fetch(`${HUB_URL}${pathname}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return res.json()
}

const LOGIN_VALUES = `(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
  set('input[name=username]', 'demo')
  set('input[name=password]', 'demo1234')
  return true
})()`

async function login(cdp) {
  await cdp.eval(LOGIN_VALUES)
  await sleep(220)
  await cdp.eval(`document.querySelector('.login__submit')?.click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录', timeout: 30000 })
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道', timeout: 30000 })
}

async function setup(cdp) {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await setViewport(cdp, VIEWPORT.height)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(250)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(900)
  // 主题是 localStorage 里的纯 UI 偏好（截图用亮色）；登录态在内存里，重载后要再登一次
  await cdp.eval(`(() => {
    try {
      localStorage.clear()
      localStorage.setItem('dsh-hub:ui:v1', JSON.stringify({ theme: 'light' }))
    } catch {}
    return true
  })()`)
  await cdp.send('Page.reload')
  await sleep(1000)
  await waitFor(cdp, `!!document.querySelector('.login__submit')`, { label: '登录页' })
  await login(cdp)
  await waitFor(cdp, `document.documentElement.dataset.theme === 'light'`, { label: '主题 light' })
}

async function setViewport(cdp, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
}

/** 打开会话页（走路由，ConversationView 才会挂载/切换）。 */
async function openSession(cdp, sessionId, { waitUsers = 1 } = {}) {
  await cdp.eval(`(() => { location.hash = '#/c/${sessionId}' })()`)
  await waitFor(cdp, `window.__dshHub.chat.activeId === ${JSON.stringify(sessionId)}`, {
    label: `打开会话 ${sessionId}`,
  })
  await waitFor(cdp, `!!document.querySelector('.thread')`, { label: '对话页挂载' })
  await waitFor(cdp, `document.querySelectorAll('.msg-user').length >= ${waitUsers}`, {
    label: `会话 ${sessionId} 的历史（≥${waitUsers} 条）`,
  })
  // 打开会话的初始姿态：在底部、没有留白（0.4.8 不变）
  await waitFor(
    cdp,
    `(() => {
      const t = document.querySelector('.thread')
      return !!t && t.scrollHeight - t.scrollTop - t.clientHeight < 24
    })()`,
    { label: '打开会话在底部' },
  )
}

/**
 * 页内探针：锚点（`window.__e2eAnchor` 指定的用户消息）位置、滚动位置、留白高度。
 * 全部按「与 e2e 断言同一个口径」量：offset = 锚点顶部 − .thread 顶部；anchorTop = 锚点顶部 −
 * 内容顶部（不含留白）；spacer = .thread-spacer 的实际高度。
 */
const PROBE = `(() => {
  const round1 = (v) => Math.round(v * 10) / 10
  const thread = document.querySelector('.thread')
  const inner = document.querySelector('.thread__inner')
  if (!thread || !inner) return null
  const users = [...document.querySelectorAll('[data-user-msg-key]')]
  const wanted = window.__e2eAnchor ?? (users.length > 0 ? users[users.length - 1].dataset.userMsgKey : null)
  const node = users.find((n) => n.dataset.userMsgKey === wanted) ?? null
  const spacerEl = document.querySelector('.thread-spacer')
  const spacer = spacerEl ? spacerEl.getBoundingClientRect().height : 0
  const tRect = thread.getBoundingClientRect()
  const iRect = inner.getBoundingClientRect()
  // 内容高度 = thread__inner 自己的高度（留白是它后面的兄弟节点，不算内容）
  const contentHeight = iRect.height
  const anchorTop = node ? node.getBoundingClientRect().top - iRect.top : null
  return {
    key: node ? node.dataset.userMsgKey : null,
    wanted,
    hasNode: node !== null,
    offset: node ? round1(node.getBoundingClientRect().top - tRect.top) : null,
    anchorTop: anchorTop === null ? null : round1(anchorTop),
    below: anchorTop === null ? null : round1(contentHeight - anchorTop),
    contentHeight: round1(contentHeight),
    scrollTop: round1(thread.scrollTop),
    scrollHeight: round1(thread.scrollHeight),
    clientHeight: round1(thread.clientHeight),
    maxScroll: round1(thread.scrollHeight - thread.clientHeight),
    distance: round1(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
    spacer: round1(spacer),
    spacerElement: !!spacerEl,
    toBottom: !!document.querySelector('.to-bottom'),
    users: users.length,
    turnRunning: !!window.__dshHub?.chat.turnRunning,
    streamChars: window.__dshHub?.chat.streamingText?.length ?? 0,
    messages: document.querySelectorAll('.thread__inner .msg-assistant').length,
    lastAssistantChars: (() => {
      const list = [...document.querySelectorAll('.thread__inner .msg-assistant')]
      const last = list[list.length - 1]
      return last ? last.textContent.trim().length : 0
    })(),
  }
})()`

/** 采样滚动位置（证明是平滑滚动：有中间帧）；`onSample` 可以在某个瞬间顺手截图。 */
async function sampleScroll(cdp, { durationMs = 1600, intervalMs = 25, onSample } = {}) {
  const samples = []
  const started = Date.now()
  while (Date.now() - started < durationMs) {
    const p = await probe(cdp)
    samples.push({ at: Date.now() - started, ...p })
    if (onSample) await onSample(p)
    await sleep(intervalMs)
  }
  return samples
}

async function probe(cdp) {
  const p = await cdp.eval(PROBE)
  if (!p) throw new Error('探针失败：找不到 .thread / .thread__inner')
  return p
}

/** 等滚动停下来（连续 quiet 次采样 scrollTop 不变），返回最后一次探针。 */
async function settleScroll(cdp, { timeout = 6000, quiet = 4, intervalMs = 70 } = {}) {
  const started = Date.now()
  let last = await probe(cdp)
  let stable = 0
  while (Date.now() - started < timeout) {
    await sleep(intervalMs)
    const now = await probe(cdp)
    if (Math.abs(now.scrollTop - last.scrollTop) < 0.6) stable += 1
    else stable = 0
    last = now
    if (stable >= quiet) return last
  }
  return last
}

async function threadBox(cdp) {
  const box = await cdp.eval(`(() => {
    const rect = document.querySelector('.thread').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), top: rect.top, height: rect.height }
  })()`)
  return box
}

/** 真实手指滑动（CDP 触摸）：从 y 拖到 y + dy（dy > 0 = 手指往下 → 内容往上翻）。 */
async function touchDrag(cdp, x, fromY, toY, steps = 12) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: fromY, id: 1 }],
  })
  for (let i = 1; i <= steps; i += 1) {
    const y = fromY + ((toY - fromY) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y, id: 1 }],
    })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 发一条消息（输入框 → 发送按钮），并把「当前最新一条用户消息」记成锚点。 */
async function sendPrompt(cdp, text) {
  await waitFor(cdp, `window.__dshHub.chat.readyToSend === true`, { label: '可以发送', timeout: 30000 })
  // 探针默认跟「最新一条用户消息」：新发的那条就是它
  await cdp.eval(`window.__e2eAnchor = null`)
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(140)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
}

/** 把下一条回复换成指定长度/速度（mock hub 的 0.4.8 钩子；plain 只发正文）。 */
async function setReply({ text, plain = true, tickMs = 25, chunk = 4 }) {
  const res = await hubPost('/__test/reply', { text, plain, tickMs, chunk })
  if (res?.ok !== true) throw new Error(`设置回复失败：${JSON.stringify(res)}`)
  return res
}

async function waitTurnEnd(cdp, { timeout = 60000 } = {}) {
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '回合结束', timeout })
  // 落成正式消息 + 高亮/图片这些晚到的长高，都在这 900ms 里发生
  await sleep(900)
}

async function latchAnchor(cdp) {
  const p = await probe(cdp)
  await cdp.eval(`window.__e2eAnchor = ${JSON.stringify(p.key)}`)
  return p
}

// ── A / B / D：发送锚定 + 流式不跟随 + 回合结束不跳 ─────────────────────────────

async function checkAnchorAndStreaming(cdp, { shots = false } = {}) {
  console.log('\n── A/B/D. 发送锚定：问题停在顶部、流式不跟随、回合结束不跳')
  await setReply({ text: LONG_REPLY })
  const before = await probe(cdp)
  expect('发送前视图在底部（初始姿态不变）', before.distance < 24, before)

  await sendPrompt(cdp, PROMPT_A)
  // 「发送瞬间后」的截图：锚点**刚**滚到顶部、回复还只有一两行时截（下面还是留白）
  let sentShot = false
  const trail = await sampleScroll(cdp, {
    durationMs: 1600,
    intervalMs: 25,
    onSample: async (p) => {
      if (!shots || sentShot || p.offset === null) return
      if (Math.abs(p.offset - OFFSET) > TOL) return
      sentShot = true
      await cdp.shot('B-01-send-anchor')
    },
  })
  const settled = await settleScroll(cdp)
  const anchor = await latchAnchor(cdp)

  // A：平滑滚动结束后锚点顶部 = 12 ± 4
  expect(
    `A. 发送后锚点距对话区顶部 = ${OFFSET}±${TOL}px（实测 ${settled.offset}px）`,
    settled.offset !== null && Math.abs(settled.offset - OFFSET) <= TOL,
    { offset: settled.offset, scrollTop: settled.scrollTop, anchorTop: settled.anchorTop },
  )
  expect(
    'A. scrollTop 正好等于「锚点位置 − 间距」（留白让目标位置够得着）',
    settled.anchorTop !== null && Math.abs(settled.scrollTop - Math.max(0, settled.anchorTop - OFFSET)) <= TOL,
    { scrollTop: settled.scrollTop, anchorTop: settled.anchorTop },
  )
  expect('A. 刚发出去时留白 > 0（回复还短，下面补一屏）', settled.spacer > 0, {
    spacer: settled.spacer,
    below: settled.below,
  })
  const target = settled.scrollTop
  const mids = trail.filter((s) => s.scrollTop > before.scrollTop + 10 && s.scrollTop < target - 10)
  expect(
    `A. 是平滑滚动（采到 ${mids.length} 个中间帧，不是瞬间跳过去）`,
    mids.length >= 2,
    { from: before.scrollTop, to: target, mids: mids.length },
  )
  expect(
    'A. 结束时锚点消息就是我们刚发的那条',
    anchor.key !== null && anchor.users >= before.users + 1,
    { key: anchor.key, users: anchor.users },
  )

  // B：流式期间多次采样，位置不变、不跟随
  const during = []
  let streamingShot = false
  const streamStart = Date.now()
  while (Date.now() - streamStart < 2600) {
    const p = await probe(cdp)
    during.push(p)
    if (shots && !streamingShot && p.streamChars > 120) {
      streamingShot = true
      await cdp.shot('B-02-streaming')
    }
    await sleep(150)
  }
  const offsets = during.map((s) => s.offset)
  const spread = Math.max(...offsets) - Math.min(...offsets)
  expect(
    `B. 流式期间锚点位置不变（${during.length} 次采样，漂移 ${spread.toFixed(1)}px ≤ ${TOL}px）`,
    offsets.every((value) => Math.abs(value - OFFSET) <= TOL) && spread <= TOL,
    { offsets },
  )
  const scrolls = new Set(during.map((s) => s.scrollTop))
  expect(
    `B. 流式期间没有跟随滚动（scrollTop 恒为 ${target}px）`,
    [...scrolls].every((value) => Math.abs(value - target) <= 1),
    { scrollTops: [...scrolls] },
  )
  expect(
    'B. 流式期间留白随内容长高变小（不是固定不动）',
    during[during.length - 1].spacer < settled.spacer,
    { before: settled.spacer, after: during[during.length - 1].spacer },
  )

  // D：回合结束后仍在原位
  const beforeEnd = await probe(cdp)
  await waitTurnEnd(cdp)
  const ended = await probe(cdp)
  if (shots) await cdp.shot('B-03-done')
  expect(
    `D. 回合结束后锚点仍在原位（实测 ${ended.offset}px，容差 ${TOL}px）`,
    Math.abs(ended.offset - OFFSET) <= TOL,
    { offset: ended.offset, before: beforeEnd.offset },
  )
  expect(
    'D. 回合结束后 scrollTop 没动（流式块落成正式消息也不跳）',
    Math.abs(ended.scrollTop - beforeEnd.scrollTop) <= TOL,
    { before: beforeEnd.scrollTop, after: ended.scrollTop },
  )
  expect(
    'D. 回复正文已经落成正式消息（流式块收尾、正文完整）',
    ended.streamChars === 0 && ended.lastAssistantChars > before.lastAssistantChars,
    { streamChars: ended.streamChars, before: before.lastAssistantChars, after: ended.lastAssistantChars },
  )
  expect('D. 留白已经缩到 0（回复超过一屏了）', ended.spacer === 0, { spacer: ended.spacer })
  return { settled, during, ended }
}

// ── C：超过一屏不跟随 + 回到底部恢复吸底 ─────────────────────────────────────

async function checkNoAutoFollow(cdp) {
  console.log('\n── C. 回复超过一屏仍不自动滚动，「回到底部」恢复吸底')
  await setReply({ text: LONG_REPLY })
  await sendPrompt(cdp, PROMPT_C)
  const settled = await settleScroll(cdp)
  await latchAnchor(cdp)
  const anchorScroll = settled.scrollTop

  // 等到回复正文长过一屏（留白已经缩到 0）
  let past = settled
  const started = Date.now()
  while (Date.now() - started < 30000) {
    past = await probe(cdp)
    if (past.spacer <= 0 && past.below > past.clientHeight + 40) break
    if (!past.turnRunning) break
    await sleep(120)
  }
  expect(
    'C. 回复正文已经超过一屏（留白 = 0）',
    past.spacer === 0 && past.below > past.clientHeight,
    { below: past.below, clientHeight: past.clientHeight, spacer: past.spacer },
  )
  expect(
    `C. 超过一屏后仍不自动滚动（锚点还在 ${past.offset}px，scrollTop 没动）`,
    Math.abs(past.offset - OFFSET) <= TOL && Math.abs(past.scrollTop - anchorScroll) <= 1,
    { offset: past.offset, scrollTop: past.scrollTop, anchorScroll },
  )
  expect('C. 这时「回到底部」入口可见', past.toBottom === true, { toBottom: past.toBottom })

  await cdp.eval(`document.querySelector('.to-bottom')?.click()`)
  await sleep(900)
  const back = await probe(cdp)
  expect(
    `C. 点回到底部后恢复吸底（距底 ${back.distance}px < 24px）`,
    back.distance < 24,
    { distance: back.distance, scrollTop: back.scrollTop },
  )
  expect('C. 回到底部后按钮消失', back.toBottom === false, { toBottom: back.toBottom })
  expect(
    'C. 视图确实往下走了（离开锚点）',
    back.scrollTop > anchorScroll + 100,
    { before: anchorScroll, after: back.scrollTop },
  )
  await sleep(1200)
  const following = await probe(cdp)
  expect(
    'C. 之后继续跟着新内容走（距底仍 < 24px）',
    following.distance < 24 && following.scrollTop >= back.scrollTop,
    { distance: following.distance, from: back.scrollTop, to: following.scrollTop },
  )
  await waitTurnEnd(cdp)
}

// ── E：用户接管 ─────────────────────────────────────────────────────────────

async function checkUserTakeover(cdp) {
  console.log('\n── E. 锚定期间手指上滑 → 退出锚定，不被程序滚动拉回')
  await setReply({ text: LONG_REPLY })
  await sendPrompt(cdp, PROMPT_E)
  const settled = await settleScroll(cdp)
  await latchAnchor(cdp)
  expect(
    `E. 起点：锚点在 ${OFFSET}px（实测 ${settled.offset}px）`,
    Math.abs(settled.offset - OFFSET) <= TOL,
    { offset: settled.offset },
  )

  const box = await threadBox(cdp)
  // 手指往下滑 = 内容往上翻 = scrollTop 变小（锚定状态下 scrollTop 已经在最大位置）
  const fromY = Math.round(box.top + 180)
  await touchDrag(cdp, box.x, fromY, fromY + 240, 14)
  await sleep(500)
  const afterDrag = await probe(cdp)
  expect(
    `E. 用户接管：视图跟着手指走了（scrollTop ${settled.scrollTop} → ${afterDrag.scrollTop}）`,
    afterDrag.scrollTop < settled.scrollTop - 60,
    { before: settled.scrollTop, after: afterDrag.scrollTop },
  )
  expect(
    `E. 锚点不再停在顶部（实测 ${afterDrag.offset}px > ${OFFSET + 60}px）`,
    afterDrag.offset > OFFSET + 60,
    { offset: afterDrag.offset },
  )
  expect('E. 接管后「回到底部」入口可见', afterDrag.toBottom === true, {
    toBottom: afterDrag.toBottom,
  })

  // 继续流式：不能再被程序滚动拉回锚点
  const samples = []
  const started = Date.now()
  while (Date.now() - started < 1600) {
    samples.push(await probe(cdp))
    await sleep(150)
  }
  const scrolls = samples.map((s) => s.scrollTop)
  const pullBack = Math.abs(scrolls[scrolls.length - 1] - afterDrag.scrollTop)
  expect(
    `E. 之后不再被程序滚动拉回（scrollTop 漂移 ${pullBack.toFixed(1)}px ≤ 4px）`,
    pullBack <= TOL,
    { scrollTops: scrolls },
  )
  expect(
    `E. 锚点位置也保持不变（实测 ${samples[samples.length - 1].offset}px）`,
    Math.abs(samples[samples.length - 1].offset - afterDrag.offset) <= TOL,
    { from: afterDrag.offset, to: samples[samples.length - 1].offset },
  )
  await waitTurnEnd(cdp)
  // 下一轮开始前回到吸底（点回到底部 = 显式接管，和真机操作一致）
  await cdp.eval(`document.querySelector('.to-bottom')?.click()`)
  await sleep(800)
}

// ── F：短回复的留白只补足 ───────────────────────────────────────────────────

async function checkSpacerExact(cdp) {
  console.log('\n── F. 短回复：留白存在，且不能再往下滚出多余空白')
  await setReply({ text: SHORT_REPLY })
  await sendPrompt(cdp, PROMPT_F)
  const settled = await settleScroll(cdp)
  await latchAnchor(cdp)
  await waitTurnEnd(cdp)
  const p = await probe(cdp)

  expect('F. 短回复时留白元素存在且高度 > 0', p.spacerElement === true && p.spacer > 0, {
    spacer: p.spacer,
    spacerElement: p.spacerElement,
  })
  expect(
    `F. 留白只补足：scrollHeight − clientHeight = 锚点位置（实测 ${p.maxScroll}px vs ${(p.anchorTop - OFFSET).toFixed(1)}px）`,
    Math.abs(p.maxScroll - Math.max(0, p.anchorTop - OFFSET)) <= 2,
    { maxScroll: p.maxScroll, anchorTop: p.anchorTop, OFFSET },
  )
  expect(
    `F. 锚点正好停在 ${OFFSET}px（已经到底，滚不动了）`,
    Math.abs(p.offset - OFFSET) <= TOL && p.distance <= 1,
    { offset: p.offset, distance: p.distance },
  )
  // 再往下滚：位置不变（没有更多空白可滚）
  const pushed = await cdp.eval(`(() => {
    const t = document.querySelector('.thread')
    t.scrollTop = t.scrollHeight
    return Math.round(t.scrollTop * 10) / 10
  })()`)
  await sleep(200)
  const after = await probe(cdp)
  expect(
    `F. 再往下滚也滚不出空白（scrollTop ${pushed}px = 上限 ${p.maxScroll}px）`,
    Math.abs(pushed - p.maxScroll) <= 1 && Math.abs(after.offset - OFFSET) <= TOL,
    { pushed, maxScroll: p.maxScroll, offset: after.offset },
  )

  // 下面只有留白、没有没看到的内容：「回到底部」不该出现（0.4.8 审查补充）
  expect('F. 短回复下面只有留白时「回到底部」不出现', after.toBottom === false, {
    toBottom: after.toBottom,
  })
  // 只往上翻一点（可见区域底边仍在留白里，回复全在屏上）：按钮仍不该出现
  const box = await threadBox(cdp)
  const fromY = Math.round(box.top + 120)
  await touchDrag(cdp, box.x, fromY, fromY + 200, 14)
  await sleep(600)
  const nudged = await probe(cdp)
  expect('F. 往上翻得不多、回复仍全在屏上：「回到底部」不出现', nudged.distance < nudged.spacer && nudged.toBottom === false, {
    toBottom: nudged.toBottom,
    distance: nudged.distance,
    spacer: nudged.spacer,
  })
  // 再往上翻，翻过留白：下面有回复被挡住了 → 按钮出现
  await touchDrag(cdp, box.x, fromY, fromY + 400, 14)
  await sleep(600)
  const scrolledUp = await probe(cdp)
  expect('F. 翻过留白后「回到底部」出现（下面有被挡住的内容）', scrolledUp.toBottom === true, {
    toBottom: scrolledUp.toBottom,
    distance: scrolledUp.distance,
    spacer: scrolledUp.spacer,
  })
  // 留白 > 0 时点「回到底部」：收掉留白、真实内容底部对齐屏幕底（短回复时锚点被顶下去）
  await cdp.eval(`document.querySelector('.to-bottom')?.click()`)
  await sleep(900)
  const jumped = await probe(cdp)
  expect(
    'F. 有留白时点回到底部：留白收掉、距底 < 24px',
    jumped.spacerElement === false && jumped.distance < 24,
    { spacer: jumped.spacer, distance: jumped.distance },
  )
  expect(
    `F. 短回复整屏不到一屏 → 锚点离开顶部（实测 ${jumped.offset}px > ${OFFSET + 60}px）`,
    jumped.offset !== null && jumped.offset > OFFSET + 60,
    { offset: jumped.offset },
  )
}

// ── G：切换会话再回来 ───────────────────────────────────────────────────────

async function checkSessionSwitch(cdp) {
  console.log('\n── G. 切到别的会话再回来：在底部、没有多余留白')
  await cdp.eval(`window.__e2eAnchor = null`)
  await openSession(cdp, 's_mock_long')
  await sleep(600)
  await openSession(cdp, 's_mock_plan', { waitUsers: 4 })
  await sleep(1000)
  const p = await probe(cdp)
  expect('G. 切回来以后在底部（距底 < 24px）', p.distance < 24, { distance: p.distance })
  expect('G. 没有多余留白（.thread-spacer 不存在）', p.spacerElement === false && p.spacer === 0, {
    spacer: p.spacer,
    spacerElement: p.spacerElement,
  })
  expect(
    'G. scrollHeight = 真实内容高度（底部没有撑出来的空白）',
    Math.abs(p.scrollHeight - p.contentHeight) <= 1,
    { scrollHeight: p.scrollHeight, contentHeight: p.contentHeight },
  )
  expect('G. 切回来以后「回到底部」不显示（pinned=true）', p.toBottom === false, {
    toBottom: p.toBottom,
  })
}

// ── H：键盘弹起 / 收起 ─────────────────────────────────────────────────────

async function checkKeyboard(cdp) {
  console.log('\n── H. 发消息时键盘弹起/收起（改视口高度）后锚点仍在顶部')
  const beforeH = await probe(cdp)
  // 短回复 → 留白一定 > 0，视口一变高度就能量到留白跟着重算
  await setReply({ text: SHORT_REPLY, chunk: 12 })
  await sendPrompt(cdp, PROMPT_H)
  const settled = await settleScroll(cdp)
  await latchAnchor(cdp)
  // 先把回合跑完：内容固定下来，留白变化才只由视口高度决定（键盘弹起/收起）
  await waitTurnEnd(cdp)
  const baseline = await probe(cdp)
  expect(
    'H. 消息确实发出去了（用户消息 +1，锚点就是它）',
    baseline.users === beforeH.users + 1 && baseline.hasNode === true,
    { before: beforeH.users, after: baseline.users, key: baseline.key },
  )
  expect(
    `H. 短回复留白 > 0（实测 ${baseline.spacer}px，锚点下方 ${baseline.below}px）`,
    baseline.spacer > 100,
    { spacer: baseline.spacer, below: baseline.below, clientHeight: baseline.clientHeight },
  )
  expect(
    `H. 起点：锚点在 ${OFFSET}px（实测 ${baseline.offset}px）`,
    Math.abs(baseline.offset - OFFSET) <= TOL,
    { offset: baseline.offset, spacer: baseline.spacer },
  )

  // 键盘弹起：视口变矮 ~324px（844 → 520）
  await setViewport(cdp, 520)
  await sleep(700)
  const keyboardUp = await probe(cdp)
  expect(
    `H. 键盘弹起后锚点仍在 ${OFFSET}px（实测 ${keyboardUp.offset}px）`,
    Math.abs(keyboardUp.offset - OFFSET) <= TOL,
    { offset: keyboardUp.offset, clientHeight: keyboardUp.clientHeight },
  )
  expect(
    'H. 视口确实变矮了、留白跟着重算',
    keyboardUp.clientHeight < baseline.clientHeight - 100 && keyboardUp.spacer !== baseline.spacer,
    {
      before: baseline.clientHeight,
      after: keyboardUp.clientHeight,
      spacerBefore: baseline.spacer,
      spacerAfter: keyboardUp.spacer,
    },
  )

  // 键盘收起：视口变回 844
  await setViewport(cdp, VIEWPORT.height)
  await sleep(700)
  const keyboardDown = await probe(cdp)
  expect(
    `H. 键盘收起后锚点仍在 ${OFFSET}px（实测 ${keyboardDown.offset}px）`,
    Math.abs(keyboardDown.offset - OFFSET) <= TOL,
    { offset: keyboardDown.offset, clientHeight: keyboardDown.clientHeight },
  )
  expect(
    'H. 视口恢复、留白回到弹起前的大小',
    Math.abs(keyboardDown.clientHeight - baseline.clientHeight) <= 1 &&
      Math.abs(keyboardDown.spacer - baseline.spacer) <= 2,
    {
      clientHeight: keyboardDown.clientHeight,
      spacer: keyboardDown.spacer,
      expectSpacer: baseline.spacer,
    },
  )
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const cdp = await Cdp.attach(CDP_PORT)
  await hubPost('/__test/reset')
  // 播一段长历史：新问题的 anchorTop 远大于一屏，锚定才有意义（12 条 + 原有 2 条 = 7 条提问）
  const seeded = await hubPost('/__test/seed-thread?session=s_mock_plan&turns=6')
  console.log(`[e2e] 种子历史：${JSON.stringify(seeded)}`)
  await setup(cdp)
  await openSession(cdp, 's_mock_plan', { waitUsers: 7 })

  const shots = true
  await checkAnchorAndStreaming(cdp, { shots })
  await checkNoAutoFollow(cdp)
  await checkUserTakeover(cdp)
  await checkSpacerExact(cdp)
  await checkSessionSwitch(cdp)
  await checkKeyboard(cdp)

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    passed,
    total: checks.length,
    checks,
  }
  await fs.writeFile(path.join(OUT, 'e2e-send-anchor.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'e2e-send-anchor.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

// ── 起服务（脚本自己能跑完，不用手工开三个终端）──────────────────────────────

const children = []
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

function pipeStdout(label, child) {
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    if (process.env.E2E_VERBOSE === '1' || /error|Error|ERR/.test(text)) {
      process.stdout.write(`[${label}] ${text}`)
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
}

async function startServers() {
  if (!SPAWN) {
    await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })
    await waitHttp(`${APP_URL}/`, { label: 'vite' })
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, { label: 'chrome CDP' })
    return
  }
  console.log(`[e2e] 起 mock hub :${HUB_PORT}`)
  const hub = spawn(process.execPath, [path.join(ROOT, 'apps/mock-hub/server.mjs')], {
    env: { ...process.env, PORT: String(HUB_PORT), TICK_MS: '12', WAKE_MS: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(hub)
  pipeStdout('hub', hub)
  await waitHttp(`${HUB_URL}/__test/health`, { label: 'mock hub' })

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

  profileDir = `/tmp/e2e-profile-anchor-${Date.now()}`
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

startServers()
  .then(() => main())
  .catch((error) => {
    console.error('e2e-send-anchor 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServers()
  })
