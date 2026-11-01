import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DesktopManifest, RelayDshResponse } from '@dsh-hub/shared'
import { createUser, json, loginAs, type TestSession } from './helpers.js'
import { cleanupDirs, createWp3App, type Wp3TestApp } from './helpers-wp3.js'
import { deviceHeaders, loginDesktop } from './helpers-desktop.js'
import { createChannel, createRelayModel } from './helpers-relay.js'

/**
 * WP32d（docs/22 §3 的「桌面基线」另一半）：桌面勾选集合的初值。
 *
 * 老库（生产）只配过云上、从没保存过桌面模型配置 → `settings.relay_dsh_desktop` 不存在。
 * 升级后第一次启动 / 第一次渲染桌面模型片段时，勾选集合与默认模型要从云上当前配置带一份并落库，
 * 否则桌面清单里的 `llm-pi-ai` 是空的（客户端拿不到渠道模型）。写过一次之后两边各自独立。
 */

let ctx: Wp3TestApp
let app: FastifyInstance
let adminSession: TestSession
const tempDirs: string[] = []

beforeEach(async () => {
  ctx = await createWp3App({
    env: { HUB_PUBLIC_ORIGIN: 'https://hub.wp32d.test', HUB_RELAY_INTERNAL_PORT: '7834' },
  })
  app = ctx.app
  // 内部监听器不真的起（同 wp32a.platform.test.ts）
  app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7834/v1')
  const adminUser = await createUser(app, { username: 'boss', role: 'admin' })
  adminSession = loginAs(app, adminUser)
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs(tempDirs)
  tempDirs.length = 0
})

interface InjectOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
}

async function injectAs(session: TestSession, opts: InjectOpts) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: session.headers,
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  } as never)
}

/** 建一个模型（一条路由） */
async function seedModel(name: string): Promise<{ modelId: number; routeId: number }> {
  const channel = createChannel(app, {
    name: `ch-${name}`,
    baseUrl: 'https://upstream.example/v1',
    apis: ['openai-completions'],
    keys: ['k-1'],
  })
  const model = await createRelayModel(app, {
    name,
    displayName: `显示 ${name}`,
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: `显示 ${name}`, contextWindow: 128_000, maxTokens: 8_192 },
    routes: [{ channelId: channel.id, upstreamModel: `up-${name}`, enabled: true }],
  })
  const route = app.deps.db.get<{ id: number }>(
    'SELECT id FROM relay_routes WHERE model_id = ? ORDER BY id LIMIT 1',
    model.id,
  )
  if (!route) throw new Error('没有建出路由')
  return { modelId: model.id, routeId: route.id }
}

/** 渲染进 DSH 的模型 id（`<模型名>@<渠道标识>`，16 §6.2） */
function routeModelIdOf(routeId: number): string {
  const row = app.deps.db.get<{ name: string; slug: string | null; id: number }>(
    `SELECT m.name AS name, c.slug AS slug, c.id AS id
       FROM relay_routes r
       JOIN relay_models m ON m.id = r.model_id
       LEFT JOIN relay_channels c ON c.id = r.channel_id
      WHERE r.id = ?`,
    routeId,
  )
  if (!row) throw new Error(`路由 ${String(routeId)} 不存在`)
  return `${row.name}@${row.slug ?? `ch${String(row.id)}`}`
}

async function putDsh(platform: 'cloud' | 'desktop' | undefined, payload: Record<string, unknown>) {
  const res = await injectAs(adminSession, {
    method: 'PUT',
    url: `/api/admin/relay/dsh${platform === undefined ? '' : `?platform=${platform}`}`,
    payload,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<RelayDshResponse>(res)
}

/** `settings.relay_dsh_desktop` 那一行（没写过 = null） */
function desktopDshRow(): { routeIds: number[]; defaultRouteId: number | null; updatedAt: string | null } | null {
  const row = app.deps.db.get<{ value_json: string }>(
    "SELECT value_json FROM settings WHERE key = 'relay_dsh_desktop'",
  )
  if (!row) return null
  const value = JSON.parse(row.value_json) as {
    routeIds?: number[]
    defaultRouteId?: number | null
    updatedAt?: string | null
  }
  return {
    routeIds: value.routeIds ?? [],
    defaultRouteId: value.defaultRouteId ?? null,
    updatedAt: value.updatedAt ?? null,
  }
}

/** 云上当前勾选（`relay_routes.dsh_enabled = 1`） */
function cloudSelectedRouteIds(): number[] {
  return app.deps.db
    .all<{ id: number }>('SELECT id FROM relay_routes WHERE dsh_enabled = 1 ORDER BY id')
    .map((row) => row.id)
}

interface RenderedFragments {
  ids: string[]
  models: string[]
  defaultModel: string | null
}

/** 桌面系统预设渲染出来的片段（管理端「桌面配置片段 → 模型预设」用的就是它） */
async function desktopPresetFragments(): Promise<RenderedFragments> {
  const res = await injectAs(adminSession, { method: 'GET', url: '/api/admin/desktop/config/model-preset' })
  expect(res.statusCode, res.body).toBe(200)
  const body = json<{ fragments: { id: string; config: Record<string, unknown> }[] }>(res)
  // 管理端预览与下发落库的就是这份：中转站地址已换成公开 origin
  expect(JSON.stringify(body.fragments)).not.toContain('10.213.0.1')
  const llm = body.fragments.find((fragment) => fragment.id === 'llm-pi-ai')
  const providers = (llm?.config['providers'] ?? {}) as Record<string, { models: { id: string }[] }>
  const models = Object.values(providers).flatMap((provider) => provider.models.map((model) => model.id))
  const defaults = body.fragments.find((fragment) => fragment.id === 'agent-default-model')
  const model = (defaults?.config['model'] ?? null) as string | null
  return { ids: body.fragments.map((fragment) => fragment.id), models, defaultModel: model }
}

describe('桌面勾选集合的初值（docs/22 §3，WP32d）', () => {
  it('只配过云上的老库：第一次渲染前从云上带一份勾选集合与默认模型（幂等，之后各自独立）', async () => {
    const alpha = await seedModel('alpha-host')
    const beta = await seedModel('beta-host')
    await putDsh(undefined, {
      routeIds: [alpha.routeId, beta.routeId],
      defaultRouteId: beta.routeId,
    })

    // 老库现场：桌面配置从没写过
    expect(desktopDshRow()).toBeNull()

    // 第一次渲染桌面模型片段（启动基线 / 管理端预览都会走到这里）
    const rendered = await desktopPresetFragments()
    expect(rendered.ids).toEqual(['llm-pi-ai', 'agent-default-model'])
    expect(rendered.models.sort()).toEqual(
      [routeModelIdOf(alpha.routeId), routeModelIdOf(beta.routeId)].sort(),
    )
    // 默认模型 = 云上的默认路由（beta）
    expect(rendered.defaultModel).toBe(routeModelIdOf(beta.routeId))

    // 初值落库：勾选集合 = 云上勾选，默认路由 = 云上默认路由
    const seeded = desktopDshRow()
    expect(seeded?.routeIds).toEqual(cloudSelectedRouteIds())
    expect(seeded?.defaultRouteId).toBe(beta.routeId)

    // 幂等：再调一次不再写
    expect(app.deps.services.relay.ensureDesktopDshSeeded()).toEqual({
      seeded: false,
      routeIds: cloudSelectedRouteIds(),
    })

    // 之后两边各自独立：改云上勾选，桌面预设不跟着变
    await putDsh(undefined, { routeIds: [alpha.routeId], defaultRouteId: alpha.routeId })
    const after = await desktopPresetFragments()
    expect(after.models.sort()).toEqual(
      [routeModelIdOf(alpha.routeId), routeModelIdOf(beta.routeId)].sort(),
    )
    expect(desktopDshRow()?.routeIds).toEqual([alpha.routeId, beta.routeId].sort((a, b) => a - b))
  })

  it('启动基线写进清单：只配过云上时 llm-pi-ai 就有模型，重复启动不重复写', async () => {
    const gamma = await seedModel('gamma-host')
    await putDsh(undefined, { routeIds: [gamma.routeId], defaultRouteId: gamma.routeId })

    const baseline = await app.deps.services.desktopDelivery.ensureModelBaseline()
    expect(baseline.written).toBe(true)

    const alice = await createUser(app, { username: 'alice' })
    const aliceSession = loginAs(app, alice)
    const login = await loginDesktop(app, aliceSession, { name: 'WP32d 设备' })
    const manifestRes = await app.inject({
      method: 'GET',
      url: '/api/desktop/manifest',
      headers: deviceHeaders(login.token),
    })
    expect(manifestRes.statusCode, manifestRes.body).toBe(200)
    const manifest = json<DesktopManifest>(manifestRes)
    const fragments = manifest.config?.fragments ?? []
    expect([...fragments.map((fragment) => fragment.id)].sort()).toEqual(['agent-default-model', 'llm-pi-ai'])
    const llm = fragments.find((fragment) => fragment.id === 'llm-pi-ai')
    const providers = (llm?.config['providers'] ?? {}) as Record<string, { models: { id: string }[] }>
    const models = Object.values(providers).flatMap((provider) => provider.models.map((model) => model.id))
    expect(models).toEqual([routeModelIdOf(gamma.routeId)])
    // 桌面在容器网络外：baseURL 必须是公开 origin，不能是中转站内部监听器
    const baseUrls = Object.values(providers).map((provider) => (provider as { baseURL?: string }).baseURL)
    expect(baseUrls.length).toBeGreaterThan(0)
    for (const url of baseUrls) expect(url?.startsWith(app.deps.config.publicOrigin)).toBe(true)
    expect(JSON.stringify(fragments)).not.toContain('10.213.0.1')

    // 「带入模型预设 → 下发」：系统预设渲染出来的片段必须原样过白名单
    const preset = await injectAs(adminSession, { method: 'GET', url: '/api/admin/desktop/config/model-preset' })
    expect(preset.statusCode, preset.body).toBe(200)
    const presetBody = json<{ fragments: { id: string; config: Record<string, unknown> }[] }>(preset)
    const deliver = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/desktop/config',
      payload: {
        target: { scope: 'all' },
        fragments: presetBody.fragments.map((fragment) => ({ id: fragment.id, mode: 'enforce', config: fragment.config })),
      },
    })
    expect(deliver.statusCode, deliver.body).toBe(200)

    // 第二次启动（再跑一次基线）不写、不清
    const again = await app.deps.services.desktopDelivery.ensureModelBaseline()
    expect(again.written).toBe(false)
  })

  it('管理员清空过桌面配置（行存在但 routeIds 为空）：不再从云上覆盖回去', async () => {
    const alpha = await seedModel('delta-host')
    await putDsh(undefined, { routeIds: [alpha.routeId], defaultRouteId: alpha.routeId })
    // 模拟「桌面配置显式保存成空集」：行存在就代表管理员定过
    app.deps.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      'relay_dsh_desktop',
      JSON.stringify({ presetId: null, routeIds: [], defaultModelId: null, defaultRouteId: null, updatedAt: null }),
      new Date().toISOString(),
    )
    expect(app.deps.services.relay.ensureDesktopDshSeeded()).toEqual({ seeded: false, routeIds: [] })
    expect(desktopDshRow()?.routeIds).toEqual([])
  })

  it('云上也没配：不凭空写桌面配置', async () => {
    expect(app.deps.services.relay.ensureDesktopDshSeeded()).toEqual({ seeded: false, routeIds: [] })
    expect(desktopDshRow()).toBeNull()
  })
})
