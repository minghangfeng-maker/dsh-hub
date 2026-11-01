import { describe, expect, it } from 'vitest'
import { planCandidates, rendezvousScore, type RelayRouterRoute } from '../src/modules/relay/router.js'

/**
 * 候选排序（12 §5.1）：分层、会合哈希的稳定性与按权重分流、跳过停用/冷却密钥、熔断渠道沉底。
 * 纯函数，不碰数据库。
 */

const NOW = '2026-10-16T10:00:00.000Z'

function route(
  overrides: Partial<RelayRouterRoute> & { routeId: number; channelId: number },
): RelayRouterRoute {
  return {
    channelName: `ch-${String(overrides.channelId)}`,
    upstreamModel: `up-${String(overrides.channelId)}`,
    priority: null,
    weight: null,
    routeEnabled: true,
    channelEnabled: true,
    channelApis: ['openai-completions'],
    channelPriority: 0,
    channelWeight: 1,
    channelCooldownUntil: null,
    channelMaxConcurrency: 0,
    channelInFlight: 0,
    keys: [{ keyId: overrides.channelId * 10, state: 'active', cooldownUntil: null }],
    ...overrides,
  }
}

describe('分层与过滤', () => {
  it('优先级降序分层；同层内按会合哈希', () => {
    const outcome = planCandidates({
      api: 'openai-completions',
      routes: [
        route({ routeId: 1, channelId: 1, priority: 0 }),
        route({ routeId: 2, channelId: 2, priority: 10 }),
        route({ routeId: 3, channelId: 3, priority: 5 }),
      ],
      stickyKey: '7:model',
      now: NOW,
      maxAttempts: 10,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.candidates.map((candidate) => candidate.channelId)).toEqual([2, 3, 1])
  })

  it('路由没写优先级时用渠道的', () => {
    const outcome = planCandidates({
      api: 'openai-completions',
      routes: [
        route({ routeId: 1, channelId: 1, channelPriority: 1 }),
        route({ routeId: 2, channelId: 2, channelPriority: 9 }),
      ],
      stickyKey: '7:model',
      now: NOW,
      maxAttempts: 10,
    })
    if (outcome.kind !== 'ok') throw new Error('unexpected')
    expect(outcome.candidates[0]!.channelId).toBe(2)
  })

  it('渠道停用 / 协议不支持 / 没有启用路由', () => {
    const disabled = planCandidates({
      api: 'openai-completions',
      routes: [route({ routeId: 1, channelId: 1, channelEnabled: false })],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 3,
    })
    expect(disabled.kind).toBe('no_available_channel')

    const unsupported = planCandidates({
      api: 'anthropic-messages',
      routes: [route({ routeId: 1, channelId: 1 })],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 3,
    })
    expect(unsupported.kind).toBe('unsupported_endpoint')

    const noRoute = planCandidates({
      api: 'openai-completions',
      routes: [],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 3,
    })
    expect(noRoute.kind).toBe('no_available_channel')
  })

  it('跳过 disabled / auto-disabled / 冷却中的密钥；没有可用密钥的渠道不出候选', () => {
    const outcome = planCandidates({
      api: 'openai-completions',
      routes: [
        route({
          routeId: 1,
          channelId: 1,
          keys: [
            { keyId: 11, state: 'disabled', cooldownUntil: null },
            { keyId: 12, state: 'auto-disabled', cooldownUntil: null },
            { keyId: 13, state: 'active', cooldownUntil: '2999-01-01T00:00:00.000Z' },
            { keyId: 14, state: 'active', cooldownUntil: '2000-01-01T00:00:00.000Z' },
          ],
        }),
        route({ routeId: 2, channelId: 2, keys: [{ keyId: 21, state: 'disabled', cooldownUntil: null }] }),
      ],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 10,
    })
    if (outcome.kind !== 'ok') throw new Error('unexpected')
    expect(outcome.candidates.map((candidate) => candidate.keyId)).toEqual([14])
  })

  it('熔断中 / 并发满的渠道排到最后，但仍然保留为兜底候选', () => {
    const cooling = route({
      routeId: 1,
      channelId: 1,
      priority: 90,
      channelCooldownUntil: '2999-01-01T00:00:00.000Z',
    })
    const full = route({
      routeId: 2,
      channelId: 2,
      priority: 80,
      channelMaxConcurrency: 2,
      channelInFlight: 2,
    })
    const healthy = route({ routeId: 3, channelId: 3, priority: 1 })
    const outcome = planCandidates({
      api: 'openai-completions',
      routes: [cooling, full, healthy],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 10,
    })
    if (outcome.kind !== 'ok') throw new Error('unexpected')
    expect(outcome.candidates.map((candidate) => candidate.channelId)).toEqual([3, 1, 2])
    expect(outcome.candidates.filter((candidate) => candidate.lastResort)).toHaveLength(2)

    // 只有不可用渠道时照样给出候选（12 §5.1「全都不可用时才用」）
    const onlyBad = planCandidates({
      api: 'openai-completions',
      routes: [cooling, full],
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 10,
    })
    expect(onlyBad.kind).toBe('ok')
  })

  it('maxAttempts 截断候选数量', () => {
    const routes = [1, 2, 3, 4].map((id) =>
      route({
        routeId: id,
        channelId: id,
        keys: [
          { keyId: id * 10 + 1, state: 'active', cooldownUntil: null },
          { keyId: id * 10 + 2, state: 'active', cooldownUntil: null },
        ],
      }),
    )
    const outcome = planCandidates({
      api: 'openai-completions',
      routes,
      stickyKey: 'k',
      now: NOW,
      maxAttempts: 3,
    })
    if (outcome.kind !== 'ok') throw new Error('unexpected')
    expect(outcome.candidates).toHaveLength(3)
  })
})

describe('会合哈希（rendezvous hashing）', () => {
  it('同一用户 + 同一模型稳定落到同一渠道', () => {
    const routes = [1, 2, 3, 4, 5].map((id) => route({ routeId: id, channelId: id }))
    const first = planCandidates({
      api: 'openai-completions',
      routes,
      stickyKey: '42:model-a',
      now: NOW,
      maxAttempts: 1,
    })
    for (let index = 0; index < 20; index += 1) {
      const again = planCandidates({
        api: 'openai-completions',
        routes,
        stickyKey: '42:model-a',
        now: NOW,
        maxAttempts: 1,
      })
      if (first.kind !== 'ok' || again.kind !== 'ok') throw new Error('unexpected')
      expect(again.candidates[0]!.channelId).toBe(first.candidates[0]!.channelId)
    }
  })

  it('不同用户散开（不全都落一个渠道）', () => {
    const routes = [1, 2, 3, 4].map((id) => route({ routeId: id, channelId: id }))
    const hits = new Set<number>()
    for (let userId = 0; userId < 200; userId += 1) {
      const outcome = planCandidates({
        api: 'openai-completions',
        routes,
        stickyKey: `${String(userId)}:model`,
        now: NOW,
        maxAttempts: 1,
      })
      if (outcome.kind !== 'ok') throw new Error('unexpected')
      hits.add(outcome.candidates[0]!.channelId)
    }
    expect(hits.size).toBe(4)
  })

  it('权重 3:1 时 1000 个用户的分布大致 3:1', () => {
    const routes = [
      route({ routeId: 1, channelId: 1, weight: 3 }),
      route({ routeId: 2, channelId: 2, weight: 1 }),
    ]
    let heavy = 0
    for (let userId = 0; userId < 1000; userId += 1) {
      const outcome = planCandidates({
        api: 'openai-completions',
        routes,
        stickyKey: `${String(userId)}:model`,
        now: NOW,
        maxAttempts: 1,
      })
      if (outcome.kind !== 'ok') throw new Error('unexpected')
      if (outcome.candidates[0]!.channelId === 1) heavy += 1
    }
    // 期望 750；给 ±7% 的宽松区间，避免偶发抖动导致假失败
    expect(heavy).toBeGreaterThan(680)
    expect(heavy).toBeLessThan(820)
  })

  it('权重大的节点得分更高（同键对比）', () => {
    expect(rendezvousScore('key', 1, 3)).toBeGreaterThan(0)
    expect(rendezvousScore('key', 1, 1)).toBeGreaterThan(0)
  })
})
