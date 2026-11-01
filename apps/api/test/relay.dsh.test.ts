import { describe, expect, it } from 'vitest'
import { DSH_HUB_PROVIDER_NAME } from '@dsh-hub/shared'
import {
  DSH_SYSTEM_PRESET_NAME,
  allSystemRouteNames,
  compareDshRoutes,
  deliverApiFor,
  deliverApiForRoute,
  dshRenderFingerprint,
  dshRouteBlockedReason,
  dshRouteDisplayName,
  dshRouteModelId,
  expectedDshState,
  isDshRouteDeliverable,
  isSystemRouteName,
  parseSystemRouteKey,
  systemProviderFor,
  systemRouteName,
  type DshRenderModel,
  type DshRouteInput,
} from '../src/modules/relay/dsh.js'

/**
 * 「下发到 DSH」的纯函数（16 §6.1 / §6.2，WP20a）：
 * 一个「模型 × 渠道」是一条路由；默认路由按模型 sort/name + 渠道优先级/倍率/id 自动改选；
 * 系统提供方仍按「协议 × 默认思考档位」分；渲染指纹覆盖模型@标识与显示名。
 */

function route(overrides: Partial<DshRouteInput> = {}): DshRouteInput {
  const modelId = overrides.modelId ?? 1
  return {
    routeId: 10,
    modelId,
    modelName: `model-${String(modelId)}`,
    displayName: `显示 ${String(modelId)}`,
    sort: 0,
    thinking: null,
    channelId: 1,
    channelName: 'ch-1',
    channelSlug: 'ch-1',
    channelPriority: 0,
    ratePermille: 1000,
    selected: true,
    routeEnabled: true,
    channelEnabled: true,
    modelEnabled: true,
    modelApis: ['openai-completions'],
    channelApis: ['openai-completions'],
    visibility: 'all',
    ...overrides,
  }
}

function renderModel(input: DshRouteInput): DshRenderModel {
  return {
    routeId: input.routeId,
    modelId: input.modelId,
    sort: input.sort,
    modelName: input.modelName,
    channelSlug: input.channelSlug,
    id: dshRouteModelId(input),
    name: dshRouteDisplayName(input),
    api: deliverApiForRoute(input)!,
    thinking: input.thinking,
    visibility: input.visibility,
    info: { name: input.displayName, contextWindow: 128_000 },
    compat: null,
  }
}

describe('协议与路由级阻断（16 §6.1）', () => {
  it('deliverApiFor / deliverApiForRoute：模型可用接口 ∩ 渠道 apis，按优先级取第一个', () => {
    expect(deliverApiFor(['openai-completions'])).toBe('openai-completions')
    expect(deliverApiFor(['anthropic-messages', 'openai-completions'])).toBe('openai-completions')
    expect(deliverApiFor([])).toBeNull()
    expect(
      deliverApiForRoute(
        route({
          modelApis: ['openai-completions', 'anthropic-messages'],
          channelApis: ['anthropic-messages'],
        }),
      ),
    ).toBe('anthropic-messages')
    expect(
      deliverApiForRoute(route({ modelApis: ['openai-completions'], channelApis: ['anthropic-messages'] })),
    ).toBeNull()
  })

  it('四种 blockedReason：模型已停用 / 渠道已停用 / 路由已停用 / 协议不匹配', () => {
    expect(dshRouteBlockedReason(route({ modelEnabled: false }))).toBe('模型已停用')
    expect(dshRouteBlockedReason(route({ channelEnabled: false }))).toBe('渠道已停用')
    expect(dshRouteBlockedReason(route({ routeEnabled: false }))).toBe('路由已停用')
    expect(dshRouteBlockedReason(route({ channelApis: ['anthropic-messages'] }))).toBe('协议不匹配')
    expect(dshRouteBlockedReason(route())).toBeNull()
    expect(isDshRouteDeliverable(route({ selected: false }))).toBe(false)
  })

  it('模型 id / 显示名：`<模型>@<slug>`、`<显示名> · <slug>`', () => {
    const input = route({
      modelName: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      channelSlug: 'upstream-b',
    })
    expect(dshRouteModelId(input)).toBe('deepseek-v4.1-flash@upstream-b')
    expect(dshRouteDisplayName(input)).toBe('DeepSeek V4.1 Flash · upstream-b')
  })
})

describe('系统路由名（12 §7.0，WP20a 保持）', () => {
  it('路由名 = 协议基名 + 有档位时的 -<档位>；显示名一律「DSH Hub」', () => {
    expect(systemRouteName('openai-completions', null)).toBe('hub')
    expect(systemRouteName('anthropic-messages', null)).toBe('hub-anthropic')
    expect(systemRouteName('openai-responses', 'max')).toBe('hub-responses-max')
    const provider = systemProviderFor('openai-completions', 'high')
    expect(provider.displayName).toBe(DSH_HUB_PROVIDER_NAME)
    expect(parseSystemRouteKey('hub-anthropic-high')).toEqual({ api: 'anthropic-messages', thinking: 'high' })
    expect(parseSystemRouteKey('hub-claude')).toBeNull()
    expect(allSystemRouteNames()).toHaveLength(3 * 8)
    expect(isSystemRouteName('hub-max')).toBe(true)
  })
})

describe('expectedDshState：默认路由与系统提供方（16 §6.1 §6.2）', () => {
  it('同一模型两条渠道 → 一个提供方、两个模型条目，默认按渠道优先级/倍率/id 选', () => {
    const input = [
      route({ routeId: 1, channelId: 2, channelSlug: 'b', channelPriority: 0, ratePermille: 100 }),
      route({ routeId: 2, channelId: 1, channelSlug: 'a', channelPriority: 5, ratePermille: 300 }),
    ]
    const state = expectedDshState(input, null)
    expect(state.providers.map((provider) => provider.routeKey)).toEqual(['hub'])
    expect(state.defaultRouteId).toBe(2)
    expect(state.defaultModelId).toBe(1)
    expect(state.preset).toEqual({
      name: DSH_SYSTEM_PRESET_NAME,
      providerRouteKeys: ['hub'],
      defaultProvider: 'hub',
      defaultModel: 'model-1@a',
    })
  })

  it('优先级相同按倍率升序、再按渠道 id；默认模型按 sort DESC、name ASC', () => {
    const state = expectedDshState(
      [
        route({
          routeId: 1,
          modelId: 1,
          modelName: 'bbb',
          sort: 0,
          channelId: 9,
          channelSlug: 'z',
          ratePermille: 100,
        }),
        route({
          routeId: 2,
          modelId: 2,
          modelName: 'aaa',
          sort: 0,
          channelId: 3,
          channelSlug: 'c',
          ratePermille: 100,
        }),
        route({
          routeId: 3,
          modelId: 3,
          modelName: 'zzz',
          sort: 5,
          channelId: 4,
          channelSlug: 'd',
          ratePermille: 900,
        }),
        route({
          routeId: 4,
          modelId: 3,
          modelName: 'zzz',
          sort: 5,
          channelId: 5,
          channelSlug: 'e',
          ratePermille: 100,
        }),
      ],
      null,
    )
    // sort 5 的 zzz 第一；同模型内倍率低的 e 优先
    expect(state.defaultRouteId).toBe(4)
  })

  it('请求的默认路由仍可下发时保留；失效时自动改选剩余第一条', () => {
    const inputs = [route({ routeId: 1, modelId: 1, sort: 1 }), route({ routeId: 2, modelId: 2, sort: 0 })]
    expect(expectedDshState(inputs, 2).defaultRouteId).toBe(2)
    // 选中的路由被停用 → 自动改选另一条
    const disabled = inputs.map((item) => (item.routeId === 2 ? { ...item, routeEnabled: false } : item))
    expect(expectedDshState(disabled, 2).defaultRouteId).toBe(1)
    // 都不行 → 空
    expect(
      expectedDshState(
        inputs.map((item) => ({ ...item, channelEnabled: false })),
        null,
      ),
    ).toEqual({ providers: [], defaultModelId: null, defaultRouteId: null, preset: null })
  })

  it('只有已选中且可下发的路由参与；同协议不同档位分成多条系统提供方', () => {
    const state = expectedDshState(
      [
        route({ routeId: 1, modelId: 1, sort: 2, thinking: null }),
        route({ routeId: 2, modelId: 2, sort: 1, thinking: 'high' }),
        route({ routeId: 3, modelId: 3, sort: 0, selected: false }),
        route({ routeId: 4, modelId: 4, sort: 0, channelEnabled: false }),
      ],
      1,
    )
    expect(state.providers.map((provider) => [provider.routeKey, provider.thinking])).toEqual([
      ['hub', null],
      ['hub-high', 'high'],
    ])
    expect(state.preset?.defaultModel).toBe('model-1@ch-1')
  })

  it('同一模型可同时有 openai 与 anthropic 两条渠道 → 两个提供方；默认路由所在提供方第一', () => {
    const state = expectedDshState(
      [
        route({
          routeId: 1,
          modelId: 1,
          channelId: 1,
          channelSlug: 'a',
          channelApis: ['openai-completions'],
          modelApis: ['openai-completions', 'anthropic-messages'],
        }),
        route({
          routeId: 2,
          modelId: 1,
          channelId: 2,
          channelSlug: 'b',
          channelApis: ['anthropic-messages'],
          modelApis: ['openai-completions', 'anthropic-messages'],
        }),
      ],
      2,
    )
    expect(state.providers.map((provider) => provider.routeKey)).toEqual(['hub-anthropic', 'hub'])
    expect(state.preset?.defaultProvider).toBe('hub-anthropic')
    expect(state.preset?.defaultModel).toBe('model-1@b')
  })

  it('展示顺序：模型 sort DESC/name，同模型内按 route id（渠道调优先级不改变 patch 顺序）', () => {
    const inputs = [
      route({ routeId: 3, modelId: 1, modelName: 'b', sort: 0 }),
      route({ routeId: 2, modelId: 1, modelName: 'a', sort: 0 }),
      route({ routeId: 1, modelId: 1, modelName: 'a', sort: 1 }),
    ]
    expect([...inputs].sort(compareDshRoutes).map((item) => item.routeId)).toEqual([1, 2, 3])
  })
})

describe('dshRenderFingerprint：渲染指纹', () => {
  it('路由/标识/显示名/档位参与；改倍率不影响', () => {
    const inputs = [
      route({ routeId: 1, channelSlug: 'a' }),
      route({ routeId: 2, channelSlug: 'b', channelId: 2, ratePermille: 100 }),
    ]
    const expected = expectedDshState(inputs, 1)
    const models = inputs.map(renderModel)
    const base = dshRenderFingerprint(models, expected)
    expect(dshRenderFingerprint(models, expected)).toBe(base)
    // 改倍率（渲染结果不变）→ 指纹不变
    const rateChanged = inputs.map((item) => ({ ...item, ratePermille: 999 }))
    expect(dshRenderFingerprint(rateChanged.map(renderModel), expectedDshState(rateChanged, 1))).toBe(base)
    // 改 slug（模型 id 变化）→ 指纹变化
    const slugChanged = inputs.map((item) => ({
      ...item,
      channelSlug: item.channelSlug === 'a' ? 'x' : item.channelSlug,
    }))
    expect(dshRenderFingerprint(slugChanged.map(renderModel), expectedDshState(slugChanged, 1))).not.toBe(
      base,
    )
    // 多一条选中路由 → 指纹变化
    const extra = [...inputs, route({ routeId: 3, channelSlug: 'c', channelId: 3 })]
    expect(dshRenderFingerprint(extra.map(renderModel), expectedDshState(extra, 1))).not.toBe(base)
  })
})
