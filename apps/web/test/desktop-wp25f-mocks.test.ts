import {
  DesktopBatchRevokeResponseSchema,
  DesktopDeviceDetailResponseSchema,
  DesktopDeviceListResponseSchema,
  DesktopModelPresetFragmentsResponseSchema,
  DesktopOverviewCountsSchema,
  DesktopRenameDeviceResponseSchema,
  AuditListResponseSchema,
} from '@dsh-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleDesktopDelivery } from '@/mocks/desktop-delivery'
import { desktopOverviewCounts, handleDesktop, resetDesktopMock } from '@/mocks/desktop'
import { MOCK_SCENARIOS, setMockScenario } from '@/mocks/state'

/**
 * WP25f 的假数据（交付物 9）：设备详情 / 批量吊销混合结果 / 改名成功与 404 /
 * overview.desktop / password_change_required / 发布日志的 actionPrefix / 系统预设。
 *
 * 全部直接调假接口入口，响应用 shared 的契约 schema 过一遍 —— 形状漂了这里先红。
 */
const BASE = 'http://127.0.0.1/api'

function url(path: string, query = ''): URL {
  return new URL(`${BASE}${path}${query}`)
}

async function json<T>(response: Response | null): Promise<T> {
  expect(response, '假接口应该接管这个请求').toBeTruthy()
  return (await response!.json()) as T
}

beforeEach(() => {
  setMockScenario('admin')
  resetDesktopMock()
})

afterEach(() => {
  setMockScenario('running')
  resetDesktopMock()
})

/** 取管理端台账的第一页（设备 id 从假数据里读，别写死） */
async function adminDevices(): Promise<{ deviceId: string; presence: string }[]> {
  const response = handleDesktop('/api/admin/desktop-devices', 'GET', url('/admin/desktop-devices', '?revoked=all&pageSize=100'))
  const body = DesktopDeviceListResponseSchema.parse(await json(response))
  return body.items.map((item) => ({ deviceId: item.device.deviceId, presence: item.device.presence }))
}

describe('设备详情（交付物 1 的假数据）', () => {
  it('过契约：台账 + 插件清单 + 最近审计，插件数与清单一致', async () => {
    const devices = await adminDevices()
    const response = handleDesktop(
      `/api/admin/desktop-devices/${devices[0]!.deviceId}`,
      'GET',
      url(`/admin/desktop-devices/${devices[0]!.deviceId}`),
    )
    const body = DesktopDeviceDetailResponseSchema.parse(await json(response))
    expect(body.device.deviceId).toBe(devices[0]!.deviceId)
    expect(body.pluginCount).toBe(body.plugins.length)
    expect(body.plugins.length).toBeGreaterThan(0)
    expect(body.audit.length).toBeGreaterThan(0)
    expect(body.audit.every((item) => item.targetType === 'desktop.device')).toBe(true)
    expect(body.audit.every((item) => item.targetId === body.device.deviceId)).toBe(true)
  })

  it('不存在的 deviceId → 404；非管理端场景 → 403', async () => {
    const missing = handleDesktop(
      `/api/admin/desktop-devices/dv_${'f'.repeat(32)}`,
      'GET',
      url(`/admin/desktop-devices/dv_${'f'.repeat(32)}`),
    )
    expect(missing?.status).toBe(404)

    setMockScenario('desktop')
    const forbidden = handleDesktop(
      `/api/admin/desktop-devices/dv_${'f'.repeat(32)}`,
      'GET',
      url(`/admin/desktop-devices/dv_${'f'.repeat(32)}`),
    )
    expect(forbidden?.status).toBe(403)
  })
})

describe('改名（交付物 3 的假数据）', () => {
  it('改自己的设备成功，列表里跟着变；写库状态在场景内保留', async () => {
    setMockScenario('desktop')
    resetDesktopMock()
    // 用户场景下用 /api/me/desktop-devices 的 deviceId
    const myResponse = handleDesktop('/api/me/desktop-devices', 'GET', url('/me/desktop-devices'))
    const my = (await json<{ items: { deviceId: string }[] }>(myResponse)).items
    expect(my.length).toBeGreaterThan(0)

    const deviceId = my[0]!.deviceId
    const renamed = handleDesktop(`/api/me/desktop-devices/${deviceId}`, 'PATCH', url(`/me/desktop-devices/${deviceId}`), {
      method: 'PATCH',
      body: JSON.stringify({ name: '  书房的新名字  ' }),
    })
    const body = DesktopRenameDeviceResponseSchema.parse(await json(renamed))
    expect(body.device.name).toBe('书房的新名字')

    const again = handleDesktop('/api/me/desktop-devices', 'GET', url('/me/desktop-devices'))
    const after = (await json<{ items: { deviceId: string; name: string }[] }>(again)).items
    expect(after.find((item) => item.deviceId === deviceId)?.name).toBe('书房的新名字')
  })

  it('非法名字 → 400；已吊销（等于「已退出」）→ 404', async () => {
    setMockScenario('desktop')
    resetDesktopMock()
    const my = (await json<{ items: { deviceId: string }[] }>(
      handleDesktop('/api/me/desktop-devices', 'GET', url('/me/desktop-devices')),
    )).items
    const deviceId = my[0]!.deviceId

    const bad = handleDesktop(`/api/me/desktop-devices/${deviceId}`, 'PATCH', url(`/me/desktop-devices/${deviceId}`), {
      body: JSON.stringify({ name: 'C:\\Users\\52914' }),
    })
    expect(bad?.status).toBe(400)

    handleDesktop(`/api/me/desktop-devices/${deviceId}`, 'DELETE', url(`/me/desktop-devices/${deviceId}`))
    const gone = handleDesktop(`/api/me/desktop-devices/${deviceId}`, 'PATCH', url(`/me/desktop-devices/${deviceId}`), {
      body: JSON.stringify({ name: '还能改吗' }),
    })
    expect(gone?.status).toBe(404)
  })
})

describe('批量吊销（交付物 2 的假数据）', () => {
  it('按真实语义逐台给结果：revoked / already_revoked / not_found，且 revoked + skipped = 条数', async () => {
    const devices = await adminDevices()
    const active = devices.filter((item) => item.presence !== 'revoked')
    const revoked = devices.filter((item) => item.presence === 'revoked')
    expect(active.length).toBeGreaterThan(1)
    expect(revoked.length).toBeGreaterThan(0)

    const deviceIds = [active[0]!.deviceId, active[1]!.deviceId, revoked[0]!.deviceId, `dv_${'e'.repeat(32)}`]
    const response = handleDesktop('/api/admin/desktop-devices/revoke', 'POST', url('/admin/desktop-devices/revoke'), {
      method: 'POST',
      body: JSON.stringify({ deviceIds }),
    })
    const body = DesktopBatchRevokeResponseSchema.parse(await json(response))
    expect(body.items.map((item) => item.outcome)).toEqual([
      'revoked',
      'revoked',
      'already_revoked',
      'not_found',
    ])
    expect(body.revoked).toBe(2)
    expect(body.skipped).toBe(2)
    expect(body.revoked + body.skipped).toBe(body.items.length)
  })

  it('admin-batch 场景把四种结果都摆出来（failed 只在服务端异常时出现，用来走查）', async () => {
    setMockScenario('admin-batch')
    resetDesktopMock()
    const devices = await adminDevices()
    const active = devices.filter((item) => item.presence !== 'revoked')
    const response = handleDesktop('/api/admin/desktop-devices/revoke', 'POST', url('/admin/desktop-devices/revoke'), {
      body: JSON.stringify({ deviceIds: active.slice(0, 4).map((item) => item.deviceId) }),
    })
    const body = DesktopBatchRevokeResponseSchema.parse(await json(response))
    expect(body.items.map((item) => item.outcome)).toEqual([
      'revoked',
      'already_revoked',
      'not_found',
      'failed',
    ])
  })

  it('0 台或超过 50 台 → 400', async () => {
    const empty = handleDesktop('/api/admin/desktop-devices/revoke', 'POST', url('/admin/desktop-devices/revoke'), {
      body: JSON.stringify({ deviceIds: [] }),
    })
    expect(empty?.status).toBe(400)

    const tooMany = handleDesktop('/api/admin/desktop-devices/revoke', 'POST', url('/admin/desktop-devices/revoke'), {
      body: JSON.stringify({ deviceIds: Array.from({ length: 51 }, (_v, i) => `dv_${String(i).padStart(32, '0')}`) }),
    })
    expect(tooMany?.status).toBe(400)
  })
})

describe('overview.desktop 与「必须改密」的假数据', () => {
  it('概览计数过契约，且 total = online + stale + revoked', () => {
    const counts = DesktopOverviewCountsSchema.parse(desktopOverviewCounts())
    expect(counts.total).toBe(counts.online + counts.stale + counts.revoked)
    expect(counts.total).toBeGreaterThan(0)
  })

  it('desktop-password 场景：授权请求 403 + loginCode=password_change_required', async () => {
    setMockScenario('desktop-password')
    const response = handleDesktop(
      '/api/desktop/auth/requests/req_password',
      'GET',
      url('/desktop/auth/requests/req_password'),
    )
    expect(response?.status).toBe(403)
    const body = (await response!.json()) as { error: { code: string; details: { loginCode?: string } } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details.loginCode).toBe('password_change_required')
  })

  it('两个新场景都进了 MOCK_SCENARIOS（?mock= 才认）', () => {
    expect(MOCK_SCENARIOS).toContain('desktop-password')
    expect(MOCK_SCENARIOS).toContain('admin-batch')
  })
})

describe('模型预设与发布日志的假数据', () => {
  it('不传 userId → 系统预设（userId=null）；传了才按用户', async () => {
    setMockScenario('admin-desktop')
    const system = await json<unknown>(
      handleDesktopDelivery(
        '/api/admin/desktop/config/model-preset',
        'GET',
        url('/admin/desktop/config/model-preset'),
      ),
    )
    const systemBody = DesktopModelPresetFragmentsResponseSchema.parse(system)
    expect(systemBody.userId).toBeNull()
    expect(systemBody.fragments.map((fragment) => fragment.id)).toEqual(['llm-pi-ai', 'agent-default-model'])

    const forUser = DesktopModelPresetFragmentsResponseSchema.parse(
      await json(
        handleDesktopDelivery(
          '/api/admin/desktop/config/model-preset',
          'GET',
          url('/admin/desktop/config/model-preset', '?userId=2'),
        ),
      ),
    )
    expect(forUser.userId).toBe(2)
    expect(forUser.fragments.length).toBe(2)
  })

  it('审计支持 actionPrefix：一次拿到全部桌面动作，精确 action 行为不变', async () => {
    setMockScenario('admin-desktop')
    const prefix = AuditListResponseSchema.parse(
      await json(
        handleDesktopDelivery(
          '/api/admin/audit',
          'GET',
          url('/admin/audit', '?actionPrefix=desktop.&pageSize=100'),
        ),
      ),
    )
    expect(prefix.items.length).toBeGreaterThan(1)
    expect(prefix.items.every((item) => item.action.startsWith('desktop.'))).toBe(true)

    const exact = AuditListResponseSchema.parse(
      await json(
        handleDesktopDelivery(
          '/api/admin/audit',
          'GET',
          url('/admin/audit', '?action=desktop.release.publish'),
        ),
      ),
    )
    expect(exact.items.every((item) => item.action === 'desktop.release.publish')).toBe(true)
  })
})
