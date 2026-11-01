/**
 * 流式朗读播放器（0.4.6 / WP51；0.4.7 改为**自适应切段**）。
 *
 * 与 0.4.3 的整段播放器（`tts-player.ts`）并存：`bootstrap.voice.tts.stream === true`
 * 的新 Hub 走这里，老 Hub 继续用整段播放器。两条路的快照/停止语义完全一致（都实现
 * `TtsController`），界面不需要知道当前是哪一种。
 *
 * 为什么这一段是流式的：
 *  - 星汐的合成引擎本身是流式的（首块约 0.2 秒），整段接口要等整段合成完才出声；
 *  - 真实测下来合成速率 r（音频秒 / 墙钟秒）在 0.90（GPU 被占）到 1.03–1.04 之间，
 *    语速约 5.4–5.6 字/秒，所以固定 0.8 秒预缓冲对长段不够，会到后半段断音。
 *
 * 0.4.7 为什么改成「逐段规划」（而不是开始时一次性切完）：
 *  - r<1 时总等待 ≈ (1/r−1)×全文时长是**守恒**的，切段只决定等待落在开头还是段间；
 *    段 i 前的停顿 ≈ D_i×(1/r−1)（D_i 是该段音频时长）。r≥1 时没有取舍，段越大接缝越少。
 *  - 所以开始时只把全文切成「句子单元」（并记下每句后面是不是段落边界），每次要请求下一段
 *    时用纯函数 {@link planNextSegment} 按**此刻的速率**现场决定装几句：
 *      首段：用上次朗读持久化的 r̂ 压到 FIRST_MIN–FIRST_MAX（开口快，又不至于短到吞字）；
 *      后续：用本次已测到的 r 算 GAP_SENTENCE 预算（段间停顿 ≈0.6 秒），若下一处是段落
 *            边界、且 GAP_PARAGRAPH 预算仍允许，就装到段落边界（停顿落在段落处更自然）；
 *            剩下的文字不多时一次装完，避免小尾巴多一道接缝。
 *  - 每段开播前的缓冲仍是 `max(0.8s, D×(1/r−1)+0.3s)`；underrun 恢复逻辑不变。
 *  - 本次朗读测到的 r 在结束时以 EWMA(α=0.5) 写回本地存储，下次的首段直接用它
 *    （钳在 RATE_MIN–RATE_MAX，防止一次抖动把下次的开口预算带偏）。
 *
 * 其余三件事没有变：
 *  1. **自适应抖动缓冲**：按本段字数估时长 D ≈ 字数 / 5.6，实时测生成速率 r
 *     （已收音频秒数 / 首块之后的时间），开始播放前攒够
 *     `max(0.8s, D×(1/r−1)+0.3s)`；这样一段内部不会断。
 *  2. **排程时间轴**：收到的 PCM 立即按 ~150ms 一个 `AudioBuffer` 排在音频时钟上
 *     （`start(when)` 首尾相接），段与段之间不重新起播，所以段内/段间都没有接缝。
 *  3. **整篇一致的电平**：开头丢掉首字之前的静音、按第一秒有声部分定增益（只降不升），
 *     段尾裁掉静音后统一补 220ms 停顿（与 0.4.4 的 `speech-level.ts` 同一口径）。
 *
 * 并发：同一时间只有一条流（服务端本来就串行）。上一段的流**下载完成**（不是播放完成）
 * 就立刻规划并请求下一段，让下一段的数据在上一段播完之前到达。
 *
 * 全部依赖注入（流接收、音频出口、计时、睡眠）：单测在 node 里跑真状态机
 * （见 test/tts-stream-player.test.ts），浏览器实现见 lib/tts-audio.ts 的
 * `createTtsStreamSink()`。诊断只记段数/字数/时长/速率/等待时间，**不记文字**。
 */

import {
  joinSpeechSentences,
  markdownToSpeechText,
  splitLongSentence,
  splitSpeechSentences,
} from './speech-text'
import {
  TTS_CACHE_BYTES,
  TTS_TEXT,
  ttsErrorCode,
  ttsRetryDelayMs,
  type TtsController,
  type TtsPhase,
  type TtsPlayInput,
  type TtsSnapshot,
  type TtsStopReason,
} from './tts-player'
import type { TtsStreamSink } from './tts-audio'

// ── 切段（0.4.7 自适应）────────────────────────────────────────────────────

/** 首段开口预算（秒）：从这里扣掉抗抖动余量，就是首段能等多少。 */
export const TTS_OPEN_BUFFER_SEC = 0.8
/** 首段下限（字）：太短会被 Breeze 吞字（首句之后仍按上限继续装）。 */
export const TTS_FIRST_MIN_CHARS = 20
/** 首段上限（字）：决定「点朗读」到听见第一声的等待时间。 */
export const TTS_FIRST_MAX_CHARS = 80
/** 后续段下限（字）：r 很慢时也别切得比这更碎（接缝本身也是成本）。 */
export const TTS_SEGMENT_MIN_CHARS = 60
/** 后续段上限（字）：实际上限再与服务端 maxChars 取 min（Hub 是 200）。 */
export const TTS_SEGMENT_MAX_CHARS = 200
/** 段间停顿预算（秒，句子边界）：r<1 时用来反推这一段能装多少字。 */
export const TTS_GAP_SENTENCE_SEC = 0.6
/** 段间停顿预算（秒，段落边界）：停顿落在段落处更自然，可以多等一点。 */
export const TTS_GAP_PARAGRAPH_SEC = 1.0
/** 收尾合并：剩余文字 ≤ min(上限, 上限×这个系数) 时一次装完。 */
export const TTS_TAIL_MERGE_RATIO = 1.25

// ── 抖动缓冲 ────────────────────────────────────────────────────────────────

/** 星汐的正常语速（字/秒）：估计「这一段大概多长音频」用（实测 5.6）。 */
export const TTS_CHARS_PER_SECOND = 5.6
/** 还没测出速率时的保守值：实测 0.89–0.91，按 0.88 多攒一点。 */
export const TTS_ASSUMED_RATE = 0.88
/** 攒到这么多音频之后才开始估速率（秒）。 */
export const TTS_RATE_WINDOW_SEC = 0.5
/** 速率估计的合理区间（防御：网络抖动不能推出 0 或 10 倍速）。 */
export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 1.2
/** 起始缓冲下限（秒）：再快也要先攒这么多，避免开头就断。 */
export const TTS_START_BUFFER_SEC = TTS_OPEN_BUFFER_SEC
/** 抗抖动余量（秒）：扣掉预计落后之后还要留一点。 */
export const TTS_BUFFER_MARGIN_SEC = 0.3
/** underrun 之后至少再攒这么多才继续（秒）。 */
export const TTS_RESUME_BUFFER_SEC = 0.5
/** 排程提前量（秒）：给音频线程留一点启动时间。 */
export const TTS_SCHEDULE_LEAD_SEC = 0.05

// ── 音频整形 ────────────────────────────────────────────────────────────────

/** 每个 `AudioBuffer` 的时长（毫秒）：契约要求的 100–200ms。 */
export const TTS_BLOCK_MS = 150
/** 段尾留存（毫秒）：段尾静音要等「知道段结束了」才能裁，先留一段不排程。 */
export const TTS_TAIL_KEEP_MS = 500
/** 段尾统一停顿（毫秒，与 0.4.4 的 speech-level 一致）。 */
export const TTS_TAIL_PAUSE_MS = 220
/** 首尾静音裁剪的余量（毫秒）：不切到字头字尾。 */
export const TTS_SILENCE_MARGIN_MS = 30
/** 增益估计窗口（毫秒）。 */
export const TTS_GAIN_WINDOW_MS = 1_000
/** 目标响度（有声部分 RMS，dBFS）。 */
export const TTS_TARGET_DB = -20
/** 增益上下限（与 speech-level 一致）。 */
export const TTS_MIN_GAIN = 0.5
export const TTS_MAX_GAIN = 4
/** 峰值上限：增益 × 峰值超过它就降增益（只降不升）。 */
export const TTS_PEAK_LIMIT = 0.95
/** 低于这个电平的 10ms 帧算静音（与 speech-level 同口径）。 */
export const TTS_SILENCE_DB = -45
/** 有声帧的门限比静音门限高这么多 dB（响度只按明显有声的部分算）。 */
const VOICED_DB_OFFSET = 15

/** 一段可排程的 PCM（单声道，[-1,1]）。 */
export interface PcmBlock {
  samples: Float32Array
  sampleRate: number
  /** 属于第几段（播放器内部标；诊断段间等待用，外面构造的块可以不填）。 */
  segment?: number
}

/** 流式合成的结果（与 core 的 `TtsStream` 同形；这里不依赖 core 的类型，方便单测）。 */
export interface TtsStreamInfo {
  sampleRate: number
  voice: string
  cached: boolean
  chunks: AsyncIterable<Uint8Array>
}

// ── 纯函数：速率与缓冲 ──────────────────────────────────────────────────────

/** RMS → dBFS。 */
export function dbOfRms(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-9))
}

/**
 * 估计生成速率 r（音频秒 / 真实秒）：
 *  - 至少要有 {@link TTS_RATE_WINDOW_SEC} 秒音频才敢估计（首块之前 r 没有意义）；
 *  - 否则用保守值 {@link TTS_ASSUMED_RATE}；
 *  - 结果钳在 {@link TTS_RATE_MIN}–{@link TTS_RATE_MAX}。
 */
export function estimateStreamRate(input: {
  receivedSeconds: number
  elapsedMs: number
  assumed?: number
}): number {
  const assumed = input.assumed ?? TTS_ASSUMED_RATE
  if (input.receivedSeconds < TTS_RATE_WINDOW_SEC || input.elapsedMs <= 0) return assumed
  const measured = input.receivedSeconds / (input.elapsedMs / 1_000)
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, measured))
}

/**
 * 开始播放前要攒多少秒音频（自适应抖动缓冲）。
 *
 * `D ≈ 字数 / 5.6` 是这一段的预计时长。生成速率 r<1 时，播放（1 倍速）会逐渐追上下载，
 * 到段尾会落后 `D×(1/r−1)` 秒；再加上 0.3 秒抗抖动余量，就是最小的起始缓冲。
 * r≥1（下载跟得上）时只剩下限 0.8 秒。
 */
export function streamBufferSeconds(
  chars: number,
  rate: number,
  options: {
    charsPerSecond?: number
    startBufferSec?: number
    marginSec?: number
  } = {},
): number {
  const charsPerSecond = Math.max(0.5, options.charsPerSecond ?? TTS_CHARS_PER_SECOND)
  const safeRate = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate || TTS_ASSUMED_RATE))
  const estimatedSec = Math.max(0, chars) / charsPerSecond
  const lagSec = estimatedSec * (1 / safeRate - 1)
  return Math.max(
    options.startBufferSec ?? TTS_START_BUFFER_SEC,
    lagSec + (options.marginSec ?? TTS_BUFFER_MARGIN_SEC),
  )
}

// ── 纯函数：句子单元与逐段规划 ──────────────────────────────────────────────

const charLen = (text: string): number => Array.from(text).length

/** 一个「句子单元」：一句话 + 它后面是不是段落边界。 */
export interface SpeechUnit {
  /** 一句话（Markdown 已去掉，按句末标点/换行切好）。 */
  text: string
  /** 这一句后面是段落边界（换行）：段间停顿落在段落处更自然。 */
  paragraphEnd: boolean
}

export interface PlanNextSegmentOptions {
  /** 是不是首段：首段用 FIRST_* 与开口预算，后续段用 SEGMENT_* 与段间停顿预算。 */
  first: boolean
  /** 规划用的速率 r（音频秒/墙钟秒）：首段传持久化的 r̂，后续段传本次实测（EWMA）。 */
  rate: number
  /** 服务端单段上限（bootstrap.voice.tts.maxChars），默认 200。 */
  serverMaxChars?: number
  /** 估时长用的语速（字/秒），默认 5.6。 */
  charsPerSecond?: number
}

export interface SegmentPlan {
  /** 这一段的文字（已拼好，不超过服务端上限）。 */
  text: string
  chars: number
  /** 规划时用的字数上限（收尾合并时字数可以略超这个值）。 */
  cap: number
  /** 规划时用的速率（诊断/测试）。 */
  rate: number
  /** 这一段装了几「句」（被切开的一句话算一个片段）。 */
  units: number
  /** 段尾是否落在段落边界上。 */
  paragraphEnd: boolean
  /** 剩下的句子单元（可能含被切开那句话的后半段）。 */
  rest: SpeechUnit[]
}

/**
 * 把一条回复切成「句子单元」：Markdown → 可朗读纯文本 → 每个非空行按句末标点切句。
 *
 * `markdownToSpeechText` 会把连续空行并成一个换行，所以**每个非空行就是一段**，
 * 行内最后一句后面就是段落边界（`\n\n` 与单个换行在这里是同一件事）。
 */
export function buildSpeechUnits(text: string): SpeechUnit[] {
  const speech = markdownToSpeechText(text)
  if (speech.length === 0) return []
  const units: SpeechUnit[] = []
  for (const line of speech.split('\n')) {
    const sentences = splitSpeechSentences(line)
    for (let index = 0; index < sentences.length; index += 1) {
      units.push({ text: sentences[index]!, paragraphEnd: index === sentences.length - 1 })
    }
  }
  return units
}

/** 规划用的 r 钳在合理区间：离谱的速率会让上限退化成 0/无穷。 */
function planRateOf(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return TTS_ASSUMED_RATE
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate))
}

/**
 * 首段上限：r̂≥1 时没有取舍，直接取 FIRST_MAX；r̂<1 时开口预算（0.8−0.3 秒）能盖住
 * `字数/5.6×(1/r̂−1)` 的落后，反推出能装多少字，再钳到 FIRST_MIN–FIRST_MAX。
 */
function firstSegmentCap(rate: number, serverMax: number, charsPerSecond: number): number {
  const max = Math.min(serverMax, TTS_FIRST_MAX_CHARS)
  const min = Math.min(TTS_FIRST_MIN_CHARS, max)
  const safe = planRateOf(rate)
  if (safe >= 1) return max
  const roomSec = Math.max(0, TTS_OPEN_BUFFER_SEC - TTS_BUFFER_MARGIN_SEC)
  const chars = Math.floor((roomSec / (1 / safe - 1)) * charsPerSecond)
  return Math.max(min, Math.min(max, chars))
}

/** 后续段上限：句子边界用 GAP_SENTENCE；段落边界可以放宽到 GAP_PARAGRAPH。 */
function laterSegmentCaps(
  rate: number,
  serverMax: number,
  charsPerSecond: number,
): { cap: number; paragraphCap: number } {
  const max = Math.min(serverMax, TTS_SEGMENT_MAX_CHARS)
  const min = Math.min(TTS_SEGMENT_MIN_CHARS, max)
  const safe = planRateOf(rate)
  if (safe >= 1) return { cap: max, paragraphCap: max }
  const lagPerSec = 1 / safe - 1
  const cap = Math.max(min, Math.min(max, Math.floor((TTS_GAP_SENTENCE_SEC / lagPerSec) * charsPerSecond)))
  const paragraph = Math.max(
    min,
    Math.min(max, Math.floor((TTS_GAP_PARAGRAPH_SEC / lagPerSec) * charsPerSecond)),
  )
  return { cap, paragraphCap: Math.max(cap, paragraph) }
}

/**
 * 收尾合并的上限（字）：`min(策略上限, 上限×1.25)`，但 r<1 时还要受「这一段自己的预缓冲会变成
 * 多长的缝」约束 —— 合并出来的段比 cap 大，它的预缓冲 `D×(1/r−1)` 会整段变成上一段结束后的
 * 静音；超过 GAP_PARAGRAPH 就没有「避免多一道接缝」的意义了（宁可让最后一个小尾巴单独一段，
 * 它的预缓冲只有 0.8 秒、通常直接接在上一段后面）。r≥1 时没有这个顾虑，按原规则合并。
 */
function tailMergeChars(
  rate: number,
  cap: number,
  planMax: number,
  charsPerSecond: number,
): number {
  const merged = Math.min(planMax, Math.floor(cap * TTS_TAIL_MERGE_RATIO))
  if (rate >= 1) return Math.max(cap, merged)
  const allowed = Math.floor((TTS_GAP_PARAGRAPH_SEC / (1 / rate - 1)) * charsPerSecond)
  return Math.max(cap, Math.min(merged, allowed))
}

function unitsChars(units: readonly SpeechUnit[]): number {
  let total = 0
  for (const unit of units) total += charLen(unit.text)
  return total
}

function joinUnits(units: readonly SpeechUnit[]): string {
  return units.reduce((text, unit) => joinSpeechSentences(text, unit.text), '')
}

/**
 * 规划下一段（纯函数）：调用方每次要请求下一段时，拿剩下的句子单元现场算一次。
 *
 * 规则（与任务包 0.4.7 一致）：
 *  1. 首段：r̂≥1 → FIRST_MAX；否则用开口预算反推上限（FIRST_MIN–FIRST_MAX）。
 *     取不超过上限的最长整句前缀；第一句本身超上限时在逗号处切（`splitLongSentence`）。
 *     第一句很短时自然会把第二句装进来（上限允许的前提下），避免 Breeze 吞字。
 *  2. 后续段：上限由 GAP_SENTENCE 预算反推（SEGMENT_MIN–SEGMENT_MAX，且 ≤ 服务端 maxChars）。
 *     贪心按整句装满；如果停在了段落中间，下一个段落边界仍落在 GAP_PARAGRAPH 预算内时
 *     延伸到那个段落边界（停顿落在段落处更自然）。单句超上限时按逗号切。
 *  3. 收尾合并：剩下 ≤ min(策略上限, 上限×1.25) 时一次装完，避免小尾巴多一道接缝。
 */
export function planNextSegment(
  units: readonly SpeechUnit[],
  options: PlanNextSegmentOptions,
): SegmentPlan | null {
  if (units.length === 0) return null
  const serverMax = Math.max(1, Math.floor(options.serverMaxChars ?? TTS_SEGMENT_MAX_CHARS))
  const charsPerSecond = Math.max(0.5, options.charsPerSecond ?? TTS_CHARS_PER_SECOND)
  const rate = planRateOf(options.rate)
  const planMax = options.first
    ? Math.min(serverMax, TTS_FIRST_MAX_CHARS)
    : Math.min(serverMax, TTS_SEGMENT_MAX_CHARS)
  const laterCaps = options.first ? null : laterSegmentCaps(rate, serverMax, charsPerSecond)
  const cap = options.first ? firstSegmentCap(rate, serverMax, charsPerSecond) : laterCaps!.cap
  const paragraphCap = laterCaps?.paragraphCap ?? cap

  // 3. 收尾合并：剩下的装得进「上限 ×1.25」就一次装完（还要受段落停顿预算约束，见 tailMergeChars）
  const tailCap = tailMergeChars(rate, cap, planMax, charsPerSecond)
  const remaining = unitsChars(units)
  if (remaining <= tailCap) {
    return {
      text: joinUnits(units),
      chars: remaining,
      cap,
      rate,
      units: units.length,
      paragraphEnd: units[units.length - 1]!.paragraphEnd,
      rest: [],
    }
  }

  // 1/2. 第一句本身就超过上限：在逗号处切，第一块当这一段，其余放回队列
  const head = units[0]!
  if (charLen(head.text) > cap) {
    const pieces = splitLongSentence(head.text, cap)
    const first = pieces[0]!
    const leftoverText = pieces.slice(1).reduce((text, piece) => joinSpeechSentences(text, piece), '')
    const rest: SpeechUnit[] = []
    if (leftoverText.length > 0) {
      rest.push({ text: leftoverText, paragraphEnd: head.paragraphEnd })
    }
    rest.push(...units.slice(1))
    return {
      text: first,
      chars: charLen(first),
      cap,
      rate,
      units: 1,
      paragraphEnd: false,
      rest,
    }
  }

  // 贪心装整句：装到再加一句就超上限为止（首句已保证不超上限）
  let text = ''
  let count = 0
  for (const unit of units) {
    const joined = text.length === 0 ? unit.text : joinSpeechSentences(text, unit.text)
    if (charLen(joined) > cap) break
    text = joined
    count += 1
  }
  let paragraphEnd = units[count - 1]!.paragraphEnd
  if (!paragraphEnd && count < units.length) {
    // 停在段落中间：往后找到下一个段落边界，段落预算仍允许就延伸过去
    let extended = text
    let extendedCount = count
    let foundBoundary = false
    while (extendedCount < units.length) {
      extended = joinSpeechSentences(extended, units[extendedCount]!.text)
      extendedCount += 1
      if (units[extendedCount - 1]!.paragraphEnd) {
        foundBoundary = true
        break
      }
    }
    if (foundBoundary && charLen(extended) <= paragraphCap) {
      text = extended
      count = extendedCount
      paragraphEnd = true
    }
  }
  return {
    text,
    chars: charLen(text),
    cap,
    rate,
    units: count,
    paragraphEnd,
    rest: units.slice(count),
  }
}

/** 按同样的规划规则数一下总共要几段（只用于界面上的「第 n/m 段」，不影响请求）。 */
export function planSegmentCount(
  units: readonly SpeechUnit[],
  options: PlanNextSegmentOptions,
): number {
  let rest = [...units]
  let count = 0
  while (rest.length > 0 && count < 1_000) {
    const plan = planNextSegment(rest, { ...options, first: options.first && count === 0 })
    if (!plan) break
    rest = plan.rest
    count += 1
  }
  return count
}

// ── 纯函数：速率持久化（下次首段的 r̂）──────────────────────────────────────

/** 上次朗读速率的本地存储键（设备级：合成快慢是这台机器/Hub 的属性，不按账号分）。 */
export const TTS_RATE_STORAGE_KEY = 'dsh-hub:tts:rate:v1'
/** 持久化时对多次朗读的 r 做 EWMA 的系数：跟得上变化，又不会被一段的抖动带偏。 */
export const TTS_RATE_EWMA_ALPHA = 0.5

/** localStorage 的最小形状（单测注入内存实现）。 */
export interface TtsRateStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultRateStorage(): TtsRateStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 把 r 钳在 {@link TTS_RATE_MIN}–{@link TTS_RATE_MAX}（非有限值退回保守值）。 */
export function clampTtsRate(rate: number): number {
  if (!Number.isFinite(rate)) return TTS_ASSUMED_RATE
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate))
}

/** 把这次测到的 r 与上次持久化的 r̂ 做 EWMA（α=0.5），结果钳在 RATE_MIN–MAX。 */
export function blendTtsRate(previous: number | null | undefined, measured: number): number {
  const next = clampTtsRate(measured)
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return next
  const before = clampTtsRate(previous)
  return clampTtsRate(before * (1 - TTS_RATE_EWMA_ALPHA) + next * TTS_RATE_EWMA_ALPHA)
}

/** 读上次朗读持久化的 r̂；没有/坏数据/隐私模式一律返回 undefined（调用方用 0.88）。 */
export function readPersistedTtsRate(
  storage: TtsRateStorage | null = defaultRateStorage(),
): number | undefined {
  try {
    const raw = storage?.getItem(TTS_RATE_STORAGE_KEY)
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const parsed: unknown = JSON.parse(raw)
    const value =
      typeof parsed === 'number'
        ? parsed
        : parsed !== null && typeof parsed === 'object'
          ? (parsed as { rate?: unknown }).rate
          : undefined
    return typeof value === 'number' && Number.isFinite(value) ? clampTtsRate(value) : undefined
  } catch {
    return undefined
  }
}

/**
 * 把这次朗读测到的 r 写回本地存储（与上次的值做 EWMA），返回合并后的值。
 * 写入失败（隐私模式/配额满）不抛错，只在当次生效。
 */
export function persistTtsRate(
  measured: number,
  storage: TtsRateStorage | null = defaultRateStorage(),
): number {
  const next = blendTtsRate(readPersistedTtsRate(storage), measured)
  try {
    storage?.setItem(TTS_RATE_STORAGE_KEY, JSON.stringify({ rate: Number(next.toFixed(4)), at: Date.now() }))
  } catch {
    /* 隐私模式/配额满：下次重新估 */
  }
  return next
}

// ── 纯函数：静音裁剪与增益 ──────────────────────────────────────────────────

/** 一帧（10ms）的 RMS。 */
function frameRms(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i += 1) {
    const value = samples[i]!
    sum += value * value
  }
  return Math.sqrt(sum / count)
}

function frameCount(samples: Float32Array, frameSamples: number): number {
  return Math.floor(samples.length / frameSamples)
}

/**
 * 第一个「有声」帧的起始样本下标（-1 = 整段都没有声）。
 * 有声 = 10ms 帧的 RMS 高于静音门限（-45 dBFS）。
 */
export function findFirstVoicedSample(
  samples: Float32Array,
  frameSamples: number,
  silenceDb = TTS_SILENCE_DB,
): number {
  for (let frame = 0; frame < frameCount(samples, frameSamples); frame += 1) {
    const start = frame * frameSamples
    if (dbOfRms(frameRms(samples, start, start + frameSamples)) >= silenceDb) return start
  }
  return -1
}

/** 最后一个「有声」帧的结束样本下标（-1 = 整段都没有声）。 */
export function findLastVoicedEnd(
  samples: Float32Array,
  frameSamples: number,
  silenceDb = TTS_SILENCE_DB,
): number {
  for (let frame = frameCount(samples, frameSamples) - 1; frame >= 0; frame -= 1) {
    const start = frame * frameSamples
    if (dbOfRms(frameRms(samples, start, start + frameSamples)) >= silenceDb) {
      return start + frameSamples
    }
  }
  return -1
}

/** 去掉第一个有声帧之前的静音（保留 `marginMs` 余量）。整段没声时返回空数组。 */
export function trimLeadingSilence(
  samples: Float32Array,
  sampleRate: number,
  options: { marginMs?: number; silenceDb?: number } = {},
): Float32Array {
  const frameSamples = Math.max(1, Math.round(sampleRate / 100))
  const first = findFirstVoicedSample(samples, frameSamples, options.silenceDb ?? TTS_SILENCE_DB)
  if (first < 0) return samples
  const margin = Math.round(((options.marginMs ?? TTS_SILENCE_MARGIN_MS) / 1000) * sampleRate)
  const from = Math.max(0, first - margin)
  return from === 0 ? samples : samples.slice(from)
}

/** 裁掉最后一个有声帧之后的静音（保留 `marginMs` 余量）。整段没声时返回空数组。 */
export function trimTrailingSilence(
  samples: Float32Array,
  sampleRate: number,
  options: { marginMs?: number; silenceDb?: number } = {},
): Float32Array {
  const frameSamples = Math.max(1, Math.round(sampleRate / 100))
  const end = findLastVoicedEnd(samples, frameSamples, options.silenceDb ?? TTS_SILENCE_DB)
  if (end < 0) return new Float32Array(0)
  const margin = Math.round(((options.marginMs ?? TTS_SILENCE_MARGIN_MS) / 1000) * sampleRate)
  const to = Math.min(samples.length, end + margin)
  return to >= samples.length ? samples : samples.slice(0, to)
}

/**
 * 用一段音频估计朗读增益：只按「明显有声」的帧算 RMS（比静音门限高 15dB），
 * 拉到目标响度后钳在 0.5–4 倍；整段没声就给 1（不放大底噪）。
 */
export function estimateSpeechGain(
  samples: Float32Array,
  sampleRate: number,
  options: { targetDb?: number; silenceDb?: number } = {},
): number {
  const frameSamples = Math.max(1, Math.round(sampleRate / 100))
  const silenceDb = options.silenceDb ?? TTS_SILENCE_DB
  let sum = 0
  let count = 0
  for (let frame = 0; frame < frameCount(samples, frameSamples); frame += 1) {
    const start = frame * frameSamples
    const rms = frameRms(samples, start, start + frameSamples)
    if (dbOfRms(rms) < silenceDb + VOICED_DB_OFFSET) continue
    sum += rms * rms * frameSamples
    count += frameSamples
  }
  if (count === 0) return 1
  const voicedRms = Math.sqrt(sum / count)
  const targetDb = options.targetDb ?? TTS_TARGET_DB
  const gain = 10 ** ((targetDb - dbOfRms(voicedRms)) / 20)
  return Math.min(TTS_MAX_GAIN, Math.max(TTS_MIN_GAIN, gain))
}

// ── 单段整形器 ──────────────────────────────────────────────────────────────

export interface SegmentShaperOptions {
  sampleRate: number
  /** 每个 block 的时长（毫秒）。 */
  blockMs?: number
  /** 段尾留存（毫秒）。 */
  tailKeepMs?: number
  /** 段尾停顿（毫秒）。 */
  tailPauseMs?: number
  /** 首尾静音裁剪余量（毫秒）。 */
  marginMs?: number
  /** 增益估计窗口（毫秒）。 */
  gainWindowMs?: number
  /** 目标响度（dBFS）。 */
  targetDb?: number
}

const EMPTY_SAMPLES: Float32Array = new Float32Array(0)

/**
 * 把一段**陆续收到**的 PCM 整形为可排程的块：
 *
 *  收到样本 ──► 去掉开头静音（第一个有声帧前留 30ms）──► 定增益（开头 1 秒）
 *           ──► 按 blockMs 切块、套增益/峰值限制 ──► 排程
 *   末尾 0.5 秒先留着（`finish()` 时裁掉段尾静音 + 补 220ms 停顿）
 *
 * 增益只降不升：某一块的峰值乘上当前增益会超过 0.95 时，把增益降到刚好不削波。
 */
export class SegmentShaper {
  readonly sampleRate: number
  private readonly blockSamples: number
  private readonly tailKeepSamples: number
  private readonly pauseSamples: number
  private readonly marginSamples: number
  private readonly gainWindowSamples: number
  private readonly frameSamples: number
  private readonly targetDb: number
  /** 还没排程的样本（可能包含开头静音与段尾留存）。 */
  private raw: Float32Array = EMPTY_SAMPLES
  /** 'lead'：还在找第一个有声帧；'gain'：在攒增益窗口；'stream'：正常出块；'done'：段结束。 */
  private state: 'lead' | 'gain' | 'stream' | 'done' = 'lead'
  private gain: number | null = null

  constructor(options: SegmentShaperOptions) {
    this.sampleRate = Math.max(1, Math.round(options.sampleRate))
    const perMs = this.sampleRate / 1_000
    this.blockSamples = Math.max(1, Math.round((options.blockMs ?? TTS_BLOCK_MS) * perMs))
    this.tailKeepSamples = Math.max(0, Math.round((options.tailKeepMs ?? TTS_TAIL_KEEP_MS) * perMs))
    this.pauseSamples = Math.max(0, Math.round((options.tailPauseMs ?? TTS_TAIL_PAUSE_MS) * perMs))
    this.marginSamples = Math.max(0, Math.round((options.marginMs ?? TTS_SILENCE_MARGIN_MS) * perMs))
    this.gainWindowSamples = Math.max(1, Math.round((options.gainWindowMs ?? TTS_GAIN_WINDOW_MS) * perMs))
    this.frameSamples = Math.max(1, Math.round(this.sampleRate / 100))
    this.targetDb = options.targetDb ?? TTS_TARGET_DB
  }

  /** 已经收到但还没排程的音频（秒）：包含段尾留存。 */
  get bufferedSeconds(): number {
    return this.raw.length / this.sampleRate
  }

  /** 当前增益（没估计出来之前是 1）。 */
  get gainValue(): number {
    return this.gain ?? 1
  }

  get finished(): boolean {
    return this.state === 'done'
  }

  /** 收到一块样本，返回**现在就能排**的块（段尾留存与不足一块的余数留在内部）。 */
  push(samples: Float32Array): PcmBlock[] {
    if (samples.length === 0 || this.state === 'done') return []
    this.raw = concatSamples(this.raw, samples)
    if (this.state === 'lead') {
      const first = findFirstVoicedSample(this.raw, this.frameSamples)
      if (first < 0) {
        // 整段开头一直是静音：只留最近一段（真整段静音时 `finish()` 会整段丢掉）
        if (this.raw.length > this.tailKeepSamples) {
          this.raw = this.raw.slice(this.raw.length - Math.max(1, this.tailKeepSamples))
        }
        return []
      }
      this.raw = this.raw.slice(Math.max(0, first - this.marginSamples))
      this.state = 'gain'
    }
    if (this.state === 'gain' && this.raw.length >= this.gainWindowSamples) {
      this.gain = estimateSpeechGain(this.raw, this.sampleRate, { targetDb: this.targetDb })
      this.state = 'stream'
    }
    if (this.state !== 'stream') return []
    return this.emit(this.tailKeepSamples)
  }

  /**
   * 开始播放前调用：用已经收到的音频定增益（不再等满 1 秒）。
   * 排队条件满足得越早，用户等得越少。
   */
  begin(): void {
    if (this.state === 'lead') {
      // 还没听到有声帧就开播：没有可裁的开头静音，直接进入正常出块
      this.state = 'gain'
    }
    this.commitGain()
  }

  /**
   * 保命：把留存的尾巴也排出去（播放器快断粮时用）。
   * 代价是这一段最后 0.5 秒的静音可能裁不掉了 —— 相比「断音」可以接受。
   */
  releaseTail(): PcmBlock[] {
    if (this.state === 'lead') return []
    this.commitGain()
    return this.emit(0)
  }

  /** 段结束：裁掉段尾静音（留 30ms）、补 220ms 停顿，把剩下的全部排出。 */
  finish(): PcmBlock[] {
    if (this.state === 'done') return []
    const wasLead = this.state === 'lead'
    this.commitGain()
    if (!wasLead) {
      const end = findLastVoicedEnd(this.raw, this.frameSamples)
      this.raw = end < 0 ? EMPTY_SAMPLES : this.raw.slice(0, Math.min(this.raw.length, end + this.marginSamples))
    } else {
      // 整段都是静音：没有可读的内容，只留段尾停顿（保持时间轴连续）
      this.raw = EMPTY_SAMPLES
    }
    const blocks = this.emit(0)
    this.state = 'done'
    if (this.pauseSamples > 0) {
      blocks.push({ samples: new Float32Array(this.pauseSamples), sampleRate: this.sampleRate })
    }
    return blocks
  }

  private commitGain(): void {
    if (this.gain !== null) return
    if (this.state === 'lead' || this.raw.length === 0) {
      this.gain = 1
      if (this.state === 'lead') this.state = 'gain'
      return
    }
    this.gain = estimateSpeechGain(this.raw, this.sampleRate, { targetDb: this.targetDb })
    this.state = 'stream'
  }

  /** 按 blockMs 切块排出，内部保留最后 `keepSamples` 个样本。 */
  private emit(keepSamples: number): PcmBlock[] {
    const blocks: PcmBlock[] = []
    let offset = 0
    for (;;) {
      const available = this.raw.length - offset - keepSamples
      if (available < this.blockSamples) break
      blocks.push(this.shape(this.raw.subarray(offset, offset + this.blockSamples)))
      offset += this.blockSamples
    }
    if (offset > 0) this.raw = this.raw.slice(offset)
    return blocks
  }

  /** 套增益 + 峰值限制（只降不升），输出新数组（不共享底层 buffer）。 */
  private shape(samples: Float32Array): PcmBlock {
    let peak = 0
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.abs(samples[i]!)
      if (value > peak) peak = value
    }
    let gain = this.gain ?? 1
    if (peak * gain > TTS_PEAK_LIMIT) {
      const limited = TTS_PEAK_LIMIT / Math.max(peak, 1e-9)
      if (limited < gain) {
        gain = limited
        this.gain = limited
      }
    }
    const out = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i]! * gain
      out[i] = value > 1 ? 1 : value < -1 ? -1 : value
    }
    return { samples: out, sampleRate: this.sampleRate }
  }
}

function concatSamples(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) return right
  const merged = new Float32Array(left.length + right.length)
  merged.set(left, 0)
  merged.set(right, left.length)
  return merged
}

// ── 整段缓存 ────────────────────────────────────────────────────────────────

export interface TtsPcmEntry {
  /** 原始 PCM16 小端字节（没有 WAV 头）。 */
  pcm: Uint8Array
  sampleRate: number
  voice: string
}

/**
 * 已**完整下载**的段的缓存（LRU，按字节，上限复用整段播放器的 30MB）。
 *
 * key 是「音色 + 文本」：同样的音色、同样的文字永远合成出同样的音频；换音色不会串音。
 * 命中后重读不再请求，但仍走一遍整形（消音/增益/停顿），保证和流式听到的一模一样。
 */
export class TtsPcmCache {
  private readonly limit: number
  private readonly entries = new Map<string, { entry: TtsPcmEntry; bytes: number }>()
  private used = 0

  constructor(limitBytes: number = TTS_CACHE_BYTES) {
    this.limit = Math.max(0, limitBytes)
  }

  static keyOf(text: string, voice?: string): string {
    return `${voice ?? ''}\u0000${text}`
  }

  get bytes(): number {
    return this.used
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): TtsPcmEntry | null {
    const found = this.entries.get(key)
    if (!found) return null
    this.entries.delete(key)
    this.entries.set(key, found)
    return found.entry
  }

  set(key: string, entry: TtsPcmEntry): void {
    const bytes = entry.pcm.byteLength
    if (bytes > this.limit) return
    const existing = this.entries.get(key)
    if (existing) {
      this.used -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, { entry, bytes })
    this.used += bytes
    for (const [oldKey, old] of this.entries) {
      if (this.used <= this.limit) break
      this.entries.delete(oldKey)
      this.used -= old.bytes
    }
  }

  clear(): void {
    this.entries.clear()
    this.used = 0
  }
}

// ── 播放器 ──────────────────────────────────────────────────────────────────

export interface TtsStreamPlayerOptions {
  /** 发起一条流（HubClient.synthesizeStream / MockHub.synthesizeStream）。 */
  synthesizeStream: (input: {
    text: string
    voice?: string
    signal?: AbortSignal
  }) => Promise<TtsStreamInfo>
  /** 音频出口（Web Audio）；第一次 `start()` 时在用户手势里创建。 */
  sink: () => TtsStreamSink
  /** 服务端单段上限（bootstrap.voice.tts.maxChars）；默认 200（见 TTS_SEGMENT_MAX_CHARS）。 */
  maxChars?: number | (() => number | undefined)
  /** 估时长用的语速（字/秒）。 */
  charsPerSecond?: number
  /** 读上次朗读持久化的速率 r̂（默认 localStorage；单测可注入）。 */
  loadRate?: () => number | undefined
  /** 朗读结束时持久化本次实测 r（默认 localStorage；单测可注入）。返回合并后的 r̂。 */
  saveRate?: (rate: number) => number
  /** 起始缓冲下限（秒）；测试可调小。 */
  startBufferSec?: number
  /** 抗抖动余量（秒）。 */
  bufferMarginSec?: number
  /** underrun 之后至少再攒多少（秒）。 */
  resumeBufferSec?: number
  /** 段缓存（默认新建；测试注入同一个实例断言命中）。 */
  cache?: TtsPcmCache
  /** 429 重试前等待（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>
  /** 墙钟（毫秒）：诊断与速率估计用。 */
  now?: () => number
  onSnapshot?: (snapshot: TtsSnapshot) => void
  /** 轻提示（502/网络中断/没有可读内容）。 */
  onNotice?: (text: string) => void
  onDiag?: (name: string, detail?: string) => void
}

/** 一段的接收状态（速率估计与缓冲判定都按段算）。 */
interface SegmentState {
  index: number
  chars: number
  /** 规划这一段时用的上限与速率（诊断用）。 */
  cap: number
  plannedRate: number
  /** 这一段的音频来自缓存（缓存命中不参与速率测量）。 */
  fromCache: boolean
  sampleRate: number
  firstChunkAt: number | null
  /** 第一个块带的音频秒数（首块是「一次性」的，估速率时要扣掉，否则会高估）。 */
  firstChunkSeconds: number
  /** 已经收到的音频秒数（含开头静音、含段尾留存）。 */
  receivedSeconds: number
  /** 已经排进队列的音频秒数。 */
  queuedSeconds: number
  /** 是否已经放出第一块（缓冲条件满足）。 */
  released: boolean
  /** 下载结束时的实测 r（缓存段/测不到 = null）。 */
  measuredRate: number | null
  /** 下载是否结束（tts:plan 诊断要等这一刻）。 */
  downloadDone: boolean
  /** 这一段的 tts:plan 诊断是否已经记过。 */
  diagDone: boolean
}

interface ActivePlay {
  key: string
  voice: string | undefined
  /** 还没规划的句子单元：每请求一段就消耗一部分（逐段规划，不再一次性切完）。 */
  units: SpeechUnit[]
  chars: number
  /** 预计段数（只给界面显示「第 n/m 段」，会随实测速率变化）。 */
  total: number
}

class TtsStopped extends Error {
  constructor() {
    super('tts-stopped')
    this.name = 'TtsStopped'
  }
}

export class TtsStreamPlayer implements TtsController {
  private readonly options: TtsStreamPlayerOptions
  private readonly cache: TtsPcmCache
  private readonly maxCharsOf: () => number | undefined
  private readonly charsPerSecond: number
  private readonly startBufferSec: number
  private readonly bufferMarginSec: number
  private readonly resumeBufferSec: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly loadRate: () => number | undefined
  private readonly saveRate: (rate: number) => number
  private sink: TtsStreamSink | null = null

  private generation = 0
  private active: ActivePlay | null = null
  private phase: TtsPhase = 'idle'
  private currentSegment = 0
  private startedAt = 0
  private controller: AbortController | null = null
  private shaper: SegmentShaper | null = null
  private segment: SegmentState | null = null
  /** 段内还没放出来的块（等缓冲条件）。 */
  private held: PcmBlock[] = []
  /** 可排程的块（跨段按顺序）。 */
  private queue: PcmBlock[] = []
  private queueSeconds = 0
  private leftover: Uint8Array | null = null
  private started = false
  private ended = false
  private failure: unknown = null
  /** 正在等下一段的缓冲（计划内的停顿，不算 underrun）。 */
  private buffering = false
  /** 本次朗读开始时的 r̂（上次持久化的速率；没有则 0.88）。 */
  private priorRate = TTS_ASSUMED_RATE
  /** 本次朗读已测到的 r 的 EWMA（α=0.5）；还没测到 = null，用 r̂ 规划。 */
  private sessionRate: number | null = null
  /** 段序号 → 段间实际静音（毫秒），消费者排到该段第一块时记。 */
  private readonly seamMs = new Map<number, number>()
  /** 下载已结束、等段间静音测出来才能记 tts:plan 的段。 */
  private readonly pendingDiags = new Map<number, SegmentState>()

  constructor(options: TtsStreamPlayerOptions) {
    this.options = options
    this.cache = options.cache ?? new TtsPcmCache()
    const pick = (
      value: number | (() => number | undefined) | undefined,
    ): (() => number | undefined) => (typeof value === 'function' ? value : () => value)
    this.maxCharsOf = pick(options.maxChars)
    this.charsPerSecond = Math.max(0.5, options.charsPerSecond ?? TTS_CHARS_PER_SECOND)
    this.startBufferSec = Math.max(0, options.startBufferSec ?? TTS_START_BUFFER_SEC)
    this.bufferMarginSec = Math.max(0, options.bufferMarginSec ?? TTS_BUFFER_MARGIN_SEC)
    this.resumeBufferSec = Math.max(0, options.resumeBufferSec ?? TTS_RESUME_BUFFER_SEC)
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Date.now())
    this.loadRate = options.loadRate ?? (() => readPersistedTtsRate())
    this.saveRate = options.saveRate ?? ((rate) => persistTtsRate(rate))
  }

  get busy(): boolean {
    return this.phase === 'loading' || this.phase === 'playing'
  }

  get snapshot(): TtsSnapshot {
    return {
      phase: this.phase,
      messageKey: this.active?.key ?? null,
      segment: this.phase === 'playing' ? this.currentSegment + 1 : 0,
      total: this.active?.total ?? 0,
      chars: this.active?.chars ?? 0,
      voice: this.active?.voice ?? null,
    }
  }

  isActive(key: string): boolean {
    return this.busy && this.active?.key === key
  }

  /** 开始朗读一条回复（先停掉上一条，reason=switch）。 */
  start(input: TtsPlayInput): Promise<void> {
    if (this.busy) this.stop('switch')
    // 只切「句子单元」（Markdown 清洗 + 按句末标点/换行），装成几段到请求时再规划
    const units = buildSpeechUnits(input.text)
    if (units.length === 0) {
      this.options.onNotice?.(TTS_TEXT.empty)
      return Promise.resolve()
    }
    const chars = units.reduce((sum, unit) => sum + charLen(unit.text), 0)
    this.priorRate = this.loadPriorRate()
    this.sessionRate = null
    const generation = ++this.generation
    this.active = {
      key: input.key,
      voice: input.voice,
      units,
      chars,
      total: planSegmentCount(units, this.planOptions(true, this.priorRate)),
    }
    this.currentSegment = 0
    this.startedAt = this.now()
    this.resetStreamState()
    // 在用户手势里创建音频出口并解锁（Android WebView 的硬要求；iOS Safari 还要在手势里
    // 播过一段静音才会真的出声；只有网页版构建会播，见 lib/tts-audio.ts 的 unlockAudioContext）
    this.sinkForPlay().unlock?.()
    this.diag('tts:stream', `segments=${this.active.total} chars=${chars}`)
    this.emit('loading')
    return this.run(generation)
  }

  /** 停止：中断下载、停掉已排程的节点，迟到的数据丢弃。 */
  stop(reason: TtsStopReason = 'user'): void {
    if (!this.busy && this.active === null) return
    // 中途停止也把已测到的 r 存下来（只要测到了有效值）
    this.persistRate()
    this.generation += 1
    try {
      this.controller?.abort()
    } catch {
      /* 已经结束 */
    }
    this.controller = null
    this.sink?.stopAll()
    const key = this.active?.key ?? null
    this.resetStreamState()
    this.active = null
    this.phase = 'idle'
    this.options.onSnapshot?.({
      phase: 'idle',
      messageKey: key,
      segment: 0,
      total: 0,
      chars: 0,
      voice: null,
    })
    this.diag('tts:stop', `reason=${reason}`)
  }

  /** 释放音频资源（离开 App / 退出登录）。缓存留着（同一次 App 会话里重读还是命中）。 */
  dispose(): void {
    this.stop('leave')
    this.sink?.dispose()
    this.sink = null
  }

  // ── 主流程 ──────────────────────────────────────────────────────────────

  private async run(generation: number): Promise<void> {
    const producer = this.produce(generation)
    try {
      await this.consume(generation)
      if (generation !== this.generation) return
      // 自然读完：把本次测到的 r 存下来，下次首段直接用它
      this.persistRate()
      // 必须推 idle 快照，否则按钮会卡在「朗读中」
      const key = this.active?.key ?? null
      this.resetStreamState()
      this.active = null
      this.phase = 'idle'
      this.options.onSnapshot?.({
        phase: 'idle',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
      this.diag('tts:stop', 'reason=done')
    } catch (error) {
      if (generation !== this.generation) return
      const code = ttsErrorCode(error)
      this.persistRate()
      this.generation += 1
      try {
        this.controller?.abort()
      } catch {
        /* 已结束 */
      }
      this.controller = null
      this.sink?.stopAll()
      const key = this.active?.key ?? null
      this.resetStreamState()
      this.active = null
      this.phase = 'error'
      this.options.onSnapshot?.({
        phase: 'error',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
      this.diag('tts:stop', `reason=error code=${code}`)
      this.options.onNotice?.(TTS_TEXT.unavailable)
      this.phase = 'idle'
      this.options.onSnapshot?.({
        phase: 'idle',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
    } finally {
      // 生产者的异常已经进 `failure`；这里只是别留 unhandled rejection
      void producer.catch(() => undefined)
    }
  }

  /**
   * 生产者：**逐段规划**并下载（并发 ≤1），上一段**下载完成**就规划并请求下一段。
   * 每段装多少句由 `planNextSegment` 按此刻的速率现场决定（见文件头注释）。
   * 每段的音频先攒够自适应缓冲再放出，之后随到随排。
   */
  private async produce(generation: number): Promise<void> {
    const active = this.active
    if (!active) return
    try {
      for (let index = 0; ; index += 1) {
        if (generation !== this.generation) return
        const plan = planNextSegment(
          active.units,
          this.planOptions(index === 0, index === 0 ? this.priorRate : this.planRate()),
        )
        if (!plan) break
        // 这一段消耗掉的句子不再回头：即使后面的实测速率变了，已请求的段也不重切
        active.units = plan.rest
        active.total = index + 1 + planSegmentCount(active.units, this.planOptions(false, this.planRate()))
        const text = plan.text
        const chars = plan.chars
        const cacheKey = TtsPcmCache.keyOf(text, active.voice)
        const cached = this.cache.get(cacheKey)
        this.currentSegment = index
        if (cached) {
          const startedAt = this.now()
          this.prepareSegment(index, chars, cached.sampleRate, plan, true)
          this.ingestBytes(cached.pcm)
          this.endSegment()
          this.diag(
            'tts:segment',
            `ms=${Math.max(0, this.now() - startedAt)} bytes=${cached.pcm.byteLength} cached=1 code=ok`,
          )
          continue
        }
        const startedAt = this.now()
        const controller = new AbortController()
        this.controller = controller
        const info = await this.openStream(text, active.voice, controller.signal, generation)
        if (generation !== this.generation) return
        this.prepareSegment(index, chars, info.sampleRate, plan, false)
        const collected: Uint8Array[] = []
        let bytes = 0
        for await (const chunk of info.chunks) {
          if (generation !== this.generation) return
          bytes += chunk.byteLength
          // 缓存里存原样的字节（下游按块切，这里 copy 一份免得底层 buffer 被复用）
          collected.push(chunk.slice())
          this.ingestBytes(chunk)
        }
        if (generation !== this.generation) return
        this.controller = null
        this.endSegment()
        this.cache.set(cacheKey, { pcm: concatBytes(collected), sampleRate: info.sampleRate, voice: info.voice })
        this.diag(
          'tts:segment',
          `ms=${Math.max(0, this.now() - startedAt)} bytes=${bytes} cached=0 code=ok`,
        )
      }
      if (generation !== this.generation) return
      this.ended = true
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof TtsStopped) return
      this.failure = error
      this.ended = true
      this.buffering = false
      this.shaper = null
      this.segment = null
      this.diag('tts:segment', `ms=0 bytes=0 cached=0 code=${ttsErrorCode(error)}`)
    } finally {
      this.controller = null
    }
  }

  /** 消费者：把队列里的块按时间轴排到音频时钟上，负责抖动缓冲与 underrun 恢复。 */
  private async consume(generation: number): Promise<void> {
    const sink = this.sinkForPlay()
    let scheduledUntil = 0
    /** 上一块排程结束的时刻与所属段：用来量段间实际静默（诊断 tts:plan 的 waitMs）。 */
    let lastScheduledEnd = 0
    let lastScheduledSegment = -1
    for (;;) {
      if (generation !== this.generation) return
      const block = this.queue.shift()
      if (block) {
        this.queueSeconds = Math.max(0, this.queueSeconds - block.samples.length / block.sampleRate)
        // 时间轴连续时紧接上一块；段间停顿过（scheduledUntil 已经追到现在）就重新起播
        const now = sink.now()
        const when = this.started && scheduledUntil > now ? scheduledUntil : now + TTS_SCHEDULE_LEAD_SEC
        const duration = sink.schedule(block.samples, block.sampleRate, when)
        // 排到某段的第一块：`when` 与上一块结束之间的空档就是这个缝的**实际静默**
        if (block.segment !== undefined && block.segment !== lastScheduledSegment) {
          this.seamMs.set(
            block.segment,
            lastScheduledSegment < 0 ? 0 : Math.max(0, Math.round((when - lastScheduledEnd) * 1_000)),
          )
          lastScheduledSegment = block.segment
          this.flushPlanDiag(block.segment)
        }
        if (!this.started) {
          this.started = true
          this.emit('playing')
          const ttfa = Math.max(0, Math.round(this.now() - this.startedAt))
          this.diag('tts:ttfa', `ms=${ttfa}`)
        }
        scheduledUntil = when + Math.max(0, duration)
        lastScheduledEnd = scheduledUntil
        continue
      }
      // 队列空：等数据，或者等已经排好的音频播完
      if (this.isDrained()) {
        await this.waitPlayback(sink, scheduledUntil, generation)
        if (generation !== this.generation) return
        if (this.failure !== null && this.failure !== undefined) throw this.failure
        return
      }
      const remaining = this.started ? scheduledUntil - sink.now() : Number.POSITIVE_INFINITY
      if (this.started && remaining <= 0 && !this.buffering) {
        // 缓冲真的耗尽了（不是计划内的段间等待）：记诊断，按公式再攒够再续
        const need = this.resumeSeconds()
        this.diag(
          'tts:underrun',
          `segment=${this.currentSegment + 1} buffered=${this.bufferedSeconds().toFixed(2)} need=${need.toFixed(2)}`,
        )
        // 等缓冲回来；流已经收完就不再等（否则会等到一个到不了的数字上）
        while (generation === this.generation && !this.ended && this.bufferedSeconds() < need) {
          await this.sleep(20)
        }
        if (generation !== this.generation) return
        scheduledUntil = sink.now() + TTS_SCHEDULE_LEAD_SEC
        continue
      }
      if (this.started && remaining < TTS_TAIL_KEEP_MS / 1_000 && !this.buffering) {
        // 排好的音频不足 0.5 秒了：把留存的尾巴先放出来。
        // 留存的 0.5 秒是「等段尾静音」用的，不能让它变成断音；放出来之后会重新积累，
        // 所以这条规则在缓冲紧张时段尾静音可能裁不干净 —— 比断音好。
        const released = this.releaseTailNow()
        if (released.length > 0) continue
      }
      await this.sleep(20)
    }
  }

  // ── 分段与缓冲 ──────────────────────────────────────────────────────────

  private prepareSegment(
    index: number,
    chars: number,
    sampleRate: number,
    plan: SegmentPlan,
    fromCache: boolean,
  ): void {
    this.segment = {
      index,
      chars,
      cap: plan.cap,
      plannedRate: plan.rate,
      fromCache,
      sampleRate: Math.max(1, Math.round(sampleRate)),
      firstChunkAt: null,
      firstChunkSeconds: 0,
      receivedSeconds: 0,
      queuedSeconds: 0,
      released: false,
      measuredRate: null,
      downloadDone: false,
      diagDone: false,
    }
    this.shaper = new SegmentShaper({ sampleRate: this.segment.sampleRate })
    this.held = []
    this.leftover = null
    this.buffering = true
    this.currentSegment = index
  }

  /** 收到一块原始 PCM16 字节（可能奇数长度）：拼成样本送进整形器。 */
  private ingestBytes(chunk: Uint8Array): void {
    const segment = this.segment
    const shaper = this.shaper
    if (!segment || !shaper) return
    const isFirstChunk = segment.firstChunkAt === null
    if (isFirstChunk) segment.firstChunkAt = this.now()
    let bytes = chunk
    if (this.leftover !== null) {
      const merged = new Uint8Array(this.leftover.length + chunk.length)
      merged.set(this.leftover, 0)
      merged.set(chunk, this.leftover.length)
      bytes = merged
      this.leftover = null
    }
    const usable = bytes.byteLength - (bytes.byteLength % 2)
    if (usable === 0) {
      this.leftover = bytes.slice()
      return
    }
    if (usable < bytes.byteLength) this.leftover = bytes.slice(usable)
    const samples = new Float32Array(usable / 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable)
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768
    segment.receivedSeconds += samples.length / segment.sampleRate
    if (isFirstChunk) segment.firstChunkSeconds = samples.length / segment.sampleRate
    const blocks = shaper.push(samples)
    if (segment.released) {
      this.pushBlocks(blocks)
    } else {
      this.held.push(...blocks)
      if (this.segmentReady(segment)) this.releaseSegment(segment)
    }
  }

  /** 段结束：把留存尾巴裁干净 + 补停顿，然后放出去；同时量出本段实测 r。 */
  private endSegment(): void {
    const segment = this.segment
    const shaper = this.shaper
    if (!segment || !shaper) return
    const blocks = shaper.finish()
    if (segment.released) this.pushBlocks(blocks)
    else this.held.push(...blocks)
    // 段再短也要放出来（否则短句永远不播）
    this.releaseSegment(segment)
    // 下载结束：本段的实测 r 进本次朗读的 EWMA（缓存命中的段不是一次真实测量）
    const measured = segment.fromCache ? null : this.measuredRateOf(segment)
    segment.measuredRate = measured
    if (measured !== null) {
      this.sessionRate =
        this.sessionRate === null
          ? measured
          : TTS_RATE_EWMA_ALPHA * measured + (1 - TTS_RATE_EWMA_ALPHA) * this.sessionRate
    }
    segment.downloadDone = true
    this.pendingDiags.set(segment.index, segment)
    this.flushPlanDiag(segment.index)
    this.segment = null
    this.shaper = null
    this.held = []
    this.leftover = null
    this.buffering = this.active !== null && this.active.units.length > 0
  }

  /**
   * 这一段的缓冲够不够开播（自适应）：`D×(1/r−1)+0.3`，不低于 0.8 秒。
   * 段收完时由 `endSegment()` 强制放出，不会因为估算偏大而永远等下去。
   */
  private segmentReady(segment: SegmentState): boolean {
    return segment.receivedSeconds >= this.requiredSeconds(segment)
  }

  private requiredSeconds(segment: SegmentState): number {
    const rate = this.rateOf(segment)
    return streamBufferSeconds(segment.chars, rate, {
      charsPerSecond: this.charsPerSecond,
      startBufferSec: this.startBufferSec,
      marginSec: this.bufferMarginSec,
    })
  }

  /**
   * 本段实测的生成速率 r（音频秒 / 真实秒）；测不出来（音频不足 0.5 秒）返回 null。
   *
   * 注意**要扣掉首块**：首块的音频是「一次到位」的（Hub 合成出第一块才建连接），把它算进
   * 速率会明显高估（例如真实 r=0.9、首块 0.2 秒时，0.7 秒内测出 1.1），于是起始缓冲被
   * 估小、长段后段就会断音。扣掉首块之后剩下的就是「持续生成速率」，才和 D×(1/r−1) 匹配。
   */
  private measuredRateOf(segment: SegmentState): number | null {
    if (segment.fromCache) return null
    const firstAt = segment.firstChunkAt
    if (firstAt === null) return null
    const sustained = Math.max(0, segment.receivedSeconds - segment.firstChunkSeconds)
    const elapsedMs = this.now() - firstAt
    if (sustained < TTS_RATE_WINDOW_SEC || elapsedMs <= 0) return null
    return estimateStreamRate({ receivedSeconds: sustained, elapsedMs })
  }

  /**
   * 这一段的缓冲/恢复用哪个 r：已经测到就用实测，测不到用本次朗读的 EWMA，
   * 本次还没测到就用上次持久化的 r̂（首段）。
   */
  private rateOf(segment: SegmentState): number {
    return this.measuredRateOf(segment) ?? this.planRate()
  }

  /** 规划下一段用的 r：本次已测到的 EWMA；还没测到就用持久化的 r̂。 */
  private planRate(): number {
    return this.sessionRate ?? this.priorRate
  }

  private planOptions(first: boolean, rate: number): PlanNextSegmentOptions {
    return {
      first,
      rate,
      serverMaxChars: this.maxCharsOf() ?? TTS_SEGMENT_MAX_CHARS,
      charsPerSecond: this.charsPerSecond,
    }
  }

  /** 读上次朗读持久化的 r̂；没有/坏数据就用保守的 0.88。 */
  private loadPriorRate(): number {
    try {
      const stored = this.loadRate()
      if (typeof stored === 'number' && Number.isFinite(stored)) return clampTtsRate(stored)
    } catch {
      /* 读不到就当没有 */
    }
    return TTS_ASSUMED_RATE
  }

  /**
   * 朗读结束时把本次测到的 r 写回本地存储（EWMA α=0.5，钳在 RATE_MIN–MAX）。
   * 中途停止时如果当前段已经测出有效 r（≥0.5 秒音频）也存 —— 下次首段就按它规划。
   */
  private persistRate(): void {
    const segment = this.segment
    const measured = this.sessionRate ?? (segment ? this.measuredRateOf(segment) : null)
    if (measured === null) return
    let stored = measured
    try {
      stored = this.saveRate(measured)
    } catch {
      /* 存储不可用：本次的值仍然用于本进程的下一次朗读 */
    }
    this.priorRate = clampTtsRate(stored)
    this.diag('tts:rate', `r=${this.priorRate.toFixed(2)}`)
  }

  /**
   * 记一段的规划诊断（tts:plan）：段序号、字数、规划上限、规划用的 r、实测 r、
   * 段间等待（毫秒 = 上一段最后一个音频节点结束到这一段第一块开始的实际静默）。
   * 等下载结束（实测 r 定型）且静默量出来再记；中途停掉的段数据不完整，不记。
   */
  private flushPlanDiag(index: number): void {
    const segment = this.pendingDiags.get(index)
    if (!segment || segment.diagDone || !segment.downloadDone) return
    if (index > 0 && !this.seamMs.has(index)) return
    segment.diagDone = true
    this.pendingDiags.delete(index)
    const measured = segment.measuredRate === null ? 'na' : segment.measuredRate.toFixed(2)
    this.diag(
      'tts:plan',
      `index=${index + 1} chars=${segment.chars} cap=${segment.cap} rate=${segment.plannedRate.toFixed(2)} measured=${measured} waitMs=${Math.round(this.seamMs.get(index) ?? 0)}`,
    )
  }

  /**
   * underrun 之后要攒多少秒才继续：`max(0.5, 剩余预计时长×(1/r−1))`。
   * 上限是「这一段还没到的音频」——比它还大就是在等一个永远等不到的数字。
   */
  private resumeSeconds(): number {
    const segment = this.segment
    if (!segment) return this.resumeBufferSec
    const rate = this.rateOf(segment)
    const totalSec = segment.chars / this.charsPerSecond
    const remainingSec = Math.max(0, totalSec - segment.receivedSeconds)
    const lag = remainingSec * (1 / rate - 1)
    const capped = Math.min(lag, Math.max(this.resumeBufferSec, remainingSec))
    return Math.max(this.resumeBufferSec, capped)
  }

  /** 把这一段的音频（含留存尾巴）全部放进可排程队列。 */
  private releaseSegment(segment: SegmentState): void {
    if (segment.released) return
    const tail = this.shaper?.releaseTail() ?? []
    const blocks = [...this.held, ...tail]
    this.held = []
    this.pushBlocks(blocks)
    segment.released = true
    segment.queuedSeconds = segment.receivedSeconds
    this.buffering = false
    if (this.started) this.emit('playing')
  }

  /**
   * 快断粮时把「还没放出去的东西」全部排上：等缓冲而扣着的块、以及整形器留存的尾巴。
   * 段尾静音可能因此裁不干净，但不会断音。
   */
  private releaseTailNow(): PcmBlock[] {
    const blocks: PcmBlock[] = []
    const segment = this.segment
    if (segment && !segment.released) {
      blocks.push(...this.held)
      this.held = []
      segment.released = true
      segment.queuedSeconds = segment.receivedSeconds
      this.buffering = false
    }
    blocks.push(...(this.shaper?.releaseTail() ?? []))
    this.pushBlocks(blocks)
    if (blocks.length > 0 && this.started) this.emit('playing')
    return blocks
  }

  private pushBlocks(blocks: PcmBlock[]): void {
    const segment = this.currentSegment
    for (const block of blocks) {
      if (block.samples.length === 0) continue
      // 标上段号：消费者据此量「段间实际静默」（诊断用）
      block.segment = segment
      this.queue.push(block)
      this.queueSeconds += block.samples.length / block.sampleRate
    }
  }

  /** 可以在**当前时刻**排的音频秒数（不含已排程的）。 */
  private bufferedSeconds(): number {
    return this.queueSeconds
  }

  private isDrained(): boolean {
    return this.ended && this.queue.length === 0 && !this.buffering
  }

  private async waitPlayback(
    sink: TtsStreamSink,
    scheduledUntil: number,
    generation: number,
  ): Promise<void> {
    while (generation === this.generation && sink.now() < scheduledUntil) {
      await this.sleep(20)
    }
  }

  // ── 网络 ────────────────────────────────────────────────────────────────

  /** 发起一条流；429 按 retryAfterSec 重试一次（与整段播放器一致）。 */
  private async openStream(
    text: string,
    voice: string | undefined,
    signal: AbortSignal,
    generation: number,
  ): Promise<TtsStreamInfo> {
    let attempt = 0
    for (;;) {
      try {
        return await this.options.synthesizeStream({ text, voice, signal })
      } catch (error) {
        if (generation !== this.generation) throw error
        if (error instanceof TtsStopped) throw error
        const code = ttsErrorCode(error)
        if (code === 'RATE_LIMITED' && attempt === 0) {
          attempt += 1
          await this.sleep(ttsRetryDelayMs(error))
          if (generation !== this.generation) throw error
          continue
        }
        throw error
      }
    }
  }

  private sinkForPlay(): TtsStreamSink {
    if (!this.sink) this.sink = this.options.sink()
    return this.sink
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  private resetStreamState(): void {
    this.controller = null
    this.shaper = null
    this.segment = null
    this.held = []
    this.queue = []
    this.queueSeconds = 0
    this.leftover = null
    this.started = false
    this.ended = false
    this.failure = null
    this.buffering = false
    this.seamMs.clear()
    this.pendingDiags.clear()
  }

  private emit(phase: TtsPhase): void {
    this.phase = phase
    this.options.onSnapshot?.(this.snapshot)
  }

  private diag(name: string, detail: string): void {
    this.options.onDiag?.(name, detail)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
