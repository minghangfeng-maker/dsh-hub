import { describe, expect, it } from 'vitest'

import {
  ASSIST_EXPECTED_HINT,
  ASSIST_READY_TIMEOUT_MS,
  ASSIST_STEP_KEYS,
  ASSIST_PHASE_META,
  assistLoadTitle,
  assistShowsLoadCard,
  formatAssistElapsed,
  synthAssistPhase,
  type AssistPhaseInput,
} from '@/utils/assist-phase'

/**
 * 启动与连接阶段合成（WP58，docs/26 §4.1）。
 *
 * 这一段是整页的「唯一真相」：胶囊、加载卡、按钮都读它。所以这里把每个阶段的判据、
 * 老 App 的兜底、180 秒超时、ready 之后的 offline 都钉死。
 */

function input(partial: Partial<AssistPhaseInput> = {}): AssistPhaseInput {
  return {
    instance: 'running',
    startRequested: false,
    startError: null,
    caps: ['status', 'layout', 'console'],
    appStatus: null,
    readyReceived: true,
    everReady: false,
    startedAt: null,
    now: 0,
    ...partial,
  }
}

const T0 = 1_760_000_000_000

describe('AI 助手 · 启动阶段合成（WP58）', () => {
  it('容器 stopped / missing：idle（三步都没开始）', () => {
    for (const instance of ['stopped', 'missing'] as const) {
      const result = synthAssistPhase(input({ instance, readyReceived: false }))
      expect(result.phase).toBe('idle')
      expect(result.steps).toEqual({ container: 'todo', dsh: 'todo', chat: 'todo' })
      expect(result.reason).toBeNull()
    }
  })

  it('还没读到容器状态（null）：当 idle，不误报「准备中」', () => {
    expect(synthAssistPhase(input({ instance: null, readyReceived: false })).phase).toBe('idle')
  })

  it('点了启动（接口还没回来）/ Hub starting：starting，第①步进行中', () => {
    const clicked = synthAssistPhase(
      input({ instance: 'stopped', readyReceived: false, startRequested: true }),
    )
    expect(clicked.phase).toBe('starting')
    expect(clicked.steps).toEqual({ container: 'active', dsh: 'todo', chat: 'todo' })

    const hubStarting = synthAssistPhase(input({ instance: 'starting', readyReceived: false }))
    expect(hubStarting.phase).toBe('starting')
  })

  it('容器 running、App 还没报连接（含 waking / 没报）：booting，第②步进行中', () => {
    const silent = synthAssistPhase(input({ readyReceived: false }))
    expect(silent.phase).toBe('booting')
    expect(silent.steps).toEqual({ container: 'done', dsh: 'active', chat: 'todo' })

    const waking = synthAssistPhase(input({ appStatus: { phase: 'waking', message: '正在唤醒…' } }))
    expect(waking.phase).toBe('booting')
    expect(waking.message).toBe('正在唤醒…')
  })

  it('App 报 auth / connecting：connecting，第③步进行中', () => {
    for (const phase of ['auth', 'connecting'] as const) {
      const result = synthAssistPhase(input({ appStatus: { phase } }))
      expect(result.phase).toBe('connecting')
      expect(result.steps).toEqual({ container: 'done', dsh: 'done', chat: 'active' })
    }
  })

  it('新 App 报 ready（容器 running）：ready，三步全勾', () => {
    const result = synthAssistPhase(input({ appStatus: { phase: 'ready' } }))
    expect(result.phase).toBe('ready')
    expect(result.steps).toEqual({ container: 'done', dsh: 'done', chat: 'done' })
    expect(result.legacy).toBe(false)
  })

  it('老 App 不带 caps：running + 收到 cockpit.ready 就算 ready（今天的兜底）', () => {
    const legacy = synthAssistPhase(input({ caps: null, readyReceived: true, appStatus: null }))
    expect(legacy.phase).toBe('ready')
    expect(legacy.legacy).toBe(true)

    // 没收到 ready 就还是准备中
    expect(synthAssistPhase(input({ caps: null, readyReceived: false })).phase).toBe('booting')
    // 容器没起来，收到 ready 也不算 ready
    expect(synthAssistPhase(input({ caps: null, readyReceived: true, instance: 'starting' })).phase).toBe(
      'starting',
    )
  })

  it('新 App 带了 caps 但还没报 ready：即使收到 cockpit.ready 也只到 booting（等 status）', () => {
    const result = synthAssistPhase(input({ caps: ['status'], readyReceived: true, appStatus: null }))
    expect(result.phase).toBe('booting')
    expect(result.legacy).toBe(false)
  })

  it('ready 之后 App 报 offline / 又回到 connecting：offline（不再盖加载卡）', () => {
    const offline = synthAssistPhase(
      input({ appStatus: { phase: 'offline' }, everReady: true, startedAt: T0, now: T0 + 30_000 }),
    )
    expect(offline.phase).toBe('offline')

    const rejoining = synthAssistPhase(
      input({ appStatus: { phase: 'connecting' }, everReady: true, startedAt: T0, now: T0 + 30_000 }),
    )
    expect(rejoining.phase).toBe('offline')

    // 时长已经超过 180 秒也不算失败：status 说它在重连
    const long = synthAssistPhase(
      input({
        appStatus: { phase: 'offline' },
        everReady: true,
        startedAt: T0,
        now: T0 + ASSIST_READY_TIMEOUT_MS * 3,
      }),
    )
    expect(long.phase).toBe('offline')
  })

  it('启动接口报错：failed 停在第①步，原因用接口的那句话', () => {
    const result = synthAssistPhase(
      input({ instance: 'stopped', startError: '启动失败：容器运行时不可用', startRequested: true }),
    )
    expect(result.phase).toBe('failed')
    expect(result.steps).toEqual({ container: 'failed', dsh: 'todo', chat: 'todo' })
    expect(result.reason).toBe('启动失败：容器运行时不可用')
    expect(assistShowsLoadCard(result.phase)).toBe(true)
  })

  it('Hub instance=error：failed（没有具体原因也要给一句）', () => {
    const result = synthAssistPhase(input({ instance: 'error', readyReceived: false }))
    expect(result.phase).toBe('failed')
    expect(result.reason).toContain('启动失败')
  })

  it('App 报 blocked：failed 停在第③步，用 App 的那句中文', () => {
    const result = synthAssistPhase(
      input({ appStatus: { phase: 'blocked', message: '这个账号没有座舱权限' } }),
    )
    expect(result.phase).toBe('failed')
    expect(result.steps).toEqual({ container: 'done', dsh: 'done', chat: 'failed' })
    expect(result.reason).toBe('这个账号没有座舱权限')
  })

  it('180 秒超时：按卡住的那一步报 failed（容器 / 等 DSH / 连接对话）', () => {
    const timeout = ASSIST_READY_TIMEOUT_MS

    const notStarted = synthAssistPhase(
      input({ instance: 'starting', readyReceived: false, startedAt: T0, now: T0 + timeout }),
    )
    expect(notStarted.phase).toBe('failed')
    expect(notStarted.steps.container).toBe('failed')

    const waitingDsh = synthAssistPhase(
      input({ instance: 'running', readyReceived: false, startedAt: T0, now: T0 + timeout }),
    )
    expect(waitingDsh.phase).toBe('failed')
    expect(waitingDsh.steps).toEqual({ container: 'done', dsh: 'failed', chat: 'todo' })

    const waitingChat = synthAssistPhase(
      input({ appStatus: { phase: 'connecting' }, startedAt: T0, now: T0 + timeout }),
    )
    expect(waitingChat.phase).toBe('failed')
    expect(waitingChat.steps).toEqual({ container: 'done', dsh: 'done', chat: 'failed' })
    expect(waitingChat.reason).toContain('180')
  })

  it('差 1 毫秒不到 180 秒：还没 failed', () => {
    const almost = synthAssistPhase(
      input({
        instance: 'running',
        // 老 App 才有「没报 status」的等待；新 App 这里保持 booting
        caps: null,
        readyReceived: false,
        startedAt: T0,
        now: T0 + ASSIST_READY_TIMEOUT_MS - 1,
      }),
    )
    expect(almost.phase).toBe('booting')
  })

  it('ready 之后计时停住：elapsed 不再参与判定', () => {
    const result = synthAssistPhase(
      input({
        appStatus: { phase: 'ready' },
        startedAt: T0,
        now: T0 + ASSIST_READY_TIMEOUT_MS * 2,
        everReady: true,
      }),
    )
    expect(result.phase).toBe('ready')
    expect(result.elapsedMs).toBe(ASSIST_READY_TIMEOUT_MS * 2)
  })

  it('胶囊文案与加载卡标题按阶段给（不会几处说法打架）', () => {
    expect(ASSIST_PHASE_META.idle.text).toBe('未启动')
    expect(ASSIST_PHASE_META.starting.text).toBe('启动中')
    expect(ASSIST_PHASE_META.booting.text).toBe('准备中')
    expect(ASSIST_PHASE_META.connecting.text).toBe('连接中')
    expect(ASSIST_PHASE_META.ready.text).toBe('就绪')
    expect(ASSIST_PHASE_META.offline.text).toBe('重连中')
    expect(ASSIST_PHASE_META.failed.text).toBe('启动失败')

    expect(assistLoadTitle('starting')).toContain('启动')
    expect(assistLoadTitle('booting')).toContain('DSH')
    expect(assistLoadTitle('connecting')).toContain('连接')
    expect(assistLoadTitle('failed')).toBe('启动失败')

    // idle / ready / offline 不盖加载卡
    expect(assistShowsLoadCard('idle')).toBe(false)
    expect(assistShowsLoadCard('ready')).toBe(false)
    expect(assistShowsLoadCard('offline')).toBe(false)
  })

  it('三步的键固定、文案与文档一致', () => {
    expect(ASSIST_STEP_KEYS).toEqual(['container', 'dsh', 'chat'])
    expect(ASSIST_EXPECTED_HINT).toContain('30–90 秒')
  })

  it('「已用 0:42」的时长格式', () => {
    expect(formatAssistElapsed(0)).toBe('0:00')
    expect(formatAssistElapsed(42_000)).toBe('0:42')
    expect(formatAssistElapsed(180_000)).toBe('3:00')
    expect(formatAssistElapsed(3_723_000)).toBe('62:03')
    expect(formatAssistElapsed(-5)).toBe('0:00')
    expect(formatAssistElapsed(Number.NaN)).toBe('0:00')
  })
})
