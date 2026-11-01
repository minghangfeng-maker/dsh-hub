import type { MyRelayModel, MyRelayModelRoute, MyRelayResponse } from '@dsh-hub/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import HomeModelsSection from '@/components/user/home/HomeModelsSection.vue'

/**
 * 工作台「我的模型」（16 §4.2）：把 `routes[]` 平铺成独立模型——同一模型挂三条渠道就是三行、
 * 不分组；默认第一，其余按倍率再按名字；managed 只列 inDsh；`routes` 缺省退回 WP19。
 */

const SUMMARY = {
  policy: 'managed' as const,
  preset: 'Hub 中转站',
  defaultModel: 'deepseek-v4.1-flash',
  providers: ['DSH Hub'],
}

const PRICE = {
  inputMicro: 1_000_000,
  outputMicro: 2_000_000,
  cacheReadMicro: 100_000,
  cacheWriteMicro: 1_000_000,
  perRequestMicro: 0,
}

function relay(models: MyRelayModel[]): MyRelayResponse {
  return {
    enabled: true,
    wallet: {
      userId: 12,
      balanceMicro: 12_345_000,
      ratePercent: 100,
      maxConcurrency: null,
      dailyLimitMicro: null,
      enabled: true,
      totalSpentMicro: 0,
      lastUsedAt: null,
    },
    today: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicro: 0,
    },
    month: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicro: 2_000_000,
    },
    publicBaseUrl: 'https://hub.example.com/v1',
    dshAttached: true,
    models,
  }
}

function model(overrides: Partial<MyRelayModel> & Pick<MyRelayModel, 'name'>): MyRelayModel {
  return {
    displayName: overrides.name,
    apis: ['openai-completions'],
    price: PRICE,
    channelRate: { minPermille: 100, maxPermille: 1000 },
    info: { contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] },
    ...overrides,
  }
}

function route(
  slug: string,
  ratePermille: number,
  extra: Partial<MyRelayModelRoute> = {},
): MyRelayModelRoute {
  return {
    channelSlug: slug,
    ratePermille,
    pinnedModel: `deepseek-v4.1-flash@${slug}`,
    inDsh: true,
    dshDefault: false,
    ...extra,
  }
}

function mountSection(value: MyRelayResponse) {
  return mount(HomeModelsSection, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    props: { summary: SUMMARY, relay: value },
  })
}

describe('我的模型：按「模型 × 渠道」平铺（16 §4.2）', () => {
  it('同一模型三条渠道 → 三行、不分组；默认第一，其余按倍率与名字排；价格按各自渠道算死', () => {
    const wrapper = mountSection(
      relay([
        model({
          name: 'deepseek-v4.1-flash',
          displayName: 'DeepSeek V4.1 Flash',
          info: { contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] },
          routes: [
            route('official', 1000),
            route('upstream-c', 300),
            route('upstream-b', 100, { dshDefault: true }),
          ],
        }),
      ]),
    )

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows).toHaveLength(3)
    // 平铺：没有嵌套分组的 DOM，同一模型名出现三次
    expect(rows.map((row) => row.attributes('data-model'))).toEqual([
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash',
    ])
    expect(rows.map((row) => row.attributes('data-pinned'))).toEqual([
      'deepseek-v4.1-flash@upstream-b',
      'deepseek-v4.1-flash@upstream-c',
      'deepseek-v4.1-flash@official',
    ])
    // 默认标签只在第一条
    expect(rows[0]?.find('[data-testid="home-model-default"]').exists()).toBe(true)
    expect(rows[1]?.find('[data-testid="home-model-default"]').exists()).toBe(false)
    // 渠道标签与确切价格：upstream-b ×0.1 → 输入 0.1 / 输出 0.2 / 缓存读 0.01
    expect(rows[0]?.find('[data-testid="home-model-channel"]').text()).toBe('upstream-b ×0.1')
    expect(rows[0]?.text()).toContain('0.1')
    expect(rows[0]?.text()).toContain('0.2')
    expect(rows[0]?.text()).toContain('0.01')
    // official ×1 → 原价
    expect(rows[2]?.find('[data-testid="home-model-channel"]').text()).toBe('official ×1')
    expect(rows[2]?.text()).toContain('1')
    // 显示名仍在
    expect(rows[0]?.text()).toContain('DeepSeek V4.1 Flash')
    wrapper.unmount()
  })

  it('统一管理（managed）只列 inDsh === true 的路由；同一模型未下发的渠道整行不出现', () => {
    const wrapper = mountSection(
      relay([
        model({
          name: 'deepseek-v4.1-flash',
          routes: [
            route('upstream-b', 100, { inDsh: true, dshDefault: true }),
            route('official', 1000, { inDsh: false }),
          ],
        }),
        model({ name: 'qwen3-coder', routes: [route('official', 1000, { inDsh: false })] }),
      ]),
    )

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attributes('data-pinned')).toBe('deepseek-v4.1-flash@upstream-b')
    wrapper.unmount()
  })

  it('同倍率按名字排：默认之后的顺序稳定（帮助文档里的「再按名字」）', () => {
    const wrapper = mountSection(
      relay([
        model({
          name: 'deepseek-v4.1-flash',
          routes: [route('upstream-b', 100, { dshDefault: true }), route('zeta', 300), route('alpha', 300)],
        }),
      ]),
    )

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows.map((row) => row.attributes('data-pinned'))).toEqual([
      'deepseek-v4.1-flash@upstream-b',
      'deepseek-v4.1-flash@alpha',
      'deepseek-v4.1-flash@zeta',
    ])
    wrapper.unmount()
  })

  it('后端没给 routes：退回 WP19 的按模型显示（一行一个、价格用倍率区间）', () => {
    const wrapper = mountSection(
      relay([
        model({
          name: 'deepseek-v4.1-flash',
          displayName: 'DeepSeek V4.1 Flash',
          inDsh: true,
          dshDefault: true,
          channelRate: { minPermille: 800, maxPermille: 1200 },
        }),
        model({ name: 'qwen3-coder', inDsh: false }),
      ]),
    )

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attributes('data-model')).toBe('deepseek-v4.1-flash')
    // 没有渠道标签（老界面不按渠道分）
    expect(rows[0]?.find('[data-testid="home-model-channel"]').exists()).toBe(false)
    // 价格仍是区间（WP19 的显示）
    expect(rows[0]?.text()).toContain('0.8–1.2')
    expect(rows[0]?.find('[data-testid="home-model-default"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
