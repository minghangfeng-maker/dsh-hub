import { describe, expect, it } from 'vitest'
import { levelSpeechWav } from '@/lib/speech-level'

const RATE = 24_000

function wavOf(samples: Int16Array, rate = RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const ascii = (o: number, t: string) => { for (let i = 0; i < t.length; i += 1) out[o + i] = t.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((v, i) => view.setInt16(44 + i * 2, v, true))
  return out
}

function samplesOf(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const n = view.getUint32(40, true) / 2
  const out = new Int16Array(n)
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(44 + i * 2, true)
  return out
}

/** 前后各 lead/tail 秒静音，中间 tone 秒、幅度 amp 的 220Hz 正弦。 */
function speech(amp: number, lead = 0.5, tone = 1, tail = 0.8): Int16Array {
  const total = Math.round((lead + tone + tail) * RATE)
  const out = new Int16Array(total)
  const a = Math.round(lead * RATE)
  const b = a + Math.round(tone * RATE)
  for (let i = a; i < b; i += 1) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE))
  return out
}

function voicedDb(samples: Int16Array): number {
  let sum = 0
  let n = 0
  for (const v of samples) {
    const x = v / 32768
    if (Math.abs(x) > 0.001) { sum += x * x; n += 1 }
  }
  return 20 * Math.log10(Math.sqrt(sum / n))
}

describe('levelSpeechWav：整篇音量与停顿一致', () => {
  it('相差 6dB 的两段整理后响度一致（误差 < 0.5dB）', () => {
    const quiet = samplesOf(levelSpeechWav(wavOf(speech(0.1))))
    const loud = samplesOf(levelSpeechWav(wavOf(speech(0.2))))
    expect(Math.abs(voicedDb(quiet) - voicedDb(loud))).toBeLessThan(0.5)
  })

  it('去掉首尾静音并在段尾补固定 220ms 停顿', () => {
    const a = samplesOf(levelSpeechWav(wavOf(speech(0.2, 0.5, 1, 0.8))))
    const b = samplesOf(levelSpeechWav(wavOf(speech(0.2, 0.1, 1, 0.1))))
    // 两段原始首尾静音差很多，整理后长度只差几帧
    expect(Math.abs(a.length - b.length)).toBeLessThan(RATE * 0.03)
    // 时长 ≈ 1s 有声 + 2×30ms 余量 + 220ms 停顿
    expect(a.length / RATE).toBeGreaterThan(1.2)
    expect(a.length / RATE).toBeLessThan(1.35)
    // 开头不是长静音：前 40ms 内就有声音
    expect(a.slice(0, Math.round(RATE * 0.04)).some((v) => Math.abs(v) > 100)).toBe(true)
  })

  it('不削波：峰值不超过 0.95', () => {
    const out = samplesOf(levelSpeechWav(wavOf(speech(0.9))))
    const peak = Math.max(...Array.from(out, (v) => Math.abs(v))) / 32768
    expect(peak).toBeLessThanOrEqual(0.951)
  })

  it('认不出的格式、整段静音原样返回', () => {
    const junk = new Uint8Array([1, 2, 3, 4])
    expect(levelSpeechWav(junk)).toBe(junk)
    const silent = wavOf(new Int16Array(RATE))
    expect(levelSpeechWav(silent)).toBe(silent)
  })
})
