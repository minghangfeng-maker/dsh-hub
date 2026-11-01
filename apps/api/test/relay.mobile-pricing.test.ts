import { afterEach, describe, expect, it } from 'vitest'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'

/**
 * 手机通道的计费钩子（0.2.9）：
 * modelMultiplier / quoteCostMicro 必须和 Hub 自己的计费口径一致，
 * 否则手机上的「X倍率 / 积分消耗」会和账单对不上。
 */
let ctx: TestApp | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

describe('手机端计费钩子（modelMultiplier / quoteCostMicro）', () => {
  it('按 `模型@渠道标识` 取倍率；积分消耗与计费公式一致', async () => {
    ctx = await createTestApp()
    const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
    const user = await createUser(ctx.app, { username: 'alice' })
    const admin: TestSession = loginAs(ctx.app, adminUser)

    const channel = json<{ channel: { id: number } }>(
      await ctx.app.inject({
        method: 'POST',
        url: '/api/admin/relay/channels',
        headers: admin.headers,
        payload: {
          name: 'upstream-b',
          slug: 'upstream-b',
          baseUrl: 'https://relay.invalid/v1',
          apis: ['openai-completions'],
          ratePermille: 100,
          keys: ['sk-test-upstream-b-0001'],
        },
      }),
    ).channel

    json(
      await ctx.app.inject({
        method: 'POST',
        url: '/api/admin/relay/models',
        headers: admin.headers,
        payload: {
          name: 'deepseek-v4.1-flash',
          price: {
            inputMicro: 1_000_000,
            outputMicro: 4_000_000,
            cacheReadMicro: 20_000,
            cacheWriteMicro: null,
            perRequestMicro: 0,
          },
          routes: [{ channelId: channel.id, upstreamModel: 'deepseek-v4.1-flash', enabled: true }],
        },
      }),
    )

    const relay = ctx.app.deps.services.relay
    expect(relay.modelMultiplier('deepseek-v4.1-flash@upstream-b')).toBe(0.1)
    expect(relay.modelMultiplier('deepseek-v4.1-flash@unknown')).toBeNull()
    expect(relay.modelMultiplier('nope')).toBeNull()

    // 与 relay_usage 的计费同公式：input 1112 + output 111*4 + cacheRead 93696*0.02 = 3430 微积分
    // 再 × 渠道 0.1 × 钱包 100% = 343
    expect(
      relay.quoteCostMicro({
        userId: user.id,
        model: 'deepseek-v4.1-flash@upstream-b',
        tokens: { inputTokens: 1112, outputTokens: 111, cacheReadTokens: 93696, cacheWriteTokens: 0 },
      }),
    ).toBe(343)
    expect(
      relay.quoteCostMicro({
        userId: user.id,
        model: 'cli-default',
        tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ).toBeNull()
  })
})
