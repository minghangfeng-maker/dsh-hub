/**
 * 模型目录与思考程度映射（M5 §17 冻结项 D3）：
 *   低=off、中等=low、高=high、超高=max；档位按模型 `efforts[].id` 匹配；
 *   没有 reasoning 的模型整块置灰。
 */

import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVELS,
  availableTiers,
  catalogFromServer,
  chipLabel,
  dshEffortIdOfTier,
  effortIdForSelection,
  flattenModelCatalog,
  normalizeSelection,
  selectionFromServer,
  supportsThinking,
  tierAvailable,
  tierOfDshEffort,
  toStoredSelection,
} from '../src/models/catalog.js'
import { MOCK_MODEL_CATALOG } from '../src/mock/models-catalog.js'
import { V2_FIXTURES_DIR, readFixture } from './helpers/fixture.js'

describe('四档 ↔ DSH effort 映射（§17）', () => {
  it('一一对应：低=off、中等=low、高=high、超高=max', () => {
    expect(EFFORT_LEVELS.map((e) => [e.id, e.label, e.dshEffortId])).toEqual([
      ['low', '低', 'off'],
      ['medium', '中等', 'low'],
      ['high', '高', 'high'],
      ['ultra', '超高', 'max'],
    ])
    expect(dshEffortIdOfTier('low')).toBe('off')
    expect(tierOfDshEffort('off')).toBe('low')
    expect(tierOfDshEffort('max')).toBe('ultra')
  })

  it('未知 effort id 忽略（返回 null，不猜）', () => {
    expect(tierOfDshEffort('ultra')).toBeNull()
    expect(tierOfDshEffort('weird')).toBeNull()
    expect(tierOfDshEffort(undefined)).toBeNull()
  })
})

describe('fixture 形状 → 目录', () => {
  it('mock 目录与 fixtures-v2/models-catalog.json 形状一致', () => {
    const fixture = readFixture<typeof MOCK_MODEL_CATALOG>('models-catalog.json', V2_FIXTURES_DIR)
    expect(MOCK_MODEL_CATALOG).toEqual(fixture)
  })

  it('摊平后保留 provider/model/efforts/defaultEffort', () => {
    const catalog = flattenModelCatalog(MOCK_MODEL_CATALOG, 'cloud:self')
    expect(catalog.source).toBe('mock')
    expect(catalog.items).toHaveLength(2)
    expect(catalog.items[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
    })
    expect(catalog.items[0]!.efforts.map((e) => e.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(catalog.items[0]!.defaultEffort).toBe('high')
    expect(catalog.default).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effort: 'low',
    })
  })

  it('四档全部可用（模型暴露 off/low/high/max）', () => {
    const catalog = flattenModelCatalog(MOCK_MODEL_CATALOG, 'cloud:self')
    const model = catalog.items[0]!
    expect(supportsThinking(model)).toBe(true)
    expect(availableTiers(model)).toEqual(['low', 'medium', 'high', 'ultra'])
  })

  it('模型只有部分档位时，缺的档位置灰', () => {
    const catalog = catalogFromServer({
      backendId: 'cloud:self',
      items: [
        {
          provider: 'p',
          model: 'm',
          name: 'M',
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      ],
    })
    const model = catalog.items[0]!
    expect(tierAvailable(model, 'low')).toBe(true)
    expect(tierAvailable(model, 'high')).toBe(true)
    expect(tierAvailable(model, 'medium')).toBe(false) // 需要 low，模型没有
    expect(tierAvailable(model, 'ultra')).toBe(false) // 需要 max，模型没有
    expect(availableTiers(model)).toEqual(['low', 'high'])
  })

  it('没有 reasoning 的模型：整块置灰，芯片显示 —', () => {
    const catalog = catalogFromServer({
      backendId: 'cloud:self',
      items: [
        {
          provider: 'p',
          model: 'plain',
          name: 'Plain',
          efforts: [],
          defaultEffort: null,
        },
      ],
    })
    const model = catalog.items[0]!
    expect(supportsThinking(model)).toBe(false)
    expect(availableTiers(model)).toEqual([])
    for (const level of EFFORT_LEVELS) expect(tierAvailable(model, level.id)).toBe(false)

    const selection = normalizeSelection(catalog, null)
    expect(selection).toEqual({ provider: 'p', model: 'plain', effortTier: null })
    expect(chipLabel(selection)).toBe('思考程度 —')
    expect(effortIdForSelection(catalog, selection)).toBeUndefined()
  })
})

describe('选择归一化与持久化', () => {
  const catalog = flattenModelCatalog(MOCK_MODEL_CATALOG, 'cloud:self')

  it('未保存过：用默认模型 + 该模型默认档（high）', () => {
    expect(normalizeSelection(catalog, null)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effortTier: 'high',
    })
  })

  it('保存过的档位仍可用就沿用（超高=max）', () => {
    const selection = normalizeSelection(catalog, {
      modelId: 'deepseek-official/deepseek-v4-pro',
      effortId: 'max',
    })
    expect(selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effortTier: 'ultra',
    })
    expect(chipLabel(selection)).toBe('思考程度 超高')
  })

  it('模型不存在 / 档位不被支持时回落到默认', () => {
    expect(
      normalizeSelection(catalog, { modelId: 'nope/nope', effortId: 'max' })?.model,
    ).toBe('deepseek-flash')
    const partial = catalogFromServer({
      backendId: 'cloud:self',
      items: [
        { provider: 'p', model: 'm', name: 'M', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      ],
    })
    expect(
      normalizeSelection(partial, { modelId: 'p/m', effortId: 'max' })?.effortTier,
    ).toBe('high')
  })

  it('存回去用 provider/model 与 DSH effort id（不是 App 档位名）', () => {
    const selection = normalizeSelection(catalog, {
      modelId: 'deepseek-official/deepseek-flash',
      effortId: 'off',
    })!
    expect(toStoredSelection(selection)).toEqual({
      modelId: 'deepseek-official/deepseek-flash',
      effortId: 'off',
    })
    expect(effortIdForSelection(catalog, selection)).toBe('off')
  })

  it('服务端 current 选择 → App 选择', () => {
    const selection = selectionFromServer(catalog, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effort: 'max',
    })
    expect(selection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effortTier: 'ultra',
    })
  })
})
