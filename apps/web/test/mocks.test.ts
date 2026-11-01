import {
  AuthMeResponseSchema,
  ExportListResponseSchema,
  MyInstanceResponseSchema,
  MyPluginsResponseSchema,
  SessionListResponseSchema,
} from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import { resolveMockScenario } from '@/mocks'
import { getMockState, MOCK_SCENARIOS, mockInstanceSummary, setMockScenario } from '@/mocks/state'

/**
 * `?mock=1` 假数据（任务书「完成定义」）。这里做两件事：
 * 1. 场景解析（URL / localStorage 的优先级）；
 * 2. **每个场景的假数据都过一遍 shared 的契约 schema** —— 假数据也是契约的一部分，
 *    形状漂了要在测试里立刻发现，而不是等到走查时页面白屏（踩过一次 slug 不匹配）。
 */
describe('mock 场景解析（?mock=1）', () => {
  it('?mock=1 用 running；?mock=<场景> 直接选场景', () => {
    expect(resolveMockScenario('?mock=1', null)).toBe('running')
    expect(resolveMockScenario('?mock=', null)).toBe('running')
    expect(resolveMockScenario('?mock=stopped', null)).toBe('stopped')
    expect(resolveMockScenario('?mock=exporting', null)).toBe('exporting')
    expect(resolveMockScenario('?mock=1&scenario=plugins', null)).toBe('plugins')
  })

  it('?mock=0 关掉；没带参数时用 localStorage 里的选择', () => {
    expect(resolveMockScenario('?mock=0', 'running')).toBeNull()
    expect(resolveMockScenario('', 'starting')).toBe('starting')
    expect(resolveMockScenario('', null)).toBeNull()
    // 伪造的值不算数
    expect(resolveMockScenario('', 'drop-table')).toBeNull()
    expect(resolveMockScenario('?mock=nonsense', null)).toBeNull()
  })
})

describe('mock 假数据符合 04 契约', () => {
  const scenarios = MOCK_SCENARIOS

  it.each(scenarios)('场景 %s：用户 / 实例 / 配额 / 模型摘要', (scenario) => {
    setMockScenario(scenario)
    const state = getMockState()

    // `GET /api/auth/me`
    expect(
      AuthMeResponseSchema.safeParse({ user: state.user, instance: mockInstanceSummary() }).success,
    ).toBe(true)

    // `GET /api/me/instance`（stats 只在运行中返回，与 04 §3.1 一致）
    const parsed = MyInstanceResponseSchema.safeParse({
      instance: mockInstanceSummary(),
      quota: state.quota,
      stats: state.status === 'running' ? state.stats : null,
      modelSummary: {
        policy: 'managed',
        preset: '默认预设',
        defaultModel: 'deepseek-chat',
        providers: ['DeepSeek', 'Kimi'],
      },
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it.each(scenarios)('场景 %s：插件 / 导出 / 会话列表', (scenario) => {
    setMockScenario(scenario)
    const state = getMockState()

    expect(MyPluginsResponseSchema.safeParse({ items: state.plugins }).success).toBe(true)
    expect(ExportListResponseSchema.safeParse({ items: state.exports }).success).toBe(true)
    expect(SessionListResponseSchema.safeParse({ items: state.sessions }).success).toBe(true)
  })

  it('切换场景会重置状态（截图之间互不影响）', () => {
    setMockScenario('stopped')
    expect(getMockState().status).toBe('stopped')
    expect(getMockState().exports).toHaveLength(2)

    setMockScenario('empty')
    expect(getMockState().exports).toHaveLength(0)
    expect(getMockState().plugins.filter((item) => item.installed)).toHaveLength(1)

    setMockScenario('capacity')
    expect(getMockState().capacityFullOnStart).toBe(true)
  })
})
