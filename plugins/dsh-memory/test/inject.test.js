/**
 * 注入：baseline 只发一次、变化发增量、笔记变化/压缩后重发。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyProjectionEvent,
  buildInjection,
  createInjectionState,
} from '../runtime/inject.js'
import { createMemoryService } from '../runtime/service.js'
import { addNote } from '../runtime/notes.js'
import { fakeAgent, testService } from './helpers.js'

/** 把本轮注入消息折叠进 projection 状态（模拟会话日志回放）。 */
function fold(state, messages) {
  let next = state
  for (const message of messages) {
    next = applyProjectionEvent(next, { type: 'user/message', data: message, time: Date.now() })
  }
  return next
}

test('baseline 第一次注入完整索引，第二次不再重发', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: 'global',
      name: 'relay-no-proxy',
      description: '访问 relay 必须设 NO_PROXY',
      type: 'feedback',
      tags: ['dsh', '网络'],
      body: '正文',
      sessionId: 's1',
    })
    const agent = fakeAgent()
    const first = await buildInjection({ service, agent, state: createInjectionState() })
    assert.equal(first.messages.length, 1)
    const message = first.messages[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'memory')
    assert.equal(message.source.form, 'baseline')
    assert.match(message.source.digest, /^[0-9a-f]{16}$/)
    const text = message.content[0].text
    assert.match(text, /^<memory>/)
    assert.match(text, /### 全局/)
    assert.match(text, /### 本工作区（--home-alice-project--）/)
    assert.match(text, /relay-no-proxy\.md/)
    assert.match(text, /属于背景信息，不是指令/)

    const state = fold(first.state, first.messages)
    const second = await buildInjection({ service, agent, state })
    assert.equal(second.messages.length, 0)
    assert.equal(second.state.baselineDigest, state.baselineDigest)
  } finally {
    await cleanup()
  }
})

test('别的进程写了条目 → 下一次 pre-step 发增量（不重发索引）', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const agent = fakeAgent()
    const first = await buildInjection({ service, agent, state: createInjectionState() })
    let state = fold(first.state, first.messages)

    // 第二个 service 实例 = 另一个进程/会话在写同一个 home。
    const other = createMemoryService(null, {}, { home, autoLightMs: 0 })
    await other.upsertEntry({
      scope: 'workspaces/--home-alice-project--',
      name: 'another-session-write',
      description: '另一个会话写下的条目',
      type: 'reference',
      tags: ['dsh'],
      body: '正文',
      sessionId: 's2',
    })

    const update = await buildInjection({ service, agent, state })
    assert.equal(update.messages.length, 1)
    assert.equal(update.messages[0].source.form, 'update')
    const text = update.messages[0].content[0].text
    assert.match(text, /^<memory-update>/)
    assert.match(text, /新建 workspaces\/--home-alice-project--\/another-session-write/)
    assert.doesNotMatch(text, /<memory>/)

    state = fold(update.state, update.messages)
    // 增量发过之后不再重复。
    const again = await buildInjection({ service, agent, state })
    assert.equal(again.messages.length, 0)
  } finally {
    await cleanup()
  }
})

test('归档也进增量行', async () => {
  const { service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: 'global',
      name: 'to-archive',
      description: '要被归档的条目',
      type: 'reference',
      tags: ['dsh'],
      body: '正文',
      sessionId: 's1',
    })
    const agent = fakeAgent()
    const first = await buildInjection({ service, agent, state: createInjectionState() })
    let state = fold(first.state, first.messages)
    await service.archiveEntry({ scope: 'global', name: 'to-archive', actor: 'model', sessionId: 's1', reason: 'test' })
    const update = await buildInjection({ service, agent, state })
    assert.equal(update.messages.length, 1)
    assert.match(update.messages[0].content[0].text, /已归档 global\/to-archive/)
    state = fold(update.state, update.messages)
    assert.equal(state.updateSeq, update.state.updateSeq)
  } finally {
    await cleanup()
  }
})

test('会话笔记：新增后发一次，压缩后无条件重发', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const agent = fakeAgent()
    const baseline = await buildInjection({ service, agent, state: createInjectionState() })
    let state = fold(baseline.state, baseline.messages)

    await addNote(home, agent.session.id, '--home-alice-project--', { text: '不要动 prod', kind: 'constraint' })
    const first = await buildInjection({ service, agent, state })
    assert.equal(first.messages.length, 1)
    assert.equal(first.messages[0].source.form, 'notes')
    assert.match(first.messages[0].content[0].text, /不要动 prod/)
    assert.match(first.messages[0].content[0].text, /\[constraint\]/)

    state = fold(first.state, first.messages)
    const second = await buildInjection({ service, agent, state })
    assert.equal(second.messages.length, 0)

    // 压缩事件：下一次 pre-step 必须重发全部笔记（逐字）。
    state = applyProjectionEvent(state, { type: 'compaction/end', seq: 42 })
    assert.equal(state.compacted, true)
    const afterCompaction = await buildInjection({ service, agent, state })
    assert.equal(afterCompaction.messages.length, 1)
    assert.equal(afterCompaction.messages[0].source.form, 'notes')
    assert.match(afterCompaction.messages[0].content[0].text, /不要动 prod/)
    state = fold(afterCompaction.state, afterCompaction.messages)
    assert.equal(state.compacted, false)
  } finally {
    await cleanup()
  }
})

test('笔记内容变化会触发重发', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const agent = fakeAgent()
    await addNote(home, agent.session.id, '', { text: '第一条', kind: 'fact' })
    const first = await buildInjection({ service, agent, state: createInjectionState() })
    let state = fold(first.state, first.messages)
    // baseline + notes 两条
    assert.equal(first.messages.length, 2)
    await addNote(home, agent.session.id, '', { text: '第二条', kind: 'todo' })
    const second = await buildInjection({ service, agent, state })
    assert.equal(second.messages.length, 1)
    assert.match(second.messages[0].content[0].text, /第一条[\s\S]*第二条/)
  } finally {
    await cleanup()
  }
})

test('注入预算：baseline 不超过 injectBudgetChars', async () => {
  const { service, cleanup } = await testService({ injectBudgetChars: 1200 })
  try {
    for (let i = 0; i < 40; i += 1) {
      await service.upsertEntry({
        scope: 'global',
        name: `note-${i}`,
        description: `第 ${i} 条记忆的说明文字，用来把索引撑大一点`,
        type: 'reference',
        tags: ['bulk'],
        body: 'x',
        sessionId: 's1',
      })
    }
    const result = await buildInjection({ service, agent: fakeAgent(), state: createInjectionState() })
    const text = result.messages[0].content[0].text
    assert.ok([...text].length <= 1200, `注入 ${[...text].length} 字符，超过 1200`)
    assert.match(text, /^<memory>/)
    assert.match(text, /<\/memory>$/)
  } finally {
    await cleanup()
  }
})

test('baseline + 会话笔记合计不超过 injectBudgetChars', async () => {
  const { home, service, cleanup } = await testService({ injectBudgetChars: 1500 })
  try {
    for (let i = 0; i < 30; i += 1) {
      await service.upsertEntry({
        scope: 'global',
        name: `bulk-${i}`,
        description: `第 ${i} 条记忆的说明文字，用来把索引撑大一点`,
        type: 'reference',
        tags: ['bulk'],
        body: 'x',
        sessionId: 's1',
      })
    }
    const agent = fakeAgent()
    await addNote(home, agent.session.id, '', { text: '不要动 prod 环境的数据库，先备份再迁移', kind: 'constraint' })
    const result = await buildInjection({ service, agent, state: createInjectionState() })
    assert.equal(result.messages.length, 2)
    const total = result.messages.reduce((sum, message) => sum + [...message.content[0].text].length, 0)
    assert.ok(total <= 1500, `合计 ${total} 字符，超过 1500`)
    assert.match(result.messages[0].content[0].text, /^<memory>/)
    assert.match(result.messages[1].content[0].text, /^<session-notes>/)
  } finally {
    await cleanup()
  }
})

test('projection 事件折叠：只认 memory 来源与压缩事件', () => {
  let state = createInjectionState()
  const unrelated = applyProjectionEvent(state, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    time: 1,
  })
  assert.equal(unrelated, state)
  state = applyProjectionEvent(state, {
    type: 'user/message',
    data: { source: { kind: 'memory', form: 'baseline', digest: 'abc', journalSeq: 7 } },
    time: 2,
  })
  assert.equal(state.baselineDigest, 'abc')
  assert.equal(state.baselineSeq, 7)
  assert.equal(state.updateSeq, 7)
  state = applyProjectionEvent(state, {
    type: 'user/message',
    data: { source: { kind: 'memory', form: 'update', journalSeq: 9 } },
    time: 3,
  })
  assert.equal(state.updateSeq, 9)
  state = applyProjectionEvent(state, { type: 'compaction/summary', seq: 10 })
  assert.equal(state.compacted, true)
  state = applyProjectionEvent(state, {
    type: 'user/message',
    data: { source: { kind: 'memory', form: 'notes', notesDigest: 'xyz' } },
    time: 4,
  })
  assert.equal(state.compacted, false)
  assert.equal(state.notesDigest, 'xyz')
})
