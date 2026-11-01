import { DesktopConfigDeliverRequestSchema, DesktopDeliveryStateSchema, DesktopDeviceListResponseSchema } from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { installMockFetch } from '@/mocks/fetch'
import {
  DESKTOP_DELIVERY_SCENARIOS,
  isDesktopDeliveryScenario,
  resetDesktopDeliveryMock,
} from '@/mocks/desktop-delivery'
import { setMockScenario } from '@/mocks/state'

/**
 * 桌面下发的假数据（WP25d 交付物 6）：四个场景走查用，形状必须严格合契约。
 * 这里直接跑 `DesktopDeliveryStateSchema` / `DesktopDeviceListResponseSchema`，
 * 形状漂了在页面上会变成「接口返回的数据不符合契约」，不如在测试里先炸。
 */
const restores: (() => void)[] = []

function useMock(scenario: (typeof DESKTOP_DELIVERY_SCENARIOS)[number]): void {
  resetDesktopDeliveryMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetDesktopDeliveryMock()
})

describe('桌面下发假数据', () => {
  it('四个场景名字都以 admin 开头，管理端兜底接口照常生效', () => {
    expect([...DESKTOP_DELIVERY_SCENARIOS]).toEqual([
      'admin-desktop',
      'admin-desktop-empty',
      'admin-desktop-failed',
      'admin-desktop-warn',
    ])
    for (const scenario of DESKTOP_DELIVERY_SCENARIOS) {
      expect(isDesktopDeliveryScenario(scenario)).toBe(true)
      expect(scenario.startsWith('admin')).toBe(true)
    }
  })

  it('admin-desktop：期望状态合格约，含插件 / 片段 / 卸载 / 渠道 / 覆盖', async () => {
    useMock('admin-desktop')
    const response = await fetch('/api/admin/desktop/delivery')
    const state = DesktopDeliveryStateSchema.parse(await response.json())

    expect(state.revision).toBeGreaterThan(0)
    expect(state.pluginTargets.length).toBe(4)
    expect(state.pluginTargets.filter((row) => row.artifact === null)).toHaveLength(1)
    expect(state.configFragments.map((row) => row.entryId)).toEqual([
      'llm-pi-ai',
      'agent-default-model',
      'claude-pilot',
    ])
    expect(state.uninstalls[0]?.packageName).toBe('@local/dsh-image-gen')
    expect(state.app.channels.map((row) => row.channel)).toEqual(['nightly', 'latest'])
    expect(state.app.overrides).toHaveLength(2)
    expect(state.warnings).toEqual([])
  })

  it('admin-desktop-empty：全新 Hub（revision 0、没有下发、没有设备）', async () => {
    useMock('admin-desktop-empty')
    const state = DesktopDeliveryStateSchema.parse(
      await (await fetch('/api/admin/desktop/delivery')).json(),
    )
    expect(state.revision).toBe(0)
    expect(state.pluginTargets).toEqual([])
    expect(state.configFragments).toEqual([])

    const devices = DesktopDeviceListResponseSchema.parse(
      await (await fetch('/api/admin/desktop-devices?revoked=active&pageSize=100')).json(),
    )
    expect(devices.total).toBe(0)
  })

  it('admin-desktop-failed：设备全部卡在失败 / 部分应用，带错误码', async () => {
    useMock('admin-desktop-failed')
    const devices = DesktopDeviceListResponseSchema.parse(
      await (await fetch('/api/admin/desktop-devices?revoked=active&pageSize=100')).json(),
    )
    expect(devices.total).toBeGreaterThan(0)
    const failed = devices.items.filter(
      (item) => item.device.applyState === 'failed' || item.device.applyState === 'partial',
    )
    expect(failed.length).toBeGreaterThanOrEqual(3)
    expect(failed.every((item) => item.device.applyErrorCode !== null)).toBe(true)
  })

  it('admin-desktop-warn：三条渲染告警（origin 非 https / 缺整包 / provider 不在 Hub 下）', async () => {
    useMock('admin-desktop-warn')
    const state = DesktopDeliveryStateSchema.parse(
      await (await fetch('/api/admin/desktop/delivery')).json(),
    )
    expect(state.warnings).toHaveLength(3)
    expect(state.warnings.join(' ')).toContain('不是 https')
    expect(state.warnings.join(' ')).toContain('还没有上传桌面整包')
  })

  it('设备台账的每台设备都带 desiredRevision（WP25b 加的必填字段）', async () => {
    useMock('admin-desktop')
    const devices = DesktopDeviceListResponseSchema.parse(
      await (await fetch('/api/admin/desktop-devices?revoked=active&pageSize=100')).json(),
    )
    expect(devices.total).toBe(4)
    for (const item of devices.items) {
      expect(item.device.desiredRevision).not.toBeUndefined()
    }
  })

  it('写接口是有状态的：下发插件会生成新 revision 并记一条审计', async () => {
    useMock('admin-desktop')
    const before = DesktopDeliveryStateSchema.parse(
      await (await fetch('/api/admin/desktop/delivery')).json(),
    )
    const response = await fetch('/api/admin/desktop/plugins', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { scope: 'user', userId: 5 }, pluginId: 2, versionId: 21 }),
    })
    const delivered = (await response.json()) as { revision: number; affectedDevices: number }
    expect(delivered.revision).toBe(before.revision + 1)
    expect(delivered.affectedDevices).toBe(0)

    const after = DesktopDeliveryStateSchema.parse(
      await (await fetch('/api/admin/desktop/delivery')).json(),
    )
    expect(after.pluginTargets).toHaveLength(before.pluginTargets.length + 1)
    expect(after.pluginTargets.at(-1)).toMatchObject({ pluginId: 2, scope: 'user', userId: 5 })

    const audits = (await (await fetch('/api/admin/audit?action=desktop.deliver')).json()) as {
      items: { action: string; detail: Record<string, unknown> }[]
    }
    expect(audits.items[0]?.action).toBe('desktop.deliver')
    expect(audits.items[0]?.detail['scope']).toBe('user')
  })

  it('配置片段下发走真契约校验：未知键被 400 挡住', async () => {
    useMock('admin-desktop')
    const response = await fetch('/api/admin/desktop/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { scope: 'all' },
        fragments: [{ id: 'agent-default-model', mode: 'enforce', config: { provider: 'hub', model: 'x', foo: 1 } }],
      }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    // 契约本身能挡住同一条请求（前端提交前也跑一遍）
    expect(
      DesktopConfigDeliverRequestSchema.safeParse({
        target: { scope: 'all' },
        fragments: [{ id: 'agent-default-model', mode: 'enforce', config: { provider: 'hub', model: 'x', foo: 1 } }],
      }).success,
    ).toBe(false)
  })
})
