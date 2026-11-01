import { describe, expect, it } from 'vitest'
import {
  MOBILE_PROTOCOL_VERSION,
  MOBILE_V2_FEATURES,
  MOBILE_V2_FEATURE_OF_FRAME,
  MobileClientFrameAllSchema,
  MobileClientSessionStateRequestSchema,
  MobileServerFrameAllSchema,
  MobileServerSessionStateFrameSchema,
  MobileSessionRowV2Schema,
} from '../src/index.js'

/**
 * WP46 / M6 §2：`session-state` 契约。
 *
 * 只钉两件事（其余行为在 Hub 与 adapter 的测试里）：
 * 1. M6 §2.1 的冻结形状能被解析，且**新增全部可选、向后兼容**（`protocolVersion` 不变）；
 * 2. 客户端帧 `session-state-request` 是 strictObject，且必须协商 `session-state`。
 */

const stateFrame = {
  v: 1 as const,
  type: 'session-state' as const,
  sessionId: 's_1',
  cursor: 42,
  running: true,
  attemptId: 's_1:1',
  questions: [
    {
      agent: 's_1',
      callId: 'call_q',
      questions: [{ id: 'q1', question: '按哪个方案继续？', options: [{ label: '方案A' }] }],
      state: 'open' as const,
    },
  ],
  approvals: [
    {
      sessionId: 's_1',
      callId: 'call_a',
      approvalId: 'ev1',
      tool: 'bash',
      answerable: true,
      actions: ['approve', 'reject', 'cancel'] as const,
      state: 'open' as const,
    },
  ],
  at: '2026-10-27T12:00:00.000Z',
}

describe('session-state 服务端帧（M6 §2.1）', () => {
  it('冻结形状可解析；requestId 是可选加法字段（§2.2.4 的回包要带）', () => {
    expect(MobileServerSessionStateFrameSchema.safeParse(stateFrame).success).toBe(true)
    expect(
      MobileServerSessionStateFrameSchema.safeParse({ ...stateFrame, requestId: 'r1' }).success,
    ).toBe(true)
    // 空快照也合法（没有未决交互、没有 attempt、游标未知）
    expect(
      MobileServerSessionStateFrameSchema.safeParse({
        ...stateFrame,
        cursor: null,
        running: false,
        attemptId: null,
        questions: [],
        approvals: [],
      }).success,
    ).toBe(true)
  })

  it('上限：questions/approvals 各 ≤16；state 只允许 open/continued', () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
      ...stateFrame.questions[0],
      callId: `call_${String(index)}`,
    }))
    expect(MobileServerSessionStateFrameSchema.safeParse({ ...stateFrame, questions: many }).success).toBe(false)
    expect(
      MobileServerSessionStateFrameSchema.safeParse({
        ...stateFrame,
        questions: [{ ...stateFrame.questions[0], state: 'settled' }],
      }).success,
    ).toBe(false)
    const approvals = Array.from({ length: 17 }, (_, index) => ({
      ...stateFrame.approvals[0],
      approvalId: `ap_${String(index)}`,
    }))
    expect(MobileServerSessionStateFrameSchema.safeParse({ ...stateFrame, approvals }).success).toBe(false)
  })

  it('进入 MobileServerFrameAllSchema（通道层能原样转发）', () => {
    const parsed = MobileServerFrameAllSchema.parse(stateFrame)
    expect(parsed.type).toBe('session-state')
    if (parsed.type !== 'session-state') throw new Error('期望 session-state')
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.approvals?.[0]?.approvalId).toBe('ev1')
  })
})

describe('session-state-request 客户端帧（M6 §2.2.4）', () => {
  it('合法帧通过；多余字段被拒（strictObject）', () => {
    const frame = { v: 1, type: 'session-state-request', requestId: 'r1', sessionId: 's_1' }
    expect(MobileClientSessionStateRequestSchema.safeParse(frame).success).toBe(true)
    expect(MobileClientFrameAllSchema.safeParse(frame).success).toBe(true)
    expect(
      MobileClientSessionStateRequestSchema.safeParse({ ...frame, sinceCursor: 3 }).success,
    ).toBe(false)
    expect(
      MobileClientSessionStateRequestSchema.safeParse({ v: 1, type: 'session-state-request', sessionId: 's_1' })
        .success,
    ).toBe(false)
  })

  it('必须协商 session-state；特性列表与协议版本不变的老客户端照旧', () => {
    expect(MOBILE_V2_FEATURES).toContain('session-state')
    expect(MOBILE_V2_FEATURE_OF_FRAME['session-state-request']).toBe('session-state')
    // M6 §3：protocolVersion 不变
    expect(MOBILE_PROTOCOL_VERSION).toBe(1)
  })
})

describe('会话行 pendingInteractions（M6 §2.4）', () => {
  const row = {
    sessionId: 's_1',
    title: '会话',
    updatedAt: 1,
    running: false,
    blank: false,
    agentAvailable: true,
  }

  it('可选：老 Hub 不发也能解析；发了必须是非负整数', () => {
    expect(MobileSessionRowV2Schema.safeParse(row).success).toBe(true)
    expect(MobileSessionRowV2Schema.safeParse({ ...row, pendingInteractions: 2 }).success).toBe(true)
    expect(MobileSessionRowV2Schema.safeParse({ ...row, pendingInteractions: 0 }).success).toBe(true)
    expect(MobileSessionRowV2Schema.safeParse({ ...row, pendingInteractions: -1 }).success).toBe(false)
    expect(MobileSessionRowV2Schema.safeParse({ ...row, pendingInteractions: 1.5 }).success).toBe(false)
  })
})
