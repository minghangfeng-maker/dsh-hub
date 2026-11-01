#!/usr/bin/env node
/**
 * 0.4.3 AI 回复朗读 e2e（WP50）：在真实 Chrome 里跑「点朗读 → 边播边合成 → 停止」。
 *
 * 覆盖：
 *   A. bootstrap 下发 `voice.tts`（enabled / 只有星汐 seki / maxChars 200）；
 *   B. 每条 AI 回复下方有朗读按钮（灰色线性图标 + 「朗读」）；
 *   C. 点击后：首段加载中显示小转圈 → 开播显示「停止」+ 动态条；
 *   D. 边播边合成：请求按段发出，**同时最多 2 个在飞**（服务端本来就串行）；
 *   E. 点停止：立刻回到「朗读」，之后不再发请求（在飞的段被丢弃）；
 *   F. 设置页「朗读」分组：音色只有「星汐 seki」+ 介绍，「试听」能读固定示例句；
 *   G. 自动朗读开关：打开后发一条消息，回合结束会自动朗读最新回复；
 *   H. 全流程控制台无错误。
 *
 * 0.4.6 起这份用例专门跑**老 Hub 回退**：mock 关掉 `voice.tts.stream`，App 必须继续用整段
 * 播放器（边播边合成 + 预取 2 段）。流式朗读见 scripts/e2e-tts-stream.mjs。
 *
 * 与真机的差别只有两处：Hub 是 mock（正弦波 WAV，不是星汐的声音）、Chrome 是 headless。
 * Web Audio 解码/播放/停止、切段、预取、缓存、状态机全是真实代码路径。
 *
 * 用法（脚本自己拉起 mock hub 5259 / vite 5260 / headless Chrome 9301–9305）：
 *
 *   node scripts/e2e-tts.mjs
 *   node scripts/e2e-tts.mjs --out /tmp/e2e-tts/out
 *
 * 已经手工起好服务时：
 *   PORT=5259 TICK_MS=12 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5259 ./node_modules/.bin/vite --port 5260 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9301 \
 *     --autoplay-policy=no-user-gesture-required --user-data-dir=/tmp/e2e-profile-tts about:blank &
 *   node scripts/e2e-tts.mjs --no-spawn --app http://127.0.0.1:5260 \
 *     --hub http://127.0.0.1:5259 --cdp 9301
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
const HUB_PORT = Number(args['hub-port'] ?? 5259)
const APP_PORT = Number(args['app-port'] ?? 5260)
const CDP_CANDIDATES = [9301, 9302, 9303, 9304, 9305]
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-tts-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
/** 每段合成的人为延迟（ms）：让「loading → playing」「播第 i 段时预取 i+1/i+2」看得见。 */
const TTS_DELAY_MS = Number(args['tts-delay'] ?? 600)
/** 试听例句（与 ui 的 TTS_PREVIEW_TEXT 一致）。 */
const PREVIEW_CHARS = 9

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

/** 页面现场快照（Pinia 的 computed 要显式拼成普通对象，Vue 代理经 CDP 序列化会变 {}）。 */
const SNAPSHOT = `(() => {
  const h = window.__dshHub
  const ttsStore = h?.tts
  const readButton = (el) => ({
    key: el.dataset.ttsKey ?? '',
    state: el.dataset.ttsState ?? '',
    label: el.querySelector('.msg-action__label')?.innerText.trim() ?? '',
    spinner: !!el.querySelector('.msg-action__spin'),
    bars: !!el.querySelector('.msg-action__bars'),
    speaker: !!el.querySelector('svg path'),
  })
  const buttons = [...document.querySelectorAll('[data-tts-actions] [data-tts-key]')].map(readButton)
  let tts = null
  try {
    if (ttsStore) {
      tts = {
        available: ttsStore.available === true,
        phase: ttsStore.phase,
        busy: ttsStore.busy === true,
        key: ttsStore.readingKey ?? null,
        segment: ttsStore.segment ?? 0,
        total: ttsStore.total ?? 0,
        autoRead: ttsStore.autoRead === true,
        voiceId: ttsStore.voiceId ?? null,
        maxChars: ttsStore.maxChars ?? 0,
        voices: (ttsStore.voices ?? []).map((v) => ({ id: v.id, name: v.name })),
      }
    }
  } catch { tts = null }
  return {
    at: Date.now(),
    tts,
    buttons,
    // 对话页的助手消息数量（按操作行算）
    readingButtons: buttons.length,
    toast: document.querySelector('.toast')?.innerText.trim() ?? '',
    ttsPrefs: window.localStorage.getItem('dsh-hub:tts:v1') ?? '',
    bootstrap: (() => {
      try {
        const voice = h?.auth?.voice
        if (!voice) return null
        return {
          asr: voice.asr === true,
          tts: voice.tts
            ? {
                enabled: voice.tts.enabled === true,
                defaultVoice: voice.tts.defaultVoice ?? null,
                maxChars: voice.tts.maxChars ?? null,
                voices: (voice.tts.voices ?? []).map((v) => ({ id: v.id, name: v.name, description: v.description ?? '' })),
              }
            : null,
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

/** 点最后一条回复的朗读按钮（最新回复在最下面）。 */
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

async function openSeededConversation(cdp) {
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await waitFor(cdp, `document.querySelectorAll('[data-tts-actions] [data-tts-key]').length >= 1`, {
    label: '对话页朗读按钮',
    timeout: 25000,
  })
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
  // 0.4.6：这一份专门验证**老 Hub 回退**（没有 voice.tts.stream）的整段模式；
  // 流式朗读由 scripts/e2e-tts-stream.mjs 覆盖。
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await ttsHook({ delayMs: TTS_DELAY_MS, enabled: true, fail: 0, rateLimit: 0, stream: false })
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

  // ---- A. bootstrap 下发 voice.tts
  await waitFor(cdp, `window.__dshHub?.auth?.voice?.tts`, { label: 'bootstrap voice.tts' })
  const boot = await cdp.eval(SNAPSHOT)
  expect('A1 bootstrap.voice.tts.enabled = true', boot.bootstrap?.tts?.enabled === true, boot.bootstrap?.tts)
  expect(
    'A2 只有一个音色「星汐 seki」',
    boot.bootstrap?.tts?.voices?.length === 1 && boot.bootstrap.tts.voices[0].name === '星汐 seki',
    boot.bootstrap?.tts?.voices,
  )
  expect('A3 单段上限 maxChars = 200', boot.bootstrap?.tts?.maxChars === 200, boot.bootstrap?.tts?.maxChars)

  // ---- B. 对话页：AI 回复下方的朗读按钮
  await openSeededConversation(cdp)
  await sleep(300)
  const idle = await cdp.eval(SNAPSHOT)
  expect('B1 每条 AI 回复下方都有朗读按钮', idle.readingButtons >= 1, idle.readingButtons)
  expect('B2 空闲态显示「朗读」+ 扬声器图标', idle.buttons.every((b) => b.state === 'idle' && b.label === '朗读' && b.speaker), idle.buttons)
  await cdp.shot('T-00-idle')

  // ---- C. 点朗读：loading（小转圈）→ playing（停止 + 动态条）
  const beforeRequests = (await ttsStatus()).requests ?? 0
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'loading'`, { label: '首段加载中', timeout: 5000 })
  const loading = await cdp.eval(SNAPSHOT)
  expect(
    'C1 首段加载中：小转圈 + 「准备中」',
    loading.buttons.some((b) => b.state === 'loading' && b.spinner && b.label === '准备中'),
    loading.buttons,
  )
  await cdp.shot('T-01-loading')

  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '开始播放', timeout: 20000 })
  const playing = await cdp.eval(SNAPSHOT)
  expect(
    'C2 开始播放：「停止」+ 动态条 + 停止方块',
    playing.buttons.some((b) => b.state === 'playing' && b.label === '停止' && b.bars),
    playing.buttons,
  )
  expect('C3 朗读状态带这条消息的 key', typeof playing.tts?.key === 'string' && playing.tts.key.length > 0, playing.tts?.key)
  expect('C4 总段数 ≥ 2（长回复被切段）', (playing.tts?.total ?? 0) >= 2, playing.tts?.total)
  await sleep(500)
  await cdp.shot('T-02-playing')

  // ---- D. 边播边合成：请求按段发出、并发 ≤ 2
  // 边播边看：播放期间轮询 status，记录并发峰值与每段字数
  let maxInflight = 0
  let segments = []
  for (let i = 0; i < 12; i += 1) {
    const st = await ttsStatus()
    maxInflight = Math.max(maxInflight, st.maxInflight ?? 0)
    if ((st.segments?.length ?? 0) > segments.length) segments = st.segments
    if ((st.requests ?? 0) - beforeRequests >= 3) break
    await sleep(220)
  }
  const afterPlay = await ttsStatus()
  const newRequests = (afterPlay.requests ?? 0) - beforeRequests
  expect('D1 播放中至少发出 3 段请求（第 1 段 + 预取 2 段）', newRequests >= 3, {
    newRequests,
    segments,
  })
  expect('D2 同时最多 2 个请求在飞', Math.max(maxInflight, afterPlay.maxInflight ?? 0) <= 2, {
    maxInflight,
    serverMax: afterPlay.maxInflight,
  })
  expect('D3 每段字数 ≤ maxChars(200)', segments.every((n) => n > 0 && n <= 200), segments)
  expect('D4 请求都带音色 seki', (afterPlay.voices ?? []).every((v) => v === 'seki'), afterPlay.voices)

  // ---- E. 停止：立刻回「朗读」，之后不再请求（迟到的段被丢弃）
  await clickLastReadButton(cdp)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '停止后回到空闲', timeout: 5000 })
  const stopped = await cdp.eval(SNAPSHOT)
  expect(
    'E1 停止后按钮回到「朗读」',
    stopped.buttons.every((b) => b.state === 'idle' && b.label === '朗读'),
    stopped.buttons,
  )
  await sleep(900) // 等在飞的预取段回来（mock 每段 600ms）
  const settled = (await ttsStatus()).requests ?? 0
  await sleep(1200)
  const later = (await ttsStatus()).requests ?? 0
  expect('E2 停止后不再发新请求', later === settled, { settled, later })

  // ---- F. 设置页：音色只有星汐 seki + 试听
  await cdp.eval(`window.__dshHub.router.push('/settings')`)
  await waitFor(cdp, `document.querySelector('[data-tts-settings]')`, { label: '设置页朗读分组' })
  await sleep(300)
  const settings = await cdp.eval(`(() => {
    const group = document.querySelector('[data-tts-settings]')
    const rows = [...document.querySelectorAll('[data-tts-voice]')].map((el) => ({
      id: el.dataset.ttsVoice,
      name: el.querySelector('.tts-voice__name')?.innerText.trim() ?? '',
      desc: el.querySelector('.tts-voice__desc')?.innerText.trim() ?? '',
      checked: el.querySelector('.tts-voice')?.getAttribute('aria-checked') === 'true',
    }))
    return {
      hasGroup: !!group,
      unavailable: !!document.querySelector('[data-tts-unavailable]'),
      rows,
      preview: !!document.querySelector('[data-tts-preview]'),
      switch: (() => {
        const el = document.querySelector('[data-tts-autoread]')
        return el ? { checked: el.getAttribute('aria-checked') === 'true' } : null
      })(),
    }
  })()`)
  expect('F1 设置页有「朗读」分组（可用，不是置灰）', settings.hasGroup && !settings.unavailable, settings)
  expect(
    'F2 音色只有「星汐 seki」且默认选中',
    settings.rows.length === 1 && settings.rows[0].name === '星汐 seki' && settings.rows[0].checked,
    settings.rows,
  )
  // 0.4.5：音色下面不再有介绍文字（只保留「星汐 seki」名字）；断言反过来锁住「没有多余文案」
  expect('F3 音色只显示名字、没有介绍文字', settings.rows[0]?.desc === '', settings.rows[0]?.desc)
  expect('F4 有「试听」按钮', settings.preview === true)
  expect('F5 自动朗读开关默认关', settings.switch?.checked === false, settings.switch)
  await cdp.shot('T-03-settings')

  // 试听：读固定示例句（9 个字：「你好呀，我是星汐。」）
  const beforePreview = (await ttsStatus()).requests ?? 0
  await cdp.eval(`document.querySelector('[data-tts-preview]').click()`)
  await waitFor(cdp, `window.__dshHub.tts.phase !== 'idle'`, { label: '试听开始', timeout: 8000 })
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '试听播放', timeout: 15000 })
  const previewStatus = await ttsStatus()
  expect('F6 试听发出了一次请求', (previewStatus.requests ?? 0) > beforePreview, {
    before: beforePreview,
    after: previewStatus.requests,
  })
  expect(
    'F7 试听读的是固定示例句（9 字）',
    (previewStatus.segments ?? []).at(-1) === PREVIEW_CHARS,
    previewStatus.segments?.at(-1),
  )
  await cdp.shot('T-04-preview')
  // 停止试听（同一按钮此时是「停止」）
  await cdp.eval(`document.querySelector('[data-tts-preview]').click()`)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '试听停止', timeout: 5000 })

  // ---- G. 自动朗读开关：打开后回合结束自动朗读最新回复
  await cdp.eval(`document.querySelector('[data-tts-autoread]').click()`)
  await sleep(200)
  const autoOn = await cdp.eval(SNAPSHOT)
  expect('G1 打开自动朗读后开关是开的', autoOn.tts?.autoRead === true, autoOn.tts?.autoRead)
  expect('G2 自动朗读偏好已存本地', autoOn.ttsPrefs.includes('"autoRead":true'), autoOn.ttsPrefs)

  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await waitFor(cdp, `document.querySelector('.composer__input')`, { label: '回到对话页' })
  await sleep(400)
  const beforeAuto = (await ttsStatus()).requests ?? 0
  // 发一条消息：等回合结束 → 自动朗读最新回复
  await cdp.eval(`(() => {
    const input = document.querySelector('.composer__input')
    input.value = '请用一句话说明你会怎么朗读'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.send-btn[aria-label="发送"]').click()`)
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === true`, {
    label: '回合开始',
    timeout: 20000,
  })
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, {
    label: '回合结束',
    timeout: 60000,
  })
  await waitFor(cdp, `window.__dshHub.tts.phase !== 'idle'`, {
    label: '自动朗读开始',
    timeout: 20000,
  })
  const autoPlaying = await cdp.eval(SNAPSHOT)
  expect(
    'G3 回合结束后自动开始朗读（没点按钮）',
    autoPlaying.tts?.busy === true && (await ttsStatus()).requests > beforeAuto,
    { phase: autoPlaying.tts?.phase, requests: (await ttsStatus()).requests, beforeAuto },
  )
  await cdp.shot('T-05-autoread')

  // 长回复的滑动窗口：播放第 i 段时预取 i+1/i+2，随播放推进不断补段，但并发始终 ≤ 2
  await waitFor(cdp, `window.__dshHub.tts.phase === 'playing'`, { label: '自动朗读播放中', timeout: 20000 })
  const longReply = await cdp.eval(SNAPSHOT)
  expect('G4 长回复被切成 ≥ 5 段', (longReply.tts?.total ?? 0) >= 5, longReply.tts?.total)
  const beforeSlide = (await ttsStatus()).requests ?? 0
  // 一段约 90ms/字（20 字 ≈ 1.8 秒），滑动窗口大约每 2 秒补一段：轮询到下一次补段为止
  let slide = await ttsStatus()
  const startedSlideWatch = Date.now()
  while ((slide.requests ?? 0) <= beforeSlide && Date.now() - startedSlideWatch < 15_000) {
    await sleep(300)
    slide = await ttsStatus()
  }
  const slideSnap = await cdp.eval(SNAPSHOT)
  expect(
    'G5 播放推进时继续补段（滑动窗口），并发仍 ≤ 2',
    (slide.requests ?? 0) > beforeSlide &&
      (slide.maxInflight ?? 0) <= 2 &&
      (slideSnap.tts?.segment ?? 0) > 1,
    {
      before: beforeSlide,
      after: slide.requests,
      maxInflight: slide.maxInflight,
      segment: slideSnap.tts?.segment,
    },
  )
  await cdp.eval(`window.__dshHub.router.push('/settings')`)
  await sleep(300)
  await cdp.eval(`document.querySelector('[data-tts-autoread]').click()`)
  await sleep(150)

  // ---- H. 老 Hub 形状（没有 voice.tts）：入口不出现
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await sleep(300)
  const beforeHide = await cdp.eval(`document.querySelectorAll('[data-tts-actions]').length`)
  await cdp.eval(`(() => {
    // 模拟老 Hub：把 bootstrap 快照里的 tts 去掉（与真实「老 Hub 不发这个字段」等价）
    const voice = window.__dshHub.auth.voice
    window.__dshHub.auth.voice = { asr: voice.asr, maxSeconds: voice.maxSeconds }
    return true
  })()`)
  await sleep(400)
  const hidden = await cdp.eval(`({
    actions: document.querySelectorAll('[data-tts-actions]').length,
    available: window.__dshHub.tts.available === true,
  })`)
  expect('H1 老 Hub（没有 voice.tts）时朗读按钮与入口消失', hidden.actions === 0 && hidden.available === false, {
    before: beforeHide,
    after: hidden,
  })

  expect('Z1 控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    viewportLabel: `${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.dpr}`,
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'tts-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'tts-e2e.json')}`)
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

/** 起 mock hub / vite / Chrome，返回实际使用的 CDP 端口。 */
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
    env: { ...process.env, PORT: String(HUB_PORT), TICK_MS: '12', WAKE_MS: '1200' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached：`node` 自己就是一个进程组，收尾时按组杀（见 stopServers）
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
      // `.bin/vite` 是 sh 壳（会再起一个 node 子进程）：必须按进程组杀，否则子进程变孤儿
      detached: true,
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })

  // CDP 端口：9301–9305 里挑一个空闲的（上一次 e2e 可能还没完全退）
  const free = []
  for (const port of CDP_CANDIDATES) if (await portFree(port)) free.push(port)
  const cdpPort = free[0]
  if (!cdpPort) throw new Error(`CDP 端口都被占用：${CDP_CANDIDATES.join(',')}`)
  profileDir = `/tmp/e2e-profile-tts-${Date.now()}`
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

/**
 * 按 **进程组** 关掉自己起的进程（不用 pkill/pgrep），再清掉临时 profile。
 *
 * 为什么要按组：`.bin/vite` 是 sh 壳，真正跑服务的是它的 node 子进程；
 * 只 kill 壳的 PID 会留下一个占着端口的孤儿（下一次 e2e 就会误用旧服务）。
 */
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
