import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RELAY_KEY_PREFIX } from '@dsh-hub/shared'
import {
  RELAY_KEY_RANDOM_LENGTH,
  extractRelayKey,
  generateRelayKey,
  hashRelayKey,
  relayKeyPreview,
} from '../src/modules/relay/keys.js'

const BASE62_PATTERN = /^[0-9A-Za-z]+$/

/** 剥掉前缀后的随机部分 */
function bodyOf(key: string): string {
  return key.slice(RELAY_KEY_PREFIX.length)
}

describe('generateRelayKey（12 §9 用户密钥）', () => {
  it('前缀是 sk-dsh-，长度是前缀 + 40', () => {
    expect(RELAY_KEY_RANDOM_LENGTH).toBe(40)
    expect(RELAY_KEY_PREFIX).toBe('sk-dsh-')
    const key = generateRelayKey()
    expect(key.startsWith('sk-dsh-')).toBe(true)
    expect(key).toHaveLength(RELAY_KEY_PREFIX.length + 40)
    expect(key).toHaveLength(47)
    expect(key).toMatch(/^sk-dsh-[0-9A-Za-z]{40}$/)
  })

  it('1000 把互不重复', () => {
    const keys = Array.from({ length: 1000 }, () => generateRelayKey())
    expect(new Set(keys).size).toBe(1000)
    for (const key of keys) {
      expect(key).toMatch(/^sk-dsh-[0-9A-Za-z]{40}$/)
    }
  })

  it('随机部分只含 base62（0-9A-Za-z）', () => {
    const observed = new Set<string>()
    const keys = Array.from({ length: 200 }, () => generateRelayKey())
    for (const key of keys) {
      const body = bodyOf(key)
      expect(body).toHaveLength(RELAY_KEY_RANDOM_LENGTH)
      expect(body).toMatch(BASE62_PATTERN)
      for (const char of body) observed.add(char)
    }
    // 200 × 40 = 8000 次抽样，覆盖 62 个字符几乎是必然事件；少于 40 个说明映射被写窄了
    expect(observed.size).toBeGreaterThan(40)
    for (const char of observed) expect(BASE62_PATTERN.test(char)).toBe(true)
  })
})

describe('relayKeyPreview（只显示首尾）', () => {
  it('格式是 sk-dsh- + 4 位 + … + 4 位', () => {
    const key = `${RELAY_KEY_PREFIX}ab12${'x'.repeat(32)}9xyz`
    expect(key).toHaveLength(47)
    expect(relayKeyPreview(key)).toBe('sk-dsh-ab12…9xyz')
    expect(relayKeyPreview(key)).toMatch(/^sk-dsh-[0-9A-Za-z]{4}…[0-9A-Za-z]{4}$/)
    expect(relayKeyPreview(key)).toHaveLength(RELAY_KEY_PREFIX.length + 4 + 1 + 4)
  })

  it('真实密钥的预览与首尾 4 位一致，且不含完整密钥', () => {
    const key = generateRelayKey()
    const body = bodyOf(key)
    expect(relayKeyPreview(key)).toBe(`sk-dsh-${body.slice(0, 4)}…${body.slice(-4)}`)
    expect(relayKeyPreview(key)).not.toContain(body)
    expect(relayKeyPreview(key).startsWith(RELAY_KEY_PREFIX)).toBe(true)
  })

  it('不同密钥给出不同预览', () => {
    const a = `${RELAY_KEY_PREFIX}aaaa${'1'.repeat(32)}zzzz`
    const b = `${RELAY_KEY_PREFIX}bbbb${'2'.repeat(32)}yyyy`
    expect(relayKeyPreview(a)).not.toBe(relayKeyPreview(b))
  })
})

describe('hashRelayKey（库里只存 sha256 hex）', () => {
  it('与标准 sha256 向量一致', () => {
    expect(hashRelayKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashRelayKey('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('稳定、64 位 hex，且不泄露明文', () => {
    const key = generateRelayKey()
    expect(hashRelayKey(key)).toBe(hashRelayKey(key))
    expect(hashRelayKey(key)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRelayKey(key)).toBe(createHash('sha256').update(key, 'utf8').digest('hex'))
    expect(hashRelayKey(key)).not.toContain(bodyOf(key))
  })

  it('不同密钥哈希不同', () => {
    const a = generateRelayKey()
    const b = generateRelayKey()
    expect(hashRelayKey(a)).not.toBe(hashRelayKey(b))
    // 只差 1 个字符也必须完全不同
    const body = bodyOf(a)
    const near = `${RELAY_KEY_PREFIX}${body.slice(0, -1)}${body.endsWith('a') ? 'b' : 'a'}`
    expect(hashRelayKey(near)).not.toBe(hashRelayKey(a))
  })
})

describe('extractRelayKey（请求头 → 密钥）', () => {
  const secret = generateRelayKey()

  it('Authorization: Bearer <key>', () => {
    expect(extractRelayKey({ authorization: `Bearer ${secret}` })).toBe(secret)
    expect(extractRelayKey({ Authorization: `Bearer ${secret}` })).toBe(secret)
  })

  it('Bearer 前缀大小写不敏感、允许多个空格与首尾空白', () => {
    expect(extractRelayKey({ authorization: `bearer ${secret}` })).toBe(secret)
    expect(extractRelayKey({ authorization: `BEARER ${secret}` })).toBe(secret)
    expect(extractRelayKey({ authorization: `Bearer    ${secret}` })).toBe(secret)
    expect(extractRelayKey({ authorization: `Bearer\t${secret}` })).toBe(secret)
    expect(extractRelayKey({ authorization: `  Bearer ${secret}  ` })).toBe(secret)
  })

  it('x-api-key / X-Api-Key 直接给密钥', () => {
    expect(extractRelayKey({ 'x-api-key': secret })).toBe(secret)
    expect(extractRelayKey({ 'X-Api-Key': secret })).toBe(secret)
    expect(extractRelayKey({ 'X-API-KEY': `  ${secret} ` })).toBe(secret)
  })

  it('头值是数组时取第一个', () => {
    expect(extractRelayKey({ authorization: [`Bearer ${secret}`, 'Bearer other'] })).toBe(secret)
    expect(extractRelayKey({ 'x-api-key': [secret] })).toBe(secret)
    // 第一个不合格也不回退到数组后面的元素
    expect(extractRelayKey({ authorization: ['Basic nope', `Bearer ${secret}`] })).toBe(null)
    // 空数组
    expect(extractRelayKey({ authorization: [] })).toBe(null)
  })

  it('没有密钥或格式不对 → null', () => {
    expect(extractRelayKey({})).toBe(null)
    expect(extractRelayKey({ authorization: undefined, 'x-api-key': undefined })).toBe(null)
    expect(extractRelayKey({ authorization: '' })).toBe(null)
    expect(extractRelayKey({ authorization: 'Bearer' })).toBe(null)
    expect(extractRelayKey({ authorization: `Basic ${secret}` })).toBe(null)
    expect(extractRelayKey({ authorization: secret.replace('sk-dsh-', 'sk-') })).toBe(null)
    expect(extractRelayKey({ authorization: 'Bearer sk-other-1234567890' })).toBe(null)
    expect(extractRelayKey({ 'x-api-key': 'sk-live-abc' })).toBe(null)
    expect(extractRelayKey({ cookie: `session=${secret}` })).toBe(null)
  })

  it('Authorization 不合格时回退到 x-api-key', () => {
    expect(extractRelayKey({ authorization: 'Basic nope', 'x-api-key': secret })).toBe(secret)
    expect(extractRelayKey({ authorization: 'Basic nope', 'x-api-key': 'nope' })).toBe(null)
  })

  it('返回值一律以 sk-dsh- 开头', () => {
    const key = extractRelayKey({ 'X-Api-Key': secret })
    expect(key).not.toBe(null)
    expect(key?.startsWith(RELAY_KEY_PREFIX)).toBe(true)
    // 返回的是可哈希的明文本身
    expect(hashRelayKey(key ?? '')).toBe(hashRelayKey(secret))
  })
})
