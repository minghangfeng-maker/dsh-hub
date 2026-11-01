import { afterEach, describe, expect, it } from 'vitest'
import { CONTAINER_LABEL_MANAGED, DEFAULT_QUOTA_VALUE } from '@dsh-hub/shared'
import { runStopAll } from '../src/ops/stop-all.js'
import { CPU_SAMPLE_SIZE, type InternalInstanceService } from '../src/modules/instances/service.js'
import {
  FALLBACK_DSH_VERSION,
  LABEL_ENV,
  LABEL_SLUG,
  belongsToEnv,
  imageForVersion,
} from '../src/modules/instances/spec.js'
import type { ContainerSpec } from '../src/modules/instances/types.js'
import { createTestApp, createUser, type TestApp } from './helpers.js'

/**
 * 开发/生产隔离（11 §2）：开发、测试、生产共用同一个 Docker 守护进程，
 * 靠 `HUB_CONTAINER_PREFIX`（容器名）与 `HUB_ENV_ID`（`dshhub.env` 标签）把
 * 对账 / 空闲回收 / `cli instance:stop-all` 的视野限制在本环境内。
 */
const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)
const TEST_PREFIX = 'dshhub-test-wp2-'
const TEST_ENV = 'test-wp2'

const contexts: TestApp[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close()
})

/** 手工造一个「别的环境」的容器（模拟生产/另一个会话起的容器） */
function foreignSpec(name: string, envId: string): ContainerSpec {
  return {
    name,
    image: IMAGE,
    env: { DSH_AUTHORITY: '127.0.0.1:3000' },
    labels: {
      [CONTAINER_LABEL_MANAGED]: '1',
      [LABEL_ENV]: envId,
      [LABEL_SLUG]: name.replace(/^dshhub-/, ''),
    },
    mounts: [],
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    network: 'dshhub-test-wp2-net',
    readOnlyRootfs: true,
    tmpfs: { '/tmp': 'rw,size=64m' },
  }
}

async function setupTestEnv(): Promise<TestApp> {
  const ctx = await createTestApp({
    env: {
      HUB_CONTAINER_PREFIX: TEST_PREFIX,
      HUB_ENV_ID: TEST_ENV,
      HUB_USERS_NETWORK: 'dshhub-test-wp2-net',
      HUB_USERS_SUBNET: '10.219.13.0/24',
    },
  })
  contexts.push(ctx)
  ctx.driver!.addImage(IMAGE)
  return ctx
}

describe('容器名前缀与环境标签（11 §2）', () => {
  it('容器名 = HUB_CONTAINER_PREFIX + slug，并打上 dshhub.env 标签', async () => {
    const ctx = await setupTestEnv()
    const user = await createUser(ctx.app)
    const instances = ctx.app.deps.services.instances as InternalInstanceService
    await instances.provision(user.id)
    const summary = await instances.ensureRunning(user.id)
    expect(summary.status).toBe('running')

    const name = `${TEST_PREFIX}${user.slug}`
    expect(ctx.driver!.getContainerNames()).toEqual([name])
    const info = await ctx.driver!.inspect(name)
    expect(info?.labels[LABEL_ENV]).toBe(TEST_ENV)
    expect(info?.labels[CONTAINER_LABEL_MANAGED]).toBe('1')
    // 驱动的视野也被限制在本环境
    expect(ctx.driver!.envId).toBe(TEST_ENV)
    expect((await ctx.driver!.listManaged()).map((c) => c.name)).toEqual([name])
  })

  it('belongsToEnv：没有 env 标签的旧容器算生产（升级期兼容）', () => {
    expect(belongsToEnv({}, 'prod')).toBe(true)
    expect(belongsToEnv({}, TEST_ENV)).toBe(false)
    expect(belongsToEnv({ [LABEL_ENV]: TEST_ENV }, TEST_ENV)).toBe(true)
    expect(belongsToEnv({ [LABEL_ENV]: 'prod' }, TEST_ENV)).toBe(false)
  })
})

describe('别的环境的容器不会被触碰', () => {
  it('对账 / 空闲回收 / instance:stop-all 都只处理本环境', async () => {
    const ctx = await setupTestEnv()
    const driver = ctx.driver!
    const instances = ctx.app.deps.services.instances as InternalInstanceService

    // ① 一个「生产」容器：名字与标签都不是本环境
    const foreign = foreignSpec('dshhub-uforeign', 'prod')
    await driver.create(foreign)
    await driver.start(foreign.name)
    driver.setStats({ cpuPercent: 0, memoryBytes: 1, memoryLimitBytes: 2, pids: 1 })

    // ② 本环境的一个实例（配额设成 1 分钟空闲就回收）
    const user = await createUser(ctx.app, {
      quotaJson: JSON.stringify({ ...DEFAULT_QUOTA_VALUE, idleStopMinutes: 1 }),
    })
    await instances.provision(user.id)
    await instances.ensureRunning(user.id)

    // 驱动只看得到本环境的容器
    expect((await driver.listManaged()).map((c) => c.name)).toEqual([`${TEST_PREFIX}${user.slug}`])

    // 对账不会把别人的容器算进来、也不会改动它
    await instances.reconcileAll()
    expect((await driver.inspect(foreign.name))?.state).toBe('running')

    // 空闲回收只停本环境的实例，别的环境照跑
    // （CPU 判据要采满 CPU_SAMPLE_SIZE 个样本 ≈ 5 分钟才生效，WP15 ②）
    ctx.clock.advance(2 * 60_000)
    let stopped = 0
    for (let i = 0; i < CPU_SAMPLE_SIZE; i += 1) stopped += await instances.reapIdle()
    expect(stopped).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
    expect((await driver.inspect(foreign.name))?.state).toBe('running')

    // cli instance:stop-all 同样只碰本环境
    const result = await runStopAll({ config: ctx.config, driver, log: () => {} })
    expect(result.total).toBe(1)
    expect(result.alreadyStopped).toEqual([`${TEST_PREFIX}${user.slug}`])
    expect((await driver.inspect(foreign.name))?.state).toBe('running')
  })

  it('默认 envId=prod 时，没有 dshhub.env 标签的旧容器仍被 stop-all 管理', async () => {
    const ctx = await createTestApp()
    contexts.push(ctx)
    const driver = ctx.driver!
    // 旧版本 Hub 建的容器：只有 managed 标签
    await driver.create({
      ...foreignSpec('dshhub-uold0001', 'prod'),
      labels: { [CONTAINER_LABEL_MANAGED]: '1' },
    })
    await driver.start('dshhub-uold0001')

    const result = await runStopAll({ config: ctx.config, driver, log: () => {} })
    expect(result.total).toBe(1)
    expect(result.stopped).toEqual(['dshhub-uold0001'])
    expect((await driver.inspect('dshhub-uold0001'))?.state).toBe('exited')
  })
})
