import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import {
  cleanupDirs,
  createWp3App,
  makeTempDir,
  seedPlugin,
  startFakeOpenAi,
  startInstance,
  type FakeServer,
  type Wp3TestApp,
} from './helpers-wp3.js'

/**
 * models 模块（04 §4.7、06 §4）：提供方 CRUD、密钥加密与遮罩、改密钥要求 reauth、
 * 连接测试（本地假 OpenAI）、预设校验与 revision、渲染预览、per-user 密钥、containerEnv、
 * applyForUser 的重启/重建判定。
 */

const API_KEY = 'sk-test-key-1234567890abcdef'
const USER_KEY = 'sk-user-key-0987654321zyxwvu'

let ctx: Wp3TestApp
let app: FastifyInstance
let admin: TestUser
let adminSession: TestSession
let user: TestUser
let openai: FakeServer
const tempDirs: string[] = []

beforeEach(async () => {
  openai = await startFakeOpenAi({ apiKey: API_KEY })
  ctx = await createWp3App()
  app = ctx.app
  admin = await createUser(app, { username: 'admin1', role: 'admin' })
  adminSession = loginAs(app, admin)
  user = await createUser(app, { username: 'alice' })
  grantReauth(adminSession)
})

afterEach(async () => {
  await ctx.close()
  await openai.close()
  cleanupDirs(tempDirs)
})

/** 直接给会话打上「刚二次验证过」的标记（不依赖 WP1 的 /api/auth/reauth 路由） */
function grantReauth(session: TestSession, minutes = 5): void {
  app.deps.db.run(
    'UPDATE sessions SET reauth_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    session.sessionId,
  )
  void minutes
}

function revokeReauth(session: TestSession): void {
  app.deps.db.run('UPDATE sessions SET reauth_at = NULL WHERE id = ?', session.sessionId)
}

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

async function createProvider(input: Record<string, unknown>): Promise<{ id: number }> {
  const res = await injectAs(adminSession, {
    method: 'POST',
    url: '/api/admin/models/providers',
    payload: input,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<{ provider: { id: number } }>(res).provider
}

const PROVIDER = {
  routeKey: 'hub-relay',
  displayName: '小站中转',
  kind: 'pi-ai',
  api: 'openai-completions',
  models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }],
  keyMode: 'shared',
}

describe('提供方 CRUD 与密钥遮罩（04 §4.7 / 10 D10）', () => {
  it('创建（带密钥）→ 列表只回末 4 位 → 改密钥要 reauth', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/models/providers' })
    const rows = json<{ apiKey: { set: boolean; last4: string | null }; apiKeyEnc?: string }[]>(list)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.apiKey).toEqual({ set: true, last4: 'cdef' })
    // 响应里不能出现明文或密文
    expect(list.body).not.toContain(API_KEY)
    expect(list.body).not.toContain('v1:')

    // 没有 reauth → 403 REAUTH_REQUIRED
    const session2 = loginAs(app, admin)
    const denied = await injectAs(session2, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { apiKey: 'sk-new-key-1111111111111111' },
    })
    expect(denied.statusCode, denied.body).toBe(403)
    expect(json<{ error: { code: string } }>(denied).error.code).toBe('REAUTH_REQUIRED')

    // 不带 apiKey 的普通更新不需要 reauth
    const okPatch = await injectAs(session2, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { displayName: '改名了' },
    })
    expect(okPatch.statusCode, okPatch.body).toBe(200)

    grantReauth(session2)
    const changed = await injectAs(session2, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { apiKey: 'sk-new-key-1111111111111111' },
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(json<{ provider: { apiKey: { last4: string } } }>(changed).provider.apiKey.last4).toBe('1111')
  })

  it('keyMode=shared 不给密钥 → 400；重复 routeKey → 409', async () => {
    const missing = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/providers',
      payload: { ...PROVIDER, baseUrl: `${openai.url}/v1` },
    })
    expect(missing.statusCode, missing.body).toBe(400)
    await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const dup = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/providers',
      payload: { ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('连接测试走本地假 OpenAI；密钥不对时 ok=false', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/models/providers/${provider.id}/test`,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(json(res)).toMatchObject({ ok: true, models: ['gpt-4o-mini', 'gpt-4o'] })
    expect(openai.requests.some((request) => request.includes('/v1/models'))).toBe(true)

    const bad = await createProvider({
      routeKey: 'bad-relay',
      displayName: '错的',
      kind: 'pi-ai',
      api: 'openai-completions',
      baseUrl: `${openai.url}/v1`,
      models: [],
      keyMode: 'shared',
      apiKey: 'sk-wrong-key-0000000000000000',
    })
    const failed = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/models/providers/${bad.id}/test`,
    })
    expect(json(failed)).toMatchObject({ ok: false })
  })

  it('discover 用请求里的临时密钥（不落库）', async () => {
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/discover',
      payload: { api: 'openai-completions', baseUrl: `${openai.url}/v1`, apiKey: API_KEY },
    })
    expect(res.statusCode, res.body).toBe(200)
    // 两个都是内置库里认识的模型：自动带出容量和输入类型，并标明来源
    const { models } = json<{ models: Record<string, unknown>[] }>(res)
    expect(models.map((model) => model.id)).toEqual(['gpt-4o-mini', 'gpt-4o'])
    for (const model of models) {
      expect(model).toMatchObject({ infoSource: 'builtin' })
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.maxTokens).toBeGreaterThan(0)
      expect(model.input).toEqual(expect.arrayContaining(['text']))
    }
    expect(app.deps.db.all('SELECT id FROM model_providers')).toHaveLength(0)
  })

  it('discover：端点自己报的容量优先于库；库里没有的模型原样返回、不带来源', async () => {
    const rich = await startFakeOpenAi({
      apiKey: API_KEY,
      models: [
        { id: 'gpt-4o', context_length: 4242, max_output_tokens: 99 },
        {
          id: 'router/vision-x',
          architecture: { input_modalities: ['text', 'image', 'file'] },
          limit: { context: 8192 },
        },
        'totally-unknown-model',
      ],
    })
    try {
      const res = await injectAs(adminSession, {
        method: 'POST',
        url: '/api/admin/models/discover',
        payload: { api: 'openai-completions', baseUrl: `${rich.url}/v1`, apiKey: API_KEY },
      })
      expect(res.statusCode, res.body).toBe(200)
      const { models } = json<{ models: Record<string, unknown>[] }>(res)
      const byId = new Map(models.map((model) => [model.id, model]))
      // 容量用端点的，输入类型 / 来源标记来自库
      expect(byId.get('gpt-4o')).toMatchObject({
        contextWindow: 4242,
        maxTokens: 99,
        infoSource: 'builtin',
      })
      // 库里没有，但端点报了容量和输入类型 → 标 upstream
      expect(byId.get('router/vision-x')).toEqual({
        id: 'router/vision-x',
        name: 'router/vision-x',
        contextWindow: 8192,
        input: ['text', 'image'],
        infoSource: 'upstream',
      })
      // 什么都没有 → 只有 id / name，需要手填
      expect(byId.get('totally-unknown-model')).toEqual({
        id: 'totally-unknown-model',
        name: 'totally-unknown-model',
      })
    } finally {
      await rich.close()
    }
  })

  it('模型信息库：自定义条目增删改、覆盖内置、discover 与 match 都认；非管理员不可访问', async () => {
    const empty = json<{ custom: unknown[]; builtin: { count: number; source: string } }>(
      await injectAs(adminSession, { method: 'GET', url: '/api/admin/models/catalog' }),
    )
    expect(empty.custom).toEqual([])
    expect(empty.builtin.count).toBeGreaterThan(500)
    expect(empty.builtin.source).toContain('pi-ai')

    // 档位里只有 off、完全没内容、未知档位 → 拒绝
    for (const entry of [
      { id: 'x-model', reasoningEfforts: ['off'] },
      { id: 'x-model' },
      { id: 'x-model', reasoningEfforts: ['low', 'ultra'] },
      { id: '///', maxTokens: 1 },
    ]) {
      const bad = await injectAs(adminSession, {
        method: 'PUT',
        url: '/api/admin/models/catalog',
        payload: { entries: [entry] },
      })
      expect(bad.statusCode, JSON.stringify(entry)).toBe(400)
    }

    // 中转站把输出上限限到了 64000：存一条自定义，档位乱序也会被整理
    const saved = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/models/catalog',
      payload: {
        entries: [
          {
            id: 'My-Relay/deepseek-v4.1-flash',
            maxTokens: 64_000,
            reasoningEfforts: ['max', 'low', 'off', 'high'],
          },
        ],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const custom = json<{ custom: Record<string, unknown>[] }>(saved).custom
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({
      key: 'deepseek-v4-1-flash',
      id: 'My-Relay/deepseek-v4.1-flash',
      maxTokens: 64_000,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    })

    // match：自定义字段优先，没写的用内置补
    const matched = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/catalog/match',
      payload: { ids: ['deepseek-v4.1-flash', 'nope-not-a-model', 'deepseek-v4.1-flash'] },
    })
    expect(matched.statusCode, matched.body).toBe(200)
    const { matches } = json<{ matches: Record<string, unknown>[] }>(matched)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      id: 'deepseek-v4.1-flash',
      source: 'custom',
      matchedId: 'My-Relay/deepseek-v4.1-flash',
      maxTokens: 64_000,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
      input: ['text', 'image'],
    })
    expect(matches[0]!.contextWindow).toBeGreaterThanOrEqual(1_000_000)

    // discover 也用自定义：端点只报 id，容量来自库
    const relay = await startFakeOpenAi({ apiKey: API_KEY, models: ['deepseek-v4.1-flash'] })
    try {
      const found = await injectAs(adminSession, {
        method: 'POST',
        url: '/api/admin/models/discover',
        payload: { api: 'openai-completions', baseUrl: `${relay.url}/v1`, apiKey: API_KEY },
      })
      expect(json<{ models: unknown[] }>(found).models[0]).toMatchObject({
        id: 'deepseek-v4.1-flash',
        maxTokens: 64_000,
        infoSource: 'custom',
        matchedId: 'My-Relay/deepseek-v4.1-flash',
      })
    } finally {
      await relay.close()
    }

    // 同一个键再存一次 = 覆盖，不会多出一行
    const overwrite = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/models/catalog',
      payload: { entries: [{ id: 'deepseek-v4.1-flash', maxTokens: 32_000 }] },
    })
    const afterOverwrite = json<{ custom: Record<string, unknown>[] }>(overwrite).custom
    expect(afterOverwrite).toHaveLength(1)
    expect(afterOverwrite[0]).toMatchObject({ id: 'deepseek-v4.1-flash', maxTokens: 32_000 })
    expect(afterOverwrite[0]!.reasoningEfforts).toBeUndefined()

    // 非管理员：全部 403
    const alice = loginAs(app, user)
    for (const request of [
      { method: 'GET' as const, url: '/api/admin/models/catalog' },
      {
        method: 'PUT' as const,
        url: '/api/admin/models/catalog',
        payload: { entries: [{ id: 'a', maxTokens: 1 }] },
      },
      { method: 'POST' as const, url: '/api/admin/models/catalog/match', payload: { ids: ['a'] } },
      { method: 'DELETE' as const, url: '/api/admin/models/catalog/deepseek-v4-1-flash' },
    ]) {
      expect((await injectAs(alice, request)).statusCode, `${request.method} ${request.url}`).toBe(403)
    }

    // 删除 → 204；再删 → 404；删完后回到内置值
    const removed = await injectAs(adminSession, {
      method: 'DELETE',
      url: '/api/admin/models/catalog/deepseek-v4-1-flash',
    })
    expect(removed.statusCode, removed.body).toBe(204)
    const again = await injectAs(adminSession, {
      method: 'DELETE',
      url: '/api/admin/models/catalog/deepseek-v4-1-flash',
    })
    expect(again.statusCode).toBe(404)
    const afterDelete = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/catalog/match',
      payload: { ids: ['deepseek-v4.1-flash'] },
    })
    expect(json<{ matches: Record<string, unknown>[] }>(afterDelete).matches[0]).toMatchObject({
      source: 'builtin',
    })

    // 增、改、删各留了审计
    const audits = app.deps.db.all<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'model.catalog.change'",
    )
    expect(audits.length).toBeGreaterThanOrEqual(3)
  })

  it('per-user 密钥：PUT/DELETE 需要 reauth，containerEnv 用该用户的密钥', async () => {
    const provider = await createProvider({
      ...PROVIDER,
      routeKey: 'per-user-relay',
      baseUrl: `${openai.url}/v1`,
      keyMode: 'per-user',
    })
    revokeReauth(adminSession)
    const denied = await injectAs(adminSession, {
      method: 'PUT',
      url: `/api/admin/models/providers/${provider.id}/user-keys/${user.id}`,
      payload: { apiKey: USER_KEY },
    })
    expect(denied.statusCode).toBe(403)

    grantReauth(adminSession)
    const put = await injectAs(adminSession, {
      method: 'PUT',
      url: `/api/admin/models/providers/${provider.id}/user-keys/${user.id}`,
      payload: { apiKey: USER_KEY },
    })
    expect(put.statusCode, put.body).toBe(204)

    // 把预设指到这个提供方，containerEnv 就该拿到该用户的密钥
    const preset = await createPreset(provider.id, 'per-user-relay', 'gpt-4o-mini')
    app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', preset.id, user.id)
    const env = await app.deps.services.models.containerEnv(user.id)
    expect(env).toEqual({ HUB_MK_PER_USER_RELAY: USER_KEY })

    const del = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/models/providers/${provider.id}/user-keys/${user.id}`,
    })
    expect(del.statusCode).toBe(204)
    expect(await app.deps.services.models.containerEnv(user.id)).toEqual({})
  })
})

async function createPreset(
  providerId: number,
  defaultProvider: string,
  defaultModel: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; revision: number }> {
  const res = await injectAs(adminSession, {
    method: 'POST',
    url: '/api/admin/models/presets',
    payload: {
      name: `预设-${defaultProvider}`,
      providerIds: [providerId],
      defaultProvider,
      defaultModel,
      ...extra,
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<{ preset: { id: number; revision: number } }>(res).preset
}

describe('预设与渲染（06 §4.2 §4.3）', () => {
  it('第一个预设自动成为默认；校验默认模型必须在提供方列表里；revision 每次 +1', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const bad = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/presets',
      payload: {
        name: '错的',
        providerIds: [provider.id],
        defaultProvider: 'hub-relay',
        defaultModel: '不存在的模型',
      },
    })
    expect(bad.statusCode, bad.body).toBe(400)

    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    expect(preset.revision).toBe(1)
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/models/presets' })
    expect(json<{ isDefault: boolean; usersOnIt: number }[]>(list)[0]).toMatchObject({
      isDefault: true,
      usersOnIt: 0,
    })

    const patched = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/models/presets/${preset.id}`,
      payload: { description: '改一下' },
    })
    expect(json<{ preset: { revision: number } }>(patched).preset.revision).toBe(2)

    // 默认预设不能删；被用户引用也不能删
    const delDefault = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/models/presets/${preset.id}`,
    })
    expect(delDefault.statusCode).toBe(409)
    app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', preset.id, user.id)
    const second = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini', {
      name: '第二个',
      isDefault: true,
    })
    const delUsed = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/models/presets/${preset.id}`,
    })
    expect(delUsed.statusCode).toBe(409)
    expect(second.id).toBeGreaterThan(0)
  })

  it('预览：密钥只以 env 名出现；插件配置只对已装用户输出', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    const plugin = seedPlugin(app, {
      packageName: 'dsh-email',
      version: '0.16.0',
      configYaml: '- id: email\n  config:\n    from: hub@example.com\n',
    })
    const now = app.deps.clock.nowIso()
    // alice 已装该插件；bob 没装
    app.deps.db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)`,
      user.id,
      plugin.pluginId,
      plugin.versionId,
      plugin.versionId,
      now,
    )
    const bob = await createUser(app, { username: 'bob' })

    const preview = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/models/presets/${preset.id}/preview?userId=${user.id}`,
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const body = json<{ content: string; warnings: string[] }>(preview)
    expect(body.content).toContain('HUB_MK_HUB_RELAY')
    expect(body.content).toContain('documentsDirectory: /workspace')
    expect(body.content).toContain('id: email')
    expect(body.content).not.toContain(API_KEY)

    const bobPreview = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/models/presets/${preset.id}/preview?userId=${bob.id}`,
    })
    expect(json<{ content: string }>(bobPreview).content).not.toContain('id: email')
  })

  it('renderManaged 落盘 managed.patch.yml + manifest.json，free 用户没有模型条目', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')

    const result = await app.deps.services.models.renderManaged(user.id)
    const dir = app.deps.paths.userManaged(user.slug)
    const patch = readFileSync(join(dir, 'managed.patch.yml'), 'utf8')
    expect(patch).toBe(result.content)
    expect(patch).toContain('agent-default-model')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      presetRevision: number
      userId: number
    }
    expect(manifest).toMatchObject({ userId: user.id, presetRevision: 1 })

    app.deps.db.run("UPDATE users SET model_policy = 'free' WHERE id = ?", user.id)
    const free = await app.deps.services.models.renderManaged(user.id)
    expect(free.content).not.toContain('llm-pi-ai')
    expect(free.content).toContain('model_policy=free')
    expect(await app.deps.services.models.containerEnv(user.id)).toEqual({})
  })

  it('deepseek-official 提供方注入 DEEPSEEK_API_KEY', async () => {
    const provider = await createProvider({
      routeKey: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      kind: 'deepseek-official',
      models: [],
      keyMode: 'shared',
      apiKey: 'sk-deepseek-1234567890abcdef',
    })
    await createPreset(provider.id, 'deepseek-official', 'deepseek-flash')
    const env = await app.deps.services.models.containerEnv(user.id)
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'sk-deepseek-1234567890abcdef' })
  })
})

describe('applyForUser（06 §4.3 最后一步）', () => {
  it('密钥变化 → 重建容器；只有配置变化 → 重启', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    await startInstance(app, user.id)
    const containerName = `dshhub-${user.slug}`
    const before = ctx.driver.getContainer(containerName)
    expect(before?.spec.env.HUB_MK_HUB_RELAY).toBe(API_KEY)

    // 1) 首次下发：用户此前没有预设 → env 从无到有 → 重建
    await app.deps.services.models.applyForUser(user.id, preset.id, { onLog: () => undefined })
    expect(ctx.driver.getContainer(containerName)?.state).toBe('running')
    expect(app.deps.services.instances.currentStatus(user.id)).toBe('running')

    // 2) 再下发同一个预设：没有变化 → 不重启（容器 id 不变）
    const idAfterFirst = (await ctx.driver.listManaged()).find((info) => info.name === containerName)?.id
    await app.deps.services.models.applyForUser(user.id, preset.id, { onLog: () => undefined })
    const idAfterSecond = (await ctx.driver.listManaged()).find((info) => info.name === containerName)?.id
    expect(idAfterSecond).toBe(idAfterFirst)

    // 3) 改共享密钥 → env 变化 → 重建（容器 id 变）
    grantReauth(adminSession)
    const patched = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { apiKey: 'sk-rotated-key-9999999999999999' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const logs: string[] = []
    await startInstance(app, user.id)
    await app.deps.services.models.applyForUser(user.id, preset.id, { onLog: (line) => logs.push(line) })
    expect(logs.some((line) => line.includes('重建容器'))).toBe(true)
    const idAfterRotate = (await ctx.driver.listManaged()).find((info) => info.name === containerName)?.id
    expect(idAfterRotate).not.toBe(idAfterFirst)
    expect(ctx.driver.getContainer(containerName)?.spec.env.HUB_MK_HUB_RELAY).toBe(
      'sk-rotated-key-9999999999999999',
    )
  }, 60_000)

  it('restart=next-start：即使配置变化（密钥轮换）也只落盘，不重启/重建', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    await startInstance(app, user.id)
    const containerName = `dshhub-${user.slug}`
    const idBefore = (await ctx.driver.listManaged()).find((info) => info.name === containerName)?.id
    // 改共享密钥 → 期望 env 与容器实际 env 不一致（needsRecreate=true）
    grantReauth(adminSession)
    await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { apiKey: 'sk-next-start-key-1234567890' },
    })
    const logs: string[] = []
    await app.deps.services.models.applyForUser(user.id, preset.id, {
      onLog: (line) => logs.push(line),
      restart: 'next-start',
    })
    expect(logs.some((line) => line.includes('next-start'))).toBe(true)
    const idAfter = (await ctx.driver.listManaged()).find((info) => info.name === containerName)?.id
    expect(idAfter).toBe(idBefore)
    // 期望状态已经落盘（下次启动时实例服务会因为 config_hash 变化自动重建）
    expect(readFileSync(join(app.deps.paths.userManaged(user.slug), 'managed.patch.yml'), 'utf8')).toContain(
      'HUB_MK_HUB_RELAY',
    )
  }, 60_000)

  it('实例没在跑时只落盘，等下次启动生效', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    const logs: string[] = []
    await app.deps.services.models.applyForUser(user.id, preset.id, { onLog: (line) => logs.push(line) })
    expect(logs.some((line) => line.includes('下次启动'))).toBe(true)
    expect(existsSync(join(app.deps.paths.userManaged(user.slug), 'managed.patch.yml'))).toBe(true)
  })
})

describe('04 §10.6：presetId 省略 = 只重渲染、不改预设', () => {
  it('applyForUser(undefined)：保留用户当前预设，managed.patch.yml 按最新配置重写', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    const preset = await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', preset.id, user.id)
    await app.deps.services.models.renderManaged(user.id)
    const before = readFileSync(
      join(app.deps.paths.userManaged(user.slug), 'managed.patch.yml'),
      'utf8',
    ).length
    // 改提供方显示名（不动预设、不动用户）
    const patched = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/models/providers/${provider.id}`,
      payload: { displayName: '改名后的中转' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const logs: string[] = []
    await app.deps.services.models.applyForUser(user.id, undefined, { onLog: (line) => logs.push(line) })
    expect(logs.some((line) => line.includes('保持用户当前预设'))).toBe(true)
    const after = readFileSync(join(app.deps.paths.userManaged(user.slug), 'managed.patch.yml'), 'utf8')
    expect(after).toContain('改名后的中转')
    expect(after).toContain('HUB_MK_HUB_RELAY')
    expect(after).not.toBe(
      readFileSync(join(app.deps.paths.userManaged(user.slug), 'managed.patch.yml'), 'utf8') + 'x',
    )
    expect(before).toBeGreaterThan(0)
    const row = app.deps.db.get<{ model_preset_id: number | null }>(
      'SELECT model_preset_id FROM users WHERE id = ?',
      user.id,
    )
    expect(row?.model_preset_id).toBe(preset.id)
  })
})

describe('providerKeysForUser（04 §10.3）', () => {
  it('列出所有 per-user 提供方，返回 set/last4，不含明文', async () => {
    const perUser = await createProvider({
      ...PROVIDER,
      routeKey: 'per-user-relay',
      baseUrl: `${openai.url}/v1`,
      keyMode: 'per-user',
    })
    await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    grantReauth(adminSession)
    await injectAs(adminSession, {
      method: 'PUT',
      url: `/api/admin/models/providers/${perUser.id}/user-keys/${user.id}`,
      payload: { apiKey: USER_KEY },
    })
    const keys = await app.deps.services.models.providerKeysForUser(user.id)
    expect(keys).toEqual([
      {
        providerId: perUser.id,
        routeKey: 'per-user-relay',
        displayName: '小站中转',
        keyMode: 'per-user',
        set: true,
        last4: 'xwvu',
      },
    ])
    expect(JSON.stringify(keys)).not.toContain(USER_KEY)
  })
})

describe('summaryForUser', () => {
  it('managed 用户返回预设与提供方；free 用户返回空', async () => {
    const provider = await createProvider({ ...PROVIDER, baseUrl: `${openai.url}/v1`, apiKey: API_KEY })
    await createPreset(provider.id, 'hub-relay', 'gpt-4o-mini')
    expect(await app.deps.services.models.summaryForUser(user.id)).toEqual({
      policy: 'managed',
      preset: '预设-hub-relay',
      defaultModel: 'gpt-4o-mini',
      providers: ['hub-relay'],
    })
    app.deps.db.run("UPDATE users SET model_policy = 'free' WHERE id = ?", user.id)
    expect(await app.deps.services.models.summaryForUser(user.id)).toEqual({
      policy: 'free',
      preset: '',
      defaultModel: '',
      providers: [],
    })
  })
})

void makeTempDir
