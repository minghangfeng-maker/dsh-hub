/**
 * 朗读分段的「电平整理」（0.4.4）：让整篇读下来音量和停顿一致。
 *
 * 星汐的合成是按段独立生成的。2026-10-28 实测：同一篇回复的 4 段之间，有声部分的
 * 响度标准差 1.0–1.6 dB，首尾静音长短不一，听起来像「一段大声一段小声、停顿忽长忽短」。
 * 调合成参数（temperature / 固定 seed / 语气指令）对此没有稳定改善（换一段文字就失效），
 * 所以在播放端统一处理：
 *
 *  1. 去掉首尾静音（保留 30ms 余量，不切到字头字尾）；
 *  2. 把有声部分的 RMS 拉到同一目标（-20 dBFS），增益限制在 0.5–4 倍，
 *     并保证峰值不超过 0.95（不削波）；
 *  3. 段尾统一补一段固定停顿（默认 220ms），段与段之间节奏一致。
 *
 * 只处理 44 字节头的 16bit 单声道 PCM WAV（Hub 返回的就是这种）；认不出的格式原样返回。
 */

export interface SpeechLevelOptions {
  /** 目标响度（有声部分 RMS，dBFS）。 */
  targetDb?: number
  /** 段尾补的停顿（毫秒）。 */
  tailPauseMs?: number
  /** 低于这个电平（dBFS）的 10ms 帧算静音。 */
  silenceDb?: number
}

const DEFAULT_TARGET_DB = -20
const DEFAULT_TAIL_PAUSE_MS = 220
const DEFAULT_SILENCE_DB = -45
const MARGIN_MS = 30
const MIN_GAIN = 0.5
const MAX_GAIN = 4
const PEAK_LIMIT = 0.95

interface PcmWav {
  sampleRate: number
  samples: Int16Array
}

function readPcmWav(bytes: Uint8Array): PcmWav | null {
  if (bytes.byteLength < 46) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bits = view.getUint16(34, true)
  if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate <= 0) return null
  const dataBytes = Math.min(view.getUint32(40, true), bytes.byteLength - 44) & ~1
  const samples = new Int16Array(dataBytes / 2)
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(44 + i * 2, true)
  return { sampleRate, samples }
}

function writePcmWav(sampleRate: number, samples: Int16Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i]!, true)
  return out
}

function dbOf(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-9))
}

/** 整理一段朗读音频；认不出的格式或整段静音时原样返回。 */
export function levelSpeechWav(wav: Uint8Array, options: SpeechLevelOptions = {}): Uint8Array {
  const parsed = readPcmWav(wav)
  if (!parsed) return wav
  const { sampleRate, samples } = parsed
  const targetDb = options.targetDb ?? DEFAULT_TARGET_DB
  const tailPauseMs = options.tailPauseMs ?? DEFAULT_TAIL_PAUSE_MS
  const silenceDb = options.silenceDb ?? DEFAULT_SILENCE_DB

  const frame = Math.max(1, Math.round(sampleRate / 100))
  const frames = Math.floor(samples.length / frame)
  if (frames === 0) return wav
  let first = -1
  let last = -1
  let voicedSum = 0
  let voicedCount = 0
  let peak = 0
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    for (let i = f * frame; i < (f + 1) * frame; i += 1) {
      const v = samples[i]! / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / frame)
    if (dbOf(rms) >= silenceDb) {
      if (first < 0) first = f
      last = f
    }
    // 响度只按明显有声的帧算（比静音门限高 15dB），避免被字间停顿拉低
    if (dbOf(rms) >= silenceDb + 15) {
      voicedSum += sum
      voicedCount += frame
    }
  }
  if (first < 0 || voicedCount === 0) return wav

  const margin = Math.round((MARGIN_MS / 1000) * sampleRate)
  const start = Math.max(0, first * frame - margin)
  const end = Math.min(samples.length, (last + 1) * frame + margin)
  for (let i = start; i < end; i += 1) peak = Math.max(peak, Math.abs(samples[i]! / 32768))

  const voicedRms = Math.sqrt(voicedSum / voicedCount)
  let gain = Math.pow(10, (targetDb - dbOf(voicedRms)) / 20)
  gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain))
  if (peak * gain > PEAK_LIMIT) gain = PEAK_LIMIT / Math.max(peak, 1e-9)

  const pause = Math.max(0, Math.round((tailPauseMs / 1000) * sampleRate))
  const out = new Int16Array(end - start + pause)
  for (let i = start; i < end; i += 1) {
    const v = Math.round(samples[i]! * gain)
    out[i - start] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
  }
  return writePcmWav(sampleRate, out)
}
