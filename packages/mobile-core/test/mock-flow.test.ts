/**
 * mock Hub 全流程：登录 → bootstrap → 唤醒 → 连接 → 会话 → 发送 → 流式 → 停止 → 断线续传。
 *
 * 走的是与真实 Hub 完全相同的 `WorkspaceController`，所以这里通过就说明
 * 帧时序、幂等、baseline 续传在「有服务端配合」时不打架。
 */

import { describe, expect, it } from 'vitest'
import { MockHub } from '../src/mock/mock-hub.js'
import { WorkspaceController } from '../src/channel/workspace.js'
import { MOCK_REPLY } from '../src/mock/content.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(5)
  }
}

async function loggedInHub(options: { tickMs?: number; wakeMs?: number } = {}): Promise<MockHub> {
  const hub = new MockHub({ tickMs: options.tickMs ?? 1, wakeMs: options.wakeMs ?? 5 })
  await hub.login({
    username: 'demo',
    password: 'demo1234',
    deviceName: 'test-device',
    platform: 'android',
  })
  return hub
}

async function awakeController(hub: MockHub): Promise<WorkspaceController> {
  // 先唤醒，等 connectable
  await hub.wake()
  await waitFor('实例就绪', () => hub.instanceState === 'running', 2_000)
  const controller = new WorkspaceController({
    nodeId: 'cloud:self',
    client: { name: 'mock-test', version: '0.1.0-dev' },
    openChannel: (nodeId) => hub.openChannel(nodeId),
    keepAlive: false,
    reconnect: { baseMs: 1, maxMs: 5, maxAttempts: 3 },
  })
  controller.start()
  await waitFor('通道连上', () => controller.getState().link === 'connected', 2_000)
  await waitFor('会话列表', () => controller.getState().sessions.length > 0, 2_000)
  return controller
}

describe('mock 全流程', () => {
  it('登录错误码按契约映射', async () => {
    const hub = new MockHub()
    await expect(
      hub.login({ username: 'pending', password: 'demo1234', deviceName: 'd', platform: 'android' }),
    ).rejects.toMatchObject({ code: 'USER_PENDING' })
    await expect(
      hub.login({ username: 'disabled', password: 'demo1234', deviceName: 'd', platform: 'android' }),
    ).rejects.toMatchObject({ code: 'USER_DISABLED' })
    await expect(
      hub.login({ username: 'changepw', password: 'demo1234', deviceName: 'd', platform: 'android' }),
    ).rejects.toMatchObject({ code: 'MUST_CHANGE_PASSWORD' })
    await expect(
      hub.login({ username: 'demo', password: 'wrong', deviceName: 'd', platform: 'android' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('bootstrap → 唤醒 → 连接 → 发送 → 流式 → 完成', async () => {
    const hub = await loggedInHub()
    const before = await hub.bootstrap()
    expect(before.user.username).toBe('demo')
    expect(before.points).toMatchObject({ balance: 1280.5, enabled: true })
    expect(before.backends.map((b) => b.id)).toEqual(['cloud:self', 'dv_mock_desktop_01'])
    const desktop = before.backends[1]!
    expect(desktop).toMatchObject({ connectable: false, reason: 'desktop-remote-off' })

    const controller = await awakeController(hub)
    const state = controller.getState()
    expect(state.capabilities?.send).toBe(true)
    // MockHub 只实现了一部分 v2 特性：hello 回显的是「双方交集」，不是客户端声明的全集。
    // 2026-10-27 WP46 起 MockHub 也实现 `session-state`（回合态快照），交集多一项。
    expect(state.features).toEqual(['models', 'tools', 'reasoning', 'archive', 'usage', 'session-state'])
    expect(state.sessions.map((s) => s.sessionId)).toContain('s_mock_plan')
    // v2：hello 回显 models 后自动拉目录（fixture 形状：2 个模型、4 个档位）
    await waitFor('模型目录', () => (controller.getState().models?.items.length ?? 0) > 0)
    expect(controller.getState().models?.items[0]?.efforts.map((e) => e.id)).toEqual([
      'off',
      'low',
      'high',
      'max',
    ])

    controller.openSession('s_mock_plan')
    await waitFor('历史消息', () => controller.getState().messages.length === 2)
    expect(controller.getState().messages[0]!.text).toContain('今天的计划')

    controller.send('帮我整理一下')
    await waitFor('用户消息已归并', () =>
      controller.getState().messages.some((m) => m.role === 'user' && m.text === '帮我整理一下'),
    )
    await waitFor('开始流式', () => (controller.getState().streamingText ?? '').length > 0)
    await waitFor('回合结束', () => !controller.getState().turnRunning && controller.getState().streamingText === null)

    const messages = controller.getState().messages
    const assistant = messages.filter((m) => m.role === 'assistant').at(-1)!
    expect(assistant.text).toBe(MOCK_REPLY)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2) // 预置 1 条 + 本轮 1 条
    expect(controller.getState().pendingSendCount).toBe(0)
  })

  it('归档筛选：默认不含已归档，切换后用 includeArchived 拉全量', async () => {
    const hub = await loggedInHub()
    const controller = await awakeController(hub)
    // 默认列表不含已归档
    expect(controller.getState().sessions.map((s) => s.sessionId)).not.toContain('s_mock_archived')
    controller.setIncludeArchived(true)
    await waitFor('归档列表', () =>
      controller.getState().sessions.some((s) => s.sessionId === 's_mock_archived'),
    )
    const archivedRow = controller
      .getState()
      .sessions.find((s) => s.sessionId === 's_mock_archived')!
    expect(archivedRow.archived).toBe(true)
    controller.setIncludeArchived(false)
    await waitFor('回到默认列表', () =>
      controller.getState().sessions.every((s) => s.sessionId !== 's_mock_archived'),
    )
  })

  it('切换模型与档位：set-model 后投影更新当前选择', async () => {
    const hub = await loggedInHub()
    const controller = await awakeController(hub)
    controller.openSession('s_mock_blank')
    await waitFor('会话打开', () => controller.getState().openSessionId === 's_mock_blank')
    controller.setModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' })
    await waitFor(
      '选择更新',
      () =>
        controller.getState().modelSelection?.model === 'deepseek-v4-pro' &&
        controller.getState().modelSelection?.effortTier === 'ultra',
    )
  })

  it('停止：1 秒内回到空闲，保留已生成的部分，不再增长', async () => {
    const hub = await loggedInHub({ tickMs: 2 })
    const controller = await awakeController(hub)
    controller.openSession('s_mock_blank')
    await waitFor('空会话打开', () => controller.getState().openSessionId === 's_mock_blank')

    controller.send('慢慢写')
    await waitFor('流式进行中', () => (controller.getState().streamingText ?? '').length > 20)
    controller.stopTurn()
    expect(controller.getState().stopRequested).toBe(true)
    await waitFor('回合结束', () => controller.getState().turnRunning === false && !controller.getState().stopRequested)

    const assistant = controller.getState().messages.filter((m) => m.role === 'assistant').at(-1)!
    expect(assistant.text.length).toBeGreaterThan(0)
    expect(assistant.text.length).toBeLessThan(MOCK_REPLY.length)
    const frozen = assistant.text
    await sleep(30)
    const again = controller.getState().messages.filter((m) => m.role === 'assistant').at(-1)!
    expect(again.text).toBe(frozen)
  })

  it('断线续传：用 assistant-baseline 恢复，不重复前半段', async () => {
    const hub = await loggedInHub({ tickMs: 2 })
    const controller = await awakeController(hub)
    controller.openSession('s_mock_blank')
    await waitFor('空会话打开', () => controller.getState().openSessionId === 's_mock_blank')

    controller.send('断线测试')
    await waitFor('流式进行中', () => (controller.getState().streamingText ?? '').length > 20)
    const beforeDrop = controller.getState().streamingText!

    hub.simulateDisconnect()
    expect(controller.getState().link === 'reconnecting' || controller.getState().link === 'connected').toBe(true)

    await waitFor('重连成功', () => controller.getState().link === 'connected', 3_000)
    await waitFor(
      '回合结束',
      () => !controller.getState().turnRunning && controller.getState().streamingText === null,
      10_000,
    )

    const assistant = controller.getState().messages.filter((m) => m.role === 'assistant').at(-1)!
    // 正文完整且没有「前半段重复拼接」
    expect(assistant.text).toBe(MOCK_REPLY)
    expect(assistant.text.startsWith(beforeDrop)).toBe(true)
    expect(assistant.text.indexOf(MOCK_REPLY.slice(0, 20), 1)).toBe(-1)
  })

  it('设备被吊销 → 通道关闭并通知回登录页', async () => {
    const hub = await loggedInHub()
    let lost = 0
    const controller = new WorkspaceController({
      nodeId: 'cloud:self',
      client: { name: 'mock-test', version: '0.1.0-dev' },
      openChannel: (nodeId) => hub.openChannel(nodeId),
      keepAlive: false,
      reconnect: { baseMs: 1, maxMs: 5, maxAttempts: 2 },
      onSessionExpired: () => (lost += 1),
    })
    await hub.wake()
    await waitFor('实例就绪', () => hub.instanceState === 'running', 2_000)
    controller.start()
    await waitFor('连上', () => controller.getState().link === 'connected')
    await hub.simulateRevoke()
    await waitFor('回到登录', () => lost > 0)
    controller.dispose()
  })
})
