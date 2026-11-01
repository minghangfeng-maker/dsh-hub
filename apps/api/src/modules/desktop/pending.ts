import {
  DESKTOP_AUTH_CODE_TTL_SECONDS,
  DESKTOP_AUTH_REQUEST_TTL_SECONDS,
  DESKTOP_MAX_EXCHANGE_ATTEMPTS,
  type DesktopAuthDevice,
} from '@dsh-hub/shared'
import type { Clock } from '../../lib/clock.js'
import { isoPlusMs } from '../../lib/clock.js'
import { randomToken, sha256Hex, timingSafeEqualStr } from '../../lib/crypto.js'

/**
 * 进行中的桌面登录请求（WP25a / D2 §3.2）。**只在内存**：
 * Hub 重启即失效（用户重新点一次即可），避免把 `code_challenge` / 一次性 `code` 这种短命秘密落库
 * （先例：一句话的一次性尝试表——只在内存里、带过期时间）。
 *
 * 一个 pending 请求的生命周期：
 *   waiting  ──用户点「允许」──►  approved（生成一次性 code，60 秒）
 *            └─用户点「拒绝」──►  denied（客户端拿 access_denied）
 *   TTL 10 分钟到点 → 410 GONE（`expired`）
 *
 * 一次性 code **只存 sha256**（与设备令牌同一纪律）：本表被 dump 也拿不到能换令牌的东西。
 */

export interface PendingAuthRequest {
  requestId: string
  /** base64url(SHA256(verifier))：客户端发来的挑战值 */
  codeChallenge: string
  /** 客户端自己比对回环回调里的 state（原样回填到 redirect，Hub 不解释它） */
  state: string
  redirectUri: string
  locale: 'zh-CN' | 'en-US'
  device: DesktopAuthDevice
  status: 'waiting' | 'approved' | 'denied'
  /** 点「允许」的网页用户 */
  userId: number | null
  /** sha256(code)；未批准时为 null */
  codeHash: string | null
  codeExpiresAt: string | null
  codeUsedAt: string | null
  /** token 兑换失败次数（≥5 销毁，防 code 爆破） */
  attempts: number
  createdAtMs: number
  expiresAt: string
}

export interface CreatePendingInput {
  codeChallenge: string
  state: string
  redirectUri: string
  locale: 'zh-CN' | 'en-US'
  device: DesktopAuthDevice
}

export interface ApproveResult {
  request: PendingAuthRequest
  /** 明文 code（只这一次；库里只有哈希） */
  code: string
  codeExpiresAt: string
}

export interface PendingStore {
  create(input: CreatePendingInput): PendingAuthRequest
  get(requestId: string): PendingAuthRequest | undefined
  /** 用户点「允许」：绑定 userId 并生成一次性 code；状态不对时抛错由 service 处理 */
  approve(requestId: string, userId: number): ApproveResult
  deny(requestId: string, userId: number): PendingAuthRequest
  /** 记一次兑换失败，返回是否还有额度 */
  failExchange(requestId: string): boolean
  /** 按明文 code 找 pending（常量时间比较哈希） */
  findByCode(code: string): PendingAuthRequest | undefined
  remove(requestId: string): void
  prune(): void
  size(): number
}

/** 内存表容量上限：超出后淘汰最旧的（防御性，正常不会到） */
export const MAX_PENDING_REQUESTS = 2000

export function isPendingExpired(request: PendingAuthRequest, nowIso: string): boolean {
  return request.expiresAt <= nowIso
}

export function createPendingStore(opts: { clock: Clock; maxRequests?: number }): PendingStore {
  const clock = opts.clock
  const maxRequests = opts.maxRequests ?? MAX_PENDING_REQUESTS
  const requests = new Map<string, PendingAuthRequest>()
  const codeIndex = new Map<string, string>()

  function prune(): void {
    const nowIso = clock.nowIso()
    for (const [id, request] of requests) {
      if (isPendingExpired(request, nowIso)) {
        if (request.codeHash) codeIndex.delete(request.codeHash)
        requests.delete(id)
      }
    }
  }

  function enforceCap(): void {
    if (requests.size <= maxRequests) return
    const sorted = [...requests.values()].sort((left, right) => left.createdAtMs - right.createdAtMs)
    for (let i = 0; i < sorted.length - maxRequests; i += 1) {
      const victim = sorted[i]!
      if (victim.codeHash) codeIndex.delete(victim.codeHash)
      requests.delete(victim.requestId)
    }
  }

  return {
    create(input) {
      prune()
      const nowIso = clock.nowIso()
      const request: PendingAuthRequest = {
        requestId: randomToken(16),
        codeChallenge: input.codeChallenge,
        state: input.state,
        redirectUri: input.redirectUri,
        locale: input.locale,
        device: input.device,
        status: 'waiting',
        userId: null,
        codeHash: null,
        codeExpiresAt: null,
        codeUsedAt: null,
        attempts: 0,
        createdAtMs: clock.now().getTime(),
        expiresAt: isoPlusMs(nowIso, DESKTOP_AUTH_REQUEST_TTL_SECONDS * 1000),
      }
      requests.set(request.requestId, request)
      enforceCap()
      return request
    },

    get(requestId) {
      return requests.get(requestId)
    },

    approve(requestId, userId) {
      const request = requests.get(requestId)
      if (!request) throw new Error('pending request not found')
      const nowIso = clock.nowIso()
      const code = randomToken(32)
      const codeHash = sha256Hex(code)
      request.status = 'approved'
      request.userId = userId
      request.codeHash = codeHash
      request.codeExpiresAt = isoPlusMs(nowIso, DESKTOP_AUTH_CODE_TTL_SECONDS * 1000)
      codeIndex.set(codeHash, requestId)
      return { request, code, codeExpiresAt: request.codeExpiresAt }
    },

    deny(requestId, userId) {
      const request = requests.get(requestId)
      if (!request) throw new Error('pending request not found')
      request.status = 'denied'
      request.userId = userId
      if (request.codeHash) codeIndex.delete(request.codeHash)
      request.codeHash = null
      return request
    },

    failExchange(requestId) {
      const request = requests.get(requestId)
      if (!request) return false
      request.attempts += 1
      if (request.attempts >= DESKTOP_MAX_EXCHANGE_ATTEMPTS) {
        this.remove(requestId)
        return false
      }
      return true
    },

    findByCode(code) {
      const codeHash = sha256Hex(code)
      const requestId = codeIndex.get(codeHash)
      if (requestId === undefined) return undefined
      const request = requests.get(requestId)
      if (!request || request.codeHash === null) return undefined
      // 常数时间比较（索引命中已经足够，这行是给「哈希碰撞/被 dump」留的纪律）
      if (!timingSafeEqualStr(request.codeHash, codeHash)) return undefined
      return request
    },

    remove(requestId) {
      const request = requests.get(requestId)
      if (request?.codeHash) codeIndex.delete(request.codeHash)
      requests.delete(requestId)
    },

    prune,

    size() {
      return requests.size
    },
  }
}

/** 请求整体有效期（给测试与文档引用） */
export const PENDING_REQUEST_TTL_MINUTES = DESKTOP_AUTH_REQUEST_TTL_SECONDS / 60
/** 一次性 code 的有效期（秒）：导出给测试用 */
export const PENDING_CODE_TTL_SECONDS = DESKTOP_AUTH_CODE_TTL_SECONDS
