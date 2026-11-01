import {
  AdminInstanceListResponseSchema,
  ComputeLeaseListResponseSchema,
  ComputeSettingsResponseSchema,
  MyComputeResponseSchema,
} from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import { resetComputeMock } from '@/mocks/compute'
import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario, type MockScenario } from '@/mocks/state'

/**
 * 算力租赁假数据（WP17b，13 §7）：每个响应都过一遍 shared 的契约 schema，
 * 写接口（选规格 / 保存设置）要真的改假状态；402 的 details 形状也要对。
 */

const restores: (() => void)[] = []

function useMock(scenario: MockScenario): void {
  resetComputeMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetComputeMock()
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

describe('用户端算力租赁假数据（?mock=compute-*）', () => {
  it.each([
    ['compute-off', false],
    ['compute-stopped', true],
    ['compute-running', true],
    ['compute-grace', true],
    ['compute-low', true],
    ['compute-exempt', true],
    ['compute-custom', true],
  ] as const)('场景 %s：GET /api/me/compute 符合契约（billingEnabled=%s）', async (scenario, enabled) => {
    useMock(scenario)
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '我的算力租赁')
    expect(data.billingEnabled).toBe(enabled)
    expect(data.blockMinutes).toBe(10)
    expect(data.graceMinutes).toBe(10)
  })

  it('计费关闭：没有租约，规格仍在（页面自己不渲染）', async () => {
    useMock('compute-off')
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '计费关闭')
    expect(data.billingEnabled).toBe(false)
    expect(data.lease).toBeNull()
  })

  it('运行中：计费租约带已扣块数与下次扣费时间', async () => {
    useMock('compute-running')
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '运行中')
    expect(data.lease?.billed).toBe(true)
    expect(data.lease?.blocks).toBe(3)
    expect(data.lease?.paidUntil).toBeTruthy()
    expect(data.lease?.graceUntil).toBeNull()
    expect(data.balanceMicro).toBe(1_860_000)
  })

  it('宽限中：graceUntil 非空、余额 ≤ 0', async () => {
    useMock('compute-grace')
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '宽限中')
    expect(data.lease?.graceUntil).toBeTruthy()
    expect(data.balanceMicro).toBeLessThanOrEqual(0)
  })

  it('管理员免租：exempt=true，租约免费', async () => {
    useMock('compute-exempt')
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '免租')
    expect(data.exempt).toBe(true)
    expect(data.lease?.billed).toBe(false)
    expect(data.lease?.chargedMicro).toBe(0)
  })

  it('定制规格：custom=true 且只出现在名单里的用户', async () => {
    useMock('compute-custom')
    const data = await getJson(MyComputeResponseSchema, '/api/me/compute', '定制规格')
    const custom = data.plans.find((plan) => plan.custom)
    expect(custom?.id).toBe('custom-16c')
    expect(data.selectedPlanId).toBe('custom-16c')
  })

  it('停止中选规格：只记住，不重启', async () => {
    useMock('compute-stopped')
    const { status, payload } = await request('PUT', '/api/me/compute/plan', { planId: 'c8m16' })
    expect(status).toBe(200)
    const result = payload as { restarted: boolean; compute: unknown }
    expect(result.restarted).toBe(false)
    const compute = expectContract(MyComputeResponseSchema, result.compute, '选规格响应')
    expect(compute.selectedPlanId).toBe('c8m16')
  })

  it('运行中换规格：restarted=true，新租约按新规格、扣第一块', async () => {
    useMock('compute-running')
    const before = await getJson(MyComputeResponseSchema, '/api/me/compute', '换规格前')
    const { status, payload } = await request('PUT', '/api/me/compute/plan', { planId: 'c2m4' })
    expect(status).toBe(200)
    const result = payload as { restarted: boolean; compute: unknown }
    expect(result.restarted).toBe(true)
    const after = expectContract(MyComputeResponseSchema, result.compute, '换规格响应')
    expect(after.lease?.planId).toBe('c2m4')
    expect(after.lease?.blocks).toBe(1)
    expect(after.balanceMicro).toBe(before.balanceMicro - 50_000)
  })

  it('余额不足时选规格 / 启动：402 INSUFFICIENT_POINTS + details', async () => {
    useMock('compute-low')
    const plan = await request('PUT', '/api/me/compute/plan', { planId: 'c4m8' })
    expect(plan.status).toBe(402)
    expect((plan.payload as { error: { code: string } }).error.code).toBe('INSUFFICIENT_POINTS')
    expect((plan.payload as { error: { details: unknown } }).error.details).toEqual({
      balanceMicro: 20_000,
      blockPriceMicro: 83_334,
    })

    const start = await request('POST', '/api/me/instance/start', { planId: 'c2m4' })
    expect(start.status).toBe(402)
    expect(
      (start.payload as { error: { details: { balanceMicro: number; blockPriceMicro: number } } }).error
        .details,
    ).toEqual({ balanceMicro: 20_000, blockPriceMicro: 50_000 })
  })

  it('租约历史：契约、分页、进行中的租约在列表里', async () => {
    useMock('compute-running')
    const page = await getJson(
      ComputeLeaseListResponseSchema,
      '/api/me/compute/leases?page=1&pageSize=5',
      '租约历史',
    )
    expect(page.pageSize).toBe(5)
    expect(page.items.length).toBeLessThanOrEqual(5)
    expect(page.items.some((row) => row.endedAt === null)).toBe(true)

    const second = await getJson(
      ComputeLeaseListResponseSchema,
      '/api/me/compute/leases?page=2&pageSize=5',
      '租约历史第二页',
    )
    expect(second.page).toBe(2)
  })
})

describe('管理端算力租赁假数据（?mock=admin）', () => {
  it('GET /api/admin/compute/settings：设置 + 宿主内存', async () => {
    useMock('admin')
    const response = await getJson(
      ComputeSettingsResponseSchema,
      '/api/admin/compute/settings',
      '算力租赁设置',
    )
    expect(response.settings.billingEnabled).toBe(true)
    expect(response.settings.plans.length).toBeGreaterThanOrEqual(3)
    expect(response.host.memTotalMb).toBeGreaterThan(0)
  })

  it('PATCH 设置：改宽限与顺序、整体替换规格，再读回来一致', async () => {
    useMock('admin')
    const current = await getJson(ComputeSettingsResponseSchema, '/api/admin/compute/settings', '设置')
    const plans = [...current.settings.plans].reverse()

    const patch = await request('PATCH', '/api/admin/compute/settings', {
      graceMinutes: 15,
      plans,
    })
    expect(patch.status).toBe(200)
    const updated = expectContract(ComputeSettingsResponseSchema, patch.payload, '保存设置响应')
    expect(updated.settings.graceMinutes).toBe(15)
    expect(updated.settings.plans.map((plan) => plan.id)).toEqual(plans.map((plan) => plan.id))

    const reread = await getJson(ComputeSettingsResponseSchema, '/api/admin/compute/settings', '设置重新读取')
    expect(reread.settings.graceMinutes).toBe(15)
  })

  it('GET /api/admin/compute/leases：带用户名、可按用户过滤', async () => {
    useMock('admin')
    const all = await getJson(ComputeLeaseListResponseSchema, '/api/admin/compute/leases', '全部租约')
    expect(all.total).toBeGreaterThan(0)
    expect(all.items.every((row) => row.username.length > 0)).toBe(true)

    const mine = await getJson(
      ComputeLeaseListResponseSchema,
      '/api/admin/compute/leases?userId=2',
      '某个用户的租约',
    )
    expect(mine.items.every((row) => row.userId === 2)).toBe(true)
  })

  it('GET /api/admin/instances：运行中的实例带 lease（计费中 / 免费）', async () => {
    useMock('admin')
    const { status, payload } = await request('GET', '/api/admin/instances')
    expect(status).toBe(200)
    const rows = expectContract(AdminInstanceListResponseSchema, payload, '实例列表')
    const withLease = rows.filter((row) => row.lease)
    expect(withLease.length).toBeGreaterThan(0)
    expect(withLease.some((row) => row.lease?.billed === false)).toBe(true)
    expect(rows.filter((row) => row.instance.status !== 'running').every((row) => !row.lease)).toBe(true)
  })
})
