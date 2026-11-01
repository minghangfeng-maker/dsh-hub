import { describe, expect, it } from 'vitest'
import {
  RELAY_CHANNEL_SLUG_MAX_LENGTH,
  autoChannelSlug,
  slugBaseFromName,
  uniqueChannelSlug,
} from '../src/modules/relay/slug.js'

/**
 * 渠道标识生成（16 §2）：转小写、只保留 a-z0-9，其它字符段换成 `-`，截 24 位；
 * 空结果用 `ch<id>`，冲突依次加 `-2`、`-3`……
 */
describe('slugBaseFromName：按名称生成标识', () => {
  it('中文名（「上游渠道 upstream-c 池」）→ upstream-c', () => {
    expect(slugBaseFromName('上游渠道 upstream-c 池')).toBe('upstream-c')
    expect(slugBaseFromName('upstream-b')).toBe('upstream-b')
    expect(slugBaseFromName('上游渠道 B')).toBe('b')
  })

  it('大写转小写；空格、下划线、点等连续段换成一个 -，首尾去掉', () => {
    expect(slugBaseFromName('  My_Channel.Name  ')).toBe('my-channel-name')
    expect(slugBaseFromName('...a---b...')).toBe('a-b')
  })

  it('全符号 → 空串（由调用方回退 ch<id>）', () => {
    expect(slugBaseFromName('！！！')).toBe('')
    expect(slugBaseFromName('---')).toBe('')
    expect(slugBaseFromName('')).toBe('')
  })

  it('超长截到 24 位，且不会留下末尾的 -', () => {
    const long = 'a'.repeat(30)
    expect(slugBaseFromName(long)).toHaveLength(RELAY_CHANNEL_SLUG_MAX_LENGTH)
    expect(slugBaseFromName(`${'a'.repeat(23)}-中文`)).toBe('a'.repeat(23))
    expect(slugBaseFromName(`${'a'.repeat(23)}-中文`)).toHaveLength(23)
  })
})

describe('uniqueChannelSlug / autoChannelSlug：冲突处理', () => {
  it('不冲突时原样返回；冲突依次加 -2、-3', () => {
    expect(uniqueChannelSlug('upstream-c', new Set())).toBe('upstream-c')
    expect(uniqueChannelSlug('upstream-c', new Set(['upstream-c']))).toBe('upstream-c-2')
    expect(uniqueChannelSlug('upstream-c', new Set(['upstream-c', 'upstream-c-2']))).toBe('upstream-c-3')
  })

  it('加后缀后仍不超过 24 位，并去掉截断产生的末尾 -', () => {
    const base = 'a'.repeat(24)
    const slug = uniqueChannelSlug(base, new Set([base]))
    expect(slug.length).toBeLessThanOrEqual(24)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe(`${'a'.repeat(22)}-2`)
  })

  it('空名称回退 ch<id>，冲突时也加后缀', () => {
    expect(autoChannelSlug('！！！', 7, new Set())).toBe('ch7')
    expect(autoChannelSlug('', 7, new Set(['ch7']))).toBe('ch7-2')
    expect(autoChannelSlug('中文', 12, new Set())).toBe('ch12')
  })
})
