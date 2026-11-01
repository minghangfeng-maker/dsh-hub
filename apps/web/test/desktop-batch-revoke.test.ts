import type { DesktopBatchRevokeItem, DesktopBatchRevokeResponse, DesktopDevice, DesktopDeviceAdminItem } from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import {
  getAdminDesktopDevice,
  listAdminDesktopDevices,
  revokeAdminDesktopDevices,
} from '@/api/desktop'
import AdminDesktopDevicesPanel from '@/components/admin/desktop/AdminDesktopDevicesPanel.vue'
import { routes } from '@/router'

/**
 * 批量吊销（WP25f 交付物 2）：勾选规则（本页全选 / 已吊销不可选 / 上限 50）、
 * 二次确认、四种 outcome 的展示、只重试「未生效」的那几台。
 */
vi.mock('@/api/desktop', () => ({
  listAdminDesktopDevices: vi.fn(),
  revokeAdminDesktopDevice: vi.fn(),
  revokeAdminDesktopDevices: vi.fn(),
  getAdminDesktopDevice: vi.fn(),
}))

const IDS = ['a', 'b', 'c', 'd'].map((char) => `dv_${char.repeat(32)}`)

function device(index: number, overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: IDS[index] ?? `dv_${String(index).repeat(32).slice(0, 32)}`,
    name: `设备 ${String(index + 1)}`,
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    capabilities: null,
    appliedRevision: 17,
    desiredRevision: 17,
    appliedAt: '2026-10-22T08:00:00.000Z',
    applyState: 'applied',
    applyErrorCode: null,
    errorCount: 0,
    presence: 'online',
    firstSeenAt: '2026-10-01T08:00:00.000Z',
    registeredAt: '2026-10-21T08:00:00.000Z',
    lastReportAt: '2026-10-22T08:20:00.000Z',
    lastAuthAt: '2026-10-21T08:00:00.000Z',
    revokedAt: null,
    revokeReason: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

function item(index: number, overrides: Partial<DesktopDevice> = {}): DesktopDeviceAdminItem {
  return {
    user: {
      id: 100 + index,
      slug: `u${String(index)}`,
      username: `user${String(index)}`,
      displayName: `用户 ${String(index)}`,
      avatarUrl: null,
    },
    device: device(index, overrides),
    pluginCount: 3,
  }
}

function page(items: DesktopDeviceAdminItem[], total = items.length) {
  return { items, total, page: 1, pageSize: 20 }
}

function outcome(deviceId: string, value: DesktopBatchRevokeItem['outcome']): DesktopBatchRevokeItem {
  return { deviceId, outcome: value, device: null }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

async function mountPanel(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/instances?tab=desktop')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(AdminDesktopDevicesPanel) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

/** 表头的「本页全选」与每行的勾选框（naive 用 role=checkbox 的 div） */
function headerCheckbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('.n-data-table-th .n-checkbox')
  expect(found, '应有表头全选框').toBeTruthy()
  return found!
}

function rowCheckboxes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.n-data-table-tbody .n-checkbox')]
}

async function click(element: HTMLElement): Promise<void> {
  element.click()
  await flushPromises()
}

function clickPopconfirm(text: string): void {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  expect(button, `应有「${text}」按钮`).toBeTruthy()
  button!.click()
}

beforeEach(() => {
  vi.mocked(listAdminDesktopDevices).mockResolvedValue(
    page([
      item(0),
      item(1, { presence: 'offline' }),
      item(2, { revokedAt: '2026-10-20T08:00:00.000Z', revokeReason: 'admin', presence: 'revoked' }),
      item(3),
    ]),
  )
})

describe('勾选规则', () => {
  it('本页全选只勾在用的行；已吊销的行勾选框禁用', async () => {
    await mountPanel()

    const boxes = rowCheckboxes()
    expect(boxes).toHaveLength(4)
    // 第 3 行已吊销 → 禁用（naive 的 disabled 类名 + 点不动）
    expect(boxes[2]?.classList.contains('n-checkbox--disabled')).toBe(true)
    await click(boxes[2]!)
    expect(boxes[2]?.getAttribute('aria-checked')).toBe('false')

    // 表头全选：勾上在用的那 3 台
    await click(headerCheckbox())
    expect(document.querySelector('[data-testid="admin-desktop-selected"]')?.textContent).toContain('已选 3 台')
    expect(rowCheckboxes().map((box) => box.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'false',
      'true',
    ])
    // 勾上之后才出现批量条（不是常驻）
    expect(document.querySelector('[data-testid="admin-desktop-batch-revoke"]')).toBeTruthy()
  })

  it('超过 50 台只提示、不发请求', async () => {
    const many = Array.from({ length: 60 }, (_value, index) =>
      item(index, { deviceId: `dv_${String(index).padStart(32, '0')}` }),
    )
    vi.mocked(listAdminDesktopDevices).mockResolvedValue(page(many, 60))
    await mountPanel()

    await click(headerCheckbox())
    expect(document.querySelector('[data-testid="admin-desktop-selected"]')?.textContent).toContain('已选 60 台')

    await click(document.querySelector<HTMLElement>('[data-testid="admin-desktop-batch-revoke"]')!)
    clickPopconfirm('确认吊销')
    await flushPromises()

    expect(revokeAdminDesktopDevices).not.toHaveBeenCalled()
    // 结果区不出现（没有真的发请求）
    expect(document.querySelector('[data-testid="admin-desktop-batch-result"]')).toBeNull()
  })
})

describe('批量吊销的结果', () => {
  it('四种 outcome 各一条；not_found / failed 算「未生效」并可重试这几台', async () => {
    const response: DesktopBatchRevokeResponse = {
      items: [
        outcome(IDS[0]!, 'revoked'),
        outcome(IDS[1]!, 'already_revoked'),
        outcome(IDS[2]!, 'not_found'),
        outcome(IDS[3]!, 'failed'),
      ],
      revoked: 1,
      skipped: 3,
    }
    vi.mocked(revokeAdminDesktopDevices).mockResolvedValue(response)
    await mountPanel()

    await click(headerCheckbox())
    await click(document.querySelector<HTMLElement>('[data-testid="admin-desktop-batch-revoke"]')!)
    // 二次确认里写了台数与后果
    const confirmText = document.body.textContent ?? ''
    expect(confirmText).toContain('将吊销所选 3 台设备')
    expect(confirmText).toContain('这些桌面端会立即退出登录')
    clickPopconfirm('确认吊销')
    await flushPromises()

    expect(revokeAdminDesktopDevices).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(revokeAdminDesktopDevices).mock.calls[0]?.[0] ?? []
    expect(sent).toEqual([IDS[0], IDS[1], IDS[3]])

    const result = document.querySelector('[data-testid="admin-desktop-batch-result"]')
    expect(result).toBeTruthy()
    expect(result!.textContent).toContain('已吊销 1 / 4 台')
    expect(result!.textContent).toContain('3 台未生效')
    const rows = [...document.querySelectorAll('[data-testid="admin-desktop-batch-item"]')]
    expect(rows.map((row) => row.getAttribute('data-outcome'))).toEqual([
      'revoked',
      'already_revoked',
      'not_found',
      'failed',
    ])
    const text = result!.textContent ?? ''
    expect(text).toContain('已吊销')
    expect(text).toContain('此前已吊销')
    expect(text).toContain('未生效 · 设备不存在')
    expect(text).toContain('未生效 · 服务端出错')
    // 设备名用提交前的快照（吊销后列表里就没有这几行了）
    expect(text).toContain('设备 1')
    expect(text).toContain('设备 2')
    expect(text).toContain('设备 4')

    // 重试只带未生效的两台
    const retry = document.querySelector<HTMLElement>('[data-testid="admin-desktop-batch-retry"]')
    expect(retry?.textContent).toContain('重试未生效的 2 台')
    vi.mocked(revokeAdminDesktopDevices).mockResolvedValue({
      items: [outcome(IDS[2]!, 'not_found'), outcome(IDS[3]!, 'revoked')],
      revoked: 1,
      skipped: 1,
    })
    await click(retry!)
    expect(vi.mocked(revokeAdminDesktopDevices).mock.calls[1]?.[0]).toEqual([IDS[2], IDS[3]])
  })

  it('全部成功时结果条是成功态、没有重试按钮，并刷新台账', async () => {
    vi.mocked(revokeAdminDesktopDevices).mockResolvedValue({
      items: [outcome(IDS[0]!, 'revoked')],
      revoked: 1,
      skipped: 0,
    })
    await mountPanel()
    const before = vi.mocked(listAdminDesktopDevices).mock.calls.length

    await click(rowCheckboxes()[0]!)
    await click(document.querySelector<HTMLElement>('[data-testid="admin-desktop-batch-revoke"]')!)
    clickPopconfirm('确认吊销')
    await flushPromises()

    const result = document.querySelector('[data-testid="admin-desktop-batch-result"]')
    expect(result!.textContent).toContain('已吊销 1 / 1 台')
    expect(result!.textContent).not.toContain('未生效')
    expect(document.querySelector('[data-testid="admin-desktop-batch-retry"]')).toBeNull()
    expect(vi.mocked(listAdminDesktopDevices).mock.calls.length).toBeGreaterThan(before)
  })
})

describe('点一行看详情', () => {
  it('点设备名所在的单元格 → 按 deviceId 打开抽屉', async () => {
    vi.mocked(getAdminDesktopDevice).mockResolvedValue({
      user: item(0).user,
      device: device(0),
      plugins: [],
      pluginCount: 0,
      audit: [],
    })
    await mountPanel()

    const cell = [...document.querySelectorAll<HTMLElement>('.n-data-table-tbody tr')][0]?.querySelectorAll('td')[2]
    expect(cell).toBeTruthy()
    cell!.click()
    await flushPromises()

    expect(getAdminDesktopDevice).toHaveBeenCalledWith(IDS[0])
  })

  it('点行内的吊销按钮不会误开抽屉', async () => {
    await mountPanel()
    const button = document.querySelector<HTMLElement>('[data-testid="admin-desktop-revoke"]')
    expect(button).toBeTruthy()
    button!.click()
    await flushPromises()
    expect(getAdminDesktopDevice).not.toHaveBeenCalled()
  })
})
