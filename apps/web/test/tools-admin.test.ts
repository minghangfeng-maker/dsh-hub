import { DEFAULT_TOOL_SETTINGS, type ToolSettingsResponse } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import { getToolSettings, updateToolSettings } from '@/api/tools'
import ToolsSettingsPanel from '@/components/admin/search/ToolsSettingsPanel.vue'
import { formatPoints, pointsToMicro } from '@/utils/points'
import { cooldownReasonText, countToolKeys, parsePastedKeys } from '@/utils/tool-keys'

vi.mock('@/api/tools', () => ({
  getToolSettings: vi.fn(),
  updateToolSettings: vi.fn(),
}))

/**
 * 搜索池 · 设置与密钥解析（WP18b 任务书「测试」节）：
 * 批量粘贴解析（空行 / 首尾空格 / 重复）、单价换算（0.01 积分/次 ↔ 10000 微积分）、
 * 设置保存只提交改动过的字段。
 */

const BASE: ToolSettingsResponse = {
  settings: { ...DEFAULT_TOOL_SETTINGS, enabled: true, deliverToDsh: false },
  internalBaseUrl: 'http://10.213.0.1:7710/v1/tools',
  publicBaseUrl: 'https://hub.example.com:8123/v1/tools',
}

function mountPanel() {
  const Host = defineComponent({
    components: { ToolsSettingsPanel, NMessageProvider },
    template: '<NMessageProvider><ToolsSettingsPanel /></NMessageProvider>',
  })
  return mount(Host)
}

describe('搜索池设置（14 §3.2 §7）', () => {
  beforeEach(() => {
    vi.mocked(getToolSettings).mockReset()
    vi.mocked(updateToolSettings).mockReset()
    vi.mocked(getToolSettings).mockResolvedValue(BASE)
    vi.mocked(updateToolSettings).mockImplementation(async (input) => ({
      settings: { ...BASE.settings, ...input },
      internalBaseUrl: BASE.internalBaseUrl,
      publicBaseUrl: BASE.publicBaseUrl,
    }))
  })

  it('只发改动字段：改搜索单价 → 请求体只有 searchPriceMicro', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const price = wrapper.get('[data-testid="tools-search-price"] input')
    expect((price.element as HTMLInputElement).value).toBe('0.01')
    await price.setValue('0.02')

    await wrapper.get('[data-testid="tools-settings-save"]').trigger('click')
    await flushPromises()

    expect(updateToolSettings).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateToolSettings).mock.calls[0]?.[0]).toEqual({ searchPriceMicro: 20_000 })
    wrapper.unmount()
  })

  it('没有改动时不发请求', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await wrapper.get('[data-testid="tools-settings-save"]').trigger('click')
    await flushPromises()

    expect(updateToolSettings).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('单价换算：0.01 积分/次 = 10000 微积分（双向）', () => {
    expect(pointsToMicro('0.01')).toBe(10_000)
    expect(formatPoints(10_000)).toBe('0.01')
    // 默认设置就是 0.01 积分/次
    expect(DEFAULT_TOOL_SETTINGS.searchPriceMicro).toBe(10_000)
  })
})

describe('批量粘贴密钥（14 §3.2）', () => {
  it('忽略空行、去掉首尾空格、同一次粘贴里的重复只留一把', () => {
    const parsed = parsePastedKeys('\n  sk-a  \n\nsk-b\nsk-a\n  \nsk-c\n')
    expect(parsed.keys).toEqual(['sk-a', 'sk-b', 'sk-c'])
    expect(parsed.skipped).toBe(1)
  })

  it('与已有密钥重复的也算跳过', () => {
    const parsed = parsePastedKeys('sk-old\nsk-new\n', ['sk-old'])
    expect(parsed.keys).toEqual(['sk-new'])
    expect(parsed.skipped).toBe(1)
  })

  it('全是空行时没有密钥', () => {
    expect(parsePastedKeys('\n\n   \n')).toEqual({ keys: [], skipped: 0 })
  })
})

describe('密钥状态统计（14 §4）', () => {
  const now = Date.parse('2026-10-18T00:00:00.000Z')

  it('可用 / 冷却 / 额度用完 / 停用 分开数', () => {
    const counts = countToolKeys(
      [
        { state: 'active', cooldownUntil: null, cooldownReason: null },
        { state: 'active', cooldownUntil: '2026-10-18T01:00:00.000Z', cooldownReason: 'rate-limit' },
        { state: 'active', cooldownUntil: '2026-11-01T00:00:00.000Z', cooldownReason: 'exhausted' },
        { state: 'disabled', cooldownUntil: null, cooldownReason: null },
        { state: 'auto-disabled', cooldownUntil: null, cooldownReason: null },
      ] as never,
      now,
    )
    expect(counts).toEqual({ active: 1, cooling: 1, exhausted: 1, disabled: 2, total: 5 })
  })

  it('冷却原因有中文文案', () => {
    expect(cooldownReasonText('rate-limit')).toContain('限流')
    expect(cooldownReasonText('exhausted')).toContain('下月 1 日')
    expect(cooldownReasonText('error')).toContain('上游')
    expect(cooldownReasonText(null)).toBe('冷却中')
  })
})
