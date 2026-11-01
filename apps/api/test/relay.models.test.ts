import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_KEY_ENV_PREFIX } from '@dsh-hub/shared'
import { computeConfigHash as hashSpec } from '../src/modules/instances/index.js'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { createChannel, createRelayModel, startFakeUpstream, type FakeUpstream } from './helpers-relay.js'

/**
 * hub-relay 提供方（12 §7）：DTO 的派生字段、渲染进 managed.patch.yml、containerEnv 注入 system 密钥。
 *
 * WP12a 起渲染口径变了（12 §7.0）：hub-relay 提供方只渲染**已勾选下发**（`relay_models.dsh_enabled = 1`）
 * 且 `deliverApi` 等于该提供方协议的模型；「哪些变化要重新下发」由系统预设的 revision 反映
 * （见 relay.dsh-api.test.ts / relay.dsh.test.ts）。
 *
 * WP13a：系统路由名（`hub` / `hub-<档位>` / `hub-anthropic…`）由 Hub 托管，这里测的是**手工建的旧提供方**，
 * 所以用 `hub-manual` 之类的非系统路由名（系统提供方的口径见 relay.dsh-thinking.test.ts）。
 *
 * 真容器结论（WP10a，见进度报告）：llm-pi-ai 的 `models[]` 条目**接受模型级 `compat`**
 * （`modelProfile.compat = compatProfile`，`resolveModelCompat` 会把它合并进该模型的有效 compat），
 * 所以渲染按"模型级 compat"实现，不需要退化成只支持提供方级。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

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
  userId: number
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const user = await createUser(ctx.app, { username: 'carol' })
  const admin = loginAs(ctx.app, adminUser)
  const session = loginAs(ctx.app, user)
  // 渲染 hub-relay 需要内部地址；测试里直接给一个（不起真监听器，不碰生产 7710）
  ctx.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7710/v1')
  ctx.app.deps.services.relay.setInternalListening(true)
  return { app: ctx, admin, user: session, userId: user.id }
}

async function createRelayProvider(
  app: TestApp,
  admin: TestSession,
  routeKey = 'hub-manual',
  api: 'openai-completions' | 'anthropic-messages' | 'openai-responses' = 'openai-completions',
) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/admin/models/providers',
    headers: admin.headers,
    payload: {
      routeKey,
      displayName: 'Hub 中转站',
      kind: 'hub-relay',
      api,
      keyMode: 'none',
    },
  })
  expect(res.statusCode).toBe(200)
  return json<{ provider: Record<string, unknown> }>(res).provider
}

/** 把提供方加进一个预设并让用户用它（返回 presetId） */
async function attachPreset(
  app: TestApp,
  admin: TestSession,
  providerId: number | number[],
  userId: number,
  defaultProvider = 'hub-manual',
) {
  const providerIds = Array.isArray(providerId) ? providerId : [providerId]
  const created = await app.app.inject({
    method: 'POST',
    url: '/api/admin/models/presets',
    headers: admin.headers,
    payload: {
      name: `p-${Math.random().toString(36).slice(2, 7)}`,
      providerIds,
      defaultProvider,
      defaultModel: 'relay-model',
      isDefault: true,
    },
  })
  expect(created.statusCode).toBe(200)
  const presetId = json<{ preset: { id: number } }>(created).preset.id
  expect(created.statusCode).toBe(200)
  app.app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', presetId, userId)
  return presetId
}

describe('hub-relay 提供方（12 §7）', () => {
  it('创建时只认 routeKey/displayName/api/compat/extra，其余忽略；列表回派生字段', async () => {
    const { app, admin } = await setup()
    const provider = await createRelayProvider(app, admin)
    expect(provider).toMatchObject({
      kind: 'hub-relay',
      keyMode: 'per-user',
      baseUrl: 'http://10.213.0.1:7710/v1',
      apiKey: { set: true, last4: null },
    })
    // 库里仍是 pi-ai + is_relay=1（迁移 044 的口子）
    const row = app.app.deps.db.get<{
      kind: string
      is_relay: number
      key_mode: string
      base_url: string | null
    }>('SELECT kind, is_relay, key_mode, base_url FROM model_providers WHERE id = ?', provider.id as number)!
    expect(row).toMatchObject({ kind: 'pi-ai', is_relay: 1, key_mode: 'per-user', base_url: null })
  })

  it('渲染：baseURL + models（含模型级 compat）+ apiKeyEnv；containerEnv 注入 system 密钥', async () => {
    const { app, admin, userId } = await setup()
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200).end()
    })
    const channel = createChannel(app.app, {
      name: 'relay-src',
      baseUrl: upstream.url,
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const model = await createRelayModel(app.app, {
      name: 'relay-model',
      displayName: '中转模型',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      info: { name: '中转模型', contextWindow: 128_000, maxTokens: 8_192, input: ['text', 'image'] },
      compat: { thinking: { type: 'deepseek' } },
      routes: [{ channelId: channel.id, upstreamModel: 'up-1', enabled: true }],
    })
    // WP12a：只有勾选下发的模型才会渲染（12 §7.0「渲染」）
    app.app.deps.db.run('UPDATE relay_models SET dsh_enabled = 1 WHERE id = ?', model.id)
    const provider = await createRelayProvider(app, admin)
    // 一个用户可以有多个 hub-relay 提供方（如 hub 走 openai、hub-claude 走 anthropic）
    const second = await createRelayProvider(app, admin, 'hub-claude')
    const presetId = await attachPreset(app, admin, [provider.id as number, second.id as number], userId)

    const rendered = await app.app.deps.services.models.renderManaged(userId)
    expect(rendered.content).toContain('baseURL: http://10.213.0.1:7710/v1')
    expect(rendered.content).toContain('apiKeyEnv: HUB_MK_HUB')
    expect(rendered.content).toContain('id: relay-model')
    expect(rendered.content).toContain('contextWindow: 128000')
    // 模型级 compat 写在模型条目上（12 §7.2）——真容器验证支持
    const modelBlock = rendered.content.slice(rendered.content.indexOf('id: relay-model'))
    expect(modelBlock).toContain('compat:')
    expect(modelBlock).toContain('type: deepseek')

    const env = await app.app.deps.services.models.containerEnv(userId)
    expect(Object.keys(env)).toEqual(['HUB_MK_HUB'])
    expect(env.HUB_MK_HUB).toMatch(/^sk-dsh-[0-9A-Za-z]{40}$/)
    // WP13：多个 hub-relay 提供方共用同一个 env 名（同一把 system 密钥），不再按路由名各注入一个
    expect(rendered.content).not.toContain(`${PROVIDER_KEY_ENV_PREFIX}HUB_CLAUDE`)
    void presetId
  })

  it('内部监听器关闭 → 不渲染该提供方并给警告；baseUrl 为 null', async () => {
    const { app, admin, userId } = await setup()
    const provider = await createRelayProvider(app, admin)
    await attachPreset(app, admin, provider.id as number, userId)
    app.app.deps.services.relay.setInternalBaseUrl(null)
    app.app.deps.services.relay.setInternalListening(false)

    const rendered = await app.app.deps.services.models.renderManaged(userId)
    expect(rendered.content).not.toContain('baseURL: http://10.213.0.1:7710/v1')
    expect(rendered.warnings.join('\n')).toContain('内部监听器没在监听')

    const dto = json<{ id: number; baseUrl: string | null }[]>(
      await app.app.inject({ method: 'GET', url: '/api/admin/models/providers', headers: admin.headers }),
    )
    expect(dto[0]!.baseUrl).toBeNull()
  })

  it('未勾选下发的模型不渲染；勾选后立刻出现（12 §7.0「渲染」）', async () => {
    const { app, admin, userId } = await setup()
    const provider = await createRelayProvider(app, admin)
    await attachPreset(app, admin, provider.id as number, userId)
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200).end()
    })
    const channel = createChannel(app.app, {
      name: 'select-ch',
      baseUrl: upstream.url,
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const model = await createRelayModel(app.app, {
      name: 'select-me',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })

    const before = await app.app.deps.services.models.renderManaged(userId)
    expect(before.content).not.toContain('id: select-me')

    app.app.deps.db.run('UPDATE relay_models SET dsh_enabled = 1 WHERE id = ?', model.id)
    const after = await app.app.deps.services.models.renderManaged(userId)
    expect(after.content).toContain('id: select-me')

    // 取消勾选（PUT 会把其余全部置 0）后又消失
    app.app.deps.services.relay.updateDsh({ modelIds: [], defaultModelId: null }, 1, META)
    const cleared = await app.app.deps.services.models.renderManaged(userId)
    expect(cleared.content).not.toContain('id: select-me')
  })

  it('一个模型同时支持 openai 与 anthropic → 只渲染在一个协议下（12 §7.0）', async () => {
    const { app, admin, userId } = await setup()
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200).end()
    })
    const both = createChannel(app.app, {
      name: 'both-apis',
      baseUrl: upstream.url,
      apis: ['openai-completions', 'anthropic-messages'],
      keys: ['k-1'],
    })
    const model = await createRelayModel(app.app, {
      name: 'dual-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: both.id, upstreamModel: 'up', enabled: true }],
    })
    app.app.deps.db.run('UPDATE relay_models SET dsh_enabled = 1 WHERE id = ?', model.id)
    const openai = await createRelayProvider(app, admin, 'hub-manual')
    const anthropic = await createRelayProvider(app, admin, 'hub-manual-2', 'anthropic-messages')
    await attachPreset(app, admin, [openai.id as number, anthropic.id as number], userId)

    const rendered = await app.app.deps.services.models.renderManaged(userId)
    expect(rendered.content).toContain('id: dual-model')
    // 只渲染在一个协议下：openai-completions 里有，anthropic-messages 里没有
    const service = app.app.deps.services.relay
    expect(service.providerModels('openai-completions', { admin: true }).map((m) => m.id)).toEqual([
      'dual-model@both-apis',
    ])
    expect(service.providerModels('anthropic-messages', { admin: true })).toEqual([])
    // WP13：没有任何可见模型的提供方整条不渲染（DSH 会拒绝空 models 的路由），所以 patch 里只有一条路由
    const content = rendered.content
    const providers = content.slice(content.indexOf('llm-pi-ai'))
    expect(providers).toContain('hub-manual:')
    expect(providers).not.toContain('hub-manual-2:')
    expect(rendered.warnings.join('\n')).toContain('hub-manual-2 对该用户没有可渲染的模型')
  })

  it('dshAttached：生效预设里有启用的 hub-relay 提供方', async () => {
    const { app, admin, userId, user } = await setup()
    expect(
      json<{ dshAttached: boolean }>(
        await app.app.inject({ method: 'GET', url: '/api/me/relay', headers: user.headers }),
      ).dshAttached,
    ).toBe(false)
    const provider = await createRelayProvider(app, admin)
    await attachPreset(app, admin, provider.id as number, userId)
    expect(
      json<{ dshAttached: boolean }>(
        await app.app.inject({ method: 'GET', url: '/api/me/relay', headers: user.headers }),
      ).dshAttached,
    ).toBe(true)
  })

  it('rotate system 密钥 → containerEnv 与 config_hash 都变', async () => {
    const { app, admin, userId } = await setup()
    const provider = await createRelayProvider(app, admin)
    await attachPreset(app, admin, provider.id as number, userId)

    const envBefore = await app.app.deps.services.models.containerEnv(userId)
    const spec = {
      name: 'dshhub-test',
      image: 'dshhub/runtime:0.2.0-rc.2',
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 1024,
      readOnlyRootfs: true,
      env: envBefore,
      mounts: [],
      labels: {},
      network: 'dshhub-users',
      tmpfs: {},
    }
    const hashBefore = hashSpec(spec)

    const keys = await app.app.deps.services.relay.listKeys(userId)
    const systemKeyRow = keys.find((key) => key.kind === 'system')!
    app.app.deps.services.relay.rotateSystemKey(userId, userId, META)

    const envAfter = await app.app.deps.services.models.containerEnv(userId)
    expect(envAfter.HUB_MK_HUB).not.toBe(envBefore.HUB_MK_HUB)
    expect(hashSpec({ ...spec, env: envAfter })).not.toBe(hashBefore)
    void systemKeyRow
  })
})
