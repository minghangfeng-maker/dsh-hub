import { afterEach, describe, expect, it } from 'vitest'
import type { TestApp } from './helpers.js'
import { createTestApp, createUser } from './helpers.js'
import {
  OPENAI_NON_STREAM_BODY,
  createChannel,
  createRelayModel,
  grantMicro,
  issueKey,
  jsonResponse,
  setupChannelAndModel,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * 对账不变量（12 §6.4）：`balance = Σ ledger.amount − Σ usage.cost`。
 * 注册赠送（含待审批）也要落在同一条公式里；管理员 CLI 建的账号不送（不走 auth.register）。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  for (const upstream of upstreams.splice(0)) await upstream.close()
})

function invariant(app: TestApp, userId: number): { balance: number; ledger: number; usage: number } {
  const balance = Number(
    app.app.deps.db.get<{ balance: number }>('SELECT balance FROM relay_wallets WHERE user_id = ?', userId)
      ?.balance ?? 0,
  )
  const ledger = Number(
    app.app.deps.db.get<{ total: number | null }>(
      'SELECT SUM(amount) AS total FROM relay_ledger WHERE user_id = ?',
      userId,
    )?.total ?? 0,
  )
  const usage = Number(
    app.app.deps.db.get<{ total: number | null }>(
      'SELECT SUM(cost) AS total FROM relay_usage WHERE user_id = ?',
      userId,
    )?.total ?? 0,
  )
  expect(balance).toBe(ledger - usage)
  return { balance, ledger, usage }
}

describe('对账不变量（12 §6.4）', () => {
  it('一串加积分/请求/扣积分之后 balance = Σledger − Σusage.cost', async () => {
    ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
    const app = ctx
    const user = await createUser(app.app, { username: 'recon' })
    const key = issueKey(app.app, user.id)

    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    const bad = await startFakeUpstream((_req, res) => jsonResponse(res, 400, { error: 'client error' }))
    upstreams.push(good, bad)
    await setupChannelAndModel(app.app, { upstreamUrl: good.url })

    // 初始没有钱包行
    invariant(app, user.id)

    grantMicro(app.app, user.id, 30_000_000)
    invariant(app, user.id)

    const call = (url = '/v1/chat/completions', model = 'test-model') =>
      app.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${key}` },
        payload: { model, messages: [{ role: 'user', content: '你好' }] },
      })

    // 3 次成功（每次 180 微积分）
    for (let index = 0; index < 3; index += 1) {
      expect((await call()).statusCode).toBe(200)
      invariant(app, user.id)
    }

    // 客户端参数错（上游 400）→ 不计费，但仍记一条用量
    const badChannel = createChannel(app.app, {
      name: 'bad-400',
      baseUrl: bad.url,
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    await createRelayModel(app.app, {
      name: 'client-error-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: badChannel.id, upstreamModel: 'up', enabled: true }],
    })
    const clientError = await call('/v1/chat/completions', 'client-error-model')
    expect(clientError.statusCode).toBe(400)
    invariant(app, user.id)

    // 未知模型 → 404，不写用量
    const notFound = await call('/v1/chat/completions', 'nope')
    expect(notFound.statusCode).toBe(404)

    // 扣积分
    app.app.deps.services.relay.adjustWallet(user.id, { amountMicro: -1_000_000, note: '扣' }, 1, META)
    const final = invariant(app, user.id)
    expect(final.usage).toBe(180 * 3)
    expect(final.balance).toBe(30_000_000 - 1_000_000 - 180 * 3)
    // 日汇总的 cost 与逐条一致
    const daily = Number(
      app.app.deps.db.get<{ total: number | null }>(
        'SELECT SUM(cost) AS total FROM relay_usage_daily WHERE user_id = ?',
        user.id,
      )?.total ?? 0,
    )
    expect(daily).toBe(final.usage)
  })

  it('注册赠送：signupBonusMicro > 0 时建钱包 + 一条 signup 流水；为 0 时只有钱包行', async () => {
    ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
    const app = ctx
    app.app.deps.settings.set('registration', { mode: 'open', requireApproval: false, maxUsers: 50 })
    app.app.deps.services.relay.updateSettings({ signupBonusMicro: 5_000_000 }, 1, META)

    const first = await app.app.deps.services.auth.register(
      { username: 'bonus-user', password: 'test-password-1' },
      META,
    )
    const ledger = app.app.deps.db.all<{ type: string; amount: number; note: string }>(
      'SELECT type, amount, note FROM relay_ledger WHERE user_id = ?',
      first.response.user.id,
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ type: 'signup', amount: 5_000_000 })
    invariant(app, first.response.user.id)

    // 待审批用户也建钱包（12 §6.4）
    app.app.deps.settings.set('registration', { mode: 'open', requireApproval: true, maxUsers: 50 })
    const pending = await app.app.deps.services.auth.register(
      { username: 'pending-user', password: 'test-password-1' },
      META,
    )
    const pendingWallet = app.app.deps.db.get<{ balance: number }>(
      'SELECT balance FROM relay_wallets WHERE user_id = ?',
      pending.response.user.id,
    )
    expect(pendingWallet?.balance).toBe(5_000_000)

    // 管理员 CLI 建的账号不送（不走 auth.register）
    const created = await createUser(app.app, { username: 'from-cli' })
    expect(
      app.app.deps.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM relay_wallets WHERE user_id = ?',
        created.id,
      )?.n,
    ).toBe(0)
    invariant(app, created.id)
  })
})

describe('对账不变量扩展：每日赠送 + 算力（13 §2.4）', () => {
  it('赠送/token/算力扣块/管理员加扣/跨日作废之后 balance = Σledger − Σusage.cost，daily_bonus_left ≥ 0', async () => {
    ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
    const app = ctx
    const user = await createUser(app.app, { username: 'recon-compute' })
    const key = issueKey(app.app, user.id)
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(good)
    await setupChannelAndModel(app.app, { upstreamUrl: good.url })

    // 打开每日赠送并发放；再管理员加积分
    app.app.deps.services.relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    expect(app.app.deps.services.relay.grantDailyBonus(user.id)).toBe(600_000)
    grantMicro(app.app, user.id, 10_000_000)
    invariant(app, user.id)

    // token 用量：180 微积分（先用赠送）
    const call = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'test-model', messages: [{ role: 'user', content: '你好' }] },
    })
    expect(call.statusCode).toBe(200)
    invariant(app, user.id)

    // 算力扣块
    app.app.deps.services.relay.chargeCompute(user.id, 50_000, '2 核 4 GB 10 分钟')
    invariant(app, user.id)

    // 管理员加扣（负数扣积分也先用赠送）
    app.app.deps.services.relay.adjustWallet(user.id, { amountMicro: 500_000, note: '加' }, 1, META)
    app.app.deps.services.relay.adjustWallet(user.id, { amountMicro: -100_000, note: '扣' }, 1, META)
    invariant(app, user.id)
    const leftBefore = Number(
      app.app.deps.db.get<{ left: number }>(
        'SELECT daily_bonus_left AS left FROM relay_wallets WHERE user_id = ?',
        user.id,
      )?.left ?? 0,
    )
    expect(leftBefore).toBeGreaterThan(0)

    // 跨日：先作废剩余赠送，再发今天的一份；不变量仍然成立
    app.clock.advance(24 * 60 * 60 * 1000)
    expect(app.app.deps.services.relay.grantDailyBonus(user.id)).toBe(600_000)
    const final = invariant(app, user.id)
    const leftAfter = Number(
      app.app.deps.db.get<{ left: number }>(
        'SELECT daily_bonus_left AS left FROM relay_wallets WHERE user_id = ?',
        user.id,
      )?.left ?? 0,
    )
    expect(leftAfter).toBe(600_000)
    expect(final.usage).toBe(180)
    const types = app.app.deps.db
      .all<{ type: string }>('SELECT type FROM relay_ledger WHERE user_id = ? ORDER BY id', user.id)
      .map((row) => row.type)
    expect(types).toContain('daily')
    expect(types).toContain('expire')
    expect(types).toContain('compute')
    // 赠送剩余不能超过余额（余额为负时为 0）
    expect(leftAfter).toBeGreaterThanOrEqual(0)
    expect(leftAfter).toBeLessThanOrEqual(Math.max(final.balance, 0))
  })
})
