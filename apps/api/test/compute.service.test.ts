import { afterEach, describe, expect, it } from 'vitest'
import { computeBlockPriceMicro, type ComputePlan } from '@dsh-hub/shared'
import { containerNameFor } from '../src/modules/instances/spec.js'
import type { ComputeSetup } from './helpers-compute.js'
import { activeLeaseOf, allLeases, setupCompute, walletOf, COMPUTE_IMAGE } from './helpers-compute.js'
import { createUser } from './helpers.js'

/** 算力租赁核心逻辑（13 §3 §4 §8）：启动准入、开租、续接、tick 状态机、宽限、计费开关、免费租约。 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }
const setups: ComputeSetup[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) await setup.ctx.close()
})

async function setup(opts: Parameters<typeof setupCompute>[0] = {}): Promise<ComputeSetup> {
  const result = await setupCompute(opts)
  setups.push(result)
  return result
}

function containerSpec(setup: ComputeSetup): { cpus: number; memoryMb: number } | undefined {
  return setup.driver.getContainer(containerNameFor(setup.user.slug))?.spec
}

describe('启动准入与开租（13 §3 §4）', () => {
  it('默认规格启动：扣第一块、租约快照规格、容器 NanoCpus/Memory = 规格', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const summary = await s.instances.ensureRunning(s.user.id)
    expect(summary.status).toBe('running')

    const lease = activeLeaseOf(s)
    expect(lease).toMatchObject({
      plan_id: 'c2m4',
      plan_name: '2 核 4 GB',
      cpus: 2,
      memory_mb: 4096,
      block_price: computeBlockPriceMicro(300_000),
      billed: 1,
      blocks: 1,
      charged: computeBlockPriceMicro(300_000),
    })
    expect(Date.parse(lease!.paid_until!)).toBe(s.clock.now().getTime() + 10 * 60_000)
    expect(containerSpec(s)).toMatchObject({ cpus: 2, memoryMb: 4096 })
    expect(walletOf(s)).toMatchObject({ balance: 950_000, total_spent: 0 })
    // 流水是 compute（负数），actor 为 null
    const ledger = s.relay.listLedger({ page: 1, pageSize: 10 }, { userId: s.user.id })
    expect(ledger.items[0]).toMatchObject({
      type: 'compute',
      amountMicro: -50_000,
      actor: null,
      note: '2 核 4 GB 10 分钟',
    })
    expect(s.app.deps.audit.recent(10).some((item) => item.action === 'compute.lease.start')).toBe(true)
  })

  it('带 planId 启动：用该规格并记住；不可选 planId → 400 VALIDATION_FAILED', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id, { planId: 'c4m8' })
    expect(containerSpec(s)).toMatchObject({ cpus: 4, memoryMb: 8192 })
    expect(activeLeaseOf(s)?.plan_id).toBe('c4m8')
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')

    await s.instances.stop(s.user.id)
    await expect(s.instances.ensureRunning(s.user.id, { planId: 'nope' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { planId: '该规格不可选' } },
    })
    // 没有建/改容器
    expect(s.instances.currentStatus(s.user.id)).toBe('stopped')
  })

  it('余额不足 1 块 → 402 INSUFFICIENT_POINTS（details 带余额与块价），不建容器', async () => {
    const s = await setup({ settings: {}, grantMicro: 49_999 })
    await expect(s.instances.ensureRunning(s.user.id)).rejects.toMatchObject({
      code: 'INSUFFICIENT_POINTS',
      status: 402,
      details: { balanceMicro: 49_999, blockPriceMicro: 50_000 },
    })
    expect(s.driver.getContainerNames()).toHaveLength(0)
    expect(allLeases(s)).toEqual([])
  })

  it('规格可见性：定制规格只有 userIds 里的用户可选；按 sort 升序；选中不可见 → 400', async () => {
    const s = await setup({
      settings: {
        plans: [
          {
            id: 'late',
            name: '后排',
            cpus: 2,
            memoryMb: 2048,
            pricePerHourMicro: 100_000,
            enabled: true,
            userIds: null,
            sort: 20,
          },
          {
            id: 'early',
            name: '前排',
            cpus: 2,
            memoryMb: 4096,
            pricePerHourMicro: 200_000,
            enabled: true,
            userIds: null,
            sort: 10,
          },
          {
            id: 'vip',
            name: '定制',
            cpus: 8,
            memoryMb: 16_384,
            pricePerHourMicro: 1_000_000,
            enabled: true,
            userIds: [999_999],
            sort: 1,
          },
        ],
      },
      grantMicro: 1_000_000,
    })
    const mine = s.compute.myCompute(s.user.id)
    expect(mine.plans.map((plan) => plan.id)).toEqual(['early', 'late'])
    expect(mine.selectedPlanId).toBe('early')
    await expect(s.compute.selectPlan(s.user.id, 'vip')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { planId: '该规格不可选' } },
    })
  })

  it('计费开启且没有任何可选规格 → 409 CONFLICT', async () => {
    const s = await setup({ settings: { plans: [] }, grantMicro: 1_000_000 })
    await expect(s.instances.ensureRunning(s.user.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '暂无可用规格，请联系管理员',
    })
    expect(s.driver.getContainerNames()).toHaveLength(0)
  })

  it('定制规格 8 核 16 GB 能起（不被 QuotaSchema 的 8 核 / 8 GB 上限拦）', async () => {
    const s = await setup({
      settings: {
        plans: [
          {
            id: 'c8m16',
            name: '8 核 16 GB',
            cpus: 8,
            memoryMb: 16_384,
            pricePerHourMicro: 1_000_000,
            enabled: true,
            userIds: [1],
            sort: 10,
          },
        ],
      },
      grantMicro: 2_000_000,
    })
    await s.instances.ensureRunning(s.user.id)
    expect(containerSpec(s)).toMatchObject({ cpus: 8, memoryMb: 16_384 })
    expect(activeLeaseOf(s)).toMatchObject({ cpus: 8, memory_mb: 16_384, block_price: 166_667 })
  })

  it('内存准入：别人的运行中内存 + 本次规格 > capacityMemoryMb → 503 CAPACITY_FULL', async () => {
    const s = await setup({
      settings: { capacityMemoryMb: 10_000 },
      grantMicro: 1_000_000,
    })
    await s.instances.ensureRunning(s.user.id)
    expect(activeLeaseOf(s)?.memory_mb).toBe(4096)

    const other = await createUser(s.app, { username: 'other' })
    s.driver.addImage(COMPUTE_IMAGE)
    await s.instances.provision(other.id)
    s.relay.adjustWallet(other.id, { amountMicro: 1_000_000, note: '测试' }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    await expect(s.instances.ensureRunning(other.id, { planId: 'c4m8' })).rejects.toMatchObject({
      code: 'CAPACITY_FULL',
      status: 503,
      details: { committedMb: 4096, requestMb: 8192, capacityMb: 10_000 },
    })
  })

  it('beforeStart 先发每日赠送：无余额也能启动，流水 daily + compute', async () => {
    const s = await setup({ settings: {} })
    s.relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, { ip: '127.0.0.1', userAgent: 'vitest' })
    await s.instances.ensureRunning(s.user.id)
    expect(walletOf(s)).toMatchObject({ balance: 550_000, daily_bonus_left: 550_000 })
    const types = s.relay
      .listLedger({ page: 1, pageSize: 10 }, { userId: s.user.id })
      .items.map((item) => item.type)
    expect(types).toContain('daily')
    expect(types).toContain('compute')
  })
})

describe('续接与换规格（13 §3 §4）', () => {
  it('停止后 10 分钟内同规格再开：继承 paid_until、不重复扣钱', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    const first = activeLeaseOf(s)!
    await s.instances.stop(s.user.id)
    expect(activeLeaseOf(s)).toBeUndefined()

    s.clock.advance(5 * 60_000)
    await s.instances.ensureRunning(s.user.id)
    const second = activeLeaseOf(s)!
    expect(second.paid_until).toBe(first.paid_until)
    expect(second.blocks).toBe(0)
    expect(second.charged).toBe(0)
    expect(walletOf(s)?.balance).toBe(950_000)
    expect(allLeases(s)).toHaveLength(2)
    expect(allLeases(s)[0]).toMatchObject({ ended_at: expect.any(String), end_reason: 'user' })
  })

  it('超过 paid_until 再开 / 换规格再开：不续接，重新扣一块', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    await s.instances.stop(s.user.id)
    s.clock.advance(11 * 60_000)
    await s.instances.ensureRunning(s.user.id)
    expect(activeLeaseOf(s)?.blocks).toBe(1)
    expect(walletOf(s)?.balance).toBe(900_000)

    await s.instances.stop(s.user.id)
    s.clock.advance(60_000)
    await s.instances.ensureRunning(s.user.id, { planId: 'c4m8' })
    expect(activeLeaseOf(s)).toMatchObject({ plan_id: 'c4m8', blocks: 1 })
    expect(walletOf(s)?.balance).toBe(900_000 - computeBlockPriceMicro(500_000))
  })

  it('运行中换规格：旧租约 plan-change、重建容器、新租约扣一块', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    const before = s.driver.getContainer(containerNameFor(s.user.slug))!.spec
    expect(before).toMatchObject({ cpus: 2, memoryMb: 4096 })

    const result = await s.compute.selectPlan(s.user.id, 'c4m8')
    expect(result.restarted).toBe(true)
    expect(result.compute.lease).toMatchObject({ planId: 'c4m8', blocks: 1 })
    expect(containerSpec(s)).toMatchObject({ cpus: 4, memoryMb: 8192 })
    expect(allLeases(s)[0]).toMatchObject({ plan_id: 'c2m4', end_reason: 'plan-change' })
    expect(walletOf(s)?.balance).toBe(1_000_000 - 50_000 - 83_334)
    expect(
      s.app.deps.audit.recent(20).filter((item) => item.action === 'compute.lease.end')[0]?.detail,
    ).toMatchObject({ reason: 'plan-change' })
  })

  it('规格相同只记住（restarted:false，不扣钱）；停止中只记住；计费关闭只记住', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    const same = await s.compute.selectPlan(s.user.id, 'c2m4')
    expect(same.restarted).toBe(false)
    expect(walletOf(s)?.balance).toBe(950_000)

    await s.instances.stop(s.user.id)
    const stopped = await s.compute.selectPlan(s.user.id, 'c4m8')
    expect(stopped.restarted).toBe(false)
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
    expect(s.driver.getContainer(containerNameFor(s.user.slug))?.state).toBe('exited')

    await s.compute.updateSettings({ billingEnabled: false }, 1, { ip: '127.0.0.1', userAgent: 'vitest' })
    const off = await s.compute.selectPlan(s.user.id, 'c2m4')
    expect(off.restarted).toBe(false)
    expect(off.compute.billingEnabled).toBe(false)
  })

  it('运行中换规格余额不足 → 402 且不动旧租约/容器', async () => {
    const s = await setup({ settings: {}, grantMicro: 100_000 })
    await s.instances.ensureRunning(s.user.id)
    expect(walletOf(s)?.balance).toBe(50_000)
    await expect(s.compute.selectPlan(s.user.id, 'c4m8')).rejects.toMatchObject({
      code: 'INSUFFICIENT_POINTS',
      details: { balanceMicro: 50_000, blockPriceMicro: 83_334 },
    })
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')
    expect(containerSpec(s)).toMatchObject({ cpus: 2, memoryMb: 4096 })
  })

  it('运行中换规格内存不足 → 503 且不动旧租约/容器', async () => {
    const s = await setup({ settings: { capacityMemoryMb: 8_000 }, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    await expect(s.compute.selectPlan(s.user.id, 'c4m8')).rejects.toMatchObject({
      code: 'CAPACITY_FULL',
      details: { committedMb: 0, requestMb: 8192, capacityMb: 8_000 },
    })
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')
    expect(containerSpec(s)).toMatchObject({ cpus: 2, memoryMb: 4096 })
  })
})

describe('tick 状态机（13 §3 §8）', () => {
  it('余额 0.06、块价 0.05：扣一块 → 0.01；下一块扣成 −0.04；再下一块进入宽限；宽限到期停机', async () => {
    const s = await setup({ settings: { graceMinutes: 10 }, grantMicro: 60_000 })
    await s.instances.ensureRunning(s.user.id)
    expect(walletOf(s)?.balance).toBe(10_000)

    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    expect(walletOf(s)?.balance).toBe(-40_000)
    expect(activeLeaseOf(s)).toMatchObject({ blocks: 2, grace_until: null })

    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    expect(walletOf(s)?.balance).toBe(-40_000)
    expect(activeLeaseOf(s)?.grace_until).toBe(new Date(s.clock.now().getTime() + 10 * 60_000).toISOString())
    expect(activeLeaseOf(s)?.blocks).toBe(2)

    // 宽限中：计时不扣费
    s.clock.advance(9 * 60_000)
    await s.compute.tick()
    expect(s.instances.currentStatus(s.user.id)).toBe('running')

    s.clock.advance(60_000)
    await s.compute.tick()
    await s.compute.tick() // 串行/幂等：第二次不应重复停机或报错
    expect(s.instances.currentStatus(s.user.id)).toBe('stopped')
    expect(activeLeaseOf(s)).toBeUndefined()
    expect(allLeases(s)[0]).toMatchObject({ end_reason: 'insufficient' })
    expect(s.app.deps.audit.recent(20).find((item) => item.action === 'instance.stop')?.detail).toMatchObject(
      { reason: 'insufficient' },
    )
  })

  it('宽限中充值：下一轮扣一块、paid_until 从现在起算、清除宽限', async () => {
    const s = await setup({ settings: { graceMinutes: 10 }, grantMicro: 60_000 })
    await s.instances.ensureRunning(s.user.id)
    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    const graceStart = s.clock.now()
    expect(activeLeaseOf(s)?.grace_until).toBe(new Date(graceStart.getTime() + 10 * 60_000).toISOString())

    s.clock.advance(5 * 60_000)
    s.relay.adjustWallet(s.user.id, { amountMicro: 100_000, note: '充值' }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    await s.compute.tick()
    const lease = activeLeaseOf(s)!
    expect(lease.grace_until).toBeNull()
    expect(lease.paid_until).toBe(new Date(s.clock.now().getTime() + 10 * 60_000).toISOString())
    expect(walletOf(s)?.balance).toBe(10_000)
    expect(lease.blocks).toBe(3)
    expect(s.instances.currentStatus(s.user.id)).toBe('running')
  })

  it('Hub 停机补扣多块：一轮内循环扣到 paid_until > now；中途余额耗尽则停在宽限前', async () => {
    const s = await setup({ settings: { graceMinutes: 10 }, grantMicro: 160_000 })
    await s.instances.ensureRunning(s.user.id)
    expect(walletOf(s)?.balance).toBe(110_000)
    s.clock.advance(30 * 60_000)
    await s.compute.tick()
    expect(walletOf(s)?.balance).toBe(-40_000)
    expect(activeLeaseOf(s)).toMatchObject({ blocks: 4, grace_until: null })
    // t=+30，paid_until 已补到 +40 → 余额虽为负，还没到下一块结算点
    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    expect(activeLeaseOf(s)?.grace_until).not.toBeNull()
  })

  it('计费开关从开到关：tick 结束计费租约 billing-off，实例不停', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    expect(activeLeaseOf(s)?.billed).toBe(1)

    await s.compute.updateSettings({ billingEnabled: false }, 1, { ip: '127.0.0.1', userAgent: 'vitest' })
    await s.compute.tick()
    expect(allLeases(s)[0]).toMatchObject({ end_reason: 'billing-off' })
    expect(activeLeaseOf(s)).toBeUndefined()
    expect(s.instances.currentStatus(s.user.id)).toBe('running')
    expect(walletOf(s)?.balance).toBe(950_000)
  })

  it('租约对应实例已不在 running/starting → 结束 system', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    // 绕过实例服务直接把库改成 stopped，模拟对账之外的外部变化
    s.app.deps.db.run("UPDATE instances SET status = 'stopped' WHERE user_id = ?", s.user.id)
    await s.compute.tick()
    expect(allLeases(s)[0]).toMatchObject({ end_reason: 'system' })
  })

  it('对账发现容器消失 → 租约 system；容器意外退出 → crash', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    const name = containerNameFor(s.user.slug)
    s.driver.crash(name)
    await s.instances.reconcileAll()
    expect(allLeases(s)[0]).toMatchObject({ end_reason: 'crash' })

    await s.instances.ensureRunning(s.user.id)
    await s.driver.remove(name)
    await s.instances.reconcileAll()
    expect(allLeases(s)[1]).toMatchObject({ end_reason: 'system' })
  })
})

describe('免费租约（13 §4）', () => {
  it('管理员本人 billAdmins=false → 免费；billAdmins=true → 计费', async () => {
    const free = await setup({ settings: {}, grantMicro: 1_000_000, user: { role: 'admin' } })
    await free.instances.ensureRunning(free.user.id)
    expect(activeLeaseOf(free)).toMatchObject({ billed: 0, blocks: 0, paid_until: null })
    expect(walletOf(free)?.balance).toBe(1_000_000)
    expect(free.compute.myCompute(free.user.id).exempt).toBe(true)

    const paid = await setup({
      settings: { billAdmins: true },
      grantMicro: 1_000_000,
      user: { role: 'admin' },
    })
    await paid.instances.ensureRunning(paid.user.id)
    expect(activeLeaseOf(paid)).toMatchObject({ billed: 1, blocks: 1 })
    expect(walletOf(paid)?.balance).toBe(950_000)
    expect(paid.compute.myCompute(paid.user.id).exempt).toBe(false)
  })

  it('管理员代启动 / rollout 启动原本停止的实例 → 免费租约、不扣用户的钱、规格用已选规格', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id, { planId: 'c4m8' })
    await s.instances.stop(s.user.id)
    const balance = walletOf(s)?.balance

    await s.instances.ensureRunning(s.user.id, { reason: 'admin' })
    expect(activeLeaseOf(s)).toMatchObject({ billed: 0, plan_id: 'c4m8', cpus: 4 })
    expect(walletOf(s)?.balance).toBe(balance)

    await s.instances.stop(s.user.id, { reason: 'admin' })
    await s.instances.ensureRunning(s.user.id, { reason: 'rollout' })
    expect(activeLeaseOf(s)).toMatchObject({ billed: 0 })
    expect(walletOf(s)?.balance).toBe(balance)
  })

  it('管理员代启动 / rollout 不查用户余额（免费租约）：0 余额也能起', async () => {
    const s = await setup({ settings: {} })
    await s.instances.ensureRunning(s.user.id, { reason: 'admin' })
    expect(activeLeaseOf(s)).toMatchObject({ billed: 0 })
    expect(s.instances.currentStatus(s.user.id)).toBe('running')
    await s.instances.stop(s.user.id, { reason: 'admin' })
    await s.instances.ensureRunning(s.user.id, { reason: 'rollout' })
    expect(activeLeaseOf(s)).toMatchObject({ billed: 0 })
  })

  it('计费关闭时启动：不开租约、按 Quota 规格', async () => {
    const s = await setup()
    await s.instances.ensureRunning(s.user.id)
    expect(activeLeaseOf(s)).toBeUndefined()
    expect(containerSpec(s)).toMatchObject({ cpus: 2, memoryMb: 4096 })
    expect(s.compute.myCompute(s.user.id).lease).toBeNull()
  })

  it('进行中租约的规格被管理员停用/删除后，recreate 仍能沿用它', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    await s.compute.updateSettings({ plans: [] }, 1, { ip: '127.0.0.1', userAgent: 'vitest' })
    await s.instances.recreate(s.user.id, { reason: 'admin' })
    expect(s.instances.currentStatus(s.user.id)).toBe('running')
    expect(containerSpec(s)).toMatchObject({ cpus: 2, memoryMb: 4096 })
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')
  })

  it('余额已为负但租约仍有效时，recreate 沿用旧租约、不被 402 挡住', async () => {
    const s = await setup({ settings: {}, grantMicro: 60_000 })
    await s.instances.ensureRunning(s.user.id)
    s.clock.advance(10 * 60_000)
    await s.compute.tick()
    expect(walletOf(s)?.balance).toBe(-40_000)
    const leaseId = activeLeaseOf(s)!.id

    await s.instances.recreate(s.user.id, { reason: 'admin' })
    expect(s.instances.currentStatus(s.user.id)).toBe('running')
    expect(activeLeaseOf(s)?.id).toBe(leaseId)
    expect(walletOf(s)?.balance).toBe(-40_000)
  })

  it('运行中 restart / recreate 沿用进行中的租约，不新开、不重复扣', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    await s.instances.ensureRunning(s.user.id)
    const lease = activeLeaseOf(s)!
    const balance = walletOf(s)?.balance

    await s.instances.restart(s.user.id)
    expect(activeLeaseOf(s)?.id).toBe(lease.id)
    await s.instances.recreate(s.user.id, { reason: 'user' })
    expect(activeLeaseOf(s)?.id).toBe(lease.id)
    expect(walletOf(s)?.balance).toBe(balance)
  })
})

describe('默认规格（15 §3.1）', () => {
  function plan(overrides: Partial<ComputePlan> & Pick<ComputePlan, 'id' | 'sort'>): ComputePlan {
    return {
      name: overrides.id,
      cpus: 1,
      memoryMb: 1024,
      pricePerHourMicro: 100_000,
      enabled: true,
      userIds: null,
      ...overrides,
    }
  }

  it('没选过规格 → 用 defaultPlanId；currentSpec / myCompute / 启动与租约一致', async () => {
    const s = await setup({ settings: { defaultPlanId: 'c4m8' }, grantMicro: 1_000_000 })
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
    expect(s.compute.currentSpec(s.user.id)).toEqual({ cpus: 4, memoryMb: 8192 })

    await s.instances.ensureRunning(s.user.id)
    expect(containerSpec(s)).toMatchObject({ cpus: 4, memoryMb: 8192 })
    expect(activeLeaseOf(s)).toMatchObject({ plan_id: 'c4m8', cpus: 4, memory_mb: 8192 })
  })

  it('defaultPlanId 被停用 / 删除 / 是别人的定制规格 → 退回第一个可选', async () => {
    const plans = [
      plan({ id: 'first', sort: 10 }),
      plan({ id: 'second', sort: 20 }),
      plan({ id: 'off', sort: 1, enabled: false }),
      plan({ id: 'vip', sort: 2, userIds: [999_999] }),
    ]
    for (const [label, defaultPlanId] of [
      ['已停用', 'off'],
      ['已删除', 'gone'],
      ['别人的定制规格', 'vip'],
    ] as const) {
      const s = await setup({ settings: { plans, defaultPlanId } })
      expect(s.compute.myCompute(s.user.id).selectedPlanId, label).toBe('first')
      // currentSpec 走同一条回退链（计费开启时由它决定容器规格）
      expect(s.compute.currentSpec(s.user.id), label).toEqual({ cpus: 1, memoryMb: 1024 })
    }
  })

  it('defaultPlanId=null → 第一个；选过别的 → 用选过的；之后改默认也不影响', async () => {
    const s = await setup({ settings: { defaultPlanId: null }, grantMicro: 1_000_000 })
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c2m4')
    await s.compute.selectPlan(s.user.id, 'c4m8')
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')

    await s.compute.updateSettings({ defaultPlanId: 'c8m16' }, 1, META)
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
  })

  it('改默认规格：没选过的用户跟着变，选过的不变', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const chooser = await createUser(s.app, { username: 'chooser' })
    await s.compute.selectPlan(chooser.id, 'c8m16')

    await s.compute.updateSettings({ defaultPlanId: 'c4m8' }, 1, META)
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
    expect(s.compute.myCompute(chooser.id).selectedPlanId).toBe('c8m16')

    await s.compute.updateSettings({ defaultPlanId: 'c8m16' }, 1, META)
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c8m16')
    expect(s.compute.myCompute(chooser.id).selectedPlanId).toBe('c8m16')
  })

  it('读取我的算力 / 改默认规格不写 compute_prefs；启动时才把本次实际规格记下来', async () => {
    const s = await setup({ settings: { defaultPlanId: 'c4m8' }, grantMicro: 1_000_000 })
    const pref = () =>
      s.app.deps.db.get<{ plan_id: string }>('SELECT plan_id FROM compute_prefs WHERE user_id = ?', s.user.id)
    expect(pref()).toBeUndefined()
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
    expect(pref()).toBeUndefined()

    await s.compute.updateSettings({ defaultPlanId: 'c8m16' }, 1, META)
    expect(pref()).toBeUndefined()

    await s.instances.ensureRunning(s.user.id)
    expect(pref()).toMatchObject({ plan_id: 'c8m16' })
  })

  it('旧库的 compute 设置没有 defaultPlanId → 按默认值合并成 c2m4（不是第一个可选规格）', async () => {
    const s = await setup()
    // 模拟 WP19 之前的库：整份设置里没有 defaultPlanId 字段
    s.app.deps.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('compute', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      JSON.stringify({
        billingEnabled: true,
        billAdmins: false,
        graceMinutes: 10,
        capacityMemoryMb: 0,
        contactText: '旧设置',
        plans: [plan({ id: 'first', sort: 1 }), plan({ id: 'c2m4', sort: 99 })],
      }),
      s.clock.nowIso(),
    )

    expect(s.compute.getSettings().defaultPlanId).toBe('c2m4')
    // 默认值 c2m4 对该用户可选 → 用它，而不是 sort 更靠前的 first
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c2m4')
  })
})
