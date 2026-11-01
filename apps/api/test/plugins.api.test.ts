import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import { multipart } from './wp1-helpers.js'
import {
  cleanupDirs,
  createWp3App,
  makePluginTgz,
  makeTempDir,
  readProfile,
  seedPlugin,
  startFakeNpmRegistry,
  waitFor,
  writeProfile,
  type FakeServer,
  type Wp3TestApp,
} from './helpers-wp3.js'

/**
 * plugins 模块的 HTTP 契约（04 §3.2 §4.5）：目录 CRUD、lookup、版本（npm / 上传 / 本地打包）、
 * 密钥扫描拒绝、用户自助安装卸载、管理端用户详情的 plugins 字段。
 */

let ctx: Wp3TestApp
let app: FastifyInstance
let admin: TestUser
let adminSession: TestSession
let user: TestUser
let userSession: TestSession
let registry: FakeServer
const tempDirs: string[] = []

beforeEach(async () => {
  registry = await startFakeNpmRegistry({
    'dsh-email': {
      versions: {
        '0.15.0': { name: 'dsh-email', version: '0.15.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } },
        '0.16.0': { name: 'dsh-email', version: '0.16.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } },
      },
      distTags: { latest: '0.16.0' },
    },
    'sketchy-plugin': {
      versions: {
        '1.0.0': {
          name: 'sketchy-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: 'cordis.patch.yml' } },
          __files: [
            { name: 'package/cordis.patch.yml', content: 'token: "AbCdEf0123456789AbCdEf0123456789"\n' },
          ],
        },
      },
    },
  })
  ctx = await createWp3App({ env: { HUB_NPM_REGISTRY: registry.url } })
  app = ctx.app
  admin = await createUser(app, { username: 'admin1', role: 'admin' })
  adminSession = loginAs(app, admin)
  user = await createUser(app, { username: 'alice' })
  userSession = loginAs(app, user)
})

afterEach(async () => {
  await ctx.close()
  await registry.close()
  cleanupDirs(tempDirs)
})

interface InjectOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

/** 以某个会话注入请求（带 cookie 与 Origin）；`as never` 只是绕开 Fastify 的 inject 重载 */
function injectAs(session: TestSession, opts: InjectOpts) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: { ...session.headers, ...(opts.headers ?? {}) },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  } as never)
}

async function createPlugin(input: Record<string, unknown>): Promise<{ id: number }> {
  const res = await injectAs(adminSession, { method: 'POST', url: '/api/admin/plugins', payload: input })
  expect(res.statusCode, res.body).toBe(201)
  return json<{ id: number }>(res)
}

describe('插件目录 CRUD（04 §4.5）', () => {
  it('创建 → 列表 → 更新 → 删除；configYaml 必须是 patch 条目数组', async () => {
    const created = await createPlugin({
      packageName: 'dsh-email',
      displayName: '邮件',
      description: '收发邮件',
      policy: 'optional',
      isBundle: true,
      bundleOrder: 30,
      configYaml: '- id: email\n  config:\n    from: hub@example.com\n',
    })
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins' })
    expect(list.statusCode).toBe(200)
    const rows = json<{ packageName: string; configYaml: string; stats: unknown }[]>(list)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      packageName: 'dsh-email',
      configYaml: '- id: email\n  config:\n    from: hub@example.com\n',
    })

    // 非数组的 YAML 被拒绝（DSH 对非数组 fatal）
    const bad = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${created.id}`,
      payload: { configYaml: 'id: email\n' },
    })
    expect(bad.statusCode, bad.body).toBe(400)
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('VALIDATION_FAILED')

    const patched = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${created.id}`,
      payload: { policy: 'required', bundleOrder: 5 },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(json<{ policy: string; bundleOrder: number }>(patched)).toMatchObject({
      policy: 'required',
      bundleOrder: 5,
    })

    const removed = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${created.id}`,
    })
    expect(removed.statusCode).toBe(204)
  })

  it('重名插件 → 409；非管理员 → 403', async () => {
    await createPlugin({ packageName: 'dsh-email', displayName: '邮件', policy: 'optional', isBundle: true })
    const dup = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/plugins',
      payload: { packageName: 'dsh-email', displayName: '重复', policy: 'optional', isBundle: true },
    })
    expect(dup.statusCode).toBe(409)
    const forbidden = await injectAs(userSession, { method: 'GET', url: '/api/admin/plugins' })
    expect(forbidden.statusCode).toBe(403)
  })

  it('lookup：npm 元数据（版本倒序 + dsh.bundle）、本地目录 package.json', async () => {
    const npm = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/plugins/lookup?source=npm&name=dsh-email',
    })
    expect(npm.statusCode, npm.body).toBe(200)
    expect(json(npm)).toMatchObject({
      packageName: 'dsh-email',
      versions: ['0.16.0', '0.15.0'],
      latest: '0.16.0',
      isBundle: true,
    })

    const dir = makeTempDir()
    tempDirs.push(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@local/x',
        version: '2.0.0',
        description: '本地插件',
        dsh: { needsRestart: false },
      }),
    )
    const local = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/plugins/lookup?source=local&path=${encodeURIComponent(dir)}`,
    })
    expect(local.statusCode, local.body).toBe(200)
    expect(json(local)).toMatchObject({
      packageName: '@local/x',
      versions: ['2.0.0'],
      isBundle: false,
      needsRestart: false,
    })
  })
})

describe('插件版本入库', () => {
  it('npm 来源：写精确版本 spec + sha256，并顺手补全描述/主页', async () => {
    const plugin = await createPlugin({
      packageName: 'dsh-email',
      displayName: '邮件',
      policy: 'optional',
      isBundle: true,
    })
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: { sourceType: 'npm', version: '0.16.0' },
    })
    expect(res.statusCode, res.body).toBe(201)
    const version = json<{
      version: { version: string; spec: string; sourceType: string; sha256: string | null }
    }>(res)
    expect(version.version).toMatchObject({ version: '0.16.0', spec: '0.16.0', sourceType: 'npm' })
    expect(version.version.sha256).toMatch(/^[a-f0-9]{64}$/u)
    // 元数据里带了 description/homepage，创建时留空的应该被补上
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins' })
    expect(json<{ description: string; homepage: string | null }[]>(list)[0]).toMatchObject({
      description: 'fake plugin',
      homepage: 'https://example.com/fake',
    })
    // 重复添加同一版本 → 409
    const again = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: { sourceType: 'npm', version: '0.16.0' },
    })
    expect(again.statusCode).toBe(409)
    void version
  })

  it('npm 包内含疑似密钥 → 拒绝入库并回 {file,line,rule}（不回显值）', async () => {
    const plugin = await createPlugin({
      packageName: 'sketchy-plugin',
      displayName: '可疑',
      policy: 'optional',
      isBundle: true,
    })
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: { sourceType: 'npm', version: '1.0.0' },
    })
    expect(res.statusCode, res.body).toBe(400)
    const body = json<{
      error: { code: string; details?: { hits: { file: string; line: number; rule: string }[] } }
    }>(res)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.hits?.[0]).toEqual({
      file: 'cordis.patch.yml',
      line: 1,
      rule: 'secret-assignment',
    })
    // 明细里不能出现命中值本身
    expect(res.body).not.toContain('AbCdEf0123456789AbCdEf0123456789')
    expect(json<{ error: { message: string } }>(res).error.message).toContain('疑似密钥')
  })

  it('上传 .tgz：校验包名、入 plugin-store、spec 用 file:；包名不符则 400', async () => {
    const plugin = await createPlugin({
      packageName: '@local/upload-me',
      displayName: '上传',
      policy: 'optional',
      isBundle: true,
    })
    const ok = multipart(makePluginTgz({ name: '@local/upload-me', version: '3.1.0' }), {
      filename: 'upload-me-3.1.0.tgz',
      contentType: 'application/gzip',
    })
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: ok.payload,
      headers: ok.headers,
    })
    expect(res.statusCode, res.body).toBe(201)
    const version = json<{ version: { version: string; spec: string; storeFile: string | null } }>(res)
    expect(version.version.version).toBe('3.1.0')
    expect(version.version.spec).toBe('file:/opt/hub/plugin-store/local-upload-me-3.1.0.tgz')
    expect(readdirSync(ctx.app.deps.paths.pluginStoreDir)).toContain('local-upload-me-3.1.0.tgz')

    const mismatch = multipart(makePluginTgz({ name: '@local/other', version: '1.0.0' }), {
      filename: 'other.tgz',
      contentType: 'application/gzip',
    })
    const bad = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: mismatch.payload,
      headers: mismatch.headers,
    })
    expect(bad.statusCode, bad.body).toBe(400)
    expect(json<{ error: { message: string } }>(bad).error.message).toContain('与目录里的')
  })

  it('上传 .tgz 预读：返回包内 package.json 的名字/描述/版本，不入库；坏包与非管理员被拒', async () => {
    const good = multipart(
      makePluginTgz({ name: '@local/peek-me', version: '2.4.0', description: '包里的描述' }),
      { filename: 'whatever-name.tgz', contentType: 'application/gzip' },
    )
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/plugins/lookup',
      payload: good.payload,
      headers: good.headers,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(json(res)).toMatchObject({
      packageName: '@local/peek-me',
      displayName: '@local/peek-me',
      description: '包里的描述',
      versions: ['2.4.0'],
      latest: '2.4.0',
      isBundle: true,
    })
    // 只读不写：既没建插件，plugin-store 也没有新文件
    expect(readdirSync(ctx.app.deps.paths.pluginStoreDir)).toEqual([])
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins' })
    expect(json<unknown[]>(list)).toHaveLength(0)

    const garbage = multipart(Buffer.from('not a tarball'), {
      filename: 'bad.tgz',
      contentType: 'application/gzip',
    })
    const bad = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/plugins/lookup',
      payload: garbage.payload,
      headers: garbage.headers,
    })
    expect(bad.statusCode, bad.body).toBe(400)

    const forbidden = await injectAs(userSession, {
      method: 'POST',
      url: '/api/admin/plugins/lookup',
      payload: good.payload,
      headers: good.headers,
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('dsh.bundle.patch 指向的文件不在包里 → 400（否则每个用户都会装不上）', async () => {
    const plugin = await createPlugin({
      packageName: '@local/bad-bundle',
      displayName: '坏包',
      policy: 'optional',
      isBundle: true,
    })
    const bad = multipart(
      makePluginTgz({
        name: '@local/bad-bundle',
        version: '1.0.0',
        extra: [{ name: 'package/README.md', content: 'no patch file here\n' }],
      }),
      { filename: 'bad-bundle.tgz', contentType: 'application/gzip' },
    )
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: bad.payload,
      headers: bad.headers,
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(json<{ error: { message: string } }>(res).error.message).toContain('dsh.bundle.patch')
  })

  it('local 来源：临时目录 pnpm pack（不改原目录）→ 入 plugin-store', async ({ skip }) => {
    // 这条要真的跑 `pnpm pack`：PATH 里没有 pnpm（nvm 的 Node 只带 corepack）就跳过，其余环境照常跑
    if (spawnSync('pnpm', ['--version']).status !== 0) skip('PATH 里没有 pnpm')
    const plugin = await createPlugin({
      packageName: '@local/pack-me',
      displayName: '本地',
      policy: 'optional',
      isBundle: true,
    })
    const dir = makeTempDir()
    tempDirs.push(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@local/pack-me',
        version: '1.2.3',
        description: 'packed',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }),
    )
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: pack-me\n  config:\n    a: 1\n')

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: { sourceType: 'local', path: dir },
    })
    expect(res.statusCode, res.body).toBe(201)
    const version = json<{ version: { version: string; spec: string; sourceType: string } }>(res)
    expect(version.version).toMatchObject({
      version: '1.2.3',
      sourceType: 'local',
      spec: 'file:/opt/hub/plugin-store/local-pack-me-1.2.3.tgz',
    })
    expect(existsSync(join(ctx.app.deps.paths.pluginStoreDir, 'local-pack-me-1.2.3.tgz'))).toBe(true)
    // 原目录没有多出 out/ 或 tgz
    expect(readdirSync(dir).sort()).toEqual(['cordis.patch.yml', 'package.json'])
  }, 60_000)

  it('删除版本：没有用户使用时删除记录并清掉 store 文件', async () => {
    const plugin = await createPlugin({
      packageName: '@local/del-me',
      displayName: '待删',
      policy: 'optional',
      isBundle: true,
    })
    const upload = multipart(makePluginTgz({ name: '@local/del-me', version: '1.0.0' }), {
      filename: 'del-me.tgz',
      contentType: 'application/gzip',
    })
    const created = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${plugin.id}/versions`,
      payload: upload.payload,
      headers: upload.headers,
    })
    const versionId = json<{ version: { id: number } }>(created).version
    const storeFile = 'local-del-me-1.0.0.tgz'
    const res = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${plugin.id}/versions/${versionId.id}`,
    })
    expect(res.statusCode).toBe(204)
    expect(readdirSync(ctx.app.deps.paths.pluginStoreDir)).not.toContain(storeFile)
  })
})

describe('我的插件与用户自助（04 §3.2）', () => {
  it('列表：hidden 不展示；required 不能自助；optional 可自助', async () => {
    seedPlugin(app, { packageName: 'req-plugin', version: '1.0.0', policy: 'required' })
    seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    seedPlugin(app, { packageName: 'hidden-plugin', version: '3.0.0', policy: 'hidden' })
    const res = await injectAs(userSession, { method: 'GET', url: '/api/me/plugins' })
    expect(res.statusCode, res.body).toBe(200)
    const items = json<{
      items: { plugin: { packageName: string }; canToggle: boolean; installed: boolean }[]
    }>(res).items
    expect(items.map((item) => item.plugin.packageName).sort()).toEqual(['opt-plugin', 'req-plugin'])
    expect(items.find((item) => item.plugin.packageName === 'req-plugin')?.canToggle).toBe(false)
    expect(items.find((item) => item.plugin.packageName === 'opt-plugin')?.canToggle).toBe(true)
    expect(items.every((item) => !item.installed)).toBe(true)
  })

  it('自助安装：202 + 单用户 job，跑完后 profile 与 user_plugins 都更新', async () => {
    const plugin = seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    writeProfile(app, user.slug)
    ctx.driver.setExecHandler((_name, cmd) => {
      if (cmd[0] === 'dsh' && cmd[3] === 'add') {
        const file = `${app.deps.paths.userProfileDir(user.slug)}/package.json`
        const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        ;(data.dependencies as Record<string, string>)['opt-plugin'] = '2.0.0'
        ;((data.dsh as { profile: { bundles: string[] } }).profile.bundles as string[]).push('opt-plugin')
        writeFileSync(file, JSON.stringify(data, null, 2))
      }
      return { exitCode: 0, output: 'ok' }
    })

    const res = await injectAs(userSession, {
      method: 'POST',
      url: `/api/me/plugins/${plugin.pluginId}/install`,
    })
    expect(res.statusCode, res.body).toBe(202)
    const { jobId } = json<{ jobId: number }>(res)

    await waitFor(
      async () => {
        const { job } = await app.deps.services.jobs.get(jobId)
        return job.status === 'succeeded'
      },
      { label: '自助安装任务完成' },
    )

    expect(readProfile(app, user.slug).dependencies?.['opt-plugin']).toBe('2.0.0')
    const rows = await app.deps.services.plugins.listUserPluginRows(user.id)
    expect(rows[0]).toMatchObject({ desired: 'installed', state: 'synced', source: 'user' })
  })

  it('required 插件不能自助卸载；未安装的不能卸载；已关闭自助时 403', async () => {
    const required = seedPlugin(app, { packageName: 'req-plugin', version: '1.0.0', policy: 'required' })
    const optional = seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    const denied = await injectAs(userSession, {
      method: 'POST',
      url: `/api/me/plugins/${required.pluginId}/uninstall`,
    })
    expect(denied.statusCode).toBe(403)
    const notInstalled = await injectAs(userSession, {
      method: 'POST',
      url: `/api/me/plugins/${optional.pluginId}/uninstall`,
    })
    expect(notInstalled.statusCode).toBe(409)

    app.deps.db.run(
      'UPDATE users SET quota_json = ? WHERE id = ?',
      JSON.stringify({ allowUserPlugins: false }),
      user.id,
    )
    const closed = await injectAs(userSession, {
      method: 'POST',
      url: `/api/me/plugins/${optional.pluginId}/install`,
    })
    expect(closed.statusCode).toBe(403)
  })
})

describe('管理端用户详情的 plugins 字段（WP1 的 TODO）', () => {
  it('返回该用户的 UserPluginRow', async () => {
    const plugin = seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    const now = app.deps.clock.nowIso()
    app.deps.db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)`,
      user.id,
      plugin.pluginId,
      plugin.versionId,
      plugin.versionId,
      now,
    )
    const res = await injectAs(adminSession, { method: 'GET', url: `/api/admin/users/${user.id}` })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ plugins: { pluginId: number; username: string; actualVersion: string | null }[] }>(
      res,
    )
    expect(body.plugins).toHaveLength(1)
    expect(body.plugins[0]).toMatchObject({
      pluginId: plugin.pluginId,
      username: 'alice',
      actualVersion: '2.0.0',
    })
  })

  it('GET /:id/users 返回全量用户矩阵（未安装的 row=null，04 §10.1/§10.2）', async () => {
    const plugin = seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    await createUser(app, { username: 'bob', displayName: '鲍勃' })
    const now = app.deps.clock.nowIso()
    app.deps.db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)`,
      user.id,
      plugin.pluginId,
      plugin.versionId,
      plugin.versionId,
      now,
    )
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/plugins/${plugin.pluginId}/users`,
    })
    expect(res.statusCode, res.body).toBe(200)
    const items = json<{
      items: {
        user: { id: number; username: string; displayName: string; status: string }
        row: { packageName: string; displayName: string; actualVersion: string | null } | null
      }[]
    }>(res).items
    // 全量：admin + alice + bob（按 username 排序）
    expect(items.map((item) => item.user.username)).toEqual(['admin1', 'alice', 'bob'])
    const alice = items.find((item) => item.user.username === 'alice')!
    expect(alice.row).toMatchObject({
      packageName: 'opt-plugin',
      displayName: 'opt-plugin',
      actualVersion: '2.0.0',
    })
    expect(items.find((item) => item.user.username === 'bob')?.row).toBeNull()
    expect(items.find((item) => item.user.username === 'bob')?.user.displayName).toBe('鲍勃')
  })

  it('仍有用户安装时不能删插件', async () => {
    const plugin = seedPlugin(app, { packageName: 'opt-plugin', version: '2.0.0', policy: 'optional' })
    const now = app.deps.clock.nowIso()
    app.deps.db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)`,
      user.id,
      plugin.pluginId,
      plugin.versionId,
      plugin.versionId,
      now,
    )
    const res = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${plugin.pluginId}`,
    })
    expect(res.statusCode).toBe(409)
  })
})
