import type { RelayModel, RelayRoute } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  channelRoutes,
  pickerRows,
  routesWithoutChannel,
  toImportEntries,
  type PickerModel,
} from '@/components/admin/relay/picker'
import { isUnpricedModel } from '@/utils/relay-model'

/**
 * 模型选择器的纯逻辑（WP11b 交付物 2/3/9）：本渠道已有路由、合并 discover 结果、
 * 生成 `import`（**不带价格**）、取消勾选时算出去掉本渠道之后的 `routes`。
 */

function route(id: number, channelId: number, upstreamModel: string, extra: Partial<RelayRoute> = {}): RelayRoute {
  return {
    id,
    channelId,
    channelName: `渠道 ${channelId}`,
    channelRatePermille: channelId === 1 ? 1500 : 1000,
    upstreamModel,
    priority: null,
    weight: null,
    enabled: true,
    ...extra,
  }
}

function model(id: number, name: string, routes: RelayRoute[], price = 1_000_000): RelayModel {
  return {
    id,
    name,
    displayName: name.toUpperCase(),
    enabled: true,
    visibility: 'all',
    price: {
      inputMicro: price,
      outputMicro: price * 2,
      cacheReadMicro: null,
      cacheWriteMicro: null,
      perRequestMicro: 0,
    },
    info: {},
    defaultThinking: null,
    compat: null,
    routes,
    apis: ['openai-completions'],
    sort: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

function upstream(id: string, extra: Partial<PickerModel> = {}): PickerModel {
  return { id, name: id, existingModelId: null, ...extra }
}

describe('channelRoutes / pickerRows', () => {
  const models = [
    model(1, 'flash', [route(101, 1, 'flash'), route(102, 2, 'flash-upstream')]),
    model(2, 'deepseek-v3', [route(103, 1, 'deepseek-v3')]),
  ]

  it('channelRoutes 只取本渠道的路由', () => {
    const routes = channelRoutes(models, 1)
    expect(routes.map((item) => item.upstreamModel)).toEqual(['flash', 'deepseek-v3'])
    expect(routes.map((item) => item.model.name)).toEqual(['flash', 'deepseek-v3'])
    expect(channelRoutes(models, null)).toEqual([])
    expect(channelRoutes(models, 99)).toEqual([])
  })

  it('pickerRows：上游没返回、但已经挂在本渠道的模型也要出现（否则没法取消勾选）', () => {
    const discovered = [upstream('flash', { contextWindow: 1000, existingModelId: 1 }), upstream('glm-4.7')]
    const rows = pickerRows(discovered, channelRoutes(models, 1), models)

    expect(rows.map((row) => row.id)).toEqual(['flash', 'glm-4.7', 'deepseek-v3'])
    // 已有的那条补上名称与对外模型 id
    const extra = rows[2]!
    expect(extra.existingModelId).toBe(2)
    expect(extra.name).toBe('DEEPSEEK-V3')
  })
})

describe('toImportEntries（import 不带价格）', () => {
  const rows: PickerModel[] = [
    upstream('flash', { contextWindow: 1000, maxTokens: 500, input: ['text', 'image'], existingModelId: 1 }),
    upstream('glm-4.7', { name: 'GLM 4.7' }),
    upstream('manual-model'),
  ]

  it('只发勾选且不在本渠道的；已有模型不重复发', () => {
    const entries = toImportEntries(rows, ['flash', 'glm-4.7', 'manual-model'], ['flash'])
    expect(entries.map((entry) => entry.upstreamModel)).toEqual(['glm-4.7', 'manual-model'])
  })

  it('每项都不带 price（价格由「模型与价格」定）', () => {
    const entries = toImportEntries(rows, ['glm-4.7'], [])
    expect(entries[0]).not.toHaveProperty('price')
    expect(JSON.stringify(entries)).not.toContain('price')
  })

  it('模型信息只带填了的字段；显示名与 id 相同时不发 displayName', () => {
    const [flash] = toImportEntries([rows[0]!], ['flash'], [])
    expect(flash!.info).toEqual({
      contextWindow: 1000,
      maxTokens: 500,
      input: ['text', 'image'],
    })
    const [manual] = toImportEntries([rows[2]!], ['manual-model'], [])
    expect(manual!.displayName).toBeUndefined()
    expect(manual!.info).toEqual({})
  })

  it('没勾选就是空数组', () => {
    expect(toImportEntries(rows, [], [])).toEqual([])
  })
})

describe('routesWithoutChannel', () => {
  it('去掉本渠道的这条路由，其余原样转成 RelayRouteInput', () => {
    const target = model(1, 'flash', [
      route(101, 1, 'flash', { priority: 10, weight: 3 }),
      route(102, 2, 'flash-upstream', { enabled: false }),
    ])
    expect(routesWithoutChannel(target, 1, 'flash')).toEqual([
      { channelId: 2, upstreamModel: 'flash-upstream', priority: null, weight: null, enabled: false },
    ])
  })

  it('同一个渠道的其它上游名不受影响', () => {
    const target = model(1, 'flash', [route(101, 1, 'a'), route(102, 1, 'b')])
    expect(routesWithoutChannel(target, 1, 'a').map((item) => item.upstreamModel)).toEqual(['b'])
  })

  it('去掉最后一条 → 空数组（模型变成「无渠道」，模型与价格保留）', () => {
    const target = model(1, 'flash', [route(101, 1, 'flash')])
    expect(routesWithoutChannel(target, 1, 'flash')).toEqual([])
    expect(target.name).toBe('flash')
  })
})

describe('isUnpricedModel（未定价状态胶囊 / 概览告警）', () => {
  it('五项全 0（缓存 null 按 0）才算未定价', () => {
    expect(isUnpricedModel(model(1, 'a', [], 0))).toBe(true)
    expect(isUnpricedModel(model(1, 'a', [], 1))).toBe(false)
  })

  it('只要有任一项有价就不是未定价', () => {
    const withPerRequest = model(1, 'a', [], 0)
    withPerRequest.price.perRequestMicro = 1_000
    expect(isUnpricedModel(withPerRequest)).toBe(false)

    const withCache = model(1, 'a', [], 0)
    withCache.price.cacheReadMicro = 500
    expect(isUnpricedModel(withCache)).toBe(false)
  })
})
