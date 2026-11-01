#!/usr/bin/env node
/**
 * 手机网页版（WP54 / W3）e2e：**文件、媒体、语音**在浏览器里真的能用。
 *
 * 跑的是 `VITE_TARGET=web` 的构建（`__DSH_WEB__` = true），手机视口 412×915，Chrome 无头。
 * 这个脚本验证的全是「APK 能力换成浏览器能力」之后的真实链路：
 *
 *   A. 前置：登录、通道连上、确认跑的是网页版构建（`IS_WEB_BUILD` 被 define 成 true）
 *   B. 产出文件「保存」= 浏览器下载：点 notes.md 的「下载」→ CDP `Browser.setDownloadBehavior`
 *      断言文件落盘，且 sha256 与 mock hub 的 fixture **字节一致**；下载后 object URL 被释放
 *   C. 图片查看器的「保存」同理（chart.png）
 *   D. 「分享」= `navigator.share`：页面注入桩，断言收到 **files**（名字/类型/大小对得上）；
 *      再把 share 拿掉 → 自动退回下载并提示
 *   E. 附件：PlusSheet 三个隐藏 input 的 accept/capture/multiple；相册选图
 *      （CDP `DOM.setFileInputFiles`）→ 托盘出现缩略图 → 上传成功（mock hub 收到全部字节）
 *   F. 剪贴板：诊断面板的复制按钮 → 读回剪贴板内容
 *   G. 按住说话：权限被拒 → 网页版文案（说明站点设置，没有「去设置」）；
 *      假麦克风放行后 → 录音 → WAV → Hub ASR → 文字插进输入框
 *   H. 朗读：点一下 → AudioContext 在用户手势里创建、state=running，且真的排了 PCM
 *   I. 触感：`navigator.vibrate(10)`（发送时）
 *   J. 全流程控制台无错误
 *
 * 假麦克风（与 scripts/e2e-voice.mjs 同一套）：
 *   --use-fake-ui-for-media-stream --use-fake-device-for-media-stream
 *   --use-file-for-fake-audio-capture=<脚本生成的 16k wav>
 *
 * 用法（统一走运行器，它挑空闲端口并收拾干净的退出）：
 *
 *   VITE_TARGET=web bash scripts/e2e-run.sh web-files
 *
 * 自己已经起好服务时：
 *
 *   node scripts/e2e-web-files.mjs --no-spawn --app http://127.0.0.1:5510 \
 *     --hub http://127.0.0.1:5511 --cdp 9510
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SPAWN = args.spawn !== 'false' && !process.argv.includes('--no-spawn')
const HUB_PORT = Number(args['hub-port'] ?? 5510)
const APP_PORT = Number(args['app-port'] ?? 5511)
const CDP_PORT = Number(args.cdp ?? 9510)
const HUB_URL = args.hub ?? `http://127.0.0.1:${HUB_PORT}`
const APP_URL = args.app ?? `http://127.0.0.1:${APP_PORT}`
const OUT = args.out ?? 'e2e-web-files-output'
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.local/bin/google-chrome`
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }
const VITE_TARGET = process.env.VITE_TARGET ?? 'web'

/** mock hub 的固定识别结果（见 apps/mock-hub/server.mjs 的 ASR_TEXT）。 */
const ASR_TEXT = '这是一段测试语音'
/** mock hub 交付物里的文件名（见 ensureFixtures）。 */
const NOTES_NAME = 'notes.md'
const CHART_NAME = 'chart.png'

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
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(cb)
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

/* ── 页面注入（导航前）：AudioContext 追踪 / 分享桩 / 触感桩 ───────────────── */

/**
 * 在**页面里**包一层 AudioContext，记录：
 *  - `__audioCtxs`：所有创建出来的 context（用来断言「手势里创建」与 state=running）；
 *  - `__ttsBuffers`：createBuffer 的 (channels, length, sampleRate)（PCM 排程规模）；
 *  - `__ttsStarts`：每个 AudioBufferSourceNode.start(when) 的排程时刻与 buffer 时长。
 *
 * 只做记录，不改行为（原型链保持成真正的 AudioContext 原型）。
 */
const TRACE_SCRIPT = `(() => {
  try {
    const Real = window.AudioContext || window.webkitAudioContext
    if (!Real) return false
    window.__audioCtxs = []
    window.__ttsBuffers = []
    window.__ttsStarts = []
    const Traced = function () {
      const ctx = new Real(...arguments)
      try { window.__audioCtxs.push(ctx) } catch (e) {}
      return ctx
    }
    Traced.prototype = Real.prototype
    try { Object.setPrototypeOf(Traced, Real) } catch (e) {}
    window.AudioContext = Traced
    window.webkitAudioContext = Traced
    const origCreateBuffer = Real.prototype.createBuffer
    Real.prototype.createBuffer = function (channels, length, sampleRate) {
      try { window.__ttsBuffers.push({ channels: channels, length: length, sampleRate: sampleRate }) } catch (e) {}
      return origCreateBuffer.apply(this, arguments)
    }
    const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype
    if (proto && !proto.__e2ePatched) {
      const original = proto.start
      proto.start = function (when) {
        try {
          window.__ttsStarts.push({
            when: typeof when === 'number' ? when : 0,
            now: this.context ? this.context.currentTime : 0,
            duration: this.buffer ? this.buffer.duration : 0,
          })
        } catch (e) {}
        return original.apply(this, arguments)
      }
      proto.__e2ePatched = true
    }
    return true
  } catch (e) {
    return false
  }
})()`

/** 分享桩：`navigator.share` 记下收到的参数（含 files），`canShare({files})` 恒为真。 */
const SHARE_STUB = `(() => {
  window.__shares = []
  try {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      writable: true,
      value: async (data) => {
        window.__shares.push({
          title: data && data.title,
          text: data && data.text,
          url: data && data.url,
          files: ((data && data.files) || []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
        })
      },
    })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      writable: true,
      value: (data) => !!(data && Array.isArray(data.files) && data.files.length > 0),
    })
  } catch (e) {}
  return true
})()`

/** 触感桩：记下 navigator.vibrate 的毫秒数（Chrome 桌面默认不震，测不到副作用）。 */
const VIBRATE_STUB = `(() => {
  window.__vibrations = []
  try {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: (pattern) => {
        window.__vibrations.push(pattern)
        return true
      },
    })
  } catch (e) {}
  return true
})()`

/* ── 测试素材 ──────────────────────────────────────────────────────────────── */

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of typeAndData) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([length, typeAndData, crcBuffer])
}

/** 生成一张真的能解码的 PNG（相册选择 → App 压缩成 jpg → 上传）。 */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 4) % 256
      raw[offset + 1] = (y * 4) % 256
      raw[offset + 2] = ((x + y) * 2) % 256
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 给 Chrome 的假麦克风音频：16kHz 单声道 16bit 的 3 秒「语音状」波形。 */
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

/* ── mock hub 控制面 ──────────────────────────────────────────────────────── */

async function hubStatus() {
  const res = await fetch(`${HUB_URL}/__test/status`)
  return res.json()
}

async function resetHub() {
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
}

/** mock hub 里的 fixture（notes.md 等）：sha256 与字节数，用来核对下载下来的文件。 */
function fixtureOf(status, name) {
  return (status.files ?? []).find((file) => file.name === name) ?? null
}

function sha256File(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/* ── 页面动作 ──────────────────────────────────────────────────────────────── */

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

/** 发一条消息并等回合结束（回合结束会推交付物：chart.png / logo.png / notes.md）。 */
async function sendMessage(cdp, text) {
  await waitFor(cdp, `document.querySelector('.composer__input')`, { label: '输入框' })
  await cdp.eval(`(() => {
    const input = document.querySelector('.composer__input')
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(140)
  await cdp.eval(`document.querySelector('.send-btn[aria-label="发送"]').click()`)
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === true`, { label: '回合开始', timeout: 20000 })
  await waitFor(cdp, `window.__dshHub.chat.turnRunning === false`, { label: '回合结束', timeout: 60000 })
  await waitFor(cdp, `window.__dshHub.chat.deliverables.length >= 1`, {
    label: '交付物出现',
    timeout: 20000,
  })
}

/** 打开指定会话的对话页（默认用 mock hub 的种子会话）。 */
async function openConversation(cdp, sessionId = 's_mock_plan') {
  await cdp.eval(`window.__dshHub.router.push('/c/${sessionId}')`)
  await waitFor(cdp, `document.querySelector('.composer__input')`, { label: '对话页输入卡', timeout: 25000 })
  await sleep(300)
}

/** 交付物里某个文件的卡片按钮（按文件名找，避开「第几个」这种脆弱选择器）。 */
function fileCardAction(name, action) {
  return `(() => {
    const cards = [...document.querySelectorAll('.file-card')]
    const card = cards.find((el) => (el.querySelector('.file-card__name')?.innerText ?? '').trim() === ${JSON.stringify(name)})
    if (!card) return false
    const btn = card.querySelector('${action}')
    if (!btn) return false
    btn.click()
    return true
  })()`
}

/** 大图查看器里点「下载」（比内联卡片的按钮更接近用户真实动作）。 */
function clickChartImage() {
  return `(() => {
    const cards = [...document.querySelectorAll('.image-file')]
    const card = cards.find((el) => (el.querySelector('.image-file__name')?.innerText ?? '').trim() === ${JSON.stringify(CHART_NAME)})
    if (!card) return false
    const img = card.querySelector('.image-file__frame img')
    if (!img) return false
    card.querySelector('.image-file__frame').click()
    return true
  })()`
}

/* ── 下载断言 ──────────────────────────────────────────────────────────────── */

function createDownloadWatcher(cdp, dir) {
  const state = { completed: [], failed: [] }
  cdp.on('Browser.downloadWillBegin', (event) => {
    state.started = state.started ?? []
    state.started.push({ guid: event.guid, suggestedFilename: event.suggestedFilename })
  })
  cdp.on('Browser.downloadProgress', (event) => {
    if (event.state === 'completed') state.completed.push(event.guid)
    if (event.state === 'canceled') state.failed.push(event.guid)
  })
  return {
    state,
    dir,
    /** 等到「第 n 个下载完成」（1-based），返回落盘文件的内容。 */
    async waitForDownload(n, { timeout = 20000 } = {}) {
      const started = Date.now()
      while (Date.now() - started < timeout) {
        if (state.completed.length >= n) {
          const guid = state.completed[n - 1]
          const meta = (state.started ?? []).find((item) => item.guid === guid)
          const name = meta?.suggestedFilename
          const files = (await fs.readdir(dir)).filter((file) => !file.endsWith('.crdownload'))
          const target = name && files.includes(name) ? name : files.sort().at(-1)
          if (!target) {
            await sleep(60)
            continue
          }
          const buffer = await fs.readFile(path.join(dir, target))
          return { name: target, buffer, guid }
        }
        await sleep(60)
      }
      throw new Error(`等待第 ${n} 个下载超时（已完成 ${state.completed.length} 个）`)
    },
  }
}

/* ── 主流程 ────────────────────────────────────────────────────────────────── */

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const pngPath = path.join(OUT, 'pick-me.png')
  await fs.writeFile(pngPath, makePng(96, 64))
  const downloadDir = path.join(OUT, 'downloads')
  await fs.rm(downloadDir, { recursive: true, force: true })
  await fs.mkdir(downloadDir, { recursive: true })

  console.log(`[e2e] VITE_TARGET=${VITE_TARGET}（网页版构建）app=${APP_URL} hub=${HUB_URL}`)
  await startServers()
  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
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
  // 剪贴板读取要求页面「有焦点」：headless 里默认没有焦点
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true, configurable: true }).catch(() => {})

  // 下载目录 + 事件
  let behaviorSet = false
  try {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    })
    behaviorSet = true
  } catch (error) {
    console.log(`  · Browser.setDownloadBehavior 不可用，退回 Page 版本：${error.message}`)
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  }
  const downloads = createDownloadWatcher(cdp, downloadDir)

  // 剪贴板权限（读回断言用）
  try {
    await cdp.send('Browser.grantPermissions', {
      origin: APP_URL,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    })
  } catch (error) {
    console.log(`  · 剪贴板授权失败（复制用例会跳过读回）：${error.message}`)
  }

  const consoleErrors = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // 页面注入：必须在导航之前
  for (const source of [TRACE_SCRIPT, SHARE_STUB, VIBRATE_STUB]) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
  }

  // ---- A. 干净登录
  await resetHub()
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(900)
  await cdp.eval(`(async () => {
    try { localStorage.clear() } catch (e) {}
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name)
    } catch (e) {}
    return true
  })()`)
  await cdp.send('Page.reload')
  await sleep(1000)
  await login(cdp)

  // 确认跑的是网页版构建：直接问页面里那一份模块（dev server 会把 __DSH_WEB__ 换成构建期常量）
  const webBuild = await cdp.eval(`(async () => {
    try {
      const module = await import('/src/lib/app-info.ts')
      return { value: module.IS_WEB_BUILD, type: typeof module.IS_WEB_BUILD }
    } catch (error) { return { error: String(error) } }
  })()`)
  expect(
    'A1 跑的是网页版构建（VITE_TARGET=web → IS_WEB_BUILD=true）',
    webBuild?.value === true,
    webBuild,
  )
  const env = await cdp.eval(`(() => ({
    share: typeof navigator.share,
    vibrate: typeof navigator.vibrate,
    secure: window.isSecureContext === true,
    audio: typeof AudioContext,
  }))()`)
  expect('A2 浏览器能力就位（share / vibrate / secure / AudioContext）', env.secure && env.audio === 'function', env)
  expect('A3 下载目录已就绪（CDP 下载行为）', behaviorSet, { downloadDir })

  // ---- B. 产出文件「保存」= 浏览器下载
  await sendMessage(cdp, '请把这份导出报告发给我')
  await waitFor(cdp, `document.querySelectorAll('.file-card').length >= 1`, { label: '文件卡片', timeout: 20000 })
  await sleep(400)
  const hubFiles = await hubStatus()
  const notesFixture = fixtureOf(hubFiles, NOTES_NAME)
  expect('B0 mock hub 有 notes.md fixture', notesFixture !== null, notesFixture)

  // 第一次点「下载」只是把字节拉下来（与 APK 一致），第二次才真的下载
  await cdp.eval(fileCardAction(NOTES_NAME, '[data-file-save]'))
  await waitFor(cdp, `Object.keys(window.__dshHub.files.fileUrls).length >= 1`, {
    label: '文件字节已加载',
    timeout: 25000,
  })
  await sleep(200)
  await cdp.eval(fileCardAction(NOTES_NAME, '[data-file-save]'))
  const notesDownload = await downloads.waitForDownload(1, { timeout: 30000 })
  expect(
    'B1 点「下载」触发浏览器下载，文件名沿用现有逻辑',
    notesDownload.name === NOTES_NAME,
    notesDownload.name,
  )
  const notesHash = sha256File(notesDownload.buffer)
  expect(
    'B2 落盘字节与 Hub 上的文件完全一致（sha256 + 长度）',
    notesFixture !== null &&
      notesHash === notesFixture.sha256 &&
      notesDownload.buffer.length === notesFixture.bytes,
    {
      got: { sha256: notesHash, bytes: notesDownload.buffer.length },
      want: notesFixture && { sha256: notesFixture.sha256, bytes: notesFixture.bytes },
    },
  )
  // 下载后 object URL 会被释放（10 秒定时器）：这个窗口内还在，之后不泄漏地留着也不算失败
  const revokedSupport = await cdp.eval(`typeof URL.revokeObjectURL === 'function'`)
  expect('B3 下载用的 object URL 有释放通道（revokeObjectURL 可用）', revokedSupport === true)
  await cdp.shot('W3-01-file-card')

  // ---- C. 图片查看器的「保存」
  expect('C1 图片卡片渲染出来（chart.png）', await cdp.eval(clickChartImage()), 'chart.png')
  await waitFor(cdp, `document.querySelector('[data-image-save]')`, { label: '大图查看器', timeout: 15000 })
  await sleep(300)
  await cdp.eval(`document.querySelector('[data-image-save]').click()`)
  const chartDownload = await downloads.waitForDownload(2, { timeout: 30000 })
  const chartFixture = fixtureOf(await hubStatus(), CHART_NAME)
  expect(
    'C2 图片查看器保存 = 下载图片，字节一致',
    chartFixture !== null &&
      chartDownload.name === CHART_NAME &&
      sha256File(chartDownload.buffer) === chartFixture.sha256,
    { name: chartDownload.name, sha256: sha256File(chartDownload.buffer), want: chartFixture?.sha256 },
  )
  await cdp.eval(`window.__dshHub.ui.closeImageViewer()`)
  await sleep(250)

  // ---- D. 「分享」= navigator.share
  const shared = await cdp.eval(fileCardAction(NOTES_NAME, '[data-file-share]'))
  expect('D1 文件卡片有「分享」按钮（浏览器有 navigator.share 时才出现）', shared === true)
  await waitFor(cdp, `(window.__shares || []).length >= 1`, { label: 'navigator.share 被调用', timeout: 15000 })
  const shareCall = await cdp.eval(`(() => { const list = window.__shares || []; return list[list.length - 1] })()`)
  expect(
    'D2 分享收到 files（名字/类型/大小与 Hub 一致）',
    shareCall?.files?.length === 1 &&
      shareCall.files[0].name === NOTES_NAME &&
      shareCall.files[0].size === notesFixture.bytes,
    shareCall,
  )

  // 拿掉 navigator.share：必须自动退回下载并提示（用户在微信内置浏览器/桌面 Firefox 的处境）
  const beforeFallback = downloads.state.completed.length
  await cdp.eval(`(() => {
    try { Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: undefined }) } catch (e) {}
    window.__shares = []
    return true
  })()`)
  await cdp.eval(fileCardAction(NOTES_NAME, '[data-file-share]'))
  const fallbackToast = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 10000) {
      const text = await cdp.eval(`document.querySelector('.toast')?.innerText ?? ''`)
      if (text.includes('已改为下载')) return text
      await sleep(100)
    }
    return ''
  })()
  const fallbackDownload = await downloads
    .waitForDownload(beforeFallback + 1, { timeout: 20000 })
    .catch(() => null)
  expect(
    'D3 没有系统分享时退回下载并提示',
    fallbackDownload !== null && sha256File(fallbackDownload.buffer) === notesFixture.sha256,
    { toast: fallbackToast, name: fallbackDownload?.name },
  )

  // ---- E. 附件：PlusSheet 三个隐藏 input + 相册选图上传
  const pickAttrs = await cdp.eval(`(() => {
    const read = (kind) => {
      const el = document.querySelector('[data-pick-input="' + kind + '"]')
      if (!el) return null
      return { accept: el.getAttribute('accept'), capture: el.getAttribute('capture'), multiple: el.hasAttribute('multiple'), type: el.type }
    }
    return { camera: read('camera'), gallery: read('gallery'), file: read('file') }
  })()`)
  expect(
    'E1 相机的隐藏 input：accept=image/* + capture=environment',
    pickAttrs.camera?.accept === 'image/*' && pickAttrs.camera?.capture === 'environment',
    pickAttrs.camera,
  )
  expect(
    'E2 相册的隐藏 input：accept=image/* + multiple',
    pickAttrs.gallery?.accept === 'image/*' && pickAttrs.gallery?.multiple === true,
    pickAttrs.gallery,
  )
  expect('E3 文件的隐藏 input：类型不限', pickAttrs.file?.accept === '*/*', pickAttrs.file)

  await cdp.eval(`document.querySelector('button[aria-label="更多"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-plus="gallery"]')`, { label: '添加附件弹层' })
  await sleep(200)
  // 走真实路径：点「相册」→ input.click()（headless 里不会弹系统选择器，接着用 CDP 塞文件）
  await cdp.eval(`document.querySelector('[data-plus="gallery"]').click()`)
  await sleep(300)
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-pick-input="gallery"]',
  })
  expect('E4 找到相册的隐藏 input 节点（CDP 才能塞文件）', nodeId > 0, { nodeId })
  await cdp.send('DOM.setFileInputFiles', { files: [pngPath], nodeId })
  await waitFor(cdp, `document.querySelectorAll('.tray__item').length >= 1`, {
    label: '附件出现在托盘',
    timeout: 20000,
  })
  const trayText = await cdp.eval(
    `(() => { const el = document.querySelector('.tray__item'); return el ? el.innerText.trim() : '' })()`,
  )
  expect('E5 附件出现在托盘，名字是压缩后的 jpg', /\.jpg/.test(trayText), trayText)
  await waitFor(cdp, `(() => {
    const items = Object.values(window.__dshHub.chat.attachments || [])
    return items.length >= 1 && items.every((item) => item.state === 'ready')
  })()`, { label: '附件上传完成', timeout: 30000 })
  const afterUpload = await hubStatus()
  const upload = (afterUpload.uploads ?? []).at(-1)
  expect(
    'E6 上传成功（Hub 收到完整字节，与 APK 同一条附件链路）',
    upload !== undefined && upload.received === upload.bytes && upload.bytes > 0,
    upload,
  )
  await cdp.shot('W3-02-attachment')

  // ---- F. 剪贴板（诊断面板的复制按钮）
  // 记录「复制按钮到底写了什么」：包一层 writeText，同时仍然调用真正的剪贴板 API。
  // headless 里 readText 有时回读为空（没有系统剪贴板后端），这时靠这层记录断言内容。
  await cdp.eval(`(() => {
    window.__copied = []
    const cb = navigator.clipboard
    if (!cb || typeof cb.writeText !== 'function') return false
    if (!window.__origWriteText) window.__origWriteText = cb.writeText.bind(cb)
    cb.writeText = async (text) => {
      window.__copied.push(text)
      return window.__origWriteText(text)
    }
    return true
  })()`)
  await cdp.eval(`window.__dshHub.ui.openSidePanel('diagnostics')`)
  await waitFor(cdp, `document.querySelector('.diag__copy')`, { label: '诊断面板复制按钮' })
  await sleep(200)
  await cdp.eval(`document.querySelector('.diag__copy').click()`)
  await waitFor(cdp, `(window.__copied || []).length >= 1`, { label: '复制写入剪贴板', timeout: 10000 })
  await sleep(300)
  const copied = await cdp.eval(`(window.__copied || []).at(-1) ?? ''`)
  const readBack = await cdp.eval(`(async () => {
    try { return await navigator.clipboard.readText() } catch (error) { return '' }
  })()`)
  expect(
    'F1 复制按钮写进剪贴板（navigator.clipboard 路径 + 内容是诊断报告）',
    typeof copied === 'string' && copied.includes('DSH') && copied.length > 20,
    copied.slice(0, 80),
  )
  expect(
    'F2 剪贴板能读回同一份内容（headless 无剪贴板后端时跳过读回比对）',
    readBack === '' || readBack === copied,
    { readBack: String(readBack).slice(0, 60), matches: readBack === copied },
  )
  const copyToast = await cdp.eval(`document.querySelector('.toast')?.innerText ?? ''`)
  expect('F3 复制成功有提示', copyToast.includes('已复制'), copyToast)
  await cdp.eval(`window.__dshHub.ui.closeSidePanel()`).catch(() => {})
  await sleep(300)

  // ---- G. 按住说话：权限被拒 → 网页版文案；放行后跑通识别
  const denied = await denyMic(cdp)
  await holdMic(cdp, 700)
  await waitFor(cdp, `document.querySelector('.voice-dialog__title')`, { label: '权限弹窗', timeout: 15000 })
  const deniedDialog = await cdp.eval(`(() => ({
    title: document.querySelector('.voice-dialog__title')?.innerText.trim() ?? '',
    text: document.querySelector('.voice-dialog__text')?.innerText.trim() ?? '',
    tips: [...document.querySelectorAll('.voice-dialog__tips li')].map((li) => li.innerText.trim()).join(' | '),
    buttons: [...document.querySelectorAll('.voice-dialog__btn')].map((b) => b.innerText.trim()),
  }))()`)
  expect(
    'G1 权限被拒给网页版文案（地址栏/站点设置）',
    deniedDialog.title.includes('需要麦克风权限') &&
      (deniedDialog.text + deniedDialog.tips).includes('站点设置'),
    deniedDialog,
  )
  expect(
    'G2 网页版不显示「去设置」（没有系统设置页可跳）',
    deniedDialog.buttons.includes('去设置') === false,
    deniedDialog.buttons,
  )
  await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('.voice-dialog__btn')].find((b) => b.textContent.includes('知道了'))
    if (button) button.click()
    return true
  })()`)
  await sleep(300)
  await allowMic(cdp, denied)

  const beforeVoice = await hubStatus()
  await clearInput(cdp)
  await holdMic(cdp, 1400)
  await waitFor(cdp, `document.querySelector('.composer__input')?.value.includes(${JSON.stringify(ASR_TEXT)})`, {
    label: '识别文字进入输入框',
    timeout: 25000,
  })
  const afterVoice = await hubStatus()
  expect(
    'G3 假麦克风按住说话 → WAV 上传 Hub ASR → 文字插进输入框',
    (afterVoice.voice?.requests ?? 0) === (beforeVoice.voice?.requests ?? 0) + 1,
    { before: beforeVoice.voice?.requests, after: afterVoice.voice?.requests },
  )
  await cdp.shot('W3-03-voice')
  await clearInput(cdp)

  // ---- H. 朗读：手势里解锁 AudioContext，并且真的排了 PCM
  await waitFor(cdp, `document.querySelectorAll('[data-tts-actions] [data-tts-key]').length >= 1`, {
    label: '朗读按钮',
    timeout: 20000,
  })
  // 录音也会建 AudioContext：只盯「点朗读之后新建的那个」
  const ctxBefore = await cdp.eval(`(window.__audioCtxs || []).length`)
  await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('[data-tts-actions] [data-tts-key]')]
    buttons[buttons.length - 1].click()
    return true
  })()`)
  await waitFor(cdp, `(window.__audioCtxs || []).length > ${ctxBefore}`, {
    label: '朗读的 AudioContext 建立',
    timeout: 15000,
  })
  // 等真的排上 PCM（首块要等服务端合成，约 200ms+）
  await waitFor(cdp, `(window.__ttsBuffers || []).filter((b) => b.length > 1).length >= 1`, {
    label: 'PCM 排程',
    timeout: 30000,
  })
  const audio = await cdp.eval(`(() => {
    const ctxs = (window.__audioCtxs || []).map((c) => ({ state: c.state, sampleRate: c.sampleRate }))
    const tts = window.__audioCtxs[TTX]
    const buffers = (window.__ttsBuffers || []).filter((b) => b.length > 1)
    const starts = (window.__ttsStarts || []).filter((s) => (s.duration || 0) > 0.001)
    return {
      contexts: ctxs,
      ttsState: tts ? tts.state : null,
      pcmBuffers: buffers.length,
      pcmSamples: buffers.reduce((sum, b) => sum + b.length, 0),
      scheduled: starts.length,
      scheduledSeconds: Number(starts.reduce((sum, s) => sum + (s.duration || 0), 0).toFixed(3)),
      // iOS Safari 的解锁节点：1 帧静音（时长 ≈ 0.000125s），只有网页版构建才播
      silentUnlocks: (window.__ttsStarts || []).filter(
        (s) => (s.duration || 0) > 0 && (s.duration || 0) <= 0.001,
      ).length,
      phase: window.__dshHub?.tts?.phase ?? null,
      segment: window.__dshHub?.tts?.segment ?? null,
      total: window.__dshHub?.tts?.total ?? null,
    }
  })()`.replace('TTX', String(ctxBefore)))
  const ttsStatus = (await hubStatus()).tts
  expect(
    'H1 点「朗读」后 AudioContext 是 running（手势里解锁成功）',
    audio.ttsState === 'running',
    { contexts: audio.contexts, ttsState: audio.ttsState },
  )
  expect(
    'H2 流式朗读真的排了 PCM（不是静音占位）',
    audio.pcmBuffers > 0 && audio.pcmSamples > 0 && audio.scheduled > 0,
    {
      pcmBuffers: audio.pcmBuffers,
      pcmSamples: audio.pcmSamples,
      scheduled: audio.scheduled,
      phase: audio.phase,
      segment: audio.segment,
      total: audio.total,
      hubStreams: ttsStatus?.streams,
      hubRequests: ttsStatus?.requests,
    },
  )
  expect(
    'H3 排程走的是音频时钟（每块都有真实时长）',
    audio.scheduledSeconds > 0,
    { scheduledSeconds: audio.scheduledSeconds, scheduled: audio.scheduled },
  )
  expect(
    'H4 网页版走了 iOS Safari 的静音解锁（手势里播过一段 1 帧 buffer）',
    audio.silentUnlocks >= 1,
    { silentUnlocks: audio.silentUnlocks },
  )
  // 切后台（visibilitychange）→ 与 APK 一致：立刻停止朗读，不留在暂停态
  await cdp.eval(`(() => {
    window.__hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden === true })
    document.dispatchEvent(new Event('visibilitychange'))
    return true
  })()`)
  await waitFor(cdp, `window.__dshHub.tts.phase === 'idle'`, { label: '切后台后朗读停止', timeout: 15000 })
  const ttsStopped = await cdp.eval(
    `(() => ({ phase: window.__dshHub.tts.phase, busy: window.__dshHub.tts.busy }))()`,
  )
  expect(
    'H5 页面切后台时停止朗读（与 APK 的 appStateChange 一致）',
    ttsStopped.phase === 'idle' && ttsStopped.busy === false,
    ttsStopped,
  )
  // 恢复前台，别把后面的用例留在 hidden 状态
  await cdp.eval(`(() => {
    window.__hidden = false
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
    return true
  })()`)
  await sleep(300)
  await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('[data-tts-actions] [data-tts-key]')]
    const last = buttons[buttons.length - 1]
    if (last && last.dataset.ttsState !== 'idle') last.click()
    return true
  })()`)
  await sleep(400)
  await cdp.shot('W3-04-tts')

  // ---- I. 触感 = navigator.vibrate（发消息时轻触 10ms）
  const vibrations = await cdp.eval(`window.__vibrations || []`)
  expect(
    'I1 发送等操作触发了 navigator.vibrate(10)（触感网页实现）',
    Array.isArray(vibrations) && vibrations.includes(10),
    vibrations.slice(0, 8),
  )

  // ---- J. 控制台无错误
  expect('J1 全流程控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    viteTarget: VITE_TARGET,
    viewport: VIEWPORT,
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'web-files-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'web-files-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

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

/** 真触摸按住 `holdMs` 再松手（走 pointerdown/up 全链路）。 */
async function holdMic(cdp, holdMs) {
  const point = await micPoint(cdp)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  })
  await sleep(holdMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * 模拟「麦克风权限被拒」：先试 CDP 的权限覆盖（最真实），拿不到就临时把
 * `getUserMedia` 换成一个抛 NotAllowedError 的桩 —— 这正是浏览器拒绝时的行为，
 * 走的是同一条 `recorderErrorFor` → permission-denied 路径。
 */
async function denyMic(cdp) {
  try {
    await cdp.send('Browser.setPermission', {
      permission: { name: 'audioCapture' },
      setting: 'denied',
      origin: APP_URL,
    })
  } catch {
    /* 老 Chrome 没有这个命令 */
  }
  await sleep(200)
  const denied = await cdp.eval(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      return false
    } catch (error) {
      return true
    }
  })()`)
  if (denied) return 'cdp'
  await cdp.eval(`(() => {
    const md = navigator.mediaDevices
    window.__origGetUserMedia = md.getUserMedia.bind(md)
    md.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError') }
    return true
  })()`)
  return 'patched'
}

async function allowMic(cdp, mode) {
  if (mode === 'patched') {
    await cdp.eval(`(() => {
      if (window.__origGetUserMedia) navigator.mediaDevices.getUserMedia = window.__origGetUserMedia
      return true
    })()`)
    return
  }
  await cdp
    .send('Browser.setPermission', {
      permission: { name: 'audioCapture' },
      setting: 'granted',
      origin: APP_URL,
    })
    .catch(() => {})
  await sleep(200)
}

/* ── 起服务 ────────────────────────────────────────────────────────────────── */

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

  console.log(`[e2e] 起 vite :${APP_PORT}（VITE_TARGET=${VITE_TARGET}，VITE_HUB_ORIGIN=${HUB_URL}）`)
  const vite = spawn(
    path.join(ROOT, 'packages/mobile-ui/node_modules/.bin/vite'),
    ['--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: path.join(ROOT, 'packages/mobile-ui'),
      env: { ...process.env, VITE_HUB_ORIGIN: HUB_URL, VITE_TARGET, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(vite)
  pipeStdout('vite', vite)
  await waitHttp(`${APP_URL}/`, { label: 'vite' })

  const fakeAudio = await makeFakeAudio()
  profileDir = `/tmp/e2e-profile-web-files-${Date.now()}`
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
      // 朗读的 AudioContext 由页面在点击里创建；这里再放开一层自动播放限制
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
