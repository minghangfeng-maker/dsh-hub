/**
 * `cockpit.status`（WP58 / docs/26 §4.1、§5）的单测。
 *
 * 要钉住的是三件在联调里最容易坏的事：
 *  1. 冷启动的**顺序**：auth → waking → connecting → ready（Hub 的加载卡按顺序打勾）；
 *  2. 断了再连：ready → offline → ready（Hub 的胶囊变黄再变回就绪）；
 *  3. **去重**：同一 phase 不重复发（每次 watch 一抖就发会让父页面一直重渲染）。
 *
 * 纯逻辑测试：不碰 store、不发消息（发送在 stores/cockpit.ts 里接）。
 */

import { describe, expect, it } from 'vitest'
import {
  CockpitStatusTracker,
  cockpitStatusOf,
  cockpitStatusText,
  type CockpitStatusSnapshot,
} from '../src/lib/cockpit-status'
import { cockpitReadyMessage, COCKPIT_CONSOLE_CAPS } from '../src/lib/cockpit'

/** 冷启动最开始：登录过了、通道还没建、容器还没起来。 */
function snapshot(overrides: Partial<CockpitStatusSnapshot> = {}): CockpitStatusSnapshot {
  return {
    authenticated: true,
    wakeState: 'idle',
    connectable: false,
    link: 'idle',
    modelsReady: false,
    blockedReason: null,
    ...overrides,
  }
}

/** 走一遍 tracker，返回真正会发出的 phase 序列（便于断言顺序）。 */
function phaseSequence(
  tracker: CockpitStatusTracker,
  snapshots: CockpitStatusSnapshot[],
): string[] {
  const sent: string[] = []
  for (const item of snapshots) {
    const update = tracker.take(item)
    if (update !== null) sent.push(update.phase)
  }
  return sent
}

describe('阶段判据（cockpitStatusOf）', () => {
  it('没登录 → auth（包括等父页面交接）', () => {
    expect(cockpitStatusOf(snapshot({ authenticated: false }), false)).toBe('auth')
    expect(cockpitStatusOf(snapshot({ authenticated: false }), true)).toBe('auth')
  })

  it('有明确失败原因 → blocked（优先于 wakeState 的 blocked）', () => {
    expect(
      cockpitStatusOf(snapshot({ wakeState: 'blocked', blockedReason: '容量已满' }), false),
    ).toBe('blocked')
  })

  it('节点不可连接（容器冷启动）→ waking，而不是 blocked', () => {
    // 座舱里 backend.wakeState 在轮询期间也是 'blocked'，但那时没有 auth.issue
    expect(cockpitStatusOf(snapshot({ wakeState: 'blocked', connectable: false }), false)).toBe(
      'waking',
    )
    expect(cockpitStatusOf(snapshot({ wakeState: 'waking' }), false)).toBe('waking')
  })

  it('节点可连接但通道没建 → connecting', () => {
    expect(cockpitStatusOf(snapshot({ connectable: true, link: 'idle' }), false)).toBe('connecting')
    expect(cockpitStatusOf(snapshot({ connectable: true, link: 'connecting' }), false)).toBe(
      'connecting',
    )
  })

  it('通道连上但模型列表还没到 → 仍是 connecting（发消息会被排队）', () => {
    expect(
      cockpitStatusOf(snapshot({ connectable: true, link: 'connected', modelsReady: false }), false),
    ).toBe('connecting')
  })

  it('全都齐了 → ready（已登录 + connectable + 通道 + 模型列表）', () => {
    expect(
      cockpitStatusOf(snapshot({ connectable: true, link: 'connected', modelsReady: true }), false),
    ).toBe('ready')
  })

  it('ready 之后通道/节点断了 → offline；还回得来 → ready', () => {
    expect(
      cockpitStatusOf(snapshot({ connectable: true, link: 'closed', modelsReady: true }), true),
    ).toBe('offline')
    expect(
      cockpitStatusOf(snapshot({ connectable: false, link: 'connected', modelsReady: true }), true),
    ).toBe('offline')
    expect(
      cockpitStatusOf(snapshot({ connectable: true, link: 'connected', modelsReady: true }), true),
    ).toBe('ready')
  })

  it('还没 ready 过时断线算 connecting（不是 offline）', () => {
    expect(
      cockpitStatusOf(snapshot({ connectable: true, link: 'closed', modelsReady: false }), false),
    ).toBe('connecting')
  })
})

describe('phase → 中文（不含敏感信息）', () => {
  it('每个阶段都有一句给人看的话', () => {
    expect(cockpitStatusText('auth')).toContain('登录')
    expect(cockpitStatusText('waking')).toContain('容器')
    expect(cockpitStatusText('connecting')).toContain('连接')
    expect(cockpitStatusText('ready')).toBe('已就绪')
    expect(cockpitStatusText('offline')).toContain('重连')
    expect(cockpitStatusText('blocked', '容量已满')).toBe('容量已满')
    expect(cockpitStatusText('blocked')).toBe('助手暂时不可用')
  })
})

describe('冷启动顺序（auth → waking → connecting → ready）', () => {
  it('按 Hub 的判据顺序依次发出，最后是 ready', () => {
    const tracker = new CockpitStatusTracker()
    const sent = phaseSequence(tracker, [
      snapshot({ authenticated: false, wakeState: 'idle' }),
      snapshot({ authenticated: true, connectable: false, wakeState: 'blocked' }),
      snapshot({ authenticated: true, connectable: true, link: 'connecting' }),
      snapshot({ authenticated: true, connectable: true, link: 'connected', modelsReady: true }),
    ])
    expect(sent).toEqual(['auth', 'waking', 'connecting', 'ready'])
  })

  it('同一条链路上「重复拍快照」不会重复发（去重）', () => {
    const tracker = new CockpitStatusTracker()
    const waking = snapshot({ connectable: false, wakeState: 'blocked' })
    const connecting = snapshot({ connectable: true, link: 'connecting' })
    const ready = snapshot({ connectable: true, link: 'connected', modelsReady: true })
    const sent = phaseSequence(tracker, [
      waking,
      waking,
      waking,
      connecting,
      connecting,
      ready,
      ready,
      ready,
    ])
    expect(sent).toEqual(['waking', 'connecting', 'ready'])
    expect(tracker.current).toBe('ready')
  })

  it('ready → offline → ready 都能再发（phase 变了）', () => {
    const tracker = new CockpitStatusTracker()
    const ready = snapshot({ connectable: true, link: 'connected', modelsReady: true })
    const offline = snapshot({ connectable: true, link: 'failed' })
    const sent = phaseSequence(tracker, [ready, offline, offline, ready, offline, ready])
    expect(sent).toEqual(['ready', 'offline', 'ready', 'offline', 'ready'])
  })

  it('blocked 带上原因（message 直接用原因文案）', () => {
    const tracker = new CockpitStatusTracker()
    const update = tracker.take(
      snapshot({ wakeState: 'blocked', blockedReason: '容器启动失败（镜像拉取超时）' }),
    )
    expect(update).toEqual({ phase: 'blocked', message: '容器启动失败（镜像拉取超时）' })
  })

  it('reset 之后从头再报一遍（重新挂桥 / 换令牌）', () => {
    const tracker = new CockpitStatusTracker()
    const ready = snapshot({ connectable: true, link: 'connected', modelsReady: true })
    expect(tracker.take(ready)).not.toBeNull()
    expect(tracker.take(ready)).toBeNull()
    tracker.reset()
    expect(tracker.current).toBeNull()
    expect(tracker.take(ready)?.phase).toBe('ready')
  })
})

describe('cockpit.ready 的 caps（docs/26 §5）', () => {
  it('控制台主题带三个能力，顺序固定', () => {
    expect(COCKPIT_CONSOLE_CAPS).toEqual(['status', 'layout', 'console'])
    expect(cockpitReadyMessage(true)).toEqual({
      type: 'cockpit.ready',
      caps: ['status', 'layout', 'console'],
    })
  })

  it('其它主题（bridge / 不传 theme）一字不改：只有 type', () => {
    expect(cockpitReadyMessage(false)).toEqual({ type: 'cockpit.ready' })
  })
})
