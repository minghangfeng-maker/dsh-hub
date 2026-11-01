import { describe, expect, it } from 'vitest'
import { resolvePinnedModelName } from '../src/modules/relay/pinned.js'

/**
 * 解析 `<模型>@<slug>`（16 §3）：先整串精确匹配模型名（兼容本来名字就带 @ 的模型），
 * 找不到再按**最后一个** @ 切开，且两边都必须存在。
 */
describe('resolvePinnedModelName：指定渠道的模型名', () => {
  const models = new Set(['deepseek-v4.1-flash', 'vendor/m@v2', 'plain'])
  const channels = new Set(['upstream-c', 'upstream-b'])
  const lookups = {
    modelExists: (name: string) => models.has(name),
    channelExists: (slug: string) => channels.has(slug),
  }

  it('模型 + 已存在渠道 → 指定渠道', () => {
    expect(resolvePinnedModelName('deepseek-v4.1-flash@upstream-b', lookups)).toEqual({
      baseModel: 'deepseek-v4.1-flash',
      channelSlug: 'upstream-b',
    })
    expect(resolvePinnedModelName('plain@upstream-c', lookups)).toEqual({
      baseModel: 'plain',
      channelSlug: 'upstream-c',
    })
  })

  it('整串本身就是一个模型名 → 不指定渠道（即使里面带 @）', () => {
    expect(resolvePinnedModelName('vendor/m@v2', lookups)).toEqual({
      baseModel: 'vendor/m@v2',
      channelSlug: null,
    })
  })

  it('模型名本身带 @，后面再跟渠道 → 按最后一个 @ 切，前半段仍是完整模型名', () => {
    expect(resolvePinnedModelName('vendor/m@v2@upstream-c', lookups)).toEqual({
      baseModel: 'vendor/m@v2',
      channelSlug: 'upstream-c',
    })
  })

  it('渠道不存在 / 模型不存在 / 分隔符在首尾 → 当作没指定渠道（由调用方 404）', () => {
    expect(resolvePinnedModelName('plain@nope', lookups)).toEqual({
      baseModel: 'plain@nope',
      channelSlug: null,
    })
    expect(resolvePinnedModelName('nope@upstream-c', lookups)).toEqual({
      baseModel: 'nope@upstream-c',
      channelSlug: null,
    })
    expect(resolvePinnedModelName('@upstream-c', lookups)).toEqual({
      baseModel: '@upstream-c',
      channelSlug: null,
    })
    expect(resolvePinnedModelName('plain@', lookups)).toEqual({
      baseModel: 'plain@',
      channelSlug: null,
    })
    expect(resolvePinnedModelName('plain', lookups)).toEqual({
      baseModel: 'plain',
      channelSlug: null,
    })
  })
})
