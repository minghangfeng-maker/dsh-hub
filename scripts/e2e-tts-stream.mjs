#!/usr/bin/env node
/**
 * 0.4.6/0.4.7 流式朗读 e2e（WP51 + 自适应切段）：在真实 Chrome 里跑「点朗读 → 边收边播 →
 * 停止 / 读完 / 不同合成速率下的切段」。
 *
 * 与 e2e-tts.mjs（老 Hub 回退、整段模式、29 项）互补，这份专门验证流式：
 *   A. bootstrap 下发 `voice.tts.stream === true`；
 *   B. 点击后 loading → playing（首块 200ms 到，随后边收边播）；
 *   C. **首声 < 1.5 秒**：读诊断 `tts:ttfa`（点击到第一个音频节点开始）；
 *   D. **段内无缝**：patch `AudioBufferSourceNode.start`，断言相邻节点
 *      `when` 与前一块结束时刻误差 < 30ms（排程时间轴首尾相接）；
 *   E. 服务端视角：流式请求数 ≥ 1、**并发 ≤ 1**、每段字数 ≤ maxChars；
 *   F. 停止：立刻回「朗读」、不再发新请求、Hub 侧看到连接被客户端关掉；
 *   G. 自然读完：设置页「试听」走流式并读到 idle（`tts:stop reason=done`）；
 *   H. 老 Hub 回退：把 `voice.tts.stream` 拿掉后，App 立刻改走整段 `/tts`。
 *   J. 自适应切段（0.4.7，0.9 倍实时）：约 520 字、6 个段落的长回复 → 首段 ≤40 字，
 *      段间实际静默（上一段最后节点结束 → 下一段第一个节点开始）≤1.3 秒；
 *   K. 自适应切段（0.4.7，1.05 倍实时）：同一篇长回复 → 首段用上次持久化的 r̂，
 *      之后每段（除最后一段）≥150 字、段数 ≤4；持久化的 r 也被写回。
 *
 * mock hub 的流式模拟：首块 200ms、之后按 `streamRate` 倍实时（默认 0.9，真星汐实测
 * 0.89–0.91，可用环境变量 `MOCK_TTS_STREAM_RATE` 改），语速 178ms/字 ≈ 5.6 字/秒，
 * 与 App 的缓冲/切段估算口径一致。
 *
 * 用法（脚本自己拉起 mock hub 5267 / vite 5268 / headless Chrome 9321–9325）：
 *
 *   node scripts/e2e-tts-stream.mjs
 *   node scripts/e2e-tts-stream.mjs --out /tmp/e2e-tts-stream/out
 *
 * 已经手工起好服务时：
 *   PORT=5267 TICK_MS=12 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5267 ./node_modules/.bin/vite --port 5268 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9321 \
 *     --autoplay-policy=no-user-gesture-required --user-data-dir=/tmp/e2e-profile-tts-stream about:blank &
 *   node scripts/e2e-tts-stream.mjs --no-spawn --app http://127.0.0.1:5268 \
 *     --hub http://127.0.0.1:5267 --cdp 9321
 */

import fs from 'node:fs/promises'
import net from 'node:net'
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
const HUB_PORT = Number(args['hub-port'] ?? 5267)
const APP_PORT = Number(args['app-port'] ?? 5268)
const CDP_CANDIDATES = [9321, 9322, 9323, 9324, 9325]
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-tts-stream-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
/** 流式模拟参数：与真星汐同量级（首块 0.2 秒、之后 0.9 倍实时、5.6 字/秒）。 */
const STREAM = {
  stream: true,
  streamRate: 0.9,
  streamFirstMs: 200,
  streamChunkMs: 200,
  streamMsPerChar: 178,
  streamInterruptAfter: 0,
  fail: 0,
  rateLimit: 0,
}
/** 试听例句（与 ui 的 TTS_PREVIEW_TEXT 一致）。 */
const PREVIEW_CHARS = 9
/** 首声上限（毫秒）。 */
const TTFA_LIMIT_MS = 1_500
/** 段内排程允许的误差（秒）。 */
const SEAM_TOLERANCE_SEC = 0.03

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

/** 页面现场快照 + 诊断事件（ttfa / stream / stop 都在 localStorage 里）。 */
const SNAPSHOT = `(() => {
  const h = window.__dshHub
  const ttsStore = h?.tts
  const buttons = [...document.querySelectorAll('[data-tts-actions] [data-tts-key]')].map((el) => ({
    key: el.dataset.ttsKey ?? '',
    state: el.dataset.ttsState ?? '',
    label: el.querySelector('.msg-action__label')?.innerText.trim() ?? '',
  }))
  let diags = []
  try { diags = JSON.parse(localStorage.getItem('dsh-hub:diagnostics:v1') ?? '[]') } catch {}
  return {
    at: Date.now(),
    tts: ttsStore ? {
      available: ttsStore.available === true,
      streamCapable: ttsStore.streamCapable === true,
      phase: ttsStore.phase,
      busy: ttsStore.busy === true,
      key: ttsStore.readingKey ?? null,
      segment: ttsStore.segment ?? 0,
      total: ttsStore.total ?? 0,
      voiceId: ttsStore.voiceId ?? null,
      maxChars: ttsStore.maxChars ?? 0,
    } : null,
    buttons,
    diags: diags.map((e) => ({ name: e.name, detail: e.detail, at: e.at })),
    toast: document.querySelector('.toast')?.innerText.trim() ?? '',
    bootstrap: (() => {
      try {
        const voice = h?.auth?.voice
        if (!voice) return null
        return {
          asr: voice.asr === true,
          tts: voice.tts ? {
            enabled: voice.tts.enabled === true,
            stream: voice.tts.stream === true,
            maxChars: voice.tts.maxChars ?? null,
          } : null,
        }
      } catch { return null }
    })(),
  }
})()`

async function login(cdp) {
  await waitFor(cdp, `document.querySelector('.login')`, { timeout: 20000, label: '登录页' })
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, {
    timeout: 30000,
    label: '登录成功',
  })
  await waitFor(cdp, `document.querySelector('.composer')`, { label: '输入卡' })
}

async function status() {
  const res = await fetch(`${HUB_URL}/__test/status`)
  return res.json()
}

async function ttsStatus() {
  return (await status()).tts ?? {}
}

async function ttsHook(body) {
  const res = await fetch(`${HUB_URL}/__test/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function clickLastReadButton(cdp) {
  const ok = await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('[data-tts-actions] [data-tts-key]')]
    const last = buttons[buttons.length - 1]
    if (!last) return false
    last.click()
    return true
  })()`)
  if (!ok) throw new Error('找不到朗读按钮')
}

async function openConversation(cdp, sessionId) {
  await cdp.eval(`window.__dshHub.router.push('/c/${sessionId}')`)
  await waitFor(cdp, `document.querySelectorAll('[data-tts-actions] [data-tts-key]').length >= 1`, {
    label: `会话 ${sessionId} 的朗读按钮`,
    timeout: 25000,
  })
}

async function openSeededConversation(cdp) {
  await openConversation(cdp, 's_mock_plan')
}

/**
 * 记录每个 `AudioBufferSourceNode.start(when, offset, duration)` 的排程时刻与 buffer 时长。
 * 这是验证「排程时间轴首尾相接」的唯一可靠办法（听不出来、也不能靠状态推断）。
 */
const PATCH_START = `(() => {
  const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype
  if (!proto) return false
  if (proto.__e2ePatched) { window.__e2eStarts = []; return true }
  const original = proto.start
  window.__e2eStarts = []
  proto.start = function (when, offset, duration) {
    try {
      window.__e2eStarts.push({
        when: typeof when === 'number' ? when : 0,
        now: this.context ? this.context.currentTime : 0,
        duration: this.buffer ? this.buffer.duration : 0,
      })
    } catch {}
    return original.apply(this, arguments)
  }
  proto.__e2ePatched = true
  return true
})()`

/** 排程时间轴：连续段内每一块都应接在上一块结束处（误差 < 30ms）。 */
function analyzeSeams(starts) {
  const nodes = [...starts].sort((a, b) => a.when - b.when)
  const gaps = []
  for (let i = 1; i < nodes.length; i += 1) {
    const prevEnd = nodes[i - 1].when + nodes[i - 1].duration
    gaps.push(Number((nodes[i].when - prevEnd).toFixed(4)))
  }
  const maxGap = gaps.length === 0 ? 0 : Math.max(...gaps)
  return {
    count: nodes.length,
    firstWhen: nodes[0]?.when ?? null,
    totalSeconds: Number(nodes.reduce((sum, node) => sum + node.duration, 0).toFixed(2)),
    maxGap,
    gaps,
  }
}

/**
 * 段间实际静默（秒）：每一段最后一块是 220ms 的段尾停顿块，
 * 下一段第一个节点与它结束时刻之差就是这个缝的静音（排程连续时为 0）。
 */
function segmentSeams(starts, pauseSec = 0.22) {
  const nodes = [...starts].sort((a, b) => a.when - b.when)
  const seams = []
  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1]
    if (Math.abs(prev.duration - pauseSec) > 0.02) continue
    seams.push(Number((nodes[i].when - (prev.when + prev.duration)).toFixed(3)))
  }
  return seams
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const cdpPort = await startServers()
  const cdp = await Cdp.attach(cdpPort)
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

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ---- 0. 干净登录（全新 profile）
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await ttsHook(STREAM)
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
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
  await login(cdp)

  // ---- A. bootstrap 声明支持流式
  await waitFor(cdp, `window.__dshHub?.auth?.voice?.tts`, { label: 'bootstrap voice.tts' })
  const boot = await cdp.eval(SNAPSHOT)
  expect('A1 bootstrap.voice.tts.stream = true', boot.bootstrap?.tts?.stream === true, boot.bootstrap?.tts)
  expect('A2 store 选择流式播放器（streamCapable）', boot.tts?.streamCapable === true, boot.tts?.streamCapable)

  // ---- B/C/D. 点朗读：loading → playing；首声 < 1.5s；排程首尾相接
  await openSeededConversation(cdp)
  await sleep(300)
  const beforeStreams = (await ttsStatus()).streams ?? 0
  const beforeRequests = (await ttsStatus()).requests ?? 0
  expect('B0 页面已注入 AudioBufferSourceNode.start 探针', (await cdp.eval(PATCH_START)) === true)

  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'loading'`, { label: '流式首段缓冲中', timeout: 5000 })
  await cdp.shot('S-01-loading')
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '开始播放', timeout: 15000 })
  const playing = await cdp.eval(SNAPSHOT)
  expect(
    'B1 开始播放：按钮变成「停止」',
    playing.buttons.some((b) => b.state === 'playing' && b.label === '停止'),
    playing.buttons,
  )
  await cdp.shot('S-02-playing')

  const ttfa = playing.diags.filter((d) => d.name === 'tts:ttfa').at(-1)
  const ttfaMs = ttfa ? Number(/ms=(\d+)/.exec(ttfa.detail)?.[1] ?? 'NaN') : NaN
  expect(`C1 首声 < ${TTFA_LIMIT_MS}ms（诊断 tts:ttfa）`, Number.isFinite(ttfaMs) && ttfaMs < TTFA_LIMIT_MS, {
    ttfaMs,
    detail: ttfa?.detail,
  })

  const streamDiag = playing.diags.filter((d) => d.name === 'tts:stream').at(-1)
  expect(
    'C2 流式诊断只记段数/字数',
    /^segments=\d+ chars=\d+$/.test(streamDiag?.detail ?? ''),
    streamDiag?.detail,
  )

  // ---- D. 排程时间轴：播 1.2 秒之后看已经排好的节点
  await sleep(1_200)
  const starts = await cdp.eval(`window.__e2eStarts ?? []`)
  const seams = analyzeSeams(starts)
  expect('D1 排了 ≥ 5 个音频节点（150ms 一块）', seams.count >= 5, seams)
  expect(
    `D2 段内无缝：相邻节点误差 < ${SEAM_TOLERANCE_SEC * 1000}ms`,
    seams.count >= 2 && seams.maxGap <= SEAM_TOLERANCE_SEC,
    { maxGap: seams.maxGap, gaps: seams.gaps.slice(0, 8) },
  )
  expect('D3 第一个节点在点击后 1.5 秒内开始', (seams.firstWhen ?? 99) < 1.5, seams.firstWhen)

  const afterPlay = await ttsStatus()
  expect(
    'E1 走的是流式接口（streams 增加）',
    (afterPlay.streams ?? 0) > beforeStreams,
    { before: beforeStreams, after: afterPlay.streams },
  )
  expect(
    'E2 同时最多 1 条流（服务端本来就串行）',
    (afterPlay.maxInflight ?? 0) <= 1,
    afterPlay.maxInflight,
  )
  expect(
    'E3 每段字数 ≤ maxChars(200) 且首段 ≤ FIRST_MAX(80)',
    (afterPlay.segments ?? []).every((n) => n > 0 && n <= 200) &&
      (afterPlay.segments?.[0] ?? 0) <= 80,
    afterPlay.segments,
  )
  expect(
    'E4 请求都带音色 seki',
    (afterPlay.voices ?? []).every((v) => v === 'seki'),
    afterPlay.voices,
  )

  // ---- F. 播放中停止：回「朗读」、中断下载、不再请求
  const beforeStop = await ttsStatus()
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '停止后回到空闲', timeout: 5000 })
  const stopped = await cdp.eval(SNAPSHOT)
  expect(
    'F1 停止后按钮回到「朗读」',
    stopped.buttons.every((b) => b.state === 'idle' && b.label === '朗读'),
    stopped.buttons,
  )
  expect(
    'F2 停止记 reason=user',
    stopped.diags.some((d) => d.name === 'tts:stop' && d.detail === 'reason=user'),
    stopped.diags.filter((d) => d.name === 'tts:stop').slice(-2),
  )
  const settled = (await ttsStatus()).requests ?? 0
  await sleep(1_500)
  const later = await ttsStatus()
  expect('F3 停止后不再发新请求', (later.requests ?? 0) === settled, {
    settled,
    later: later.requests,
    beforeStop: beforeStop.requests,
  })
  expect(
    'F4 Hub 侧看到客户端断开（下载被中断）',
    (later.streamAborted ?? 0) > 0,
    later.streamAborted,
  )

  // ---- G. 再读一次并**自然读完**：按钮回到「朗读」、诊断记 reason=done
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '重新开始播放', timeout: 15000 })
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '自然读完回空闲', timeout: 40000 })
  const finished = await cdp.eval(SNAPSHOT)
  expect(
    'G1 自然读完：按钮回到「朗读」',
    finished.buttons.every((b) => b.state === 'idle' && b.label === '朗读'),
    finished.buttons,
  )
  expect(
    'G2 自然读完推 idle + 记 reason=done',
    finished.diags.some((d) => d.name === 'tts:stop' && d.detail === 'reason=done'),
    finished.diags.filter((d) => d.name === 'tts:stop').slice(-2),
  )

  // ---- H. 设置页「试听」也走流式
  await cdp.eval(`window.__dshHub.router.push('/settings')`)
  await waitFor(cdp, `document.querySelector('[data-tts-preview]')`, { label: '设置页试听按钮' })
  await sleep(300)
  const beforePreview = await ttsStatus()
  await cdp.eval(`document.querySelector('[data-tts-preview]').click()`)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '试听播放', timeout: 15000 })
  await cdp.shot('S-03-preview')
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '试听读完', timeout: 20000 })
  const preview = await ttsStatus()
  expect(
    'H1 试听也走流式（streams 增加、段长 = 9 字）',
    (preview.streams ?? 0) > (beforePreview.streams ?? 0) &&
      (preview.segments ?? []).at(-1) === PREVIEW_CHARS,
    { streams: preview.streams, segment: preview.segments?.at(-1) },
  )

  // ---- J/K. 0.4.7 自适应切段：约 520 字、6 个段落的长回复（mock 的 s_mock_long）
  // J：0.9 倍实时（比实时慢）——首段按 r̂=0.88 压到 ~13 字，段间停顿应 ≤1.3 秒
  await cdp.eval(`(() => { localStorage.removeItem('dsh-hub:tts:rate:v1'); return true })()`)
  await ttsHook({ ...STREAM, streamRate: 0.9, streamFirstMs: 200, streamMsPerChar: 178 })
  await openConversation(cdp, 's_mock_long')
  await sleep(400)
  const beforeSlow = await ttsStatus()
  await cdp.eval(`window.__e2eStarts = []; true`)
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, {
    label: '慢速率开始播放',
    timeout: 20000,
  })
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, {
    label: '慢速率读完（约 100 秒）',
    timeout: 180000,
  })
  const slowStatus = await ttsStatus()
  const slowSegments = (slowStatus.segments ?? []).slice(beforeSlow.segments?.length ?? 0)
  const slowStarts = await cdp.eval(`window.__e2eStarts ?? []`)
  const slowSeams = segmentSeams(slowStarts)
  const slowSnap = await cdp.eval(SNAPSHOT)
  // 诊断环只留最近 40 条：取最后 N 条 tts:plan 就是这次慢速朗读的（前面还有试听/短回复的记录）
  const slowPlans = slowSnap.diags
    .filter((d) => d.name === 'tts:plan')
    .slice(-slowSegments.length)
  expect(
    'J1 0.9 倍实时：首段 ≤ 40 字（r̂=0.88 的开口预算）',
    slowSegments.length > 1 && slowSegments[0] > 0 && slowSegments[0] <= 40,
    slowSegments,
  )
  expect(
    'J2 0.9 倍实时：段间实际静默 ≤ 1.3s',
    slowSeams.length >= 2 && Math.max(...slowSeams) <= 1.3,
    { seams: slowSeams, max: slowSeams.length > 0 ? Math.max(...slowSeams) : null },
  )
  expect(
    'J3 每段一条 tts:plan（序号/字数/上限/速率/等待，不记文字）',
    slowPlans.length === slowSegments.length &&
      slowPlans.every(
        (d, index) =>
          d.detail.startsWith(`index=${index + 1} `) &&
          /^index=\d+ chars=\d+ cap=\d+ rate=\d\.\d\d measured=(na|\d\.\d\d) waitMs=\d+$/.test(
            d.detail,
          ),
      ),
    slowPlans.map((d) => d.detail).slice(0, 3),
  )
  await cdp.shot('S-04-adaptive-slow')

  // K：1.05 倍实时（比实时快）——首段之后每段 ≥150 字、段数 ≤4。
  // 不清 rate 存储：首段应当用上一次朗读持久化的 r̂ 规划。
  // 但要刷新页面：段 PCM 缓存在内存里（同一段文字第二次不再请求），刷新后才是真的重新合成。
  const persistedRate = await cdp.eval(`(() => {
    try { return JSON.parse(localStorage.getItem('dsh-hub:tts:rate:v1') ?? 'null')?.rate ?? null } catch { return null }
  })()`)
  expect(
    'K0 0.9 读完把实测 r 持久化（0.8–1.0）',
    typeof persistedRate === 'number' && persistedRate >= 0.8 && persistedRate <= 1.0,
    persistedRate,
  )
  await cdp.send('Page.reload')
  await sleep(900)
  // Web 端的令牌只在内存里：刷新后要重新登录（localStorage 里的 r̂ 不丢）
  await login(cdp)
  await openConversation(cdp, 's_mock_long')
  await sleep(400)
  await ttsHook({ ...STREAM, streamRate: 1.05, streamFirstMs: 200, streamMsPerChar: 178 })
  await cdp.eval(`window.__e2eStarts = []; true`)
  const beforeFast = await ttsStatus()
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, {
    label: '快速率开始播放',
    timeout: 20000,
  })
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, {
    label: '快速率读完（约 90 秒）',
    timeout: 180000,
  })
  const fastStatus = await ttsStatus()
  const fastSegments = (fastStatus.segments ?? []).slice(beforeFast.segments?.length ?? 0)
  expect(
    'K1 1.05 倍实时：段数 ≤ 4',
    fastSegments.length >= 2 && fastSegments.length <= 4,
    fastSegments,
  )
  expect(
    'K2 1.05 倍实时：首段之后每段（除最后一段）≥150 字',
    fastSegments.slice(1, -1).every((n) => n >= 150),
    fastSegments,
  )
  expect(
    'K3 1.05 倍实时：首段 ≤ FIRST_MAX(80)',
    fastSegments.length > 0 && fastSegments[0] > 0 && fastSegments[0] <= 80,
    fastSegments,
  )
  await cdp.shot('S-05-adaptive-fast')

  // ---- I. 老 Hub 回退：拿掉 stream 后立刻改走整段 /tts
  await openSeededConversation(cdp)
  await sleep(300)
  await cdp.eval(`(() => {
    const voice = window.__dshHub.auth.voice
    const tts = { ...voice.tts }
    delete tts.stream
    window.__dshHub.auth.voice = { ...voice, tts }
    return true
  })()`)
  await sleep(400)
  const beforeLegacy = await ttsStatus()
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '整段模式播放', timeout: 20000 })
  const legacy = await ttsStatus()
  expect(
    'I1 没有 stream 时回退整段接口（streams 不变、requests 增加）',
    (legacy.streams ?? 0) === (beforeLegacy.streams ?? 0) &&
      (legacy.requests ?? 0) > (beforeLegacy.requests ?? 0),
    {
      streamsBefore: beforeLegacy.streams,
      streamsAfter: legacy.streams,
      requestsBefore: beforeLegacy.requests,
      requestsAfter: legacy.requests,
    },
  )
  expect(
    'I2 回退后 store 的 streamCapable = false',
    (await cdp.eval(`window.__dshHub.tts.streamCapable === true`)) === false,
  )
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '整段模式停止', timeout: 5000 })

  expect('Z1 控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    stream: STREAM,
    seams,
    adaptive: {
      slow: {
        segments: slowSegments,
        seams: slowSeams,
        plans: slowPlans.map((d) => d.detail),
      },
      fast: { segments: fastSegments, persistedRate },
    },
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'tts-stream-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'tts-stream-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

// ── 起服务 ──────────────────────────────────────────────────────────────────

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

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
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
    const port = Number(args.cdp ?? CDP_CANDIDATES[0])
    await waitHttp(`http://127.0.0.1:${port}/json/version`, { label: 'chrome CDP' })
    return port
  }
  console.log(`[e2e] 起 mock hub :${HUB_PORT}`)
  const hub = spawn(process.execPath, [path.join(ROOT, 'apps/mock-hub/server.mjs')], {
    // MOCK_TTS_STREAM_RATE 是 mock hub 的默认流式速率（本用例的 J/K 再用 /__test/tts 临时改）
    env: {
      ...process.env,
      PORT: String(HUB_PORT),
      TICK_MS: '12',
      WAKE_MS: '1200',
      MOCK_TTS_STREAM_RATE: '0.9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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
      detached: true,
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })

  const free = []
  for (const port of CDP_CANDIDATES) if (await portFree(port)) free.push(port)
  const cdpPort = free[0]
  if (!cdpPort) throw new Error(`CDP 端口都被占用：${CDP_CANDIDATES.join(',')}`)
  profileDir = `/tmp/e2e-profile-tts-stream-${Date.now()}`
  console.log(`[e2e] 起 headless Chrome :${cdpPort}（profile ${profileDir}）`)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      // AudioContext 不在用户手势里创建也能 running（e2e 用 CDP 点击，手势标记不一定传递）
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  children.push(chrome)
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, { label: 'chrome CDP' })
  return cdpPort
}

/** 按**进程组**关掉自己起的进程（不用 pkill/pgrep），再清掉临时 profile。 */
function killGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
    return
  } catch {
    /* 没有独立进程组（或已经退出）：退回按 PID */
  }
  try {
    child.kill(signal)
  } catch {
    /* ignore */
  }
}

async function stopServers() {
  for (const child of children) killGroup(child, 'SIGTERM')
  await sleep(400)
  for (const child of children) killGroup(child, 'SIGKILL')
  if (profileDir) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}

main()
  .catch((error) => {
    console.error('e2e 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServers()
  })
