import { describe, expect, it } from 'vitest'
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from '../src/lib/password.js'

describe('scrypt 密码哈希（02 §5）', () => {
  it('格式为 scrypt$N$r$p$saltB64$hashB64 且参数符合基线', () => {
    const stored = hashPassword('correct horse battery')
    const parts = stored.split('$')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('scrypt')
    expect(parts[1]).toBe('32768')
    expect(parts[2]).toBe('8')
    expect(parts[3]).toBe('1')
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16)
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64)
  })

  it('正确密码通过、错误密码不通过', () => {
    const stored = hashPassword('s3cret-password')
    expect(verifyPassword('s3cret-password', stored)).toBe(true)
    expect(verifyPassword('s3cret-passwore', stored)).toBe(false)
    expect(verifyPassword('', stored)).toBe(false)
  })

  it('同一密码两次哈希不同（盐随机）', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'))
  })

  it('损坏的哈希串一律返回 false（不抛错）', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', 'scrypt$0$8$1$AAA$BBB')).toBe(false)
    expect(verifyPassword('x', 'scrypt$32768$8$1$!!!$!!!')).toBe(false)
  })

  it('needsRehash 识别低参数哈希', () => {
    expect(needsRehash(hashPassword('x'))).toBe(false)
    const low = hashPassword('x', { N: 1024, r: 8, p: 1, keylen: 64 })
    expect(needsRehash(low)).toBe(true)
    expect(verifyPassword('x', low)).toBe(true)
    expect(needsRehash('garbage')).toBe(true)
  })
})

describe('密码强度（02 §5）', () => {
  it('通过：≥10 位 + 两类字符', () => {
    // 注意：`abcd123456` 这类「字母序 + 连续数字」已在 WP1 的 weak-passwords.txt 里（约 1500 条），
    // 所以这里用真正不在表里的样例
    expect(checkPasswordStrength('mint-leaf-42')).toEqual([])
    expect(checkPasswordStrength('a-very-long-passphrase')).toEqual([])
  })

  it('太短、单一字符类、等于用户名、弱口令都被拒绝', () => {
    expect(checkPasswordStrength('abc123')).toContain('至少 10 位')
    expect(checkPasswordStrength('abcdefghijkl')).toContain('至少包含字母、数字、符号中的两类')
    expect(checkPasswordStrength('alicealice', 'ALICEALICE')).toContain('不能与用户名相同')
    expect(checkPasswordStrength('password123')).toContain('这是常见弱口令')
  })
})
