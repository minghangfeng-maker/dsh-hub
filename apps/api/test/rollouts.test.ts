import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import {
  TEST_META,
  cleanupDirs,
  createWp3App,
  seedPlugin,
  waitFor,
  writeProfile,
  type Wp3TestApp,
} from './helpers-wp3.js'

/**
 * 下发任务（rollouts，04 §4.8 / 06 §5.1）：preview 与 create 目标一致、金丝雀排序与失败暂停、
 * 失败率阈值暂停、retry-failed、三种 kind 的期望状态落库。
 */

let ctx: Wp3TestApp
let app: FastifyInstance
let admin: TestUser
let adminSession: TestSession
const users: TestUser[] = []
const tempDirs: string[] = []

beforeEach(async () => {
  ctx = await createWp3App()
  app = ctx.app
  admin = await createUser(app, { username: 'admin1', role: 'admin' })
  adminSession = loginAs(app, admin)
  writeProfile(app, admin.slug)
  // 下发需要二次验证（04 §4.8）：直接给会话打上标记，不依赖 WP1 的 /api/auth/reauth
  app.deps.db.run(
    'UPDATE sessions SET reauth_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    adminSession.sessionId,
  )
  for (let index = 0; index < 4; index += 1) {
    const user = await createUser(app, { username: `user${index}` })
    writeProfile(app, user.slug)
    users.push(user)
  }
})

afterEach(async () => {
  users.length = 0
  await ctx.close()
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

const STRATEGY = { concurrency: 2, canary: 1, maxFailureRatio: 0.2, restart: 'next-start' }

/** 让某些用户的 `dsh plugin add` 失败（按容器名区分） */
function failFor(slugs: string[], stage: 'dsh' | 'pnpm' = 'dsh'): void {
  const failing = new Set(slugs.map((slug) => `dshhub-${slug}`))
  ctx.driver.setExecHandler((name, cmd) => {
    if (cmd[0] === stage && failing.has(name)) return { exitCode: 1, output: 'boom' }
    if (cmd[0] === 'dsh' && cmd[3] === 'add') {
      // 成功的安装要真的改 profile，否则后续断言看不到效果
      const slug = name.replace('dshhub-', '')
      const file = `${app.deps.paths.userProfileDir(slug)}/package.json`
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const spec = String(cmd[4] ?? '')
      const packageName = spec.startsWith('@')
        ? spec.split('@').slice(0, 2).join('@')
        : (spec.split('@')[0] ?? spec)
      ;(data.dependencies as Record<string, string>)[packageName] = spec
      writeFileSync(file, JSON.stringify(data, null, 2))
    }
    return { exitCode: 0, output: 'ok' }
  })
}

async function createPluginRollout(payload: Record<string, unknown>): Promise<number> {
  const res = await injectAs(adminSession, { method: 'POST', url: '/api/admin/rollouts', payload })
  expect(res.statusCode, res.body).toBe(202)
  return json<{ jobId: number }>(res).jobId
}

async function waitStatus(jobId: number, statuses: string[]): Promise<string> {
  try {
    return await waitFor(
      async () => {
        const status = (await app.deps.services.jobs.get(jobId)).job.status
        return statuses.includes(status) ? status : ''
      },
      { label: `job ${String(jobId)} → ${statuses.join('/')}` },
    )
  } catch (error) {
    const { job, tasks } = await app.deps.services.jobs.get(jobId)
    console.error('job 状态不符合预期：', JSON.stringify({ job, tasks }, null, 2))
    throw error
  }
}

describe('rollout 目标解析（06 §5.1）', () => {
  it('preview 与 create 的目标一致，且金丝雀（管理员自己）排在最前', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    const request = {
      kind: 'plugin',
      action: 'install',
      pluginId: plugin.pluginId,
      targets: { userIds: [users[0]!.id, users[1]!.id, admin.id] },
      strategy: STRATEGY,
    }
    const preview = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts/preview',
      payload: request,
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const previewBody = json<{ targets: { userId: number; username: string }[]; total: number }>(preview)
    expect(previewBody.total).toBe(3)
    // 管理员自己（actor）是金丝雀，排第一
    expect(previewBody.targets[0]!.userId).toBe(admin.id)

    // 不落库：preview 之后没有期望状态
    expect(app.deps.db.all('SELECT * FROM user_plugins')).toHaveLength(0)
    void users

    failFor([])
    const jobId = await createPluginRollout(request)
    const tasks = (await app.deps.services.jobs.get(jobId)).tasks
    expect(tasks.map((task) => task.userId)).toEqual(previewBody.targets.map((item) => item.userId))
    // create 后期望状态已落库（pending）
    const rows = app.deps.db.all<{ user_id: number; desired: string; state: string }>(
      'SELECT user_id, desired, state FROM user_plugins',
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.desired === 'installed' && row.state === 'pending')).toBe(true)

    await waitStatus(jobId, ['succeeded'])
  })

  it('all 目标：排除已删除用户，包含 disabled（但不启动其实例）', async () => {
    const disabled = await createUser(app, { username: 'gone', status: 'disabled' })
    writeProfile(app, disabled.slug)
    const deleted = await createUser(app, { username: 'deleted' })
    app.deps.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', app.deps.clock.nowIso(), deleted.id)
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })

    const preview = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts/preview',
      payload: {
        kind: 'plugin',
        action: 'install',
        pluginId: plugin.pluginId,
        targets: { all: true },
        strategy: STRATEGY,
      },
    })
    const ids = json<{ targets: { userId: number }[] }>(preview).targets.map((item) => item.userId)
    expect(ids).toContain(disabled.id)
    expect(ids).not.toContain(deleted.id)
  })
})

describe('金丝雀与失败率（06 §5.1 / 10 D4）', () => {
  it('金丝雀失败 → job 暂停，等管理员决定', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    failFor([admin.slug])
    const jobId = await createPluginRollout({
      kind: 'plugin',
      action: 'install',
      pluginId: plugin.pluginId,
      targets: { userIds: [admin.id, users[0]!.id, users[1]!.id] },
      strategy: STRATEGY,
    })
    await waitStatus(jobId, ['paused'])
    const { job, tasks } = await app.deps.services.jobs.get(jobId)
    expect(job.error).toContain('金丝雀')
    // 金丝雀失败后，其余任务没有继续跑
    const pending = tasks.filter((task) => task.status === 'pending')
    expect(pending.length).toBeGreaterThan(0)
    expect(tasks.find((task) => task.userId === admin.id)?.status).toBe('failed')
  })

  it('失败率超过阈值 → 暂停；retry-failed 后重跑并成功', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    failFor([users[0]!.slug, users[1]!.slug])
    const jobId = await createPluginRollout({
      kind: 'plugin',
      action: 'install',
      pluginId: plugin.pluginId,
      targets: { userIds: users.map((user) => user.id) },
      strategy: { ...STRATEGY, canary: 0, concurrency: 1, maxFailureRatio: 0.2 },
    })
    await waitStatus(jobId, ['paused'])
    const paused = (await app.deps.services.jobs.get(jobId)).job
    expect(paused.error).toContain('失败率')
    expect(paused.failed).toBeGreaterThanOrEqual(1)

    // 修好之后重试失败项
    failFor([])
    const retried = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/jobs/${jobId}/retry-failed`,
    })
    expect(retried.statusCode, retried.body).toBe(200)
    await waitStatus(jobId, ['succeeded', 'partial'])
    const { job, tasks } = await app.deps.services.jobs.get(jobId)
    expect(tasks.every((task) => task.status === 'succeeded')).toBe(true)
    expect(job.status).toBe('succeeded')
    // 期望/实际状态都同步了
    const rows = app.deps.db.all<{ state: string; actual_version_id: number | null }>(
      'SELECT state, actual_version_id FROM user_plugins',
    )
    expect(rows.every((row) => row.state === 'synced' && row.actual_version_id !== null)).toBe(true)
  })

  it('卸载下发：desired=absent，跑完后 profile 里没有该依赖', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    const now = app.deps.clock.nowIso()
    for (const user of users) {
      app.deps.db.run(
        `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
         VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)`,
        user.id,
        plugin.pluginId,
        plugin.versionId,
        plugin.versionId,
        now,
      )
      writeProfile(app, user.slug, {
        dependencies: { 'dsh-email': '0.16.0' },
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-email'],
      })
    }
    failFor([])
    const jobId = await createPluginRollout({
      kind: 'plugin',
      action: 'uninstall',
      pluginId: plugin.pluginId,
      targets: { all: true },
      strategy: { ...STRATEGY, canary: 0 },
    })
    await waitStatus(jobId, ['succeeded'])
    for (const user of users) {
      const data = JSON.parse(
        readFileSync(`${app.deps.paths.userProfileDir(user.slug)}/package.json`, 'utf8'),
      ) as { dependencies: Record<string, string> }
      expect(data.dependencies['dsh-email']).toBeUndefined()
    }
  })
})

describe('runtime / models 下发（期望状态）', () => {
  it('runtime：把 users.runtime_id 写成目标版本，钉在别处的用户不在目标里', async () => {
    const runtimeId = app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES ('0.3.0', 'dshhub/runtime:0.3.0', 'ready', 0, '', ?)`,
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    // users[0] 钉在**另一个**版本上 → 统一更新不该动它
    const otherRuntimeId = app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES ('0.1.0', 'dshhub/runtime:0.1.0', 'ready', 0, '', ?)`,
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    app.deps.db.run('UPDATE users SET runtime_id = ? WHERE id = ?', otherRuntimeId, users[0]!.id)

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts',
      payload: { kind: 'runtime', runtimeId, targets: { all: true }, strategy: STRATEGY },
    })
    expect(res.statusCode, res.body).toBe(202)
    const jobId = json<{ jobId: number }>(res).jobId
    // 钉在别处的用户被排除：目标只有管理员与其余 3 个用户
    const tasks = (await app.deps.services.jobs.get(jobId)).tasks
    expect(tasks.map((task) => task.userId)).not.toContain(users[0]!.id)
    expect(tasks).toHaveLength(4)
    const rows = app.deps.db.all<{ id: number; runtime_id: number | null }>(
      'SELECT id, runtime_id FROM users WHERE id <> ?',
      users[0]!.id,
    )
    expect(rows.every((row) => row.runtime_id === runtimeId)).toBe(true)
  })

  it('runtime：目标是默认版本 → users.runtime_id 置空（跟随默认，04 §10.5）', async () => {
    const runtimeId = app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES ('0.3.0', 'dshhub/runtime:0.3.0', 'ready', 1, '', ?)`,
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    // users[1] 先钉在**这个默认版本**上；users[0] 跟随默认（runtime_id 为空）
    app.deps.db.run('UPDATE users SET runtime_id = ? WHERE id = ?', runtimeId, users[1]!.id)

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts',
      payload: { kind: 'runtime', runtimeId, targets: { all: true }, strategy: STRATEGY },
    })
    expect(res.statusCode, res.body).toBe(202)
    const rows = app.deps.db.all<{ id: number; runtime_id: number | null }>(
      'SELECT id, runtime_id FROM users WHERE deleted_at IS NULL',
    )
    // 目标就是默认版本 → 期望状态写「跟随默认」（不钉住）
    expect(rows.every((row) => row.runtime_id === null)).toBe(true)

    const preview = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts/preview',
      payload: { kind: 'runtime', runtimeId, targets: { all: true }, strategy: STRATEGY },
    })
    expect(json<{ targets: { after: string }[] }>(preview).targets[0]!.after).toContain('默认版本，不钉住')
  })

  it('models：省略 presetId 时不改用户预设，只重渲染（04 §10.6）', async () => {
    const providerId = app.deps.db.run(
      `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                    extra_json, key_mode, api_key_enc, enabled, created_at, updated_at)
       VALUES ('hub-relay', '中转', 'pi-ai', 'openai-completions', 'https://x/v1', '[]', NULL, NULL,
               'none', NULL, 1, ?, ?)`,
      app.deps.clock.nowIso(),
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    const presetId = app.deps.db.run(
      `INSERT INTO model_presets (name, description, provider_ids_json, default_provider, default_model,
                                  is_default, revision, created_at, updated_at)
       VALUES ('默认', '', ?, 'hub-relay', 'm1', 1, 1, ?, ?)`,
      JSON.stringify([providerId]),
      app.deps.clock.nowIso(),
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', presetId, users[0]!.id)

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts',
      payload: {
        kind: 'models',
        targets: { userIds: [users[0]!.id] },
        strategy: { ...STRATEGY, restart: 'next-start' },
      },
    })
    expect(res.statusCode, res.body).toBe(202)
    const row = app.deps.db.get<{ model_preset_id: number | null }>(
      'SELECT model_preset_id FROM users WHERE id = ?',
      users[0]!.id,
    )
    expect(row?.model_preset_id).toBe(presetId)
  })

  it('models：写 users.model_preset_id，缺省为 NULL（跟随默认预设）', async () => {
    const providerId = app.deps.db.run(
      `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                    extra_json, key_mode, api_key_enc, enabled, created_at, updated_at)
       VALUES ('hub-relay', '中转', 'pi-ai', 'openai-completions', 'https://x/v1', '[]', NULL, NULL,
               'none', NULL, 1, ?, ?)`,
      app.deps.clock.nowIso(),
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    const presetId = app.deps.db.run(
      `INSERT INTO model_presets (name, description, provider_ids_json, default_provider, default_model,
                                  is_default, revision, created_at, updated_at)
       VALUES ('默认', '', ?, 'hub-relay', 'm1', 1, 1, ?, ?)`,
      JSON.stringify([providerId]),
      app.deps.clock.nowIso(),
      app.deps.clock.nowIso(),
    ).lastInsertRowid

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts',
      payload: {
        kind: 'models',
        presetId,
        targets: { userIds: [users[0]!.id, users[1]!.id] },
        strategy: { ...STRATEGY, restart: 'next-start' },
      },
    })
    expect(res.statusCode, res.body).toBe(202)
    const rows = app.deps.db.all<{ id: number; model_preset_id: number | null }>(
      'SELECT id, model_preset_id FROM users WHERE id IN (?, ?)',
      users[0]!.id,
      users[1]!.id,
    )
    expect(rows.every((row) => row.model_preset_id === presetId)).toBe(true)

    // 预览文案里能看到「当前 → 之后」
    const preview = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts/preview',
      payload: { kind: 'models', targets: { userIds: [users[0]!.id] }, strategy: STRATEGY },
    })
    const item = json<{ targets: { current: string; after: string }[] }>(preview).targets[0]!
    expect(item.current).toContain('默认')
    expect(item.after).toContain('默认')
  })

  it('D9：versionId / runtimeId / presetId 不存在或不属于该插件 → 4xx（不是 500）', async () => {
    const pluginA = seedPlugin(app, { packageName: 'plugin-a', version: '1.0.0' })
    const pluginB = seedPlugin(app, { packageName: 'plugin-b', version: '2.0.0' })
    const cases = [
      {
        payload: { kind: 'plugin', action: 'install', pluginId: pluginA.pluginId, versionId: 999999 },
        code: 'NOT_FOUND',
      },
      {
        // 版本存在，但属于另一个插件
        payload: {
          kind: 'plugin',
          action: 'install',
          pluginId: pluginA.pluginId,
          versionId: pluginB.versionId,
        },
        code: 'NOT_FOUND',
      },
      { payload: { kind: 'runtime', runtimeId: 999999 }, code: 'NOT_FOUND' },
      { payload: { kind: 'models', presetId: 999999 }, code: 'NOT_FOUND' },
    ]
    for (const item of cases) {
      const res = await injectAs(adminSession, {
        method: 'POST',
        url: '/api/admin/rollouts',
        payload: { ...item.payload, targets: { userIds: [users[0]!.id] }, strategy: STRATEGY },
      })
      expect(res.statusCode, JSON.stringify(item.payload) + res.body).toBe(404)
      expect(json<{ error: { code: string } }>(res).error.code).toBe(item.code)
    }
    // 期望状态不能被写脏
    const rows = app.deps.db.all('SELECT * FROM user_plugins')
    expect(rows).toHaveLength(0)
    expect(app.deps.db.all('SELECT id FROM jobs')).toHaveLength(0)
  })

  it('没有匹配目标 → 409 CONFLICT', async () => {
    const plugin = seedPlugin(app, { packageName: 'dsh-email', version: '0.16.0' })
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/rollouts',
      payload: {
        kind: 'plugin',
        action: 'install',
        pluginId: plugin.pluginId,
        targets: { filter: { status: 'pending' } },
        strategy: STRATEGY,
      },
    })
    expect(res.statusCode, res.body).toBe(409)
    void TEST_META
  })
})
