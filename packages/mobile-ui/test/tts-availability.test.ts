/**
 * 0.4.3 朗读能力的可见性：老 Hub / 关掉朗读 / 没有音色时，入口显示成什么样。
 *
 * 这些函数同时被对话页（是否显示朗读按钮）与设置页（分组是否置灰）使用，
 * 所以在这里把三条规则锁死。
 */

import { describe, expect, it } from 'vitest'
import type { BootstrapTts } from '@dsh-hub/mobile-core'
import {
  TTS_PREVIEW_TEXT,
  isTtsAvailable,
  resolveTtsVoiceId,
  ttsCapabilityOf,
  ttsMaxChars,
  ttsUnavailableHint,
  ttsVoiceDescription,
  ttsVoiceList,
} from '@/lib/tts-availability'

const SEKI = { id: 'seki', name: '星汐 seki', description: '温柔清晰的女声' }

function capability(overrides: Partial<BootstrapTts> = {}): BootstrapTts {
  return {
    enabled: true,
    voices: [SEKI],
    defaultVoice: 'seki',
    maxChars: 200,
    ...overrides,
  }
}

describe('ttsCapabilityOf / isTtsAvailable', () => {
  it('老 Hub 不发 voice.tts → null，不可用', () => {
    expect(ttsCapabilityOf({})).toBeNull()
    expect(ttsCapabilityOf(null)).toBeNull()
    expect(ttsCapabilityOf(undefined)).toBeNull()
    expect(isTtsAvailable(null)).toBe(false)
  })

  it('enabled=true 且有音色才算可用', () => {
    expect(isTtsAvailable(capability())).toBe(true)
    expect(isTtsAvailable(capability({ enabled: false }))).toBe(false)
    expect(isTtsAvailable(capability({ voices: [] }))).toBe(false)
  })

  it('voice.tts 原样取出（与 asr 同级）', () => {
    expect(ttsCapabilityOf({ tts: capability() })?.defaultVoice).toBe('seki')
  })
})

describe('音色列表与选择', () => {
  it('不可用时列表为空（设置页连音色都不显示）', () => {
    expect(ttsVoiceList(null)).toEqual([])
    expect(ttsVoiceList(capability({ enabled: false }))).toEqual([])
  })

  it('默认音色：没选过就用 defaultVoice', () => {
    expect(resolveTtsVoiceId(capability(), null)).toBe('seki')
    expect(resolveTtsVoiceId(capability(), undefined)).toBe('seki')
  })

  it('用户选过且仍存在 → 用用户的', () => {
    const two = capability({
      voices: [SEKI, { id: 'other', name: '另一个声音' }],
      defaultVoice: 'seki',
    })
    expect(resolveTtsVoiceId(two, 'other')).toBe('other')
  })

  it('用户选过的音色已经不存在 → 回落到默认，不把不存在的 id 发出去', () => {
    expect(resolveTtsVoiceId(capability(), 'gone')).toBe('seki')
  })

  it('defaultVoice 为空 → 用第一个音色', () => {
    expect(resolveTtsVoiceId(capability({ defaultVoice: null }), null)).toBe('seki')
  })

  it('没有音色 → null', () => {
    expect(resolveTtsVoiceId(capability({ voices: [] }), 'seki')).toBeNull()
  })
})

describe('上限与文案', () => {
  it('maxChars 用 Hub 下发的值，缺失/非法退回 200', () => {
    expect(ttsMaxChars(capability({ maxChars: 120 }))).toBe(120)
    expect(ttsMaxChars(null)).toBe(200)
    expect(ttsMaxChars(capability({ maxChars: 0 }))).toBe(200)
  })

  it('不可用时的说明分三种（老 Hub / 关掉 / 没音色）', () => {
    expect(ttsUnavailableHint(null)).toBe('这个 Hub 还没有开启朗读')
    expect(ttsUnavailableHint(capability({ enabled: false }))).toBe('朗读暂时不可用')
    expect(ttsUnavailableHint(capability({ voices: [] }))).toBe('暂时没有可用的音色')
    expect(ttsUnavailableHint(capability())).toBeNull()
  })

  it('音色介绍：Hub 给了就用；没给时给通用说明', () => {
    expect(ttsVoiceDescription(SEKI)).toBe('温柔清晰的女声')
    expect(ttsVoiceDescription({ id: 'seki', name: '星汐 seki' }, capability())).toBe(
      '默认音色，适合朗读 AI 的回复',
    )
    expect(ttsVoiceDescription({ id: 'x', name: 'X' }, capability({ defaultVoice: null }))).toBe(
      '用这个声音朗读 AI 的回复',
    )
  })

  it('试听例句是固定的一句', () => {
    expect(TTS_PREVIEW_TEXT).toBe('你好呀，我是星汐。')
  })
})
