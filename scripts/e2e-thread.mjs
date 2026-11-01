#!/usr/bin/env node
/**
 * 0.4.0 §2/§4 端到端探针：过程行位置固定 + 问题导航条。
 *
 * 覆盖两件事（设计文档 §6）：
 *  A. **过程行位置不跳**：mock 用提示词里的「过程行」触发「思考 → 工具 → 再思考 → 正文」，
 *     在正文出现前按 ~40ms 采样过程行的纵坐标，要求：
 *       - 三个时刻（实时思考 / 工具运行 / 再思考）都出现过；
 *       - 纵坐标极差 ≤ 2px；
 *       - 块 DOM 节点没有被替换（在节点上打标记，整轮都在）；
 *       - 块 key（`data-process-key`）在实时 → 落库切换时不变；
 *       - 正文始终在过程行下方。
 *  B. **问题导航条**：会话里 ≥3 条提问时，滚动后右缘出现细轨；拖动时左侧弹出简述气泡、
 *     吸附到目标提问；松手后该用户消息顶部位于对话区顶部下方 12±4px；回到底部按钮可用。
 *
 * 用法（与 e2e-a2 同一套 mock hub / vite）：
 *   TICK_MS=12 PORT=5246 node apps/mock-hub/server.mjs
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5246 ./node_modules/.bin/vite --port 5247
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9261 \
 *     --user-data-dir=/tmp/e2e-thread-profile about:blank
 *   node scripts/e2e-thread.mjs --app http://127.0.0.1:5247 --hub http://127.0.0.1:5246 --cdp 9261
 *
 * 截图（设计文档 §6 第 7–11 张）：加 `--shots <目录> --theme light|dark`，
 * 会额外把过程行的三个时刻、展开后的时间线、长回答排版、导航条拖动气泡、回到底部按钮存成 PNG。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9261)
const APP_URL = args.app ?? 'http://127.0.0.1:5247'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5246'
const OUT = args.out ?? 'e2e-thread-output'
const SHOTS = args.shots ?? ''
const THEME = args.theme === 'dark' ? 'dark' : 'light'
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
/** 过程行纵坐标容差（设计文档要求 ≤ 2px）。 */
const Y_TOLERANCE = 2
/** 跳转后用户消息顶部与对话区顶部的间距。 */
const JUMP_OFFSET = 12
const JUMP_TOLERANCE = 4
const PROCESS_PROMPT = '用过程行看一下思考到工具再到思考的完整过程'

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
  async eval(expression, { awaitPromise = true } = {}) {
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
    const file = path.join(SHOTS, `${name}-${THEME}.png`)
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(250)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(900)
  // 主题是 localStorage 里的纯 UI 偏好（settings store）：写进去再重载；登录态在内存里，重载后要再登一次
  await cdp.eval(`(() => {
    try {
      localStorage.clear()
      localStorage.setItem('dsh-hub:ui:v1', JSON.stringify({ theme: ${JSON.stringify(THEME)} }))
    } catch {}
    return true
  })()`)
  await cdp.send('Page.reload')
  await sleep(1000)
  await waitFor(cdp, `!!document.querySelector('.login__submit')`, { label: '登录页' })
  await login(cdp)
  await waitFor(cdp, `document.documentElement.dataset.theme === ${JSON.stringify(THEME)}`, {
    label: `主题 ${THEME}`,
  })
}

/** 打开会话页（走路由，ConversationView 才会挂载）。 */
async function openSession(cdp, sessionId) {
  await cdp.eval(`(() => { location.hash = '#/c/${sessionId}' })()`)
  await waitFor(cdp, `window.__dshHub.chat.activeId === ${JSON.stringify(sessionId)}`, {
    label: `打开会话 ${sessionId}`,
  })
  await waitFor(cdp, `!!document.querySelector('.thread')`, { label: '对话页挂载' })
}

async function sendPrompt(cdp, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    // 上一轮的工具卡还留在会话状态里：记下基线，阶段判定只看这一轮新增的
    window.__e2eToolsAtStart = window.__dshHub.chat.toolCards.length
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
}

/** 过程行采样：纵坐标、块 key、DOM 标记、当前阶段、头部两段文字（0.4.9）。 */
const SAMPLE = `(() => {
  const el = [...document.querySelectorAll('[data-testid="process-row"]')].pop()
  if (!el) return null
  if (!el.__e2eMark) el.__e2eMark = 'b-0.4.0'
  const text = el.querySelector('.process__text')
  const headEl = el.querySelector('.process__head')
  const liveLabel = el.querySelector('.process__live-label')
  const statusEl = el.querySelector('.process__status')
  const dots = [...el.querySelectorAll('.process__ellipsis i')]
  const chat = window.__dshHub.chat
  const reasoning = chat.streamingReasoning.length
  const body = chat.streamingText.length
  const tools = chat.toolCards.length - (window.__e2eToolsAtStart ?? 0)
  const lastCard = chat.toolCards[chat.toolCards.length - 1]
  const toolRunning = !!lastCard && lastCard.phase === 'start' && lastCard.status === 'running'
  const stage = body > 0 ? 'body' : tools > 0 && reasoning > 0 ? 'reasoning2' : tools > 0 ? 'tool' : 'reasoning1'
  const thread = document.querySelector('.thread')
  const inner = document.querySelector('.thread__inner')
  const rowTop = el.getBoundingClientRect().top
  // 0.4.8：发出新问题后视图会平滑滚到这条提问（发送锚定），视野里的纵坐标整轮会平移一次；
  // 这里量「相对内容顶部」的位置，看的仍然是块在时间线里有没有跳（scrollTop 单独记在下面）。
  const y = inner ? Math.round((rowTop - inner.getBoundingClientRect().top) * 10) / 10 : null
  const bodyEl = document.querySelector('.thread__inner > .msg-assistant:last-child')
  const users = [...document.querySelectorAll('[data-user-msg-key]')]
  const lastUserKey = users.length > 0 ? users[users.length - 1].dataset.userMsgKey : null
  const expectedKey = lastUserKey ? 'activity-after-' + lastUserKey : null
  return {
    y,
    key: el.dataset.processKey ?? null,
    // 是不是「当前这一轮」的过程行（上一轮的过程行还留在时间线里）
    current: expectedKey !== null && el.dataset.processKey === expectedKey,
    mark: el.__e2eMark,
    live: el.classList.contains('process--live'),
    stage,
    // 完成后（旧样式）：图标 + 一行结果摘要
    head: (text?.textContent ?? '').trim(),
    // 0.4.9 运行中：左侧固定文案「正在深度求索中」+ 动态省略号，右侧当前状态
    label: (liveLabel?.textContent ?? '').trim(),
    status: (statusEl?.textContent ?? '').trim(),
    aria: (headEl?.getAttribute('aria-label') ?? '').trim(),
    headH: headEl ? Math.round(headEl.getBoundingClientRect().height * 10) / 10 : null,
    leadIcon: !!el.querySelector('.process__lead svg'),
    dots: dots.length,
    dotVisible: dots.filter((d) => Number(getComputedStyle(d).opacity) > 0.5).length,
    toolRunning,
    rows: document.querySelectorAll('[data-testid="process-row"]').length,
    bodyTop: bodyEl ? Math.round((bodyEl.getBoundingClientRect().top - rowTop) * 10) / 10 : null,
    scrollTop: Math.round(thread.scrollTop),
  }
})()`

/** A. 位置固定（严格断言，不夹杂截图）。 */
async function checkProcessRow(cdp) {
  console.log('\n── A. 过程行位置固定（思考 → 工具 → 再思考 → 正文）')
  await openSession(cdp, 's_mock_plan')
  await sleep(500)
  await sendPrompt(cdp, PROCESS_PROMPT)

  const samples = []
  const stagesSeen = new Set()
  const started = Date.now()
  while (Date.now() - started < 30000) {
    const sample = await cdp.eval(SAMPLE)
    if (sample?.current === true) {
      samples.push(sample)
      stagesSeen.add(sample.stage)
      if (sample.stage === 'body') break
    }
    await sleep(40)
  }

  expect('采样到了「实时思考」时刻', stagesSeen.has('reasoning1'), [...stagesSeen])
  expect('采样到了「工具运行」时刻', stagesSeen.has('tool'), [...stagesSeen])
  expect('采样到了「第二次思考」时刻', stagesSeen.has('reasoning2'), [...stagesSeen])
  expect('采样到了正文出现（过程行仍在）', stagesSeen.has('body'), [...stagesSeen])

  const beforeBody = samples.filter((s) => s.stage !== 'body')
  const ys = beforeBody.map((s) => s.y)
  const spread = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : Number.POSITIVE_INFINITY
  expect(
    `正文出现前过程行在时间线里的位置不跳（相对内容顶部，极差 ${spread.toFixed(1)}px ≤ ${Y_TOLERANCE}px）`,
    ys.length > 0 && spread <= Y_TOLERANCE,
    { spread, samples: ys },
  )
  const keys = new Set(samples.map((s) => s.key))
  expect('实时 → 落库切换时块 key 不变', keys.size === 1 && !keys.has(null), [...keys])
  const marks = new Set(samples.map((s) => s.mark))
  expect('块 DOM 节点没有被替换', marks.size === 1 && !marks.has(null), [...marks])
  expect('全程只有一个过程行', samples.every((s) => s.rows === 1), samples.map((s) => s.rows))

  const bodySample = samples.find((s) => s.stage === 'body')
  expect(
    '正文出现在过程行下方',
    bodySample !== undefined && bodySample.bodyTop > 0,
    bodySample,
  )

  // ── 0.4.9 运行中的头部：左「正在深度求索中」+ 动态省略号，右「当前状态」
  const liveSamples = samples.filter((s) => s.live)
  expect(
    '运行中头部左侧都是「正在深度求索中」（省略号不在文案里，由 CSS 画）',
    liveSamples.length > 0 && liveSamples.every((s) => s.label === '正在深度求索中'),
    { live: liveSamples.length, labels: [...new Set(liveSamples.map((s) => s.label))] },
  )
  expect(
    '运行中头部有三个点，且可见点数随时间变化（依次出现，不是同时闪）',
    liveSamples.every((s) => s.dots === 3) &&
      new Set(liveSamples.map((s) => s.dotVisible)).size >= 2,
    {
      dots: [...new Set(liveSamples.map((s) => s.dots))],
      visible: [...new Set(liveSamples.map((s) => s.dotVisible))],
    },
  )
  expect(
    '运行中右侧显示最新一句思考（思考阶段）',
    liveSamples.some((s) => s.stage.startsWith('reasoning') && s.status !== ''),
    liveSamples.filter((s) => s.stage.startsWith('reasoning')).slice(-3).map((s) => s.status),
  )
  expect(
    '工具运行时右侧是工具摘要（工具优先于思考）',
    liveSamples.some((s) => s.toolRunning && /^搜索「.+」…$/u.test(s.status)),
    [...new Set(liveSamples.filter((s) => s.toolRunning).map((s) => s.status))],
  )
  expect(
    '右侧状态里不会重复左侧文案 / 旧的兜底「思考中」',
    liveSamples.every(
      (s) => s.status !== '思考中' && !s.status.includes('正在深度求索中'),
    ),
    [...new Set(liveSamples.map((s) => s.status))].filter((s) => s !== '').slice(0, 6),
  )
  expect(
    '运行中头部的无障碍名称 =「正在深度求索中…」+ 当前状态',
    liveSamples.every(
      (s) => s.aria === `正在深度求索中…${s.status === '' ? '' : ` ${s.status}`}`,
    ),
    { aria: liveSamples[liveSamples.length - 1]?.aria, status: liveSamples[liveSamples.length - 1]?.status },
  )
  const liveHeadHeights = [...new Set(liveSamples.map((s) => s.headH))]

  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '回合结束', timeout: 60000 })
  await sleep(800)
  const ended = await cdp.eval(SAMPLE)
  expect('回合结束后仍是同一个过程行（key 不变）', ended !== null && keys.has(ended.key), ended)
  expect('回合结束后仍是同一个 DOM 节点', ended !== null && ended.mark === 'b-0.4.0', ended)
  expect('回合结束后折叠成一行', ended !== null && ended.live === false, ended)
  expect('回合结束后摘要变成结果', ended !== null && ended.head !== '' && !/^思考中$/u.test(ended.head), ended)
  expect(
    '回合结束后头部恢复旧样式：左侧图标回来、没有动态省略号和右侧状态',
    ended !== null &&
      ended.leadIcon === true &&
      ended.dots === 0 &&
      ended.label === '' &&
      ended.status === '',
    ended,
  )
  expect('回合结束后无障碍名称恢复「过程详情」', ended !== null && ended.aria === '过程详情', ended?.aria)
  expect(
    `运行中头部恒为两行 48px、结束后收成一行 32px（${liveHeadHeights.join('/') || '?'} → ${ended?.headH ?? '?'}px）`,
    ended !== null &&
      ended.headH !== null &&
      liveSamples.length > 0 &&
      liveSamples.every((s) => Math.abs(s.headH - 48) <= 0.5) &&
      Math.abs(ended.headH - 32) <= 0.5,
    { live: liveHeadHeights, ended: ended?.headH },
  )
}

/** A（截图）：再跑一轮，按三个时刻各截一张，证明位置不变。 */
async function shootProcessMoments(cdp) {
  console.log('\n── A′. 过程行三个时刻截图')
  await sendPrompt(cdp, PROCESS_PROMPT)
  const taken = new Set()
  const started = Date.now()
  while (Date.now() - started < 20000) {
    const sample = await cdp.eval(SAMPLE)
    if (sample?.current === true) {
      const name = {
        reasoning1: 'B-07a-process-thinking',
        tool: 'B-07b-process-tool',
        reasoning2: 'B-07c-process-rethinking',
      }[sample.stage]
      if (name && !taken.has(name)) {
        taken.add(name)
        await cdp.shot(name)
        console.log(`  · ${name} @ y=${sample.y}`)
      }
      if (sample.stage === 'body') break
    }
    await sleep(40)
  }
  expect('截图拿到了过程行的三个时刻', taken.size === 3, [...taken])
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '回合结束', timeout: 60000 })
  await sleep(600)
}

/** 第 8/9 张：展开后的时间线 + 长回答排版。 */
async function shootExpandedAndAnswer(cdp) {
  await cdp.eval(`[...document.querySelectorAll('[data-testid="process-row"] .process__head')].pop()?.click()`)
  await waitFor(cdp, `!!document.querySelector('.process__timeline .reasoning')`, { label: '过程行展开' })
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('[data-testid="process-row"]')].pop()
    if (row) row.scrollIntoView({ block: 'start' })
    return true
  })()`)
  await sleep(400)
  await cdp.shot('B-08-process-expanded')

  // 长回答分三张：①开头（粗体 + 标题 + 列表）②表格 + 代码块 ③引用来源角标
  await cdp.eval(`(() => {
    const answers = [...document.querySelectorAll('.thread__inner .msg-assistant')]
    const last = answers[answers.length - 1]
    const first = last ? (last.querySelector('.md > :first-child') ?? last) : null
    if (first) first.scrollIntoView({ block: 'start' })
    return true
  })()`)
  await sleep(450)
  await cdp.shot('B-09-long-answer')

  await cdp.eval(`(() => {
    const pre = [...document.querySelectorAll('.md pre')]
    const target = pre[1] ?? pre[0]
    if (target) target.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(450)
  await cdp.shot('B-09b-long-answer-code')

  await cdp.eval(`(() => {
    const pills = document.querySelector('.cite-row')
    if (pills) pills.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(450)
  await cdp.shot('B-09c-long-answer-sources')

}

/** 0.4.10：引用来源「+N」可点（不依赖 --shots，每次都跑）。 */
async function checkCitations(cdp) {
  console.log('\n── 引用来源：「+N」展开 / 收起（0.4.10）')
  await waitFor(cdp, `!!document.querySelector('.cite-row')`, { label: '引用来源角标' })
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.cite-row')].pop()
    if (row) row.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(200)
  // 0.4.10：「+N」可点 —— 展开全部来源，末尾变成「收起」，再点收回
  const citesBefore = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.cite-row')].pop()
    const more = row?.querySelector('.cite-pill--more')
    return {
      links: row ? row.querySelectorAll('a.cite-pill').length : 0,
      more: more?.textContent?.trim() ?? '',
      isButton: more?.tagName === 'BUTTON',
    }
  })()`)
  const extra = Number(citesBefore.more.replace('+', ''))
  expect(
    `来源超过 3 个时显示 3 个 + 「+N」按钮（${citesBefore.links} 个 + ${citesBefore.more}）`,
    citesBefore.links === 3 && extra > 0 && citesBefore.isButton,
    citesBefore,
  )
  await cdp.eval(`[...document.querySelectorAll('.cite-row')].pop()?.querySelector('.cite-pill--more')?.click()`)
  await sleep(300)
  const citesOpen = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.cite-row')].pop()
    return {
      links: row ? row.querySelectorAll('a.cite-pill').length : 0,
      more: row?.querySelector('.cite-pill--more')?.textContent?.trim() ?? '',
    }
  })()`)
  expect(
    `点「+N」展开全部来源（${citesOpen.links} = 3 + ${extra}），末尾是「收起」`,
    citesOpen.links === 3 + extra && citesOpen.more === '收起',
    citesOpen,
  )
  if (SHOTS) await cdp.shot('B-09d-long-answer-sources-open')
  await cdp.eval(`[...document.querySelectorAll('.cite-row')].pop()?.querySelector('.cite-pill--more')?.click()`)
  await sleep(300)
  const citesClosed = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.cite-row')].pop()
    return {
      links: row ? row.querySelectorAll('a.cite-pill').length : 0,
      more: row?.querySelector('.cite-pill--more')?.textContent?.trim() ?? '',
    }
  })()`)
  expect('点「收起」回到 3 个 + 「+N」', citesClosed.links === 3 && citesClosed.more === citesBefore.more, citesClosed)
}

/**
 * C（0.4.9）：运行中但还没有任何可显示的状态时，右侧**留空**——不重复「思考中」。
 *
 * 用 `/__test/reply { tickMs: 700 }` 把这一轮放慢：第一段思考要 6 拍（约 4 秒）才到，
 * 占位行能稳定停住，不用抢 TICK_MS=12 时那 ~70ms 的窗口；顺便在这段时间里按帧看
 * 动态省略号（0 → 1 → 2 → 3）和 prefers-reduced-motion 的降级。
 * 这一条放在最后跑：占位行之后这一轮还在慢慢跑，不再影响前面的断言。
 */
async function checkLiveFallback(cdp) {
  console.log('\n── C. 运行中还没有状态时：右侧留空（0.4.9）')
  const plan = await hubPost('/__test/reply', { tickMs: 700 })
  expect('mock 把下一条回复放慢（第一段思考约 4 秒后才到）', plan?.ok === true, plan)
  await sendPrompt(cdp, '先别急着回答，我想看看还没开始思考时的样子')
  await waitFor(cdp, `!!document.querySelector('[data-testid="process-row"].process--live')`, {
    label: '占位过程行',
    timeout: 8000,
  })
  const placeholder = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('[data-testid="process-row"]')].pop()
    const head = row?.querySelector('.process__head')
    return {
      live: row?.classList.contains('process--live') ?? false,
      label: (row?.querySelector('.process__live-label')?.textContent ?? '').trim(),
      status: (row?.querySelector('.process__status')?.textContent ?? '').trim(),
      statusBox: !!row?.querySelector('.process__status'),
      aria: (head?.getAttribute('aria-label') ?? '').trim(),
      head: (row?.querySelector('.process__text')?.textContent ?? '').trim(),
      headH: head ? Math.round(head.getBoundingClientRect().height * 10) / 10 : null,
    }
  })()`)
  expect('还没有状态时左侧仍然是「正在深度求索中」', placeholder.label === '正在深度求索中', placeholder)
  expect(
    '还没有状态时右侧留空（不显示「思考中」）',
    placeholder.status === '' && placeholder.statusBox === true && placeholder.live === true,
    placeholder,
  )
  expect(
    '无障碍名称只有文案 + 省略号，不重复「思考中」',
    placeholder.aria === '正在深度求索中…',
    placeholder.aria,
  )
  expect(
    '占位行（还没有状态）也是两行 48px：状态出现时不推动时间线',
    placeholder.headH !== null && Math.abs(placeholder.headH - 48) <= 0.5,
    placeholder.headH,
  )
  // 动态省略号：按帧观察 1.6 秒（一个循环 1.35 秒），应当看到 0 → 1 → 2 → 3 个点依次出现
  const phases = await cdp.eval(`new Promise((resolve) => {
    const dots = [...document.querySelectorAll('[data-testid="process-row"].process--live .process__ellipsis i')]
    if (dots.length !== 3) { resolve({ dots: dots.length, seen: [] }); return }
    const seen = new Set()
    const started = performance.now()
    const step = () => {
      seen.add(dots.filter((d) => Number(getComputedStyle(d).opacity) > 0.5).length)
      if (performance.now() - started < 1600) requestAnimationFrame(step)
      else resolve({ dots: dots.length, seen: [...seen].sort((a, b) => a - b) })
    }
    requestAnimationFrame(step)
  })`)
  expect(
    '动态省略号按帧看是 0 → 1 → 2 → 3 个点依次出现（循环）',
    phases.dots === 3 && phases.seen.join(',') === '0,1,2,3',
    phases,
  )
  // prefers-reduced-motion：动态三点换成静态「…」，流光也停（不再动）
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await sleep(150)
  const reduced = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('[data-testid="process-row"]')].pop()
    const dots = row ? [...row.querySelectorAll('.process__ellipsis i')] : []
    const staticDots = row?.querySelector('.process__ellipsis b')
    const label = row?.querySelector('.process__live-label')
    return {
      dots: dots.length,
      dotsShown: dots.filter((d) => getComputedStyle(d).display !== 'none').length,
      staticText: staticDots ? staticDots.textContent.trim() : '',
      staticShown: staticDots ? getComputedStyle(staticDots).display !== 'none' : false,
      labelAnim: label ? getComputedStyle(label).animationName : '',
      label: (label?.textContent ?? '').trim(),
    }
  })()`)
  expect(
    'prefers-reduced-motion：动态三点换成静态「…」，流光也停',
    reduced.dots === 3 &&
      reduced.dotsShown === 0 &&
      reduced.staticShown === true &&
      reduced.staticText === '…' &&
      reduced.labelAnim === 'none' &&
      reduced.label === '正在深度求索中',
    reduced,
  )
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })
}

/** B. 问题导航条。 */
async function checkQuestionRail(cdp, { shots = false } = {}) {
  console.log('\n── B. 问题导航条（≥3 条提问）')
  const seeded = await hubPost('/__test/seed-thread?session=s_mock_plan&turns=4')
  expect('mock 补了 4 轮问答（用于导航条）', seeded?.ok === true && seeded.messages >= 8, seeded)
  // 会话已经打开时路由不变、不会重新订阅：整页重载后重新登录，按 Hub 的 history 重新渲染
  await cdp.send('Page.reload')
  await sleep(1200)
  await waitFor(cdp, `!!document.querySelector('.login__submit')`, { label: '重载后登录页', timeout: 20000 })
  await login(cdp)
  await sleep(300)
  await openSession(cdp, 's_mock_plan')
  await waitFor(cdp, `document.querySelectorAll('.msg-user').length >= 3`, { label: '≥3 条用户消息' })
  await waitFor(cdp, `!!document.querySelector('.rail')`, { label: '导航条挂载' })
  await sleep(600)

  const initial = await cdp.eval(`(() => {
    const rail = document.querySelector('.rail')
    const thread = document.querySelector('.thread')
    return {
      dots: document.querySelectorAll('.rail__dot').length,
      users: document.querySelectorAll('.msg-user').length,
      visible: rail.classList.contains('rail--visible'),
      opacity: Number(getComputedStyle(rail).opacity),
      scrollable: thread.scrollHeight - thread.clientHeight,
      role: rail.getAttribute('role'),
      label: rail.getAttribute('aria-label'),
      dotLabels: [...document.querySelectorAll('.rail__dot')].map((d) => d.getAttribute('aria-label')),
    }
  })()`)
  expect('每条用户提问一个圆点', initial.dots === initial.users, initial)
  expect('时间线足够长（可滚动）', initial.scrollable > 400, initial.scrollable)
  expect('用户还没滚动时导航条不显示（淡出）', initial.visible === false && initial.opacity === 0, initial)
  expect('导航条 role=navigation / aria-label=提问导航', initial.role === 'navigation' && initial.label === '提问导航', initial)
  expect(
    '每个圆点都有 aria-label（提问简述）',
    initial.dotLabels.every((label) => typeof label === 'string' && label.length > 0),
    initial.dotLabels,
  )

  // 用户滚动：滚轮先触发 userInteracting，再真正滚动
  const threadBox = await cdp.eval(`(() => {
    const rect = document.querySelector('.thread').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: threadBox.x,
    y: threadBox.y,
    deltaX: 0,
    deltaY: -320,
    pointerType: 'mouse',
  })
  await waitFor(cdp, `document.querySelector('.rail')?.classList.contains('rail--visible')`, {
    label: '滚动后导航条淡入',
  })
  await sleep(400)
  const afterScroll = await cdp.eval(`(() => {
    const rail = document.querySelector('.rail')
    const track = rail.querySelector('.rail__track').getBoundingClientRect()
    const hit = rail.getBoundingClientRect()
    return {
      visible: rail.classList.contains('rail--visible'),
      opacity: Number(getComputedStyle(rail).opacity),
      trackWidth: Math.round(track.width),
      trackTop: Math.round(track.top - hit.top),
      trackBottom: Math.round(hit.bottom - track.bottom),
      hitWidth: Math.round(hit.width),
    }
  })()`)
  expect('滚动后导航条淡入', afterScroll.visible === true && afterScroll.opacity > 0.9, afterScroll)
  expect('轨道宽 3px、上下各留 12px', afterScroll.trackWidth === 3 && afterScroll.trackTop === 12 && afterScroll.trackBottom === 12, afterScroll)
  expect('热区约 28–32px（不挡正文）', afterScroll.hitWidth >= 28 && afterScroll.hitWidth <= 34, afterScroll)

  const geometry = await cdp.eval(`(() => {
    const rail = document.querySelector('.rail').getBoundingClientRect()
    const dots = [...document.querySelectorAll('.rail__dot')].map((dot) => {
      const r = dot.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    return { pressX: Math.round(rail.left + rail.width / 2), railLeft: Math.round(rail.left), dots }
  })()`)
  const pressX = geometry.pressX
  const labels = await cdp.eval(
    `[...document.querySelectorAll('.rail__dot')].map((d) => d.getAttribute('aria-label'))`,
  )
  expect('至少 3 个提问点（够做拖动吸附）', geometry.dots.length >= 3, geometry.dots.length)

  // 拖动：按在最后一个点，向上拖到第 2 个点
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pressX,
    y: geometry.dots[geometry.dots.length - 1].y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pressX,
    y: geometry.dots[1].y,
    button: 'left',
    buttons: 1,
  })
  await sleep(200)
  const dragging = await cdp.eval(`(() => {
    const bubble = document.querySelector('.rail__bubble')
    const active = document.querySelector('.rail__dot--active')
    const rail = document.querySelector('.rail')
    return {
      bubble: bubble ? bubble.textContent.trim() : null,
      bubbleVisible: bubble !== null && bubble.getBoundingClientRect().width > 0,
      bubbleMax: bubble ? parseFloat(getComputedStyle(bubble).maxWidth) : null,
      active: active ? Number(active.dataset.railIndex) : null,
      visible: rail.classList.contains('rail--visible'),
      opacity: Number(getComputedStyle(rail).opacity),
      highlighted: [...document.querySelectorAll('.rail__dot--seen')].length,
    }
  })()`)
  expect('拖动时左侧弹出简述气泡', dragging.bubbleVisible === true, dragging)
  expect('气泡内容是提问前 20 字（取自 aria-label）', dragging.bubble === labels[1], {
    bubble: dragging.bubble,
    expected: labels[1],
  })
  expect('气泡最大宽度 60vw', dragging.bubbleMax !== null && dragging.bubbleMax <= VIEWPORT.width * 0.6 + 1, dragging.bubbleMax)
  expect('按住时吸附到目标提问点', dragging.active === 1, dragging)
  expect('手指按在轨道上时保持显示', dragging.visible === true && dragging.opacity > 0.9, dragging)
  expect('当前视口里的提问点高亮', dragging.highlighted >= 1, dragging)
  if (shots) await cdp.shot('B-10-question-rail-drag')

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pressX,
    y: geometry.dots[1].y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  await sleep(1400)
  const jumped = await cdp.eval(`(() => {
    const thread = document.querySelector('.thread')
    const target = [...document.querySelectorAll('.msg-user')][1]
    const rail = document.querySelector('.rail')
    return {
      offset: Math.round((target.getBoundingClientRect().top - thread.getBoundingClientRect().top) * 10) / 10,
      bubble: !!document.querySelector('.rail__bubble'),
      jumpButton: !!document.querySelector('.to-bottom'),
      railVisible: rail.classList.contains('rail--visible'),
    }
  })()`)
  expect(
    `松手后目标提问顶部对齐到 ${JUMP_OFFSET}±${JUMP_TOLERANCE}px（实测 ${jumped.offset}px）`,
    Math.abs(jumped.offset - JUMP_OFFSET) <= JUMP_TOLERANCE,
    jumped,
  )
  expect('松手后气泡消失', jumped.bubble === false, jumped)
  expect('跳转设 pinned=false（出现回到底部按钮）', jumped.jumpButton === true, jumped)

  // 回到底部按钮：40px 圆形、只有图标
  const toBottom = await cdp.eval(`(() => {
    const btn = document.querySelector('.to-bottom')
    if (!btn) return null
    const rect = btn.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: (btn.textContent ?? '').trim(),
      icon: !!btn.querySelector('svg'),
      radius: getComputedStyle(btn).borderRadius,
      shadow: getComputedStyle(btn).boxShadow !== 'none',
      label: btn.getAttribute('aria-label'),
    }
  })()`)
  expect('回到底部按钮：40px 圆形', toBottom !== null && toBottom.width === 40 && toBottom.height === 40, toBottom)
  expect('回到底部按钮只有图标（没有文字）', toBottom !== null && toBottom.text === '' && toBottom.icon === true, toBottom)
  expect('回到底部按钮有阴影', toBottom !== null && toBottom.shadow === true, toBottom)
  if (shots) await cdp.shot('B-11-to-bottom')

  await cdp.eval(`document.querySelector('.to-bottom')?.click()`)
  await sleep(1000)
  const backToBottom = await cdp.eval(`(() => {
    const thread = document.querySelector('.thread')
    return {
      distance: Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
      button: !!document.querySelector('.to-bottom'),
    }
  })()`)
  expect(
    '点回到底部后恢复吸底（距底 < 24px 且按钮消失）',
    backToBottom.distance < 24 && backToBottom.button === false,
    backToBottom,
  )
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  if (SHOTS) await fs.mkdir(SHOTS, { recursive: true })
  const cdp = await Cdp.attach(CDP_PORT)
  await hubPost('/__test/reset')
  await setup(cdp)

  await checkProcessRow(cdp)
  if (SHOTS) {
    await shootProcessMoments(cdp)
    await shootExpandedAndAnswer(cdp)
  }
  await checkCitations(cdp)
  await checkQuestionRail(cdp, { shots: Boolean(SHOTS) })
  await checkLiveFallback(cdp)

  const passed = checks.filter((c) => c.ok).length
  const report = { at: new Date().toISOString(), app: APP_URL, hub: HUB_URL, theme: THEME, passed, total: checks.length, checks }
  await fs.writeFile(path.join(OUT, `e2e-thread-${THEME}.json`), JSON.stringify(report, null, 2))
  console.log(`\n结果（${THEME}）：${passed}/${checks.length} 通过，报告 ${path.join(OUT, `e2e-thread-${THEME}.json`)}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

main().catch((error) => {
  console.error('e2e-thread 失败：', error)
  process.exitCode = 1
})
