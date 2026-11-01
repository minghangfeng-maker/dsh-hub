#!/usr/bin/env node
/**
 * A2 端到端探针：v2 帧（工具卡 / 思考 / 产出文件 / 附件上传 / 重命名 / 归档 / 问答 / 审批）
 * 在真实 HTTP + WS（本地 mock Hub）下的行为，并在工具卡流式期间复测手感指标。
 *
 * 与 e2e-a1.mjs 的分工：
 *  - e2e-a1.mjs 是 A1 的回归（登录/唤醒/弹层/停止/续传/归档筛选 + 61fps/拖动/fling）；
 *  - 本文件只测 A2 新增能力，加一段「有工具卡时」的帧率与长任务窗口。
 *
 * 用法：
 *   node scripts/e2e-a2.mjs --app http://127.0.0.1:5242 --hub http://127.0.0.1:5245 \
 *        --cdp 9241 --out ../mobile-plan/v2/artifacts/a2-screenshots
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
const OUT = args.out ?? 'e2e-a2-output'
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

const FPS_RECORDER = `(() => {
  window.__a2 = { frames: [], longtasks: [], on: true, marks: [], startedAt: performance.now(), streamStarted: false, turnEndAt: null }
  window.__a2.mark = (name) => window.__a2.marks.push({ name, t: Math.round(performance.now()) })
  const watchTurn = () => {
    const c = window.__dshHub?.chat
    const r = window.__a2
    if (!r) return
    if (c?.isStreaming) r.streamStarted = true
    else if (r.streamStarted && r.turnEndAt == null) r.turnEndAt = performance.now()
    requestAnimationFrame(watchTurn)
  }
  requestAnimationFrame(watchTurn)
  const loop = (ts) => {
    const r = window.__a2
    if (!r.on) return
    r.frames.push(ts)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50 && entry.startTime >= window.__a2.startedAt) {
          window.__a2.longtasks.push({ duration: Math.round(entry.duration), name: entry.name, start: Math.round(entry.startTime) })
        }
      }
    })
    obs.observe({ type: 'longtask', buffered: false })
  } catch {}
  return true
})()`

const SCROLL_RECORDER = `(() => {
  const el = document.querySelector('.thread')
  window.__a2rec = { s: [], on: true }
  const loop = () => {
    const r = window.__a2rec
    if (!r.on) return
    r.s.push({ t: Math.round(performance.now()), top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) })
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
    reversals,
    maxBackJumpPx: maxBack,
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

/** 诊断里的「走网络的 file:read」时间戳（40 条环形缓冲，越早抓越可靠）。 */
const NETWORK_FILE_READS = `(() => {
  try {
    const list = JSON.parse(localStorage.getItem('dsh-hub:diagnostics:v1') ?? '[]')
    return list
      .filter((e) => e && e.name === 'file:read' && String(e.detail ?? '').includes('src=network'))
      .map((e) => e.at)
  } catch { return [] }
})()`

async function hubStatus(user = 'demo') {
  const res = await fetch(`${HUB_URL}/__test/status?user=${user}`)
  return res.json()
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
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(700)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload')
  await sleep(700)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  // 先确认这一份 dist 真的指向本机 mock Hub：构建参数忘了给时会连生产地址，
  // 表现是「登录网络错误」，很容易被误判成后端挂了。
  if ('.') {
    const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
    expect(`构建产物指向本机 mock Hub（当前 ${origin}）`, origin === HUB_URL, origin)
  }
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(100)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道连接', timeout: 30000 })

  // ---- 1. v2 特性协商
  const features = await cdp.eval(`Array.from(window.__dshHub.chat.features)`)
  expect(
    // 2026-10-26 起新增第 9 个特性 `usage`（会话信息面板的用量）；
    // 2026-10-27（0.3.0 / WP46）起新增第 10 个 `session-state`（回合态权威快照）。
    'App 声明并协商到全部 10 个 v2 特性',
    Array.isArray(features) && features.length === 10 && features.includes('session-state'),
    features,
  )
  const capsV2 = await cdp.eval(`(() => {
    const c = window.__dshHub.chat.capabilities
    return c ? { models: c.models, filesRead: c.filesRead, filesUpload: c.filesUpload, deliverables: c.deliverables, rename: c.rename, archive: c.archive } : null
  })()`)
  expect('v2 能力位已摊平到 capabilities（弹层/文件/上传用）', capsV2?.filesRead === true && capsV2?.filesUpload === true, capsV2)

  // 打开已有会话
  await cdp.eval(`window.__dshHub.chat.openSession('s_mock_plan')`)
  await sleep(400)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/c/s_mock_plan` })
  await sleep(400)
  await waitFor(cdp, `document.querySelectorAll('.thread__inner .md-block, .thread__inner .msg-assistant').length > 0`, {
    label: '会话内容',
  })

  // ---- 2. 发一条消息：思考 → 搜索工具 → 正文 → Python → 交付
  await cdp.eval(FPS_RECORDER)
  await cdp.eval(`window.__a2.mark('send')`)
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    el.value = '帮我查一下最新的通道契约，再算个 sin 看看'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  // Composer 的 canSend 依赖 v-model 的异步 watch：输入后要等一拍再点，否则点的是 disabled 按钮。
  await sleep(150)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
  // 0.4.0 §2：思考不再是时间线末尾的独立折叠块，而是「过程行」的末行；
  // 运行中这一行只有一个固定高度的单行头部：0.4.9 起是「正在深度求索中… + 当前状态」，默认折叠。
  await waitFor(cdp, `window.__dshHub.chat.streamingReasoning.length > 0`, { label: '思考增量' })
  await waitFor(cdp, `!!document.querySelector('[data-testid="process-row"].process--live')`, {
    label: '运行中的过程行',
  })
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="process-row"] .process__live-label')?.textContent?.trim().length > 0`,
    { timeout: 3000, label: '运行中头部文案' },
  )
  const liveProcess = await cdp.eval(`(() => {
    const row = document.querySelector('[data-testid="process-row"]')
    const head = row?.querySelector('.process__head')
    const label = row?.querySelector('.process__live-label')
    const status = row?.querySelector('.process__status')
    return {
      label: label?.textContent?.trim() ?? '',
      status: status?.textContent?.trim() ?? '',
      shimmer: !!label?.classList.contains('process__shimmer'),
      dots: row?.querySelectorAll('.process__ellipsis i').length ?? 0,
      lines: label ? label.getClientRects().length : 0,
      statusLines: status && status.textContent ? Math.round(status.scrollHeight / 20) : 0,
      height: head ? Math.round(head.getBoundingClientRect().height) : 0,
      timeline: !!row?.querySelector('.process__timeline'),
      rows: document.querySelectorAll('[data-testid="process-row"]').length,
    }
  })()`)
  expect(
    '运行中的过程行显示「正在深度求索中」+ 当前状态',
    liveProcess.label === '正在深度求索中' && liveProcess.status.length > 0,
    liveProcess,
  )
  expect('运行中的过程行左侧是三个点（依次出现）', liveProcess.dots === 3, liveProcess)
  expect('运行中的过程行文案带 shimmer', liveProcess.shimmer === true, liveProcess)
  expect(
    '过程行头部两行（文案一行 + 状态一行），固定 48px，不推动时间线',
    liveProcess.lines === 1 && liveProcess.statusLines <= 1 && liveProcess.height === 48,
    liveProcess,
  )
  expect('运行中过程行默认折叠（没有嵌套的思考/工具面板）', liveProcess.timeline === false, liveProcess)
  expect('整轮只有一个过程行', liveProcess.rows === 1, liveProcess)
  // 用户手动展开（运行中也允许）：展开成竖向时间线，实时思考是其中一个节点
  await cdp.eval(`document.querySelector('[data-testid="process-row"] .process__head').click()`)
  await waitFor(cdp, `!!document.querySelector('.process__timeline .reasoning .reasoning__text')`, {
    label: '过程行展开',
  })
  const timelineNode = await cdp.eval(`(() => {
    const text = document.querySelector('.process__timeline .reasoning .reasoning__text')
    const clamp = document.querySelector('.process__timeline .reasoning__clamp')
    return {
      length: text?.textContent?.trim().length ?? 0,
      clamp: !!clamp,
      clampOverflow: clamp ? clamp.scrollHeight > clamp.clientHeight + 1 : false,
      steps: document.querySelectorAll('.process__step').length,
    }
  })()`)
  expect('展开后思考节点显示实时正文（最多 6 行）', timelineNode.length > 0 && timelineNode.clamp === true, timelineNode)
  await cdp.shot('01-reasoning')

  await waitFor(cdp, `window.__dshHub.chat.toolCards.length >= 1`, { label: '搜索工具卡' })
  // 工具卡先开始后结束：摘要要等 end 帧（带来源）才变成「搜索了 N 个网页」。
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.tool__summary')).some(e => /搜索了 \\d+ 个网页/.test(e.textContent))`,
    { label: '搜索工具卡结束', timeout: 30000 },
  )
  const searchSummary = await cdp.eval(`document.querySelector('.tool__summary')?.textContent ?? ''`)
  expect('工具卡摘要显示「搜索了 N 个网页」', /搜索了 \d+ 个网页/.test(searchSummary), searchSummary)
  // 展开工具卡：输入 / 输出 / 来源
  await cdp.eval(`document.querySelector('.tool__head').click()`)
  await sleep(400)
  const cardText = await cdp.eval(`document.querySelector('.tool')?.innerText ?? ''`)
  expect('工具卡展开后有输入与输出预览', cardText.includes('输入') && cardText.includes('输出'), cardText.slice(0, 120))
  expect('搜索工具卡显示来源列表', cardText.includes('来源') && cardText.includes('M5'), cardText.slice(0, 160))
  await cdp.shot('02-tool-card')

  // 流式期间的工具卡帧率窗口（工具卡 + 正文同时增长）
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '回合结束', timeout: 60000 })
  await sleep(600)
  // 0.4.0 §2：这一轮结束后过程行折叠成一行（结果摘要），展开后是竖向时间线（思考 → 工具）
  const collapsed = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="process-row"]')]
    const last = rows.pop()
    return last
      ? {
          count: rows.length + 1,
          open: !!last.querySelector('.process__timeline'),
          title: last.querySelector('.process__text')?.textContent?.trim() ?? '',
          live: last.classList.contains('process--live'),
          reasoningVisible: document.querySelectorAll('.reasoning').length,
        }
      : null
  })()`)
  expect(
    '过程行完成后折叠成一行（执行了 N 个操作）',
    !!collapsed &&
      collapsed.open === false &&
      collapsed.live === false &&
      /执行了 \d+ 个操作/.test(collapsed.title) &&
      collapsed.reasoningVisible === 0,
    collapsed,
  )
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="process-row"]')]
    rows[rows.length - 1]?.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(250)
  await cdp.shot('02a-turn-collapsed')
  await cdp.eval(`[...document.querySelectorAll('.process__head')].pop().click()`)
  await waitFor(cdp, `!!document.querySelector('.process__timeline .reasoning')`, { label: '过程行展开' })
  const rowsInfo = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('[data-testid="process-row"]')].pop()
    const steps = [...row.querySelectorAll('.process__step')].map((step) =>
      step.querySelector('.reasoning') ? 'reasoning' : step.querySelector('.tool') ? 'tool' : 'other',
    )
    return {
      steps,
      reasoningText: row.querySelector('.reasoning__text')?.textContent?.trim().length ?? 0,
      toolSummary: row.querySelector('.tool__summary')?.textContent?.trim() ?? '',
    }
  })()`)
  expect(
    '展开后是竖向时间线：思考 → 工具，思考节点有正文',
    rowsInfo.steps.includes('reasoning') &&
      rowsInfo.steps.includes('tool') &&
      rowsInfo.reasoningText > 0 &&
      /搜索了 \d+ 个网页/.test(rowsInfo.toolSummary),
    rowsInfo,
  )
  // 回归：本轮最后一条用户消息之后，仍是「过程块 → 助手回答」，工具卡没跑到用户消息上面
  const sequence = await cdp.eval(`(() => {
    const kids = [...document.querySelector('.thread__inner').children]
    return kids.map((el) =>
      el.classList.contains('msg-user')
        ? 'user'
        : el.dataset.testid === 'process-row'
          ? 'process'
          : el.classList.contains('msg-assistant')
            ? 'assistant'
            : el.classList.contains('deliverable')
              ? 'deliverable'
              : 'other',
    )
  })()`)
  const lastUser = sequence.lastIndexOf('user')
  const afterUser = sequence.slice(lastUser + 1)
  expect(
    '最后一条用户消息之后是过程行，然后是回答',
    afterUser.includes('process') && afterUser.indexOf('assistant') > afterUser.indexOf('process'),
    sequence,
  )
  await cdp.shot('02b-turn-steps')
  await cdp.eval(`(() => {
    const users = document.querySelectorAll('.msg-user')
    const last = users[users.length - 1]
    if (last) last.scrollIntoView({ block: 'start' })
    return true
  })()`)
  await sleep(300)
  await cdp.shot('02b-turn-steps')
  const perf = await cdp.eval(`(() => {
    const r = window.__a2
    r.on = false
    const start = r.marks.find(m => m.name === 'send')?.t ?? r.startedAt
    const end = r.turnEndAt ?? performance.now()
    const frames = r.frames.filter(t => t >= start && t <= end)
    const span = Math.max(1, end - start)
    const deltas = []
    for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i-1])
    deltas.sort((a,b) => a-b)
    return {
      frames: frames.length,
      spanMs: Math.round(span),
      fps: Math.round((frames.length / span) * 1000),
      p95: Math.round(deltas[Math.floor(deltas.length * 0.95)] ?? 0),
      max: Math.round(deltas[deltas.length-1] ?? 0),
      // 只统计**流式窗口内**的长任务：Shiki 首次高亮发生在回合结束后（A1 的既有行为），
      // 那是预热策略的一部分，不算流式卡顿。
      longtasks: r.longtasks.filter((x) => x.start <= end),
      postTurnLongtasks: r.longtasks.filter((x) => x.start > end),
      streamingLength: window.__dshHub.chat.streamingText.length,
    }
  })()`)
  expect('有工具卡时的流式帧率 ≥ 55fps', perf.fps >= 55, perf)
  expect('流式期间无 >50ms 长任务', perf.longtasks.length === 0, perf.longtasks)

  // ---- 3. 产出文件：图片内联 + 大图 + 文件卡
  await waitFor(cdp, `window.__dshHub.chat.deliverables.length >= 1`, { label: '交付物' })
  await waitFor(cdp, `Object.keys(window.__dshHub.files.fileUrls).length >= 2`, { label: '文件下载', timeout: 30000 })
  const inlineImages = await cdp.eval(`Array.from(document.querySelectorAll('.image-file__frame img')).map(i => i.src.slice(0, 5))`)
  expect('交付图片内联显示（blob: URL）', inlineImages.length >= 2 && inlineImages.every((s) => s === 'blob:'), inlineImages)
  const fileCards = await cdp.eval(`document.querySelectorAll('.file-card').length`)
  expect('非图片产出显示下载卡', fileCards >= 1, fileCards)
  const networkReadsBefore = await cdp.eval(NETWORK_FILE_READS)
  await cdp.shot('03-deliverable')

  // 大图：点开 → viewer；保存按钮存在；关闭
  await cdp.eval(`document.querySelector('.image-file__frame').click()`)
  await sleep(400)
  const viewer = await cdp.eval(`(() => {
    const el = document.querySelector('.viewer')
    return el ? { img: !!el.querySelector('img'), save: !!el.querySelector('.viewer__save'), count: el.querySelector('.viewer__count')?.textContent?.trim() ?? '' } : null
  })()`)
  expect('点开图片进入大图查看', viewer?.img === true, viewer)
  expect('大图页有保存入口', viewer?.save === true)
  await cdp.shot('04-image-viewer')
  await cdp.eval(`document.querySelector('.viewer__btn').click()`)

  // ---- 4. 附件上传：addAttachment → upload-begin/chunk → 进度 100% → 发送带 attachments
  const pngBase64 = await fs.readFile(path.join(OUT, 'upload-sample.png')).then((buf) => buf.toString('base64')).catch(() => null)
  // 没有样例文件时用 1x1 PNG（真正走 upload 帧，体积不是重点）
  const sample =
    pngBase64 ??
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await cdp.eval(`(() => {
    // 真机上预览图由相机/相册给；e2e 里用同一个 base64 造一个 blob URL，行为一致。
    const bin = atob(${JSON.stringify(sample)})
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
    window.__dshHub.chat.addAttachment({
      kind: 'image',
      name: 'a2-upload.png',
      mimeType: 'image/png',
      bytes: bytes.length,
      base64: ${JSON.stringify(sample)},
      previewUrl: url
    })
    return true
  })()`)
  await waitFor(cdp, `window.__dshHub.chat.attachments.length === 1`, { label: '附件入列' })
  await waitFor(cdp, `window.__dshHub.chat.attachments[0]?.state === 'ready'`, { label: '附件上传完成', timeout: 20000 })
  const attach = await cdp.eval(`(() => {
    const a = window.__dshHub.chat.attachments[0]
    return a ? { state: a.state, progress: a.progress, uploadId: a.uploadId, bytes: a.bytes } : null
  })()`)
  expect('附件上传走帧并到达 100%', attach.state === 'ready' && attach.progress >= 1 && !!attach.uploadId, {
    state: attach.state,
    progress: attach.progress,
    uploadId: attach.uploadId,
  })
  await cdp.shot('05-attachment-ready')
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    el.value = '这张图你看看'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.send-btn').click()`)
  await sleep(500)
  const statusAfterSend = await hubStatus()
  expect(
    '发送时带上 attachments（Hub 收到 uploadId 引用）',
    Array.isArray(statusAfterSend.lastAttachments) && statusAfterSend.lastAttachments.length === 1,
    statusAfterSend.lastAttachments,
  )
  expect(
    '用户气泡里显示附件缩略图',
    await cdp.eval(`document.querySelectorAll('.msg-user__thumb').length >= 1`),
  )

  // ---- 5. DSH 提问卡：显式回答
  await fetch(`${HUB_URL}/__test/question?session=s_mock_plan`, { method: 'POST' })
  await waitFor(cdp, `document.querySelector('.question-card')`, { label: '提问卡' })
  await cdp.eval(`(() => {
    document.querySelectorAll('.question__option').forEach((el) => el.click())
    return true
  })()`)
  await sleep(200)
  await cdp.eval(`document.querySelector('.question-card__submit').click()`)
  await sleep(600)
  const afterAnswer = await hubStatus()
  expect(
    '回答提问后 Hub 收到 answers',
    Array.isArray(afterAnswer.lastAnswers?.answers) && afterAnswer.lastAnswers.answers.length === 1,
    afterAnswer.lastAnswers,
  )
  const cardGone = await cdp.eval(`!document.querySelector('.question-card')`)
  expect('回答后提问卡消失（question-settled）', cardGone)

  // ---- 6. 审批卡：手机端可以直接批准（v2 capabilities.approvals=true）
  await fetch(`${HUB_URL}/__test/approval?session=s_mock_plan`, { method: 'POST' })
  await waitFor(cdp, `document.querySelector('.approval-card')`, { label: '审批卡' })
  const approvalText = await cdp.eval(`document.querySelector('.approval-card').innerText`)
  expect('审批卡说明是「需要你批准」', approvalText.includes('需要你批准'), approvalText.replace(/\n/g, ' ').slice(0, 120))
  expect(
    '审批卡有「允许一次 / 拒绝」按钮',
    (await cdp.eval(`!!document.querySelector('.approval-card__btn--primary')`)) &&
      (await cdp.eval(`document.querySelector('.approval-card')?.innerText.includes('拒绝')`)),
    approvalText.replace(/\n/g, ' ').slice(0, 160),
  )
  await cdp.shot('06-approval')
  await cdp.eval(`document.querySelector('.approval-card__btn--primary').click()`)
  await waitFor(cdp, `!document.querySelector('.approval-card')`, { label: '审批结算后卡片消失' })

  // ---- 7. 长按会话：重命名 + 归档
  await cdp.eval(`window.__dshHub.ui.openSessionActions('s_mock_plan', '今天的计划')`)
  await waitFor(cdp, `document.querySelector('.sheet__title')?.textContent?.includes('今天的计划')`, { label: '会话菜单' })
  await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('.sheet__item')).find(el => el.textContent.includes('重命名'))
    btn.click()
    return true
  })()`)
  await sleep(200)
  await cdp.eval(`(() => {
    const el = document.querySelector('.sheet__input')
    el.value = 'A2 重命名测试'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    const btn = Array.from(document.querySelectorAll('.sheet__confirm'))[0]
    btn.click()
    return true
  })()`)
  await waitFor(cdp, `!document.querySelector('.sheet__input')`, { label: '重命名完成' })
  const afterRename = await hubStatus()
  const renamed = afterRename.sessions.find((s) => s.sessionId === 's_mock_plan')?.title
  expect('长按会话可以重命名（Hub 侧标题已变）', renamed === 'A2 重命名测试', renamed)

  await cdp.eval(`window.__dshHub.chat.refreshSessions()`)
  await sleep(400)
  await cdp.eval(`window.__dshHub.ui.openSessionActions('s_mock_blank', '新会话')`)
  await sleep(200)
  await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('.sheet__item')).find(el => el.textContent.includes('归档'))
    btn.click()
    return true
  })()`)
  await sleep(600)
  const afterArchive = await hubStatus()
  expect(
    '长按会话可以归档（Hub 归档集合包含它）',
    afterArchive.archived.includes('s_mock_blank'),
    afterArchive.archived,
  )
  const defaultList = await cdp.eval(`window.__dshHub.chat.sessions.map(s => s.sessionId)`)
  expect('默认会话列表不含已归档', !defaultList.includes('s_mock_blank'), defaultList)
  // 全部会话 → 已归档筛选
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/all` })
  await sleep(500)
  await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('.session-tabs button')).find(b => b.textContent.includes('已归档'))
    if (btn) btn.click()
    return true
  })()`)
  await waitFor(cdp, `document.querySelector('.conv-row')`, { label: '已归档列表' })
  const archivedRows = await cdp.eval(`Array.from(document.querySelectorAll('.conv-row__title')).map(e => e.textContent.trim())`)
  expect('「已归档」筛选能看到归档会话', archivedRows.length >= 1, archivedRows)
  await cdp.shot('07-archived')

  // 没有删除入口
  const hasDelete = await cdp.eval(`document.body.innerText.includes('删除会话') || !!document.querySelector('.delete-session')`)
  expect('没有「删除会话」入口（DSH 没有删除接口）', !hasDelete)

  // ---- 7b. 0.2.14 修复回归：持久缓存（问题 1/2）+ 冷启动回上次会话（问题 4）
  // 交付物首次下载应走网络并写「file:read src=network」诊断；随后整页重载 = 冷启动，
  // 登录后应自动回到上次会话，且交付物图片从 IndexedDB 持久缓存渲染、不再重新下载。
  // 诊断是 40 条的环形缓冲：重载后旧条目会被挤掉，所以比的是「有没有**新**的网络下载」
  // （时间戳集合差），而不是条数——条数变少同时说明不了缓存命中（0.4.0 实测踩到）。
  // （networkReadsBefore 在交付物一节里就抓了：诊断是 40 条环形缓冲，
  //   等到这里再读，早期条目已经被后面的登录/恢复事件挤掉了。）
  expect('交付物首次下载走了网络（诊断 file:read src=network）', Array.isArray(networkReadsBefore) && networkReadsBefore.length >= 1, networkReadsBefore)
  // 恢复器只在首页触发：先回首页，再整页重载模拟「杀掉 App 再打开」。
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/` })
  await sleep(600)
  await cdp.send('Page.reload')
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '重载后登录页' })
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(100)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '重载后登录成功' })
  await waitFor(cdp, `location.hash.startsWith('#/c/')`, { label: '冷启动自动回到上次会话', timeout: 30000 })
  const restoredHash = await cdp.eval(`location.hash`)
  expect('冷启动自动回到上次会话', restoredHash === '#/c/s_mock_plan', restoredHash)
  await waitFor(cdp, `document.querySelectorAll('.image-file__frame img').length >= 2`, {
    label: '交付物图片从本地缓存渲染',
    timeout: 20000,
  })
  const networkReadsAfter = await cdp.eval(NETWORK_FILE_READS)
  const newNetworkReads = networkReadsAfter.filter((at) => !networkReadsBefore.includes(at))
  expect(
    '重开后交付物图片来自持久缓存，不再重新下载',
    Array.isArray(networkReadsAfter) && newNetworkReads.length === 0,
    { before: networkReadsBefore, after: networkReadsAfter, newNetworkReads },
  )
  await cdp.shot('08-cache-restore')

  // ---- 8. 控制台
  expect('控制台无错误', consoleErrors.length === 0, consoleErrors)

  const passed = checks.filter((c) => c.ok).length
  const report = { passed, total: checks.length, checks, perf, features, capsV2 }
  await fs.writeFile(path.join(OUT, 'a2-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'a2-e2e.json')}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch(async (error) => {
  console.error('e2e-a2 失败：', error)
  process.exitCode = 1
})
