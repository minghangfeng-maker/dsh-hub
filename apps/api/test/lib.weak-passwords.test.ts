import { describe, expect, it } from 'vitest'
import { checkPasswordStrength } from '../src/lib/password.js'
import { isWeakPassword, weakPasswordCount, weakPasswordSource } from '../src/lib/weak-passwords.js'

describe('弱口令黑名单（02 §5：内置 Top-1000）', () => {
  it('词表 ≥ 1000 条且来自 weak-passwords.txt', () => {
    expect(weakPasswordSource()).toBe('file')
    expect(weakPasswordCount()).toBeGreaterThanOrEqual(1000)
  })

  it('大小写与空白不敏感', () => {
    expect(isWeakPassword('password123')).toBe(true)
    expect(isWeakPassword('PassWord123')).toBe(true)
    expect(isWeakPassword('  12345678abc  ')).toBe(true)
    expect(isWeakPassword('qwerty123')).toBe(true)
    expect(isWeakPassword('dsh123456')).toBe(true)
    expect(isWeakPassword('Th1s-1s-N0t-C0mmon')).toBe(false)
  })

  it('checkPasswordStrength 命中词表（10 §B4 的两个样例）', () => {
    expect(checkPasswordStrength('12345678abc', 'someone')).toContain('这是常见弱口令')
    expect(checkPasswordStrength('password123', 'someone')).toContain('这是常见弱口令')
    expect(checkPasswordStrength('Str0ng-pass-1', 'someone')).toEqual([])
  })

  it('其余规则：长度、字符类别、不等于用户名', () => {
    expect(checkPasswordStrength('Ab1!x')).toContain('至少 10 位')
    expect(checkPasswordStrength('abcdefghijkl', 'someone')).toContain('至少包含字母、数字、符号中的两类')
    expect(checkPasswordStrength('someone', 'someone').length).toBeGreaterThan(0)
    // 与用户名相同（且够长、类别够）时只报「不能与用户名相同」
    expect(checkPasswordStrength('Some-one-123', 'some-one-123')).toEqual(['不能与用户名相同'])
  })
})
