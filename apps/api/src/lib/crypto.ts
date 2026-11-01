import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'
import { HubError } from './errors.js'

export const SECRET_VERSION = 'v1'
export const AES_KEY_BYTES = 32
export const AES_IV_BYTES = 12

/** `sha256(input)` 的 hex（会话 id、config_hash、文件名后缀都用它） */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** URL 安全的 base64（无 padding），用于 cookie/token */
export function base64url(input: string | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  return buf.toString('base64url')
}

export function fromBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/** 加密随机 token（默认 32 字节 → 43 字符 base64url） */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes))
}

/** 定长随机字符串（邀请码等），字符集由调用方给定 */
export function randomString(length: number, alphabet: string): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)]
  return out
}

/** 恒定时间字符串比较（长度不同直接 false，长度本身不算秘密） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function hmacSha256Base64url(key: string | Uint8Array, data: string | Uint8Array): string {
  return base64url(hmacSha256(key, data))
}

function assertMasterKey(masterKey: Uint8Array): void {
  if (masterKey.length !== AES_KEY_BYTES) {
    throw new HubError('INTERNAL', `主密钥长度必须是 ${AES_KEY_BYTES} 字节`)
  }
}

/**
 * AES-256-GCM 加密，格式 `v1:<ivB64>:<tagB64>:<cipherB64>`（03 §1）。
 * 认证标签随密文一起存，解密时校验 → 篡改必然失败。
 */
export function encryptSecret(plaintext: string, masterKey: Uint8Array): string {
  assertMasterKey(masterKey)
  const iv = randomBytes(AES_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [SECRET_VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(
    ':',
  )
}

/** 解密；格式不对/密钥不对/被篡改都抛 INTERNAL（不区分原因，避免给攻击者提示） */
export function decryptSecret(payload: string, masterKey: Uint8Array): string {
  assertMasterKey(masterKey)
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== SECRET_VERSION) {
    throw new HubError('INTERNAL', '密钥密文格式不正确')
  }
  try {
    const iv = Buffer.from(parts[1]!, 'base64')
    const tag = Buffer.from(parts[2]!, 'base64')
    const data = Buffer.from(parts[3]!, 'base64')
    if (iv.length !== AES_IV_BYTES || tag.length !== 16) throw new Error('bad iv/tag')
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new HubError('INTERNAL', '密钥解密失败')
  }
}

/** 密钥只回显末 4 位（02 §6） */
export function keyLast4(apiKey: string): string {
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4)
}
