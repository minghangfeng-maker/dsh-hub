/**
 * 「上次打开的会话」：冷启动接着展示上一次对话（0.2.9）。
 * 纯逻辑 + 存储读写，不依赖浏览器/插件。
 */

import { describe, expect, it } from 'vitest'
import { MemoryKeyValueStore } from '@dsh-hub/mobile-core'
import {
  LAST_SESSION_KEY,
  LastSessionRestorer,
  clearLastSession,
  loadLastSession,
  parseLastSession,
  saveLastSession,
  type LastSessionRecord,
  type RestoreSessionCandidate,
} from '@/lib/last-session'

describe('parseLastSession', () => {
  it('合法记录：sessionId / backendId / at', () => {
    expect(
      parseLastSession(JSON.stringify({ sessionId: 's_1', backendId: 'cloud:self', at: 123 })),
    ).toEqual({ sessionId: 's_1', backendId: 'cloud:self', at: 123 })
  })

  it('坏数据一律当没有（空/非 JSON/数组/缺 sessionId/类型不对）', () => {
    expect(parseLastSession(null)).toBeNull()
    expect(parseLastSession('')).toBeNull()
    expect(parseLastSession('not json')).toBeNull()
    expect(parseLastSession('[]')).toBeNull()
    expect(parseLastSession(JSON.stringify({ backendId: 'x' }))).toBeNull()
    expect(parseLastSession(JSON.stringify({ sessionId: 123 }))).toBeNull()
    expect(parseLastSession(JSON.stringify({ sessionId: '' }))).toBeNull()
  })

  it('backendId / at 缺失或非法时降级（backend 任意/时间 0），不整条丢弃', () => {
    expect(parseLastSession(JSON.stringify({ sessionId: 's_1' }))).toEqual({
      sessionId: 's_1',
      backendId: null,
      at: 0,
    })
  })
})

describe('save / load / clear', () => {
  it('写进去能读出来；clear 后没有', async () => {
    const prefs = new MemoryKeyValueStore()
    await saveLastSession(prefs, { sessionId: 's_42', backendId: 'cloud:self', at: 999 })
    expect(await loadLastSession(prefs)).toEqual({
      sessionId: 's_42',
      backendId: 'cloud:self',
      at: 999,
    })
    await clearLastSession(prefs)
    expect(await loadLastSession(prefs)).toBeNull()
  })

  it('存储里的垃圾数据读出来是 null，不抛错', async () => {
    const prefs = new MemoryKeyValueStore()
    await prefs.set(LAST_SESSION_KEY, '{坏数据')
    expect(await loadLastSession(prefs)).toBeNull()
  })

  it('非法 sessionId 不写入（防脏数据）', async () => {
    const prefs = new MemoryKeyValueStore()
    await saveLastSession(prefs, { sessionId: '', backendId: null, at: 1 })
    expect(await prefs.get(LAST_SESSION_KEY)).toBeNull()
  })
})

// ── 冷启动恢复上次会话（0.2.14） ─────────────────────────────────────────────
//
// 真机根因：旧实现只等会话列表 4s（云容器冷启动唤醒 ~11s），且「放弃后本次运行不再重试」。
// LastSessionRestorer 把「等待 / 重试 / 取消 / 不重复」做成可测状态机：
//  - 会话列表晚到（唤醒后才有）也能恢复；
//  - timeout / auth-lost 允许后续触发重试，成功/取消后本次运行不再打开；
//  - 用户手动导航走 → 取消，不把人拽回旧会话；
//  - 归档 / 换后端 / 没有记录 → 不跳转。

interface RestorerHarness {
  restorer: LastSessionRestorer
  state: {
    record: LastSessionRecord | null
    sessions: RestoreSessionCandidate[]
    authenticated: boolean
    route: string | null | undefined
    backend: string | null
    controllerReady: boolean
    canceled: boolean
    opened: string[]
    navigated: string[]
    cleared: number
    now: number
    events: Array<{ name: string; detail?: string }>
  }
}

function makeHarness(options: {
  record?: LastSessionRecord | null
  sessions?: RestoreSessionCandidate[]
  authenticated?: boolean
  route?: string | null | undefined
  backend?: string | null
  controllerReady?: boolean
  timeoutMs?: number
  pollMs?: number
  /** 每次 sleep 时调用：用来模拟「会话列表晚到 / 用户导航 / 控制器就绪」。 */
  onSleep?: (state: RestorerHarness['state'], sleepIndex: number) => void
} = {}): RestorerHarness {
  const state: RestorerHarness['state'] = {
    record: options.record === undefined ? { sessionId: 's1', backendId: 'cloud:self', at: 1 } : options.record,
    sessions: options.sessions ?? [],
    authenticated: options.authenticated ?? true,
    route: options.route === undefined ? 'home' : options.route,
    backend: options.backend === undefined ? 'cloud:self' : options.backend,
    controllerReady: options.controllerReady ?? true,
    canceled: false,
    opened: [],
    navigated: [],
    cleared: 0,
    now: 0,
    events: [],
  }
  let sleepIndex = 0
  const restorer = new LastSessionRestorer({
    loadRecord: async () => state.record,
    clearRecord: async () => {
      state.cleared += 1
      state.record = null
    },
    isAuthenticated: () => state.authenticated,
    routeName: () => state.route,
    selectedBackendId: () => state.backend,
    findSession: (sessionId) => state.sessions.find((row) => row.sessionId === sessionId) ?? null,
    canOpenSession: () => state.controllerReady,
    openSession: async (sessionId) => {
      state.opened.push(sessionId)
    },
    navigate: async (sessionId) => {
      state.navigated.push(sessionId)
    },
    isCanceled: () => state.canceled,
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms
      options.onSleep?.(state, sleepIndex)
      sleepIndex += 1
    },
    onEvent: (name, detail) => state.events.push({ name, detail }),
    timeoutMs: options.timeoutMs ?? 60_000,
    pollMs: options.pollMs ?? 100,
  })
  return { restorer, state }
}

describe('冷启动恢复上次会话：等会话列表（云容器唤醒 ~11s）', () => {
  it('会话列表晚到也能恢复；恢复后再次触发不会重复打开', async () => {
    const h = makeHarness({
      onSleep: (state, index) => {
        // 前 3 次轮询都没有会话（通道还没连上/容器还在唤醒）
        if (index === 2) state.sessions = [{ sessionId: 's1' }]
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
    expect(h.state.navigated).toEqual(['s1'])
    expect(h.state.now).toBe(300)
    expect(h.restorer.settled).toBe(true)

    // 成功后任意触发（回前台/会话列表更新）都不再打开一次
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
    expect(h.state.navigated).toEqual(['s1'])
  })

  it('总窗口内等不到会话 → timeout（不落结论），记录保留；后续会话出现再试成功', async () => {
    const h = makeHarness({ timeoutMs: 300 })
    await expect(h.restorer.restore()).resolves.toBe('timeout')
    expect(h.state.opened).toEqual([])
    expect(h.state.cleared).toBe(0)
    expect(h.state.record).not.toBeNull()
    expect(h.state.events.some((e) => e.name === 'restore:timeout')).toBe(true)
    expect(h.restorer.settled).toBe(false)

    // 唤醒完成后会话列表回来了（App 会因 sessions 变化再次触发）
    h.state.sessions = [{ sessionId: 's1' }]
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
  })

  it('60s 默认窗口覆盖云容器冷启动（11s 时仍在等）', async () => {
    const h = makeHarness({
      onSleep: (state, index) => {
        if (index === 109) state.sessions = [{ sessionId: 's1' }] // 11s / 100ms
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
    expect(h.state.now).toBe(11_000)
  })
})

describe('冷启动恢复上次会话：取消 / 归档 / 换后端', () => {
  it('用户手动导航走了（比如点了别的会话/设置）→ 取消，不打开旧会话', async () => {
    const h = makeHarness({
      onSleep: (state) => {
        state.route = 'settings'
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('canceled')
    expect(h.state.opened).toEqual([])
    // 之后再触发也不再恢复（本次运行已取消）
    h.state.route = 'home'
    h.state.sessions = [{ sessionId: 's1' }]
    await expect(h.restorer.restore()).resolves.toBe('canceled')
    expect(h.state.opened).toEqual([])
  })

  it('restorer.cancel()：取消进行中的恢复', async () => {
    const holder: { restorer: LastSessionRestorer | null } = { restorer: null }
    const h = makeHarness({
      onSleep: () => holder.restorer?.cancel(),
    })
    holder.restorer = h.restorer
    await expect(h.restorer.restore()).resolves.toBe('canceled')
    expect(h.state.opened).toEqual([])
  })

  it('会话已归档 → 清掉记录，留在首页', async () => {
    const h = makeHarness({ sessions: [{ sessionId: 's1', archived: true }] })
    await expect(h.restorer.restore()).resolves.toBe('archived')
    expect(h.state.cleared).toBe(1)
    expect(h.state.record).toBeNull()
    expect(h.state.opened).toEqual([])
    expect(h.restorer.settled).toBe(true)
  })

  it('后端变了（App 自动回退到可连接后端）→ 不跳转也不清记录', async () => {
    const h = makeHarness({ backend: 'desktop:home' })
    await expect(h.restorer.restore()).resolves.toBe('backend-mismatch')
    expect(h.state.opened).toEqual([])
    expect(h.state.cleared).toBe(0)
    expect(h.state.record).not.toBeNull()
  })

  it('没有记录 → none，且不再反复尝试', async () => {
    const h = makeHarness({ record: null })
    await expect(h.restorer.restore()).resolves.toBe('none')
    expect(h.restorer.settled).toBe(true)
    h.state.record = { sessionId: 's2', backendId: 'cloud:self', at: 2 }
    await expect(h.restorer.restore()).resolves.toBe('none')
    expect(h.state.opened).toEqual([])
  })
})

describe('冷启动恢复上次会话：等待控制器 / 登录态 / 路由 resolve', () => {
  it('控制器没建好（后端切换中）时不开会话，就绪后再打开', async () => {
    const h = makeHarness({
      sessions: [{ sessionId: 's1' }],
      controllerReady: false,
      onSleep: (state, index) => {
        if (index === 1) state.controllerReady = true
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
    expect(h.state.navigated).toEqual(['s1'])
    expect(h.state.now).toBe(200)
  })

  it('启动初期路由还没 resolve → 等它落到首页再打开（避免开了会话却没跳转）', async () => {
    const h = makeHarness({
      sessions: [{ sessionId: 's1' }],
      route: undefined,
      onSleep: (state, index) => {
        if (index === 1) state.route = 'home'
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
    expect(h.state.navigated).toEqual(['s1'])
  })

  it('恢复过程中登录态丢了 → auth-lost（不落结论），重新登录后还能恢复', async () => {
    const h = makeHarness({
      authenticated: false,
      onSleep: () => {
        /* 不会 sleep：未登录立刻返回 */
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('auth-lost')
    expect(h.restorer.settled).toBe(false)
    expect(h.state.opened).toEqual([])

    // 手动/自动重新登录成功 + 会话列表到了
    h.state.authenticated = true
    h.state.sessions = [{ sessionId: 's1' }]
    await expect(h.restorer.restore()).resolves.toBe('restored')
    expect(h.state.opened).toEqual(['s1'])
  })

  it('恢复过程中登录态丢了（轮询中）→ auth-lost，不打开会话', async () => {
    const h = makeHarness({
      onSleep: (state) => {
        state.authenticated = false
      },
    })
    await expect(h.restorer.restore()).resolves.toBe('auth-lost')
    expect(h.state.opened).toEqual([])
  })
})
