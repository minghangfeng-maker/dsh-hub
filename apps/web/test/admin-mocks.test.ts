import {
  AdminInstanceListResponseSchema,
  AdminUserResponseSchema,
  CatalogResponseSchema,
  DeletedUserListResponseSchema,
  DiscoverModelsResponseSchema,
  MatchModelsResponseSchema,
  AdminOverviewResponseSchema,
  AdminPluginListResponseSchema,
  AuditListResponseSchema,
  AuthMeResponseSchema,
  AvailableRuntimesResponseSchema,
  CreateInvitesResponseSchema,
  CreateUserResponseSchema,
  InviteListResponseSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  ModelPresetListResponseSchema,
  ModelProviderListResponseSchema,
  PluginUsersResponseSchema,
  PresetPreviewResponseSchema,
  RoleLabelListResponseSchema,
  RolloutCreatedResponseSchema,
  RolloutPreviewResponseSchema,
  RuntimeListResponseSchema,
  SettingsResponseSchema,
  UserDetailResponseSchema,
  UserListResponseSchema,
} from '@dsh-hub/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'

import { installMockFetch } from '@/mocks/fetch'
import { resolveMockScenario } from '@/mocks'
import { MOCK_SCENARIOS, getMockState, setMockScenario } from '@/mocks/state'

/**
 * 管理端假接口（11 §5：`?mock=admin`，WP6 复用 WP5b 的 `src/mocks/`）。
 *
 * 每个响应都用 `@dsh-hub/shared` 的契约 schema 校验一遍 —— 假数据一旦与 04 漂移，这里先红，
 * 不用等到页面显示「接口返回的数据不符合契约」。
 */

const restores: (() => void)[] = []

function useMock(scenario: 'admin' | 'admin-empty' | 'running'): void {
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  vi.unstubAllGlobals()
})

async function get(path: string): Promise<unknown> {
  const response = await fetch(path)
  expect(response.status, `${path} 的状态码`).toBeLessThan(400)
  return response.json()
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status, `${path} 的状态码`).toBeLessThan(400)
  return response.json()
}

async function patch(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status, `${path} 的状态码`).toBeLessThan(400)
  return response.json()
}

async function expectContract<T>(schema: ZodType<T>, value: unknown, label: string): Promise<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `${label} 不符合契约：${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`,
    )
  }
  return parsed.data
}

describe('mock 场景解析（含管理端场景）', () => {
  it('MOCK_SCENARIOS 里登记了 admin / admin-empty', () => {
    expect(MOCK_SCENARIOS).toContain('admin')
    expect(MOCK_SCENARIOS).toContain('admin-empty')
  })

  it('?mock=admin 解析为管理端场景；?mock=0 关闭', () => {
    expect(resolveMockScenario('?mock=admin', null)).toBe('admin')
    expect(resolveMockScenario('?mock=admin-empty', null)).toBe('admin-empty')
    expect(resolveMockScenario('?mock=0', 'admin')).toBeNull()
    expect(resolveMockScenario('?mock=unknown-scenario', null)).toBeNull()
  })
})

describe('管理端假数据：读取接口都满足 04 契约', () => {
  it('/api/auth/me 在 admin 场景下返回管理员（否则路由守卫会把人挡在 /admin 之外）', async () => {
    useMock('admin')
    const body = await expectContract(AuthMeResponseSchema, await get('/api/auth/me'), 'auth/me')
    expect(body.user.role).toBe('admin')
  })

  it('概览 / 用户列表 / 用户详情 / 实例', async () => {
    useMock('admin')

    const overview = await expectContract(
      AdminOverviewResponseSchema,
      await get('/api/admin/overview'),
      'overview',
    )
    expect(overview.users.total).toBeGreaterThan(0)
    expect(overview.recent.audit.length).toBeGreaterThan(0)

    const users = await expectContract(
      UserListResponseSchema,
      await get('/api/admin/users?page=1&pageSize=20'),
      'users',
    )
    expect(users.items.length).toBeGreaterThanOrEqual(6)
    expect(users.items.some((user) => user.status === 'pending')).toBe(true)

    const detail = await expectContract(
      UserDetailResponseSchema,
      await get('/api/admin/users/2'),
      'user detail',
    )
    expect(detail.user.id).toBe(2)
    expect(detail.plugins.length).toBeGreaterThan(0)
    // 04 §10.2：插件行自带名称
    expect(detail.plugins[0]?.displayName).toBeTruthy()
    expect(detail.plugins[0]?.packageName).toBeTruthy()
    // 04 §10.3：providerKeys 覆盖所有 per-user 提供方
    expect(detail.providerKeys.length).toBeGreaterThan(0)
    expect(detail.providerKeys.every((key) => key.keyMode === 'per-user')).toBe(true)
    expect(detail.providerKeys.some((key) => key.set)).toBe(true)

    const instances = await expectContract(
      AdminInstanceListResponseSchema,
      await get('/api/admin/instances'),
      'instances',
    )
    expect(instances.some((row) => row.stats !== null)).toBe(true)
  })

  it('插件 / 装机情况 / DSH 版本', async () => {
    useMock('admin')

    const plugins = await expectContract(
      AdminPluginListResponseSchema,
      await get('/api/admin/plugins'),
      'plugins',
    )
    expect(plugins.some((plugin) => plugin.configYaml.length > 0)).toBe(true)
    expect(plugins.some((plugin) => plugin.policy === 'required')).toBe(true)

    // 04 §10.1：全量用户矩阵，row=null 表示从未安装
    const rows = await expectContract(
      PluginUsersResponseSchema,
      await get('/api/admin/plugins/1/users'),
      'plugin users',
    )
    expect(rows.items.length).toBeGreaterThanOrEqual(6)
    expect(rows.items.some((item) => item.row === null)).toBe(true)
    expect(rows.items.every((item) => item.user.username.length > 0)).toBe(true)

    await expectContract(RuntimeListResponseSchema, await get('/api/admin/runtimes'), 'runtimes')
    await expectContract(
      AvailableRuntimesResponseSchema,
      await get('/api/admin/runtimes/available'),
      'available',
    )
  })

  it('模型提供方 / 预设 / 渲染预览', async () => {
    useMock('admin')

    const providers = await expectContract(
      ModelProviderListResponseSchema,
      await get('/api/admin/models/providers'),
      'providers',
    )
    expect(providers.some((provider) => provider.keyMode === 'per-user')).toBe(true)

    await expectContract(ModelPresetListResponseSchema, await get('/api/admin/models/presets'), 'presets')
    const preview = await expectContract(
      PresetPreviewResponseSchema,
      await get('/api/admin/models/presets/1/preview?userId=2'),
      'preset preview',
    )
    expect(preview.content).toContain('- id: llm-pi-ai')
    expect(preview.content).toContain('apiKeyEnv')
  })

  it('模型信息库 / 发现结果 / 按名匹配', async () => {
    useMock('admin')

    const discovered = await expectContract(
      DiscoverModelsResponseSchema,
      await post('/api/admin/models/discover', {
        api: 'openai-completions',
        baseUrl: 'https://x.example.com/v1',
      }),
      'discover',
    )
    // 四种状态都有：库匹配 / 自定义 / 端点返回 / 没匹配
    expect(new Set(discovered.models.map((model) => model.infoSource))).toEqual(
      new Set(['builtin', 'custom', 'upstream', undefined]),
    )

    const catalog = await expectContract(
      CatalogResponseSchema,
      await get('/api/admin/models/catalog'),
      'catalog',
    )
    expect(catalog.custom.length).toBeGreaterThan(0)

    const matched = await expectContract(
      MatchModelsResponseSchema,
      await post('/api/admin/models/catalog/match', { ids: ['deepseek-v4.1-flash', 'unknown-x'] }),
      'match',
    )
    expect(matched.matches.map((match) => match.id)).toEqual(['deepseek-v4.1-flash'])
  })

  it('任务列表 / 任务详情（含 task 表）', async () => {
    useMock('admin')

    const jobs = await expectContract(
      JobListResponseSchema,
      await get('/api/admin/jobs?page=1&pageSize=20'),
      'jobs',
    )
    expect(jobs.items.some((job) => job.status === 'running')).toBe(true)

    const detail = await expectContract(
      JobDetailResponseSchema,
      await get('/api/admin/jobs/1042'),
      'job detail',
    )
    expect(detail.tasks.length).toBeGreaterThan(0)
    expect(detail.tasks.some((task) => task.status === 'failed')).toBe(true)
  })

  it('邀请码 / 系统设置 / 审计', async () => {
    useMock('admin')

    const invites = await expectContract(InviteListResponseSchema, await get('/api/admin/invites'), 'invites')
    expect(invites.items.some((invite) => invite.uses.length > 0)).toBe(true)

    await expectContract(SettingsResponseSchema, await get('/api/admin/settings'), 'settings')

    const audit = await expectContract(AuditListResponseSchema, await get('/api/admin/audit?page=1'), 'audit')
    expect(audit.items.length).toBeGreaterThan(0)
  })

  it('邀请码带角色：列表有角色；role-labels 合并邀请码标签（只在码上的 count=0）', async () => {
    useMock('admin')

    const invites = await expectContract(InviteListResponseSchema, await get('/api/admin/invites'), 'invites')
    expect(invites.items.map((invite) => invite.roleLabel)).toContain('家人')

    const labels = await expectContract(
      RoleLabelListResponseSchema,
      await get('/api/admin/users/role-labels'),
      'role labels',
    )
    expect(labels.items).toContainEqual({ label: '同事', count: 0 })
  })
})

describe('管理端假数据：写接口', () => {
  it('下发预览 / 创建下发 / 新建用户 / 生成邀请码 / 保存设置', async () => {
    useMock('admin')

    const preview = await expectContract(
      RolloutPreviewResponseSchema,
      await post('/api/admin/rollouts/preview', {
        kind: 'runtime',
        runtimeId: 2,
        targets: { all: true },
        strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
      }),
      'rollout preview',
    )
    expect(preview.total).toBeGreaterThan(0)
    expect(preview.targets[0]).toHaveProperty('current')

    await expectContract(
      RolloutCreatedResponseSchema,
      await post('/api/admin/rollouts', { kind: 'models', targets: { all: true } }),
      'rollout create',
    )

    const created = await expectContract(
      CreateUserResponseSchema,
      await post('/api/admin/users', { username: 'newcomer' }),
      'create user',
    )
    expect(created.user.username).toBe('newcomer')

    const invites = await expectContract(
      CreateInvitesResponseSchema,
      await post('/api/admin/invites', { count: 3, maxUses: 1, note: '测试' }),
      'create invites',
    )
    expect(invites.items).toHaveLength(3)
    expect(invites.items[0]?.code).toMatch(/^MOCK/)

    const settings = await expectContract(
      SettingsResponseSchema,
      await patch('/api/admin/settings', { capacity: { maxRunning: 20, maxConcurrentExports: 3 } }),
      'patch settings',
    )
    expect(settings.capacity.maxRunning).toBe(20)
  })

  it('回收站（WP22）：已删除列表符合契约，恢复 / 彻底删除改假数据', async () => {
    useMock('admin')

    const deleted = await expectContract(
      DeletedUserListResponseSchema,
      await get('/api/admin/users/deleted?page=1&pageSize=20'),
      'deleted users',
    )
    expect(deleted.items.length).toBeGreaterThan(0)
    expect(deleted.items.every((item) => item.username.length > 0)).toBe(true)
    expect(deleted.items.some((item) => item.daysLeft > 0)).toBe(true)
    expect(deleted.items.some((item) => item.daysLeft <= 0)).toBe(true)

    // 原用户名已被普通用户占用 → 409 USERNAME_TAKEN（前端要把文案显示在恢复弹窗里）
    const taken = await fetch('/api/admin/users/8/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'mint' }),
    })
    expect(taken.status).toBe(409)
    const takenBody = (await taken.json()) as { error: { code: string } }
    expect(takenBody.error.code).toBe('USERNAME_TAKEN')

    // 不传 username → 用删除时的原名恢复，返回标准 `{ user }`
    const restored = await expectContract(
      AdminUserResponseSchema,
      await post('/api/admin/users/8/restore', {}),
      'restore user',
    )
    expect(restored.user.username).toBe('demo-carl')
    expect(restored.user.deletedAt).toBeNull()

    const purged = await fetch('/api/admin/users/9/purge', { method: 'POST' })
    expect(purged.status).toBe(204)

    const after = await expectContract(
      DeletedUserListResponseSchema,
      await get('/api/admin/users/deleted'),
      'deleted users after',
    )
    expect(after.items).toEqual([])
  })

  it('admin-empty：列表为空、没有可用版本（用来验引导卡与空状态）', async () => {
    useMock('admin-empty')

    const overview = await expectContract(
      AdminOverviewResponseSchema,
      await get('/api/admin/overview'),
      'empty overview',
    )
    expect(overview.users.total).toBe(0)
    expect(overview.runtime.versions).toBe(0)

    const users = await expectContract(UserListResponseSchema, await get('/api/admin/users'), 'empty users')
    expect(users.items).toEqual([])

    const plugins = await expectContract(
      AdminPluginListResponseSchema,
      await get('/api/admin/plugins'),
      'empty plugins',
    )
    expect(plugins).toEqual([])
  })
})

describe('假数据只拦 /api/**，未命中与未开启时透传真后端', () => {
  it('非管理端场景不接管 /api/admin/**（透传）', async () => {
    const fallback = vi.fn(
      async () =>
        new Response('{"passthrough":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fallback)

    useMock('running')
    const response = await fetch('/api/admin/overview')
    expect(fallback).toHaveBeenCalled()
    expect(await response.json()).toEqual({ passthrough: true })
  })

  it('管理端场景下未覆盖的路径也透传', async () => {
    const fallback = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fallback)

    useMock('admin')
    const response = await fetch('/api/admin/not-a-real-endpoint')
    expect(fallback).toHaveBeenCalled()
    expect(response.status).toBe(204)
  })

  it('非 /api 请求（静态资源等）不经过假数据', async () => {
    const fallback = vi.fn(async () => new Response('asset', { status: 200 }))
    vi.stubGlobal('fetch', fallback)

    useMock('admin')
    await fetch('/assets/main.js')
    expect(fallback).toHaveBeenCalledWith('/assets/main.js', undefined)
  })

  it('admin 场景下 getMockState().user 是管理员', () => {
    useMock('admin')
    expect(getMockState().user.role).toBe('admin')
    expect(getMockState().user.username).toBe('admin')
  })
})
