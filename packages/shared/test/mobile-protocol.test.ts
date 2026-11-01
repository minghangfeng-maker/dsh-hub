import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_PROTOCOL_VERSION,
  MobileClientFrameSchema,
  MobileNodesResponseSchema,
  MobileServerFrameSchema,
  DesktopRelayFrameEnvelopeSchema,
} from '../src/index.js'

/**
 * 冻结契约的可复用 fixture（M1）。
 *
 * 这些 JSON 同时被 M2（Android）与 M3（桌面 relay）当作对拍样例：
 * 任一侧改了字段而没改契约，这里先红。fixtures 的副本在
 * `mobile-plan/fixtures/mobile-v1/`，两边必须字节一致。
 */

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures', 'mobile-v1')

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as unknown
}

const CASES: ReadonlyArray<readonly [string, 'nodes' | 'client' | 'server' | 'relay']> = [
  ['nodes-response.json', 'nodes'],
  ['client-hello.json', 'client'],
  ['client-sessions.json', 'client'],
  ['client-history.json', 'client'],
  ['client-send.json', 'client'],
  ['client-subscribe.json', 'client'],
  ['client-stop.json', 'client'],
  ['client-create.json', 'client'],
  ['client-answer-question.json', 'client'],
  ['client-answer-approval.json', 'client'],
  ['client-ping.json', 'client'],
  ['server-hello.json', 'server'],
  ['server-sessions.json', 'server'],
  ['server-history.json', 'server'],
  ['server-delta.json', 'server'],
  ['server-delta-end.json', 'server'],
  ['server-turn.json', 'server'],
  ['server-message-user.json', 'server'],
  ['server-assistant-baseline.json', 'server'],
  ['server-message.json', 'server'],
  ['server-state.json', 'server'],
  ['server-question.json', 'server'],
  ['server-question-settled.json', 'server'],
  ['server-approval.json', 'server'],
  ['server-error.json', 'server'],
  ['server-pong.json', 'server'],
  ['relay-hello.json', 'relay'],
  ['relay-open.json', 'relay'],
  ['relay-frame.json', 'relay'],
  ['relay-close.json', 'relay'],
]

describe('mobile-v1 fixtures', () => {
  it('目录里的每个 JSON 都在用例表里（防止加了 fixture 忘了校验）', () => {
    // stream-chunks.json 是 chunk 形状集合，不是帧
    const AUX = new Set(['stream-chunks.json'])
    const files = readdirSync(fixturesDir).filter((name) => name.endsWith('.json') && !AUX.has(name))
    expect(new Set(files)).toEqual(new Set(CASES.map(([name]) => name)))
  })

  for (const [name, kind] of CASES) {
    it(`${name} 通过 ${kind} 契约`, () => {
      const value = load(name)
      if (kind === 'nodes') {
        const parsed = MobileNodesResponseSchema.parse(value)
        // 硬约束：节点列表不带 home/cwd/openUrl（M4 §3.1）
        for (const item of parsed.items) {
          expect(item).not.toHaveProperty('home')
          expect(item).not.toHaveProperty('cwd')
          expect(item).not.toHaveProperty('openUrl')
        }
      } else if (kind === 'client') {
        const parsed = MobileClientFrameSchema.parse(value)
        expect(parsed.v).toBe(MOBILE_PROTOCOL_VERSION)
      } else if (kind === 'server') {
        const parsed = MobileServerFrameSchema.parse(value)
        expect(parsed.v).toBe(MOBILE_PROTOCOL_VERSION)
      } else {
        DesktopRelayFrameEnvelopeSchema.parse(value)
      }
    })
  }
})

describe('mobile-v1 防漂移', () => {
  it('客户端帧拒绝未知字段（strictObject）', () => {
    const value = { ...(load('client-sessions.json') as Record<string, unknown>), extra: 1 }
    expect(() => MobileClientFrameSchema.parse(value)).toThrow()
  })

  it('未知协议版本被拒（不是「忽略版本继续跑」）', () => {
    const value = { ...(load('client-sessions.json') as Record<string, unknown>), v: 2 }
    expect(() => MobileClientFrameSchema.parse(value)).toThrow()
  })

  it('审批帧：schema 已预留 approve/reject 与 settled 语义，但真实能力由 capability 决定', () => {
    const value = load('server-approval.json') as { approval: { answerable: boolean; actions: string[]; state: string } }
    expect(value.approval.answerable).toBe(false)
    expect(value.approval.actions).toEqual(['cancel'])
    expect(value.approval.state).toBe('open')
    // schema 允许 future 的 approve/reject（不是被 literal(false) 焊死）
    const tampered = { ...(load('server-approval.json') as Record<string, unknown>) }
    const approval = { ...(tampered.approval as Record<string, unknown>), answerable: true, actions: ['approve', 'reject', 'cancel'] }
    expect(MobileServerFrameSchema.safeParse({ ...tampered, approval }).success).toBe(true)
  })

  it('clientMessageId 只出现在 user 消息上（来自 source.rpcId，不猜）', () => {
    const user = load('server-message-user.json') as { clientMessageId?: string }
    const assistant = load('server-message.json') as { clientMessageId?: string }
    expect(user.clientMessageId).toBe('m_01A')
    expect(assistant.clientMessageId).toBeUndefined()
  })

  it('delta 与 turn 是两种帧：chunk 结束不得冒充回合结束', () => {
    const deltaEnd = MobileServerFrameSchema.parse(load('server-delta-end.json'))
    const turn = MobileServerFrameSchema.parse(load('server-turn.json'))
    expect(deltaEnd.type).toBe('delta-end')
    expect(turn.type).toBe('turn')
    // 把 delta-end 冒充成 turn 必须被判别联合挡住（服务端帧允许加字段，但不许换 type 语义）
    expect(
      MobileServerFrameSchema.safeParse({ ...(load('server-delta-end.json') as object), type: 'turn' }).success,
    ).toBe(false)
  })
})
