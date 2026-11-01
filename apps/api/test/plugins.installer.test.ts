import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createUser, type TestUser } from './helpers.js'
import {
  cleanupDirs,
  createWp3App,
  readProfile,
  seedPlugin,
  startInstance,
  writeProfile,
  type Wp3TestApp,
} from './helpers-wp3.js'
import { FakeDriver } from '../src/modules/instances/fake-driver.js'

/**
 * 单用户插件安装执行器（06 §2.4）：成功、官方命令失败 → 还原 + 重装、
 * 重启后就绪失败 → 回滚并抛错、required 对账、bootstrap。
 */

let ctx: Wp3TestApp
let app: FastifyInstance
let user: TestUser
const tempDirs: string[] = []

beforeEach(async () => {
  ctx = await createWp3App()
  app = ctx.app
  user = await createUser(app, { username: 'installer' })
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs(tempDirs)
})

function plugins() {
  return app.deps.services.plugins
}

function profileOf() {
  return app.deps.paths.userProfileDir(user.slug)
}

describe('installForUser', () => {
  it('成功：dsh plugin add → 重排 bundles → 登记 managed → 更新 user_plugins', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0', bundleOrder: 5 })
    writeProfile(app, user.slug, {
      extra: { keepMe: true },
      dependencies: { 'user-own': '1.2.3' },
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'user-own'],
    })
    // 模拟官方命令的行为：把依赖与 bundle 追加到末尾
    const commands: string[] = []
    ctx.driver.setExecHandler((_name, cmd) => {
      commands.push(cmd.join(' '))
      if (cmd[0] === 'dsh' && cmd[3] === 'add') {
        const file = `${profileOf()}/package.json`
        const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(json.dependencies as Record<string, string>)['dsh-email'] = '0.16.0'
        ;((json.dsh as { profile: { bundles: string[] } }).profile.bundles as string[]).push('dsh-email')
        writeFileSync(file, JSON.stringify(json, null, 2))
      }
      return { exitCode: 0, output: 'ok' }
    })

    await plugins().installForUser(
      user.id,
      {
        add: [
          {
            id: plugin.versionId,
            version: '0.16.0',
            platform: 'cloud',
            sourceType: 'npm',
            sourceRef: 'dsh-email@0.16.0',
            spec: '0.16.0',
            sha256: null,
            minDsh: null,
            createdAt: app.deps.clock.nowIso(),
          },
        ],
        remove: [],
      },
      { restart: 'next-start' },
    )

    // WP8a e2e 发现：npm 源的 CLI 实参必须是 `包名@版本`（只传版本号会让 pnpm 404）
    expect(commands).toContain('dsh plugin --profile web add dsh-email@0.16.0')
    const profile = readProfile(app, user.slug)
    expect(profile.dependencies).toEqual({ 'user-own': '1.2.3', 'dsh-email': '0.16.0' })
    expect(profile.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-email',
      'user-own',
    ])
    expect(profile.dshHub?.managed).toEqual({ 'dsh-email': '0.16.0' })
    expect(profile.keepMe).toBe(true)

    const rows = await plugins().listUserPluginRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pluginId: plugin.pluginId,
      desired: 'installed',
      actualVersionId: plugin.versionId,
      state: 'synced',
      source: 'admin',
    })
  })

  it('官方命令失败 → 还原 package.json 并再跑一次 pnpm install', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    writeProfile(app, user.slug)
    const before = readProfile(app, user.slug)
    const commands: string[][] = []
    ctx.driver.setExecHandler((_name, cmd) => {
      commands.push(cmd)
      if (cmd[0] === 'dsh') {
        // 模拟 dsh plugin add 失败前的部分写入
        const file = `${profileOf()}/package.json`
        const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(json.dependencies as Record<string, string>)['dsh-email'] = '0.16.0'
        writeFileSync(file, JSON.stringify(json, null, 2))
        return { exitCode: 1, output: 'dsh: plugin command failed' }
      }
      return { exitCode: 0, output: 'ok' }
    })

    await expect(
      plugins().installForUser(
        user.id,
        {
          add: [
            {
              id: plugin.versionId,
              version: '0.16.0',
              platform: 'cloud',
              sourceType: 'npm',
              sourceRef: 'dsh-email@0.16.0',
              spec: '0.16.0',
              sha256: null,
              minDsh: null,
              createdAt: app.deps.clock.nowIso(),
            },
          ],
          remove: [],
        },
        { restart: 'next-start' },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })

    // package.json 已还原
    expect(readProfile(app, user.slug)).toEqual(before)
    // 还原后跑了 pnpm install
    expect(commands.some((cmd) => cmd[0] === 'pnpm' && cmd[1] === 'install')).toBe(true)
    // 备份保留（最近 3 份）
    const backups = readdirSync(profileOf()).filter((name) => name.includes('.hub-bak-'))
    expect(backups.length).toBe(1)
    // user_plugins 里没有成功的记录
    expect(await plugins().listUserPluginRows(user.id)).toHaveLength(0)
  })

  it('实例 running + needs_restart → 重启；就绪失败 → 回滚并抛 INSTANCE_START_FAILED', async () => {
    // 单独建 app：把就绪等待上限调小，避免测试等 90s
    const local = await createWp3App({ env: { HUB_INSTANCE_READY_TIMEOUT_MS: '600' } })
    try {
      const localUser = await createUser(local.app, { username: 'restartfail' })
      const plugin = seedPlugin(local.app, {
        packageName: 'dsh-email',
        version: '0.16.0',
        needsRestart: true,
      })
      writeProfile(local.app, localUser.slug)
      await startInstance(local.app, localUser.id)
      expect(local.app.deps.services.instances.currentStatus(localUser.id)).toBe('running')

      const commands: string[][] = []
      local.driver.setExecHandler((_name, cmd) => {
        commands.push(cmd)
        if (cmd[0] === 'dsh') {
          const file = `${local.app.deps.paths.userProfileDir(localUser.slug)}/package.json`
          const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
          ;(json.dependencies as Record<string, string>)['dsh-email'] = '0.16.0'
          writeFileSync(file, JSON.stringify(json, null, 2))
        }
        return { exitCode: 0, output: 'ok' }
      })

      // 制造「重启后起不来」：restart 之后容器被停掉（就绪判据①不过，等超时）
      const originalRestart = local.driver.restart.bind(local.driver)
      let restarts = 0
      ;(local.driver as unknown as Record<string, unknown>).restart = async (
        name: string,
        timeoutSec: number,
      ): Promise<void> => {
        restarts += 1
        await originalRestart(name, timeoutSec)
        await local.driver.stop(name, 1)
      }

      await expect(
        local.app.deps.services.plugins.installForUser(
          localUser.id,
          {
            add: [
              {
                id: plugin.versionId,
                version: '0.16.0',
                platform: 'cloud',
                sourceType: 'npm',
                sourceRef: 'dsh-email@0.16.0',
                spec: '0.16.0',
                sha256: null,
                minDsh: null,
                createdAt: local.app.deps.clock.nowIso(),
              },
            ],
            remove: [],
          },
          { restart: 'now', onLog: () => undefined },
        ),
      ).rejects.toMatchObject({ code: 'INSTANCE_START_FAILED' })

      // 回滚：还原 profile + 再装一次依赖；重启至少两次（失败 + 回滚重启）
      expect(restarts).toBeGreaterThanOrEqual(2)
      expect(commands.filter((cmd) => cmd[0] === 'pnpm').length).toBeGreaterThanOrEqual(1)
      expect(readProfile(local.app, localUser.slug).dependencies?.['dsh-email']).toBeUndefined()
    } finally {
      await local.close()
    }
  }, 30_000)

  // WP8b B1：用户从未启动过实例（`ensureNetwork` 只在第一次 start 时调用），
  // 插件下发走的是 `runOnce` 一次性容器 —— 驱动必须先建用户网络，否则真机上直接 404
  // `failed to set up container networking: network dshhub-users not found`。
  it('B1：从未启动过实例的用户 → runOnce 前先建用户网络', async () => {
    const plugin = seedPlugin(app, { packageName: 'net-plugin', version: '1.0.0' })
    writeProfile(app, user.slug)
    ctx.driver.setExecHandler((_name, cmd) => {
      if (cmd[0] === 'dsh') {
        const file = `${profileOf()}/package.json`
        const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(json.dependencies as Record<string, string>)['net-plugin'] = '1.0.0'
        writeFileSync(file, JSON.stringify(json, null, 2))
      }
      return { exitCode: 0, output: 'ok' }
    })

    expect(await app.deps.services.instances.currentStatus(user.id)).toBe('absent')
    expect(ctx.driver.getNetwork()).toBeNull()

    await plugins().installForUser(
      user.id,
      {
        add: [
          {
            id: plugin.versionId,
            version: '1.0.0',
            platform: 'cloud',
            sourceType: 'npm',
            sourceRef: 'net-plugin@1.0.0',
            spec: '1.0.0',
            sha256: null,
            minDsh: null,
            createdAt: app.deps.clock.nowIso(),
          },
        ],
        remove: [],
      },
      { restart: 'next-start' },
    )

    expect(ctx.driver.getNetwork()).toEqual({
      name: app.deps.config.usersNetwork,
      subnet: app.deps.config.usersSubnet,
    })
  })

  // 热修回归：目录不存在时 Docker 会以 root 建 bind mount 目录，容器里的 uid 1000 随后
  // 写 /home/dsh/.dsh 报 Permission denied。一次性容器之前必须由 Hub 进程自己建好四个目录。
  it('用户目录不存在时，一次性容器启动前由 Hub 建好四个目录（0o700）', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    const paths = app.deps.paths
    const dirs = [
      paths.userDir(user.slug),
      paths.userHome(user.slug),
      paths.userWorkspace(user.slug),
      paths.userManaged(user.slug),
    ]
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
    expect(app.deps.services.instances.currentStatus(user.id)).toBe('absent')

    const snapshots: boolean[][] = []
    ctx.driver.setExecHandler((_name, cmd) => {
      snapshots.push(dirs.map((dir) => existsSync(dir)))
      if (cmd.join(' ') === 'dsh --profile web --help') writeProfile(app, user.slug)
      return { exitCode: 0, output: 'ok' }
    })

    await plugins().installForUser(
      user.id,
      {
        add: [
          {
            id: plugin.versionId,
            version: '0.16.0',
            platform: 'cloud',
            sourceType: 'npm',
            sourceRef: 'dsh-email@0.16.0',
            spec: '0.16.0',
            sha256: null,
            minDsh: null,
            createdAt: app.deps.clock.nowIso(),
          },
        ],
        remove: [],
      },
      { restart: 'next-start' },
    )

    // 第一次 runOnce 就是 ensureProfile 的一次性容器：调用时四个目录必须已由 Hub 建好
    expect(snapshots[0]).toEqual([true, true, true, true])
    for (const dir of dirs) expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('profile 不存在时先用一次性容器创建', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    expect(existsSync(`${profileOf()}/package.json`)).toBe(false)
    const commands: string[][] = []
    ctx.driver.setExecHandler((_name, cmd) => {
      commands.push(cmd)
      if (cmd.join(' ') === 'dsh --profile web --help') {
        writeProfile(app, user.slug)
      }
      return { exitCode: 0, output: 'ok' }
    })
    await plugins().installForUser(
      user.id,
      {
        add: [
          {
            id: plugin.versionId,
            version: '0.16.0',
            platform: 'cloud',
            sourceType: 'npm',
            sourceRef: 'dsh-email@0.16.0',
            spec: '0.16.0',
            sha256: null,
            minDsh: null,
            createdAt: app.deps.clock.nowIso(),
          },
        ],
        remove: [],
      },
      { restart: 'next-start' },
    )
    expect(commands[0]?.join(' ')).toBe('dsh --profile web --help')
    expect(existsSync(`${profileOf()}/package.json`)).toBe(true)
  })
})

describe('bootstrapUser / reconcileUser', () => {
  it('bootstrap 安装 required + default，忽略 optional；失败不阻塞（抛错但记录 failed）', async () => {
    const required = seedPlugin(app, { packageName: 'req-a', version: '1.0.0', policy: 'required' })
    const defaulted = seedPlugin(app, { packageName: 'def-b', version: '2.0.0', policy: 'default' })
    seedPlugin(app, { packageName: 'opt-c', version: '3.0.0', policy: 'optional' })
    void defaulted
    writeProfile(app, user.slug)
    ctx.driver.setExecHandler((_name, cmd) => {
      // 只有 `dsh plugin …` 会动 profile；回滚路径里的 `pnpm install` 必须原样放过
      if (cmd[0] !== 'dsh') return { exitCode: 0, output: 'ok' }
      const spec = cmd[cmd.length - 1] ?? ''
      // npm 来源的 CLI 实参是 `包名@版本`（WP8a e2e 发现：只传版本号会让 pnpm 去 registry 找名为 `2.0.0`
      // 的包并 404）；写进 package.json 的值仍是精确版本（06 §2.1）
      const version = spec.slice(spec.lastIndexOf('@') + 1)
      if (version === '2.0.0') return { exitCode: 1, output: 'boom' }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs')
      const file = `${profileOf()}/package.json`
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      ;(json.dependencies as Record<string, string>)[version === '1.0.0' ? 'req-a' : 'def-b'] = version
      fs.writeFileSync(file, JSON.stringify(json, null, 2))
      return { exitCode: 0, output: 'ok' }
    })

    await expect(plugins().bootstrapUser(user.id, { restart: 'next-start' })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    })
    const rows = await plugins().listUserPluginRows(user.id)
    const byId = new Map(rows.map((row) => [row.pluginId, row]))
    expect(byId.size).toBe(2)
    // bootstrap 是**一批**装完（06 §2.5：装完一次重启）；批中任何一个失败都整体回滚，
    // 所以两个插件都记 failed、profile 里不留半个依赖（不是「一成功一失败」的中间态）
    expect(byId.get(required.pluginId)).toMatchObject({
      state: 'failed',
      actualVersionId: null,
      desired: 'installed',
    })
    expect(byId.get(defaulted.pluginId)).toMatchObject({ state: 'failed', actualVersionId: null })
    expect(byId.get(required.pluginId)?.error).toBeTruthy()
    expect(readProfile(app, user.slug).dependencies ?? {}).toEqual({})
  })

  // 06 §2.5（WP2 第二轮之后）：实例服务在启动 DSH 之前调 bootstrap（传 next-start）；
  // 若有人在实例运行时显式要求 restart: 'now'（例如管理员重试），装完重启一次让插件当场生效
  it('实例在跑且显式 restart=now → 装完立刻重启一次（插件当场生效）', async () => {
    const local = await createWp3App({ env: { HUB_INSTANCE_READY_TIMEOUT_MS: '8000' } })
    try {
      const localUser = await createUser(local.app, { username: 'bootrestart' })
      seedPlugin(local.app, { packageName: 'req-a', version: '1.0.0', policy: 'required' })
      writeProfile(local.app, localUser.slug)
      await startInstance(local.app, localUser.id)
      let restarts = 0
      const originalRestart = local.driver.restart.bind(local.driver)
      ;(local.driver as unknown as Record<string, unknown>).restart = async (
        name: string,
        timeoutSec: number,
      ): Promise<void> => {
        restarts += 1
        await originalRestart(name, timeoutSec)
      }
      local.driver.setExecHandler((_name, cmd) => {
        if (cmd[0] === 'dsh' && cmd[4] === 'add') {
          const file = `${local.app.deps.paths.userProfileDir(localUser.slug)}/package.json`
          const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
          ;(json.dependencies as Record<string, string>)['req-a'] = '1.0.0'
          writeFileSync(file, JSON.stringify(json, null, 2))
        }
        return { exitCode: 0, output: 'ok' }
      })
      await local.app.deps.services.plugins.bootstrapUser(localUser.id, { restart: 'now' })
      expect(restarts).toBe(1)
      expect(readProfile(local.app, localUser.slug).dependencies?.['req-a']).toBe('1.0.0')
    } finally {
      await local.close()
    }
  }, 30_000)

  it('reconcile 只补 required；已同步时不动', async () => {
    const required = seedPlugin(app, { packageName: 'req-a', version: '1.0.0', policy: 'required' })
    writeProfile(app, user.slug, {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-base'],
    })
    ctx.driver.setExecHandler((_name, cmd) => {
      if (cmd[0] === 'dsh') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs')
        const file = `${profileOf()}/package.json`
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(json.dependencies as Record<string, string>)['req-a'] = '1.0.0'
        fs.writeFileSync(file, JSON.stringify(json, null, 2))
      }
      return { exitCode: 0, output: 'ok' }
    })
    const first = await plugins().reconcileUser(user.id)
    expect(first.changed).toBe(1)
    const second = await plugins().reconcileUser(user.id)
    expect(second.changed).toBe(0)
    expect(
      (await plugins().listUserPluginRows(user.id)).find((row) => row.pluginId === required.pluginId),
    ).toMatchObject({ state: 'synced', actualVersionId: required.versionId })
  })

  it('required 插件被用户删掉后，下次对账装回来（D5）', async () => {
    seedPlugin(app, { packageName: 'req-a', version: '1.0.0', policy: 'required' })
    writeProfile(app, user.slug)
    ctx.driver.setExecHandler((_name, cmd) => {
      if (cmd[0] === 'dsh') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs')
        const file = `${profileOf()}/package.json`
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(json.dependencies as Record<string, string>)['req-a'] = '1.0.0'
        fs.writeFileSync(file, JSON.stringify(json, null, 2))
      }
      return { exitCode: 0, output: 'ok' }
    })
    await plugins().reconcileUser(user.id)
    expect(readProfile(app, user.slug).dependencies?.['req-a']).toBe('1.0.0')

    // 用户在 DSH 里自己删掉（改 profile）
    writeProfile(app, user.slug, { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
    const again = await plugins().reconcileUser(user.id)
    expect(again.changed).toBe(1)
    expect(readProfile(app, user.slug).dependencies?.['req-a']).toBe('1.0.0')
  })
})

describe('FakeDriver 可用性自检', () => {
  it('listManaged 能列出实例容器（其他用例依赖它）', async () => {
    await startInstance(app, user.id)
    const containers = await ctx.driver.listManaged()
    expect(containers.some((info) => info.labels['dshhub.slug'] === user.slug)).toBe(true)
    void FakeDriver
    void tempDirs
  })
})
