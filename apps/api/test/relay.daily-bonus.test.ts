import { afterEach, describe, expect, it } from 'vitest'
import { createTestClock } from '../src/lib/clock.js'
import type { TestApp } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'

/**
 * 每日赠送（13 §2）：发放、同日只发一次、次日先作废再发、消费先用赠送、余额为负时的作废额、
 * 钱包 DTO 的 `dailyBonusLeftMicro`，以及流水类型/actor。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

async function setup(start = '2026-10-18T01:00:00.000Z'): Promise<TestApp> {
  ctx = await createTestApp({ clock: createTestClock(start), env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  return ctx
}

function ledger(app: TestApp, userId: number): { type: string; amount: number; actor: string | null }[] {
  return app.app.deps.services.relay
    .listLedger({ page: 1, pageSize: 100 }, { userId })
    .items.map((row) => ({ type: row.type, amount: row.amountMicro, actor: row.actor }))
}

function wallet(app: TestApp, userId: number) {
  return app.app.deps.db.get<{ balance: number; daily_bonus_left: number; daily_bonus_day: string | null }>(
    'SELECT balance, daily_bonus_left, daily_bonus_day FROM relay_wallets WHERE user_id = ?',
    userId,
  )
}

describe('每日赠送（13 §2）', () => {
  it('同日重复触发只发一次；当日消费先用赠送', async () => {
    const app = await setup()
    const user = await createUser(app.app)
    const relay = app.app.deps.services.relay
    relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)

    expect(relay.grantDailyBonus(user.id)).toBe(600_000)
    expect(relay.grantDailyBonus(user.id)).toBe(0)
    expect(wallet(app, user.id)).toMatchObject({ balance: 600_000, daily_bonus_left: 600_000 })

    // 算力扣块：先用赠送；total_spent 不动（它是 token 累计消耗口径）
    expect(relay.chargeCompute(user.id, 50_000, '2 核 4 GB 10 分钟')).toBe(550_000)
    expect(wallet(app, user.id)).toMatchObject({ balance: 550_000, daily_bonus_left: 550_000 })
    expect(
      app.app.deps.db.get<{ total_spent: number }>(
        'SELECT total_spent FROM relay_wallets WHERE user_id = ?',
        user.id,
      )?.total_spent,
    ).toBe(0)
    // 管理员扣积分同样先用赠送
    relay.adjustWallet(user.id, { amountMicro: -100_000, note: '扣' }, 1, META)
    expect(wallet(app, user.id)).toMatchObject({ balance: 450_000, daily_bonus_left: 450_000 })

    const rows = ledger(app, user.id)
    expect(rows.map((row) => row.type)).toEqual(['deduct', 'compute', 'daily'])
    expect(rows[0]?.actor).toBe(user.username)
    expect(
      rows.filter((row) => row.type === 'daily' || row.type === 'compute').every((row) => row.actor === null),
    ).toBe(true)
  })

  it('次日先作废昨天的未用部分、再发今天的一份；余额为负时作废额为 0 但 left 清零', async () => {
    const app = await setup()
    const user = await createUser(app.app)
    const relay = app.app.deps.services.relay
    relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    relay.grantDailyBonus(user.id)
    relay.chargeCompute(user.id, 50_000, '2 核 4 GB 10 分钟')

    app.clock.set('2026-10-19T01:00:00.000Z')
    expect(relay.grantDailyBonus(user.id)).toBe(600_000)
    expect(wallet(app, user.id)).toMatchObject({
      balance: 600_000,
      daily_bonus_left: 600_000,
      daily_bonus_day: '2026-10-19',
    })
    expect(ledger(app, user.id).map((row) => [row.type, row.amount])).toEqual([
      ['daily', 600_000],
      ['expire', -550_000],
      ['compute', -50_000],
      ['daily', 600_000],
    ])

    // 余额为负：作废额 = min(left, max(balance, 0)) = 0，但 left 必须清零（不能留到明天）
    app.app.deps.db.run(
      'UPDATE relay_wallets SET balance = -200_000, daily_bonus_left = 300_000, daily_bonus_day = ? WHERE user_id = ?',
      '2026-10-18',
      user.id,
    )
    app.clock.set('2026-10-20T01:00:00.000Z')
    relay.grantDailyBonus(user.id)
    expect(wallet(app, user.id)).toMatchObject({
      balance: 400_000,
      daily_bonus_left: 600_000,
    })
    expect(ledger(app, user.id).filter((row) => row.type === 'expire')).toHaveLength(1)
  })

  it('dailyBonusMicro=0：不发也不写流水；待审批账号不发', async () => {
    const app = await setup()
    const user = await createUser(app.app)
    const pending = await createUser(app.app, { status: 'pending' })
    const relay = app.app.deps.services.relay
    expect(relay.grantDailyBonus(user.id)).toBe(0)
    expect(ledger(app, user.id)).toEqual([])
    expect(wallet(app, user.id)).toBeUndefined()

    relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    expect(relay.grantDailyBonus(pending.id)).toBe(0)
    expect(ledger(app, pending.id)).toEqual([])
  })

  it('钱包 DTO：dailyBonusLeftMicro = min(left, max(balance, 0))；赠送扣到 0 后不再为负', async () => {
    const app = await setup()
    const user = await createUser(app.app)
    const relay = app.app.deps.services.relay
    relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    relay.grantDailyBonus(user.id)
    // 透支：余额可以小幅为负，赠送剩余不能为负
    relay.chargeCompute(user.id, 700_000, '扣到负数')
    expect(wallet(app, user.id)).toMatchObject({ balance: -100_000, daily_bonus_left: 0 })
    expect(relay.getWalletRow(user.id).dailyBonusLeftMicro).toBe(0)

    app.app.deps.db.run(
      'UPDATE relay_wallets SET balance = 100, daily_bonus_left = 500 WHERE user_id = ?',
      user.id,
    )
    expect(relay.getWalletRow(user.id).dailyBonusLeftMicro).toBe(100)
  })
})

describe('每日赠送的触发点（13 §2.3）', () => {
  it('POST /api/auth/login 成功时发放（同一天再登录不重复）', async () => {
    const app = await setup()
    const user = await createUser(app.app, { username: 'login-bonus' })
    app.app.deps.services.relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)

    const first = await app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: user.username, password: user.password },
    })
    expect(first.statusCode).toBe(200)
    expect(wallet(app, user.id)).toMatchObject({ balance: 600_000, daily_bonus_left: 600_000 })

    const second = await app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: user.username, password: user.password },
    })
    expect(second.statusCode).toBe(200)
    expect(wallet(app, user.id)?.balance).toBe(600_000)
    expect(ledger(app, user.id).filter((row) => row.type === 'daily')).toHaveLength(1)
  })
})

describe('中转站设置', () => {
  it('PATCH /api/admin/relay/settings 能改 dailyBonusMicro', async () => {
    const app = await setup()
    const admin = await createUser(app.app, { username: 'settings-admin', role: 'admin' })
    const session = loginAs(app.app, admin)
    const patched = await app.app.inject({
      method: 'PATCH',
      url: '/api/admin/relay/settings',
      headers: session.headers,
      payload: { dailyBonusMicro: 600_000 },
    })
    expect(patched.statusCode).toBe(200)
    expect(json<{ settings: { dailyBonusMicro: number } }>(patched).settings.dailyBonusMicro).toBe(600_000)
    expect(app.app.deps.services.relay.getSettings().dailyBonusMicro).toBe(600_000)
  })
})
