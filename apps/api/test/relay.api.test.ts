import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { grantMicro, issueKey, startFakeUpstream, systemKey, type FakeUpstream } from './helpers-relay.js'

/**
 * 管理端 / 用户端接口（12 §9）。这里**走真实 HTTP 路由**（app.inject + 会话 cookie），
 * 覆盖契约 schema、权限边界与几个容易写错的业务规则（密钥只存哈希、system 不能删、rotate 作废旧密钥…）。
 */

let ctx: TestApp | undefined
let upstream: FakeUpstream | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
  user: TestSession
  adminUser: { id: number }
  user1: { id: number }
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const user1 = await createUser(ctx.app, { username: 'alice' })
  const admin = loginAs(ctx.app, adminUser)
  const user = loginAs(ctx.app, user1)
  grantMicro(ctx.app, user1.id, 50_000_000)
  return { app: ctx, admin, user, adminUser, user1 }
}

function db(app: TestApp) {
  return app.app.deps.db
}

function api(
  app: FastifyInstance,
  session: TestSession,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: session.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
}

describe('渠道 CRUD（12 §9）', () => {
  it('建渠道（带密钥）→ 列表只回末 4 位；改/停用/删；重复名 409；非法 baseUrl 400；鉴权头 400', async () => {
    const { app, admin } = await setup()
    const created = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1/',
      apis: ['openai-completions'],
      keys: ['sk-upstream-abcdefgh1234', 'sk-upstream-abcdefgh1234', 'sk-second-key-9999'],
    })
    expect(created.statusCode).toBe(200)
    const channel = json<{
      channel: { id: number; baseUrl: string; keys: { last4: string; state: string }[] }
    }>(created).channel
    // 末尾 `/` 去掉；重复密钥去重
    expect(channel.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(channel.keys).toHaveLength(2)
    expect(channel.keys.map((key) => key.last4)).toEqual(['1234', '9999'])
    // 明文只加密存
    const stored = db(app).get<{ key_enc: string }>(
      'SELECT key_enc FROM relay_channel_keys WHERE channel_id = ? LIMIT 1',
      channel.id,
    )!
    expect(stored.key_enc.startsWith('v1:')).toBe(true)

    const list = await api(app.app, admin, 'GET', '/api/admin/relay/channels')
    expect(list.statusCode).toBe(200)
    expect(json<unknown[]>(list)).toHaveLength(1)

    const renamed = await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channel.id)}`, {
      name: 'deepseek-2',
      priority: 5,
    })
    expect(json<{ channel: { name: string; priority: number } }>(renamed).channel).toMatchObject({
      name: 'deepseek-2',
      priority: 5,
    })

    const dup = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'deepseek-2',
      baseUrl: 'https://x.example/v1',
      apis: ['openai-completions'],
    })
    expect(dup.statusCode).toBe(409)

    const badUrl = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'bad-url',
      baseUrl: 'ftp://x',
      apis: ['openai-completions'],
    })
    expect(badUrl.statusCode).toBe(400)

    const badHeader = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'bad-header',
      baseUrl: 'https://x.example/v1',
      apis: ['openai-completions'],
      headers: { Authorization: 'Bearer nope' },
    })
    expect(badHeader.statusCode).toBe(400)

    const removed = await api(app.app, admin, 'DELETE', `/api/admin/relay/channels/${String(channel.id)}`)
    expect(removed.statusCode).toBe(204)
  })

  it('有路由引用的渠道不能删（CONFLICT，details 列出模型名）', async () => {
    const { app, admin, user1 } = await setup()
    const channel = json<{ channel: { id: number } }>(
      await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
        name: 'busy',
        baseUrl: 'https://x.example/v1',
        apis: ['openai-completions'],
        keys: ['k1'],
      }),
    ).channel
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'busy-model',
      price: { inputMicro: 1000, outputMicro: 2000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })
    const res = await api(app.app, admin, 'DELETE', `/api/admin/relay/channels/${String(channel.id)}`)
    expect(res.statusCode).toBe(409)
    expect(json<{ error: { details: { models: string[] } } }>(res).error.details.models).toEqual([
      'busy-model',
    ])
    void user1
  })

  it('密钥池：批量加、改名/恢复、删除', async () => {
    const { app, admin } = await setup()
    const channel = json<{ channel: { id: number } }>(
      await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
        name: 'pool',
        baseUrl: 'https://x.example/v1',
        apis: ['openai-completions'],
      }),
    ).channel
    const added = await api(app.app, admin, 'POST', `/api/admin/relay/channels/${String(channel.id)}/keys`, {
      keys: ['key-a-1111', 'key-b-2222'],
      label: '主池',
    })
    expect(json<{ added: number; skipped: number }>(added)).toMatchObject({ added: 2, skipped: 0 })
    const keyId = json<{ channel: { keys: { id: number }[] } }>(added).channel.keys[0]!.id

    const updated = await api(
      app.app,
      admin,
      'PATCH',
      `/api/admin/relay/channels/${String(channel.id)}/keys/${String(keyId)}`,
      { label: '备用', state: 'disabled' },
    )
    expect(
      json<{ channel: { keys: { id: number; label: string; state: string }[] } }>(updated).channel.keys.find(
        (key) => key.id === keyId,
      ),
    ).toMatchObject({ label: '备用', state: 'disabled' })

    const deleted = await api(
      app.app,
      admin,
      'DELETE',
      `/api/admin/relay/channels/${String(channel.id)}/keys/${String(keyId)}`,
    )
    expect(json<{ channel: { keys: unknown[] } }>(deleted).channel.keys).toHaveLength(1)
  })

  it('测试渠道：对每把非 disabled 密钥 GET /models；发现模型带 existingModelId', async () => {
    const { app, admin } = await setup()
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }))
        return
      }
      res.writeHead(404).end()
    })
    const channel = json<{ channel: { id: number } }>(
      await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
        name: 'probe',
        baseUrl: upstream.url,
        apis: ['openai-completions'],
        keys: ['probe-key-1234'],
      }),
    ).channel

    const tested = await api(app.app, admin, 'POST', `/api/admin/relay/channels/${String(channel.id)}/test`)
    expect(tested.statusCode).toBe(200)
    const test = json<{ ok: boolean; results: { ok: boolean; httpStatus: number; last4: string }[] }>(tested)
    expect(test.ok).toBe(true)
    expect(test.results[0]).toMatchObject({ ok: true, httpStatus: 200, last4: '1234' })
    expect(upstream.requests[0]!.headers.authorization).toBe('Bearer probe-key-1234')

    const discovered = await api(
      app.app,
      admin,
      'POST',
      `/api/admin/relay/channels/${String(channel.id)}/discover`,
    )
    expect(discovered.statusCode).toBe(200)
    const models = json<{ models: { id: string; existingModelId: number | null }[] }>(discovered).models
    expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(models[0]!.existingModelId).toBeNull()
  })
})

describe('对外模型 CRUD 与导入（12 §9）', () => {
  it('建模型（info 由模型库补全）→ 改 → 导入只加路由 → 删', async () => {
    const { app, admin } = await setup()
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }))
    })
    const channel = json<{ channel: { id: number } }>(
      await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
        name: 'import-ch',
        baseUrl: upstream.url,
        apis: ['openai-completions'],
        keys: ['k-1234'],
      }),
    ).channel

    const created = await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'deepseek/deepseek-chat',
      displayName: 'DeepSeek Chat',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      info: {},
      routes: [{ channelId: channel.id, upstreamModel: 'deepseek-chat', enabled: true }],
    })
    expect(created.statusCode).toBe(200)
    const model = json<{ model: { id: number; apis: string[]; info: { contextWindow?: number } } }>(
      created,
    ).model
    // 模型名带 `/` 也合法；apis 由路由的启用渠道派生
    expect(model.apis).toEqual(['openai-completions'])

    const imported = await api(app.app, admin, 'POST', '/api/admin/relay/models/import', {
      channelId: channel.id,
      models: [
        { upstreamModel: 'deepseek-chat-v2', name: 'deepseek/deepseek-chat' },
        { upstreamModel: 'deepseek-reasoner' },
      ],
      price: { inputMicro: 500_000, outputMicro: 1_000_000 },
    })
    expect(imported.statusCode).toBe(200)
    const result = json<{ created: number; routesAdded: number; skipped: number }>(imported)
    // 同名的只加路由；新名字建一条
    expect(result).toMatchObject({ created: 1, routesAdded: 1, skipped: 0 })

    const patched = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model.id)}`, {
      enabled: false,
      price: { inputMicro: 2_000_000, outputMicro: 4_000_000 },
    })
    expect(json<{ model: { enabled: boolean } }>(patched).model.enabled).toBe(false)

    expect(
      (await api(app.app, admin, 'DELETE', `/api/admin/relay/models/${String(model.id)}`)).statusCode,
    ).toBe(204)
  })
})

describe('钱包、流水与统计（12 §9）', () => {
  it('列表含没建钱包的用户；加/扣积分写流水并返回新余额', async () => {
    const { app, admin, user1 } = await setup()
    const list = await api(app.app, admin, 'GET', '/api/admin/relay/wallets')
    expect(list.statusCode).toBe(200)
    const body = json<{ items: { userId: number; balanceMicro: number; username: string }[]; total: number }>(
      list,
    )
    expect(body.total).toBeGreaterThanOrEqual(2)
    expect(body.items.map((item) => item.username)).toContain('alice')

    const adjust = await api(app.app, admin, 'POST', `/api/admin/relay/wallets/${String(user1.id)}/adjust`, {
      amountMicro: 12_500_000,
      note: '充值',
    })
    expect(adjust.statusCode).toBe(200)
    expect(json<{ wallet: { balanceMicro: number } }>(adjust).wallet.balanceMicro).toBe(62_500_000)

    const deduct = await api(app.app, admin, 'POST', `/api/admin/relay/wallets/${String(user1.id)}/adjust`, {
      amountMicro: -2_500_000,
      note: '扣回',
    })
    expect(json<{ wallet: { balanceMicro: number } }>(deduct).wallet.balanceMicro).toBe(60_000_000)

    const ledger = await api(app.app, admin, 'GET', `/api/admin/relay/ledger?userId=${String(user1.id)}`)
    const ledgerBody = json<{ items: { type: string; amountMicro: number; balanceAfterMicro: number }[] }>(
      ledger,
    )
    expect(ledgerBody.items.map((item) => item.type)).toEqual(['deduct', 'grant', 'grant'])

    const zero = await api(app.app, admin, 'POST', `/api/admin/relay/wallets/${String(user1.id)}/adjust`, {
      amountMicro: 0,
    })
    expect(zero.statusCode).toBe(400)
  })

  it('设置读写 + 概览 + 用量/记录接口', async () => {
    const { app, admin } = await setup()
    const settings = await api(app.app, admin, 'GET', '/api/admin/relay/settings')
    expect(settings.statusCode).toBe(200)
    const initial = json<{ settings: { maxAttempts: number }; publicBaseUrl: string; internalBaseUrl: null }>(
      settings,
    )
    expect(initial.settings.maxAttempts).toBe(3)
    expect(initial.publicBaseUrl).toMatch(/\/v1$/)
    expect(initial.internalBaseUrl).toBeNull() // 测试里内部监听器关闭

    const patched = await api(app.app, admin, 'PATCH', '/api/admin/relay/settings', { maxAttempts: 5 })
    expect(json<{ settings: { maxAttempts: number } }>(patched).settings.maxAttempts).toBe(5)
    expect(
      json<{ settings: { enabled: boolean } }>(
        await api(app.app, admin, 'PATCH', '/api/admin/relay/settings', { enabled: false }),
      ).settings.enabled,
    ).toBe(false)

    const overview = await api(app.app, admin, 'GET', '/api/admin/relay/overview')
    expect(overview.statusCode).toBe(200)
    expect(json<{ enabled: boolean; internalListening: boolean }>(overview)).toMatchObject({
      enabled: false,
      internalListening: false,
    })

    for (const url of [
      '/api/admin/relay/usage',
      '/api/admin/relay/logs',
      '/api/admin/relay/models',
      '/api/admin/relay/channels',
    ]) {
      expect((await api(app.app, admin, 'GET', url)).statusCode).toBe(200)
    }
  })

  it('非管理员访问管理端一律 403；未登录 401', async () => {
    const { app, user } = await setup()
    expect((await api(app.app, user, 'GET', '/api/admin/relay/channels')).statusCode).toBe(403)
    const anon = await app.app.inject({ method: 'GET', url: '/api/admin/relay/channels' })
    expect(anon.statusCode).toBe(401)
  })
})

describe('用户端 /api/me/relay（12 §9）', () => {
  it('概览返回钱包/今日/本月/模型与 publicBaseUrl', async () => {
    const { app, admin, user } = await setup()
    const channel = json<{ channel: { id: number } }>(
      await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
        name: 'me-ch',
        baseUrl: 'https://x.example/v1',
        apis: ['openai-completions'],
        keys: ['k-1'],
      }),
    ).channel
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'visible-model',
      displayName: 'Visible',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'admin-only-model',
      visibility: 'admin',
      price: { inputMicro: 1, outputMicro: 1 },
      routes: [{ channelId: channel.id, upstreamModel: 'up2', enabled: true }],
    })

    const mine = json<{
      enabled: boolean
      wallet: { balanceMicro: number }
      publicBaseUrl: string
      dshAttached: boolean
      models: { name: string }[]
    }>(await api(app.app, user, 'GET', '/api/me/relay'))
    expect(mine.enabled).toBe(true)
    expect(mine.wallet.balanceMicro).toBe(50_000_000)
    expect(mine.models.map((model) => model.name)).toEqual(['visible-model'])
    expect(mine.dshAttached).toBe(false)

    // 管理员自己能看到 admin 可见性的模型
    const adminView = json<{ models: { name: string }[] }>(await api(app.app, admin, 'GET', '/api/me/relay'))
    expect(adminView.models.map((model) => model.name).sort()).toEqual(['admin-only-model', 'visible-model'])

    expect((await api(app.app, user, 'GET', '/api/me/relay/usage')).statusCode).toBe(200)
    expect((await api(app.app, user, 'GET', '/api/me/relay/logs')).statusCode).toBe(200)
    expect((await api(app.app, user, 'GET', '/api/me/relay/ledger')).statusCode).toBe(200)
  })

  it('用量区间跨度 > 92 天 → 400；daily 每天都有一项', async () => {
    const { app, user } = await setup()
    const tooLong = await api(app.app, user, 'GET', '/api/me/relay/usage?from=2026-01-01&to=2026-12-31')
    expect(tooLong.statusCode).toBe(400)
    const ok = json<{ from: string; to: string; daily: unknown[] }>(
      await api(app.app, user, 'GET', '/api/me/relay/usage?from=2026-10-01&to=2026-10-07'),
    )
    expect(ok.daily).toHaveLength(7)
  })

  it('密钥：只存哈希、明文只回一次、system 不能删/停用、rotate 立刻作废旧密钥', async () => {
    const { app, user, user1 } = await setup()
    const created = await api(app.app, user, 'POST', '/api/me/relay/keys', { name: 'cli' })
    expect(created.statusCode).toBe(200)
    const created2 = json<{ secret: string; key: { id: number; kind: string; preview: string } }>(created)
    expect(created2.secret).toMatch(/^sk-dsh-[0-9A-Za-z]{40}$/)
    expect(created2.key.kind).toBe('user')

    // 库里只有 sha256，没有明文，也没有 key_enc
    const row = db(app).get<{ key_hash: string; key_enc: string | null }>(
      'SELECT key_hash, key_enc FROM relay_keys WHERE id = ?',
      created2.key.id,
    )!
    expect(row.key_hash).toBe(createHash('sha256').update(created2.secret).digest('hex'))
    expect(row.key_enc).toBeNull()
    expect(JSON.stringify(db(app).all('SELECT * FROM relay_keys'))).not.toContain(created2.secret)

    // 列表里只有预览，没有明文
    const list = await api(app.app, user, 'GET', '/api/me/relay/keys')
    expect(list.body).not.toContain(created2.secret)
    expect(json<{ preview: string }[]>(list)[0]!.preview).toMatch(/^sk-dsh-.{4}…/)

    // user 密钥：不能 rotate
    const rotateUser = await api(
      app.app,
      user,
      'POST',
      `/api/me/relay/keys/${String(created2.key.id)}/rotate`,
    )
    expect(rotateUser.statusCode).toBe(400)

    // 自己造的 user 密钥可以改名/停用/删除（软删）
    const patched = await api(app.app, user, 'PATCH', `/api/me/relay/keys/${String(created2.key.id)}`, {
      name: 'cli-2',
      enabled: false,
    })
    expect(json<{ key: { name: string; enabled: boolean } }>(patched).key).toMatchObject({
      name: 'cli-2',
      enabled: false,
    })
    expect(
      (await api(app.app, user, 'DELETE', `/api/me/relay/keys/${String(created2.key.id)}`)).statusCode,
    ).toBe(204)
    expect(json<unknown[]>(await api(app.app, user, 'GET', '/api/me/relay/keys'))).toHaveLength(0)

    // system 密钥：由 containerEnv 路径签发
    const systemSecret = systemKey(app.app, user1.id)
    const keys = json<{ id: number; kind: string; enabled: boolean }[]>(
      await api(app.app, user, 'GET', '/api/me/relay/keys'),
    )
    const systemKeyRow = keys.find((key) => key.kind === 'system')!
    expect(systemKeyRow).toBeTruthy()

    expect(
      (await api(app.app, user, 'DELETE', `/api/me/relay/keys/${String(systemKeyRow.id)}`)).statusCode,
    ).toBe(400)
    expect(
      (
        await api(app.app, user, 'PATCH', `/api/me/relay/keys/${String(systemKeyRow.id)}`, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(400)

    // rotate：旧的立即失效、新的可用、needsRecreate=true
    const rotated = await api(app.app, user, 'POST', `/api/me/relay/keys/${String(systemKeyRow.id)}/rotate`)
    expect(rotated.statusCode).toBe(200)
    const rotatedBody = json<{ secret: string; needsRecreate: boolean }>(rotated)
    expect(rotatedBody.needsRecreate).toBe(true)
    expect(rotatedBody.secret).not.toBe(systemSecret)

    const withOld = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${systemSecret}` },
    })
    expect(withOld.statusCode).toBe(401)
    const withNew = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${rotatedBody.secret}` },
    })
    expect(withNew.statusCode).toBe(200)
  })

  it('用户 A 看不到也改不了 B 的密钥与记录', async () => {
    const { app, user, admin } = await setup()
    const other = await createUser(app.app, { username: 'bob' })
    const otherSession = loginAs(app.app, other)
    const bobKey = issueKey(app.app, other.id, 'bob-key')
    expect(bobKey).toMatch(/^sk-dsh-/)

    // A 的密钥列表里没有 B 的
    const mine = json<{ id: number }[]>(await api(app.app, user, 'GET', '/api/me/relay/keys'))
    expect(mine).toHaveLength(0)
    const bobKeys = json<{ id: number }[]>(await api(app.app, otherSession, 'GET', '/api/me/relay/keys'))
    const bobKeyId = bobKeys[0]!.id

    // A 改不了 B 的密钥（NOT_FOUND 而不是 403，避免探测别人的 id）
    const patch = await api(app.app, user, 'PATCH', `/api/me/relay/keys/${String(bobKeyId)}`, {
      name: 'hack',
    })
    expect(patch.statusCode).toBe(404)
    expect((await api(app.app, user, 'DELETE', `/api/me/relay/keys/${String(bobKeyId)}`)).statusCode).toBe(
      404,
    )

    // 流水也只有自己的
    const ledger = json<{ items: { userId: number }[] }>(
      await api(app.app, user, 'GET', '/api/me/relay/ledger'),
    )
    expect(ledger.items.every((item) => item.userId !== other.id)).toBe(true)
    const bobLedger = json<{ items: { userId: number }[] }>(
      await api(app.app, otherSession, 'GET', '/api/me/relay/ledger'),
    )
    expect(bobLedger.items).toHaveLength(0)
    void admin
  })
})
