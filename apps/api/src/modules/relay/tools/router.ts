import type { ToolChannelKind, ToolKind } from '@dsh-hub/shared'
import { rendezvousScore } from '../router.js'
import type { ToolCandidate } from './types.js'

/**
 * 搜索池候选排序（14 §2，**纯函数**）：渠道 priority 降序 → 同层按 weight + 会合哈希 →
 * 渠道内密钥也按会合哈希 → 熔断/冷却中的渠道沉底 → 展开成「渠道 × 密钥」序列。
 *
 * 复用 `relay/router.ts` 的会合哈希：同一用户稳定落到同一渠道/密钥，上游缓存与配额都更友好。
 */

export interface ToolRouterKey {
  keyId: number
  state: 'active' | 'disabled' | 'auto-disabled'
  cooldownUntil: string | null
}

export interface ToolRouterChannel {
  channelId: number
  channelName: string
  kind: ToolChannelKind
  priority: number
  weight: number
  channelEnabled: boolean
  channelCooldownUntil: string | null
  /** 这条渠道支持哪些工具 */
  tools: ToolKind[]
  keys: ToolRouterKey[]
}

export interface ToolRouterInput {
  tool: ToolKind
  /** 会合哈希键：`tools:<userId>`（同一用户稳定） */
  stickyKey: string
  channels: ToolRouterChannel[]
  now: string
  maxAttempts: number
}

export type ToolRouterOutcome = { kind: 'ok'; candidates: ToolCandidate[] } | { kind: 'no_available_channel' }

function isKeyUsable(key: ToolRouterKey, nowMs: number): boolean {
  if (key.state !== 'active') return false
  if (!key.cooldownUntil) return true
  const until = Date.parse(key.cooldownUntil)
  return !Number.isFinite(until) || until <= nowMs
}

function isCooling(channel: ToolRouterChannel, nowMs: number): boolean {
  if (!channel.channelCooldownUntil) return false
  const until = Date.parse(channel.channelCooldownUntil)
  return Number.isFinite(until) && until > nowMs
}

/** 排序候选；返回的数组已经是尝试顺序（已按 `maxAttempts` 截断） */
export function planToolCandidates(input: ToolRouterInput): ToolRouterOutcome {
  const nowMs = Date.parse(input.now)
  const supported = input.channels.filter(
    (channel) => channel.channelEnabled && channel.tools.includes(input.tool),
  )

  interface Prepared {
    channel: ToolRouterChannel
    keys: ToolRouterKey[]
    lastResort: boolean
    score: number
  }

  const prepared: Prepared[] = []
  for (const channel of supported) {
    const keys = channel.keys.filter((key) => isKeyUsable(key, nowMs))
    if (keys.length === 0) continue
    keys.sort(
      (a, b) =>
        rendezvousScore(input.stickyKey, `key:${String(b.keyId)}`, 1) -
        rendezvousScore(input.stickyKey, `key:${String(a.keyId)}`, 1),
    )
    const weight = Number.isFinite(channel.weight) && channel.weight > 0 ? channel.weight : 1
    prepared.push({
      channel,
      keys,
      lastResort: isCooling(channel, nowMs),
      score: rendezvousScore(input.stickyKey, channel.channelId, weight),
    })
  }
  if (prepared.length === 0) return { kind: 'no_available_channel' }

  prepared.sort((a, b) => b.channel.priority - a.channel.priority || b.score - a.score)
  const healthy = prepared.filter((item) => !item.lastResort)
  const lastResort = prepared.filter((item) => item.lastResort)

  const candidates: ToolCandidate[] = []
  const max = Math.max(1, Math.trunc(input.maxAttempts))
  for (const item of [...healthy, ...lastResort]) {
    for (const [index, key] of item.keys.entries()) {
      candidates.push({
        channelId: item.channel.channelId,
        channelName: item.channel.channelName,
        kind: item.channel.kind,
        keyId: key.keyId,
        keyIndex: index,
        lastResort: item.lastResort,
      })
      if (candidates.length >= max) return { kind: 'ok', candidates }
    }
  }
  return { kind: 'ok', candidates }
}
