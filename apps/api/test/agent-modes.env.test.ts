import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_MODE_SETTINGS, type AgentModeSettings } from '@dsh-hub/shared'
import { claudeRootUrl, codexBaseUrl, isTargeted, modeEnv, modesEnv } from '../src/modules/agent-modes/env.js'

/**
 * 18 §4.1 的 env 纯函数：开通/未开通、all/指定用户、内部监听器关闭、Claude 根地址不带 /v1、
 * Codex 带 /v1。真实容器 env 由 `models.containerEnv` 叠加（agent-modes 管理接口测试覆盖）。
 */

function settings(patch: Partial<AgentModeSettings> = {}): AgentModeSettings {
  return { ...DEFAULT_AGENT_MODE_SETTINGS, targets: { userIds: [] }, ...patch }
}

const BASE = 'http://10.213.0.1:7710/v1'

describe('isTargeted（18 §2 targets）', () => {
  it('all / 指定用户 / 空数组', () => {
    expect(isTargeted({ all: true }, 7)).toBe(true)
    expect(isTargeted({ userIds: [7, 9] }, 9)).toBe(true)
    expect(isTargeted({ userIds: [7] }, 8)).toBe(false)
    expect(isTargeted({ userIds: [] }, 7)).toBe(false)
  })
})

describe('claudeRootUrl / codexBaseUrl（12 §7.0 的 baseURL 规则）', () => {
  it('Claude 去掉 /v1（Anthropic SDK 自己拼），Codex 保留 /v1', () => {
    expect(claudeRootUrl(BASE)).toBe('http://10.213.0.1:7710')
    expect(claudeRootUrl('http://10.213.0.1:7710')).toBe('http://10.213.0.1:7710')
    expect(claudeRootUrl('http://10.213.0.1:7710/v1/')).toBe('http://10.213.0.1:7710')
    expect(codexBaseUrl(BASE)).toBe(BASE)
    expect(codexBaseUrl('http://10.213.0.1:7710')).toBe(BASE)
    expect(codexBaseUrl('http://10.213.0.1:7710/v1/')).toBe(BASE)
  })
})

describe('modeEnv（18 §4.1）', () => {
  it('Claude Code：开通且用户在 targets 里 → 三件套，base 不带 /v1', () => {
    const result = modeEnv({
      mode: 'claude-code',
      settings: settings({ enabled: true, targets: { all: true } }),
      userId: 3,
      internalBaseUrl: BASE,
      key: 'sk-dsh-abc',
    })
    expect(result.warning).toBeNull()
    expect(result.env).toEqual({
      HUB_CLAUDE_AUTH: 'apiKey',
      HUB_CLAUDE_KEY: 'sk-dsh-abc',
      HUB_CLAUDE_BASE_URL: 'http://10.213.0.1:7710',
    })
  })

  it('Codex：三件套，base 带 /v1，wire_api=responses', () => {
    const result = modeEnv({
      mode: 'codex',
      settings: settings({ enabled: true, targets: { userIds: [3] } }),
      userId: 3,
      internalBaseUrl: BASE,
      key: 'sk-dsh-xyz',
    })
    expect(result.warning).toBeNull()
    expect(result.env).toEqual({
      HUB_CODEX_KEY: 'sk-dsh-xyz',
      HUB_CODEX_BASE_URL: BASE,
      HUB_CODEX_WIRE_API: 'responses',
    })
  })

  it('未开通 / 不在 targets → 空 env、不告警', () => {
    for (const current of [
      settings({ enabled: false, targets: { all: true } }),
      settings({ enabled: true, targets: { userIds: [8] } }),
      settings({ enabled: true, targets: { userIds: [] } }),
    ]) {
      expect(
        modeEnv({ mode: 'claude-code', settings: current, userId: 3, internalBaseUrl: BASE, key: 'k' }),
      ).toEqual({ env: {}, warning: null })
    }
  })

  it('内部监听器关闭 → 空 env + 中文告警', () => {
    const result = modeEnv({
      mode: 'claude-code',
      settings: settings({ enabled: true, targets: { all: true } }),
      userId: 3,
      internalBaseUrl: null,
      key: 'k',
    })
    expect(result.env).toEqual({})
    expect(result.warning).toContain('内部监听器没开')
  })

  it('密钥签发失败 → 空 env + 告警', () => {
    const result = modeEnv({
      mode: 'codex',
      settings: settings({ enabled: true, targets: { all: true } }),
      userId: 3,
      internalBaseUrl: BASE,
      key: null,
    })
    expect(result.env).toEqual({})
    expect(result.warning).toContain('密钥签发失败')
  })
})

describe('modesEnv（两个模式合并）', () => {
  it('只注入开通且命中 targets 的模式；别的模式不签发密钥', () => {
    const calls: string[] = []
    const result = modesEnv({
      settings: {
        'claude-code': settings({ enabled: true, targets: { userIds: [3] } }),
        codex: settings({ enabled: true, targets: { userIds: [4] } }),
      },
      userId: 3,
      internalBaseUrl: BASE,
      keyFor: (mode) => {
        calls.push(mode)
        return `key-${mode}`
      },
    })
    expect(calls).toEqual(['claude-code'])
    expect(result.env.HUB_CLAUDE_KEY).toBe('key-claude-code')
    expect(result.env.HUB_CODEX_KEY).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  it('内部监听器关闭时两个模式都给告警', () => {
    const result = modesEnv({
      settings: {
        'claude-code': settings({ enabled: true, targets: { all: true } }),
        codex: settings({ enabled: true, targets: { all: true } }),
      },
      userId: 3,
      internalBaseUrl: null,
      keyFor: () => 'k',
    })
    expect(result.env).toEqual({})
    expect(result.warnings).toHaveLength(2)
  })
})
