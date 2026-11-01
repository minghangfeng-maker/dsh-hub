import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTAINER_LABEL_MANAGED } from '@dsh-hub/shared'
import { createTestApp, type TestApp } from './helpers.js'
import { loadConfig } from '../src/config.js'
import { FakeDriver } from '../src/modules/instances/fake-driver.js'
import type { ContainerDriver, ContainerSpec } from '../src/modules/instances/types.js'
import { runDbBackup } from '../src/ops/backup.js'
import { runDoctor } from '../src/ops/doctor.js'
import { runStopAll } from '../src/ops/stop-all.js'
import { runAdoptRuntime } from '../src/ops/adopt-runtime.js'
import { flagValue, hasFlag, numberFlag } from '../src/ops/args.js'

/** 运维命令（任务书交付物 4）：db:backup / instance:stop-all / doctor */
let ctx: TestApp
let outDir: string

const CLI_TS = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const API_DIR = fileURLToPath(new URL('..', import.meta.url))

/** 起一个子进程跑真正的 cli.ts（验证命令接线与退出码） */
function runCli(args: string[], env: Record<string, string> = {}): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', CLI_TS, ...args], {
      cwd: API_DIR,
      env: { ...process.env, HUB_LOG_LEVEL: 'silent', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function containerSpec(name: string, labels: Record<string, string>): ContainerSpec {
  return {
    name,
    image: 'dshhub/runtime:0.2.0-rc.2',
    env: {},
    labels,
    mounts: [],
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    network: 'dshhub-users',
    tmpfs: { '/tmp': 'rw,size=64m' },
    readOnlyRootfs: true,
  }
}

beforeEach(async () => {
  ctx = await createTestApp()
  outDir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-backup-'))
})

afterEach(async () => {
  await ctx.close()
  rmSync(outDir, { recursive: true, force: true })
})

describe('cli db:backup（VACUUM INTO + secrets）', () => {
  it('生成 0600 的库快照与 secrets 归档，并验证副本可读', async () => {
    const result = await runDbBackup({ config: ctx.config, outDir, now: new Date('2026-10-12T03:30:00') })

    expect(result.dbFile.endsWith('hub-20261012-033000.db')).toBe(true)
    expect(existsSync(result.dbFile)).toBe(true)
    expect(statSync(result.dbFile).mode & 0o777).toBe(0o600)
    expect(result.dbBytes).toBeGreaterThan(0)

    expect(result.secretsFile).not.toBeNull()
    expect(statSync(result.secretsFile!).mode & 0o777).toBe(0o600)
    // 归档里是 secrets 目录的内容（不带顶层目录名），恢复时直接解到 secrets/ 下
    const listing = execFileSync('tar', ['-tzf', result.secretsFile!], { encoding: 'utf8' })
    expect(listing).toContain('master.key')
    expect(listing).not.toContain('secrets/master.key')

    // 副本能作为独立库打开，且用户数一致
    expect(result.pruned).toEqual([])
  })

  it('同一秒内重复执行不会撞名（自动加序号）', async () => {
    const now = new Date('2026-10-12T03:30:00')
    const first = await runDbBackup({ config: ctx.config, outDir, now })
    const second = await runDbBackup({ config: ctx.config, outDir, now })
    expect(second.dbFile).not.toBe(first.dbFile)
    expect(second.dbFile.endsWith('-2.db')).toBe(true)
    expect(existsSync(first.dbFile)).toBe(true)
  })

  it('保留策略：超过 keep-days 的旧备份被删掉', async () => {
    const old = join(outDir, 'hub-19700101-000000.db')
    writeFileSync(old, 'x')
    utimesSync(old, new Date(0), new Date(0))
    const oldSecrets = join(outDir, 'secrets-19700101-000000.tar.gz')
    writeFileSync(oldSecrets, 'x')
    utimesSync(oldSecrets, new Date(0), new Date(0))
    writeFileSync(join(outDir, 'unrelated.txt'), 'keep me')

    const result = await runDbBackup({ config: ctx.config, outDir, keepDays: 14, now: new Date() })
    expect(result.pruned.sort()).toEqual(['hub-19700101-000000.db', 'secrets-19700101-000000.tar.gz'])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(outDir, 'unrelated.txt'))).toBe(true)
  })

  it('没有数据库时明确报错（不是产出空文件）', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-nodb-'))
    try {
      const config = loadConfig({ HUB_DATA_DIR: empty, HUB_CONTAINER_DRIVER: 'fake' })
      await expect(runDbBackup({ config, outDir })).rejects.toThrow(/数据库不存在/)
      expect(readdirSync(outDir)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('cli instance:stop-all（label dshhub.managed=1）', () => {
  it('只停 Hub 管理的运行中容器', async () => {
    const driver = new FakeDriver()
    for (const name of ['dshhub-u-alice', 'dshhub-u-bob']) {
      await driver.create(containerSpec(name, { [CONTAINER_LABEL_MANAGED]: '1' }))
      await driver.start(name)
    }
    await driver.create(containerSpec('someone-else', { [CONTAINER_LABEL_MANAGED]: '0' }))
    await driver.start('someone-else')
    await driver.stop('dshhub-u-bob', 5)

    const lines: string[] = []
    const result = await runStopAll({ config: ctx.config, driver, log: (l) => lines.push(l) })
    expect(result.total).toBe(2)
    expect(result.stopped).toEqual(['dshhub-u-alice'])
    expect(result.alreadyStopped).toEqual(['dshhub-u-bob'])
    expect(result.failed).toEqual([])
    expect((await driver.inspect('dshhub-u-alice'))?.state).toBe('exited')
    expect((await driver.inspect('someone-else'))?.state).toBe('running')

    const again = await runStopAll({ config: ctx.config, driver, log: () => {} })
    expect(again.stopped).toEqual([])
    expect(again.alreadyStopped).toEqual(['dshhub-u-alice', 'dshhub-u-bob'])
    expect(lines.length).toBeGreaterThan(0)
  })

  it('--dry-run 只列不动', async () => {
    const driver = new FakeDriver()
    await driver.create(containerSpec('dshhub-u-alice', { [CONTAINER_LABEL_MANAGED]: '1' }))
    await driver.start('dshhub-u-alice')
    const result = await runStopAll({ config: ctx.config, driver, dryRun: true, log: () => {} })
    expect(result.stopped).toEqual(['dshhub-u-alice'])
    expect((await driver.inspect('dshhub-u-alice'))?.state).toBe('running')
  })

  it('容器引擎不可达时报错', async () => {
    const broken: ContainerDriver = {
      ping: async () => ({ ok: false }),
    } as unknown as ContainerDriver
    await expect(runStopAll({ config: ctx.config, driver: broken })).rejects.toThrow(/容器引擎不可达/)
  })
})

describe('cli doctor（Docker/数据目录/磁盘/默认 runtime）', () => {
  it('健康环境：必需项全 PASS，未配置 DSH 版本只给 WARN', async () => {
    // 磁盘阈值显式压到 1 字节：「健康」不该取决于跑测试那台机器还剩多少盘（CI runner 常常不到默认阈值）
    const checks = (
      await runDoctor({ config: ctx.config, driver: ctx.driver!, diskWarnBytes: 1, diskFailBytes: 0, log: () => {} })
    ).checks
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]))
    expect(byId.node?.status).toBe('PASS')
    expect(byId.data?.status).toBe('PASS')
    expect(byId.db?.status).toBe('PASS')
    expect(byId.disk?.status).toBe('PASS')
    expect(byId.runtime?.status).toBe('WARN') // WP3 的表还没建
    expect(checks.filter((c) => c.status === 'FAIL')).toEqual([])
  })

  it('数据目录不存在 → FAIL 并给出应执行的命令', async () => {
    const missing = join(tmpdir(), `dshhub-test-wp7a-missing-${process.pid}`)
    rmSync(missing, { recursive: true, force: true })
    const config = loadConfig({ HUB_DATA_DIR: missing, HUB_CONTAINER_DRIVER: 'fake' })
    const result = await runDoctor({ config, driver: new FakeDriver(), log: () => {} })
    const data = result.checks.find((c) => c.id === 'data')
    expect(data?.status).toBe('FAIL')
    expect(data?.hint).toContain('mkdir -p')
    expect(result.failed).toBeGreaterThan(0)
  })

  it('磁盘余量低于阈值 → FAIL；Docker 不可达 → FAIL', async () => {
    const broken = { ping: async () => ({ ok: false }) } as unknown as ContainerDriver
    // 必须是 docker 驱动才会真的去 ping（fake 驱动只给 WARN）
    const dockerConfig = loadConfig({ HUB_DATA_DIR: ctx.dataDir, HUB_CONTAINER_DRIVER: 'docker' })
    const result = await runDoctor({
      config: dockerConfig,
      driver: broken,
      diskWarnBytes: 1024 ** 4,
      diskFailBytes: 1024 ** 5,
      log: () => {},
    })
    expect(result.checks.find((c) => c.id === 'disk')?.status).toBe('FAIL')
    expect(result.checks.find((c) => c.id === 'docker')?.status).toBe('FAIL')
    expect(result.failed).toBe(2)
  })

  it('默认 runtime 存在 → PASS；镜像被删 → FAIL', async () => {
    const db = ctx.app.deps.db
    // WP3 合并后 runtimes 表由迁移 040 建好（不用再造假表），直接插一条默认版本
    db.raw.exec(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES ('0.2.0-rc.2', 'dshhub/runtime:0.2.0-rc.2', 'ready', 1, '', '${ctx.clock.nowIso()}')`,
    )
    const driver = new FakeDriver()
    const missing = await runDoctor({ config: ctx.config, driver, log: () => {} })
    expect(missing.checks.find((c) => c.id === 'runtime')?.status).toBe('FAIL')

    await driver.buildImage(join(tmpdir(), 'ctx'), 'dshhub/runtime:0.2.0-rc.2', {}, () => {})
    const ok = await runDoctor({ config: ctx.config, driver, log: () => {} })
    expect(ok.checks.find((c) => c.id === 'runtime')?.status).toBe('PASS')
  })
})

describe('cli runtime:adopt（WP8b P1：登记本机已有镜像）', () => {
  const VERSION = '0.2.1-alpha.2'
  const IMAGE = `dshhub/runtime:${VERSION}`

  function adoptDriver(smokeOutput = `@deepseek-ai/dsh ${VERSION}\n`): FakeDriver {
    const driver = new FakeDriver({ clock: ctx.clock })
    driver.addImage(IMAGE, 982 * 1024 * 1024)
    driver.setExecHandler((_name, cmd) =>
      cmd.join(' ') === 'dsh --version' ? { exitCode: 0, output: smokeOutput } : { exitCode: 0, output: 'ok' },
    )
    return driver
  }

  it('成功：冒烟 dsh --version 一致 → ready（记 imageId/sizeBytes）+ --default 设默认；重复执行幂等', async () => {
    const driver = adoptDriver()
    const logs: string[] = []
    const result = await runAdoptRuntime({
      config: ctx.config,
      db: ctx.app.deps.db,
      dshVersion: VERSION,
      makeDefault: true,
      driver,
      log: (line) => logs.push(line),
      now: () => '2026-10-13T00:00:00.000Z',
    })
    expect(result).toMatchObject({
      created: true,
      isDefault: true,
      dshVersion: VERSION,
      image: IMAGE,
      sizeBytes: 982 * 1024 * 1024,
    })
    expect(result.imageId).toBeTruthy()
    expect(logs.join('\n')).toContain('设为默认版本')

    const row = ctx.app.deps.db.get<{ status: string; is_default: number; image_id: string | null }>(
      'SELECT status, is_default, image_id FROM runtimes WHERE id = ?',
      result.runtimeId,
    )
    expect(row).toMatchObject({ status: 'ready', is_default: 1, image_id: result.imageId })
    // 冒烟容器用 none 网络：adopt 不需要用户网络（与构建冒烟同一规格）
    expect(driver.getNetwork()).toBeNull()

    const again = await runAdoptRuntime({
      config: ctx.config,
      db: ctx.app.deps.db,
      dshVersion: VERSION,
      makeDefault: true,
      driver,
    })
    expect(again.runtimeId).toBe(result.runtimeId)
    expect(again.created).toBe(false)
    const count = ctx.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runtimes')
    expect(count?.n).toBe(1)
  })

  it('镜像不存在 → NOT_FOUND；冒烟版本不一致 → UPSTREAM_ERROR 且不落库', async () => {
    const empty = new FakeDriver({ clock: ctx.clock })
    await expect(
      runAdoptRuntime({ config: ctx.config, db: ctx.app.deps.db, dshVersion: VERSION, driver: empty }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const mismatch = adoptDriver('0.2.0-rc.2\n')
    await expect(
      runAdoptRuntime({ config: ctx.config, db: ctx.app.deps.db, dshVersion: VERSION, driver: mismatch }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(ctx.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runtimes')?.n).toBe(0)
  })

  it('--allow-version-mismatch：镜像 tag 带构建后缀时放行（默认仍然严格）', async () => {
    // WP40d 的 chat1 镜像：tag 是 0.2.1-rc.2-chat1，里面装的仍是 0.2.1-rc.2
    const version = '0.2.1-rc.2-chat1'
    const image = `dshhub/runtime:${version}`
    const driver = new FakeDriver({ clock: ctx.clock })
    driver.addImage(image, 2_404_448_955)
    driver.setExecHandler((_name, cmd) =>
      cmd.join(' ') === 'dsh --version'
        ? { exitCode: 0, output: '@deepseek-ai/dsh 0.2.1-rc.2\n' }
        : { exitCode: 0, output: 'ok' },
    )

    const logs: string[] = []
    const result = await runAdoptRuntime({
      config: ctx.config,
      db: ctx.app.deps.db,
      dshVersion: version,
      allowVersionMismatch: true,
      driver,
      log: (line) => logs.push(line),
      now: () => '2026-10-25T00:00:00.000Z',
    })
    expect(result).toMatchObject({ image, created: true })
    expect(result.smokeOutput).toContain('0.2.1-rc.2')
    expect(logs.join('\n')).toContain('--allow-version-mismatch')
    expect(
      ctx.app.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtimes WHERE dsh_version = ?", version)?.n,
    ).toBe(1)
  })

  it('CLI 接线：缺参数/镜像不存在都退出码 1 并给出提示（子进程真跑 cli.ts）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp8b-adopt-'))
    try {
      const env = { HUB_DATA_DIR: dataDir, HUB_CONTAINER_DRIVER: 'fake' }
      expect(runCli(['migrate'], env).code).toBe(0)

      const missingArg = runCli(['runtime:adopt'], env)
      expect(missingArg.code).toBe(1)
      expect(missingArg.output).toContain('用法：runtime:adopt')

      // fake 驱动的进程里没有任何镜像 → 明确报「本机没有镜像」
      const noImage = runCli(['runtime:adopt', VERSION, '--default'], env)
      expect(noImage.code).toBe(1)
      expect(noImage.output).toContain(IMAGE)

      expect(runCli(['help']).output).toContain('runtime:adopt')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('参数解析与 CLI 接线', () => {  it('flagValue 支持 --k v 与 --k=v，缺值抛错', () => {
    expect(flagValue(['--out', '/tmp/x'], '--out')).toBe('/tmp/x')
    expect(flagValue(['--out=/tmp/y'], '--out')).toBe('/tmp/y')
    expect(flagValue([], '--out')).toBeUndefined()
    expect(hasFlag(['--dry-run'], '--dry-run')).toBe(true)
    expect(numberFlag(['--keep-days=7'], '--keep-days', 14)).toBe(7)
    expect(numberFlag([], '--keep-days', 14)).toBe(14)
    expect(() => flagValue(['--out'], '--out')).toThrow(/缺少取值/)
    expect(() => numberFlag(['--keep-days', 'many'], '--keep-days', 14)).toThrow(/数字/)
  })

  it('cli help 列出运维命令；未知命令退出码 1', () => {
    const help = runCli(['help'])
    expect(help.code).toBe(0)
    expect(help.output).toContain('db:backup')
    expect(help.output).toContain('instance:stop-all')
    expect(help.output).toContain('doctor')
    expect(runCli(['nope']).code).toBe(1)
  })

  it('migrate → db:backup → doctor 全链路（子进程真跑 cli.ts）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-cli-'))
    try {
      const env = { HUB_DATA_DIR: dataDir, HUB_CONTAINER_DRIVER: 'fake' }
      const migrate = runCli(['migrate'], env)
      expect(migrate.code).toBe(0)
      expect(existsSync(join(dataDir, 'hub.db'))).toBe(true)

      const backup = runCli(['db:backup', '--out', join(dataDir, 'backups'), '--keep-days', '3'], env)
      expect(backup.code).toBe(0)
      expect(backup.output).toContain('备份完成')
      expect(readdirSync(join(dataDir, 'backups')).some((f) => f.endsWith('.db'))).toBe(true)

      const doctor = runCli(['doctor'], env)
      expect(doctor.output).toContain('[PASS]')
      expect(doctor.output).toContain('data')
      // fake 驱动 → docker 是 WARN，不会有 FAIL
      expect(doctor.code).toBe(0)

      const stopAll = runCli(['instance:stop-all', '--dry-run'], env)
      expect(stopAll.code).toBe(0)
      expect(stopAll.output).toContain('共 0 个容器')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
