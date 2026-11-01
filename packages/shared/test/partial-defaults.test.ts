import { describe, expect, it } from 'vitest'
import * as shared from '../src/index.js'

/**
 * zod 4 的 `.partial()` 仍会给缺省字段填 `.default()`：PATCH 只改一个字段，其它字段会被悄悄重置成默认值。
 * 所有「修改」请求（`Update*RequestSchema`）解析空对象都必须得到空对象。
 */
describe('Update*RequestSchema 不注入默认值', () => {
  const updateSchemas = Object.entries(shared).filter(
    ([name, value]) =>
      name.startsWith('Update') &&
      name.endsWith('RequestSchema') &&
      typeof (value as { safeParse?: unknown }).safeParse === 'function',
  ) as [string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }][]

  it('至少覆盖到渠道与提供方', () => {
    const names = updateSchemas.map(([name]) => name)
    expect(names).toContain('UpdateRelayChannelRequestSchema')
    expect(names).toContain('UpdateProviderRequestSchema')
  })

  it.each(updateSchemas)('%s.parse({}) 不带出任何字段', (_name, schema) => {
    const result = schema.safeParse({})
    if (result.success) expect(result.data).toEqual({})
  })

  it('只改渠道名不会重置倍率、优先级、备注', () => {
    expect(shared.UpdateRelayChannelRequestSchema.parse({ name: 'x' })).toEqual({ name: 'x' })
    expect(shared.UpdateRelayChannelRequestSchema.parse({ ratePermille: 1500 })).toEqual({
      ratePermille: 1500,
    })
  })

  it('只改提供方显示名不会清空模型列表', () => {
    expect(shared.UpdateProviderRequestSchema.parse({ displayName: 'x' })).toEqual({ displayName: 'x' })
  })
})
