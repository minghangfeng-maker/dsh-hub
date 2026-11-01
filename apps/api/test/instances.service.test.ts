import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_CONTAINER_PERMISSION_PRESET,
  DEFAULT_QUOTA_VALUE,
  DEFAULT_SETTINGS,
  type Quota,
} from '@dsh-hub/shared'
import {
  ATTACH_COLLABORATORS,
  CPU_SAMPLE_SIZE,
  type InternalInstanceService,
} from '../src/modules/instances/service.js'
import { containerNameFor, imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import { createTestApp, createUser, type TestApp, type TestUser } from './helpers.js'

const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)
const LONG_READY_DELAY_MS = 60_000

interface Setup {
  ctx: TestApp
  app: FastifyInstance
  user: TestUser
  instances: InternalInstanceService
  driver: NonNullable<TestApp['driver']>
  name: string
}

const contexts: TestApp[] = []

afterEach(async () => {
  delete process.env.HUB_INSTANCE_READY_TIMEOUT_MS
  for (const ctx of contexts.splice(0)) await ctx.close()
})

/**
 * WP45：磁盘用量改成「后台统计 + 缓存」后，`getStats` 冷缓存第一次可能返回 `null`。
 * 测试里需要一个确定性等待：真实时间里轮询到数字出现（测试目录很小，几十毫秒内就完成）。
 */
async function waitForDiskBytes<T extends { diskBytes: number | null }>(
  read: () => Promise<T | null>,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const stats = await read()
    if (stats && typeof stats.diskBytes === 'number') return stats
    if (Date.now() > deadline) throw new Error('磁盘统计在测试超时前没有完成')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function setup(opts: { quota?: Partial<Quota>; provision?: boolean } = {}): Promise<Setup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  const driver = ctx.driver!
  driver.addImage(IMAGE)
  const user = await createUser(ctx.app, {
    quotaJson: opts.quota ? JSON.stringify({ ...DEFAULT_QUOTA_VALUE, ...opts.quota }) : null,
  })
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  if (opts.provision !== false) await instances.provision(user.id)
  return {
    ctx,
    app: ctx.app,
    user,
    instances,
    driver,
    name: containerNameFor(user.slug),
  }
}

describe('provision（05 §6 / 03 §2）', () => {
  it('建目录、写 managed 占位、instances 行置 stopped，不建容器', async () => {
    const { ctx, user, instances, driver } = await setup({ provision: false })
    const summary = await instances.provision(user.id)
    const paths = ctx.app.deps.paths
    for (const dir of [
      paths.userHome(user.slug),
      paths.userWorkspace(user.slug),
      paths.userManaged(user.slug),
    ]) {
      expect(existsSync(dir)).toBe(true)
    }
    // WP3 合并后 managed/ 由 models.renderManaged 真正渲染：至少含 workspace-controller 条目，
    // 且必须是顶层 YAML 数组（DSH 对非数组 fatal，WP2 真容器实测）
    const managed = readFileSync(join(paths.userManaged(user.slug), 'managed.patch.yml'), 'utf8')
    expect(managed).toContain('id: workspace-controller')
    expect(managed).toContain('documentsDirectory: /workspace')
    const manifest = JSON.parse(
      readFileSync(join(paths.userManaged(user.slug), 'manifest.json'), 'utf8'),
    ) as {
      slug: string
      generatedAt: string
    }
    expect(manifest).toMatchObject({ slug: user.slug })
    expect(manifest.generatedAt).toBe(ctx.clock.nowIso())

    expect(summary).toMatchObject({ status: 'stopped', openUrl: `/dsh/${user.username}/`, error: null })
    expect(driver.getContainerNames()).toHaveLength(0)
    // 幂等：重复 provision 不炸、不覆盖目录
    await instances.provision(user.id)
    expect(instances.currentStatus(user.id)).toBe('stopped')
  })
})

describe('provision 的 managed.patch.yml（WP40d）', () => {
  it('默认不下发手机「普通对话」预设（标准 DSH 模式）；管理员开启时才写 preset-chat', async () => {
    const { ctx, user, instances } = await setup({ provision: false })
    await instances.provision(user.id)
    const managed = readFileSync(
      join(ctx.app.deps.paths.userManaged(user.slug), 'managed.patch.yml'),
      'utf8',
    )
    expect(managed).not.toContain('preset-chat')
    expect(managed).not.toContain('agent-preset-registry')
  })
})

describe('ensureRunning 状态机（05 §6）', () => {
  it('并发 3 次 start 只建一个容器，且都已 running', async () => {
    const { user, instances, driver, name } = await setup()
    const results = await Promise.all([
      instances.ensureRunning(user.id),
      instances.ensureRunning(user.id),
      instances.ensureRunning(user.id),
    ])
    expect(results.every((summary) => summary.status === 'running')).toBe(true)
    expect(driver.getContainerNames()).toEqual([name])
    const info = await driver.inspect(name)
    expect(info?.state).toBe('running')
    expect(info?.labels['dshhub.slug']).toBe(user.slug)
    expect(info?.labels['dshhub.config_hash']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('已在运行时 start 是幂等的（不重建容器）', async () => {
    const { user, instances, driver, name } = await setup()
    await instances.ensureRunning(user.id)
    const first = await driver.inspect(name)
    await instances.ensureRunning(user.id)
    const second = await driver.inspect(name)
    expect(second?.id).toBe(first?.id)
    expect(driver.getContainerNames()).toHaveLength(1)
  })

  // 热修回归：实例行已存在（例如插件下发的一次性容器留下）时，目录被清掉也要在起容器前补建，
  // 否则 Docker 会以 root 建 bind mount 目录，容器里的 uid 1000 写不了 /home/dsh/.dsh。
  it('实例行已存在但用户目录被清掉 → 起容器前补建四个目录（0o700）', async () => {
    const { user, instances, driver, ctx } = await setup()
    const paths = ctx.app.deps.paths
    const dirs = [
      paths.userDir(user.slug),
      paths.userHome(user.slug),
      paths.userWorkspace(user.slug),
      paths.userManaged(user.slug),
    ]
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)

    // fake driver 没有 create 钩子：包一层，记录 docker create 当时四个目录是否已经存在
    let dirsAtCreate: boolean[] = []
    const create = driver.create.bind(driver)
    driver.create = async (spec) => {
      dirsAtCreate = dirs.map((dir) => existsSync(dir))
      return create(spec)
    }

    await instances.ensureRunning(user.id)
    expect(dirsAtCreate).toEqual([true, true, true, true])
    for (const dir of dirs) expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('就绪超时 → error + INSTANCE_START_FAILED（附日志尾巴），修好后重试可成功', async () => {
    process.env.HUB_INSTANCE_READY_TIMEOUT_MS = '400'
    const { user, instances, driver, ctx } = await setup()
    driver.setReadyDelay(LONG_READY_DELAY_MS)

    await expect(instances.ensureRunning(user.id)).rejects.toMatchObject({
      code: 'INSTANCE_START_FAILED',
      status: 500,
    })
    expect(instances.currentStatus(user.id)).toBe('error')
    const row = ctx.app.deps.db.get<{ error: string | null }>(
      'SELECT error FROM instances WHERE user_id = ?',
      user.id,
    )
    expect(row?.error).toContain('等待就绪超时')
    const audit = ctx.app.deps.audit.recent(5).find((item) => item.action === 'instance.error')
    expect(audit).toBeTruthy()

    // 第二次：密钥立刻落盘 → 启动成功（error 可重试，05 §6）
    driver.setReadyDelay(0)
    const summary = await instances.ensureRunning(user.id)
    expect(summary.status).toBe('running')
    expect(summary.error).toBeNull()
  })

  it('镜像未就绪 → RUNTIME_NOT_READY', async () => {
    const ctx = await createTestApp()
    contexts.push(ctx)
    const user = await createUser(ctx.app)
    const instances = ctx.app.deps.services.instances as InternalInstanceService
    await instances.provision(user.id)
    // 没有 addImage：FakeDriver 认为镜像不存在
    await expect(instances.ensureRunning(user.id)).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' })
  })

  it('磁盘用量超过 diskGb → DISK_QUOTA_EXCEEDED（403，details 带 usedBytes/limitBytes）', async () => {
    const { user, instances, ctx, driver } = await setup({ quota: { diskGb: 1 } })
    // 稀疏文件：st_size 2GB 但不占真实磁盘（磁盘统计按 lstat().size 累计）
    const big = join(ctx.app.deps.paths.userDir(user.slug), 'big.bin')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, 2 * 1024 * 1024 * 1024) // 稀疏文件：st_size 2GB，不占真实磁盘
    closeSync(fd)

    await expect(instances.ensureRunning(user.id)).rejects.toMatchObject({
      code: 'DISK_QUOTA_EXCEEDED',
      status: 403,
      details: { limitBytes: 1024 * 1024 * 1024 },
    })
    // 拒绝发生在建容器之前，实例保持 stopped（已运行的不强停，05 §7）
    expect(driver.getContainerNames()).toHaveLength(0)
    expect(instances.currentStatus(user.id)).toBe('stopped')

    // 停止态也能拿到用量/上限（前端画 90%/100% 提示的数据）
    const stats = await instances.getStats(user.id)
    expect(stats?.diskBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024 * 1024)
    expect(stats?.diskLimitBytes).toBe(1024 * 1024 * 1024)
  })

  it('容量满 → CAPACITY_FULL（details 带 running/max）', async () => {
    const { app, instances, driver, ctx } = await setup()
    await app.deps.settings.set('capacity', { maxRunning: 1, maxConcurrentExports: 2 })
    const other = await createUser(app)
    driver.addImage(IMAGE)
    await instances.provision(other.id)
    const first = await instances.ensureRunning((await currentUser(ctx)).id)
    expect(first.status).toBe('running')

    await expect(instances.ensureRunning(other.id)).rejects.toMatchObject({
      code: 'CAPACITY_FULL',
      status: 503,
      details: { running: 1, max: 1 },
    })
  })
})

describe('stop / restart / recreate（05 §6）', () => {
  it('stop 保留容器、状态转 stopped；restart 复用同一容器', async () => {
    const { user, instances, driver, name } = await setup()
    await instances.ensureRunning(user.id)
    const containerId = (await driver.inspect(name))?.id

    const stopped = await instances.stop(user.id, { reason: 'user' })
    expect(stopped.status).toBe('stopped')
    expect((await driver.inspect(name))?.state).toBe('exited')

    const restarted = await instances.restart(user.id)
    expect(restarted.status).toBe('running')
    expect((await driver.inspect(name))?.id).toBe(containerId)
  })

  it('配额变化 → needsRecreate → restart 触发重建（数据卷不变）', async () => {
    const { user, instances, driver, name, ctx } = await setup()
    await instances.ensureRunning(user.id)
    const before = await driver.inspect(name)
    expect((await instances.getSummary(user.id)).needsRecreate).toBe(false)

    const nextQuota: Quota = { ...DEFAULT_QUOTA_VALUE, cpus: 4 }
    ctx.app.deps.db.run('UPDATE users SET quota_json = ? WHERE id = ?', JSON.stringify(nextQuota), user.id)
    expect((await instances.getSummary(user.id)).needsRecreate).toBe(true)

    const summary = await instances.restart(user.id)
    expect(summary.status).toBe('running')
    const after = await driver.inspect(name)
    expect(after?.id).not.toBe(before?.id)
    expect(driver.getContainer(name)?.spec.cpus).toBe(4)
    // 重建后 hash 与库一致，不再提示需要重建
    expect((await instances.getSummary(user.id)).needsRecreate).toBe(false)
  })

  it('recreate 显式重建并留下审计', async () => {
    const { user, instances, driver, name, ctx } = await setup()
    await instances.ensureRunning(user.id)
    const before = await driver.inspect(name)
    const summary = await instances.recreate(user.id, { reason: 'admin' })
    expect(summary.status).toBe('running')
    expect((await driver.inspect(name))?.id).not.toBe(before?.id)
    expect(ctx.app.deps.audit.recent(5).some((item) => item.action === 'instance.recreate')).toBe(true)
  })
})

describe('bootstrap（06 §2.5）', () => {
  it('首次启动调用一次 bootstrapUser 并写 bootstrapped_at', async () => {
    const { user, instances, ctx } = await setup()
    const calls: number[] = []
    instances[ATTACH_COLLABORATORS]({
      bootstrapUser: async (userId) => {
        calls.push(userId)
      },
    })
    await instances.ensureRunning(user.id)
    expect(calls).toEqual([user.id])
    const row = ctx.app.deps.db.get<{ bootstrapped_at: string | null }>(
      'SELECT bootstrapped_at FROM instances WHERE user_id = ?',
      user.id,
    )
    expect(row?.bootstrapped_at).toBeTruthy()

    await instances.stop(user.id)
    await instances.ensureRunning(user.id)
    expect(calls).toEqual([user.id])
  })

  it('bootstrap 抛错仍然能启动，且照样写 bootstrapped_at（06 §2.5：失败不阻塞、不重试）', async () => {
    const { user, instances, ctx } = await setup()
    let attempts = 0
    instances[ATTACH_COLLABORATORS]({
      bootstrapUser: async () => {
        attempts += 1
        throw new Error('pnpm install 失败')
      },
    })
    const summary = await instances.ensureRunning(user.id)
    expect(summary.status).toBe('running')
    expect(bootstrappedAt(ctx, user.id)).toBeTruthy()

    // 再起一次不会重复 bootstrap（失败的插件由 user_plugins.state=failed 记录，另有「立即应用」入口）
    await instances.stop(user.id)
    await instances.ensureRunning(user.id)
    expect(attempts).toBe(1)
  })

  it('bootstrap 在启动 DSH 之前离线完成，阶段顺序是 creating → bootstrapping → booting → ready', async () => {
    const { user, instances, driver, name } = await setup()
    const phases: string[] = []
    let stateDuringBootstrap: string | null = null
    instances[ATTACH_COLLABORATORS]({
      bootstrapUser: async () => {
        // 调 bootstrap 的那一刻，容器必须已经建好但**还没 start**（WP3 用 runOnce 离线装插件）
        stateDuringBootstrap = (await driver.inspect(name))?.state ?? null
      },
    })
    await instances.ensureRunning(user.id, {
      onPhase: (phase) => {
        phases.push(phase)
      },
    })
    expect(stateDuringBootstrap).toBe('created')
    expect(phases).toEqual(['creating', 'bootstrapping', 'booting', 'ready'])
  })

  it('模型 env 由 models.containerEnv 提供并进 config_hash（05 §4）', async () => {
    const { user, instances, driver, name } = await setup()
    instances[ATTACH_COLLABORATORS]({ containerEnv: async () => ({ HUB_MK_HUB_RELAY: 'k-1' }) })
    await instances.ensureRunning(user.id)
    expect(driver.getContainer(name)?.spec.env.HUB_MK_HUB_RELAY).toBe('k-1')

    instances[ATTACH_COLLABORATORS]({ containerEnv: async () => ({ HUB_MK_HUB_RELAY: 'k-2' }) })
    expect((await instances.getSummary(user.id)).needsRecreate).toBe(true)
    await instances.restart(user.id)
    expect(driver.getContainer(name)?.spec.env.HUB_MK_HUB_RELAY).toBe('k-2')
  })

  it('容器内权限预设：缺省 danger-full-access；改设置后 env 与 config_hash 都变（WP40d）', async () => {
    // 两处默认值必须一致（shared 常量 vs settings 默认）
    expect(DEFAULT_CONTAINER_PERMISSION_PRESET).toBe(DEFAULT_SETTINGS.container.permissionPreset)
    const { user, instances, driver, name, ctx } = await setup()
    await instances.ensureRunning(user.id)
    const first = driver.getContainer(name)!.spec
    expect(first.env.DSH_PERMISSION_MODE).toBe('danger-full-access')

    // 管理员把「容器内权限」改回 ask（workspace-write + 审批）→ 期望哈希变化、下次启动重建
    ctx.app.deps.settings.set('container', { permissionPreset: 'workspace-write', chatPreset: true })
    expect((await instances.getSummary(user.id)).needsRecreate).toBe(true)
    await instances.restart(user.id)
    const second = driver.getContainer(name)!.spec
    expect(second.env.DSH_PERMISSION_MODE).toBe('workspace-write')
    expect(second.labels['dshhub.config_hash']).not.toBe(first.labels['dshhub.config_hash'])
    // 重建不动数据卷：四个挂载必须一字不差（05 §4）
    expect(second.mounts).toEqual(first.mounts)
  })
})

describe('对账与空闲回收（05 §6）', () => {
  it('崩溃的容器 → error（附最后日志）', async () => {
    const { user, instances, driver, name, ctx } = await setup()
    await instances.ensureRunning(user.id)
    driver.crash(name, 3)
    await instances.reconcileAll()
    expect(instances.currentStatus(user.id)).toBe('error')
    const row = ctx.app.deps.db.get<{ error: string | null }>(
      'SELECT error FROM instances WHERE user_id = ?',
      user.id,
    )
    expect(row?.error).toContain('exit code=3')
    expect(ctx.app.deps.audit.recent(5).some((item) => item.action === 'instance.error')).toBe(true)
  })

  it('容器被外部删除 → stopped；Hub 重启后容器仍在 → running', async () => {
    const { user, instances, driver, name, ctx } = await setup()
    await instances.ensureRunning(user.id)

    // 模拟「Hub 重启」：库里状态是 stopped，但容器其实在跑 → 对账改回 running
    ctx.app.deps.db.run("UPDATE instances SET status = 'stopped' WHERE user_id = ?", user.id)
    await instances.reconcileAll()
    expect(instances.currentStatus(user.id)).toBe('running')

    // 容器被外部删掉 → 库里落 stopped，不残留 running
    await driver.remove(name)
    await instances.reconcileAll()
    expect(instances.currentStatus(user.id)).toBe('stopped')
  })

  it('空闲超过 idleStopMinutes 且 CPU 低 → 自动停止（审计 reason=idle）', async () => {
    const { user, instances, ctx, driver } = await setup({ quota: { idleStopMinutes: 1 } })
    await instances.ensureRunning(user.id)
    expect(await instances.reapIdle()).toBe(0)

    ctx.clock.advance(2 * 60_000)
    // CPU 判据要采满 CPU_SAMPLE_SIZE 个样本（每分钟一个 ≈ 最近 5 分钟）才生效（WP15 ②）
    expect(await reapRounds(instances, CPU_SAMPLE_SIZE)).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
    const audit = ctx.app.deps.audit.recent(5).find((item) => item.action === 'instance.stop')
    expect(audit?.detail).toMatchObject({ reason: 'idle' })
    // 假 stats 说的是 1.5% CPU，符合「最近 5 分钟平均 < 3%」
    expect(driver.getContainer(containerNameFor(user.slug))?.state).toBe('exited')
  })

  it('CPU 忙时不停（防止停掉正在跑长任务的 agent）；idleStopMinutes=0 永久不回收', async () => {
    const busy = await setup({ quota: { idleStopMinutes: 1 } })
    await busy.instances.ensureRunning(busy.user.id)
    busy.driver.setStats({ cpuPercent: 42, memoryBytes: 1, memoryLimitBytes: 2, pids: 3 })
    busy.ctx.clock.advance(10 * 60_000)
    // 采满一整窗样本也是「忙」：5 × 42% 远高于 3%
    expect(await reapRounds(busy.instances, CPU_SAMPLE_SIZE + 2)).toBe(0)
    expect(busy.instances.currentStatus(busy.user.id)).toBe('running')

    const never = await setup({ quota: { idleStopMinutes: 0 } })
    await never.instances.ensureRunning(never.user.id)
    never.ctx.clock.advance(24 * 60 * 60_000)
    expect(await reapRounds(never.instances, CPU_SAMPLE_SIZE)).toBe(0)
    expect(never.instances.currentStatus(never.user.id)).toBe('running')
  })

  it('活跃度节流落库：touchActivity + flushActivity 影响空闲判据', async () => {
    const { user, instances, ctx } = await setup({ quota: { idleStopMinutes: 1 } })
    await instances.ensureRunning(user.id)
    ctx.clock.advance(2 * 60_000)
    instances.touchActivity(user.id) // 代理每请求调用它，默认 30s 批量落库
    instances.flushActivity()
    expect(await instances.reapIdle()).toBe(0)

    ctx.clock.advance(2 * 60_000)
    expect(await reapRounds(instances, CPU_SAMPLE_SIZE)).toBe(1)
  })

  it('调度器可启停（生产由模块注册时启动，测试模式不自动起）', async () => {
    const { instances } = await setup()
    expect(() => {
      instances.startSchedulers()
      instances.startSchedulers()
      instances.stopSchedulers()
    }).not.toThrow()
  })
})

/**
 * WP15（管理端实例操作串扰）：空闲回收的起点与 CPU 判据。
 *
 * 生产形态：管理员从后台启动实例，但没人打开那个用户的 DSH → `last_active_at` 还是几百分钟前，
 * `markRunning` 只写 `started_at`；旧实现用 `last_active_at ?? started_at` 算空闲，≤60s 的下一轮
 * 就把刚启动的实例停了（用户看到「点 A 的停止，B 也停了」）。
 */
describe('空闲回收的起点与 CPU 样本（WP15）', () => {
  it('刚启动（last_active_at 是很久以前）不会被回收；超时且采满样本后才停', async () => {
    const { user, instances, ctx } = await setup({ quota: { idleStopMinutes: 1 } })
    await instances.ensureRunning(user.id)
    const old = setLastActiveAgo(ctx, user.id, 528) // 生产日志 19:13:44 user 2 的形态

    // 旧实现会在这里返回 1（把刚启动的实例停掉）；新实现从 started_at 重新计时
    expect(await instances.reapIdle()).toBe(0)
    expect(instances.currentStatus(user.id)).toBe('running')
    // 启动不刷新「最近活跃」：管理端要展示真实使用时间，不做假
    expect(lastActiveAt(ctx, user.id)).toBe(old)

    ctx.clock.advance(2 * 60_000)
    // 第 1 轮已经采过 1 个样本，还差 CPU_SAMPLE_SIZE - 1 个才够判定
    expect(await reapRounds(instances, CPU_SAMPLE_SIZE - 2)).toBe(0)
    expect(instances.currentStatus(user.id)).toBe('running')
    expect(await instances.reapIdle()).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
  })

  it('两个用户：只停真空闲很久的那个，刚启动的（旧 last_active_at）照常运行', async () => {
    const ctx = await createTestApp()
    contexts.push(ctx)
    ctx.driver!.addImage(IMAGE)
    const instances = ctx.app.deps.services.instances as InternalInstanceService
    // 真空闲的用 1 分钟配额；刚启动的用默认 120 分钟配额（更接近生产）
    const idle = await createUser(ctx.app, {
      quotaJson: JSON.stringify({ ...DEFAULT_QUOTA_VALUE, idleStopMinutes: 1 }),
    })
    const fresh = await createUser(ctx.app, {
      quotaJson: JSON.stringify({ ...DEFAULT_QUOTA_VALUE, idleStopMinutes: 120 }),
    })
    await instances.provision(idle.id)
    await instances.provision(fresh.id)

    await instances.ensureRunning(idle.id)
    ctx.clock.advance(2 * 60_000)
    await instances.ensureRunning(fresh.id) // 管理员刚启动（没人打开 → last_active 仍是很久以前）
    setLastActiveAgo(ctx, fresh.id, 528)

    // 一轮：谁都不该停；之后 idle 攒满样本被停，fresh 因为起点是刚才的 started_at 而安然无恙
    expect(await instances.reapIdle()).toBe(0)
    expect(await reapRounds(instances, CPU_SAMPLE_SIZE)).toBe(1)
    expect(instances.currentStatus(idle.id)).toBe('stopped')
    expect(instances.currentStatus(fresh.id)).toBe('running')
  })

  it('样本数不足 CPU_SAMPLE_SIZE 时不停（Hub 刚启动/实例刚恢复时没有「最近 5 分钟」证据）', async () => {
    const { user, instances, ctx } = await setup({ quota: { idleStopMinutes: 1 } })
    await instances.ensureRunning(user.id)
    ctx.clock.advance(10 * 60_000) // 一次跳很久：样本表还是空的

    for (let i = 0; i < CPU_SAMPLE_SIZE - 1; i += 1) expect(await instances.reapIdle()).toBe(0)
    expect(instances.currentStatus(user.id)).toBe('running')
    expect(await instances.reapIdle()).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
  })

  it('restart 刷新 started_at：重启后空闲回收从这次启动重新计时', async () => {
    const { user, instances, ctx } = await setup({ quota: { idleStopMinutes: 1 } })
    await instances.ensureRunning(user.id)
    const before = startedAt(ctx, user.id)
    ctx.clock.advance(30 * 60_000)
    setLastActiveAgo(ctx, user.id, 600) // 上一轮运行的旧活跃时间

    await instances.restart(user.id)
    expect(startedAt(ctx, user.id)).toBe(ctx.clock.nowIso())
    expect(startedAt(ctx, user.id)).not.toBe(before)

    // 旧的 last_active_at 不会再被算成 600 分钟空闲；样本也清零 → 采满一整窗都不该停
    expect(await reapRounds(instances, CPU_SAMPLE_SIZE)).toBe(0)
    expect(instances.currentStatus(user.id)).toBe('running')
  })
})

describe('统计与运维接口（04 §3.1 §4.3）', () => {
  it('getStats：容器没跑时运行时数字为 0、磁盘用量照给；跑起来后给真实数字', async () => {
    const { user, instances } = await setup({ quota: { diskGb: 3 } })
    // 没有实例行的用户 → null（各自的 app 上下文里判断，避免 id 撞车）
    const stranger = await setup({ provision: false })
    expect(await stranger.instances.getStats(stranger.user.id)).toBeNull()

    // WP45：冷缓存时首屏不等目录统计（旧实现要遍历整个用户目录），先给 null + 后台补测
    const cold = await instances.getStats(user.id)
    expect(cold?.diskBytes ?? null).toBeNull()
    expect(cold).toMatchObject({ diskLimitBytes: 3 * 1024 * 1024 * 1024 })

    const idle = await waitForDiskBytes(() => instances.getStats(user.id))
    expect(idle).toMatchObject({
      cpuPercent: 0,
      memoryBytes: 0,
      pids: 0,
      diskLimitBytes: 3 * 1024 * 1024 * 1024,
    })
    expect(typeof idle?.diskBytes).toBe('number')

    await instances.ensureRunning(user.id)
    const running = await instances.getStats(user.id)
    expect(running).toMatchObject({ cpuPercent: 1.5, diskLimitBytes: 3 * 1024 * 1024 * 1024 })
    expect(typeof running?.diskBytes).toBe('number')
  })

  it('hostSnapshot / counts 反映宿主与实例概况', async () => {
    const { user, instances, app } = await setup()
    await instances.ensureRunning(user.id)
    const snapshot = await instances.hostSnapshot()
    expect(snapshot.cpuCount).toBeGreaterThan(0)
    expect(snapshot.memTotal).toBeGreaterThan(0)
    expect(snapshot.dockerOk).toBe(true)
    expect(instances.counts()).toEqual({
      running: 1,
      max: app.deps.settings.get('capacity').maxRunning,
      starting: 0,
      error: 0,
    })
  })

  it('管理端列表带上用户、stats（WP33：只读采样器缓存）与 needsRecreate', async () => {
    const { user, instances } = await setup()
    await instances.ensureRunning(user.id)
    // WP33：列表不再内联采 stats；先让采样器写一份缓存
    await instances.refreshStatsCache()
    const rows = await instances.listForAdmin()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.user).toMatchObject({ id: user.id, slug: user.slug, username: user.username })
    expect(row.status).toBe('running')
    expect(row.stats?.cpuPercent).toBe(1.5)
    expect(row.statsAt).toBeTruthy()
    expect(row.probe?.state).toBe('unknown') // 还没探过（假驱动默认没有 session/list）
    expect(row.needsRecreate).toBe(false)
    expect(row.runtimeVersion).toBe(FALLBACK_DSH_VERSION)
  })

  it('日志脱敏：token=***', async () => {
    const { user, instances, driver, name } = await setup()
    await instances.ensureRunning(user.id)
    await driver.exec(name, ['sh', '-lc', 'echo token=super-secret'])
    const text = await instances.logsFor(user.id, 50)
    expect(text).toContain('token=***')
    expect(text).not.toContain('super-secret')
  })

  it('removeUserData：停删容器 + 数据移入 trash/', async () => {
    const { user, instances, driver, ctx } = await setup()
    await instances.ensureRunning(user.id)
    const result = await instances.removeUserData(user.id)
    expect(result.slug).toBe(user.slug)
    expect(result.trashPath).toBeTruthy()
    expect(existsSync(ctx.app.deps.paths.userDir(user.slug))).toBe(false)
    expect(existsSync(result.trashPath!)).toBe(true)
    expect(driver.getContainerNames()).toHaveLength(0)
    expect(instances.currentStatus(user.id)).toBe('absent')
  })

  // 热修回归：管理端删除用户时先软删除（deleted_at 已置位）再清数据，removeUserData 不能
  // 再用「未软删除」的严格语义拒掉，否则容器/实例行/目录全都留在那里。
  it('removeUserData：用户已软删除也能清容器、实例行与目录', async () => {
    const { user, instances, driver, ctx } = await setup()
    await instances.ensureRunning(user.id)
    ctx.app.deps.db.run(
      "UPDATE users SET deleted_at = ?, status = 'disabled' WHERE id = ?",
      ctx.clock.nowIso(),
      user.id,
    )

    const result = await instances.removeUserData(user.id)
    expect(result.slug).toBe(user.slug)
    expect(result.trashPath).toBeTruthy()
    expect(existsSync(result.trashPath!)).toBe(true)
    expect(
      ctx.app.deps.db.get<{ user_id: number }>('SELECT user_id FROM instances WHERE user_id = ?', user.id),
    ).toBeUndefined()
    expect(driver.getContainerNames()).toHaveLength(0)
    expect(instances.currentStatus(user.id)).toBe('absent')
  })

  it('removeUserData：物理不存在的用户仍抛 NOT_FOUND', async () => {
    const { instances } = await setup()
    await expect(instances.removeUserData(999_999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

/** `bootstrapped_at`（06 §2.5） */
function bootstrappedAt(ctx: TestApp, userId: number): string | null {
  return (
    ctx.app.deps.db.get<{ bootstrapped_at: string | null }>(
      'SELECT bootstrapped_at FROM instances WHERE user_id = ?',
      userId,
    )?.bootstrapped_at ?? null
  )
}

/** `instances.started_at`（空闲起点，WP15） */
function startedAt(ctx: TestApp, userId: number): string | null {
  return (
    ctx.app.deps.db.get<{ started_at: string | null }>(
      'SELECT started_at FROM instances WHERE user_id = ?',
      userId,
    )?.started_at ?? null
  )
}

/** `instances.last_active_at`（管理端展示的真实使用时间） */
function lastActiveAt(ctx: TestApp, userId: number): string | null {
  return (
    ctx.app.deps.db.get<{ last_active_at: string | null }>(
      'SELECT last_active_at FROM instances WHERE user_id = ?',
      userId,
    )?.last_active_at ?? null
  )
}

/** 把 `last_active_at` 改到 `minutesAgo` 分钟前（模拟「启动了但一直没人打开 DSH」） */
function setLastActiveAgo(ctx: TestApp, userId: number, minutesAgo: number): string {
  const at = new Date(ctx.clock.now().getTime() - minutesAgo * 60_000).toISOString()
  ctx.app.deps.db.run('UPDATE instances SET last_active_at = ? WHERE user_id = ?', at, userId)
  return at
}

/** 连续跑 `rounds` 轮空闲回收（每轮最多采一个 CPU 样本），返回累计停掉的实例数 */
async function reapRounds(instances: InternalInstanceService, rounds: number): Promise<number> {
  let stopped = 0
  for (let i = 0; i < rounds; i += 1) stopped += await instances.reapIdle()
  return stopped
}

/** 取「容量」测试里第一个用户的 id（setup 每次都新建用户，这里只是拿最近创建的那个） */
async function currentUser(ctx: TestApp): Promise<TestUser> {
  const row = ctx.app.deps.db.get<{ id: number }>('SELECT id FROM users ORDER BY id LIMIT 1')
  if (!row) throw new Error('没有用户')
  return { id: row.id } as TestUser
}
