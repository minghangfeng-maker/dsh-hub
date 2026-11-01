/**
 * 云实例唤醒状态的「过期」处理（backend store）。
 *
 * 真机复现（2026-10-29）：问完问题切后台 → 过一阵 Hub 把空闲容器休眠 → 回前台连不上，
 * 只能杀掉 App 重开。原因：回前台刷新 bootstrap 后云实例已不是 running，但 `wakeState`
 * 还停在上次的 `ready`，而自动唤醒只在 `idle` 时跑 —— 于是没人去唤醒，`ensureConnected`
 * 看到后端不可连接就直接返回。冷启动能好是因为 `wakeState` 从 `idle` 开始。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { gateway } from '../src/lib/instance'

function cloud(connectable: boolean): unknown {
  return {
    id: 'cloud:self',
    kind: 'cloud',
    name: '云实例',
    status: connectable ? 'running' : 'stopped',
    connectable,
    capabilities: {},
  }
}

function desktop(): unknown {
  return {
    id: 'desktop:pc',
    kind: 'desktop',
    name: '我的电脑',
    status: 'online',
    connectable: true,
    capabilities: {},
  }
}

function bootstrapWith(running: boolean, extra: unknown[] = []): never {
  return {
    user: { id: 1, username: 'alice', displayName: 'Alice' },
    points: { balance: 0, enabled: false },
    backends: [cloud(running), ...extra],
    instance: { status: running ? 'running' : 'stopped', capacityFull: false },
    serverTime: 1_730_000_000_000,
    app: {},
  } as never
}

/** 已登录、云实例在跑、已经唤醒过（ready）的 store。 */
function bootReady(extra: unknown[] = []) {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  const backend = useBackendStore()
  auth.phase = 'authenticated'
  auth.user = { id: 1, username: 'alice', displayName: 'Alice' } as never
  auth.backends = [cloud(true), ...extra] as never
  auth.instance = { status: 'running', capacityFull: false } as never
  backend.selectedBackendId = 'cloud:self'
  backend.wakeState = 'ready'
  return { auth, backend }
}

describe('backend 唤醒：ready 过期后重新唤醒', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('回前台发现云实例已休眠 → 退回 idle 并重新唤醒，起来后回到 ready', async () => {
    const { auth, backend } = bootReady()
    await nextTick()
    const wake = vi.spyOn(gateway, 'wake').mockResolvedValue({ status: 'starting' } as never)
    const bootstrap = vi.spyOn(gateway, 'bootstrap').mockResolvedValue(bootstrapWith(false))

    // 回前台：refreshBootstrap 看到实例已经停了
    await auth.refreshBootstrap()
    await nextTick()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(backend.wakeState).toBe('waking')

    // 容器起来了：下一次轮询看到 running + connectable
    bootstrap.mockResolvedValue(bootstrapWith(true))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.wakeState).toBe('ready')
    expect(backend.canUseCloud).toBe(true)
  })

  it('云实例一直在跑：回前台刷新 bootstrap 不触发唤醒', async () => {
    const { auth, backend } = bootReady()
    await nextTick()
    const wake = vi.spyOn(gateway, 'wake').mockResolvedValue({ status: 'running' } as never)
    vi.spyOn(gateway, 'bootstrap').mockResolvedValue(bootstrapWith(true))

    await auth.refreshBootstrap()
    await nextTick()
    expect(wake).not.toHaveBeenCalled()
    expect(backend.wakeState).toBe('ready')
  })

  it('唤醒失败（blocked）后刷新 bootstrap 不自动重试：仍等用户点「重试」', async () => {
    const { auth, backend } = bootReady()
    backend.wakeState = 'blocked'
    await nextTick()
    const wake = vi.spyOn(gateway, 'wake').mockResolvedValue({ status: 'starting' } as never)
    vi.spyOn(gateway, 'bootstrap').mockResolvedValue(bootstrapWith(false))

    await auth.refreshBootstrap()
    await nextTick()
    expect(wake).not.toHaveBeenCalled()
    expect(backend.wakeState).toBe('blocked')
  })

  it('还有在线的桌面后端时同样会唤醒云实例（与冷启动行为一致）', async () => {
    const { auth, backend } = bootReady([desktop()])
    await nextTick()
    const wake = vi.spyOn(gateway, 'wake').mockResolvedValue({ status: 'starting' } as never)
    vi.spyOn(gateway, 'bootstrap').mockResolvedValue(bootstrapWith(false, [desktop()]))

    await auth.refreshBootstrap()
    await nextTick()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(backend.wakeState).toBe('waking')
  })
})
