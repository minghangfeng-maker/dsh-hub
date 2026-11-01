import type { TestClock } from '../src/lib/clock.js'
import { createTestClock } from '../src/lib/clock.js'
import { imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import type { InternalInstanceService } from '../src/modules/instances/service.js'
import type { ComputeService } from '../src/modules/compute/types.js'
import type { ComputeSettings } from '@dsh-hub/shared'
import type { RelayService } from '../src/modules/relay/types.js'
import { createTestApp, createUser, type TestApp, type TestUser } from './helpers.js'

const META = { ip: '127.0.0.1', userAgent: 'vitest' }
export const COMPUTE_IMAGE = imageForVersion(FALLBACK_DSH_VERSION)

export interface ComputeSetup {
  ctx: TestApp
  app: TestApp['app']
  user: TestUser
  driver: NonNullable<TestApp['driver']>
  instances: InternalInstanceService
  compute: ComputeService
  relay: RelayService
  clock: TestClock
}

export interface ComputeSetupOptions {
  start?: string
  user?: { role?: 'user' | 'admin'; status?: 'pending' | 'active' | 'disabled'; username?: string }
  /** 覆盖 compute 设置（默认 billingEnabled: true） */
  settings?: Partial<ComputeSettings>
  /** 直接给钱包加积分（走 grant 流水） */
  grantMicro?: number
  /** 是否 provision 实例（默认 true） */
  provision?: boolean
}

/** 算力租赁测试脚手架：临时目录 + FakeDriver + 可控时钟 + 打开计费 + 可选加积分 */
export async function setupCompute(opts: ComputeSetupOptions = {}): Promise<ComputeSetup> {
  const ctx = await createTestApp({
    clock: createTestClock(opts.start ?? '2026-10-18T01:00:00.000Z'),
    env: { HUB_RELAY_INTERNAL_PORT: '0' },
  })
  const driver = ctx.driver!
  driver.addImage(COMPUTE_IMAGE)
  const user = await createUser(ctx.app, {
    ...(opts.user?.role === undefined ? {} : { role: opts.user.role }),
    ...(opts.user?.status === undefined ? {} : { status: opts.user.status }),
    ...(opts.user?.username === undefined ? {} : { username: opts.user.username }),
  })
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  const compute = ctx.app.deps.services.compute
  const relay = ctx.app.deps.services.relay
  if (opts.provision !== false) await instances.provision(user.id)
  if (opts.settings !== undefined) {
    await compute.updateSettings({ billingEnabled: true, ...opts.settings }, 1, META)
  }
  if (opts.grantMicro !== undefined) {
    relay.adjustWallet(user.id, { amountMicro: opts.grantMicro, note: '测试加积分' }, 1, META)
  }
  return { ctx, app: ctx.app, user, driver, instances, compute, relay, clock: ctx.clock }
}

/** 直接取该用户的钱包行（测试断言用） */
export function walletOf(setup: ComputeSetup, userId = setup.user.id) {
  return setup.app.deps.db.get<{
    balance: number
    daily_bonus_left: number
    daily_bonus_day: string | null
    total_spent: number
  }>(
    'SELECT balance, daily_bonus_left, daily_bonus_day, total_spent FROM relay_wallets WHERE user_id = ?',
    userId,
  )
}

/** 该用户进行中的租约行 */
export function activeLeaseOf(setup: ComputeSetup, userId = setup.user.id) {
  return setup.app.deps.db.get<{
    id: number
    plan_id: string
    plan_name: string
    cpus: number
    memory_mb: number
    block_price: number
    billed: number
    paid_until: string | null
    grace_until: string | null
    ended_at: string | null
    end_reason: string | null
    blocks: number
    charged: number
  }>('SELECT * FROM compute_leases WHERE user_id = ? AND ended_at IS NULL', userId)
}

export function allLeases(setup: ComputeSetup, userId = setup.user.id) {
  return setup.app.deps.db.all<{
    id: number
    plan_id: string
    billed: number
    ended_at: string | null
    end_reason: string | null
    blocks: number
    charged: number
    paid_until: string | null
    grace_until: string | null
  }>('SELECT * FROM compute_leases WHERE user_id = ? ORDER BY id ASC', userId)
}
