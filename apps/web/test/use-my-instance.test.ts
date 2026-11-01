import type { InstanceStatus, InstanceSummary, MyInstanceResponse } from '@dsh-hub/shared'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { HubApiError } from '@/api/http'
import { useMyInstance, type OpenTab, type UseMyInstanceDeps } from '@/composables/useMyInstance'
import type { SseSource } from '@/composables/useSse'

/**
 * 「打开 DSH」在未运行时的流程（任务书「测试」节：mock API）。
 * 核心是浏览器弹窗拦截：`window.open` 必须在点击的同一个同步 tick 里发生，
 * 就绪后再把占位标签的 `location.href` 指过去。
 */

const OPEN_URL = '/dsh/littletao/'

class FakeSource implements SseSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function summary(status: InstanceStatus, partial: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    status,
    runtimeVersion: '0.9.4',
    startedAt: status === 'running' ? '2026-10-12T09:47:00.000Z' : null,
    lastActiveAt: '2026-10-12T11:56:00.000Z',
    needsRecreate: false,
    error: null,
    openUrl: OPEN_URL,
    ...partial,
  }
}

const QUOTA = {
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 512,
  diskGb: 20,
  idleStopMinutes: 60,
  idleNoClientMinutes: 30,
  allowUserPlugins: true,
}

function response(status: InstanceStatus, partial: Partial<InstanceSummary> = {}): MyInstanceResponse {
  return {
    instance: summary(status, partial),
    quota: QUOTA,
    stats:
      status === 'running'
        ? {
            cpuPercent: 36.8,
            memoryBytes: 1_700_000_000,
            memoryLimitBytes: 4 * 1024 ** 3,
            pids: 47,
            diskBytes: 6_800_000_000,
            diskLimitBytes: 20 * 1024 ** 3,
          }
        : null,
    modelSummary: {
      policy: 'managed',
      preset: '默认预设',
      defaultModel: 'deepseek-chat',
      providers: ['DeepSeek'],
    },
  }
}

function mountHost(deps: UseMyInstanceDeps = {}) {
  const sources: FakeSource[] = []
  const host = defineComponent({
    setup() {
      const api = useMyInstance({
        immediate: false,
        pollIntervalMs: 1,
        statsIntervalMs: 1_000_000,
        startupTimeoutMs: 2_000,
        sseFactory: (url: string) => {
          const source = new FakeSource(url)
          sources.push(source)
          return source
        },
        ...deps,
      })
      return { api }
    },
    template: '<div />',
  })

  const wrapper = mount(host)
  const api = (wrapper.vm as unknown as { api: ReturnType<typeof useMyInstance> }).api
  return { wrapper, api, sources }
}

function fakeTab(): OpenTab {
  return { location: { href: '' } }
}

describe('「打开 DSH」流程（07 §6.1）', () => {
  it('未运行：先同步开空白页 → start → 轮询到 running → 改 location（绕开弹窗拦截）', async () => {
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('starting') }))
    let polls = 0
    const fetchInstance = vi.fn(async () => {
      polls += 1
      // 第一次轮询还没起来，第二次 running
      return response(polls >= 2 ? 'running' : 'starting')
    })

    const { api } = mountHost({ fetchInstance, start, openWindow })

    expect(api.isRunning.value).toBe(false)
    const result = await api.openDsh()

    expect(result).toBe('opened')
    // 占位页必须是同步开的（弹窗拦截只认同步调用）
    expect(openWindow).toHaveBeenNthCalledWith(1, 'about:blank')
    expect(openWindow.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0] ?? 0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(fetchInstance.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(tab.location.href).toBe(OPEN_URL)
    expect(api.instance.value?.status).toBe('running')
    expect(api.phase.value).toBeNull()
  })

  it('start 直接返回 running：不睡不轮询，占位页当场指向 openUrl（POST 已在服务端等到就绪）', async () => {
    vi.useFakeTimers()
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('running') }))
    const fetchInstance = vi.fn(async () => response('running'))

    const { api, wrapper } = mountHost({ fetchInstance, start, openWindow })
    try {
      const opening = api.openDsh()

      // 只让出微任务、不推进假时钟：实现里如果还在睡一个轮询间隔，href 不会变
      await vi.advanceTimersByTimeAsync(0)
      expect(tab.location.href).toBe(OPEN_URL)

      await expect(opening).resolves.toBe('opened')
      expect(start).toHaveBeenCalledTimes(1)
      // 返回体已经是 running，不该再拉一次 /api/me/instance
      expect(fetchInstance).not.toHaveBeenCalled()
      expect(api.phase.value).toBeNull()
      expect(api.opening.value).toBe(false)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('start 只回到 starting：按默认 300ms 轮询，running 后跳转', async () => {
    vi.useFakeTimers()
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('starting') }))
    let polls = 0
    const fetchInstance = vi.fn(async () => {
      polls += 1
      return response(polls >= 2 ? 'running' : 'starting')
    })

    // pollIntervalMs 显式传 undefined：让 composable 用默认值（300ms），验证默认值没被改回大间隔
    const { api, wrapper } = mountHost({
      fetchInstance,
      start,
      openWindow,
      pollIntervalMs: undefined,
    })
    try {
      const opening = api.openDsh()
      await vi.advanceTimersByTimeAsync(0)
      // 进循环前先看本地状态：没 running 也先不额外拉一次接口
      expect(fetchInstance).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(299)
      expect(fetchInstance).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(fetchInstance).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(300)
      expect(fetchInstance).toHaveBeenCalledTimes(2)

      await expect(opening).resolves.toBe('opened')
      expect(tab.location.href).toBe(OPEN_URL)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('轮询到 error：仍然报错（INSTANCE_START_FAILED）并且不跳转', async () => {
    vi.useFakeTimers()
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('starting') }))
    const fetchInstance = vi.fn(async () => response('error', { error: '容器启动失败：端口没起来' }))

    const { api, wrapper } = mountHost({ fetchInstance, start, openWindow, pollIntervalMs: 5 })
    try {
      const opening = api.openDsh()
      await vi.advanceTimersByTimeAsync(5)

      await expect(opening).resolves.toBe('error')
      expect(api.errorCode.value).toBe('INSTANCE_START_FAILED')
      expect(api.errorText.value).toContain('端口没起来')
      expect(tab.location.href).toBe('')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('连点两次「打开 DSH」：只发一个 start，第二次直接返回 busy', async () => {
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    let release: (value: { instance: InstanceSummary }) => void = () => {}
    const start = vi.fn(
      () =>
        new Promise<{ instance: InstanceSummary }>((resolve) => {
          release = resolve
        }),
    )
    const fetchInstance = vi.fn(async () => response('running'))

    const { api } = mountHost({ fetchInstance, start, openWindow })

    const first = api.openDsh()
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(api.opening.value).toBe(true)

    // 第二下（同一个 tick 里、卡片按钮还没来得及禁用）：必须被吞掉，不多开占位页也不多发 start
    await expect(api.openDsh()).resolves.toBe('busy')
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)

    release({ instance: summary('running') })
    await expect(first).resolves.toBe('opened')
    expect(tab.location.href).toBe(OPEN_URL)
    expect(start).toHaveBeenCalledTimes(1)
    expect(fetchInstance).not.toHaveBeenCalled()
  })

  it('start 还没返回时再触发一次：只发一个 POST（run 单飞）', async () => {
    let release: (value: { instance: InstanceSummary }) => void = () => {}
    const start = vi.fn(
      () =>
        new Promise<{ instance: InstanceSummary }>((resolve) => {
          release = resolve
        }),
    )
    const fetchInstance = vi.fn(async () => response('running'))

    const { api } = mountHost({ fetchInstance, start })

    const first = api.start()
    await expect(api.start()).resolves.toBe(false)
    expect(start).toHaveBeenCalledTimes(1)

    release({ instance: summary('running') })
    await expect(first).resolves.toBe(true)
  })

  it('运行中：直接打开 openUrl，不 start、不再开空白页、也不再拉接口', async () => {
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('running') }))
    const fetchInstance = vi.fn(async () => response('running'))

    const { api } = mountHost({ fetchInstance, start, openWindow })
    await api.refresh()
    expect(api.isRunning.value).toBe(true)

    const result = await api.openDsh()

    expect(result).toBe('opened')
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith(OPEN_URL)
    expect(start).not.toHaveBeenCalled()
    // 已经 running：除了 refresh 那次，不再额外打 /api/me/instance
    expect(fetchInstance).toHaveBeenCalledTimes(1)
  })

  it('弹窗被浏览器拦住：返回 blocked（界面提示手动打开）', async () => {
    const openWindow = vi.fn(() => null)
    const start = vi.fn(async () => ({ instance: summary('starting') }))
    const fetchInstance = vi.fn(async () => response('running'))

    const { api } = mountHost({ fetchInstance, start, openWindow })
    const result = await api.openDsh()

    expect(result).toBe('blocked')
  })

  it('CAPACITY_FULL：提示友好文案（含 running/max），不会把占位标签指过去', async () => {
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => {
      throw new HubApiError('CAPACITY_FULL', '同时在用的人有点多，稍后再试试', 503, { running: 12, max: 12 })
    })
    const fetchInstance = vi.fn(async () => response('stopped'))

    const { api } = mountHost({ fetchInstance, start, openWindow })
    const result = await api.openDsh()

    expect(result).toBe('error')
    expect(api.errorCode.value).toBe('CAPACITY_FULL')
    expect(api.errorText.value).toContain('12/12')
    expect(tab.location.href).toBe('')
  })

  it('启动超时：给出「稍后回来看看」的提示', async () => {
    const tab = fakeTab()
    const openWindow = vi.fn(() => tab)
    const start = vi.fn(async () => ({ instance: summary('starting') }))
    const fetchInstance = vi.fn(async () => response('starting'))

    const { api } = mountHost({ fetchInstance, start, openWindow, startupTimeoutMs: 20, pollIntervalMs: 5 })
    const result = await api.openDsh()

    expect(result).toBe('error')
    expect(api.errorText.value).toContain('启动时间有点久')
  })

  it('SSE status 事件更新实例、阶段文字与资源', async () => {
    // 服务端状态跟着 SSE 一起走（ready 之后 /api/me/instance 也会返回 running）
    let current: InstanceStatus = 'stopped'
    const { api, sources } = mountHost({ fetchInstance: vi.fn(async () => response(current)) })
    await api.refresh()

    expect(sources[0]?.url).toBe('/api/me/instance/events')

    sources[0]!.emit('status', {
      instance: summary('starting'),
      phase: 'bootstrapping',
      message: '正在安装插件（2/3）',
    })
    await Promise.resolve()

    expect(api.status.value).toBe('starting')
    expect(api.phase.value).toBe('bootstrapping')
    expect(api.phaseMessage.value).toBe('正在安装插件（2/3）')
    expect(api.isBusy.value).toBe(true)

    current = 'running'
    sources[0]!.emit('status', { instance: summary('running'), phase: 'ready', message: '准备就绪' })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.status.value).toBe('running')
    expect(api.phase.value).toBeNull()
  })

  it('停止与重启各自调用接口并更新状态', async () => {
    const stop = vi.fn(async () => ({ instance: summary('stopping') }))
    const restart = vi.fn(async () => ({ instance: summary('starting') }))
    const fetchInstance = vi.fn(async () => response('running'))

    const { api } = mountHost({ fetchInstance, stop, restart })
    await api.refresh()

    expect(await api.stop()).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(api.status.value).toBe('stopping')

    expect(await api.restart()).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(api.status.value).toBe('starting')
    expect(api.phase.value).toBe('pulling')
  })
})
