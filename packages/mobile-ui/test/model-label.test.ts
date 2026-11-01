import { describe, expect, it } from 'vitest'
import {
  EFFORT_SHORT_LABELS,
  effortShortLabel,
  isHiddenModelChannel,
  modelChannelName,
  modelDisplayName,
  modelMultiplierText,
  shortModelName,
} from '@/lib/model-label'

describe('shortModelName', () => {
  it('去掉 · provider 后缀（真实 Hub 的展示名形状）', () => {
    expect(shortModelName('DeepSeek V4.1 Flash · upstream-b')).toBe('DeepSeek Flash')
    expect(shortModelName('DeepSeek V4.1 Flash•upstream-b')).toBe('DeepSeek Flash')
  })

  it('去掉版本号 token，并把连字符换成空格', () => {
    expect(shortModelName('DeepSeek-V4.1-Flash')).toBe('DeepSeek Flash')
    expect(shortModelName('DeepSeek-V4-Pro')).toBe('DeepSeek Pro')
    expect(shortModelName('Claude Sonnet 4.5')).toBe('Claude Sonnet')
    expect(shortModelName('Claude-3-5-Sonnet')).toBe('Claude Sonnet')
    expect(shortModelName('Qwen_V3_235B')).toBe('Qwen 235B')
  })

  it('带字母的版本后缀保留（不把 GPT-4o 削成 GPT）', () => {
    expect(shortModelName('GPT-4o')).toBe('GPT 4o')
    expect(shortModelName('GPT-3.5-turbo')).toBe('GPT turbo')
  })

  it('中文名只做空白整理', () => {
    expect(shortModelName('深度求索 V4.1 推理')).toBe('深度求索 推理')
    expect(shortModelName('深度求索')).toBe('深度求索')
  })

  it('全被削光时退回原词，不返回空串', () => {
    expect(shortModelName('V4.1')).toBe('V4.1')
    expect(shortModelName('  V4  ')).toBe('V4')
  })

  it('空值安全', () => {
    expect(shortModelName('')).toBe('')
    expect(shortModelName(null)).toBe('')
    expect(shortModelName(undefined)).toBe('')
    expect(shortModelName('   ')).toBe('')
  })

  it('超长名字只由 CSS 省略号兜底，函数本身不截断', () => {
    const long = 'DeepSeek V4.1 Flash Ultra Long Experimental · upstream-b'
    expect(shortModelName(long)).toBe('DeepSeek Flash Ultra Long Experimental')
  })
})

describe('effortShortLabel', () => {
  it('四档英文短名：Low / Medium / High / Max', () => {
    expect(EFFORT_SHORT_LABELS).toEqual({
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      ultra: 'Max',
    })
    expect(effortShortLabel('low')).toBe('Low')
    expect(effortShortLabel('medium')).toBe('Medium')
    expect(effortShortLabel('high')).toBe('High')
    expect(effortShortLabel('ultra')).toBe('Max')
  })

  it('模型不支持思考时给 —', () => {
    expect(effortShortLabel(null)).toBe('—')
    expect(effortShortLabel(undefined)).toBe('—')
  })
})

describe('modelDisplayName', () => {
  it('优先 name 短名，其次 model id，最后兜底', () => {
    expect(modelDisplayName({ name: 'DeepSeek-V4.1-Flash', model: 'deepseek-flash' })).toBe(
      'DeepSeek Flash',
    )
    expect(modelDisplayName({ name: '', model: 'deepseek-flash' })).toBe('deepseek flash')
    expect(modelDisplayName(null)).toBe('模型')
  })
})

describe('modelChannelName', () => {
  it('取展示名里 `· channel` 的后半段（真实 Hub 的渠道命名）', () => {
    expect(
      modelChannelName({ name: 'DeepSeek V4.1 Flash · upstream-b', model: 'x@upstream-b' }),
    ).toBe('upstream-b')
    expect(modelChannelName({ name: 'DeepSeek V4.1 Flash•upstream-c' })).toBe('upstream-c')
    expect(modelChannelName({ name: 'Qwen: Qwen3.8 27B · modelscope' })).toBe('modelscope')
  })

  it('展示名里没有渠道时退回模型 id 的 @channel', () => {
    expect(modelChannelName({ name: 'DeepSeek Flash', model: 'deepseek-v4.1-flash@upstream-c' })).toBe(
      'upstream-c',
    )
    expect(
      modelChannelName({ name: '', model: 'Qwen/Qwen3.8-Flash-Next@modelscope' }),
    ).toBe('modelscope')
  })

  it('没有渠道信息时返回空串（UI 不显示这一行）', () => {
    expect(modelChannelName({ name: '跟随 Claude Code 默认', model: 'claude-code-default' })).toBe('')
    expect(modelChannelName({ name: 'DeepSeek Flash' })).toBe('')
    expect(modelChannelName({ name: '', model: '' })).toBe('')
    expect(modelChannelName(null)).toBe('')
    expect(modelChannelName(undefined)).toBe('')
  })
})

describe('modelMultiplierText（模型名后的渠道倍率）', () => {
  it('0.1 → X0.1、0.3 → X0.3、1 → X1', () => {
    expect(modelMultiplierText(0.1)).toBe('X0.1')
    expect(modelMultiplierText(0.3)).toBe('X0.3')
    expect(modelMultiplierText(1)).toBe('X1')
    expect(modelMultiplierText(0.125)).toBe('X0.125')
  })

  it('老 Hub 没给价格信息 → 空串（不显示）', () => {
    expect(modelMultiplierText(null)).toBe('')
    expect(modelMultiplierText(undefined)).toBe('')
    expect(modelMultiplierText(Number.NaN)).toBe('')
    expect(modelMultiplierText(-1)).toBe('')
  })
})

describe('isHiddenModelChannel（手机端隐藏 Claude Code / Codex）', () => {
  it('provider 是 claude-code / codex → 隐藏', () => {
    expect(isHiddenModelChannel({ provider: 'claude-code', name: 'Opus 5.5' })).toBe(true)
    expect(isHiddenModelChannel({ provider: 'codex', name: 'GPT-6 Astra' })).toBe(true)
  })

  it('展示名里带 GPT / Claude 的兜底隐藏', () => {
    expect(isHiddenModelChannel({ provider: 'hub-high', name: '跟随 Claude Code 默认' })).toBe(true)
    expect(isHiddenModelChannel({ provider: 'hub', name: 'gpt-6.1-sol' })).toBe(true)
  })

  it('中转站模型不隐藏', () => {
    expect(isHiddenModelChannel({ provider: 'hub-max', name: 'DeepSeek V4.1 Flash · upstream-c' })).toBe(false)
    expect(isHiddenModelChannel({ provider: 'hub', name: 'Kimi-K3 · upstream-c' })).toBe(false)
    expect(isHiddenModelChannel({ provider: 'hub-xhigh', name: 'Qwen: Qwen3.8 27B · modelscope' })).toBe(false)
    expect(isHiddenModelChannel(null)).toBe(false)
  })
})
