import {
  DeliveryCreatedResponseSchema,
  DeliveryPreviewResponseSchema,
  PluginInstallStatsResponseSchema,
  type DeliveryRequest,
} from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { deliveriesRevision, DELIVERY_SCENARIOS, isDeliveryScenario, resetDeliveriesMock } from '@/mocks/deliveries'
import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario } from '@/mocks/state'

/**
 * 统一下发的假数据（WP28b 交付物 4）：四个场景、有状态的后端、契约形状。
 *
 * 形状漂了在页面上会变成「接口返回的数据不符合契约」，所以这里直接跑契约 schema；
 * 「已安装」的解析、跳过原因、一台设备一行、revision 递增也在这一层断言。
 */
const restores: (() => void)[] = []

function useMock(scenario: (typeof DELIVERY_SCENARIOS)[number]): void {
  resetDeliveriesMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetDeliveriesMock()
})

const pluginRequest = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  platforms: ['instance', 'desktop'],
  items: [{ kind: 'plugin', pluginId: 1, versionId: 11 }],
  action: 'upgrade',
  targets: { mode: 'installed', outdatedOnly: false },
  strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
  ...overrides,
})

async function preview(input: DeliveryRequest) {
  const response = await fetch('/api/admin/deliveries/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  return DeliveryPreviewResponseSchema.parse(await response.json())
}

async function create(input: DeliveryRequest) {
  const response = await fetch('/api/admin/deliveries', { method: 'POST', body: JSON.stringify(input) })
  expect(response.status).toBe(202)
  return DeliveryCreatedResponseSchema.parse(await response.json())
}

describe('统一下发假数据：场景', () => {
  it('四个场景名固定，且只有它们接管统一下发接口', () => {
    expect([...DELIVERY_SCENARIOS]).toEqual([
      'delivery',
      'delivery-desktop-only',
      'delivery-warnings',
      'delivery-truncated',
    ])
    for (const scenario of DELIVERY_SCENARIOS) expect(isDeliveryScenario(scenario)).toBe(true)
    expect(isDeliveryScenario('admin')).toBe(false)
  })

  it('管理端场景照常生效（插件库 / 用户列表仍由 admin 兜底）', async () => {
    useMock('delivery')
    const response = await fetch('/api/admin/plugins')
    expect(response.status).toBe(200)
    expect(Array.isArray(await response.json())).toBe(true)
  })
})

describe('统一下发假数据：预览', () => {
  it('合契约；桌面端一台设备一行（同一个用户两台设备就两行）', async () => {
    useMock('delivery')
    const result = await preview(pluginRequest({ targets: { mode: 'all' } }))

    const desktop = result.rows.filter((row) => row.platform === 'desktop')
    const deviceIds = desktop.map((row) => row.deviceId)
    expect(deviceIds.every((id) => id !== null)).toBe(true)
    expect(new Set(deviceIds).size).toBe(deviceIds.length)
    // 用户 1 有两台设备，所以桌面行里的 userId=1 出现两次
    expect(desktop.filter((row) => row.userId === 1)).toHaveLength(2)
    // 实例行没有设备
    expect(result.rows.filter((row) => row.platform === 'instance').every((row) => row.deviceId === null)).toBe(true)
  })

  it('「已安装」按插件解析，outdatedOnly 只留版本较旧的', async () => {
    useMock('delivery')
    const all = await preview(pluginRequest())
    const outdated = await preview(
      pluginRequest({ targets: { mode: 'installed', outdatedOnly: true } }),
    )

    const instanceUsers = (rows: typeof all.rows) =>
      rows.filter((row) => row.platform === 'instance').map((row) => row.username)
    expect(instanceUsers(all.rows).sort()).toEqual([
      'admin',
      'butter',
      'demo-alice-work-laptop',
      'mint',
      'quiet-leaf',
      'sakura',
      'skywalker',
    ])
    // 只有 mint（0.15.0）与 sakura（0.15.0）版本比 0.16.0 旧
    expect(instanceUsers(outdated.rows).sort()).toEqual(['mint', 'sakura'])
    expect(outdated.summary.instance.willRun + outdated.summary.instance.skipped).toBe(2)
  })

  it('跳过的行都给原因（待审批 / 已停用 / 已是该版本 / 不在桌面插件库）', async () => {
    useMock('delivery')
    const result = await preview(
      pluginRequest({ items: [{ kind: 'plugin', pluginId: 4, versionId: 41 }], targets: { mode: 'all' } }),
    )
    const reasons = new Set(result.rows.map((row) => row.skipReason))
    // 视频渲染不在桌面插件库（docs/22 §2）→ 桌面行整项跳过
    expect(reasons.has('该插件不在桌面插件库')).toBe(true)
    // 待审批的 skywalker 与已停用的 quiet-leaf 被跳过
    expect(reasons.has('用户待审批')).toBe(true)
    expect(reasons.has('用户已停用')).toBe(true)
    for (const row of result.rows) {
      if (row.skipReason !== null) expect(row.skipReason.length).toBeGreaterThan(0)
    }
  })

  it('desktop-only 场景：实例侧没有安装记录，有一台已吊销设备', async () => {
    useMock('delivery-desktop-only')
    const result = await preview(pluginRequest())
    expect(result.rows.filter((row) => row.platform === 'instance')).toHaveLength(0)
    const desktop = result.rows.filter((row) => row.platform === 'desktop')
    expect(desktop.some((row) => row.skipReason === '设备已吊销')).toBe(true)
  })

  it('warnings 场景：预览带警告；truncated 场景：truncated=true', async () => {
    useMock('delivery-warnings')
    const withWarnings = await preview(
      pluginRequest({
        items: [{ kind: 'plugin', pluginId: 4 }, { kind: 'runtime', runtimeId: 2 }],
        targets: { mode: 'all' },
      }),
    )
    expect(withWarnings.warnings.length).toBeGreaterThan(0)
    expect(withWarnings.warnings.some((text) => text.includes('不在桌面插件库'))).toBe(true)

    useMock('delivery-truncated')
    const truncated = await preview(pluginRequest({ targets: { mode: 'all' } }))
    expect(truncated.truncated).toBe(true)
    expect(truncated.rows.length).toBeGreaterThan(10)
  })

  it('不合契约的请求回 400 VALIDATION_FAILED', async () => {
    useMock('delivery')
    // 只选了桌面端却要下发 DSH 版本：契约的 superRefine 会拒绝
    const response = await fetch('/api/admin/deliveries/preview', {
      method: 'POST',
      body: JSON.stringify(pluginRequest({ platforms: ['desktop'], items: [{ kind: 'runtime', runtimeId: 2 }] })),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('统一下发假数据：提交', () => {
  it('实例侧每个内容项一个 job，桌面侧只把 revision 往前推一格', async () => {
    useMock('delivery')
    const before = deliveriesRevision()
    const items = [{ kind: 'plugin' as const, pluginId: 1 }, { kind: 'plugin' as const, pluginId: 3 }]
    const created = await create(pluginRequest({ items, targets: { mode: 'all' } }))

    expect(created.jobs).toHaveLength(2)
    expect(created.jobs.map((job) => job.itemLabel)).toEqual(['邮件助手 0.16.0', '文件下载器 1.0.0'])
    expect(created.jobs.every((job) => job.jobId > 0)).toBe(true)
    // 会执行的桌面行：文件下载器要装到还没装的 2 台设备，邮件助手只升级 mint 那台
    expect(created.desktop).toEqual({ revision: before + 1, users: 3, devices: 3 })
    expect(created.skippedItems).toEqual([])
    expect(deliveriesRevision()).toBe(before + 1)
  })

  it('不在桌面插件库的整项跳过，其它项照常执行', async () => {
    useMock('delivery')
    const created = await create(
      pluginRequest({
        items: [{ kind: 'plugin', pluginId: 4 }, { kind: 'plugin', pluginId: 1 }],
        targets: { mode: 'all' },
      }),
    )
    expect(created.skippedItems).toEqual([
      { itemLabel: '视频渲染', platform: 'desktop', reason: '该插件不在桌面插件库' },
    ])
    expect(created.jobs).toHaveLength(2)
  })

  it('只选桌面端时没有 job，只有 revision', async () => {
    useMock('delivery')
    const created = await create(pluginRequest({ platforms: ['desktop'] }))
    expect(created.jobs).toEqual([])
    expect(created.desktop?.revision).toBeGreaterThan(0)
  })
})

describe('统一下发假数据：人数', () => {
  it('install-stats 合契约，实例与桌面分别计数', async () => {
    useMock('delivery')
    const response = await fetch('/api/admin/plugins/install-stats')
    const stats = PluginInstallStatsResponseSchema.parse(await response.json())

    const email = stats.items.find((item) => item.pluginId === 1)
    expect(email?.instance.users).toBe(7)
    expect(email?.instance.outdated).toBe(2)
    expect(email?.desktop.devices).toBe(4)
    expect(email?.desktop.users).toBe(3)
    expect(email?.desktop.outdated).toBe(1)
    // docs/22 §2.1 + 契约 7bb61db：桌面最新版本是桌面库的最新版本（没有桌面版本 = null）
    expect(email?.latestVersion).toBe('0.16.0')
    expect(email?.desktopLatestVersion).toBe('0.16.0')
    expect(stats.items.find((item) => item.pluginId === 4)?.desktopLatestVersion).toBeNull()

    // 没人装的插件是 0，不报 null
    const im = stats.items.find((item) => item.pluginId === 2)
    expect(im?.instance.users).toBe(0)
    expect(im?.desktop.devices).toBe(0)
  })

  it('整包清单里有一个插件缺整包（向导第 1 步的标记）', async () => {
    useMock('delivery')
    const response = await fetch('/api/admin/desktop/artifacts')
    const body = (await response.json()) as { items: { pluginId: number }[] }
    expect(body.items.map((item) => item.pluginId)).not.toContain(4)
  })
})
