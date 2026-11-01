#!/usr/bin/env node
/**
 * 0.4.2 按住说话 e2e：**App 自己录音 → Hub 服务端识别**。
 *
 * 用户真机上的问题：国产 ROM 的系统 `SpeechRecognizer` 一按就 ERROR_CLIENT，而且不弹麦克风授权。
 * 0.4.2 改成录音上传 Hub（`POST /api/mobile/asr`），这个脚本在 Chrome 里用**假麦克风**把整条
 * 链路跑通：
 *
 *   A. bootstrap 下发 `voice.asr=true`，App 选「服务器」引擎；
 *   B. 按住 1.5 秒（浮层出现波形 + 「正在听…」，没有实时文字）→ 松手（浮层「正在识别…」）→
 *      mock hub 返回固定文字，文字被追加进输入框；
 *   C. 上滑取消：不插字、也不上传；
 *   D. 识别 502：轻提示「服务器识别暂时不可用」，输入框不变；
 *   E. 设置页显示当前引擎「服务器」，并有自动 / 服务器 / 手机系统三档；
 *   F. 全流程控制台无错误。
 *
 * 假麦克风：Chrome 的
 *   --use-fake-ui-for-media-stream      自动同意麦克风（不弹权限框）
 *   --use-fake-device-for-media-stream  用假采集设备
 *   --use-file-for-fake-audio-capture=<16k wav>  用脚本生成的 3 秒 440Hz 单声道 wav 喂给页面
 * 这样 `getUserMedia` + AudioWorklet + 下采样 + WAV 封装 + 上传全是真的，只有麦克风是假的。
 *
 * 用法（脚本自己拉起 mock hub 5257 / vite 5258 / headless Chrome 9295，跑完按 PID 关掉）：
 *
 *   node scripts/e2e-voice.mjs
 *   node scripts/e2e-voice.mjs --out /tmp/e2e-voice/out
 *
 * 已经手工起好服务时：
 *   PORT=5257 TICK_MS=12 node apps/mock-hub/server.mjs &
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5257 ./node_modules/.bin/vite --port 5258 &
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9295 \
 *     --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
 *     --user-data-dir=/tmp/e2e-profile-voice about:blank &
 *   node scripts/e2e-voice.mjs --no-spawn --app http://127.0.0.1:5258 \
 *     --hub http://127.0.0.1:5257 --cdp 9295
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
const HUB_PORT = Number(args['hub-port'] ?? 5257)
const APP_PORT = Number(args['app-port'] ?? 5258)
const CDP_PORT = Number(args.cdp ?? 9295)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-voice-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

/** mock hub 的固定识别结果（见 apps/mock-hub/server.mjs 的 ASR_TEXT）。 */
const ASR_TEXT = '这是一段测试语音'
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
    await fs.mkdir(OUT, { recursive: true })
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
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

/** 输入卡 / 浮层 / 提示的现场快照。 */
const SNAPSHOT = `(() => {
  const h = window.__dshHub
  const input = document.querySelector('.composer__input')
  const overlay = document.querySelector('[data-voice-overlay]')
  const toast = document.querySelector('.toast')
  return {
    at: Date.now(),
    input: input ? input.value : null,
    overlay: overlay
      ? {
          engine: overlay.dataset.voiceEngine ?? '',
          phase: overlay.dataset.voicePhase ?? '',
          cancel: overlay.dataset.voiceCancel ?? '',
          text: document.querySelector('[data-voice-text]')?.innerText.trim() ?? '',
          hint: document.querySelector('[data-voice-hint]')?.innerText.trim() ?? '',
          countdown: document.querySelector('[data-voice-countdown]')?.innerText.trim() ?? '',
        }
      : null,
    toast: toast ? toast.innerText.trim() : '',
    // 明确拼一个普通对象：Vue 的 reactive 代理经 CDP 序列化会变成 {}
    voice: (() => {
      try {
        const value = h?.auth?.voice
        if (!value) return null
        return { asr: value.asr === true, maxSeconds: value.maxSeconds ?? null }
      } catch {
        return null
      }
    })(),
    dialogTitle: document.querySelector('.voice-dialog__title')?.innerText.trim() ?? '',
    engineActive: document.querySelector('[data-voice-engine-active]')?.dataset.voiceEngineActive ?? '',
    setting: window.localStorage.getItem('dsh-hub:ui:v1') ?? '',
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
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 40000, label: '通道连上' })
  await waitFor(cdp, `document.querySelector('.composer')`, { label: '输入卡' })
}

/** 清空输入框（每段用例之间互不影响）。 */
async function clearInput(cdp) {
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    if (!el) return false
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(80)
}

async function micPoint(cdp) {
  const point = await cdp.eval(`(() => {
    const el = document.querySelector('button[aria-label="按住说话"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!point) throw new Error('找不到麦克风按钮')
  return point
}

async function touchStart(cdp, point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  })
}
async function touchMove(cdp, point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  })
}
async function touchEnd(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 按住 `holdMs` 后松手（真触摸事件：会走 pointerdown/move/up 全链路）。 */
async function hold(cdp, holdMs, { moveUp = 0 } = {}) {
  const point = await micPoint(cdp)
  await touchStart(cdp, point)
  if (moveUp > 0) {
    await sleep(260)
    await touchMove(cdp, { x: point.x, y: point.y - moveUp })
  }
  await sleep(holdMs)
  await touchEnd(cdp)
}

async function voiceHook(body) {
  const res = await fetch(`${HUB_URL}/__test/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function voiceStatus() {
  const res = await fetch(`${HUB_URL}/__test/status`)
  return res.json()
}

/** 生成给 Chrome 的假麦克风音频：16kHz 单声道 16bit 的 3 秒 440Hz 正弦。 */
async function makeFakeAudio() {
  const sampleRate = 16_000
  const seconds = 3
  const samples = sampleRate * seconds
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples * 2, 40)
  // 语音一样的包络（2.2Hz 起伏 + 220Hz 基频）：波形条才会高低起伏，不是一根等高线
  for (let i = 0; i < samples; i += 1) {
    const envelope = 0.12 + 0.88 * Math.abs(Math.sin((2 * Math.PI * 2.2 * i) / sampleRate))
    const value = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.42 * envelope
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + i * 2)
  }
  const file = path.join(OUT, 'fake-mic-16k.wav')
  await fs.mkdir(OUT, { recursive: true })
  await fs.writeFile(file, buffer)
  return file
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
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

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ---- 0. 干净登录（全新 profile）
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
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

  // 麦克风在页面里真的可用（不然下面「按住」会全部失败，要能一眼看出原因）
  const micSupported = await cdp.eval(`(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'no getUserMedia' }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const tracks = stream.getAudioTracks().length
      stream.getTracks().forEach((t) => t.stop())
      return { ok: true, tracks, audioContext: typeof AudioContext !== 'undefined',
        worklet: typeof AudioWorkletNode !== 'undefined' }
    } catch (error) { return { ok: false, reason: String(error) } }
  })()`)
  expect('页面能打开麦克风（假设备）', micSupported.ok === true, micSupported)

  // ---- A. bootstrap 下发语音能力
  const boot = await cdp.eval(SNAPSHOT)
  expect('A1 bootstrap.voice.asr = true', boot.voice?.asr === true, boot.voice)
  expect('A2 单段上限 60 秒', boot.voice?.maxSeconds === 60, boot.voice?.maxSeconds)

  // ---- B. 按住 1.5 秒 → 松手 → 输入框出现 mock 文本
  await clearInput(cdp)
  const point = await micPoint(cdp)
  await touchStart(cdp, point)
  await sleep(700)
  const recording = await cdp.eval(SNAPSHOT)
  expect('B1 浮层出现且引擎是「服务器」', recording.overlay?.engine === 'server', recording.overlay)
  expect('B2 录音中显示「正在听…」（没有实时文字）', recording.overlay?.text === '正在听…', recording.overlay?.text)
  expect('B3 录音中不显示倒计时（剩 >10 秒）', recording.overlay?.countdown === '', recording.overlay?.countdown)
  await sleep(800)
  await cdp.shot('V-00-recording')
  await touchEnd(cdp)
  await waitFor(cdp, `document.querySelector('.composer__input')?.value.includes(${JSON.stringify(ASR_TEXT)})`, {
    label: '识别文字进入输入框',
    timeout: 20000,
  })
  const afterHold = await cdp.eval(SNAPSHOT)
  expect('B4 松手后文字追加进输入框', afterHold.input?.includes(ASR_TEXT) === true, afterHold.input)
  await waitFor(cdp, `!document.querySelector('[data-voice-overlay]')`, { label: '浮层收起' })
  expect('B5 浮层收起（识别完不再挡输入卡）', true)
  const afterFirst = await voiceStatus()
  expect('B6 只上传了一次', afterFirst.voice?.requests === 1, afterFirst.voice)

  // ---- C. 上滑取消：不插字、也不上传
  await sleep(2200) // 等「已取消」「没听清」这类轻提示自己消失
  await clearInput(cdp)
  await hold(cdp, 900, { moveUp: 90 })
  await sleep(600)
  const afterCancel = await cdp.eval(SNAPSHOT)
  expect('C1 上滑取消后输入框是空的', (afterCancel.input ?? '').trim() === '', afterCancel.input)
  expect('C2 取消后浮层收起（没有停留在录音态）', afterCancel.overlay === null, afterCancel.overlay)
  const afterCancelStatus = await voiceStatus()
  expect('C3 取消没有触发上传', afterCancelStatus.voice?.requests === 1, afterCancelStatus.voice)

  // ---- D. 识别 502：轻提示「服务器识别暂时不可用」
  await sleep(2200)
  await voiceHook({ fail: 1 })
  await clearInput(cdp)
  await hold(cdp, 1_000)
  await waitFor(
    cdp,
    `(() => {
      const toast = document.querySelector('.toast')?.innerText ?? ''
      const dialog = document.querySelector('.voice-dialog__title')?.innerText ?? ''
      return (toast + dialog).includes('服务器识别暂时不可用')
    })()`,
    { label: '502 提示', timeout: 20000 },
  )
  const afterFail = await cdp.eval(SNAPSHOT)
  // 浏览器里没有系统识别（两者都不可用）→ 弹窗说明；真机上系统识别可用时是轻提示
  const failText = `${afterFail.toast} ${afterFail.dialogTitle}`
  expect('D1 502 后提示「服务器识别暂时不可用」', failText.includes('服务器识别暂时不可用'), failText.trim())
  expect('D2 失败时不插字', (afterFail.input ?? '').trim() === '', afterFail.input)
  const afterFailStatus = await voiceStatus()
  expect('D3 失败也算一次上传', afterFailStatus.voice?.requests === 2, afterFailStatus.voice)

  // 关掉弹窗（「知道了」），后面还要继续用输入卡
  await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('.voice-dialog__btn')].find((b) => b.textContent.includes('知道了'))
    if (button) button.click()
    return true
  })()`)
  await sleep(300)

  // ---- E. 设置页：三档选择（0.4.5 起不再单独显示「当前：服务器」那一行，
  //     解析结果挂在分段控件的 data-voice-engine-active 上，断言强度不变）
  await sleep(2200)
  await cdp.eval(`window.__dshHub.router.push('/settings')`)
  await waitFor(cdp, `document.querySelector('[data-voice-setting]')`, { label: '设置页语音分组' })
  await sleep(300)
  const settingsSnap = await cdp.eval(`(() => ({
    active: document.querySelector('[data-voice-engine-active]')?.dataset.voiceEngineActive ?? '',
    options: [...document.querySelectorAll('[data-engine]')].map((el) => ({
      key: el.dataset.engine,
      label: el.innerText.trim(),
      on: el.classList.contains('is-on'),
    })),
  }))()`)
  expect('E1 解析出的引擎是「服务器」', settingsSnap.active === 'server', settingsSnap.active)
  expect(
    'E2 三档选择齐全且默认「自动」',
    settingsSnap.options.length === 3 &&
      settingsSnap.options.map((o) => o.key).join(',') === 'auto,server,native' &&
      settingsSnap.options.find((o) => o.key === 'auto')?.on === true,
    settingsSnap.options,
  )
  await cdp.shot('V-01-settings-engine')

  // 切到「手机系统」：偏好要被记住；浏览器没有系统识别，所以按住只会弹「不可用」，
  // 而且**绝不能**悄悄把录音传去服务器（手动选择严格生效）
  await cdp.eval(`document.querySelector('[data-engine="native"]').click()`)
  await sleep(250)
  const switched = await cdp.eval(SNAPSHOT)
  expect('E3 切到「手机系统」后偏好已保存', switched.setting.includes('"voiceEngine":"native"'), switched.setting)
  await cdp.eval(`window.__dshHub.router.back()`)
  await sleep(400)
  await clearInput(cdp)
  const before = (await voiceStatus()).voice.requests
  await hold(cdp, 700)
  await sleep(500)
  const afterNative = await voiceStatus()
  const nativeSnap = await cdp.eval(SNAPSHOT)
  expect('E4 手动选「手机系统」后不再调用服务端识别', afterNative.voice.requests === before, {
    before,
    after: afterNative.voice.requests,
  })
  expect(
    'E5 系统识别不可用时弹「语音输入不可用」（不偷偷上传）',
    nativeSnap.dialogTitle.includes('语音输入不可用'),
    nativeSnap.dialogTitle,
  )
  await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('.voice-dialog__btn')].find((b) => b.textContent.includes('知道了'))
    if (button) button.click()
    return true
  })()`)
  await sleep(200)
  // 恢复「自动」，别把用户的偏好留在测试用的值上（截图/后续用例要用服务器）
  await cdp.eval(`window.__dshHub.router.push('/settings')`)
  await sleep(250)
  await cdp.eval(`document.querySelector('[data-engine="auto"]').click()`)
  await sleep(200)

  expect('F1 控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'voice-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'voice-e2e.json')}`)
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

  const fakeAudio = await makeFakeAudio()
  profileDir = `/tmp/e2e-profile-voice-${Date.now()}`
  console.log(`[e2e] 起 headless Chrome :${CDP_PORT}（profile ${profileDir}，假麦克风 ${fakeAudio}）`)
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
      // 假麦克风：自动同意权限 + 假采集设备 + 固定音频文件（16kHz wav）
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeAudio}`,
      // AudioContext 不在用户手势里创建时也可能被挂起，这里直接放开
      '--autoplay-policy=no-user-gesture-required',
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

main()
  .catch((error) => {
    console.error('e2e 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServers()
  })
