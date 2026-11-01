import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAY_SETTINGS, RelaySettingsSchema } from '@dsh-hub/shared'
import { createRelaySettingsStore } from '../src/modules/relay/settings-store.js'
import {
  addRelayDays,
  isRelayDay,
  relayDayRange,
  relayDaySpan,
  shanghaiDay,
  shanghaiDayStartIso,
  shanghaiMonthStart,
} from '../src/modules/relay/time.js'
import { closeProxyAgents } from '../src/modules/relay/proxy.js'
import { sanitizeUpstreamError, upstreamPathFor } from '../src/modules/relay/proxy.js'
import { computeCostMicro } from '../src/modules/relay/billing.js'
import { createTestApp } from './helpers.js'
import type { TestApp } from './helpers.js'

/** 日期分桶（12 §6.5）、转运站设置（12 §8）、错误脱敏与上游路径（12 §5.3）的纯函数单测。 */

describe('Asia/Shanghai 日期分桶（12 §6.5）', () => {
  it('UTC 16:00 之后算第二天', () => {
    expect(shanghaiDay('2026-10-15T15:59:59.000Z')).toBe('2026-10-15')
    expect(shanghaiDay('2026-10-15T16:00:00.000Z')).toBe('2026-10-16')
    expect(shanghaiDay('2026-10-16T10:00:00.000Z')).toBe('2026-10-16')
  })

  it('某天起点换算回 UTC（左闭右开区间用）', () => {
    expect(shanghaiDayStartIso('2026-10-16')).toBe('2026-10-15T16:00:00.000Z')
  })

  it('加减天数、跨度、月份起点与区间序列', () => {
    expect(addRelayDays('2026-10-16', 1)).toBe('2026-10-17')
    expect(addRelayDays('2026-11-01', -1)).toBe('2026-10-31')
    expect(relayDaySpan('2026-10-01', '2026-10-07')).toBe(7)
    expect(relayDaySpan('2026-10-07', '2026-10-01')).toBeLessThanOrEqual(0)
    expect(shanghaiMonthStart('2026-10-16')).toBe('2026-10-01')
    expect(relayDayRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
  })

  it('合法性校验', () => {
    expect(isRelayDay('2026-10-16')).toBe(true)
    expect(isRelayDay('2026-2-3')).toBe(false)
    expect(isRelayDay('2026-02-30')).toBe(false)
    expect(isRelayDay('')).toBe(false)
  })
})

describe('中转站设置（12 §8）', () => {
  let ctx: TestApp | undefined
  const setup = async (): Promise<TestApp> => {
    ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
    return ctx
  }

  it('缺省用 DEFAULT_RELAY_SETTINGS；部分字段合并；非法值拒绝', async () => {
    const app = await setup()
    const store = createRelaySettingsStore(app.app.deps.db)
    expect(store.get()).toEqual(DEFAULT_RELAY_SETTINGS)

    // 手改库：只写了一个字段 → 其余用默认值补齐（前向兼容）
    app.app.deps.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('relay', ?, ?)`,
      JSON.stringify({ maxAttempts: 5 }),
      app.clock.nowIso(),
    )
    expect(store.get()).toMatchObject({ maxAttempts: 5, defaultMaxConcurrency: 4 })

    // 坏 JSON → 回退默认值，不抛错
    app.app.deps.db.run(`UPDATE settings SET value_json = 'not json' WHERE key = 'relay'`)
    expect(store.get()).toEqual(DEFAULT_RELAY_SETTINGS)

    const updated = store.update({ keyCooldownSeconds: 30, enabled: false }, app.clock.nowIso())
    expect(updated).toMatchObject({ keyCooldownSeconds: 30, enabled: false })
    expect(RelaySettingsSchema.safeParse({ ...updated, maxAttempts: 99 }).success).toBe(false)

    store.reset()
    expect(store.get()).toEqual(DEFAULT_RELAY_SETTINGS)
    await app.close()
    ctx = undefined
  })
})

describe('上游路径与错误脱敏（12 §5.3 §5.2）', () => {
  it('三协议与 count_tokens 的路径', () => {
    expect(upstreamPathFor('openai-completions')).toBe('/chat/completions')
    expect(upstreamPathFor('openai-responses')).toBe('/responses')
    expect(upstreamPathFor('anthropic-messages')).toBe('/messages')
    expect(upstreamPathFor('anthropic-messages', '/v1/messages/count_tokens')).toBe('/messages/count_tokens')
    expect(upstreamPathFor('anthropic-messages', '/v1/messages?beta=1')).toBe('/messages')
  })

  it('脱敏去掉密钥片段并截断', () => {
    expect(sanitizeUpstreamError('bad key sk-live-abcdefghijklmnop')).not.toContain(
      'sk-live-abcdefghijklmnop',
    )
    expect(sanitizeUpstreamError('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    expect(sanitizeUpstreamError('x-api-key=abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
    const long = sanitizeUpstreamError('x'.repeat(500))
    expect(long.length).toBeLessThanOrEqual(301)
  })
})

describe('计费（12 §6.2）与代理连接池', () => {
  it('缓存价缺省、倍率与 perRequest', () => {
    const price = {
      inputMicro: 1_000_000,
      outputMicro: 2_000_000,
      cacheReadMicro: null,
      cacheWriteMicro: 500_000,
      perRequestMicro: 10,
    }
    // 渠道倍率默认 1000‰ = ×1.0
    const rates = (walletRatePercent: number) => ({ walletRatePercent, channelRatePermille: 1000 })
    expect(computeCostMicro(price, { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 }, rates(100))).toBe(
      110,
    )
    expect(computeCostMicro(price, { input: 0, cacheRead: 100, cacheWrite: 0, output: 0 }, rates(100))).toBe(
      110,
    )
    expect(computeCostMicro(price, { input: 0, cacheRead: 0, cacheWrite: 100, output: 0 }, rates(100))).toBe(
      60,
    )
    expect(computeCostMicro(price, { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 }, rates(0))).toBe(0)
    expect(computeCostMicro(price, { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 }, rates(50))).toBe(
      55,
    )
  })

  it('closeProxyAgents 可重复调用（进程退出/测试清理用）', () => {
    expect(() => closeProxyAgents()).not.toThrow()
    expect(() => closeProxyAgents()).not.toThrow()
  })
})
