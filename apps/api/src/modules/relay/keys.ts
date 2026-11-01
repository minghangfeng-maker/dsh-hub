import { createHash, randomBytes } from 'node:crypto'
import { RELAY_KEY_PREFIX } from '@dsh-hub/shared'

/** 用户密钥：`sk-dsh-` + 40 位 base62（这里只描述随机部分的长度） */
export const RELAY_KEY_RANDOM_LENGTH = 40

/** base62 字母表 `0-9A-Za-z`；顺序无所谓，只要每个字符等概率即可 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * 拒绝采样阈值：256 不是 62 的整数倍，直接对所有字节取模会让字母表前 8 个字符偏多。
 * 248 = 4 × 62，[0, 248) 内的字节正好 4 个一组均匀落到 62 个字符上，≥ 248 的丢弃重抽。
 */
const REJECT_FROM = 248

/** 生成一把新的用户密钥明文（只在新建 / 重置后返回一次，之后库里只有哈希） */
export function generateRelayKey(): string {
  let random = ''
  while (random.length < RELAY_KEY_RANDOM_LENGTH) {
    // 接受率 248/256 ≈ 96.9%，一轮取整长度的字节基本就够；不够再抽一轮
    for (const byte of randomBytes(RELAY_KEY_RANDOM_LENGTH)) {
      if (byte >= REJECT_FROM) continue
      // 用整除而不是取模：byte ∈ [0,248) 时 floor(byte / 4) ∈ [0,62) 均匀
      random += BASE62.charAt(Math.floor(byte / 4))
      if (random.length === RELAY_KEY_RANDOM_LENGTH) break
    }
  }
  return `${RELAY_KEY_PREFIX}${random}`
}

/** 算密钥的 sha256（hex），即库里的 `key_hash`：明文永不落库，比对时再哈希请求里的密钥 */
export function hashRelayKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** 显示用预览：`sk-dsh-ab12…9xyz`（前缀 + 随机部分前 4 + `…` + 后 4），避免明文出现在界面与日志里 */
export function relayKeyPreview(secret: string): string {
  const body = secret.startsWith(RELAY_KEY_PREFIX) ? secret.slice(RELAY_KEY_PREFIX.length) : secret
  // 太短就整体显示：4 + 4 会重叠，预览反而泄露全部随机部分
  if (body.length <= 8) return `${RELAY_KEY_PREFIX}${body}`
  return `${RELAY_KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`
}

/** 按头名取值：HTTP 头名大小写不敏感，而 fastify / Node 保留客户端原始大小写，所以逐个小写比对 */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/** 解析一个头值：数组取第一个，允许大小写不敏感且可带多个空格的 `Bearer` 前缀，最终必须是密钥前缀 */
function parseKeyValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return null
  let candidate = raw.trim()
  const bearer = /^bearer\s+/i.exec(candidate)
  if (bearer !== null) candidate = candidate.slice(bearer[0].length).trim()
  return candidate.startsWith(RELAY_KEY_PREFIX) ? candidate : null
}

/** 从请求头里取密钥：`Authorization: Bearer sk-dsh-…` 或 `x-api-key: sk-dsh-…`；没有 / 格式不对返回 null */
export function extractRelayKey(headers: Record<string, string | string[] | undefined>): string | null {
  return (
    parseKeyValue(readHeader(headers, 'authorization')) ?? parseKeyValue(readHeader(headers, 'x-api-key'))
  )
}

/**
 * 用量的来源（WP25a / D6 §7.3）：**由凭据决定，不由请求自述**。
 * - 桌面设备专用密钥（`relay_keys.device_id` 非空）→ `desktop`
 * - 容器里注入的 system 密钥（`HUB_MK_*`）→ `docker`
 * - 用户自建密钥 → `external`
 * - 其它（历史数据 / 判定不出来）→ `unknown`
 */
export type RelayClientKind = 'docker' | 'desktop' | 'external' | 'unknown'

export function relayClientKindOf(key: { kind: 'system' | 'user'; deviceId?: string | null }): RelayClientKind {
  if (key.deviceId) return 'desktop'
  return key.kind === 'system' ? 'docker' : 'external'
}
