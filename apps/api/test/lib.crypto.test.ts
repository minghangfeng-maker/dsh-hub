import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  base64url,
  decryptSecret,
  encryptSecret,
  fromBase64url,
  hmacSha256Base64url,
  keyLast4,
  randomString,
  randomToken,
  sha256Hex,
  timingSafeEqualStr,
} from '../src/lib/crypto.js'

const KEY = randomBytes(32)

describe('crypto', () => {
  it('sha256Hex 与标准向量一致', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('base64url 无 padding 且可还原', () => {
    expect(base64url('hello')).toBe('aGVsbG8')
    expect(base64url('a?b>c')).not.toContain('=')
    expect(fromBase64url(base64url('中文')).toString('utf8')).toBe('中文')
  })

  it('randomToken 默认 32 字节且不重复', () => {
    const a = randomToken()
    const b = randomToken()
    expect(a).not.toBe(b)
    expect(fromBase64url(a)).toHaveLength(32)
    expect(randomToken(16)).toHaveLength(22)
  })

  it('randomString 只用给定字符集', () => {
    const value = randomString(64, 'ab')
    expect(value).toMatch(/^[ab]{64}$/)
  })

  it('timingSafeEqualStr 正确比较', () => {
    expect(timingSafeEqualStr('token', 'token')).toBe(true)
    expect(timingSafeEqualStr('token', 'tokeN')).toBe(false)
    expect(timingSafeEqualStr('token', 'token-longer')).toBe(false)
  })

  it('hmacSha256Base64url 稳定', () => {
    expect(hmacSha256Base64url('key', 'data')).toBe(hmacSha256Base64url('key', 'data'))
    expect(hmacSha256Base64url('key', 'data')).not.toBe(hmacSha256Base64url('key2', 'data'))
  })
})

describe('encryptSecret / decryptSecret（03 §1 格式）', () => {
  it('往返一致，格式为 v1:iv:tag:cipher', () => {
    const payload = encryptSecret('sk-1234567890', KEY)
    const parts = payload.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(decryptSecret(payload, KEY)).toBe('sk-1234567890')
  })

  it('同一明文两次加密结果不同（随机 IV）', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY))
  })

  it('篡改密文/标签会被检测出来', () => {
    const payload = encryptSecret('secret-value', KEY)
    const [version, iv, tag, cipher] = payload.split(':')
    const flipped = Buffer.from(cipher!, 'base64')
    flipped[0] = flipped[0]! ^ 0xff
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':')
    expect(() => decryptSecret(tampered, KEY)).toThrow(/解密失败/)

    const flippedTag = Buffer.from(tag!, 'base64')
    flippedTag[0] = flippedTag[0]! ^ 0xff
    expect(() => decryptSecret([version, iv, flippedTag.toString('base64'), cipher].join(':'), KEY)).toThrow(
      /解密失败/,
    )
  })

  it('换密钥解不开，格式错误也抛错', () => {
    const payload = encryptSecret('secret-value', KEY)
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow(/解密失败/)
    expect(() => decryptSecret('v2:a:b:c', KEY)).toThrow(/格式不正确/)
    expect(() => decryptSecret('not-a-payload', KEY)).toThrow(/格式不正确/)
    expect(() => encryptSecret('x', randomBytes(16))).toThrow(/主密钥长度/)
  })

  it('keyLast4 只回显末 4 位', () => {
    expect(keyLast4('sk-abcdefgh')).toBe('efgh')
    expect(keyLast4('abc')).toBe('abc')
  })
})
