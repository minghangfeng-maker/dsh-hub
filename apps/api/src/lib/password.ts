import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { PASSWORD_MIN_CLASSES, PASSWORD_MIN_LENGTH } from '@dsh-hub/shared'
import { isWeakPassword, weakPasswordCount } from './weak-passwords.js'

/** scrypt 参数（02 §5）；写进哈希串，将来升参数时旧密码仍可验证 */
export const SCRYPT_N = 32768
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_KEYLEN = 64
export const SCRYPT_SALT_BYTES = 16
/** 128 * N * r = 32MB，Node 默认 maxmem 也是 32MB，留一倍余量 */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

export interface ScryptParams {
  N: number
  r: number
  p: number
  keylen: number
}

const DEFAULT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keylen: SCRYPT_KEYLEN }

function scrypt(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: Math.max(SCRYPT_MAXMEM, 128 * params.N * params.r * 2),
  })
}

/** `scrypt$N$r$p$saltB64$hashB64`（02 §5，参数进串便于升级） */
export function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const hash = scrypt(password, salt, params)
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

/** 校验密码；任何解析失败都返回 false（不抛错，避免登录接口泄漏细节） */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0)
    return false
  try {
    const salt = Buffer.from(parts[4]!, 'base64')
    const expected = Buffer.from(parts[5]!, 'base64')
    // base64 里的非法字符会被忽略成空 buffer，必须显式拒绝，否则「空 == 空」会误判通过
    if (salt.length === 0 || expected.length === 0) return false
    const actual = scrypt(password, salt, { N, r, p, keylen: expected.length })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 哈希参数是否低于当前基线（登录成功后可顺手升级） */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true
  return Number(parts[1]) < SCRYPT_N || Number(parts[2]) < SCRYPT_R
}

/**
 * 密码强度检查（02 §5）：返回不满足的原因，空数组 = 通过。
 * 规则：≥10 位、至少两类字符（字母/数字/符号）、不得等于用户名、不在弱口令表里
 * （`weak-passwords.txt` + shared 内置表，见 weak-passwords.ts）。
 */
export function checkPasswordStrength(password: string, username?: string): string[] {
  const reasons: string[] = []
  if (password.length < PASSWORD_MIN_LENGTH) reasons.push(`至少 ${PASSWORD_MIN_LENGTH} 位`)
  const classes = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  if (classes < PASSWORD_MIN_CLASSES) reasons.push('至少包含字母、数字、符号中的两类')
  if (username && password.toLowerCase() === username.toLowerCase()) reasons.push('不能与用户名相同')
  if (isWeakPassword(password)) reasons.push('这是常见弱口令')
  return reasons
}

/** 弱口令词表规模（自检用：应 ≥ 1000） */
export function weakPasswordTableSize(): number {
  return weakPasswordCount()
}
