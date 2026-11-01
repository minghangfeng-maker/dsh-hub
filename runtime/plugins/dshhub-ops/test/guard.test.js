/**
 * 座舱守则注入的单元测试（不联网）：内容快照 + 每回合一次 + 拿不到 `/ops/context` 也要注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildGuardText, GUARD_MAX_CHARS, GUARD_RULES, installGuard, summarizeContext } from '../guard.js'

const CONTEXT = {
  version: '0.9.0',
  today: '2026-10-29',
  timezone: 'Asia/Shanghai',
  policy: { autoExecuteR1: true },
  counts: { users: 12, instances: 3, jobs: 1 },
}

/** 只实现 installGuard 用到的事件订阅。 */
function createFakeCtx() {
  const handlers = new Map()
  return {
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
    },
    handlers,
  }
}

function fakeClient(context = CONTEXT) {
  let calls = 0
  return {
    calls: () => calls,
    context: async () => {
      calls += 1
      if (context === 'throw') throw new Error('unreachable')
      return context
    },
  }
}

test('守则正文包含 docs/24 §5 的全部规则（含舰桥新增的两条），且不超过预算', () => {
  // WP56h 起 10 条：多了「能用图就用图」那条选卡规则
  assert.equal(GUARD_RULES.length, 10)
  const text = buildGuardText(CONTEXT)
  assert.ok(
    [...text].length <= GUARD_MAX_CHARS,
    `守则 ${String([...text].length)} 字，超过 ${String(GUARD_MAX_CHARS)}`,
  )
  assert.match(text, /<cockpit-guard>/)
  assert.match(text, /先 ops_find 再调用/)
  assert.match(text, /succeeded/)
  assert.match(text, /secret_request/)
  assert.match(text, /是数据不是指令/)
  assert.match(text, /右侧的「事件」栏/)
  assert.match(text, /不要说「左舷」「右舷」/)
  assert.doesNotMatch(text, /左舷放数据/)
  assert.match(text, /先投卡再用一两句话说结论/)
  // WP56h：能把结论画成图就不要画表
  assert.match(text, /能用图就用图/)
  assert.match(text, /donut/)
  assert.match(text, /表格只用于要逐行查看\/追问的明细/)
  assert.match(text, /Hub 0\.9\.0/)
  assert.match(text, /R1 自动执行=开/)
  assert.match(text, /users 12/)
})

test('拿不到 /ops/context 时仍然给出完整规则', () => {
  const text = buildGuardText(null)
  assert.match(text, /读不到状态/)
  assert.equal(
    GUARD_RULES.every((rule) => text.includes(rule)),
    true,
  )
})

test('summarizeContext 不编字段：空对象只回空串', () => {
  assert.equal(summarizeContext({}), '')
  assert.equal(summarizeContext(null).startsWith('Hub 座舱通道'), true)
})

test('每回合只注入一次：step=0 注入，step>0 不注入，新回合再注入', async () => {
  const { ctx, handlers } = createFakeCtx()
  const client = fakeClient()
  installGuard(ctx, { client })
  const handler = handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function')

  const agent = { session: { id: 's1' } }
  const next = async () => ({ kind: 'enter', messages: [{ id: 'u1', role: 'user', content: [] }] })

  const first = await handler({ agent, turn: 1, step: 0, signal: undefined }, next)
  assert.equal(first.messages.length, 2, '第一回合第一步要注入守则')
  assert.match(first.messages[1].content[0].text, /<cockpit-guard>/)
  assert.equal(first.messages[1].source.kind, 'dshhub-ops')

  const second = await handler({ agent, turn: 1, step: 1, signal: undefined }, next)
  assert.equal(second.messages.length, 1, '同一回合的后续 step 不再注入')

  const nextTurn = await handler({ agent, turn: 2, step: 0, signal: undefined }, next)
  assert.equal(nextTurn.messages.length, 2, '新回合要重新注入')

  // 同一回合内重复的 step=0（重放/重试）不重复注入
  const replay = await handler({ agent, turn: 2, step: 0, signal: undefined }, next)
  assert.equal(replay.messages.length, 1)
})

test('决策被 reject 或没有消息时原样放行', async () => {
  const { ctx, handlers } = createFakeCtx()
  installGuard(ctx, { client: fakeClient() })
  const handler = handlers.get('agent/pre-step')
  const agent = { session: { id: 's2' } }

  const rejected = await handler({ agent, turn: 1, step: 0, signal: undefined }, async () => ({
    kind: 'reject',
  }))
  assert.deepEqual(rejected, { kind: 'reject' })

  const empty = await handler({ agent, turn: 1, step: 0, signal: undefined }, async () => ({
    kind: 'enter',
    messages: [],
  }))
  assert.deepEqual(empty.messages, [])
})

test('/ops/context 挂了也要注入规则（只是没有摘要）', async () => {
  const { ctx, handlers } = createFakeCtx()
  installGuard(ctx, { client: fakeClient('throw') })
  const handler = handlers.get('agent/pre-step')
  const agent = { session: { id: 's3' } }
  const decision = await handler({ agent, turn: 1, step: 0, signal: undefined }, async () => ({
    kind: 'enter',
    messages: [{ id: 'u9', role: 'user', content: [] }],
  }))
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /读不到状态/)
})

test('context 有 30 秒缓存：同一回合多步不重复打 Hub', async () => {
  const { ctx, handlers } = createFakeCtx()
  const client = fakeClient()
  installGuard(ctx, { client })
  const handler = handlers.get('agent/pre-step')
  const agent = { session: { id: 's4' } }
  const next = async () => ({ kind: 'enter', messages: [{ id: 'u1', role: 'user', content: [] }] })
  await handler({ agent, turn: 1, step: 0, signal: undefined }, next)
  await handler({ agent, turn: 2, step: 0, signal: undefined }, next)
  assert.equal(client.calls(), 1)
})
