/**
 * 嵌入座舱的「节点就绪」路径（WP56e3）。
 *
 * 真链路 e2e（Hub 的 /admin 同源 iframe）复现的 bug：
 *  - 座舱容器冷启动 60–90 秒，这期间 bootstrap 的 `cloud:ops` 是 `connectable:false`；
 *  - App 只把 `wakeState` 置成 `blocked` 并起轮询，轮询看到 connectable 变 true 之后
 *    **只是停掉自己**，既没把状态推成 ready，也没人再调 `ensureConnected()`；
 *  - 结果：Hub 侧一次 ticket 都收不到，输入框能打字、发送后永远停在「连上后自动发送」。
 *
 * 这里钉住两件事：
 *  1) 轮询看到 `cloud:ops` 变可连接后必须 `wakeState=ready`（App.vue 的 watch 据此建通道）；
 *  2) bootstrap 的「云是否可用」在嵌入模式下看 `cloud:ops`（不是 `cloud:self`），
 *     否则容量满判定会把一个正常的座舱误判成 CAPACITY_FULL。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 嵌入模式：真实实现由 `?embed=cockpit` 在 main.ts 里置位，单测直接固定成 true。
vi.mock('../src/lib/cockpit-embed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/cockpit-embed')>()
  return { ...actual, isCockpitEmbed: () => true }
})

import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { gateway } from '../src/lib/instance'

const COCKPIT_NODE = {
  id: 'cloud:ops',
  kind: 'cloud',
  name: '座舱 DSH',
  status: 'running',
  connectable: true,
  capabilities: {},
}

function cockpitBackend(connectable: boolean): Record<string, unknown> {
  return { ...COCKPIT_NODE, connectable }
}

/** 座舱 bootstrap：`instance` 字段与节点可连接性**不保证一致**（真 Hub 就是这样）。 */
function cockpitBootstrap(connectable: boolean, capacityFull = false): never {
  return {
    user: { id: 9001, username: 'hub-ops', displayName: '座舱 DSH' },
    points: { balance: 0, enabled: false },
    backends: [cockpitBackend(connectable)],
    instance: { status: 'running', capacityFull },
    serverTime: 1_730_000_000_000,
    app: {},
  } as never
}

function bootCockpit(backends: unknown[], instance: unknown) {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.phase = 'authenticated'
  auth.user = { id: 9001, username: 'hub-ops', displayName: '座舱 DSH' } as never
  auth.backends = backends as never
  auth.instance = instance as never
  const backend = useBackendStore()
  return { auth, backend }
}

describe('嵌入座舱冷启动：connectable 变 true 后必须推成 ready', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('第一次 bootstrap 不可连接 → blocked + 轮询；容器起来后 wakeState=ready（不调 wake）', async () => {
    const { auth, backend } = bootCockpit([], null)
    await nextTick()
    // 还没拿到 bootstrap：没有可连接的节点 → blocked，并且在轮询等它。
    expect(backend.wakeState).toBe('blocked')

    const wake = vi.spyOn(gateway, 'wake')
    const bootstrap = vi
      .spyOn(gateway, 'bootstrap')
      .mockResolvedValueOnce(cockpitBootstrap(false))
      .mockResolvedValue(cockpitBootstrap(true))

    // 轮询第一拍：拿到 connectable:false（容器还在起）
    await vi.advanceTimersByTimeAsync(2_500)
    expect(backend.canUseCloud).toBe(false)
    expect(backend.wakeState).toBe('blocked')

    // 轮询第二拍：connectable 变 true —— 必须推成 ready（之后 App 的 watcher 才会建通道）
    await vi.advanceTimersByTimeAsync(2_500)
    await nextTick()
    expect(backend.canUseCloud).toBe(true)
    expect(backend.wakeState).toBe('ready')
    expect(bootstrap).toHaveBeenCalledTimes(2)
    // 嵌入模式没有 wake 接口（scope=cockpit 的令牌会被 403）
    expect(wake).not.toHaveBeenCalled()

    // ready 之后轮询必须停：再走几个周期也不该继续打 bootstrap
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bootstrap).toHaveBeenCalledTimes(2)
    expect(auth.phase).toBe('authenticated')
  })

  it('bootstrap 直接可连接：ensureAwake 当场 ready，不进入轮询', async () => {
    const { backend } = bootCockpit([cockpitBackend(true)], {
      status: 'running',
      capacityFull: false,
    })
    await nextTick()
    expect(backend.wakeState).toBe('ready')
    expect(backend.canUseCloud).toBe(true)
  })
})

describe('嵌入座舱的 bootstrap 容量判定看 cloud:ops', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cloud:ops 可连接时 capacityFull 不误报 CAPACITY_FULL', async () => {
    const { auth } = bootCockpit([cockpitBackend(true)], {
      status: 'running',
      capacityFull: false,
    })
    await nextTick()
    vi.spyOn(gateway, 'bootstrap').mockResolvedValue(cockpitBootstrap(true, true))
    await auth.refreshBootstrap()
    // 修复前这里按 `cloud:self` 找不到后端 → canUseCloud=false → 误报容量满
    expect(auth.issue).toBeNull()
  })

  it('cloud:ops 不可连接时仍然给 CAPACITY_FULL（行为保持）', async () => {
    const { auth } = bootCockpit([], null)
    await nextTick()
    vi.spyOn(gateway, 'bootstrap').mockResolvedValue(cockpitBootstrap(false, true))
    await auth.refreshBootstrap()
    expect(auth.issue?.code).toBe('CAPACITY_FULL')
  })
})
