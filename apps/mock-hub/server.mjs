#!/usr/bin/env node
/**
 * 本地假 Hub（A1 联调与 e2e 用）。
 *
 * 为什么还要一个 Node 服务，而不是只用 App 里的进程内 mock：
 *  - 端到端探针需要一个**真实 HTTP + WebSocket** 的对端，才能覆盖 CORS、ticket、
 *    WS 升级、断线重连这些只在「真连接」下才出现的路径；
 *  - App 的 mock 构建（VITE_HUB_ORIGIN=mock）用于没有服务的真机演示，两者共用同一份协议。
 *
 * 只监听 5242–5250（A1 端口段），不要占用 8040。
 *
 * 启动：
 *   node apps/mock-hub/server.mjs             # 默认 5245
 *   PORT=5246 node apps/mock-hub/server.mjs
 *   node apps/mock-hub/server.mjs --web-dist packages/mobile-ui/dist-web   # 顺便托管手机网页版（/m/）
 *
 * 手机网页版（WP54）：`--web-dist <目录>` 或 `MOCK_WEB_DIST=<目录>` 时，在 `/m/` 下同源托管
 * `packages/mobile-ui/dist-web`（缓存头按契约 C6；`/m` → 301 `/m/`；没给目录时 `/m/` 回中文 503 页）。
 * 与 Hub（WP54b）对齐的路径语义：`/m/`(`/index.html`)、`/m/version.json` 用 no-store；
 * `/m/assets/*` 一年 immutable；**带扩展名但不存在 → 404**（含 version.json，绝不回 index.html）；
 * **不带扩展名的路径 → 兜底 index.html**（no-store）。
 * 这样 e2e 里页面与 Hub **同源**：入口 = location.origin、`connect-src 'self'`、
 * 相对路径的 `./version.json` 都与生产一致。登录接口按契约校验 `platform ∈ android/ios/web`，
 * 并把最近一次登录请求（platform/deviceName/installId/user-agent）记在 `GET /__test/last-login`。
 *
 * 账号（仅 mock）：
 *   demo / demo1234        正常
 *   pending / demo1234     待审批
 *   disabled / demo1234    已停用
 *   changepw / demo1234    必须改密码
 *   ratelimit / demo1234   限流
 *
 * e2e 控制（不在产品路径）：
 *   POST /__test/disconnect   模拟网络掉线（terminate 所有 WS）
 *   POST /__test/hold         挂起后续 WS 握手 {ms}，模拟「后端一直连不上」；ms=0 释放
 *   POST /__test/sleep        模拟 Hub 把空闲容器休眠：实例回到 stopped 并掐断所有 WS
 *                            （之后 bootstrap 报 instance-not-running，要 App 重新 wake 才能连）
 *   POST /__test/voice        语音识别钩子（0.4.2）：{ asr, maxSeconds, fail, delayMs }
 *   POST /__test/reply        下一条回复的钩子（0.4.8）：{ text, plain, tickMs, chunk }
 *                            text 换回复正文、plain 只发正文（不思考/不工具/不交付物）、
 *                            tickMs 改流式节拍、chunk 改每拍几个字；只对下一条 send 生效，
 *                            不设置时行为与以前完全一样
 *   POST /__test/tts          朗读钩子（0.4.3/0.4.6）：{ enabled, fail, delayMs, maxChars, rateLimit,
 *                            stream, streamRate, streamFirstMs, streamChunkMs, streamInterruptAfter }
 *   GET  /__test/status       当前实例/会话/流式状态
 *   POST /__test/reset        重置 demo 账号的实例与会话
 *   POST /__test/origin-mode  「主入口不可达」场景（0.4.11 / WP52）：`{ blocked: boolean }`
 *                             切换后所有 /api/* 都回阿里云风格的 403 HTML（Server: Beaver），
 *                             连 /api/health 也不通；GET 返回当前状态与请求计数。
 *                             启动时也可以用环境变量 MOCK_ORIGIN_BLOCKED=1 直接是拦截态。
 *                             带 `X-DSH-Mock-Ingress: backup` 的请求视为从**备用入口**进来的
 *                             （e2e 代理会加），不受拦截影响：两个入口背后是同一个 hub 进程。
 *
 * 服务端语音识别（0.4.2 / WP49）：`POST /api/mobile/asr`（audio/wav）只校验 WAV 头与上限，
 * 然后回固定文字「这是一段测试语音」；`bootstrap.voice` 由 `voiceHook` 决定。
 * 朗读（0.4.3 / WP50）：`POST /api/mobile/tts`（JSON `{text,voice}`）按字数生成一段 24kHz
 * 正弦波 WAV；`bootstrap.voice.tts` 由 `ttsHook` 决定（默认开启，音色只有星汐 seki）。
 * 流式朗读（0.4.6 / WP51）：`POST /api/mobile/tts/stream` 返回裸 PCM16，按 `streamRate`
 * 倍实时速率分块下发（模拟真星汐「首块 0.2 秒、之后比实时略慢」）。默认 0.9，可用环境变量
 * `MOCK_TTS_STREAM_RATE` 改（e2e 的 1.05 / 0.9 场景就是改这个钩子）；`POST /__test/tts`
 * 也能在跑动中改。
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { WebSocketServer } from 'ws'

// 真实形状的模型目录：直接复用 WP40c-1 的 fixtures-v2/models-catalog.json 副本。
const MODEL_CATALOG = JSON.parse(
  readFileSync(new URL('./models-catalog.json', import.meta.url), 'utf8'),
)

/**
 * 命令行参数（都等价于同名环境变量，方便 e2e 运行器与手工启动两种用法）：
 *   --port <n>        / PORT
 *   --web-dist <目录> / MOCK_WEB_DIST —— 手机网页版构建产物（`packages/mobile-ui/dist-web`），
 *                       在 `/m/` 下同源托管（WP54，契约 C2/C6）。不给时 `/m/` 回 503。
 */
const argv = process.argv.slice(2)
function argValue(name, envName) {
  const inline = argv.find((item) => item.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1]
  return process.env[envName] ?? ''
}

const PORT = Number(argValue('port', 'PORT') || 5245)
const HOST = process.env.HOST ?? '0.0.0.0'
const TICK_MS = Number(process.env.TICK_MS ?? 25)
const WAKE_MS = Number(process.env.WAKE_MS ?? 1200)
const PROTOCOL_VERSION = 1

/** 登录平台取值（与 shared 的 `MobileAppPlatformSchema` 一致：android / ios / web）。 */
const MOBILE_PLATFORMS = ['android', 'ios', 'web']

/**
 * 手机网页版托管目录（WP54）：`--web-dist <目录>` 或 `MOCK_WEB_DIST`。
 *
 * 为什么 mock hub 要托管它：手机网页版是**同源**的（Hub 在 `/m/` 下托管同一套 App 界面，
 * 入口 = 页面 origin，`connect-src 'self'`）。要在 e2e 里跑「真的同源」，就必须让 mock hub
 * 自己当那个源，而不是再起一个 vite —— 所以这里按契约 C6 的缓存头托管静态产物：
 *   /m/、/m/version.json → no-store；/m/assets/* → 一年 immutable；其它 → no-cache。
 */
const WEB_DIST_RAW = argValue('web-dist', 'MOCK_WEB_DIST').trim()
let WEB_DIST = ''
if (WEB_DIST_RAW) {
  try {
    WEB_DIST = realpathSync(path.resolve(WEB_DIST_RAW))
  } catch {
    console.warn(`[mock-hub] --web-dist 目录不存在：${WEB_DIST_RAW}（/m/ 会回 503）`)
    WEB_DIST = ''
  }
}
/** 网页版的挂载前缀（与 shared 的 MOBILE_WEB_BASE_PATH 一致，带结尾斜杠）。 */
const MOBILE_WEB_BASE = '/m/'

/** 与 Hub 契约（WP49，packages/shared/src/api/mobile.ts）保持一致：60 秒 / 16kHz 单声道 16bit。 */
const ASR_MAX_SECONDS = 60
const ASR_MAX_BYTES = 16_000 * 2 * ASR_MAX_SECONDS + 1_024
const ASR_TEXT = '这是一段测试语音'

/**
 * 语音识别钩子（e2e / 截图用）：
 *   asr      —— `false` 时 bootstrap.voice.asr=false（App 应改用系统识别）
 *   fail     —— 接下来 N 次识别直接 502（模拟识别服务没起来），用一次减一次
 *   delayMs  —— 每次识别人为延迟（截图时能把「正在识别…」定住）
 */
const voiceHook = { asr: true, maxSeconds: ASR_MAX_SECONDS, fail: 0, delayMs: 0 }

/**
 * 「主入口不可达」场景（0.4.11 / WP52 多入口 e2e）：真实世界的样子是阿里云按 SNI 拦截
 * 未备案域名 —— 所有 /api/* 请求收到 403 HTML（不是 Hub 的 JSON 错误信封），健康检查同样不通。
 * App 据此判定「入口挂了」并切到备用入口（见 packages/core/src/http/origin-manager.ts）。
 *
 * `/__test/*` 控制面不受影响（否则 e2e 连「让它恢复」都做不到）。
 */
const originHook = {
  blocked: process.env.MOCK_ORIGIN_BLOCKED === '1',
  apiRequests: 0,
  blockedRequests: 0,
  backupRequests: 0,
}
const BLOCKED_PAGE =
  '<!DOCTYPE html><html><head><title>403 Forbidden</title></head>' +
  '<body><h1>403 Forbidden</h1><p>该网站未备案，暂时无法访问。</p></body></html>'

/**
 * 最近一次登录请求（WP54）：只给 e2e 断言用（`GET /__test/last-login`）。
 *
 * 手机网页版要看「登录请求里 platform 是不是 web、deviceName 是不是
 * 手机网页版 · Chrome · Android」—— 这些只有服务端能看到（CDP 抓包也能，但这里更直接），
 * 与 `/__test/status` 一样属于控制面，不进产品逻辑。
 */
let lastLogin = null

/** 拦截页：403 + text/html + Server: Beaver（与阿里云的拦截页特征一致）。 */
function blockedPage(res) {
  res.writeHead(403, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Server: 'Beaver',
  })
  res.end(BLOCKED_PAGE)
}

/** 成功识别次数（e2e 断言「确实上传过一次」用；不进产品路径）。 */
let asrRequests = 0

/**
 * 朗读（0.4.3 / WP50）：
 *   enabled    —— false 时 bootstrap.voice.tts.enabled=false 且 /api/mobile/tts 回 502
 *   fail        —— 接下来 N 次合成回 502（模拟合成服务没起来），用一次减一次
 *   rateLimit   —— 接下来 N 次回 429 + details.retryAfterSec（App 应按它重试一次）
 *   delayMs     —— 每次合成人为延迟（让「边播边合成/预取」的时序在 e2e 里看得见）
 *   maxChars    —— 单次合成的文字上限（App 按它切段）
 */
const TTS_MAX_CHARS = 200
const TTS_SAMPLE_RATE = 24_000
const TTS_VOICES = [{ id: 'seki', name: '星汐 seki', description: '温柔清晰的女声，适合朗读长回复' }]
/**
 * 流式模拟的默认速率（音频秒 / 真实秒）：真星汐实测 0.89–0.91。
 * 环境变量 `MOCK_TTS_STREAM_RATE` 可改（默认 0.9）；`/__test/tts` 还能临时覆盖。
 */
const TTS_STREAM_RATE = (() => {
  const raw = Number(process.env.MOCK_TTS_STREAM_RATE ?? 0.9)
  return Number.isFinite(raw) ? Math.min(1.5, Math.max(0.3, raw)) : 0.9
})()
const ttsHook = {
  enabled: true,
  fail: 0,
  rateLimit: 0,
  retryAfterSec: 1,
  delayMs: 0,
  maxChars: TTS_MAX_CHARS,
  /**
   * 流式朗读（0.4.6 / WP51）：
   *   stream        —— bootstrap.voice.tts.stream（false = 模拟老 Hub，只发整段接口）
   *   streamRate    —— 音频秒 / 真实秒（真星汐实测 0.89–0.91，默认 0.9 = 比实时略慢）
   *   streamFirstMs —— 首块延迟（真机 0.18–0.32 秒）
   *   streamChunkMs —— 每块音频时长
   *   streamMsPerChar —— 流式模拟的语速（178ms/字 ≈ 5.6 字/秒，与 App 的估算口径一致）
   *   streamInterruptAfter —— 下发 N 块之后掐断连接（模拟开始下发后的合成失败）
   */
  stream: true,
  streamRate: TTS_STREAM_RATE,
  streamFirstMs: 200,
  streamChunkMs: 200,
  streamMsPerChar: 178,
  streamInterruptAfter: 0,
}
/** e2e 断言用：请求总数、当前并发、历史最大并发、每段字数（不记文字）。 */
const ttsStats = {
  requests: 0,
  inflight: 0,
  maxInflight: 0,
  segments: [],
  voices: [],
  streams: 0,
  streamAborted: 0,
}

/** 按字数生成一段 24kHz 单声道 16bit WAV（正弦 + 音节包络；与 App 的 MockHub 同一口径）。 */
function encodeTtsWav(text) {
  const chars = [...text.replace(/\s+/g, '')].length
  const durationMs = Math.max(300, Math.min(10_000, Math.round(chars * 90)))
  const totalSamples = Math.max(1, Math.round((TTS_SAMPLE_RATE * durationMs) / 1_000))
  const buffer = Buffer.alloc(44 + totalSamples * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + totalSamples * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(TTS_SAMPLE_RATE, 24)
  buffer.writeUInt32LE(TTS_SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(totalSamples * 2, 40)
  const syllable = Math.max(1, Math.round((90 * TTS_SAMPLE_RATE) / 1_000))
  const fade = Math.max(1, Math.round(TTS_SAMPLE_RATE * 0.01))
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / TTS_SAMPLE_RATE
    const phase = (i % syllable) / syllable
    const envelope = Math.sin(Math.PI * phase) ** 2
    const edge = Math.min(1, i / fade, (totalSamples - i) / fade)
    const value = Math.sin(2 * Math.PI * 220 * t) * 0.25 * envelope * edge
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + i * 2)
  }
  return buffer
}

/**
 * 流式朗读下发的裸 PCM16 小端单声道字节（无 WAV 头）。
 *
 * 语速按 `msPerChar` 走（默认 178ms/字 ≈ 5.6 字/秒，与真星汐实测接近），
 * 这样 App 的自适应缓冲估算（字数 / 5.6）在 e2e 里能对上。
 */
function encodeTtsPcm(text, msPerChar = 178) {
  const chars = [...text.replace(/\s+/g, '')].length
  const totalSamples = Math.max(1, Math.round((chars * msPerChar * TTS_SAMPLE_RATE) / 1_000))
  const buffer = Buffer.alloc(totalSamples * 2)
  const syllable = Math.max(1, Math.round((msPerChar * TTS_SAMPLE_RATE) / 1_000))
  const fade = Math.max(1, Math.round(TTS_SAMPLE_RATE * 0.01))
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / TTS_SAMPLE_RATE
    const phase = (i % syllable) / syllable
    const envelope = Math.sin(Math.PI * phase) ** 2
    const edge = Math.min(1, i / fade, (totalSamples - i) / fade)
    const value = Math.sin(2 * Math.PI * 220 * t) * 0.25 * envelope * edge
    buffer.writeInt16LE(Math.round(value * 32_767), i * 2)
  }
  return buffer
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function wavBytes(res, status, buffer, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'audio/wav',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(buffer)
}

const MOCK_REPLY = `收到！我先按你的要求把这件事**拆开做**，每一步都给你可核对的结果。

### 先做什么

1. 读一遍现有的接口定义，确认字段没有漂移
2. 用本地假服务跑通登录、唤醒、发送和停止
3. 断线之后带游标续传，确认不重复也不丢字

### 进度

| 阶段 | 状态 |
| --- | --- |
| 登录 | 完成 |
| 唤醒 | 进行中 |
| 通道 | 完成 |

下面是一段示例代码：

\`\`\`ts
const ticket = await hub.requestTicket(nodeId)
const link = new WsChannelLink(channelUrl(nodeId, ticket))
await link.ready()
\`\`\`

再补一段 Python，验证工具卡和代码高亮不会互相影响：

\`\`\`python
import math
values = [math.sin(i / 10) for i in range(0, 120)]
print(len(values), values[0])
\`\`\`

### 接下来

- 先把会话列表按后端缓存起来，切回来时立刻能看
- 再确认流式停止在 1 秒内生效
- 最后把附件和大文件下载留到下一个版本

行内公式也可以显示：\\(E = mc^2\\)（LaTeX 原生行内写法，应该走 KaTeX 渲染，而不是原样显示成括号）。

块级公式同样支持：

\\[\\int_0^1 x\\,dx = \\frac{1}{2}\\]

另外金额不会被误认成公式：一共 $5 和 $10 两笔。

> 提示：如果你希望我换一种更短的写法，直接说一声就行。

最后确认一下：需要我把上面的清单直接执行掉，还是先只做第一步？如果需要我边做边汇报，我也可以每完成一项就发一条进度。`

let lastApprovalDecision = null

const CAPABILITIES = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: true,
  create: true,
  // v2 能力位（与 v1 平铺）
  models: true,
  rename: true,
  archive: true,
  filesRead: true,
  filesList: true,
  filesUpload: true,
  deliverables: true,
}

/** mock 支持的 v2 feature：客户端声明什么就回显什么（交集）。 */
const SUPPORTED_FEATURES = [
  'models',
  'tools',
  'reasoning',
  'files',
  'deliverables',
  'attachments',
  'rename',
  'archive',
  'usage',
  // WP46 / M6 §2：会话回合态 + 未决提问/审批的权威快照，以及会话行的 pendingInteractions
  'session-state',
]

/** v2 能力位（shared 契约里与 v1 的 8 个平级，不嵌套）。 */
const CAPABILITIES_V2 = {
  models: true,
  rename: true,
  archive: true,
  filesRead: true,
  filesList: true,
  filesUpload: true,
  deliverables: true,
}

// 与 shared 的 MOBILE_V2_* 限额对齐（mock 只是照着实现，不重新定义语义）
const V2_CHUNK_RAW = 144 * 1024
const V2_INLINE_RAW = 96 * 1024
const V2_IMAGE_MAX = 5 * 1024 * 1024
const V2_FILE_MAX = 20 * 1024 * 1024

/** 假回合的思考过程（真实 DSH 的 reasoning 增量会逐字到达，这里按块发）。 */
const MOCK_REASONING = `用户问的是一个开发进度问题，我先确认上下文：他刚看过 A1 的界面，关心对话页是否完整。我应该先给结论，再补一句可核对的信息。
先想想有哪些线索可以引用：通道契约、界面验收点、以及他知道的最近几次改动。把顺序理清楚：结论 → 依据 → 下一步建议。
避免说太多细节，手机屏幕窄，长句要拆开。再检查一下有没有遗漏的用户意图：他其实更关心「思考过程」和「工具卡」的排列是否自然，所以回答里要点名这次修了什么。
最后再补一句可以马上验证的做法，方便他在真机上确认。另外注意：工具卡结束后正文要能接上，不要把思考又整个吞掉；如果用户在思考中途滑上去看历史，不要强行把他拽回底部，等他自己回到底部再继续跟随。
这一段的目的是让 mock 的思考内容足够长，能在 320px 高的思考框里产生内部滚动，从而在端到端测试里验证「思考框自动滚到最新」这条行为，而不是只靠肉眼在真机上看。多写几行没有关系，真实 DSH 的思考增量往往就有几百上千字，比这段长得多。
再补一些内容确保滚动一定发生：这一段会重复描述当前正在做的事——先看用户的问题，再确认上下文来源，然后决定要不要调用工具，调用完工具之后继续整理搜索结果，最后把结论写清楚并给出可验证的步骤。每一步都要按顺序来，不能跳步，也不能把上一段的结论直接当成最终答案。写到足够长以后，思考框内部就会出现滚动条，此时应当始终显示最新一行，而不是停在最上面。`

/**
 * 0.4.0 §2 的过程行场景：提示词里带这个词时，mock 按「思考 → 搜索工具 → 再思考 → 正文」
 * 执行（默认回合是「思考 → 工具与正文同时推进」，验证不了块位置/ key 不变）。
 */
const PROCESS_SCENARIO_MARK = /过程行/u
const PROCESS_REASONING_1 = `我先看一下当前的时间线结构：这一轮应该只有一个过程行，位置固定。
第一步只思考，不调工具，用来验证「实时思考」出现在用户消息下方，而不是时间线末尾。
思考还在继续，摘要里应该一直是最新这一句。`
const PROCESS_REASONING_2 = `搜索结束了，我再想一下怎么回答：过程行还应该在同一个位置，不能跳。
这次思考是在工具卡之后才出现的，用来验证它并进的是同一个过程行，而不是新起一块。
想清楚了，接下来开始写正文。`

/**
 * 0.4.9 交付截图用的长思考（提示词里带「长思考」）：
 * 一段**很长的一整句**（只有逗号，没有句号），运行中右侧的「当前状态」会一直是最新这一句的
 * 前 30 个字，在 390px 宽下必然被省略号截断，而且截断状态能稳住一两秒——
 * 截图脚本不用去抢那个 70ms 的瞬时窗口。
 */
const LONG_THINK_MARK = /长思考/u
const LONG_THINK_REASONING = `这一轮要把过程行运行时的头部换成左边固定的「正在深度求索中」加动态省略号、右边接当前状态，我得先确认左侧这段文案在窄屏和系统字体放大百分之三十的时候都不会被右侧挤成两行，再确认动态省略号的宽度是固定的所以右边那句状态不会随着点数的多少来回抖动，接着确认运行中到结束的切换里头部高度保持三十二像素、位置采样的极差不超过两个像素，最后把兜底情况下右侧留空的规则也对一遍，别出现「正在深度求索中… 思考中」这种重复，同时保证读屏用户听到的是文案加当前状态，而不是两段互不相干的内容。
再补一段较短的总结：改动只碰运行态，结束后的图标加结果摘要保持原样。`

const MOCK_SEARCH_QUERY = 'DSH Hub 手机通道 v2 冻结裁决'
const MOCK_CITATIONS = [
  { title: 'M5 通道 v2 契约（§17 冻结裁决）', url: 'https://example.invalid/m5-v2' },
  { title: 'DSH Hub 开发文档 v2 §1.4', url: 'https://example.invalid/doc-1-4' },
  { title: 'WP40c-2 进度：工具帧与文件帧', url: 'https://example.invalid/wp40c2' },
  // 0.4.10：超过 3 个才会出现「+N」（e2e-thread 验证点开展开 / 收起）
  { title: 'WP46 会话代理与重连', url: 'https://example.invalid/wp46' },
  { title: 'WP51 流式朗读转发', url: 'https://example.invalid/wp51' },
]

// ── 样例产出文件（真 PNG / 真大文本，用来走 file 与 file-chunk 两条路径）────────

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** 生成一张噪声 PNG（噪声压不动，体积稳定 >96KiB → 走分片下载路径）。 */
function makeNoisePng(width, height, seed = 1) {
  const rowBytes = width * 3 + 1
  const raw = Buffer.alloc(rowBytes * height)
  let state = seed >>> 0
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0
    for (let x = 0; x < width * 3; x += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      raw[y * rowBytes + 1 + x] = state & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 生成一张 32×32 纯色 PNG（<96KiB → 走一次性 `file` 路径）。 */
function makeSolidPng(size, rgb) {
  const rowBytes = size * 3 + 1
  const raw = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * rowBytes] = 0
    for (let x = 0; x < size; x += 1) {
      raw[y * rowBytes + 1 + x * 3] = rgb[0]
      raw[y * rowBytes + 2 + x * 3] = rgb[1]
      raw[y * rowBytes + 3 + x * 3] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const fileRefOf = (name) => Buffer.from(`v1:mock:${name}`).toString('base64url')

const DESKTOP_NODE = {
  id: 'dv_mock_desktop_01',
  kind: 'desktop',
  name: '书房的 Windows',
  status: 'host-running',
  presence: 'online',
  connectable: false,
  reason: 'desktop-remote-off',
  clientVersion: '0.9.3',
}

/**
 * 管理座舱（WP56d）的假后端：`scope=cockpit` 的令牌只看到一个节点 `cloud:ops`
 * （docs/24 §2 / §3.3）。App 的嵌入模式固定连它，且没有节点切换。
 */
const COCKPIT_NODE = {
  id: 'cloud:ops',
  kind: 'cloud',
  name: '座舱 DSH',
  status: 'running',
  connectable: true,
  capabilities: CAPABILITIES,
}

/**
 * 座舱节点的「冷启动窗口」（WP56e3 的 e2e）：真 Hub 里座舱容器是 `/admin` 打开时才拉起的，
 * 60–90 秒内 `cloud:ops` 是 `connectable:false`、ticket 请求 409。`blockedUntil` 之前
 * bootstrap 与 ticket 都按不可连接处理；`__test/cockpit-node` 用来开关。
 */
const cockpitNodeHook = { blockedUntil: 0 }
const cockpitNodeConnectable = () => now() >= cockpitNodeHook.blockedUntil

/** `ops_call` 返回「出方案」时 App 该显示的东西（方案 id 与标题固定，e2e 直接断言）。 */
const COCKPIT_PROPOSAL_ID = 12
const COCKPIT_PROPOSAL_JSON = JSON.stringify({
  kind: 'proposal',
  proposal: {
    id: COCKPIT_PROPOSAL_ID,
    sessionId: 's_mock_cockpit',
    title: '给所有用户下发 dsh-memory 0.1.5（下次启动生效）',
    rationale: '插件库里 0.1.5 修了记忆串号，先全量下发，下次启动生效，不打断正在跑的会话。',
    risk: 'R2',
    status: 'pending',
    steps: [
      {
        capability: 'rollouts.plugin',
        args: { pluginId: 7, versionId: 31, targets: 'all', restart: 'next-start' },
        preview: { summary: '影响 8 个用户；其中 2 个实例运行中，下次启动生效' },
      },
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  },
})

/** 座舱回合的正文（短：e2e 只要它到齐 + 方案行出现）。 */
const COCKPIT_REPLY = `我看了一下，这周消耗最多的是 **alice**（1280 分，占 41%），其次是 bob（760 分）。

插件下发我不直接执行，已经出了一张方案：右侧方案卡 #12 等你确认。`

/**
 * 嵌入座舱的「父页面」（WP56d 的 e2e 用）：同源 iframe 嵌 `/m/?embed=cockpit#code=…`，
 * 并把收到的 postMessage 记在 `window.received` 里。与 Hub 前端 `/admin` 的职责一样：
 * 换码 → 写进 iframe 的 URL hash；子页面的 `cockpit.auth-expired` → 再换一个码发回去。
 */
const COCKPIT_PARENT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>座舱父页面（mock）</title>
<style>html,body{margin:0;height:100%;font-family:system-ui}iframe{display:block;width:100%;height:100vh;border:0}</style>
</head>
<body>
<!-- 先空着：由 e2e 调 loadApp(code) 打开（真 Hub 是把带码的地址写进 iframe 的 src） -->
<iframe id="app" title="cockpit" src="about:blank"></iframe>
<script>
  window.received = [];
  window.frameEl = function () { return document.getElementById('app'); };
  window.addEventListener('message', function (event) {
    // 父页面这一侧同样只认同源消息（docs/24 §6）
    if (event.origin !== location.origin) return;
    window.received.push(event.data);
  });
  window.sendToApp = function (message) {
    window.frameEl().contentWindow.postMessage(message, location.origin);
  };
  // 每次都换一个 nonce：只改 fragment 不会让 iframe 重新加载（同文档导航），
  // 那样 App 已经 boot 完、不会再读 hash 里的码。真 Hub 是新建 iframe，天然是一次整页加载。
  //
  // 第二个参数是主题（WP58）：'bridge'（默认，老 e2e 不变）/ 'console' / ''（不传 theme）。
  window.loadApp = function (code, theme) {
    window.received = [];
    var nonce = String(Date.now());
    var mode = typeof theme === 'string' ? theme : 'bridge';
    var themeQuery = mode ? '&theme=' + encodeURIComponent(mode) : '';
    window.frameEl().src =
      '/m/?embed=cockpit' + themeQuery + '&n=' + nonce + (code ? '#code=' + encodeURIComponent(code) : '');
  };
  window.lastOfType = function (type) {
    for (var i = window.received.length - 1; i >= 0; i -= 1) {
      if (window.received[i] && window.received[i].type === type) return window.received[i];
    }
    return null;
  };
</script>
</body>
</html>`

/** 座舱会话的初始内容（App 打开就直接看得到一条方案结果）。 */
const COCKPIT_SEED = [
  {
    sessionId: 's_mock_cockpit',
    title: '本周用量',
    initiator: 'admin',
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 60_000,
    running: false,
    messages: [
      {
        seq: 1,
        role: 'user',
        at: Date.now() - 3_600_000,
        text: '这周谁的积分消耗最多？顺便把要下发的插件事办了。',
      },
      {
        seq: 3,
        role: 'assistant',
        at: Date.now() - 3_590_000,
        text: '这周消耗最多的是 **alice**（1280 分，占 41%）。用量图已投放左舷；插件下发我出了一张方案，右舷方案卡 #12 等你确认。',
        reasoning: '先看用量，再看插件版本；写操作一律出方案，不直接执行。',
      },
    ],
  },
  {
    sessionId: 's_mock_cockpit_ops',
    title: '插件升级',
    initiator: 'ops-lee',
    createdAt: Date.now() - 7_200_000,
    updatedAt: Date.now() - 7_000_000,
    running: false,
    messages: [
      { seq: 1, role: 'user', at: Date.now() - 7_200_000, text: '把 dsh-memory 升到最新版，下次启动生效' },
      {
        seq: 2,
        role: 'assistant',
        at: Date.now() - 7_190_000,
        text: '好的，我先看一眼插件库和当前下发状态。',
      },
    ],
  },
]

const SEED_HISTORY = [
  { seq: 1, role: 'user', at: 1_760_000_000_000, text: '你好，帮我看下今天的计划' },
  {
    seq: 2,
    role: 'assistant',
    at: 1_760_000_001_000,
    text: `# 今天的计划

1. 先跑一遍单元测试
2. 再看一眼接口文档

\`\`\`bash
pnpm test
\`\`\`

需要我直接开始吗？`,
    tools: [],
    reasoning: '用户要的是今天的计划，不是建议清单；先复述已有安排，再问一句是否开始。',
  },
]

/**
 * 长回复（约 516 字、6 个段落）：0.4.7 自适应切段的 e2e 用。
 *
 * 句子 35–42 字。快速率（r≥1）下每段能装 3 句（190 字上下，段数 4），慢速率（r≈0.9）
 * 下 cap=60、每段 1 句（35–42 字，段间停顿 ~1 秒）；首段按 r̂ 在逗号处切成 13 字。
 * 换成别的文本时先用 `planNextSegment` 跑一遍，确认 e2e 的段数与「≥150 字」断言还有意义。
 */
const LONG_REPLY = `明天上午先处理邮件和待办，把积压的事项按紧急程度排一遍序，再留出半小时看昨天的数据。十点开会讨论下个版本的发布节奏，顺便确认测试环境什么时候能空出来，再把联调窗口定好。

中午之前把接口文档补完，重点写清楚重试与超时的约定，避免客户端和服务端各写一套。客户端和服务端对同一件事的理解不一致时，先看文档怎么写，再决定改哪一边，别靠猜。

下午两点开始联调，先跑一遍冒烟用例，再看日志里有没有异常的连接断开和老旧的重连。遇到问题就当场修，修不完的记到看板，别留在脑子里，第二天很容易忘掉细节。联调结束之前把今天的改动过一遍，确认没有漏掉的迁移脚本和没有关掉的调试开关。

四点和产品一起过需求清单，把这一周能做完的和要放到下周的分开，别把时间排得太满。有争议的点先记下来，等数据出来再定，每周固定留半天做技术债，别等到出问题才补。

下班前把今天的改动整理成一份说明，写上风险点和回滚办法，让第二天的人能直接接手。发布之前再检查一次版本号与更新日志，如果发现不对，宁可推迟一天也不要带病上线。

如果一切顺利，晚上把测试报告发出来，顺便把明天要用的数据和环境准备好。明天早上第一件事就是确认夜间任务有没有跑完，这些做完，今天就算收尾了。`

const now = () => Date.now()
const iso = (ms) => new Date(ms).toISOString()
const random = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`

// ── 用户状态 ────────────────────────────────────────────────────────────────

/** 初始会话（新建账号与 /__test/reset 共用；`s_mock_long` 是 0.4.7 自适应切段 e2e 用的长回复）。 */
function seededSessions() {
  return [
    {
      sessionId: 's_mock_plan',
      title: '今天的计划',
      createdAt: now() - 3_600_000,
      updatedAt: now() - 60_000,
      messages: SEED_HISTORY.map((m) => ({ ...m })),
      running: false,
    },
    {
      sessionId: 's_mock_blank',
      title: null,
      createdAt: now() - 600_000,
      updatedAt: now() - 600_000,
      messages: [],
      running: false,
    },
    {
      sessionId: 's_mock_long',
      title: '明天的安排',
      createdAt: now() - 1_800_000,
      updatedAt: now() - 120_000,
      messages: [
        { seq: 1, role: 'user', at: now() - 1_800_000, text: '把明天的安排完整说一遍' },
        {
          seq: 2,
          role: 'assistant',
          at: now() - 1_800_000 + 1_000,
          text: LONG_REPLY,
          tools: [],
        },
      ],
      running: false,
    },
    {
      sessionId: 's_mock_archived',
      title: '上个月的复盘',
      createdAt: now() - 30 * 86_400_000,
      updatedAt: now() - 29 * 86_400_000,
      messages: [
        { seq: 1, role: 'user', at: now() - 30 * 86_400_000, text: '帮我复盘上个月' },
        {
          seq: 2,
          role: 'assistant',
          at: now() - 30 * 86_400_000 + 1000,
          text: '上个月完成了三件事……',
        },
      ],
      running: false,
    },
  ]
}

class UserState {
  constructor(username) {
    this.username = username
    this.displayName = username
    this.instance = 'stopped'
    /** 座舱 DSH 的会话列表（WP56d）：多个管理员共享，行上带发起人；回合里会调 ops_call。 */
    this.cockpit = false
    this.runtimes = new Map()
    this.channels = new Set()
    this.seq = 100
    this.archived = new Set(['s_mock_archived'])
    this.modelSelections = new Map()
    /** fileRef → { name, mimeType, mediaType, bytes, sha256 } */
    this.files = new Map()
    /** sessionId → 已发生的 tool/deliverable 帧（重进会话时补发，模拟 adapter 的 replayHistory） */
    this.events = new Map()
    /** uploadId → { kind, name, mimeType, bytes, chunks, received, sha256, expiresAt } */
    this.uploads = new Map()
    /**
     * 未决交互（WP46 的「常驻会话代理」语义，M6 §1）：**通道断开不清**，
     * 会话行按它给 `pendingInteractions`，重连后的 `session-state` 快照把它带回来。
     * sessionId → [{ agent, callId, questions, state }]
     */
    this.pendingQuestions = new Map()
    /** sessionId → [approval]（只留 state='open' 的） */
    this.pendingApprovals = new Map()
    /** 最近一次 send 带的附件（/__test/status 断言用） */
    this.lastAttachments = null
    /**
     * `/__test/reply` 设的下一条回复（0.4.8）：{ text, plain, tickMs, chunk }。
     * 只对下一条 send 生效，用完即清（默认行为不变）。
     */
    this.replyPlan = null
    /** 最近一次回答的提问（/__test/status 断言用） */
    this.lastAnswers = null
    /** 最近一次审批事件 */
    this.lastApproval = null
    this.ensureFixtures()
    this.sessions = seededSessions()
  }

  modelsPayload(selection) {
    const items = MODEL_CATALOG.groups.flatMap((group) =>
      group.models.map((model) => ({
        provider: group.id,
        model: model.id,
        name: model.name,
        description: model.description ?? null,
        ...(typeof model.multiplier === 'number' ? { multiplier: model.multiplier } : {}),
        efforts: (model.reasoning?.efforts ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
          // shared 的 MobileModelEffort.tier 必填（App 不靠它判断，但契约要全）
          tier:
            e.id === 'off'
              ? 'low'
              : e.id === 'low'
                ? 'medium'
                : e.id === 'high'
                  ? 'high'
                  : e.id === 'max'
                    ? 'ultra'
                    : null,
        })),
        defaultEffort: model.reasoning?.efforts?.length
          ? (model.reasoning.defaultEffort ?? null)
          : null,
        input: { text: true, image: null },
      })),
    )
    const fallback = {
      provider: MODEL_CATALOG.default.provider,
      model: MODEL_CATALOG.default.model,
      ...(MODEL_CATALOG.default.reasoningEffort
        ? { effort: MODEL_CATALOG.default.reasoningEffort }
        : {}),
    }
    return {
      items,
      default: fallback,
      failures: [],
      ...(selection ? { current: selection } : {}),
    }
  }

  /** 两个图片 + 一个大文本：覆盖 file（一次内联）与 file-chunk（分片）两条下载路径。 */
  ensureFixtures() {
    const add = (name, mimeType, mediaType, bytes) => {
      const fileRef = fileRefOf(name)
      this.files.set(fileRef, {
        fileRef,
        name,
        mimeType,
        mediaType,
        bytes,
        sha256: sha256(bytes),
      })
      return fileRef
    }
    this.chartRef = add('chart.png', 'image/png', 'image', makeNoisePng(320, 220, 7))
    this.logoRef = add('logo.png', 'image/png', 'image', makeSolidPng(32, [74, 127, 212]))
    const markdown = Buffer.from(
      `# 导出报告\n\n${'这是一段用于验证分片下载的正文。'.repeat(1200)}\n`,
      'utf8',
    )
    this.notesRef = add('notes.md', 'text/markdown', 'file', markdown)
  }

  findFile(fileRef) {
    return this.files.get(fileRef) ?? null
  }

  recordEvent(sessionId, frame) {
    const list = this.events.get(sessionId) ?? []
    list.push(frame)
    this.events.set(sessionId, list)
  }

  eventsOf(sessionId) {
    return this.events.get(sessionId) ?? []
  }

  getSession(sessionId) {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null
  }

  rows(includeArchived = false) {
    return [...this.sessions]
      .filter((s) => includeArchived || !this.archived.has(s.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.messages.length === 0,
        agentAvailable: true,
        // WP56d：座舱会话的发起人（多个管理员共享同一个会话列表，docs/24 §10 第 4 条）
        ...(typeof s.initiator === 'string' && s.initiator !== '' ? { initiator: s.initiator } : {}),
        // WP46：未决提问+审批数（0 省略）——抽屉/全部会话据此显示「待回答」角标。
        ...(this.pendingInteractionCount(s.sessionId) > 0
          ? { pendingInteractions: this.pendingInteractionCount(s.sessionId) }
          : {}),
        ...(includeArchived ? { archived: this.archived.has(s.sessionId) } : {}),
      }))
  }

  historyPage(sessionId, beforeSeq, limit) {
    const session = this.getSession(sessionId)
    if (!session) return { items: [], nextBeforeSeq: null, cursor: 0, hasMore: false }
    const upto = beforeSeq == null ? Number.MAX_SAFE_INTEGER : beforeSeq
    const filtered = session.messages.filter((m) => m.seq < upto)
    const page = filtered.slice(Math.max(0, filtered.length - limit))
    const hasMore = filtered.length > page.length
    return {
      items: page,
      nextBeforeSeq: hasMore && page.length > 0 ? page[0].seq : null,
      cursor: session.messages.length > 0 ? session.messages[session.messages.length - 1].seq : 0,
      hasMore,
    }
  }

  appendMessage(sessionId, input) {
    const session = this.getSession(sessionId)
    if (!session) return null
    const message = { ...input, seq: ++this.seq }
    session.messages.push(message)
    session.updatedAt = now()
    if (input.role === 'user' && !session.title) session.title = input.text.slice(0, 24)
    return message
  }

  createSession() {
    const session = {
      sessionId: `s_mock_${randomBytes(3).toString('hex')}`,
      title: null,
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      running: false,
    }
    this.sessions.unshift(session)
    return session
  }

  startTurn(sessionId, channel, text = '') {
    const session = this.getSession(sessionId)
    if (!session) return
    const existing = this.runtimes.get(sessionId)
    if (existing) this.finishTurn(existing, 'cancelled')
    // 0.4.8：`POST /__test/reply` 可以对**下一条**回复定制长度/速度；用完即清（默认不变）
    const plan = this.replyPlan
    this.replyPlan = null
    const runtime = {
      sessionId,
      attemptId: `att_${randomBytes(4).toString('hex')}`,
      revision: 1,
      target: plan?.text ?? (this.cockpit ? COCKPIT_REPLY : MOCK_REPLY),
      delivered: 0,
      index: 0,
      // 座舱回合不铺长思考：直接出工具（方案）再给结论，e2e 与真机都更快看到结果
      reasoning: plan?.plain || this.cockpit
        ? ''
        : LONG_THINK_MARK.test(String(text))
          ? LONG_THINK_REASONING
          : MOCK_REASONING,
      // 只发正文的场景（0.4.8 发送锚定 e2e：回复长度/时间可控，且没有工具卡干扰高度）
      plain: plan?.plain === true,
      // 每拍发几个字：默认 1（与以前一致）
      chunk: Number.isFinite(plan?.chunk) && plan.chunk > 0 ? Math.floor(plan.chunk) : 1,
      tickMs: Number.isFinite(plan?.tickMs) && plan.tickMs > 0 ? plan.tickMs : TICK_MS,
      reasoningSent: 0,
      reasoningDone: false,
      ticks: 0,
      searchStarted: false,
      searchEnded: false,
      pythonStarted: false,
      pythonEnded: false,
      deliverableSent: false,
      // 0.4.0 §2 的端到端场景：提示词里带标记时按「思考 → 工具 → 再思考 → 正文」走。
      // WP56d：座舱会话的每一轮都会调一次 ops_call（出方案），用来验证过程行的「方案 #N」。
      scenario: plan?.plain
        ? 'plain'
        : this.cockpit
          ? 'cockpit'
          : PROCESS_SCENARIO_MARK.test(String(text))
            ? 'process-row'
            : 'default',
      stage: 0,
      stageTicks: 0,
      cockpitCallId: `call_ops_${randomBytes(3).toString('hex')}`,
      searchCallId: `call_search_${randomBytes(3).toString('hex')}`,
      pythonCallId: `call_python_${randomBytes(3).toString('hex')}`,
      presentCallId: `call_present_${randomBytes(3).toString('hex')}`,
      timer: null,
      listeners: new Set([channel]),
      stopped: false,
    }
    this.runtimes.set(sessionId, runtime)
    session.running = true
    // running 变化 = 快照时机之一（M6 §2.2.2）
    this.broadcastSessionState(sessionId)
    runtime.timer = setInterval(() => this.tick(runtime), runtime.tickMs)
    runtime.timer.unref?.()
  }

  /** 发一条工具帧并记入 replay 队列（模拟 adapter 的 replayHistory）。 */
  emitTool(runtime, frame) {
    const full = {
      v: PROTOCOL_VERSION,
      type: 'tool',
      sessionId: runtime.sessionId,
      turn: 1,
      step: 1,
      ...frame,
    }
    this.recordEvent(runtime.sessionId, full)
    for (const channel of runtime.listeners) sendFrame(channel, full)
  }

  startSearchTool(runtime) {
    if (runtime.searchStarted) return
    runtime.searchStarted = true
    this.emitTool(runtime, {
      callId: runtime.searchCallId,
      kind: 'search',
      name: 'web_search',
      phase: 'start',
      seq: ++this.seq,
      status: 'running',
      title: '搜索网页',
      inputPreview: MOCK_SEARCH_QUERY,
      inputBytes: Buffer.byteLength(MOCK_SEARCH_QUERY, 'utf8'),
      truncated: { input: true },
    })
  }

  endSearchTool(runtime) {
    if (!runtime.searchStarted || runtime.searchEnded) return
    runtime.searchEnded = true
    const output = MOCK_CITATIONS.map((item, index) => `${index + 1}. ${item.title}`).join('\n')
    this.emitTool(runtime, {
      callId: runtime.searchCallId,
      kind: 'search',
      name: 'web_search',
      phase: 'end',
      seq: ++this.seq,
      status: 'ok',
      title: '搜索网页',
      outputPreview: output,
      outputBytes: Buffer.byteLength(output, 'utf8'),
      citations: MOCK_CITATIONS,
      durationMs: 860,
    })
  }

  runPythonTool(runtime) {
    if (runtime.pythonStarted) return
    runtime.pythonStarted = true
    this.emitTool(runtime, {
      callId: runtime.pythonCallId,
      kind: 'python',
      name: 'python',
      phase: 'start',
      seq: ++this.seq,
      status: 'running',
      title: '运行 Python',
      inputPreview: 'import math\nprint(round(math.sin(1), 3))',
      inputBytes: 49,
    })
    runtime.pythonEnded = true
    this.emitTool(runtime, {
      callId: runtime.pythonCallId,
      kind: 'python',
      name: 'python',
      phase: 'end',
      seq: ++this.seq,
      status: 'ok',
      title: '运行 Python',
      outputPreview: '0.841\n',
      outputBytes: 6,
      durationMs: 42,
    })
  }

  emitDeliverable(runtime) {
    if (runtime.deliverableSent) return
    runtime.deliverableSent = true
    const files = [this.chartRef, this.logoRef, this.notesRef]
      .map((ref) => this.files.get(ref))
      .filter(Boolean)
      .map((file) => ({
        fileRef: file.fileRef,
        name: file.name,
        pathLabel: `outputs/${file.name}`,
        mediaType: file.mediaType,
        mimeType: file.mimeType,
        bytes: file.bytes.length,
      }))
    const frame = {
      v: PROTOCOL_VERSION,
      type: 'deliverable',
      sessionId: runtime.sessionId,
      seq: ++this.seq,
      turn: 1,
      callId: runtime.presentCallId,
      files,
    }
    this.recordEvent(runtime.sessionId, frame)
    for (const channel of runtime.listeners) sendFrame(channel, frame)
  }

  tick(runtime) {
    if (runtime.stopped) return
    runtime.ticks += 1
    const send = (frame) => {
      for (const channel of runtime.listeners) sendFrame(channel, { v: PROTOCOL_VERSION, ...frame })
    }

    // 0.4.0 §2 场景：思考 → 工具 → 再思考 → 正文（验证过程行位置与 key 不变）
    if (runtime.scenario === 'process-row') {
      this.tickProcessRow(runtime, send)
      return
    }

    // WP56d 场景：座舱回合 = 调一次 ops_call（出方案）→ 正文
    if (runtime.scenario === 'cockpit') {
      this.tickCockpit(runtime, send)
      return
    }

    // 0.4.8：只发正文（发送锚定 e2e 用：回复长度/时间可控，没有工具卡/交付物干扰高度）
    if (runtime.scenario === 'plain') {
      if (runtime.delivered >= runtime.target.length) {
        this.finishTurn(runtime, 'completed')
        return
      }
      const piece = runtime.target.slice(runtime.delivered, runtime.delivered + runtime.chunk)
      runtime.delivered += piece.length
      send({
        type: 'delta',
        sessionId: runtime.sessionId,
        attemptId: runtime.attemptId,
        revision: runtime.revision,
        index: runtime.index++,
        turn: 1,
        step: 1,
        part: { kind: 'text', text: piece },
      })
      return
    }

    // 1) 先想：每 6 拍发一小段 reasoning（真实增量是逐块到达、持续数秒的；
    //    这里放慢是为了让「思考中 -> 正文开始后收起」这个可见状态持续足够久，e2e 才抓得住）
    if (runtime.reasoningSent < runtime.reasoning.length) {
      if (runtime.ticks % 6 !== 0) return
      const piece = runtime.reasoning.slice(runtime.reasoningSent, runtime.reasoningSent + 28)
      runtime.reasoningSent += piece.length
      send({
        type: 'delta',
        sessionId: runtime.sessionId,
        attemptId: runtime.attemptId,
        revision: runtime.revision,
        index: runtime.index++,
        turn: 1,
        step: 1,
        part: { kind: 'reasoning', text: piece },
      })
      if (runtime.reasoningSent >= runtime.reasoning.length && !runtime.reasoningDone) {
        runtime.reasoningDone = true
        // 与真实 adapter 一致：结束帧**没有 text**，只有 done:true
        send({
          type: 'delta',
          sessionId: runtime.sessionId,
          attemptId: runtime.attemptId,
          revision: runtime.revision,
          index: runtime.index++,
          turn: 1,
          step: 1,
          part: { kind: 'reasoning' },
          done: true,
        })
        // 与真实 Host 一致：思考完成的这一步单独落一条 assistant/message（text 为空、只带思考），
        // 工具卡随后到达时思考框仍留在时间线上（真机 2026-10-27 的排列需求）。
        const step = this.appendMessage(runtime.sessionId, {
          role: 'assistant',
          at: now(),
          text: '',
          reasoning: runtime.reasoning,
        })
        runtime.reasoning = ''
        for (const channel of runtime.listeners) {
          sendFrame(channel, {
            v: PROTOCOL_VERSION,
            type: 'message',
            sessionId: runtime.sessionId,
            seq: step.seq,
            role: 'assistant',
            at: step.at,
            text: '',
          })
        }
        // 下一步是新 attempt：旧 attemptId 已被客户端标记结束，继续用会被丢弃。
        runtime.attemptId = `att_${randomBytes(4).toString('hex')}`
        runtime.revision = 1
        runtime.index = 0
      }
      return
    }

    // 2) 搜索工具：一开始就起，正文推进到 25% 时收尾
    this.startSearchTool(runtime)
    const progress = runtime.delivered / runtime.target.length
    if (progress >= 0.25) this.endSearchTool(runtime)
    if (progress >= 0.55) this.runPythonTool(runtime)

    if (runtime.delivered >= runtime.target.length) {
      this.emitDeliverable(runtime)
      this.finishTurn(runtime, 'completed')
      return
    }
    const char = runtime.target[runtime.delivered]
    runtime.delivered += 1
    send({
      type: 'delta',
      sessionId: runtime.sessionId,
      attemptId: runtime.attemptId,
      revision: runtime.revision,
      index: runtime.index++,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: char },
    })
  }

  /**
   * 一轮座舱回合要调的工具（docs/24 §1/§6）：
   * `canvas_show` ×3（左、左、右）+ `ops_call` 出方案 —— App 的过程行应该显示四行：
   * 「⟶ 已投放左舷：近 7 天积分消耗」「⟶ 已投放左舷：Top 5 用户」
   * 「⟶ 已投放右舷：下发进度 #88」「⟶ 方案 #12 · 待确认（右舷）」。
   */
  cockpitSteps(runtime) {
    if (runtime.cockpitStepList) return runtime.cockpitStepList
    const canvasStep = (index, placement, title, specKind) => {
      const item = {
        id: `cv_mock_${String(index)}`,
        sessionId: runtime.sessionId,
        title,
        spec: { kind: specKind, placement },
        placement,
        pinned: false,
        order: index - 1,
        origin: 'dsh',
        createdAt: iso(now()),
        updatedAt: iso(now()),
      }
      const preview = JSON.stringify(item)
      return {
        start: {
          callId: `call_canvas_${String(index)}`,
          kind: 'other',
          name: 'canvas_show',
          phase: 'start',
          status: 'running',
          title: '投放画布',
          inputPreview: JSON.stringify({ title, placement, spec: { kind: specKind, placement } }),
        },
        end: {
          callId: `call_canvas_${String(index)}`,
          kind: 'other',
          name: 'canvas_show',
          phase: 'end',
          status: 'ok',
          title: '投放画布',
          outputPreview: preview,
          outputBytes: Buffer.byteLength(preview, 'utf8'),
          durationMs: 40,
        },
      }
    }
    runtime.cockpitStepList = [
      canvasStep(1, 'left', '近 7 天积分消耗', 'chart'),
      canvasStep(2, 'left', 'Top 5 用户', 'table'),
      canvasStep(3, 'right', '下发进度 #88', 'job'),
      {
        start: {
          callId: runtime.cockpitCallId,
          kind: 'other',
          name: 'ops_call',
          phase: 'start',
          status: 'running',
          title: '调用座舱能力',
          inputPreview: JSON.stringify({
            capability: 'rollouts.plugin',
            args: { pluginId: 7, versionId: 31, targets: 'all', restart: 'next-start' },
          }),
        },
        end: {
          callId: runtime.cockpitCallId,
          kind: 'other',
          name: 'ops_call',
          phase: 'end',
          status: 'ok',
          title: '调用座舱能力',
          outputPreview: COCKPIT_PROPOSAL_JSON,
          outputBytes: Buffer.byteLength(COCKPIT_PROPOSAL_JSON, 'utf8'),
          durationMs: 320,
        },
      },
    ]
    return runtime.cockpitStepList
  }

  /**
   * 座舱回合（WP56d）：逐个调工具（每个先 start、两拍后 end），最后流式给正文。
   *
   * 帧形状与真实 adapter 一致（`tool` start / end；`outputPreview` 是工具结果的 JSON），
   * App 的过程行据此渲染「⟶ 已投放…」与「⟶ 方案 #12 · 待确认（右舷）」。
   */
  tickCockpit(runtime, send) {
    runtime.stageTicks += 1
    const steps = this.cockpitSteps(runtime)
    if (runtime.stage < steps.length) {
      const step = steps[runtime.stage]
      if (!step.started) {
        step.started = true
        this.emitTool(runtime, { ...step.start, seq: ++this.seq })
        runtime.stageTicks = 0
        return
      }
      if (runtime.stageTicks < 2) return
      this.emitTool(runtime, { ...step.end, seq: ++this.seq })
      runtime.stage += 1
      runtime.stageTicks = 0
      return
    }
    // 工具调完：正文逐字流出（正文永远在过程行下方）
    if (runtime.delivered >= runtime.target.length) {
      this.finishTurn(runtime, 'completed')
      return
    }
    const chunk = runtime.target.slice(runtime.delivered, runtime.delivered + 3)
    runtime.delivered += chunk.length
    send({
      type: 'delta',
      sessionId: runtime.sessionId,
      attemptId: runtime.attemptId,
      revision: runtime.revision,
      index: runtime.index++,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: chunk },
    })
  }

  /**
   * 「思考 → 工具 → 再思考 → 正文」的回合脚本（0.4.0 §2 的 e2e/截图用）。
   *
   * 每个阶段都留出足够的时间让探针采样（默认 TICK_MS=12 时每阶段约 0.3–0.6s）：
   * 阶段 0/2 的思考分成小块发（真实增量就是这样），块结束发 done 帧并落一条
   * 「只有思考」的 assistant 消息（与真实 Host 一致）。
   */
  tickProcessRow(runtime, send) {
    const emitReasoning = (text, done = false) => {
      send({
        type: 'delta',
        sessionId: runtime.sessionId,
        attemptId: runtime.attemptId,
        revision: runtime.revision,
        index: runtime.index++,
        turn: 1,
        step: 1,
        part: done ? { kind: 'reasoning' } : { kind: 'reasoning', text },
        ...(done ? { done: true } : {}),
      })
    }
    const persistReasoning = (text) => {
      const step = this.appendMessage(runtime.sessionId, {
        role: 'assistant',
        at: now(),
        text: '',
        reasoning: text,
      })
      send({
        type: 'message',
        sessionId: runtime.sessionId,
        seq: step.seq,
        role: 'assistant',
        at: step.at,
        text: '',
      })
      // 新的一步 = 新 attempt（旧 attemptId 已被客户端标记结束）
      runtime.attemptId = `att_${randomBytes(4).toString('hex')}`
      runtime.revision = 1
      runtime.index = 0
    }
    const streamReasoning = (text, nextStage) => {
      if (runtime.stageTicks % 2 !== 0) return
      const piece = text.slice(runtime.reasoningSent, runtime.reasoningSent + 16)
      runtime.reasoningSent += piece.length
      if (piece !== '') emitReasoning(piece)
      if (runtime.reasoningSent < text.length) return
      emitReasoning('', true)
      persistReasoning(text)
      runtime.stage = nextStage
      runtime.stageTicks = 0
      runtime.reasoningSent = 0
    }

    runtime.stageTicks += 1
    if (runtime.stage === 0) {
      // 先停 8 拍：让「回合刚开始、还没有任何事件」的占位行也被探针看到
      if (runtime.stageTicks <= 8) return
      streamReasoning(PROCESS_REASONING_1, 1)
      return
    }
    if (runtime.stage === 1) {
      // 搜索工具：起 → 40 拍后结束（带来源，摘要是「搜索了 3 个网页」）
      if (!runtime.searchStarted) {
        this.startSearchTool(runtime)
        return
      }
      if (!runtime.searchEnded && runtime.stageTicks >= 40) {
        this.endSearchTool(runtime)
        runtime.stage = 2
        runtime.stageTicks = 0
      }
      return
    }
    if (runtime.stage === 2) {
      if (runtime.stageTicks <= 8) return
      streamReasoning(PROCESS_REASONING_2, 3)
      return
    }
    // 阶段 3：正文逐字流出（正文永远在过程行下方）
    if (runtime.delivered >= runtime.target.length) {
      this.finishTurn(runtime, 'completed')
      return
    }
    const chunk = runtime.target.slice(runtime.delivered, runtime.delivered + 3)
    runtime.delivered += chunk.length
    send({
      type: 'delta',
      sessionId: runtime.sessionId,
      attemptId: runtime.attemptId,
      revision: runtime.revision,
      index: runtime.index++,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: chunk },
    })
  }

  finishTurn(runtime, reason) {
    if (runtime.timer) clearInterval(runtime.timer)
    runtime.timer = null
    this.runtimes.delete(runtime.sessionId)
    // 收尾时补齐没发过的工具/交付物帧（停止的回合也要让用户看到已经发生的步骤）
    this.endSearchTool(runtime)
    // process-row / plain 两种场景都不发工具卡与交付物（0.4.8 的锚定 e2e 靠这个控制高度）
    const toolFreeTurn = runtime.scenario === 'process-row' || runtime.scenario === 'plain'
    if (!toolFreeTurn && runtime.delivered > runtime.target.length * 0.55) this.runPythonTool(runtime)
    if (reason === 'completed' && !toolFreeTurn) this.emitDeliverable(runtime)
    const session = this.getSession(runtime.sessionId)
    if (session) {
      session.running = false
      const text = runtime.target.slice(0, runtime.delivered)
      if (text.trim()) {
        const message = this.appendMessage(runtime.sessionId, {
          role: 'assistant',
          at: now(),
          text,
          ...(runtime.reasoning ? { reasoning: runtime.reasoning } : {}),
        })
        if (this.cockpit) {
          // 真链路证据：回合真的产出了助手回复（e2e 与 turns 按 sessionId + 时间对上）
          pushCockpitEvidence(cockpitStats.replies, {
            at: message.at,
            sessionId: runtime.sessionId,
            reason,
            text,
          })
        }
        for (const channel of runtime.listeners) {
          sendFrame(channel, {
            v: PROTOCOL_VERSION,
            type: 'message',
            sessionId: runtime.sessionId,
            seq: message.seq,
            role: 'assistant',
            at: message.at,
            text: message.text,
          })
        }
      }
      session.updatedAt = now()
    }
    for (const channel of runtime.listeners) {
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'turn',
        sessionId: runtime.sessionId,
        phase: 'end',
        turn: 1,
        reason,
      })
    }
    runtime.listeners.clear()
    // 回合结束（含被停止）= 快照时机之一
    this.broadcastSessionState(runtime.sessionId)
  }

  stopTurn(sessionId) {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    runtime.stopped = true
    this.finishTurn(runtime, 'cancelled')
    return true
  }

  // ── WP46：未决交互与 session-state 快照 ────────────────────────────────

  /** 这个会话还没结算的提问 + 审批数（会进行里也照算）。 */
  pendingInteractionCount(sessionId) {
    const questions = this.pendingQuestions.get(sessionId) ?? []
    const approvals = (this.pendingApprovals.get(sessionId) ?? []).filter((item) => item.state === 'open')
    return questions.length + approvals.length
  }

  pendingQuestionsOf(sessionId) {
    return (this.pendingQuestions.get(sessionId) ?? []).map((item) => ({ ...item }))
  }

  pendingApprovalsOf(sessionId) {
    return (this.pendingApprovals.get(sessionId) ?? [])
      .filter((item) => item.state === 'open')
      .map((item) => ({ ...item }))
  }

  /** 暂存一条未决提问（通道断开也留着；重连后快照带回）。 */
  parkQuestion(sessionId, question) {
    const list = this.pendingQuestions.get(sessionId) ?? []
    this.pendingQuestions.set(sessionId, [
      ...list.filter((item) => item.callId !== question.callId),
      question,
    ])
  }

  settleQuestion(sessionId, callId) {
    const list = this.pendingQuestions.get(sessionId) ?? []
    const next = list.filter((item) => item.callId !== callId)
    if (next.length === 0) this.pendingQuestions.delete(sessionId)
    else this.pendingQuestions.set(sessionId, next)
  }

  parkApproval(sessionId, approval) {
    const list = this.pendingApprovals.get(sessionId) ?? []
    this.pendingApprovals.set(sessionId, [
      ...list.filter((item) => item.approvalId !== approval.approvalId),
      approval,
    ])
  }

  settleApproval(sessionId, approvalId) {
    const list = this.pendingApprovals.get(sessionId) ?? []
    const next = list.filter((item) => item.approvalId !== approvalId)
    if (next.length === 0) this.pendingApprovals.delete(sessionId)
    else this.pendingApprovals.set(sessionId, next)
  }

  /** 一份权威快照（M6 §2.1）。`requestId` 只在回 `session-state-request` 时带。 */
  sessionStateFrame(sessionId, requestId) {
    const session = this.getSession(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const last = session && session.messages.length > 0 ? session.messages[session.messages.length - 1] : null
    return {
      v: PROTOCOL_VERSION,
      type: 'session-state',
      ...(requestId ? { requestId } : {}),
      sessionId,
      cursor: last ? last.seq : null,
      // 回合态权威位：有 runtime 就是在跑（stop 之后 runtime 已被清掉）。
      running: !!runtime,
      attemptId: runtime ? runtime.attemptId : null,
      questions: this.pendingQuestionsOf(sessionId),
      approvals: this.pendingApprovalsOf(sessionId),
      at: iso(now()),
    }
  }

  /** 把快照推给「订阅了这个会话、且协商了 session-state」的通道（running/未决集合变化时发）。 */
  broadcastSessionState(sessionId) {
    for (const channel of this.channels) {
      if (!channel.subscriptions.has(sessionId)) continue
      if (!(channel.features ?? []).includes('session-state')) continue
      channel.deliver(this.sessionStateFrame(sessionId))
    }
  }

  attachRuntime(sessionId, channel) {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    runtime.listeners.add(channel)
    sendFrame(channel, {
      v: PROTOCOL_VERSION,
      type: 'assistant-baseline',
      sessionId,
      attemptId: runtime.attemptId,
      revision: runtime.revision,
      nextIndex: runtime.delivered,
      text: runtime.target.slice(0, runtime.delivered),
    })
  }

  wake() {
    if (this.instance === 'running') return 'running'
    if (this.instance === 'stopped') {
      this.instance = 'starting'
      const timer = setTimeout(() => {
        this.instance = 'running'
      }, WAKE_MS)
      timer.unref?.()
    }
    return this.instance
  }

  reset() {
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer)
    }
    this.runtimes.clear()
    this.instance = 'stopped'
    this.seq = 100
    this.archived = new Set(['s_mock_archived'])
    this.modelSelections.clear()
    this.pendingQuestions.clear()
    this.pendingApprovals.clear()
    this.uploads.clear()
    this.events.clear()
    this.lastAttachments = null
    this.replyPlan = null
    this.files.clear()
    this.ensureFixtures()
    this.sessions = seededSessions()
  }

  modelsPayload(selection) {
    const items = MODEL_CATALOG.groups.flatMap((group) =>
      group.models.map((model) => ({
        provider: group.id,
        model: model.id,
        name: model.name,
        description: model.description ?? null,
        ...(typeof model.multiplier === 'number' ? { multiplier: model.multiplier } : {}),
        efforts: (model.reasoning?.efforts ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
          // shared 的 MobileModelEffort.tier 必填（App 不靠它判断，但契约要全）
          tier:
            e.id === 'off'
              ? 'low'
              : e.id === 'low'
                ? 'medium'
                : e.id === 'high'
                  ? 'high'
                  : e.id === 'max'
                    ? 'ultra'
                    : null,
        })),
        defaultEffort: model.reasoning?.efforts?.length
          ? (model.reasoning.defaultEffort ?? null)
          : null,
        input: { text: true, image: null },
      })),
    )
    const fallback = {
      provider: MODEL_CATALOG.default.provider,
      model: MODEL_CATALOG.default.model,
      ...(MODEL_CATALOG.default.reasoningEffort
        ? { effort: MODEL_CATALOG.default.reasoningEffort }
        : {}),
    }
    // shared 的 models 帧把 failures 定为必填（拿不到模型的 provider 列表，可为空）；
    // 少了它 App 侧 zod 解析会整帧丢掉（真机不会，但 mock 自己也必须给全）。
    return { items, default: fallback, failures: [], ...(selection ? { current: selection } : {}) }
  }
}

const users = new Map()
function userFor(username) {
  if (!users.has(username)) users.set(username, new UserState(username))
  return users.get(username)
}

/**
 * 座舱 DSH（WP56d）：系统账号 `hub-ops` 的状态。
 *
 * 只有一个真实用例，所以单独缓存一份：实例恒 running（docs/24 §5：不参与空闲回收），
 * 会话列表是**多个管理员共享**的（行上带发起人），并且每轮都会调 `ops_call`。
 */
const cockpitUsers = new Map()

function cockpitUser() {
  const key = 'hub-ops'
  if (cockpitUsers.has(key)) return cockpitUsers.get(key)
  const user = new UserState(key)
  user.displayName = '座舱 DSH'
  user.instance = 'running'
  user.cockpit = true
  user.archived = new Set()
  user.sessions = COCKPIT_SEED.map((seed) => ({ ...seed, messages: seed.messages.map((m) => ({ ...m })) }))
  // 已经发生过的工具帧：重进会话时（subscribe → replay）补发，App 一打开就能看到「方案 #12」。
  const start = {
    v: PROTOCOL_VERSION,
    type: 'tool',
    sessionId: 's_mock_cockpit',
    turn: 1,
    step: 1,
    callId: 'call_ops_seed',
    kind: 'other',
    name: 'ops_call',
    phase: 'start',
    seq: 2,
    status: 'running',
    title: '调用座舱能力',
    inputPreview: JSON.stringify({ capability: 'rollouts.plugin', args: { pluginId: 7 } }),
  }
  const end = {
    ...start,
    phase: 'end',
    status: 'ok',
    seq: 3,
    outputPreview: COCKPIT_PROPOSAL_JSON,
    outputBytes: Buffer.byteLength(COCKPIT_PROPOSAL_JSON, 'utf8'),
    durationMs: 320,
  }
  // 一张已投放的卡（左舷）：重进会话时过程行里也应该有「⟶ 已投放左舷：…」
  const canvasPreview = JSON.stringify({
    id: 'cv_seed_1',
    sessionId: 's_mock_cockpit',
    title: '近 7 天积分消耗',
    spec: { kind: 'chart', placement: 'left' },
    placement: 'left',
    pinned: false,
    order: 0,
    origin: 'dsh',
    createdAt: iso(now()),
    updatedAt: iso(now()),
  })
  user.recordEvent('s_mock_cockpit', {
    v: PROTOCOL_VERSION,
    type: 'tool',
    sessionId: 's_mock_cockpit',
    turn: 1,
    step: 1,
    callId: 'call_canvas_seed',
    kind: 'other',
    name: 'canvas_show',
    phase: 'end',
    seq: 2,
    status: 'ok',
    title: '投放画布',
    outputPreview: canvasPreview,
    outputBytes: Buffer.byteLength(canvasPreview, 'utf8'),
  })
  user.recordEvent('s_mock_cockpit', start)
  user.recordEvent('s_mock_cockpit', end)
  user.seq = 200
  cockpitUsers.set(key, user)
  return user
}

// token → { kind:'access'|'refresh', username, deviceId, scope? }
const tokens = new Map()
// ticket → { username, nodeId, expiresAt, scope? }
const tickets = new Map()
// 交接码 → { username, expiresAt, used }（WP56d；一次性、60 秒）
const cockpitCodes = new Map()
/**
 * e2e 断言用：换过几次码、成没成功（不进产品路径）。
 *
 * WP56e3 起还记通道侧的证据，让 e2e 能断言「消息真的经 WS 通道发到 Hub、回合真的产生了
 * 助手回复」，而不是只看 iframe 里的 UI 状态：
 *  - `bootstraps`：每次座舱 bootstrap 当时的 `connectable`（冷启动窗口的证据）；
 *  - `tickets`：ticket 请求（成/败与时间，真链路 bug「App 从不发起通道连接」的直接证据）；
 *  - `turns`：经通道收到的 `send` 帧；
 *  - `replies`：回合结束时落库的助手回复。
 */
const cockpitStats = {
  exchanges: [],
  handoffs: 0,
  bootstraps: [],
  tickets: [],
  turns: [],
  replies: [],
}
/** 数组只留最近 N 条（e2e 一次跑几十条，够用且不让状态接口越来越大）。 */
const KEEP_COCKPIT_EVIDENCE = 60
function pushCockpitEvidence(list, item) {
  list.push(item)
  if (list.length > KEEP_COCKPIT_EVIDENCE) list.splice(0, list.length - KEEP_COCKPIT_EVIDENCE)
}

function issueTokens(username, extra = {}) {
  // 令牌格式必须满足 shared 契约（App 会按 schema 校验）。
  const deviceId = `dv_${randomBytes(16).toString('hex')}`
  const accessToken = `dshm_at_${randomBytes(20).toString('hex')}`
  const refreshToken = `dshm_rt_${randomBytes(20).toString('hex')}`
  const record = { username, deviceId, ...(extra.scope ? { scope: extra.scope } : {}) }
  tokens.set(accessToken, { kind: 'access', ...record })
  tokens.set(refreshToken, { kind: 'refresh', ...record })
  return {
    accessToken,
    accessExpiresAt: iso(now() + 3_600_000),
    refreshToken,
    refreshExpiresAt: iso(now() + 60 * 86_400_000),
    deviceId,
    user: { id: 1, username, displayName: username },
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.scope === 'cockpit' ? { platform: 'web' } : {}),
  }
}

/** 发一个一次性交接码（模拟 `POST /api/admin/cockpit/handoff`，60 秒）。 */
function issueCockpitCode(username = 'admin') {
  const code = `hc_${randomBytes(12).toString('hex')}`
  cockpitCodes.set(code, { username, expiresAt: now() + 60_000, used: false })
  cockpitStats.handoffs += 1
  return { code, expiresAt: iso(now() + 60_000) }
}

/** 取一个**没用过**的交接码记录；无效/用过/过期一律 null。 */
function takeCockpitCode(raw) {
  const code = String(raw ?? '').trim()
  const record = cockpitCodes.get(code)
  if (!record) return null
  if (record.used || record.expiresAt < now()) return null
  record.used = true
  return record
}

function bearerOf(req) {
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  const record = tokens.get(token)
  return record && record.kind === 'access' ? record : null
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────

function withCors(req, res) {
  const origin = req.headers.origin
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-DSH-Client')
  // 朗读响应的采样率/音色在自定义头里：跨域（vite :5260 → hub :5259）必须显式暴露，
  // 否则 fetch 读不到 x-tts-sample-rate / x-tts-voice（真 Hub 同源，没这个问题）
  res.setHeader(
    'Access-Control-Expose-Headers',
    'x-tts-sample-rate, x-tts-voice, x-tts-format, x-tts-cached',
  )
  res.setHeader('Access-Control-Max-Age', '600')
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 读原始请求体（语音上传用）；超过 `limit` 返回 null（由调用方回 413）。 */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 是不是 16kHz 单声道 16bit 的 WAV（只认 RIFF/WAVE + fmt/data 的字段）。 */
function parseWavHeader(buffer) {
  if (!buffer || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return null
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bitsPerSample = buffer.readUInt16LE(34)
  const dataTag = buffer.toString('ascii', 36, 40)
  if (dataTag !== 'data') return null
  const dataBytes = buffer.readUInt32LE(40)
  if (dataBytes === 0 || dataBytes + 44 > buffer.length) return null
  return { channels, sampleRate, bitsPerSample, dataBytes }
}

function wavDurationMs(info) {
  return Math.max(0, Math.round((info.dataBytes / (info.sampleRate * info.channels * 2)) * 1_000))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) throw new Error('body too large')
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ── 通道 ────────────────────────────────────────────────────────────────────

class Channel {
  constructor(ws, user) {
    this.ws = ws
    this.user = user
    this.subscriptions = new Set()
    this.closed = false
    user.channels.add(this)
  }

  deliver(frame) {
    if (this.closed) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      /* socket 已关 */
    }
  }

  close(code = 1000) {
    if (this.closed) return
    this.closed = true
    this.user.channels.delete(this)
    try {
      this.ws.close(code)
    } catch {
      /* ignore */
    }
  }
}

function sendFrame(channel, frame) {
  channel.deliver(frame)
}

function handleClientFrame(channel, frame) {
  const user = channel.user
  switch (frame.type) {
    case 'hello': {
      const declared = Array.isArray(frame.features) ? frame.features : undefined
      const features = declared
        ? declared.filter((feature) => SUPPORTED_FEATURES.includes(feature))
        : undefined
      channel.features = features ?? []
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'hello',
        requestId: frame.requestId,
        node: {
          id: 'cloud:self',
          kind: 'cloud',
          name: '云服务器',
          status: user.instance,
        },
        capabilities: CAPABILITIES,
        capabilitiesV2: CAPABILITIES_V2,
        subscribed: [...channel.subscriptions],
        serverTime: now(),
        ...(features && features.length > 0 ? { features } : {}),
      })
      return
    }
    case 'models': {
      const selection = frame.sessionId ? user.modelSelections.get(frame.sessionId) ?? null : null
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'models',
        requestId: frame.requestId,
        ...user.modelsPayload(selection),
      })
      return
    }
    case 'set-model': {
      const selection = {
        provider: frame.provider,
        model: frame.model,
        ...(frame.effort ? { effort: frame.effort } : {}),
      }
      user.modelSelections.set(frame.sessionId, selection)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'model-changed',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        ...selection,
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'state',
        sessionId: frame.sessionId,
        key: 'modelSelection',
        value: {
          lastUsed: { ...selection, reasoningEffort: selection.effort ?? 'high' },
          next: { ...selection, reasoningEffort: selection.effort ?? 'high' },
        },
        seq: null,
      })
      return
    }
    case 'session-state-request': {
      if (!(channel.features ?? []).includes('session-state')) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'feature-unsupported',
          message: '当前后端不支持会话快照',
          retryable: false,
        })
        return
      }
      sendFrame(channel, user.sessionStateFrame(frame.sessionId, frame.requestId))
      return
    }
    case 'usage': {
      // 会话用量：按 mock 数据确定性算一份（契约 stats 字段与真实 adapter 一致）
      const session = user.getSession(frame.sessionId)
      const messages = session ? session.messages : []
      const assistants = messages.filter((m) => m.role === 'assistant')
      const askers = messages.filter((m) => m.role === 'user')
      const outputChars = assistants.reduce((n, m) => n + (m.text ?? '').length, 0)
      const outputTokens = Math.round(outputChars / 2.2)
      const inputTokens = assistants.length * 1200 + askers.length * 40
      const cacheReadTokens = assistants.length * 800
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'usage',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        stats: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens,
          cacheReadTokens,
          assistantMessages: assistants.length,
          userMessages: askers.length,
          turns: assistants.length,
          truncated: false,
          // 与 Hub 计费同口径的确定性估算（DeepSeek Flash · upstream-c）：微积分
          pointsMicro: Math.round(
            inputTokens * 0.1 + outputTokens * 0.4 + cacheReadTokens * 0.002,
          ),
          pointsEstimated: false,
        },
      })
      return
    }
    case 'sessions':
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'sessions',
        requestId: frame.requestId,
        items: user.rows(frame.includeArchived === true),
      })
      return
    case 'history': {
      const page = user.historyPage(frame.sessionId, frame.beforeSeq ?? null, frame.limit ?? 30)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'history',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        items: page.items,
        nextBeforeSeq: page.nextBeforeSeq,
        cursor: page.cursor,
        hasMore: page.hasMore,
      })
      return
    }
    case 'create': {
      const session = user.createSession()
      const selection =
        frame.provider && frame.model
          ? {
              provider: frame.provider,
              model: frame.model,
              ...(frame.effort ? { effort: frame.effort } : {}),
            }
          : null
      if (selection) user.modelSelections.set(session.sessionId, selection)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'created',
        requestId: frame.requestId,
        sessionId: session.sessionId,
        ...(frame.preset ? { preset: frame.preset } : {}),
        ...(selection ? { model: selection } : {}),
      })
      return
    }
    case 'subscribe': {
      channel.subscriptions.add(frame.sessionId)
      const page = user.historyPage(frame.sessionId, null, 30)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'history',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        items: page.items,
        nextBeforeSeq: page.nextBeforeSeq,
        cursor: page.cursor,
        hasMore: page.hasMore,
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'replay',
        sessionId: frame.sessionId,
        fromCursor: frame.sinceCursor ?? null,
        toCursor: page.cursor,
      })
      // 与真实 adapter 一致：history 之后**补发**该会话已经发生过的工具/交付物帧。
      for (const event of user.eventsOf(frame.sessionId)) channel.deliver(event)
      user.attachRuntime(frame.sessionId, channel)
      // WP46 / M6 §2.2.1：订阅成功后（replay 边界之后）立刻发一份权威快照，
      // 把断线期间错过的回合态与未决提问/审批一次校正回来。
      if ((channel.features ?? []).includes('session-state')) {
        channel.deliver(user.sessionStateFrame(frame.sessionId))
      }
      return
    }
    case 'unsubscribe':
      channel.subscriptions.delete(frame.sessionId)
      return
    case 'send': {
      const session = user.getSession(frame.sessionId)
      if (!session) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'session-not-found',
          message: '会话不存在',
          retryable: false,
        })
        return
      }
      if (session.messages.some((m) => m.clientMessageId === frame.clientMessageId)) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'ack',
          requestId: frame.requestId,
          clientMessageId: frame.clientMessageId,
        })
        return
      }
      user.lastAttachments = Array.isArray(frame.attachments) ? frame.attachments : null
      const message = user.appendMessage(frame.sessionId, {
        role: 'user',
        at: now(),
        text: frame.text,
        clientMessageId: frame.clientMessageId,
      })
      if (user.cockpit) {
        // 真链路证据：这条消息是从 App 的 WS 通道进来的（不是 UI 自己画的气泡）
        pushCockpitEvidence(cockpitStats.turns, {
          at: now(),
          sessionId: frame.sessionId,
          text: String(frame.text ?? ''),
          requestId: frame.requestId ?? null,
        })
      }
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'ack',
        requestId: frame.requestId,
        clientMessageId: frame.clientMessageId,
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'message',
        sessionId: frame.sessionId,
        seq: message.seq,
        role: 'user',
        at: message.at,
        text: message.text,
        clientMessageId: frame.clientMessageId,
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'turn',
        sessionId: frame.sessionId,
        phase: 'start',
        turn: 1,
      })
      user.startTurn(frame.sessionId, channel, frame.text)
      return
    }
    case 'stop': {
      const accepted = user.runtimes.has(frame.sessionId)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'stopped',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        accepted,
      })
      if (accepted) user.stopTurn(frame.sessionId)
      return
    }
    case 'rename': {
      const session = user.getSession(frame.sessionId)
      if (!session) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'session-not-found',
          message: '会话不存在',
          retryable: false,
        })
        return
      }
      const title = String(frame.title ?? '').trim()
      if (title.length === 0 || title.length > 300) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'title-invalid',
          message: '标题不合法',
          retryable: false,
        })
        return
      }
      session.title = title
      session.updatedAt = now()
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'renamed',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        title,
        seq: ++user.seq,
      })
      return
    }
    case 'archive': {
      const session = user.getSession(frame.sessionId)
      if (!session) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'session-not-found',
          message: '会话不存在',
          retryable: false,
        })
        return
      }
      const archived = frame.archived === true
      // §17.1 ④：运行中的会话不能归档，也不暗中停回合
      if (archived && user.runtimes.has(frame.sessionId)) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'agent-busy',
          message: '会话正在运行，结束后再归档',
          retryable: false,
        })
        return
      }
      if (archived) user.archived.add(frame.sessionId)
      else user.archived.delete(frame.sessionId)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'archived',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        archived,
        sessionIds: [...user.archived],
      })
      return
    }
    case 'file-read': {
      const file = frame.fileRef
        ? user.findFile(frame.fileRef)
        : [...user.files.values()].find((item) => item.name === frame.path) ?? null
      if (!file) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'file-not-found',
          message: '文件不存在',
          retryable: false,
        })
        return
      }
      // 一次内联（≤96KiB）或分片（每片 144KiB 原始 → base64 192KiB），与契约一致。
      if (file.bytes.length <= V2_INLINE_RAW) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'file',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          fileRef: file.fileRef,
          name: file.name,
          mediaType: file.mediaType,
          mimeType: file.mimeType,
          bytes: file.bytes.length,
          encoding: 'base64',
          data: file.bytes.toString('base64'),
          sha256: file.sha256,
        })
        return
      }
      let seq = 0
      for (let offset = 0; offset < file.bytes.length; offset += V2_CHUNK_RAW) {
        const end = Math.min(offset + V2_CHUNK_RAW, file.bytes.length)
        const final = end >= file.bytes.length
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'file-chunk',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          fileRef: file.fileRef,
          seq: seq++,
          final,
          encoding: 'base64',
          data: file.bytes.subarray(offset, end).toString('base64'),
          ...(final ? { bytes: file.bytes.length, sha256: file.sha256 } : {}),
        })
      }
      return
    }
    case 'file-list':
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'file-list',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        path: '',
        entries: [...user.files.values()].map((file) => ({
          name: file.name,
          kind: 'file',
          bytes: file.bytes.length,
          fileRef: file.fileRef,
        })),
        truncated: false,
      })
      return
    case 'upload-begin': {
      const kind = frame.kind === 'image' ? 'image' : 'file'
      const limit = kind === 'image' ? V2_IMAGE_MAX : V2_FILE_MAX
      if (typeof frame.bytes !== 'number' || frame.bytes <= 0 || frame.bytes > limit) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'file-too-large',
          message: `单个附件不能超过 ${Math.round(limit / 1024 / 1024)}MB`,
          retryable: false,
        })
        return
      }
      const uploadId = `up_${randomBytes(6).toString('hex')}`
      user.uploads.set(uploadId, {
        uploadId,
        sessionId: frame.sessionId,
        kind,
        name: frame.name,
        mimeType: frame.mimeType,
        bytes: frame.bytes,
        chunks: [],
        received: 0,
        sha256: null,
        expiresAt: now() + 10 * 60_000,
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'upload-started',
        requestId: frame.requestId,
        uploadId,
        maxChunkBytes: V2_CHUNK_RAW,
      })
      return
    }
    case 'upload-chunk': {
      const upload = user.uploads.get(frame.uploadId)
      if (!upload) {
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'error',
          requestId: frame.requestId,
          code: 'file-not-found',
          message: '上传已过期',
          retryable: false,
        })
        return
      }
      const chunk = Buffer.from(String(frame.data ?? ''), 'base64')
      upload.chunks.push(chunk)
      upload.received += chunk.length
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'upload-received',
        requestId: frame.requestId,
        uploadId: frame.uploadId,
        seq: frame.seq,
        received: upload.received,
      })
      if (frame.final === true) {
        const bytes = Buffer.concat(upload.chunks)
        upload.sha256 = sha256(bytes)
        sendFrame(channel, {
          v: PROTOCOL_VERSION,
          type: 'uploaded',
          requestId: frame.requestId,
          uploadId: frame.uploadId,
          kind: upload.kind,
          name: upload.name,
          mimeType: upload.mimeType,
          bytes: bytes.length,
          expiresAt: upload.expiresAt,
        })
      }
      return
    }
    case 'upload-abort': {
      user.uploads.delete(frame.uploadId)
      return
    }
    case 'ping':
      sendFrame(channel, { v: PROTOCOL_VERSION, type: 'pong', t: frame.t })
      return
    case 'answer-question':
      user.lastAnswers = { callId: frame.callId, answers: frame.answers }
      user.settleQuestion(frame.sessionId, frame.callId)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'answer-result',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        accepted: true,
        continued: false,
      })
      // 真实 Host 在回答后还会推 `question-settled`
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'question-settled',
        sessionId: frame.sessionId,
        callId: frame.callId,
        answers: frame.answers,
      })
      // 未决集合变化 = 快照时机之一（M6 §2.2.3）
      user.broadcastSessionState(frame.sessionId)
      return
    case 'answer-approval':
      // 手机端可以直接批准/拒绝：结算后推 approval-settled，卡片消失
      lastApprovalDecision = { approvalId: frame.approvalId, decision: frame.decision }
      user.settleApproval(frame.sessionId, frame.approvalId)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'approval-settled',
        sessionId: frame.sessionId,
        approvalId: frame.approvalId,
        decision: frame.decision === 'approve' ? 'approve' : 'reject',
      })
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'answer-result',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        accepted: true,
        continued: false,
      })
      user.broadcastSessionState(frame.sessionId)
      return
    default:
      return
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────────────────────

// ── 手机网页版静态托管（WP54 / 契约 C2、C6）─────────────────────────────────
//
// mock hub 在 `/m/` 下托管 `dist-web`，让 e2e 走**真的同源**路径：页面的 location.origin
// 就是 Hub 的地址，`connect-src 'self'` 语义、relative `./version.json`、hash 路由都和
// 生产（Hub 在 `/m/` 托管）一致。缓存头按契约 C6：
//   * `/m/`（index.html）与 `/m/version.json` → no-store（刷新/版本检查永远拿新的）
//   * `/m/assets/*`（文件名带内容哈希）→ 一年 immutable
//   * 其它静态文件 → no-cache（每次都回源校验）

const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/** 契约 C6 的缓存策略（按请求路径判断，dashboard 与 Hub 保持一致）。 */
function webCacheControl(pathname) {
  if (pathname === MOBILE_WEB_BASE || pathname.endsWith('/index.html')) return 'no-store'
  if (pathname === `${MOBILE_WEB_BASE}version.json`) return 'no-store'
  if (pathname.startsWith(`${MOBILE_WEB_BASE}assets/`)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

/** 未部署时的中文提示页（与 Hub 的 /m/ 503 页同义：告诉用户去哪儿）。 */
const WEB_MISSING_PAGE =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>手机网页版暂未部署</title>' +
  '</head><body style="font-family:system-ui;padding:24px;line-height:1.6">' +
  '<h1 style="font-size:20px">手机网页版暂未部署</h1>' +
  '<p>这台 Hub 还没有发布手机网页版产物（<code>--web-dist</code> 未指定）。</p>' +
  '<p><a href="/">前往电脑版</a></p></body></html>'

function serveMobileWeb(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Method Not Allowed')
    return
  }
  if (!WEB_DIST) {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(WEB_MISSING_PAGE)
    return
  }
  // '/m/' → index.html；其余按相对路径取（URL 解码后再拼，防 %2e%2e 之类的绕行）
  let rel
  try {
    rel = decodeURIComponent(pathname.slice(MOBILE_WEB_BASE.length))
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  let file = path.resolve(WEB_DIST, rel)
  // 目录穿越防线（两道：拼出来的路径必须在产物目录里；真实路径也要在）
  if (file !== WEB_DIST && !file.startsWith(`${WEB_DIST}${path.sep}`)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  let real = file
  let info = null
  try {
    real = realpathSync(file)
    info = statSync(real)
  } catch {
    info = null
  }
  /**
   * SPA 兜底（与 Hub 的 WP54b 实现对齐，契约 C6）：
   *  - **带扩展名**但文件不存在（`/m/missing.json`、`/m/assets/nope.js`、`/m/version.json`）
   *    → 一律 404，**不回 index.html**。原因：这些是「资源」请求，回一页 HTML 会让客户端
   *    把 HTML 当 JSON/JS 解析（版本检查尤其要能分辨「没部署」与「版本一样」）；
   *  - **不带扩展名**的路径（`/m/foo`）→ 回 index.html（hash 路由其实用不到，但浏览器直接
   *    打开/分享出来的路径不能 404）。
   */
  let fallback = false
  if (info === null || !info.isFile()) {
    if (path.extname(rel) !== '') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('Not Found')
      return
    }
    const indexFile = path.join(WEB_DIST, 'index.html')
    try {
      real = realpathSync(indexFile)
      info = statSync(real)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('Not Found')
      return
    }
    fallback = true
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('Not Found')
    return
  }
  if (real !== WEB_DIST && !real.startsWith(`${WEB_DIST}${path.sep}`)) {
    // 产物目录里指出去的符号链接：一律不认
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const type = WEB_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'Content-Type': type,
    'Content-Length': String(info.size),
    // 兜底回的 index.html 一定是 no-store（路径本身可能长得像资源，别按 no-cache 缓存它）
    'Cache-Control': fallback ? 'no-store' : webCacheControl(pathname),
    'X-Content-Type-Options': 'nosniff',
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  createReadStream(real).pipe(res)
}

const server = http.createServer(async (req, res) => {
  withCors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname

  try {
    // 「主入口不可达」：/api/* 全部按拦截页处理（含 /api/health）。
    //
    // 例外：带 `X-DSH-Mock-Ingress: backup` 的请求来自 e2e 的备用入口代理（同一条网络路径的
    // 另一个入口），放行 —— 这样两个入口背后仍是**同一个 hub 进程**，设备令牌通用，
    // 才测得出「切回首选入口不重新登录」。
    if (path.startsWith('/api/')) {
      originHook.apiRequests += 1
      const viaBackup = req.headers['x-dsh-mock-ingress'] === 'backup'
      if (viaBackup) originHook.backupRequests += 1
      if (originHook.blocked && !viaBackup) {
        originHook.blockedRequests += 1
        blockedPage(res)
        return
      }
    }

    // 手机网页版（WP54）：`/m` → 301 `/m/`（契约 C2），`/m/**` → dist-web 静态产物（契约 C6）
    if (path === MOBILE_WEB_BASE.replace(/\/$/, '')) {
      res.writeHead(301, { Location: MOBILE_WEB_BASE, 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (path.startsWith(MOBILE_WEB_BASE)) {
      serveMobileWeb(req, res, path)
      return
    }

    if (path === '/' || path === '/__test/health') {
      json(res, 200, { ok: true, service: 'dsh-hub-mock', port: PORT, protocol: PROTOCOL_VERSION })
      return
    }

    // 最近一次登录请求（WP54 e2e 断言 platform/deviceName 用；不进产品逻辑）
    if (path === '/__test/last-login') {
      json(res, 200, { lastLogin })
      return
    }

    // 管理座舱（WP56d）的控制面：发一个交接码 / 让座舱令牌全部失效 / 看换码记录
    if (path === '/__test/cockpit-handoff' && req.method === 'POST') {
      json(res, 200, issueCockpitCode(url.searchParams.get('user') ?? 'admin'))
      return
    }
    if (path === '/__test/cockpit-expire' && req.method === 'POST') {
      let removed = 0
      for (const [token, value] of [...tokens]) {
        if (value.scope !== 'cockpit') continue
        tokens.delete(token)
        removed += 1
      }
      // 通道也一起断：真实 Hub 在管理员被降级/登出时会给通道发 bye（docs/24 §3.3）
      for (const user of cockpitUsers.values()) {
        for (const channel of [...user.channels]) channel.close(1000)
      }
      json(res, 200, { ok: true, removed })
      return
    }
    if (path === '/__test/cockpit-state') {
      json(res, 200, {
        handoffs: cockpitStats.handoffs,
        exchanges: cockpitStats.exchanges,
        codes: [...cockpitCodes.entries()].map(([code, value]) => ({
          code,
          used: value.used,
          expired: value.expiresAt < now(),
        })),
        cockpitTokens: [...tokens.values()].filter((value) => value.scope === 'cockpit').length,
        sessions: cockpitUser().rows(true),
        // WP56e3：通道侧证据（冷启动窗口 / ticket / 经通道的 send 与助手回复）
        node: { connectable: cockpitNodeConnectable(), blockedUntil: cockpitNodeHook.blockedUntil },
        bootstraps: cockpitStats.bootstraps,
        tickets: cockpitStats.tickets,
        turns: cockpitStats.turns,
        replies: cockpitStats.replies,
      })
      return
    }
    // 座舱节点「冷启动窗口」开关（WP56e3）：`{connectable:false, ms:6000}` → 6 秒内不可连接。
    if (path === '/__test/cockpit-node' && req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body?.connectable === 'boolean') {
        cockpitNodeHook.blockedUntil = body.connectable
          ? 0
          : now() + Math.max(0, Number(body.ms ?? 0) || 0)
      }
      json(res, 200, {
        ok: true,
        connectable: cockpitNodeConnectable(),
        blockedUntil: cockpitNodeHook.blockedUntil,
      })
      return
    }
    // 嵌入座舱的「父页面」：同源 iframe 把 /m/?embed=cockpit 嵌进来，并记录 postMessage。
    if (path === '/__cockpit/parent') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(COCKPIT_PARENT_PAGE)
      return
    }

    if (path === '/__test/origin-mode') {
      if (req.method === 'POST') {
        const body = await readJson(req)
        if (typeof body?.blocked === 'boolean') originHook.blocked = body.blocked
      }
      json(res, 200, { ...originHook })
      return
    }

    // 入口健康检查（App 切换前探测它；真 Hub 回 {ok,version,db,docker}）
    if (path === '/api/health') {
      json(res, 200, { ok: true, version: 'mock', db: 'ok', docker: 'disabled' })
      return
    }

    if (path === '/__test/script') {
      json(res, 200, { reply: MOCK_REPLY })
      return
    }

    if (path === '/__test/status') {
      const username = url.searchParams.get('user') ?? 'demo'
      const user = users.get(username)
      json(res, 200, {
        instance: user?.instance ?? 'absent',
        sessions: user?.rows(true) ?? [],
        runtimes: user ? [...user.runtimes.keys()] : [],
        channels: user?.channels.size ?? 0,
        // v2 诊断（e2e 断言用）
        archived: user ? [...user.archived] : [],
        lastAttachments: user?.lastAttachments ?? null,
        lastAnswers: user?.lastAnswers ?? null,
        lastApproval: user?.lastApproval ?? null,
        // 0.4.11 多入口：本机是否是「主入口不可达」场景 / 收到多少 /api 请求（e2e 断言用）
        origin: { ...originHook },
        // WP46：每个会话还没结算的提问+审批数（e2e 断言「暂存住了」用）
        voice: { ...voiceHook, requests: asrRequests },
        // 0.4.3 朗读：请求数 / 并发峰值 / 每段字数（不含文字），e2e 用它断言预取不超 2
        tts: {
          ...ttsHook,
          requests: ttsStats.requests,
          inflight: ttsStats.inflight,
          maxInflight: ttsStats.maxInflight,
          segments: [...ttsStats.segments],
          voices: [...ttsStats.voices],
          streams: ttsStats.streams,
          streamAborted: ttsStats.streamAborted,
        },
        pendingInteractions: user
          ? Object.fromEntries(
              user.sessions
                .map((row) => [row.sessionId, user.pendingInteractionCount(row.sessionId)])
                .filter(([, count]) => count > 0),
            )
          : {},
        uploads: user ? [...user.uploads.values()].map((u) => ({
          uploadId: u.uploadId,
          name: u.name,
          bytes: u.bytes,
          received: u.received,
          sha256: u.sha256,
        })) : [],
        files: user ? [...user.files.values()].map((f) => ({
          fileRef: f.fileRef,
          name: f.name,
          mimeType: f.mimeType,
          mediaType: f.mediaType,
          bytes: f.bytes.length,
          sha256: f.sha256,
        })) : [],
        events: user
          ? Object.fromEntries([...user.events.entries()].map(([id, list]) => [id, list.length]))
          : {},
      })
      return
    }

    if (path === '/__test/question' && req.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? 's_mock_plan'
      const user = userFor(url.searchParams.get('user') ?? 'demo')
      const callId = `q_${randomBytes(3).toString('hex')}`
      const question = {
        sessionId,
        agent: 'chat',
        callId,
        state: 'open',
        questions: [
          {
            id: 'tone',
            header: '回答风格',
            question: '你希望我怎么继续？',
            options: [
              { label: '直接执行', description: '不再确认，边做边汇报' },
              { label: '先给方案', description: '先看计划，再决定' },
            ],
          },
        ],
      }
      // WP46：未决提问**暂存在 Hub 侧**（通道断开也不 next、不丢），
      // 只有订阅了该会话的通道才收增量帧；其它情况靠会话行的 pendingInteractions 提示。
      user.parkQuestion(sessionId, {
        agent: question.agent,
        callId: question.callId,
        questions: question.questions,
        state: question.state,
      })
      for (const channel of user.channels) {
        if (!channel.subscriptions.has(sessionId)) continue
        channel.deliver({ v: PROTOCOL_VERSION, type: 'question', ...question })
      }
      user.broadcastSessionState(sessionId)
      json(res, 200, { ok: true, callId })
      return
    }

    if (path === '/__test/approval' && req.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? 's_mock_plan'
      const user = userFor(url.searchParams.get('user') ?? 'demo')
      const approvalId = `ap_${randomBytes(3).toString('hex')}`
      const approval = {
        approvalId,
        sessionId,
        callId: null,
        tool: 'bash',
        reason: '想在你的工作区里执行命令',
        answerable: true,
        actions: ['approve', 'reject'],
        state: 'open',
      }
      user.parkApproval(sessionId, approval)
      for (const channel of user.channels) {
        if (!channel.subscriptions.has(sessionId)) continue
        channel.deliver({ v: PROTOCOL_VERSION, type: 'approval', sessionId, approval })
      }
      user.broadcastSessionState(sessionId)
      json(res, 200, { ok: true, approvalId })
      return
    }

    // 给会话补一张工具卡（字体放大回归用：过程行展开后才有 .tool__summary）。
    // 走真实的 tool 帧 → 客户端 toolCards → 过程行，而不是直接改 store 的只读 computed。
    if (path === '/__test/tool' && req.method === 'POST') {
      const sessionId = url.searchParams.get('session')
        ? url.searchParams.get('session')
        : 's_mock_plan'
      const user = userFor(url.searchParams.get('user') ?? 'demo')
      if (!user.getSession(sessionId)) {
        json(res, 404, { ok: false, error: 'session-not-found' })
        return
      }
      const callId = `call_zoom_${randomBytes(3).toString('hex')}`
      const query = '一个相当长的搜索查询，用来检查工具卡在字体放大时会不会把输入卡撑破'
      const base = {
        v: PROTOCOL_VERSION,
        type: 'tool',
        sessionId,
        turn: 1,
        step: 1,
        callId,
        kind: 'search',
        name: 'web_search',
        title: '搜索网页',
        inputPreview: query,
        inputBytes: Buffer.byteLength(query, 'utf8'),
        truncated: { input: true },
      }
      const frames = [
        { ...base, phase: 'start', seq: ++user.seq, status: 'running' },
        {
          ...base,
          phase: 'end',
          seq: ++user.seq,
          status: 'ok',
          outputPreview: MOCK_CITATIONS.map((item, index) => `${index + 1}. ${item.title}`).join('\n'),
          outputBytes: 96,
          citations: MOCK_CITATIONS,
          durationMs: 860,
        },
      ]
      for (const frame of frames) {
        user.recordEvent(sessionId, frame)
        for (const channel of user.channels) {
          if (channel.subscriptions.has(sessionId)) channel.deliver(frame)
        }
      }
      json(res, 200, { ok: true, callId, citations: MOCK_CITATIONS.length })
      return
    }

    // 问题导航条（0.4.0 §4）的 e2e 场景：给一个会话补几轮「问答」，
    // 让时间线足够长、用户提问 ≥ 3 条。只在 mock 里，不参与产品路径。
    if (path === '/__test/seed-thread' && req.method === 'POST') {
      const sessionId = url.searchParams.get('session') ?? 's_mock_plan'
      const turns = Math.max(1, Number(url.searchParams.get('turns') ?? 4))
      const user = userFor(url.searchParams.get('user') ?? 'demo')
      const session = user.getSession(sessionId)
      if (!session) {
        json(res, 404, { ok: false, error: 'session-not-found' })
        return
      }
      for (let i = 1; i <= turns; i += 1) {
        user.appendMessage(sessionId, {
          role: 'user',
          at: now() + i,
          text: `第 ${i} 个提问：把第 ${i} 段的结论再复述一遍，顺便说说下一步要验证什么。`,
        })
        user.appendMessage(sessionId, {
          role: 'assistant',
          at: now() + i,
          text: `第 ${i} 段的结论：过程行固定在「最后一条用户消息之后、正文之前」，实时思考只是这一行的末行。

- 位置不变：块 key 以前一个边界条目派生，实时 → 落库时同一个 DOM 节点原地更新
- 摘要单行：运行中是当前步骤，完成后是结果（思考 N 秒 / 搜索了 N 个网页）
- 正文永远在过程行下方

下一步要验证的是：真机上连续提问时，问题导航条能准确定位到每一条提问。`,
        })
      }
      json(res, 200, { ok: true, sessionId, turns, messages: session.messages.length })
      return
    }

    if (path === '/__test/disconnect' && req.method === 'POST') {
      let count = 0
      for (const user of users.values()) {
        for (const channel of [...user.channels]) {
          count += 1
          channel.closed = true
          user.channels.delete(channel)
          channel.ws.terminate()
        }
      }
      json(res, 200, { ok: true, disconnected: count })
      return
    }

    if (path === '/__test/sleep' && req.method === 'POST') {
      // e2e（回前台唤醒）：Hub 空闲休眠 = 实例 stopped + 通道全断；不动会话数据。
      let count = 0
      for (const user of users.values()) {
        user.instance = 'stopped'
        for (const channel of [...user.channels]) {
          count += 1
          channel.closed = true
          user.channels.delete(channel)
          channel.ws.terminate()
        }
      }
      json(res, 200, { ok: true, disconnected: count })
      return
    }

    if (path === '/__test/tts' && req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body.enabled === 'boolean') ttsHook.enabled = body.enabled
      if (typeof body.fail === 'number') ttsHook.fail = Math.max(0, Math.round(body.fail))
      if (typeof body.rateLimit === 'number') {
        ttsHook.rateLimit = Math.max(0, Math.round(body.rateLimit))
      }
      if (typeof body.retryAfterSec === 'number') {
        ttsHook.retryAfterSec = Math.max(0, Math.round(body.retryAfterSec))
      }
      if (typeof body.delayMs === 'number') ttsHook.delayMs = Math.max(0, Math.round(body.delayMs))
      if (typeof body.maxChars === 'number') {
        ttsHook.maxChars = Math.max(1, Math.min(TTS_MAX_CHARS, Math.round(body.maxChars)))
      }
      if (typeof body.stream === 'boolean') ttsHook.stream = body.stream
      if (typeof body.streamRate === 'number') {
        ttsHook.streamRate = Math.min(1.5, Math.max(0.3, body.streamRate))
      }
      if (typeof body.streamFirstMs === 'number') {
        ttsHook.streamFirstMs = Math.max(0, Math.round(body.streamFirstMs))
      }
      if (typeof body.streamChunkMs === 'number') {
        ttsHook.streamChunkMs = Math.max(20, Math.round(body.streamChunkMs))
      }
      if (typeof body.streamMsPerChar === 'number') {
        ttsHook.streamMsPerChar = Math.max(20, Math.round(body.streamMsPerChar))
      }
      if (typeof body.streamInterruptAfter === 'number') {
        ttsHook.streamInterruptAfter = Math.max(0, Math.round(body.streamInterruptAfter))
      }
      json(res, 200, { ok: true, ...ttsHook })
      return
    }

    if (path === '/__test/reply' && req.method === 'POST') {
      const body = await readJson(req)
      const user = userFor(url.searchParams.get('user') ?? 'demo')
      const text = typeof body?.text === 'string' && body.text !== '' ? body.text : null
      const plain = body?.plain === true
      const tickMs = Number.isFinite(body?.tickMs) && body.tickMs > 0 ? Number(body.tickMs) : null
      const chunk = Number.isFinite(body?.chunk) && body.chunk > 0 ? Number(body.chunk) : null
      if (text === null && !plain && tickMs === null && chunk === null) {
        // 不带参数 = 清掉钩子，回到默认回复
        user.replyPlan = null
        json(res, 200, { ok: true, cleared: true })
        return
      }
      user.replyPlan = {
        ...(text === null ? {} : { text }),
        plain,
        ...(tickMs === null ? {} : { tickMs }),
        ...(chunk === null ? {} : { chunk }),
      }
      json(res, 200, { ok: true, next: user.replyPlan })
      return
    }

    if (path === '/__test/voice' && req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body.asr === 'boolean') voiceHook.asr = body.asr
      if (typeof body.maxSeconds === 'number') {
        voiceHook.maxSeconds = Math.max(1, Math.min(ASR_MAX_SECONDS, Math.round(body.maxSeconds)))
      }
      if (typeof body.fail === 'number') voiceHook.fail = Math.max(0, Math.round(body.fail))
      if (typeof body.delayMs === 'number') voiceHook.delayMs = Math.max(0, Math.round(body.delayMs))
      json(res, 200, { ok: true, ...voiceHook })
      return
    }

    if (path === '/__test/hold' && req.method === 'POST') {
      // e2e（0.4.1 连接 UX）：挂起后续 WS 握手 N 毫秒（ms=0 → 释放并掐断挂着的握手）。
      const body = await readJson(req)
      holdUpgradeMs = Math.max(0, Number(body.ms ?? 0) || 0)
      if (holdUpgradeMs === 0) flushHeldUpgrades()
      json(res, 200, { ok: true, ms: holdUpgradeMs, held: heldUpgrades.size })
      return
    }

    if (path === '/__test/reset' && req.method === 'POST') {
      users.clear()
      tokens.clear()
      tickets.clear()
      // WP56e3：座舱的通道证据与冷启动窗口也一起清（每个 e2e 脚本都从干净状态开始）
      cockpitStats.bootstraps.length = 0
      cockpitStats.tickets.length = 0
      cockpitStats.turns.length = 0
      cockpitStats.replies.length = 0
      cockpitNodeHook.blockedUntil = 0
      holdUpgradeMs = 0
      // 登录记录也一起清：e2e 里 /__test/reset 之后再登录，读到的就是这一轮的请求
      lastLogin = null
      flushHeldUpgrades()
      voiceHook.asr = true
      voiceHook.maxSeconds = ASR_MAX_SECONDS
      voiceHook.fail = 0
      voiceHook.delayMs = 0
      asrRequests = 0
      ttsHook.enabled = true
      ttsHook.fail = 0
      ttsHook.rateLimit = 0
      ttsHook.retryAfterSec = 1
      ttsHook.delayMs = 0
      ttsHook.maxChars = TTS_MAX_CHARS
      ttsHook.stream = true
      ttsHook.streamRate = TTS_STREAM_RATE
      ttsHook.streamFirstMs = 200
      ttsHook.streamChunkMs = 200
      ttsHook.streamMsPerChar = 178
      ttsHook.streamInterruptAfter = 0
      ttsStats.requests = 0
      ttsStats.inflight = 0
      ttsStats.maxInflight = 0
      ttsStats.segments = []
      ttsStats.voices = []
      ttsStats.streams = 0
      ttsStats.streamAborted = 0
      json(res, 200, { ok: true })
      return
    }

    if (path === '/api/mobile/auth/login' && req.method === 'POST') {
      const body = await readJson(req)
      const username = String(body.username ?? '')
      const password = String(body.password ?? '')
      // 平台（WP54 / 契约 C1、C11）：真 Hub 只收 android / ios / web；这里同样校验，
      // 免得 e2e 因为「mock 什么都收」而放过一个真机上会 400 的 bug。
      const platform = body.platform === undefined ? 'android' : String(body.platform)
      const deviceName = body.deviceName === undefined ? null : String(body.deviceName)
      const installId = body.installId === undefined ? null : String(body.installId)
      lastLogin = {
        at: new Date().toISOString(),
        username,
        platform,
        deviceName,
        installId,
        userAgent: String(req.headers['user-agent'] ?? ''),
      }
      if (!MOBILE_PLATFORMS.includes(platform)) {
        json(res, 400, {
          code: 'INVALID_REQUEST',
          message: `platform 只支持 ${MOBILE_PLATFORMS.join(' / ')}，收到：${platform}`,
        })
        return
      }
      if (!username || !password) {
        json(res, 400, { code: 'INVALID_REQUEST', message: '缺少用户名或密码' })
        return
      }
      if (deviceName !== null && (deviceName.trim() === '' || deviceName.length > 64)) {
        json(res, 400, { code: 'INVALID_REQUEST', message: 'deviceName 长度必须是 1..64' })
        return
      }
      if (password !== 'demo1234') {
        json(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'invalid credentials' } })
        return
      }
      if (username === 'pending') {
        json(res, 403, { error: { code: 'USER_PENDING', message: 'pending approval' } })
        return
      }
      if (username === 'disabled') {
        json(res, 403, { error: { code: 'USER_DISABLED', message: 'disabled' } })
        return
      }
      if (username === 'changepw') {
        json(res, 403, { error: { code: 'MUST_CHANGE_PASSWORD', message: 'must change password' } })
        return
      }
      if (username === 'ratelimit') {
        json(res, 429, {
          error: {
            code: 'RATE_LIMITED',
            message: 'too many attempts',
            details: { retryAfterSec: 3 },
          },
        })
        return
      }
      userFor(username)
      json(res, 200, issueTokens(username))
      return
    }

    // ── 管理座舱（WP56d / docs/24 §3.3）：交接码换座舱令牌 ────────────────────
    if (path === '/api/mobile/auth/cockpit-exchange' && req.method === 'POST') {
      const body = await readJson(req)
      const code = String(body?.code ?? '').trim()
      const record = takeCockpitCode(code)
      if (!record) {
        // 无效 / 过期 / 已用过：一律 400（App 据此等父页面重新交接，不回登录页）
        cockpitStats.exchanges.push({ code, ok: false, at: iso(now()) })
        json(res, 400, {
          error: { code: 'INVALID_REQUEST', message: 'handoff code invalid, expired or used' },
        })
        return
      }
      lastLogin = {
        at: new Date().toISOString(),
        username: record.username,
        platform: 'web',
        deviceName: '管理座舱（cockpit）',
        installId: null,
        userAgent: String(req.headers['user-agent'] ?? ''),
      }
      cockpitStats.exchanges.push({ code, ok: true, at: iso(now()) })
      json(res, 200, issueTokens(record.username, { scope: 'cockpit' }))
      return
    }

    if (path === '/api/mobile/auth/refresh' && req.method === 'POST') {
      const body = await readJson(req)
      const record = tokens.get(String(body.refreshToken ?? ''))
      if (!record || record.kind !== 'refresh') {
        json(res, 401, { error: { code: 'DEVICE_REVOKED', message: 'refresh token invalid' } })
        return
      }
      // 轮换：旧 refresh 立即失效
      for (const [token, value] of [...tokens]) {
        if (value.username === record.username && value.kind === 'refresh') tokens.delete(token)
      }
      json(res, 200, issueTokens(record.username, record.scope ? { scope: record.scope } : {}))
      return
    }

    if (path === '/api/mobile/auth/consolidate' && req.method === 'POST') {
      // 0.2.9：合并历史重复设备；mock 没有历史台账，固定返回 0
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      json(res, 200, { removed: 0 })
      return
    }

    if (path === '/api/mobile/auth/logout' && req.method === 'POST') {
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      for (const [token, value] of [...tokens]) {
        if (value.username === record.username) tokens.delete(token)
      }
      res.writeHead(204)
      res.end()
      return
    }

    // ── 朗读合成（0.4.3 / WP50）：POST /api/mobile/tts（JSON {text, voice?}）────────
    if (path === '/api/mobile/tts' && req.method === 'POST') {
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().includes('application/json')) {
        json(res, 415, {
          error: { code: 'UNSUPPORTED_MEDIA', message: 'content-type must be application/json' },
        })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        json(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'invalid json' } })
        return
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const voice = typeof body.voice === 'string' && body.voice.length > 0 ? body.voice : TTS_VOICES[0].id
      if (text.length === 0 || text.length > ttsHook.maxChars) {
        json(res, 400, {
          error: { code: 'VALIDATION_FAILED', message: `text length ${text.length}` },
        })
        return
      }
      if (!TTS_VOICES.some((item) => item.id === voice)) {
        json(res, 400, { error: { code: 'VALIDATION_FAILED', message: `unknown voice ${voice}` } })
        return
      }
      ttsStats.requests += 1
      ttsStats.inflight += 1
      ttsStats.maxInflight = Math.max(ttsStats.maxInflight, ttsStats.inflight)
      ttsStats.segments.push(text.length)
      ttsStats.voices.push(voice)
      try {
        if (ttsHook.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, ttsHook.delayMs))
        }
        if (ttsHook.rateLimit > 0) {
          ttsHook.rateLimit -= 1
          json(res, 429, {
            error: {
              code: 'RATE_LIMITED',
              message: 'synthesis queue full',
              details: { retryAfterSec: ttsHook.retryAfterSec },
            },
          })
          return
        }
        if (ttsHook.fail > 0 || !ttsHook.enabled) {
          if (ttsHook.fail > 0) ttsHook.fail -= 1
          json(res, 502, {
            error: { code: 'UPSTREAM_ERROR', message: 'tts service unavailable' },
          })
          return
        }
        wavBytes(res, 200, encodeTtsWav(text), {
          'x-tts-sample-rate': String(TTS_SAMPLE_RATE),
          'x-tts-voice': voice,
        })
      } finally {
        ttsStats.inflight -= 1
      }
      return
    }

    // ── 流式朗读（0.4.6 / WP51）：POST /api/mobile/tts/stream ────────────────────
    // 请求体与 /tts 相同；成功时 200 + 裸 PCM16 分块下发（无 WAV 头、无 Content-Length）。
    // 首块延迟 streamFirstMs，之后每块 streamChunkMs 音频，按 streamRate（默认 0.9）慢于实时。
    // streamInterruptAfter > 0 时在第 N 块之后直接掐断连接（App 读流会报错）——真 Hub 开始
    // 下发后失败就是这么做的。客户端停止（关连接）时计 streamAborted，不再继续写。
    if (path === '/api/mobile/tts/stream' && req.method === 'POST') {
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().includes('application/json')) {
        json(res, 415, {
          error: { code: 'UNSUPPORTED_MEDIA', message: 'content-type must be application/json' },
        })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        json(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'invalid json' } })
        return
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const voice =
        typeof body.voice === 'string' && body.voice.length > 0 ? body.voice : TTS_VOICES[0].id
      if (text.length === 0 || text.length > ttsHook.maxChars) {
        json(res, 400, {
          error: { code: 'VALIDATION_FAILED', message: `text length ${text.length}` },
        })
        return
      }
      if (!TTS_VOICES.some((item) => item.id === voice)) {
        json(res, 400, { error: { code: 'VALIDATION_FAILED', message: `unknown voice ${voice}` } })
        return
      }
      ttsStats.requests += 1
      ttsStats.streams += 1
      ttsStats.inflight += 1
      ttsStats.maxInflight = Math.max(ttsStats.maxInflight, ttsStats.inflight)
      ttsStats.segments.push(text.length)
      ttsStats.voices.push(voice)
      let closed = false
      let finished = false
      let aborted = false
      const countAborted = () => {
        // 正常收尾之后再 close 不算中断；提前断开 = 客户端停止朗读（App 中断下载）
        if (finished || aborted) return
        aborted = true
        ttsStats.streamAborted += 1
      }
      res.on('close', () => {
        closed = true
        countAborted()
      })
      try {
        if (ttsHook.rateLimit > 0) {
          ttsHook.rateLimit -= 1
          json(res, 429, {
            error: {
              code: 'RATE_LIMITED',
              message: 'synthesis queue full',
              details: { retryAfterSec: ttsHook.retryAfterSec },
            },
          })
          return
        }
        if (ttsHook.fail > 0 || !ttsHook.enabled) {
          if (ttsHook.fail > 0) ttsHook.fail -= 1
          json(res, 502, {
            error: { code: 'UPSTREAM_ERROR', message: 'tts service unavailable' },
          })
          return
        }
        const pcm = encodeTtsPcm(text, ttsHook.streamMsPerChar)
        const chunkBytes = Math.max(
          2,
          Math.round((TTS_SAMPLE_RATE * ttsHook.streamChunkMs) / 1_000) * 2,
        )
        res.writeHead(200, {
          'Content-Type': `audio/L16; rate=${TTS_SAMPLE_RATE}; channels=1`,
          'Cache-Control': 'no-store',
          'x-tts-sample-rate': String(TTS_SAMPLE_RATE),
          'x-tts-voice': voice,
          'x-tts-format': 'pcm16le',
          'x-tts-cached': '0',
        })
        await sleepMs(ttsHook.streamFirstMs)
        // 按「起始时刻 + 块序号 × 每块间隔」排程：setTimeout 的几毫秒开销不会逐块累积，
        // 否则 App 实测的速率会被拖低（0.9 变成 0.89），自适应切段的停顿预算就失真了。
        const startedAt = Date.now()
        let offset = 0
        let index = 0
        while (offset < pcm.length) {
          if (closed || res.destroyed) {
            countAborted()
            return
          }
          if (ttsHook.streamInterruptAfter > 0 && index >= ttsHook.streamInterruptAfter) {
            // 开始下发之后失败：真 Hub 直接掐断连接
            res.destroy()
            return
          }
          const end = Math.min(pcm.length, offset + chunkBytes)
          try {
            res.write(pcm.subarray(offset, end))
          } catch {
            // 客户端已经断开（停止朗读）：真 Hub 也是这样断开连接的
            countAborted()
            return
          }
          offset = end
          index += 1
          if (offset >= pcm.length) break
          const due = startedAt + index * (ttsHook.streamChunkMs / ttsHook.streamRate)
          const wait = Math.round(due - Date.now())
          if (wait > 0) await sleepMs(wait)
        }
        finished = true
        res.end()
      } finally {
        ttsStats.inflight -= 1
      }
      return
    }

    // ── 服务端语音识别（0.4.2 / WP49）：POST /api/mobile/asr（audio/wav）──────────
    if (path === '/api/mobile/asr' && req.method === 'POST') {
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      const contentType = String(req.headers['content-type'] ?? '')
      if (!contentType.toLowerCase().includes('audio/wav')) {
        json(res, 415, {
          error: { code: 'UNSUPPORTED_MEDIA', message: 'content-type must be audio/wav' },
        })
        return
      }
      const raw = await readBody(req, ASR_MAX_BYTES)
      if (raw === null) {
        json(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'audio too large' } })
        return
      }
      const wav = parseWavHeader(raw)
      if (!wav || wav.sampleRate !== 16_000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
        json(res, 400, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'expect 16kHz mono 16bit PCM wav',
          },
        })
        return
      }
      // 到这里就算一次真实请求（成败都要计数，e2e 用它断言「没重复上传」）
      asrRequests += 1
      if (voiceHook.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, voiceHook.delayMs))
      }
      if (voiceHook.fail > 0 || !voiceHook.asr) {
        if (voiceHook.fail > 0) voiceHook.fail -= 1
        json(res, 502, {
          error: { code: 'UPSTREAM_ERROR', message: 'asr service unavailable' },
        })
        return
      }
      json(res, 200, { text: ASR_TEXT, durationMs: wavDurationMs(wav) })
      return
    }

    const authRequired =
      path.startsWith('/api/mobile/bootstrap') ||
      path === '/api/mobile/instance/wake' ||
      path.startsWith('/api/mobile/nodes/')
    if (authRequired) {
      const record = bearerOf(req)
      if (!record) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } })
        return
      }
      // 座舱令牌（WP56d / docs/24 §3.3）：只看得到 cloud:ops，bootstrap 只给通道需要的字段。
      const cockpit = record.scope === 'cockpit'
      const user = cockpit ? cockpitUser() : userFor(record.username)

      if (path === '/api/mobile/bootstrap' && req.method === 'GET') {
        const cockpitConnectable = cockpitNodeConnectable()
        if (cockpit) {
          pushCockpitEvidence(cockpitStats.bootstraps, {
            at: now(),
            connectable: cockpitConnectable,
          })
        }
        json(res, 200, {
          user: cockpit
            ? { id: 9001, username: 'hub-ops', displayName: '座舱 DSH' }
            : { id: 1, username: record.username, displayName: record.username },
          points: cockpit ? { balance: 0, enabled: false } : { balance: 1280.5, enabled: true },
          backends: cockpit
            ? [{ ...COCKPIT_NODE, connectable: cockpitConnectable }]
            : [
                {
                  id: 'cloud:self',
                  kind: 'cloud',
                  name: '云服务器',
                  status: user.instance,
                  connectable: user.instance === 'running',
                  ...(user.instance === 'running' ? {} : { reason: 'instance-not-running' }),
                  capabilities: CAPABILITIES,
                },
                DESKTOP_NODE,
              ],
          instance: { status: user.instance, capacityFull: false },
          app: { minVersionCode: 1, latestVersionCode: 10, downloadUrl: null },
          // 0.4.2：Hub 侧语音识别能力（老 Hub 不发这个字段，App 就只用系统识别）
          // 0.4.3：voice.tts 与 asr 同级；enabled=false 时 App 隐藏朗读入口
          voice: {
            asr: voiceHook.asr,
            maxSeconds: voiceHook.maxSeconds,
            tts: {
              enabled: ttsHook.enabled,
              voices: TTS_VOICES,
              defaultVoice: TTS_VOICES[0].id,
              maxChars: ttsHook.maxChars,
              // 0.4.6：流式朗读能力；hook 关掉时**不带这个字段**（老 Hub 形状）
              ...(ttsHook.stream ? { stream: true } : {}),
            },
          },
          serverTime: iso(now()),
        })
        return
      }

      if (path === '/api/mobile/instance/wake' && req.method === 'POST') {
        json(res, 202, { status: user.wake() })
        return
      }

      const ticketMatch = path.match(/^\/api\/mobile\/nodes\/([^/]+)\/ticket$/)
      if (ticketMatch && req.method === 'POST') {
        const nodeId = decodeURIComponent(ticketMatch[1])
        const allowed = cockpit ? COCKPIT_NODE.id : 'cloud:self'
        const recordTicket = (ok, reason) => {
          if (!cockpit) return
          pushCockpitEvidence(cockpitStats.tickets, { at: now(), nodeId, ok, ...(reason ? { reason } : {}) })
        }
        if (nodeId !== allowed) {
          recordTicket(false, 'unknown-node')
          json(res, 409, { error: { code: 'node-not-connectable', message: 'unknown node' } })
          return
        }
        if (cockpit && !cockpitNodeConnectable()) {
          // 冷启动窗口：容器还没起来（真 Hub 是同义的 409，App 要继续等/重试）
          recordTicket(false, 'cockpit-starting')
          json(res, 409, { error: { code: 'node-not-connectable', message: 'cockpit starting' } })
          return
        }
        if (user.instance !== 'running') {
          recordTicket(false, 'instance-not-running')
          json(res, 409, { error: { code: 'instance-not-running', message: 'instance is not running' } })
          return
        }
        const ticket = random('tk_')
        tickets.set(ticket, {
          username: record.username,
          nodeId,
          expiresAt: now() + 30_000,
          ...(record.scope ? { scope: record.scope } : {}),
        })
        recordTicket(true)
        json(res, 200, { ticket, expiresAt: iso(now() + 30_000) })
        return
      }
    }

    json(res, 404, { error: { code: 'INVALID_REQUEST', message: `no route ${path}` } })
  } catch (error) {
    console.error('[mock-hub] request failed:', error)
    if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL', message: 'mock failed' } })
  }
})

// ── WebSocket 升级 ──────────────────────────────────────────────────────────

/**
 * e2e 钩子（0.4.1 连接 UX）：`POST /__test/hold {ms}` 让接下来的 WS 升级**挂起**，
 * 模拟「后端一直连不上」（客户端停在 connecting/reconnecting，收不到握手）。
 *
 * `ms: 0` 释放：把挂着的 socket **直接掐掉**（不补升级），让客户端走正常的重连退避 —
 * 比把积压的握手全部放行更接近真实恢复，也不会一次冒出好几条通道。
 */
let holdUpgradeMs = 0
const heldUpgrades = new Set()

function flushHeldUpgrades() {
  for (const entry of [...heldUpgrades]) {
    clearTimeout(entry.timer)
    heldUpgrades.delete(entry)
    entry.socket.destroy()
  }
}

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const match = url.pathname.match(/^\/api\/mobile\/nodes\/([^/]+)\/channel$/)
  if (!match) {
    socket.destroy()
    return
  }
  const nodeId = decodeURIComponent(match[1])
  const ticket = url.searchParams.get('ticket') ?? ''
  const record = tickets.get(ticket)
  tickets.delete(ticket)
  if (!record || record.nodeId !== nodeId || record.expiresAt < now()) {
    socket.destroy()
    return
  }
  // 座舱令牌（WP56d）：实例恒 running（docs/24 §5），走单独的假状态
  const user = record.scope === 'cockpit' ? cockpitUser() : userFor(record.username)
  if (user.instance !== 'running') {
    socket.destroy()
    return
  }
  const accept = () => {
    if (socket.destroyed) return
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, user)
      })
    } catch (error) {
      socket.destroy()
    }
  }
  if (holdUpgradeMs > 0) {
    // 挂起期间客户端可能主动放弃（关掉 socket）：静默接住，别让 mock 进程抛错。
    socket.on('error', () => {})
    const entry = {
      socket,
      timer: setTimeout(() => {
        heldUpgrades.delete(entry)
        accept()
      }, holdUpgradeMs),
    }
    heldUpgrades.add(entry)
    return
  }
  accept()
})

wss.on('connection', (ws, _req, user) => {
  const channel = new Channel(ws, user)
  ws.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      channel.close(1008)
      return
    }
    if (frame?.v !== PROTOCOL_VERSION || typeof frame?.type !== 'string') {
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'error',
        requestId: typeof frame?.requestId === 'string' ? frame.requestId : undefined,
        code: 'protocol-version-unsupported',
        message: '协议版本不符',
        retryable: false,
      })
      channel.close(1008)
      return
    }
    try {
      handleClientFrame(channel, frame)
    } catch (error) {
      console.error('[mock-hub] frame failed:', error)
      sendFrame(channel, {
        v: PROTOCOL_VERSION,
        type: 'error',
        requestId: typeof frame.requestId === 'string' ? frame.requestId : undefined,
        code: 'internal',
        message: 'mock 处理失败',
        retryable: true,
      })
    }
  })
  ws.on('close', () => {
    channel.closed = true
    user.channels.delete(channel)
  })
  ws.on('error', () => {
    channel.closed = true
    user.channels.delete(channel)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[mock-hub] listening on http://${HOST}:${PORT} (tick=${TICK_MS}ms, wake=${WAKE_MS}ms)`)
  console.log('[mock-hub] accounts: demo/demo1234, pending, disabled, changepw, ratelimit')
})
