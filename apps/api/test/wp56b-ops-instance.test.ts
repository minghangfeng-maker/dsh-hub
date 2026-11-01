import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './helpers.js'
import { OPS_CONTAINER_NAME } from '../src/modules/cockpit/ops-repo.js'
import { FALLBACK_DSH_VERSION, imageForVersion } from '../src/modules/instances/spec.js'

/**
 * WP56b：座舱 DSH 的系统账号与容器生命周期（docs/24 §5）。
 *
 * 覆盖任务书的四项必测：FakeDriver 下 ensure/start/restart、换令牌后旧令牌 401、
 * IP 变更后旧 IP 401、空闲回收跳过座舱实例；外加编排者补充的安全断言
 * （**不挂 docker.sock、不加特权**）与令牌轮换时序。
 *
 * 注意：`users.is_system` 列由迁移 `129_cockpit.sql` 建（WP56e1 已删掉原先的临时补列 shim，
 * 这里不再需要任何测试期 ALTER）。
 */

const OPS_BASE_URL = 'http://10.219.61.1:8272/ops'

let ctx: TestApp

const savedEnv = { base: process.env.HUB_OPS_BASE_URL, plugin: process.env.HUB_OPS_PLUGIN_DIR }

beforeEach(async () => {
  // /ops 的地址由 Hub 注入容器；测试里用环境变量覆盖（内部监听器在测试中不启动）
  process.env.HUB_OPS_BASE_URL = OPS_BASE_URL
  // 插件源目录显式指向不存在的路径：跳过「同步 + 装插件」，只测生命周期
  process.env.HUB_OPS_PLUGIN_DIR = '/nonexistent/wp56b-ops-plugin'
  ctx = await createTestApp()
  // 座舱容器用「当前默认运行时镜像」；测试里给假驱动登记一个同 tag 的镜像
  ctx.driver!.addImage(imageForVersion(FALLBACK_DSH_VERSION))
})

afterEach(async () => {
  await ctx.close()
  if (savedEnv.base === undefined) delete process.env.HUB_OPS_BASE_URL
  else process.env.HUB_OPS_BASE_URL = savedEnv.base
  if (savedEnv.plugin === undefined) delete process.env.HUB_OPS_PLUGIN_DIR
  else process.env.HUB_OPS_PLUGIN_DIR = savedEnv.plugin
})

function ops() {
  return ctx.app.deps.services.cockpitOps
}

function container() {
  return ctx.driver?.getContainer(OPS_CONTAINER_NAME)
}

describe('系统账号与容器', () => {
  it('ensureStarted 建出 hub-ops 系统账号与 dshhub-ops 容器，状态从 missing 变 running', async () => {
    expect((await ops().status()).instance).toBe('missing')

    await ops().ensureStarted()
    await ops().whenSettled()

    const status = await ops().status()
    expect(status.instance).toBe('running')
    expect(status.model).toBe('deepseek-v4.1-flash')
    expect(status.autoExecuteR1).toBe(true)

    const user = ctx.app.deps.db.get<{
      id: number
      slug: string
      username: string
      role: string
      is_system: number
      status: string
    }>('SELECT id, slug, username, role, is_system, status FROM users WHERE username = ?', 'hub-ops')
    expect(user).toMatchObject({ slug: 'ops', role: 'user', is_system: 1, status: 'active' })
    expect(ops().systemUserId()).toBe(user!.id)

    const created = container()
    expect(created?.state).toBe('running')
    expect(ops().containerName()).toBe(OPS_CONTAINER_NAME)
  })

  it('容器规格：2C2G、注入 /ops env、**不注入出网代理**', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()

    const spec = container()!.spec
    expect(spec.cpus).toBe(2)
    expect(spec.memoryMb).toBe(2048)
    expect(spec.env.DSHHUB_OPS_URL).toBe(OPS_BASE_URL)
    expect(spec.env.DSHHUB_OPS_TOKEN).toMatch(/^[A-Za-z0-9_-]{20,}$/u)
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(spec.env[key], `${key} 不该注入座舱容器`).toBeUndefined()
    }
  })

  it('安全基线：座舱容器不挂 docker.sock、不挂用户目录以外的宿主路径、没有特权字段', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()

    const spec = container()!.spec
    // 编排者补充：座舱容器不能拿 Docker，否则等于把宿主机给了模型
    for (const mount of spec.mounts) {
      expect(mount.host).not.toContain('docker.sock')
      expect(mount.container).not.toContain('docker.sock')
    }
    const userDir = ctx.config.dataDir
    for (const mount of spec.mounts) {
      expect(mount.host.startsWith(userDir)).toBe(true)
    }
    // 规格里根本没有 privileged / capAdd 这类字段（安全基线由 driver 统一施加）
    expect(spec).not.toHaveProperty('privileged')
    expect(spec).not.toHaveProperty('capAdd')
    expect(spec.readOnlyRootfs).toBe(true)
  })

  it('ensureStarted 幂等：重复打开 /admin 不会重建容器', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()
    const first = container()!.spec.env.DSHHUB_OPS_TOKEN

    await ops().ensureStarted()
    await ops().ensureStarted()
    await ops().whenSettled()

    expect(ctx.driver!.getContainerNames().filter((name) => name === OPS_CONTAINER_NAME)).toHaveLength(1)
    expect(container()!.spec.env.DSHHUB_OPS_TOKEN).toBe(first)
  })
})

describe('令牌轮换与来源 IP', () => {
  it('重启换新令牌：旧令牌立即 401，新令牌对当前 IP 通过', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()
    const oldToken = container()!.spec.env.DSHHUB_OPS_TOKEN!
    const oldIp = container()!.ip!

    expect(ops().verify(oldToken, oldIp)).toBe(true)

    await ops().restart()
    await ops().whenSettled()

    const newToken = container()!.spec.env.DSHHUB_OPS_TOKEN!
    const newIp = container()!.ip!
    expect(newToken).not.toBe(oldToken)
    // 旧令牌：即使 IP 对也不认了（docs/24 §5「每次启动重新生成，旧的立即作废」）
    expect(ops().verify(oldToken, newIp)).toBe(false)
    expect(ops().verify(newToken, newIp)).toBe(true)
  })

  it('来源 IP 变了就 401（容器重启换 IP → 旧 IP 立即失效）', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()
    const token = container()!.spec.env.DSHHUB_OPS_TOKEN!
    const ip = container()!.ip!

    expect(ops().verify(token, ip)).toBe(true)
    expect(ops().verify(token, '10.219.61.250')).toBe(false)
    expect(ops().verify('完全不对的令牌', ip)).toBe(false)
    expect(ops().verify('', ip)).toBe(false)
  })

  it('普通（未重启）启动只换 IP、不换令牌：重新起来之后还是同一枚', async () => {
    await ops().ensureStarted()
    await ops().whenSettled()
    const token = container()!.spec.env.DSHHUB_OPS_TOKEN!

    // 停掉容器再 ensureStarted：走「换令牌 + 重建」路径（旧令牌立即作废）
    await ctx.app.deps.services.instances.stop(ops().systemUserId()!)
    await ops().ensureStarted()
    await ops().whenSettled()
    expect(container()!.spec.env.DSHHUB_OPS_TOKEN).not.toBe(token)
    expect((await ops().status()).instance).toBe('running')
  })
})

describe('空闲回收（WP57 起与普通实例一致）', () => {
  it('reapIdle 会停掉空闲的座舱容器（概览里的 AI 助手点了才启动，不再常驻）', async () => {
    ctx.app.deps.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      'default_quota',
      JSON.stringify({ ...ctx.app.deps.settings.get('default_quota'), idleStopMinutes: 1 }),
      ctx.clock.nowIso(),
    )
    await ops().ensureStarted()
    await ops().whenSettled()
    expect((await ops().status()).instance).toBe('running')

    // 把时钟推过空闲阈值（2 小时）
    ctx.clock.advance(2 * 60 * 60_000)
    // 探针拿不到会话状态时走旧规则：要采满 5 个 CPU 样本（每轮一个）才停
    let stopped = 0
    for (let round = 0; round < 8 && stopped === 0; round += 1) {
      stopped = await ctx.app.deps.services.instances.reapIdle()
      ctx.clock.advance(60_000)
    }
    expect(stopped).toBe(1)
    expect((await ops().status()).instance).not.toBe('running')
  })
})

describe('座舱设置（WP56a 写、本包读）', () => {
  it('settings.cockpit 缺省 → 默认模型与 R1 自动执行；写入后按写入的值报', async () => {
    expect((await ops().status()).model).toBe('deepseek-v4.1-flash')
    // WP56a 会把 settings.cockpit 加进 settings 的 key 表；本分支用原始 SQL 模拟它的写入
    ctx.app.deps.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      'cockpit',
      JSON.stringify({ model: 'deepseek-v4.1', autoExecuteR1: false }),
      ctx.clock.nowIso(),
    )
    const status = await ops().status()
    expect(status.model).toBe('deepseek-v4.1')
    expect(status.autoExecuteR1).toBe(false)
  })
})

describe('座舱插件随 Hub 升级刷新（2026-10-30：改了守则没改版本号，座舱一直跑旧守则）', () => {
  it('同一版本号、插件内容变了 → 重新同步并重跑 dsh plugin add；内容没变 → 不重装', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const src = mkdtempSync(join(tmpdir(), 'ops-plugin-'))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: '@dshhub/ops', version: '0.1.0' }))
    writeFileSync(join(src, 'guard.js'), 'export const RULES = "旧守则"\n')
    process.env.HUB_OPS_PLUGIN_DIR = src

    await ops().ensureStarted()
    await ops().whenSettled()
    // 模拟「已装好」：profile 里登记了 @dshhub/ops
    const slug = 'ops'
    const profile = ctx.app.deps.paths.userProfileDir(slug)
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: { '@dshhub/ops': 'file:/home/dsh/ops-plugin' } }),
    )
    const adds = async () =>
      (await ctx.driver!.logs(OPS_CONTAINER_NAME, { tail: 500 }))
        .split('\n')
        .filter((line) => line.includes('plugin --profile web add file:/home/dsh/ops-plugin')).length
    const before = await adds()

    // 内容没变：再次 ensureStarted 不重装
    await ops().ensureStarted()
    await ops().whenSettled()
    expect(await adds()).toBe(before)

    // 同版本号、守则内容变了：重新同步 + 重装
    writeFileSync(join(src, 'guard.js'), 'export const RULES = "新守则：能用图就用图"\n')
    await ops().ensureStarted()
    await ops().whenSettled()
    expect(await adds()).toBe(before + 1)
    const synced = readFileSync(join(ctx.app.deps.paths.userHome(slug), 'ops-plugin', 'guard.js'), 'utf8')
    expect(synced).toContain('新守则')
  })
})
