import { createHash } from 'node:crypto'
import type { ModelApi } from '@dsh-hub/shared'

/**
 * 候选渠道排序（12 §5.1，**纯函数**）：优先级分层 → 层内加权会合哈希 → 渠道内密钥排序 →
 * 熔断/并发满的渠道沉底 → 展开成「渠道 × 密钥」候选序列。
 *
 * 为什么用会合哈希（rendezvous hashing）而不是轮询：同一用户 + 同一模型稳定落到同一渠道，
 * 上游的提示缓存才命中得了；同时整体又按权重分流。
 */

/** 渠道里的一把上游密钥（只保留排序需要的字段） */
export interface RelayRouterKey {
  keyId: number
  state: 'active' | 'disabled' | 'auto-disabled'
  /** 429 冷却到何时（ISO）；null = 未冷却 */
  cooldownUntil: string | null
}

/** 一条路由 + 它所在渠道的状态（调用方查库后拼好） */
export interface RelayRouterRoute {
  routeId: number
  channelId: number
  channelName: string
  upstreamModel: string
  /** 路由上的值；null = 用渠道的 */
  priority: number | null
  weight: number | null
  routeEnabled: boolean
  channelEnabled: boolean
  channelApis: ModelApi[]
  channelPriority: number
  channelWeight: number
  channelCooldownUntil: string | null
  /** 渠道并发上限，0 = 不限 */
  channelMaxConcurrency: number
  channelInFlight: number
  keys: RelayRouterKey[]
}

export interface RelayRouterInput {
  api: ModelApi
  routes: RelayRouterRoute[]
  /** 会合哈希键：`${userId}:${对外模型名}` */
  stickyKey: string
  now: string
  /** `settings.relay.maxAttempts`：最多尝试几个「渠道 × 密钥」 */
  maxAttempts: number
}

export interface RelayCandidate {
  routeId: number
  channelId: number
  channelName: string
  upstreamModel: string
  keyId: number
  /** 该渠道内第几个候选密钥（0 起） */
  keyIndex: number
  /** 排到最后（熔断中或并发已满）的兜底候选 */
  lastResort: boolean
}

export type RelayRouterOutcome =
  | { kind: 'ok'; candidates: RelayCandidate[] }
  /** 有启用的路由，但没有一条支持本次接口的协议（400） */
  | { kind: 'unsupported_endpoint' }
  /** 没有任何可用渠道（400/503 之外：全停用 / 没密钥 / 渠道并发满） */
  | { kind: 'no_available_channel' }

/** 53 位整数上界（`2 ** 53`，超过它 JS 的 number 就不精确了） */
const TWO_POW_53 = 2 ** 53

/** `sha256(key)` 的高 53 位 → (0, 1] 上的均匀数（HRW 的 u） */
export function hashUnit(key: string): number {
  const digest = createHash('sha256').update(key).digest()
  const high = digest.readUInt32BE(0) * 2 ** 21 + (digest.readUInt32BE(4) >>> 11)
  return (high + 1) / TWO_POW_53
}

/**
 * 加权会合哈希打分：`score = -weight / ln(u)`（u 是 (0,1] 的哈希值）。
 * 取分数最大的节点；权重 w 的节点获胜概率 ∝ w（3:1 的两个节点约 75% / 25%）。
 */
export function rendezvousScore(stickyKey: string, nodeId: number | string, weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  const u = hashUnit(`${stickyKey}#${String(nodeId)}`)
  const score = -w / Math.log(u)
  return Number.isFinite(score) ? score : Number.MAX_VALUE
}

function effectivePriority(route: RelayRouterRoute): number {
  return route.priority ?? route.channelPriority
}

function effectiveWeight(route: RelayRouterRoute): number {
  const weight = route.weight ?? route.channelWeight
  return Number.isFinite(weight) && weight > 0 ? weight : 1
}

/** 密钥是否可用：active 且不在冷却中 */
function isKeyUsable(key: RelayRouterKey, nowMs: number): boolean {
  if (key.state !== 'active') return false
  if (!key.cooldownUntil) return true
  const until = Date.parse(key.cooldownUntil)
  return !Number.isFinite(until) || until <= nowMs
}

function isCooling(route: RelayRouterRoute, nowMs: number): boolean {
  if (!route.channelCooldownUntil) return false
  const until = Date.parse(route.channelCooldownUntil)
  return Number.isFinite(until) && until > nowMs
}

function isConcurrencyFull(route: RelayRouterRoute): boolean {
  return route.channelMaxConcurrency > 0 && route.channelInFlight >= route.channelMaxConcurrency
}

/**
 * 排序候选。返回的 `candidates` 已经是尝试顺序（前 `maxAttempts` 条由调用方截断；
 * 这里直接截断，避免生成无用的长列表）。
 */
export function planCandidates(input: RelayRouterInput): RelayRouterOutcome {
  const nowMs = Date.parse(input.now)
  const enabledRoutes = input.routes.filter((route) => route.routeEnabled && route.channelEnabled)
  if (enabledRoutes.length === 0) return { kind: 'no_available_channel' }
  const supported = enabledRoutes.filter((route) => route.channelApis.includes(input.api))
  if (supported.length === 0) return { kind: 'unsupported_endpoint' }

  interface Prepared {
    route: RelayRouterRoute
    keys: RelayRouterKey[]
    priority: number
    lastResort: boolean
    score: number
  }

  const prepared: Prepared[] = []
  for (const route of supported) {
    const keys = route.keys.filter((key) => isKeyUsable(key, nowMs))
    if (keys.length === 0) continue
    // 同一渠道内的密钥也走会合哈希：换渠道不换密钥、换密钥不换渠道，两者都对缓存友好
    keys.sort(
      (a, b) =>
        rendezvousScore(input.stickyKey, `key:${String(b.keyId)}`, 1) -
        rendezvousScore(input.stickyKey, `key:${String(a.keyId)}`, 1),
    )
    prepared.push({
      route,
      keys,
      priority: effectivePriority(route),
      lastResort: isCooling(route, nowMs) || isConcurrencyFull(route),
      score: rendezvousScore(input.stickyKey, route.routeId, effectiveWeight(route)),
    })
  }
  if (prepared.length === 0) return { kind: 'no_available_channel' }

  // 优先级降序 → 同层按会合哈希降序
  prepared.sort((a, b) => b.priority - a.priority || b.score - a.score)
  // 稳定分区：熔断中/并发满的渠道沉底（只在前面都试完时才用）
  const healthy = prepared.filter((item) => !item.lastResort)
  const lastResort = prepared.filter((item) => item.lastResort)
  const ordered = [...healthy, ...lastResort]

  const candidates: RelayCandidate[] = []
  const max = Math.max(1, Math.trunc(input.maxAttempts))
  for (const item of ordered) {
    for (const [index, key] of item.keys.entries()) {
      candidates.push({
        routeId: item.route.routeId,
        channelId: item.route.channelId,
        channelName: item.route.channelName,
        upstreamModel: item.route.upstreamModel,
        keyId: key.keyId,
        keyIndex: index,
        lastResort: item.lastResort,
      })
      if (candidates.length >= max) return { kind: 'ok', candidates }
    }
  }
  return { kind: 'ok', candidates }
}
