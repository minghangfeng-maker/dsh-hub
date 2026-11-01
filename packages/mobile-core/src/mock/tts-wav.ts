/**
 * mock Hub 的朗读音频：把一段文字编码成 24kHz 单声道 16bit 的 WAV。
 *
 * 真 Hub 的音频来自本机的语音合成服务（星汐），mock 只需要「形状对、能被解码、长度
 * 跟着字数走」：一段正弦波 + 与字数相关的时长。播放器、解码器与 AudioContext 全是真
 * 代码路径，只有声音是假的。
 *
 * 时长口径与真服务接近：约 90ms/字（中文正常语速），最短 300ms，最长 10 秒。
 * 这样 e2e 里「边播边合成」的时序与真机接近（一段 1–3 秒），又不会让用例跑太久。
 */

export interface MockTtsWavOptions {
  sampleRate?: number
  /** 每个字符的时长（毫秒）。 */
  msPerChar?: number
  /** 最短时长（毫秒）：一个字也要能听见。 */
  minMs?: number
  /** 最长时长（毫秒）：mock 不做真实排队，限制一下别拖慢用例。 */
  maxMs?: number
  /** 音高（Hz）：mock 只用来让波形看出「有声音」。 */
  frequency?: number
}

const DEFAULTS = {
  sampleRate: 24_000,
  msPerChar: 90,
  minMs: 300,
  maxMs: 10_000,
  frequency: 220,
}

/** 估算一段文字的播放时长（毫秒）：与 `encodeTtsWav` 同一套口径。 */
export function ttsDurationMs(text: string, options: MockTtsWavOptions = {}): number {
  const msPerChar = options.msPerChar ?? DEFAULTS.msPerChar
  const minMs = options.minMs ?? DEFAULTS.minMs
  const maxMs = options.maxMs ?? DEFAULTS.maxMs
  const chars = Array.from(text.replace(/\s+/g, '')).length
  return Math.max(minMs, Math.min(maxMs, Math.round(chars * msPerChar)))
}

/**
 * 生成 PCM16 小端单声道字节（无 WAV 头）：流式朗读（0.4.6 / WP51）下发的内容。
 *
 * 波形：220Hz 正弦 × （每个字一次的音节包络），避免整段是一个恒定音（截图/听感上更像话）。
 * 每个字 90ms 一个音节：包络是 sin^2，句首句尾自然淡入淡出，不会有爆音。
 */
export function encodeTtsPcm(text: string, options: MockTtsWavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate
  const frequency = options.frequency ?? DEFAULTS.frequency
  const durationMs = ttsDurationMs(text, options)
  const totalSamples = Math.max(1, Math.round((sampleRate * durationMs) / 1_000))
  const bytes = new Uint8Array(totalSamples * 2)
  const view = new DataView(bytes.buffer)

  const syllableMs = options.msPerChar ?? DEFAULTS.msPerChar
  const syllableSamples = Math.max(1, Math.round((syllableMs * sampleRate) / 1_000))
  const fadeSamples = Math.max(1, Math.round(sampleRate * 0.01))
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate
    const phase = (i % syllableSamples) / syllableSamples
    const envelope = Math.sin(Math.PI * phase) ** 2
    const fade = Math.min(1, i / fadeSamples, (totalSamples - i) / fadeSamples)
    const value = Math.sin(2 * Math.PI * frequency * t) * 0.25 * envelope * fade
    view.setInt16(i * 2, Math.round(value * 32_767), true)
  }
  return bytes
}

/**
 * 生成 WAV（RIFF/WAVE，fmt + data，单声道 16bit PCM）。
 *
 * 与 `/tts` 一样：整段合成接口用的就是这个；流式接口只去掉 44 字节头（见 `encodeTtsPcm`）。
 */
export function encodeTtsWav(text: string, options: MockTtsWavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate
  const pcm = encodeTtsPcm(text, options)
  const bytes = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(bytes.buffer)

  const tag = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // 字节率
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  tag(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  bytes.set(pcm, 44)
  return bytes
}
