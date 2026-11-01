import {
  AddRelayChannelKeysResponseSchema,
  DiscoverRelayChannelResponseSchema,
  JobDetailResponseSchema,
  ImportRelayModelsResponseSchema,
  MyRelayResponseSchema,
  RelayChannelListResponseSchema,
  RelayChannelResponseSchema,
  RelayDshResponseSchema,
  RelayKeyListResponseSchema,
  RelayKeySecretResponseSchema,
  RelayLedgerListResponseSchema,
  RelayModelListResponseSchema,
  RelayModelResponseSchema,
  RelayOverviewResponseSchema,
  RelaySettingsResponseSchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsResponseSchema,
  RelayWalletListResponseSchema,
  RelayWalletResponseSchema,
  TestRelayChannelResponseSchema,
} from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'

/**
 * 中转站假数据（WP10b 交付物 5，12 §9）：每个响应都过一遍 shared 的契约 schema，
 * 写接口要真的改假状态 —— 假数据漂了先在这里红，而不是走查时页面白屏。
 */

const restores: (() => void)[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
})

function expectContract<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `${label} 不符合契约：${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`,
    )
  }
  return parsed.data
}

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, payload: text ? JSON.parse(text) : null }
}

async function getJson<T>(schema: ZodType<T>, path: string, label: string): Promise<T> {
  const { status, payload } = await request('GET', path)
  expect(status, `${path} 的状态码`).toBeLessThan(400)
  return expectContract(schema, payload, label)
}

describe('用户端中转站假数据（?mock=1）', () => {
  it('GET /api/me/relay：钱包 + 今日/本月 + 可用模型 + 接入地址', async () => {
    useMock('running')
    const data = await getJson(MyRelayResponseSchema, '/api/me/relay', 'MyRelayResponse')

    expect(data.enabled).toBe(true)
    expect(data.wallet.balanceMicro).toBeGreaterThan(0)
    expect(data.publicBaseUrl).toMatch(/^https?:\/\//)
    expect(data.models.length).toBeGreaterThanOrEqual(3)
    expect(data.models.some((model) => model.name === 'deepseek-v4.1-flash')).toBe(true)
    // 价格是「微积分 / 百万 token」：输入 1 积分、输出 2 积分、缓存 0.1 积分
    const flash = data.models.find((model) => model.name === 'deepseek-v4.1-flash')
    expect(flash?.price).toMatchObject({
      inputMicro: 1_000_000,
      outputMicro: 2_000_000,
      cacheReadMicro: 100_000,
    })
    // 15 §3.2：已下发的标记 inDsh，默认模型带 dshDefault；未下发的模型也在列表里（前端自己过滤）
    expect(flash?.inDsh).toBe(true)
    expect(flash?.dshDefault).toBe(true)
    expect(data.models.some((model) => model.inDsh === false)).toBe(true)
  })

  it('GET /api/me/relay/usage：每天一项、区间默认近 30 天、用户端没有 byUser/byChannel', async () => {
    useMock('running')
    const stats = await getJson(RelayUsageStatsResponseSchema, '/api/me/relay/usage', 'RelayUsageStats')

    expect(stats.daily).toHaveLength(30)
    expect(stats.from < stats.to).toBe(true)
    expect(stats.total.requests).toBeGreaterThan(0)
    expect(stats.total.costMicro).toBeGreaterThan(0)
    expect(stats.daily.some((day) => day.requests > 0)).toBe(true)
    expect(stats.byModel.length).toBeGreaterThan(0)
    // 16 §3：按模型统计按请求时的原始名字分组 → 带 @ 与不带 @ 都要有
    expect(stats.byModel.some((row) => row.model.includes('@'))).toBe(true)
    expect(stats.byModel.some((row) => !row.model.includes('@'))).toBe(true)
    expect(stats.byUser).toEqual([])
    expect(stats.byChannel).toEqual([])

    const week = await getJson(
      RelayUsageStatsResponseSchema,
      '/api/me/relay/usage?from=2026-01-01&to=2026-01-07',
      'RelayUsageStats(week)',
    )
    expect(week.daily).toHaveLength(7)
  })

  it('GET /api/me/relay/logs 与 /ledger：只看自己，逐条记录不带渠道', async () => {
    useMock('running')
    const logs = await getJson(RelayUsageLogResponseSchema, '/api/me/relay/logs', 'RelayUsageLog')
    expect(logs.items.length).toBeGreaterThan(0)
    expect(logs.items.every((row) => row.userId === 12)).toBe(true)
    expect(logs.items.every((row) => row.channelId === null && row.channelName === null)).toBe(true)
    expect(new Set(logs.items.map((row) => row.status)).size).toBeGreaterThan(1)
    expect(logs.items.some((row) => row.estimated)).toBe(true)

    const ledger = await getJson(RelayLedgerListResponseSchema, '/api/me/relay/ledger', 'RelayLedger')
    expect(ledger.items.every((row) => row.userId === 12)).toBe(true)
  })

  it('密钥：列表有 system；新建后明文只回一次；system 不能删也不能停用；rotate 需要重建容器', async () => {
    useMock('running')
    const keys = await getJson(RelayKeyListResponseSchema, '/api/me/relay/keys', 'RelayKeyList')
    expect(keys.some((key) => key.kind === 'system')).toBe(true)

    const created = await request('POST', '/api/me/relay/keys', { name: 'CI 机器人' })
    expect(created.status).toBe(201)
    const secret = expectContract(RelayKeySecretResponseSchema, created.payload, 'RelayKeySecret')
    expect(secret.secret.startsWith('sk-dsh-')).toBe(true)
    expect(secret.key.kind).toBe('user')
    expect(secret.needsRecreate).toBe(false)

    const after = await getJson(RelayKeyListResponseSchema, '/api/me/relay/keys', 'RelayKeyList')
    expect(after).toHaveLength(keys.length + 1)
    // 列表里只有 preview，没有明文
    expect(JSON.stringify(after)).not.toContain(secret.secret)

    const system = keys.find((key) => key.kind === 'system')!
    const disabled = await request('PATCH', `/api/me/relay/keys/${system.id}`, { enabled: false })
    expect(disabled.status).toBe(400)
    const removed = await request('DELETE', `/api/me/relay/keys/${system.id}`)
    expect(removed.status).toBe(400)

    const rotated = await request('POST', `/api/me/relay/keys/${system.id}/rotate`)
    const rotatedSecret = expectContract(
      RelayKeySecretResponseSchema,
      rotated.payload,
      'RelayKeySecret(rotate)',
    )
    expect(rotatedSecret.needsRecreate).toBe(true)
    expect(rotatedSecret.secret).not.toBe(secret.secret)
  })

  it('?mock=relay-off：未开通（enabled=false、没有模型、导航隐藏）', async () => {
    useMock('relay-off')
    const data = await getJson(MyRelayResponseSchema, '/api/me/relay', 'MyRelayResponse(off)')
    expect(data.enabled).toBe(false)
    expect(data.models).toEqual([])
    expect(data.dshAttached).toBe(false)
  })

  it('19 §3：dailyByModel 给足 7 个以上模型、含同名不同渠道与 Claude Code 来源，且只给有用量的格子', async () => {
    useMock('running')
    const stats = await getJson(RelayUsageStatsResponseSchema, '/api/me/relay/usage', 'RelayUsageStats')

    const rows = stats.dailyByModel ?? []
    expect(rows.length).toBeGreaterThan(0)
    // 只给有用量的格子
    expect(rows.every((row) => row.requests > 0 || row.costMicro > 0 || row.inputTokens > 0)).toBe(true)
    // 日期落在区间里、按 day 升序
    const days = [...new Set(rows.map((row) => row.day))]
    expect(days[0]! >= stats.from).toBe(true)
    expect(days.at(-1)! <= stats.to).toBe(true)
    expect([...days].sort()).toEqual(days)

    const models = new Set(rows.map((row) => row.model))
    expect(models.size).toBeGreaterThanOrEqual(7)
    // 同名模型的不同渠道各是一条（`模型@渠道`）
    expect([...models].some((model) => model.startsWith('deepseek-v4.1-flash@'))).toBe(true)
    /**
     * 同一个模型既要出现「不带 @ 的原始名」、也要出现「@渠道」——16 §3 按请求时的原始名字分组。
     * 假用量是按天随机造的（`rng(dayIndex)`），滚动 30 天窗口里具体覆盖哪几个模型每天都会变，
     * 所以断言「至少有一组同名并存」，不钉死某一个模型（2026-10-29 这条因为窗口滚动失败过一次）。
     */
    const bareModels = new Set([...models].filter((model) => !model.includes('@')))
    expect(
      [...models].some((model) => model.includes('@') && bareModels.has(model.slice(0, model.indexOf('@')))),
    ).toBe(true)
    // 来自 Claude Code 的用量（来源筛选的素材）
    expect([...models].some((model) => model.startsWith('claude-'))).toBe(true)
    // 有几天全 0：区间里不是每天都有用量
    expect(days.length).toBeLessThan(stats.daily.length)

    // from/to 生效
    const week = await getJson(
      RelayUsageStatsResponseSchema,
      '/api/me/relay/usage?from=2026-01-01&to=2026-01-07',
      'RelayUsageStats(week)',
    )
    expect(week.dailyByModel).toEqual([])

    // scope 生效
    const claude = await getJson(
      RelayUsageStatsResponseSchema,
      '/api/me/relay/usage?scope=claude-code',
      'RelayUsageStats(claude)',
    )
    expect(claude.dailyByModel!.length).toBeGreaterThan(0)
    expect(claude.dailyByModel!.every((row) => row.model.startsWith('claude-'))).toBe(true)
  })

  it('?mock=usage-empty：开通着但区间内没有用量（统计、记录、dailyByModel 都是空）', async () => {
    useMock('usage-empty')
    const stats = await getJson(
      RelayUsageStatsResponseSchema,
      '/api/me/relay/usage',
      'RelayUsageStats(empty)',
    )
    expect(stats.total.requests).toBe(0)
    expect(stats.total.costMicro).toBe(0)
    expect(stats.daily.every((day) => day.requests === 0)).toBe(true)
    expect(stats.dailyByModel).toEqual([])
    expect(stats.byModel).toEqual([])

    const logs = await getJson(RelayUsageLogResponseSchema, '/api/me/relay/logs', 'RelayUsageLog(empty)')
    expect(logs.items).toEqual([])
    expect(logs.total).toBe(0)
  })
})

describe('管理端中转站假数据（?mock=admin）', () => {
  it('概览：统计 + 内部地址 + 渠道健康 + 各类告警', async () => {
    useMock('admin')
    const overview = await getJson(RelayOverviewResponseSchema, '/api/admin/relay/overview', 'RelayOverview')

    expect(overview.enabled).toBe(true)
    expect(overview.internalListening).toBe(true)
    expect(overview.internalBaseUrl).toBe('http://10.213.0.1:7710/v1')
    expect(overview.today.requests).toBeGreaterThan(0)
    expect(overview.month.requests).toBeGreaterThanOrEqual(overview.today.requests)
    expect(overview.channels.total).toBeGreaterThanOrEqual(3)
    expect(overview.models.total).toBeGreaterThanOrEqual(6)
    expect(overview.totalBalanceMicro).toBeGreaterThan(0)

    const kinds = overview.alerts.map((alert) => alert.kind)
    for (const kind of [
      'key-auto-disabled',
      'channel-cooling',
      'channel-no-key',
      'usage-missing',
      'models-changed',
    ]) {
      expect(kinds).toContain(kind)
    }
    expect(new Set(overview.alerts.map((alert) => alert.level))).toEqual(new Set(['warn', 'error']))
  })

  it('设置：读写一致，内部 / 公网地址只读', async () => {
    useMock('admin')
    const settings = await getJson(RelaySettingsResponseSchema, '/api/admin/relay/settings', 'RelaySettings')
    expect(settings.settings.enabled).toBe(true)
    expect(settings.publicBaseUrl).toMatch(/^https?:\/\//)

    const patched = await request('PATCH', '/api/admin/relay/settings', { maxAttempts: 5 })
    const next = expectContract(RelaySettingsResponseSchema, patched.payload, 'RelaySettings(patch)')
    expect(next.settings.maxAttempts).toBe(5)
    expect(next.settings.keyCooldownSeconds).toBe(settings.settings.keyCooldownSeconds)
  })

  it('渠道：upstream-c 池有两把密钥（一把 auto-disabled）、upstream-b ×0.1、official 支持两个协议', async () => {
    useMock('admin')
    const channels = await getJson(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels',
      'RelayChannelList',
    )

    const pool = channels.find((channel) => channel.slug === 'upstream-c')
    expect(pool?.name).toBe('Upstream C 池')
    expect(pool?.apis).toEqual(['openai-completions'])
    expect(pool?.keys).toHaveLength(2)
    expect(pool?.keys.some((key) => key.state === 'auto-disabled')).toBe(true)
    expect(pool?.keys.find((key) => key.state === 'auto-disabled')?.lastError).toBeTruthy()

    const backup = channels.find((channel) => channel.slug === 'upstream-b')
    expect(backup?.ratePermille).toBe(100)
    expect(backup?.enabled).toBe(true)

    const official = channels.find((channel) => channel.slug === 'official')
    expect(official?.apis).toEqual(expect.arrayContaining(['openai-completions', 'anthropic-messages']))
    expect(official?.ratePermille).toBe(1000)
    expect(channels.map((channel) => channel.slug)).toEqual(['upstream-c', 'upstream-b', 'official'])
    expect(channels.some((channel) => channel.health === 'disabled')).toBe(true)
  })

  it('渠道：测试 / 发现模型 / 批量加密钥 / 启停 / 删除被引用时 CONFLICT 带模型名', async () => {
    useMock('admin')

    const tested = await request('POST', '/api/admin/relay/channels/1/test')
    const test = expectContract(TestRelayChannelResponseSchema, tested.payload, 'TestRelayChannel')
    expect(test.results).toHaveLength(2)
    expect(test.results.some((row) => !row.ok && row.httpStatus === 401)).toBe(true)

    const discovered = await request('POST', '/api/admin/relay/channels/1/discover')
    const found = expectContract(
      DiscoverRelayChannelResponseSchema,
      discovered.payload,
      'DiscoverRelayChannel',
    )
    expect(found.models.length).toBeGreaterThan(0)
    expect(found.models.some((model) => model.existingModelId !== null)).toBe(true)

    const added = await request('POST', '/api/admin/relay/channels/1/keys', {
      keys: ['sk-upstream-new-key-1234', 'sk-upstream-new-key-1234', 'sk-upstream-second-5678'],
      label: '批量',
    })
    const result = expectContract(AddRelayChannelKeysResponseSchema, added.payload, 'AddRelayChannelKeys')
    expect(result.added).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.channel.keys).toHaveLength(4)

    const key = result.channel.keys.find((item) => item.state === 'auto-disabled')!
    const restored = await request('PATCH', `/api/admin/relay/channels/1/keys/${key.id}`, { state: 'active' })
    const afterRestore = expectContract(RelayChannelResponseSchema, restored.payload, 'RelayChannel(restore)')
    // 渠道本身还是停用的，恢复一把密钥不会把整个渠道变成健康
    expect(afterRestore.channel.health).toBe('disabled')
    expect(afterRestore.channel.keys.find((item) => item.id === key.id)?.lastError).toBeNull()

    const deleted = await request('DELETE', `/api/admin/relay/channels/1/keys/${key.id}`)
    expect(
      expectContract(RelayChannelResponseSchema, deleted.payload, 'RelayChannel(del key)').channel.keys,
    ).toHaveLength(3)

    const conflict = await request('DELETE', '/api/admin/relay/channels/1')
    expect(conflict.status).toBe(409)
    expect((conflict.payload as { error: { code: string; details: { models?: string[] } } }).error.code).toBe(
      'CONFLICT',
    )
    expect(
      (conflict.payload as { error: { details: { models?: string[] } } }).error.details.models?.length,
    ).toBeGreaterThan(0)
  })

  it('模型与价格：deepseek-v4.1-flash 三条路由；import 给已有模型只加路由', async () => {
    useMock('admin')
    const models = await getJson(RelayModelListResponseSchema, '/api/admin/relay/models', 'RelayModelList')
    const flash = models.find((model) => model.name === 'deepseek-v4.1-flash')
    expect(flash?.routes).toHaveLength(3)
    expect(flash?.price.inputMicro).toBe(1_000_000)
    expect(flash?.apis).toContain('anthropic-messages')
    // 有一个 admin 可见、一个停用的模型，页面上能看到「停用 / 仅管理员」
    expect(models.some((model) => model.visibility === 'admin')).toBe(true)
    expect(models.some((model) => !model.enabled)).toBe(true)

    const imported = await request('POST', '/api/admin/relay/models/import', {
      channelId: 2,
      models: [
        { upstreamModel: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
        { upstreamModel: 'openrouter/auto', name: 'openrouter-auto', displayName: 'OpenRouter Auto' },
      ],
      price: { inputMicro: 2_000_000, outputMicro: 4_000_000, perRequestMicro: 0 },
    })
    const result = expectContract(ImportRelayModelsResponseSchema, imported.payload, 'ImportRelayModels')
    expect(result.created).toBe(1)
    expect(result.routesAdded).toBe(1)

    const created = result.models.find((model) => model.name === 'openrouter-auto')
    expect(created?.routes[0]?.channelSlug).toBe('upstream-b')
    expect(created?.price.inputMicro).toBe(2_000_000)

    const patched = await request('PATCH', `/api/admin/relay/models/${flash!.id}`, {
      price: { inputMicro: 900_000, outputMicro: 1_800_000, perRequestMicro: 0 },
      routes: [{ channelId: 2, upstreamModel: 'deepseek-chat' }],
    })
    const updated = expectContract(RelayModelResponseSchema, patched.payload, 'RelayModel(patch)')
    expect(updated.model.price.inputMicro).toBe(900_000)
    expect(updated.model.routes).toHaveLength(1)
    expect(updated.model.apis).toEqual(['openai-completions'])
  })

  it('钱包：列表含负余额；加/扣积分改余额并写流水；设置改倍率与日上限', async () => {
    useMock('admin')
    const wallets = await getJson(
      RelayWalletListResponseSchema,
      '/api/admin/relay/wallets',
      'RelayWalletList',
    )
    expect(wallets.items.length).toBeGreaterThanOrEqual(4)
    expect(wallets.items.some((row) => row.balanceMicro < 0)).toBe(true)
    expect(wallets.items.some((row) => row.monthCostMicro > 0)).toBe(true)

    const before = await getJson(RelayWalletResponseSchema, '/api/admin/relay/wallets/2', 'RelayWallet')
    const granted = await request('POST', '/api/admin/relay/wallets/2/adjust', {
      amountMicro: 5_000_000,
      note: '手动充值',
    })
    const afterGrant = expectContract(RelayWalletResponseSchema, granted.payload, 'RelayWallet(grant)')
    expect(afterGrant.wallet.balanceMicro).toBe(before.wallet.balanceMicro + 5_000_000)

    const deducted = await request('POST', '/api/admin/relay/wallets/2/adjust', {
      amountMicro: -2_000_000,
      note: '扣回',
    })
    const afterDeduct = expectContract(RelayWalletResponseSchema, deducted.payload, 'RelayWallet(deduct)')
    expect(afterDeduct.wallet.balanceMicro).toBe(before.wallet.balanceMicro + 3_000_000)

    const zero = await request('POST', '/api/admin/relay/wallets/2/adjust', { amountMicro: 0 })
    expect(zero.status).toBe(400)

    const settings = await request('PATCH', '/api/admin/relay/wallets/2', {
      ratePercent: 50,
      maxConcurrency: 1,
      dailyLimitMicro: 1_000_000,
      enabled: false,
    })
    const updated = expectContract(RelayWalletResponseSchema, settings.payload, 'RelayWallet(patch)')
    expect(updated.wallet).toMatchObject({
      ratePercent: 50,
      maxConcurrency: 1,
      dailyLimitMicro: 1_000_000,
      enabled: false,
    })

    const ledger = await getJson(
      RelayLedgerListResponseSchema,
      '/api/admin/relay/ledger?userId=2',
      'RelayLedger(admin)',
    )
    expect(ledger.items.every((row) => row.userId === 2)).toBe(true)
    expect(ledger.items[0]?.note).toBe('扣回')
    expect(ledger.items[0]?.actor).toBe('admin')
  })

  it('用量：区间汇总有 byUser/byChannel；逐条记录可按用户/状态筛选', async () => {
    useMock('admin')
    const stats = await getJson(
      RelayUsageStatsResponseSchema,
      '/api/admin/relay/usage',
      'RelayUsageStats(admin)',
    )
    expect(stats.daily).toHaveLength(30)
    expect(stats.byUser.length).toBeGreaterThan(1)
    expect(stats.byChannel.length).toBeGreaterThan(1)
    expect(stats.byModel.length).toBeGreaterThan(1)
    expect(stats.byUser.reduce((sum, row) => sum + row.requests, 0)).toBe(stats.total.requests)
    expect(stats.byChannel.reduce((sum, row) => sum + row.costMicro, 0)).toBe(stats.total.costMicro)

    const logs = await getJson(
      RelayUsageLogResponseSchema,
      '/api/admin/relay/logs?status=client_error',
      'RelayUsageLog(client_error)',
    )
    expect(logs.items.length).toBeGreaterThan(0)
    expect(logs.items.every((row) => row.status === 'client_error')).toBe(true)
    expect(logs.items.every((row) => row.channelName !== null)).toBe(true)

    const byUser = await getJson(
      RelayUsageLogResponseSchema,
      '/api/admin/relay/logs?userId=2',
      'RelayUsageLog(user)',
    )
    expect(byUser.items.every((row) => row.userId === 2)).toBe(true)
  })
})

describe('WP11b 渠道倍率与未定价（12 §6.2 §10）', () => {
  it('渠道带 ratePermille（upstream-c ×0.3、upstream-b ×0.1、official ×1），路由带渠道标识与倍率快照', async () => {
    useMock('admin')
    const channels = await getJson(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels',
      'RelayChannelList',
    )
    expect(channels.map((channel) => [channel.slug, channel.ratePermille])).toEqual([
      ['upstream-c', 300],
      ['upstream-b', 100],
      ['official', 1000],
    ])

    const models = await getJson(RelayModelListResponseSchema, '/api/admin/relay/models', 'RelayModelList')
    const flash = models.find((model) => model.name === 'deepseek-v4.1-flash')!
    expect(flash.routes).toHaveLength(3)
    expect(flash.routes.map((route) => route.channelSlug)).toEqual(['upstream-c', 'upstream-b', 'official'])
    expect(flash.routes.find((route) => route.channelSlug === 'upstream-c')?.channelRatePermille).toBe(300)
    expect(flash.routes.filter((route) => route.channelRatePermille === 100)).toHaveLength(1)
  })

  it('用户端模型：routes 只含启用渠道上的启用路由，三条渠道的模型用户看到两条', async () => {
    useMock('running')
    const data = await getJson(MyRelayResponseSchema, '/api/me/relay', 'MyRelayResponse')

    const flash = data.models.find((model) => model.name === 'deepseek-v4.1-flash')
    // upstream-c 停用 → 用户端只有 upstream-b / official 两条
    expect(flash?.routes?.map((route) => route.channelSlug)).toEqual(['upstream-b', 'official'])
    expect(flash?.routes?.map((route) => route.pinnedModel)).toEqual([
      'deepseek-v4.1-flash@upstream-b',
      'deepseek-v4.1-flash@official',
    ])
    expect(flash?.routes?.find((route) => route.channelSlug === 'upstream-b')?.inDsh).toBe(true)
    expect(flash?.routes?.find((route) => route.channelSlug === 'upstream-b')?.dshDefault).toBe(true)
    expect(flash?.routes?.find((route) => route.channelSlug === 'official')?.inDsh).toBe(true)
    expect(flash?.routes?.find((route) => route.channelSlug === 'official')?.dshDefault).toBe(false)
    expect(flash?.channelRate).toEqual({ minPermille: 100, maxPermille: 1000 })

    // 只挂一条渠道
    const coder = data.models.find((model) => model.name === 'qwen3-coder')
    expect(coder?.routes).toHaveLength(1)
    expect(coder?.channelRate).toEqual({ minPermille: 100, maxPermille: 100 })

    // 无渠道的模型（`apis` 为空）压根不会渲染给用户
    expect(data.models.some((model) => model.name === 'kimi-k2-thinking')).toBe(false)
  })

  it('用量记录带 channelRatePermille（没走到渠道的是 null）', async () => {
    useMock('admin')
    const logs = await getJson(RelayUsageLogResponseSchema, '/api/admin/relay/logs', 'RelayUsageLog')
    expect(logs.items.some((row) => row.channelRatePermille === 300)).toBe(true)
    expect(logs.items.some((row) => row.channelRatePermille === 100)).toBe(true)
    expect(logs.items.some((row) => row.channelRatePermille === 1000)).toBe(true)
    // 上游错误（换遍候选没成功）没有计费渠道 → null
    expect(
      logs.items
        .filter((row) => row.status === 'upstream_error')
        .every((row) => row.channelRatePermille === null),
    ).toBe(true)

    // 用户端也返回倍率（不带渠道名），用来解释费用
    useMock('running')
    const mine = await getJson(RelayUsageLogResponseSchema, '/api/me/relay/logs', 'RelayUsageLog(me)')
    expect(mine.items.every((row) => row.channelId === null)).toBe(true)
    expect(mine.items.some((row) => row.channelRatePermille !== null)).toBe(true)
    expect(mine.items.some((row) => row.model.includes('@'))).toBe(true)
    expect(mine.items.some((row) => !row.model.includes('@'))).toBe(true)
    expect(mine.items.some((row) => row.channelSlug !== null)).toBe(true)
  })

  it('概览告警有 models-unpriced（2 个未定价模型、点名）', async () => {
    useMock('admin')
    const overview = await getJson(RelayOverviewResponseSchema, '/api/admin/relay/overview', 'RelayOverview')
    const alert = overview.alerts.find((item) => item.kind === 'models-unpriced')
    expect(alert, '应有 models-unpriced 告警').toBeTruthy()
    expect(alert?.level).toBe('warn')
    expect(alert?.message).toContain('2 个模型还没定价')
    expect(alert?.message).toContain('glm-4.7-air')

    const models = await getJson(RelayModelListResponseSchema, '/api/admin/relay/models', 'RelayModelList')
    const unpriced = models.filter(
      (model) => model.enabled && model.price.inputMicro === 0 && model.price.outputMicro === 0,
    )
    expect(unpriced.map((model) => model.name).sort()).toEqual(['glm-4.7-air', 'kimi-k2-thinking'])
    // 一个未定价但挂着渠道、一个无渠道
    expect(unpriced.find((model) => model.name === 'glm-4.7-air')?.routes).toHaveLength(1)
    expect(unpriced.find((model) => model.name === 'kimi-k2-thinking')?.routes).toHaveLength(0)
  })

  it('discover：9 个上游模型（含一个长 id 的极端值夹具、2 个已有）；拉不动的渠道给 UPSTREAM_ERROR（演示手动添加）', async () => {
    useMock('admin')
    const discovered = await request('POST', '/api/admin/relay/channels/1/discover')
    const found = expectContract(
      DiscoverRelayChannelResponseSchema,
      discovered.payload,
      'DiscoverRelayChannel',
    )
    expect(found.models).toHaveLength(9)
    expect(found.models.filter((model) => model.existingModelId !== null)).toHaveLength(2)

    const failed = await request('POST', '/api/admin/relay/channels/3/discover')
    expect(failed.status).toBe(502)
    expect((failed.payload as { error: { code: string; message: string } }).error.code).toBe('UPSTREAM_ERROR')
    expect((failed.payload as { error: { message: string } }).error.message).toContain('超时')
  })

  it('建渠道带倍率；改倍率会把路由上的快照一起更新；移除最后一条路由 = 无渠道', async () => {
    useMock('admin')

    const created = await request('POST', '/api/admin/relay/channels', {
      name: '演示渠道',
      baseUrl: 'https://demo.example.com/v1',
      apis: ['openai-completions'],
      ratePermille: 333,
      keys: ['sk-demo-1'],
    })
    const channel = expectContract(
      RelayChannelResponseSchema,
      created.payload,
      'RelayChannel(create)',
    ).channel
    expect(channel.ratePermille).toBe(333)
    expect(channel.modelCount).toBe(0)

    // 往这个渠道导入一个模型：路由快照 = 333，渠道模型数变 1
    const imported = await request('POST', '/api/admin/relay/models/import', {
      channelId: channel.id,
      models: [{ upstreamModel: 'demo-model' }],
    })
    const result = expectContract(
      ImportRelayModelsResponseSchema,
      imported.payload,
      'ImportRelayModels(no price)',
    )
    expect(result.created).toBe(1)
    expect(result.models[0]?.price.inputMicro).toBe(0)
    expect(result.models[0]?.routes[0]?.channelRatePermille).toBe(333)

    const channels = await getJson(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels',
      'RelayChannelList',
    )
    expect(channels.find((item) => item.id === channel.id)?.modelCount).toBe(1)

    // 改倍率 → 路由快照跟着变
    await request('PATCH', `/api/admin/relay/channels/${channel.id}`, { ratePermille: 2000 })
    const models = await getJson(RelayModelListResponseSchema, '/api/admin/relay/models', 'RelayModelList')
    const demo = models.find((model) => model.name === 'demo-model')!
    expect(demo.routes[0]?.channelRatePermille).toBe(2000)

    // 取消勾选（PATCH routes 去掉本渠道）→ 无渠道、价格保留、模型数回到 0
    await request('PATCH', `/api/admin/relay/models/${demo.id}`, {
      routes: [],
      price: { inputMicro: 500_000, outputMicro: 1_000_000, perRequestMicro: 0 },
    })
    const after = await getJson(
      RelayModelListResponseSchema,
      '/api/admin/relay/models',
      'RelayModelList(after)',
    )
    const saved = after.find((model) => model.name === 'demo-model')!
    expect(saved.routes).toHaveLength(0)
    expect(saved.apis).toEqual([])
    expect(saved.price.inputMicro).toBe(500_000)
    const channelsAfter = await getJson(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels',
      'RelayChannelList(after)',
    )
    expect(channelsAfter.find((item) => item.id === channel.id)?.modelCount).toBe(0)
  })
})

describe('WP12b 下发到 DSH（12 §7.0 §10）', () => {
  it('GET /api/admin/relay/dsh：按路由平铺、默认路由、pending / warnings / 上次下发都过契约', async () => {
    useMock('admin')
    const data = await getJson(RelayDshResponseSchema, '/api/admin/relay/dsh', 'RelayDshResponse')

    expect(data.models).toHaveLength(8)
    // 选中的模型 = 有选中路由的模型；其中 deepseek 还选中了已停用渠道上的那条（已选但被阻断）
    expect(
      data.models
        .filter((model) => model.selected)
        .map((model) => model.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 4])
    expect(data.defaultModelId).toBe(1)
    expect(data.defaultRouteId).toBe(102)

    const flash = data.models.find((model) => model.name === 'deepseek-v4.1-flash')!
    expect(flash.routes?.map((route) => route.routeId)).toEqual([101, 102, 103])
    expect(flash.routes?.filter((route) => route.selected).map((route) => route.routeId)).toEqual([
      101, 102, 103,
    ])
    expect(flash.routes?.find((route) => route.routeId === 101)?.blockedReason).toBe('渠道已停用')
    expect(flash.routes?.find((route) => route.routeId === 101)?.selected).toBe(true)
    expect(flash.routes?.find((route) => route.routeId === 102)?.blockedReason).toBeNull()
    expect(flash.routes?.find((route) => route.routeId === 102)?.channelSlug).toBe('upstream-b')
    expect(flash.routes?.find((route) => route.routeId === 102)?.ratePermille).toBe(100)

    // 一个模型只挂一个协议：claude 在 official 上走 anthropic，在 upstream-b 上协议不匹配
    const claude = data.models.find((model) => model.name === 'claude-sonnet-4.6')!
    expect(claude.deliverApi).toBe('anthropic-messages')
    expect(claude.routes?.find((route) => route.channelSlug === 'upstream-b')?.blockedReason).toBe(
      '模型和渠道没有共同支持的协议',
    )
    expect(data.models.find((model) => model.name === 'local-qwen3-32b')?.blockedReason).toBe('已停用')
    expect(data.models.find((model) => model.name === 'kimi-k2-thinking')?.blockedReason).toBe('没有可用渠道')
    expect(data.models.find((model) => model.name === 'kimi-k2-thinking')?.deliverApi).toBeNull()

    // 未定价的可以选（只是提示）
    expect(data.models.find((model) => model.name === 'glm-4.7-air')?.priced).toBe(false)
    expect(data.models.find((model) => model.name === 'glm-4.7-air')?.blockedReason).toBeNull()

    expect(data.pending).toBe(true)
    expect(data.updatedAt).not.toBeNull()
    expect(data.revision).toBeGreaterThan(0)
    expect(data.lastRollout).toMatchObject({ jobId: 1041, status: 'succeeded' })
    expect(data.users).toEqual({ total: 7, running: 3 })
    expect(data.warnings.join('；')).toContain('deepseek-v4.1-flash@upstream-c')
    expect(data.warnings.join('；')).toContain('渠道已停用')
  })

  it('PUT 新写法（routeIds + defaultRouteId）真改假状态：选中路由 / 默认路由 / revision', async () => {
    useMock('admin')
    const before = await getJson(RelayDshResponseSchema, '/api/admin/relay/dsh', 'RelayDshResponse(before)')

    const ok = await request('PUT', '/api/admin/relay/dsh', {
      routeIds: [102, 103, 108],
      defaultRouteId: 103,
    })
    const data = expectContract(RelayDshResponseSchema, ok.payload, 'RelayDshResponse(route put)')
    expect(
      data.models
        .flatMap((model) => model.routes ?? [])
        .filter((route) => route.selected)
        .map((route) => route.routeId)
        .sort((a, b) => a - b),
    ).toEqual([102, 103, 108])
    expect(data.defaultRouteId).toBe(103)
    expect(data.defaultModelId).toBe(1)
    expect(data.revision).toBe(before.revision + 1)
    expect(data.pending).toBe(true)

    // 默认必须是选中的路由之一
    const badDefault = await request('PUT', '/api/admin/relay/dsh', {
      routeIds: [102],
      defaultRouteId: 103,
    })
    expect(badDefault.status).toBe(400)

    // 101 这时已经不在选中集合里了，渠道停用 → 新勾上被拒
    const blocked = await request('PUT', '/api/admin/relay/dsh', { routeIds: [101], defaultRouteId: 101 })
    expect(blocked.status).toBe(400)
    expect((blocked.payload as { error: { message: string } }).error.message).toContain('渠道已停用')

    // 清空（一个都不选 → 默认必须为空）
    const cleared = await request('PUT', '/api/admin/relay/dsh', { routeIds: [], defaultRouteId: null })
    const empty = expectContract(RelayDshResponseSchema, cleared.payload, 'RelayDshResponse(clear route)')
    expect(empty.models.flatMap((model) => model.routes ?? []).every((route) => !route.selected)).toBe(true)
    expect(empty.defaultRouteId).toBeNull()
    expect(empty.defaultModelId).toBeNull()
    expect(empty.pending).toBe(false)
  })

  it('PUT 老写法（modelIds + defaultModelId）：等于选中这些模型的全部路由，默认按可下发路线取', async () => {
    useMock('admin')
    const before = await getJson(RelayDshResponseSchema, '/api/admin/relay/dsh', 'RelayDshResponse(before)')

    const updated = await request('PUT', '/api/admin/relay/dsh', {
      modelIds: [2, 4, 7],
      defaultModelId: 4,
    })
    expect(updated.status).toBe(400)
    expect((updated.payload as { error: { message: string } }).error.message).toContain('没有可用渠道')

    const ok = await request('PUT', '/api/admin/relay/dsh', { modelIds: [2, 4], defaultModelId: 4 })
    const data = expectContract(RelayDshResponseSchema, ok.payload, 'RelayDshResponse(old put)')
    expect(
      data.models
        .filter((model) => model.selected)
        .map((model) => model.id)
        .sort((a, b) => a - b),
    ).toEqual([2, 4])
    expect(data.defaultModelId).toBe(4)
    // model 4 只有 108 这一条可下发路由
    expect(data.defaultRouteId).toBe(108)
    expect(data.revision).toBe(before.revision + 1)
    expect(data.pending).toBe(true)

    // 默认模型必须在选中集合里
    const bad = await request('PUT', '/api/admin/relay/dsh', { modelIds: [2], defaultModelId: 4 })
    expect(bad.status).toBe(400)
  })

  it('?mock=admin-empty-dsh：一个对外模型都没有（空状态用）', async () => {
    useMock('admin-empty-dsh')
    const data = await getJson(RelayDshResponseSchema, '/api/admin/relay/dsh', 'RelayDshResponse(empty)')
    expect(data.models).toEqual([])
    expect(data.defaultModelId).toBeNull()
    expect(data.defaultRouteId).toBeNull()
    expect(data.pending).toBe(false)

    const models = await getJson(
      RelayModelListResponseSchema,
      '/api/admin/relay/models',
      'RelayModelList(empty)',
    )
    expect(models).toEqual([])
  })

  it('POST /api/admin/rollouts 建一条真的会跑完的假任务（几秒内 succeeded，DSH 状态跟着归位）', async () => {
    useMock('admin')
    const created = await request('POST', '/api/admin/rollouts', {
      kind: 'models',
      targets: { all: true },
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    expect(created.status).toBe(202)
    const jobId = (created.payload as { jobId: number }).jobId
    expect(jobId).toBeGreaterThanOrEqual(1043)

    const detail = await getJson(JobDetailResponseSchema, `/api/admin/jobs/${jobId}`, 'JobDetail(new)')
    expect(detail.job.type).toBe('rollout.models')
    expect(detail.job.total).toBe(7)
    expect(detail.tasks).toHaveLength(7)

    // 任务在后台几秒内跑完：轮询到 succeeded 为止
    const deadline = Date.now() + 10_000
    let job = detail.job
    while (job.status !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      job = (await getJson(JobDetailResponseSchema, `/api/admin/jobs/${jobId}`, 'JobDetail(poll)')).job
    }
    expect(job.status).toBe('succeeded')
    expect(job.done).toBe(7)

    // 「上次下发」指向新任务，pending 归位（任务创建晚于配置更新时间）
    const dsh = await getJson(RelayDshResponseSchema, '/api/admin/relay/dsh', 'RelayDshResponse(after job)')
    expect(dsh.lastRollout).toMatchObject({ jobId, status: 'succeeded' })
    expect(dsh.pending).toBe(false)
  }, 20_000)
})
