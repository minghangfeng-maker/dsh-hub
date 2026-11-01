import { DEFAULT_RELAY_SETTINGS, type ComputeLeaseRow, type RelayLedgerRow } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import { getRelaySettings, updateRelaySettings } from '@/api/admin-relay'
import RelaySettingsTab from '@/components/admin/relay/RelaySettingsTab.vue'
import LedgerTable from '@/components/relay/LedgerTable.vue'
import ComputeLeaseTable from '@/components/user/compute/ComputeLeaseTable.vue'
import { formatClock, formatMemoryGb, leaseEndReasonText } from '@/components/user/compute/text'

vi.mock('@/api/admin-relay', () => ({
  getRelaySettings: vi.fn(),
  updateRelaySettings: vi.fn(),
}))

/**
 * 「积分与用量」的算力租赁记录（13 §7）：结束原因中文映射、列内容；
 * 中转站设置的「每日赠送」与注册赠送并列、保存时提交微积分。
 */

const ROWS: ComputeLeaseRow[] = [
  {
    id: 120,
    userId: 12,
    username: 'littletao',
    planId: 'c4m8',
    planName: '4 核 8 GB',
    cpus: 4,
    memoryMb: 8192,
    pricePerHourMicro: 500_000,
    blockPriceMicro: 83_334,
    billed: true,
    startedAt: '2026-10-18T04:00:00.000Z',
    paidUntil: '2026-10-18T04:25:00.000Z',
    graceUntil: null,
    endedAt: null,
    endReason: null,
    blocks: 3,
    chargedMicro: 250_002,
  },
  {
    id: 101,
    userId: 12,
    username: 'littletao',
    planId: 'c2m4',
    planName: '2 核 4 GB',
    cpus: 2,
    memoryMb: 4096,
    pricePerHourMicro: 300_000,
    blockPriceMicro: 50_000,
    billed: true,
    startedAt: '2026-10-17T01:00:00.000Z',
    paidUntil: '2026-10-17T02:30:00.000Z',
    graceUntil: null,
    endedAt: '2026-10-17T02:30:00.000Z',
    endReason: 'user',
    blocks: 3,
    chargedMicro: 150_000,
  },
]

describe('算力租赁记录（13 §7）', () => {
  it('结束原因中文映射：八种契约枚举', () => {
    expect(leaseEndReasonText('user')).toBe('用户停止')
    expect(leaseEndReasonText('admin')).toBe('管理员停止')
    expect(leaseEndReasonText('idle')).toBe('空闲自动停止')
    expect(leaseEndReasonText('insufficient')).toBe('余额不足停止')
    expect(leaseEndReasonText('crash')).toBe('异常退出')
    expect(leaseEndReasonText('plan-change')).toBe('切换规格')
    expect(leaseEndReasonText('billing-off')).toBe('计费关闭')
    expect(leaseEndReasonText('system')).toBe('系统')
    expect(leaseEndReasonText(null)).toBe('进行中')
  })

  it('时间与内存的小工具', () => {
    expect(formatMemoryGb(4096)).toBe('4 GB')
    expect(formatMemoryGb(1536)).toBe('1.5 GB')
    expect(formatClock('2026-10-18T04:25:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatClock(null)).toBe('—')
  })

  it('表格：规格、时长、块数、花费、结束原因', async () => {
    const wrapper = mount(ComputeLeaseTable, {
      props: { rows: ROWS, total: 2, page: 1, pageSize: 20 },
    })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('4 核 8 GB')
    expect(text).toContain('2 核 4 GB')
    expect(text).toContain('进行中')
    expect(text).toContain('用户停止')
    expect(text).toContain('0.25')
    expect(text).toContain('0.15')
  })
})

describe('积分流水的新类型（13 §6）', () => {
  it('每日赠送 / 赠送作废 / 算力租赁 都显示中文类型', async () => {
    const rows: RelayLedgerRow[] = [
      {
        id: 1,
        userId: 12,
        username: 'littletao',
        type: 'daily',
        amountMicro: 600_000,
        balanceAfterMicro: 2_400_000,
        note: '每日赠送',
        actor: null,
        createdAt: '2026-10-18T01:00:00.000Z',
      },
      {
        id: 2,
        userId: 12,
        username: 'littletao',
        type: 'expire',
        amountMicro: -300_000,
        balanceAfterMicro: 2_100_000,
        note: '昨日赠送未用完，作废',
        actor: null,
        createdAt: '2026-10-18T00:30:00.000Z',
      },
      {
        id: 3,
        userId: 12,
        username: 'littletao',
        type: 'compute',
        amountMicro: -250_002,
        balanceAfterMicro: 1_850_000,
        note: '4 核 8 GB 10 分钟 × 3',
        actor: null,
        createdAt: '2026-10-17T20:00:00.000Z',
      },
    ]

    const wrapper = mount(LedgerTable, { props: { rows, total: 3, page: 1, pageSize: 20 } })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('每日赠送')
    expect(text).toContain('赠送作废')
    expect(text).toContain('算力租赁')
    expect(text).toContain('4 核 8 GB 10 分钟 × 3')
  })
})

describe('中转站设置 · 每日赠送（13 §2 §7）', () => {
  const settings = { ...DEFAULT_RELAY_SETTINGS, signupBonusMicro: 5_000_000, dailyBonusMicro: 600_000 }

  beforeEach(() => {
    vi.mocked(getRelaySettings).mockReset()
    vi.mocked(updateRelaySettings).mockReset()

    vi.mocked(getRelaySettings).mockResolvedValue({
      settings,
      internalBaseUrl: 'http://10.213.0.1:7710/v1',
      publicBaseUrl: 'https://hub.example.com:8123/v1',
    })
    vi.mocked(updateRelaySettings).mockImplementation(async (input) => ({
      settings: { ...settings, ...input },
      internalBaseUrl: 'http://10.213.0.1:7710/v1',
      publicBaseUrl: 'https://hub.example.com:8123/v1',
    }))
  })

  it('与注册赠送并列显示，值按「积分」录入；保存提交 dailyBonusMicro', async () => {
    const Host = defineComponent({
      components: { RelaySettingsTab, NMessageProvider },
      template: '<NMessageProvider><RelaySettingsTab /></NMessageProvider>',
    })
    const wrapper = mount(Host)
    await flushPromises()

    const input = wrapper.get('[data-testid="relay-daily-bonus"] input')
    expect((input.element as HTMLInputElement).value).toBe('0.6')

    await input.setValue('1.2')
    const save = wrapper.findAll('button').find((button) => button.text() === '保存设置')
    expect(save).toBeTruthy()
    await save?.trigger('click')
    await flushPromises()

    expect(updateRelaySettings).toHaveBeenCalledTimes(1)
    const body = vi.mocked(updateRelaySettings).mock.calls[0]?.[0]
    expect(body?.dailyBonusMicro).toBe(1_200_000)
    expect(body?.signupBonusMicro).toBe(5_000_000)
    wrapper.unmount()
  })
})
