import type {
  AdminInstanceRow,
  AdminOverviewResponse,
  InstanceActionResponse,
  InstanceStatus,
} from '@dsh-hub/shared'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { instanceAction, listInstanceStats, listInstances } from '@/api/admin-instances'
import { fetchOverview } from '@/api/admin-users'
import InstanceCard from '@/components/admin/InstanceCard.vue'
import { routes } from '@/router'
import AdminInstancesView from '@/views/admin/AdminInstancesView.vue'

/**
 * WP15 ③：实例操作串扰的前端一半。
 *
 * 旧实现是一只共用 `busy`：点任一实例的任一按钮，**所有**实例的所有按钮一起转圈。
 * 现在按 userId 记录进行中的操作（卡片视图与表格视图都要），只让被点的那个实例变化。
 */
vi.mock('@/api/admin-instances', () => ({
  listInstances: vi.fn(),
  listInstanceStats: vi.fn(),
  instanceAction: vi.fn(),
}))
vi.mock('@/api/admin-users', () => ({ fetchOverview: vi.fn() }))

const OVERVIEW: AdminOverviewResponse = {
  users: { total: 2, active: 2, pending: 0, disabled: 0, newToday: 0 },
  instances: { running: 2, max: 12, starting: 0, error: 0 },
  host: {
    cpuCount: 4,
    load1: 0.1,
    load5: 0.2,
    memTotal: 8 * 1024 ** 3,
    memAvailable: 4 * 1024 ** 3,
    diskTotal: 100 * 1024 ** 3,
    diskFree: 50 * 1024 ** 3,
    dockerOk: true,
    dockerVersion: '27.0.0',
  },
  jobs: { running: 0, queued: 0, failedLast24h: 0 },
  runtime: { defaultVersion: null, versions: 0 },
  recent: { registrations: [], audit: [] },
}

function row(id: number, username: string, status: InstanceStatus = 'running'): AdminInstanceRow {
  return {
    user: { id, slug: `u${id}`, username, displayName: username, avatarUrl: null },
    instance: {
      status,
      runtimeVersion: '0.9.4',
      startedAt: '2026-10-12T09:47:00.000Z',
      lastActiveAt: '2026-10-12T11:56:00.000Z',
      needsRecreate: false,
      error: null,
      openUrl: `/dsh/${username}/`,
    },
    stats: null,
  }
}

const ROWS = [row(1, 'alice'), row(2, 'bob')]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function actionResponse(status: InstanceStatus): InstanceActionResponse {
  return { instance: { ...ROWS[0]!.instance, status } }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(listInstances).mockResolvedValue(ROWS)
  vi.mocked(listInstanceStats).mockResolvedValue([])
  vi.mocked(fetchOverview).mockResolvedValue(OVERVIEW)
  vi.mocked(instanceAction).mockResolvedValue(actionResponse('running'))
})

async function mountView(view: 'cards' | 'table' = 'cards'): Promise<VueWrapper> {
  // useStorage 对 string 默认值用「原样存」的序列化器（不套 JSON 引号），这里照它的写法写
  window.localStorage.setItem('hub.admin.instances-view', view)
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/instances')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(AdminInstancesView) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

/** 某张按钮是不是转圈中（naive-ui 的 loading 只加 class，不置 disabled） */
function isLoading(button: DOMWrapper<Element>): boolean {
  return button.classes().includes('n-button--loading')
}

function isDisabled(button: DOMWrapper<Element>): boolean {
  // 用 naive 的 class 判定而不是 `disabled` 属性：`tag="a"` 的按钮会把 disabled="false" 也写进属性里
  return button.classes().includes('n-button--disabled')
}

function buttonIn(container: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<Element> {
  const button = container.findAll('button').find((item) => item.text().trim() === text)
  expect(button, `应有「${text}」按钮`).toBeTruthy()
  return button!
}

function cardFor(wrapper: VueWrapper, userId: number): VueWrapper {
  const card = wrapper
    .findAllComponents(InstanceCard)
    .find((item) => (item.props('row') as AdminInstanceRow).user.id === userId)
  expect(card, `应有 user ${String(userId)} 的实例卡片`).toBeTruthy()
  return card!
}

function tableRow(wrapper: VueWrapper, username: string): DOMWrapper<Element> {
  const tr = wrapper.findAll('tr').find((item) => item.text().includes(username))
  expect(tr, `表格里应有 ${username} 的行`).toBeTruthy()
  return tr!
}

const ACTIONS = ['启动', '停止', '重启', '重建'] as const

describe('AdminInstancesView 按实例隔离 busy（WP15 ③）', () => {
  it('卡片视图：点 A 的「停止」未完成时，只有 A 的停止转圈、A 其他按钮 disabled，B 完全不受影响', async () => {
    const gate = deferred<InstanceActionResponse>()
    vi.mocked(instanceAction).mockReturnValue(gate.promise)

    const wrapper = await mountView('cards')
    await buttonIn(cardFor(wrapper, 1), '停止').trigger('click')
    await nextTick()

    expect(instanceAction).toHaveBeenCalledWith(1, 'stop')
    const aliceStop = buttonIn(cardFor(wrapper, 1), '停止')
    expect(isLoading(aliceStop)).toBe(true)
    for (const text of ['启动', '重启', '重建']) {
      const button = buttonIn(cardFor(wrapper, 1), text)
      expect(isLoading(button), `A 的「${text}」不该转圈`).toBe(false)
      expect(isDisabled(button), `A 的「${text}」该 disabled（同实例串行）`).toBe(true)
    }

    for (const text of ACTIONS) {
      const button = buttonIn(cardFor(wrapper, 2), text)
      expect(isLoading(button), `B 的「${text}」不该转圈`).toBe(false)
      expect(isDisabled(button), `B 的「${text}」该照常可点`).toBe(false)
    }

    // 同一实例未完成时再点（哪怕绕过了 disabled）不会重复提交
    await buttonIn(cardFor(wrapper, 1), '重启').trigger('click')
    await nextTick()
    expect(instanceAction).toHaveBeenCalledTimes(1)

    // 请求结束 → 按钮恢复
    gate.resolve(actionResponse('stopped'))
    await flushPromises()
    expect(instanceAction).toHaveBeenCalledTimes(1)
    expect(isLoading(buttonIn(cardFor(wrapper, 1), '停止'))).toBe(false)
    expect(isDisabled(buttonIn(cardFor(wrapper, 1), '启动'))).toBe(false)
  })

  it('表格视图：同样只让被点的那一行变化', async () => {
    const gate = deferred<InstanceActionResponse>()
    vi.mocked(instanceAction).mockReturnValue(gate.promise)

    const wrapper = await mountView('table')
    expect(tableRow(wrapper, 'alice').text()).toContain('运行中')

    await buttonIn(tableRow(wrapper, 'alice'), '停止').trigger('click')
    await nextTick()
    expect(instanceAction).toHaveBeenCalledWith(1, 'stop')

    expect(isLoading(buttonIn(tableRow(wrapper, 'alice'), '停止'))).toBe(true)
    expect(isDisabled(buttonIn(tableRow(wrapper, 'alice'), '启动'))).toBe(true)
    for (const text of ACTIONS) {
      const button = buttonIn(tableRow(wrapper, 'bob'), text)
      expect(isLoading(button), `B 的「${text}」不该转圈`).toBe(false)
      expect(isDisabled(button), `B 的「${text}」该照常可点`).toBe(false)
    }

    gate.resolve(actionResponse('stopped'))
    await flushPromises()
    expect(isLoading(buttonIn(tableRow(wrapper, 'alice'), '停止'))).toBe(false)
  })

  it('InstanceCard：busyAction 只影响对应的那颗按钮', async () => {
    const card = mount(InstanceCard, { props: { row: ROWS[0]!, busyAction: 'restart' } })
    expect(isLoading(buttonIn(card, '重启'))).toBe(true)
    for (const text of ['启动', '停止', '重建']) {
      expect(isLoading(buttonIn(card, text))).toBe(false)
      expect(isDisabled(buttonIn(card, text))).toBe(true)
    }
    // 「打开」是外链（tag="a"），任何情况下都不该被挡
    const open = card.findAll('a').find((item) => item.text().trim() === '打开')
    expect(open, '应有「打开」链接').toBeTruthy()
    expect(isDisabled(open!)).toBe(false)
    card.unmount()
  })
})
