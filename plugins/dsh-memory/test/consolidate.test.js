/**
 * 整理：bigram 相似度、关键信息守恒、合并、收件箱、抢占/续跑、LLM 上限、
 * 标签归一、过期标记、会话笔记晋升、整次运行撤销。
 */

import assert from 'node:assert/strict'
import { readFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkMergePreserves,
  createConsolidator,
  extractJson,
  jaccard,
} from '../runtime/consolidate.js'
import { addNote, loadNotes } from '../runtime/notes.js'
import { readJournal, readRuns, readSettings, patchSettings, serializeEntry, today } from '../runtime/store.js'
import { fakeLlm, testService } from './helpers.js'

const MERGE_ANSWER = {
  duplicate: true,
  merged: {
    description: '访问 relay 必须设置 NO_PROXY，否则 Clash 返回 502',
    type: 'reference',
    tags: ['网络'],
    body: '**How:** export NO_PROXY=127.0.0.1，端口 7890，配置 /etc/clash/config.yaml',
  },
}

function mergeHandlers(answer = MERGE_ANSWER) {
  return [
    ['判断它们是否在说同一件事', JSON.stringify(answer)],
    ['只用过一次', JSON.stringify({ mapping: {} })],
    ['跨会话仍然有价值', JSON.stringify({ promotions: [] })],
  ]
}

/** 写两条同 tag、描述高度相似的 reference。 */
async function seedPair(service, { scope = 'global', tag = '网络', left = 'relay-no-proxy-a', right = 'relay-no-proxy-b' } = {}) {
  const description = '访问 relay 必须设置 NO_PROXY 环境变量，否则 Clash 返回 502'
  const body = '**How:** export NO_PROXY=127.0.0.1，端口 7890，配置 /etc/clash/config.yaml'
  for (const name of [left, right]) {
    await service.upsertEntry({
      scope,
      name,
      description: `${description}${name.endsWith('b') ? '（重复条目）' : ''}`,
      type: 'reference',
      tags: [tag],
      body,
      sessionId: 's1',
    })
  }
}

test('extractJson 容忍 markdown 围栏；jaccard 对重复描述接近 1', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('前缀 {"duplicate": true} 后缀'), { duplicate: true })
  assert.equal(extractJson('不是 json'), null)
  assert.ok(jaccard('访问 relay 必须设置 NO_PROXY', '访问 relay 必须设置 NO_PROXY，否则 502') > 0.6)
  assert.ok(jaccard('完全不同的两句话', '另一件毫不相干的事情') < 0.2)
})

test('合并校验：缺路径或数字就作废', () => {
  const sources = ['配置 /etc/clash/config.yaml，端口 7890，命令 `export NO_PROXY=127.0.0.1`']
  assert.equal(checkMergePreserves(sources, '配置 /etc/clash/config.yaml，端口 7890，命令 `export NO_PROXY=127.0.0.1`').ok, true)
  const missingPath = checkMergePreserves(sources, '端口 7890，命令 `export NO_PROXY=127.0.0.1`')
  assert.equal(missingPath.ok, false)
  assert.ok(missingPath.missing.includes('/etc/clash/config.yaml'))
  const missingNumber = checkMergePreserves(sources, '配置 /etc/clash/config.yaml，命令 `export NO_PROXY=127.0.0.1`')
  assert.equal(missingNumber.ok, false)
  assert.ok(missingNumber.missing.includes('7890'))
})

test('深整理合并重复条目，写 journal 并可通过 runId 整体撤销', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await seedPair(service)
    const llm = fakeLlm(mergeHandlers())
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.status, 'done')
    assert.equal(run.progress.merged, 1)
    assert.equal(run.progress.llmCalls, 1)

    const names = (await service.allItems()).items.map((item) => item.name).sort()
    assert.deepEqual(names, ['relay-no-proxy-a'])
    const merged = await service.itemDetail('global', 'relay-no-proxy-a')
    assert.match(merged.meta.links.join(','), /relay-no-proxy-b/)
    assert.match(merged.body, /\/etc\/clash\/config\.yaml/)

    const journal = await readJournal(home, { runId: run.id })
    assert.deepEqual(journal.map((entry) => entry.op).sort(), ['archive', 'update'])
    const stored = await readRuns(home)
    assert.equal(stored[run.id].status, 'done')

    const undo = await service.undoJournal({ runId: run.id })
    assert.equal(undo.undone.length, 2)
    assert.deepEqual((await service.allItems()).items.map((item) => item.name).sort(), ['relay-no-proxy-a', 'relay-no-proxy-b'])
  } finally {
    await cleanup()
  }
})

test('合并结果缺少关键信息 → 不合并，转成收件箱提议', async () => {
  const { service, cleanup } = await testService()
  try {
    await seedPair(service)
    const llm = fakeLlm(mergeHandlers({
      duplicate: true,
      merged: { description: '访问 relay 要设代理', type: 'reference', tags: ['网络'], body: '合并后的正文，但把细节丢了' },
    }))
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.merged, 0)
    assert.equal(run.progress.proposals, 1)
    assert.equal((await service.allItems()).items.length, 2)
    const inbox = await service.inbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].kind, 'merge')
    assert.match(inbox[0].reason, /缺少关键信息/)
    assert.match(inbox[0].reason, /\/etc\/clash\/config\.yaml/)
    assert.equal(inbox[0].archive.length, 1)
  } finally {
    await cleanup()
  }
})

test('受保护条目（feedback/pinned）的合并一律进收件箱', async () => {
  const { service, cleanup } = await testService()
  try {
    await seedPair(service)
    const item = await service.itemDetail('global', 'relay-no-proxy-a')
    await service.upsertEntry({
      scope: 'global',
      name: 'relay-no-proxy-a',
      description: item.meta.description,
      type: 'feedback',
      tags: item.meta.tags,
      body: item.body,
      sessionId: 's1',
    })
    const llm = fakeLlm(mergeHandlers())
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.merged, 0)
    assert.equal(run.progress.proposals, 1)
    const inbox = await service.inbox()
    assert.match(inbox[0].reason, /受保护条目/)
  } finally {
    await cleanup()
  }
})

test('抢占：忙时暂停，空闲后续跑同一个 run', async () => {
  const { service, cleanup } = await testService()
  try {
    await seedPair(service, { tag: '网络', left: 'relay-a1', right: 'relay-a2' })
    await seedPair(service, { tag: 'network2', left: 'proxy-b1', right: 'proxy-b2' })
    const llm = fakeLlm(mergeHandlers())
    // 第一次 LLM 调用完成后就"有会话在跑" → 第二对之前暂停。
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => llm.calls.length >= 1 })
    const paused = await consolidator.runDeep({ reason: 'test' })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.progress.merged, 1)
    assert.equal((await service.allItems()).items.length, 3)
    assert.equal((await readRuns(service.home))[paused.id].status, 'paused')

    // 空闲了：resumeIfPaused 用同一个 runId 续跑。
    const idle = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const resumed = await idle.resumeIfPaused()
    assert.ok(resumed)
    assert.equal(resumed.id, paused.id)
    assert.equal(resumed.status, 'done')
    assert.equal(resumed.progress.merged, 2)
    assert.equal((await service.allItems()).items.length, 2)
  } finally {
    await cleanup()
  }
})

test('每次运行的 LLM 调用上限：超了就暂停，下次续跑', async () => {
  const { service, cleanup } = await testService()
  try {
    await patchSettings(service.home, { maxLlmCalls: 1 })
    await seedPair(service, { tag: '网络', left: 'relay-a1', right: 'relay-a2' })
    await seedPair(service, { tag: 'network2', left: 'proxy-b1', right: 'proxy-b2' })
    const llm = fakeLlm(mergeHandlers())
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const paused = await consolidator.runDeep({ reason: 'test' })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.progress.llmCalls, 1)
    assert.match(paused.log.at(-1).message, /上限/)

    const settings = await readSettings(service.home)
    assert.equal(settings.maxLlmCalls, 1)
    await patchSettings(service.home, { maxLlmCalls: 10 })
    const resumed = await consolidator.resumeIfPaused()
    assert.equal(resumed.status, 'done')
    assert.equal(resumed.id, paused.id)
  } finally {
    await cleanup()
  }
})

test('标签归一：写 synonyms 并重打标签（journal op=retag）', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({ scope: 'global', name: 'net-a', description: '网络第一条', type: 'reference', tags: ['网络'], body: 'a', sessionId: 's1' })
    await service.upsertEntry({ scope: 'global', name: 'net-b', description: '网络第二条', type: 'reference', tags: ['网络'], body: 'b', sessionId: 's1' })
    await service.upsertEntry({ scope: 'global', name: 'proxy-note', description: '单独用 proxy 标签', type: 'reference', tags: ['proxy'], body: 'c', sessionId: 's1' })
    const llm = fakeLlm([
      ['判断它们是否在说同一件事', JSON.stringify({ duplicate: false })],
      ['只用过一次', JSON.stringify({ mapping: { proxy: '网络' } })],
      ['跨会话仍然有价值', JSON.stringify({ promotions: [] })],
    ])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.retagged, 1)
    const proxy = await service.itemDetail('global', 'proxy-note')
    assert.deepEqual(proxy.meta.tags, ['网络'])
    const tags = await service.readTags(home)
    assert.equal(tags.synonyms.proxy, '网络')
    const journal = await readJournal(home, { runId: run.id })
    assert.ok(journal.some((entry) => entry.op === 'retag'))
  } finally {
    await cleanup()
  }
})

test('过期标记：project 超过 staleDays 未核实 → stale:true', async () => {
  const { home, service, cleanup } = await testService({ staleDays: 30 })
  try {
    await service.upsertEntry({
      scope: 'global',
      name: 'old-project',
      description: '三个月没动的项目',
      type: 'project',
      tags: ['project'],
      body: '进度',
      sessionId: 's1',
    })
    const old = new Date(Date.now() - 60 * 86_400_000)
    const path = join(home, 'global', 'old-project.md')
    const text = await readFile(path, 'utf8')
    await utimes(path, old, old)
    assert.match(text, /verified_at: \d{4}-\d{2}-\d{2}/)
    // 直接把 verified_at 改成 60 天前（文件系统 mtime 不影响判断，读的是 frontmatter）。
    const { writeItemRaw } = await import('../runtime/store.js')
    await writeItemRaw(home, 'global', 'old-project', text.replace(/^verified_at: .*$/m, `verified_at: ${old.toISOString().slice(0, 10)}`))

    const llm = fakeLlm([['跨会话仍然有价值', JSON.stringify({ promotions: [] })]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.stale, 1)
    const item = await service.itemDetail('global', 'old-project')
    assert.equal(item.meta.stale, true)
    const index = await service.readIndex('global')
    assert.match(index, /⚠️/)
  } finally {
    await cleanup()
  }
})

test('会话笔记晋升：生成收件箱提议并标记 promoted', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await addNote(home, 'session-old', '--home-alice-project--', { text: '不要动 prod', kind: 'constraint' })
    const old = new Date(Date.now() - 8 * 3_600_000)
    await utimes(join(home, 'sessions', 'session-old.json'), old, old)
    const llm = fakeLlm([
      ['跨会话仍然有价值', JSON.stringify({
        promotions: [{
          id: 'n1',
          name: 'do-not-touch-prod',
          description: '不要动 prod 环境',
          type: 'feedback',
          tags: ['prod'],
          body: '不要对 prod 做写操作。',
        }],
      })],
    ])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.promoted, 1)
    const inbox = await service.inbox()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].name, 'do-not-touch-prod')
    assert.equal(inbox[0].scope, 'workspaces/--home-alice-project--')
    assert.equal(inbox[0].proposedBy, 'consolidate')
    const notes = await loadNotes(home, 'session-old')
    assert.deepEqual(notes.promoted, ['n1'])
  } finally {
    await cleanup()
  }
})

test('LLM 不可用时：跳过模型阶段，其余整理照常完成', async () => {
  const { service, cleanup } = await testService()
  try {
    await seedPair(service)
    const llm = {
      available: false,
      async complete() {
        const error = new Error('没有可用的 LLM 服务')
        error.code = 'NO_LLM'
        throw error
      },
    }
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.status, 'done')
    assert.match(run.llmUnavailable, /没有可用的 LLM/)
    assert.ok(run.log.some((entry) => entry.phase === 'light'))
    assert.ok(await service.readIndex('global'))
  } finally {
    await cleanup()
  }
})

/* ────────────────────── AI 审阅收件箱（子代理提议） ────────────────────── */

const CHILD_SCOPE = 'workspaces/--home-alice-project--'

/** 子代理提议里 after 的原始条目文本。 */
function childRaw({ name, description = '子代理的结论', type = 'reference', tags = ['dsh'], body = '子代理写下的结论。', pinned = false }) {
  return serializeEntry({
    name,
    description,
    type,
    tags,
    links: [],
    pinned,
    created: today(),
    updated: today(),
    verified_at: today(),
    source: 'session-child',
  }, body)
}

/** 造一条子代理提议（默认 workspace 作用域）。 */
async function seedChildProposal(service, options = {}) {
  const name = options.name ?? 'child-memory'
  return service.propose({
    kind: options.kind ?? 'create',
    scope: options.scope ?? CHILD_SCOPE,
    name,
    before: options.before ?? null,
    after: options.after ?? childRaw({ name, ...options }),
    reason: options.reason ?? '子代理会话的写入提议',
    proposedBy: 'model',
    ...(options.legacy ? {} : { origin: 'subagent' }),
    originScope: options.originScope ?? CHILD_SCOPE,
    sessionId: 'session-child',
  })
}

/** 审阅提示的匹配特征。 */
const REVIEW_NEEDLE = '长期记忆库的审阅器'

test('AI 审阅：子代理提议被批准后写入，带 runId 可撤销，并留下决定审计', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const first = await seedChildProposal(service, { name: 'child-approved', body: '子代理结论：生产服务端口是 8124。' })
    // 没有 origin 的旧提议（reason 前缀识别）也要能审阅。
    const legacy = await seedChildProposal(service, { name: 'child-legacy', body: '子代理结论：本机没有 sudo。', legacy: true })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({
        decisions: [
          { id: first.id, decision: 'approve', confidence: 0.92, reason: '跨会话有用的环境事实' },
          { id: legacy.id, decision: 'approve', confidence: 0.88, reason: '环境约束值得记住' },
        ],
      }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.status, 'done')
    assert.deepEqual(run.progress.inbox, { reviewed: 2, approved: 2, rejected: 0, deferred: 0 })
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'child-approved').then((item) => item?.meta.description), '子代理的结论')
    assert.ok(await service.itemDetail(CHILD_SCOPE, 'child-legacy'))
    assert.equal((await service.inbox()).length, 0)

    const journal = await readJournal(home, { runId: run.id })
    assert.deepEqual(journal.map((entry) => entry.op).sort(), ['create', 'create'])
    assert.ok(journal.every((entry) => entry.actor === 'consolidate'))

    for (const proposal of [first, legacy]) {
      const decided = JSON.parse(await readFile(join(home, 'inbox', 'decided', `${proposal.id}.json`), 'utf8'))
      assert.equal(decided.decision, 'approve')
      assert.equal(decided.by, 'ai')
      assert.equal(decided.runId, run.id)
      assert.match(decided.reason, /置信度 0\.\d\d/)
    }

    // AI 的写入挂在这次运行下：撤销整次运行会把它们撤掉。
    const undo = await service.undoJournal({ runId: run.id })
    assert.equal(undo.undone.length, 2)
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'child-approved'), null)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：拒绝低价值提议，条目不会落盘但决定留档', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const proposal = await seedChildProposal(service, { name: 'child-noise', body: '这次任务的临时进度：第三步跑完了。' })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({ decisions: [{ id: proposal.id, decision: 'reject', confidence: 0.9, reason: '一次性进度，没有跨会话价值' }] }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.deepEqual(run.progress.inbox, { reviewed: 1, approved: 0, rejected: 1, deferred: 0 })
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'child-noise'), null)
    assert.equal((await service.inbox()).length, 0)
    const decided = JSON.parse(await readFile(join(home, 'inbox', 'decided', `${proposal.id}.json`), 'utf8'))
    assert.equal(decided.decision, 'reject')
    assert.match(decided.reason, /一次性进度/)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：全局作用域/归档/受保护条目/低置信度都留给用户，深整理自己的提议不碰', async () => {
  const { service, cleanup } = await testService()
  try {
    const globalProposal = await seedChildProposal(service, { name: 'global-proposal', scope: 'global', body: '全局环境事实。' })
    await service.upsertEntry({ scope: CHILD_SCOPE, name: 'archivable', description: '可以归档', type: 'reference', tags: ['dsh'], body: '旧内容', sessionId: 's1' })
    const archivable = await service.itemDetail(CHILD_SCOPE, 'archivable')
    const archiveProposal = await service.propose({
      kind: 'archive',
      scope: CHILD_SCOPE,
      name: 'archivable',
      before: archivable.raw,
      after: null,
      reason: '子代理提议归档：没用了',
      proposedBy: 'model',
      origin: 'subagent',
    })
    await service.upsertEntry({ scope: CHILD_SCOPE, name: 'pinned-target', description: '受保护的条目', type: 'feedback', tags: ['dsh'], body: '不要改我', pinned: true, sessionId: 's1' })
    const pinned = await service.itemDetail(CHILD_SCOPE, 'pinned-target')
    const pinnedProposal = await service.propose({
      kind: 'update',
      scope: CHILD_SCOPE,
      name: 'pinned-target',
      before: pinned.raw,
      after: serializeEntry({ ...pinned.meta, updated: today() }, '改过的正文'),
      reason: '子代理会话的写入提议',
      proposedBy: 'model',
      origin: 'subagent',
    })
    const lowConfidence = await seedChildProposal(service, { name: 'low-confidence', body: '拿不准要不要记。' })
    // 子代理自己要求 pinned（常驻热层）也要留给用户。
    const newPinned = await seedChildProposal(service, { name: 'new-pinned', pinned: true, body: '子代理想让这条常驻热层。' })
    // 深整理自己产生的提议（受保护条目的修改提议）不该进 AI 审阅。
    await service.propose({
      kind: 'update',
      scope: CHILD_SCOPE,
      name: 'model-proposal',
      before: null,
      after: childRaw({ name: 'model-proposal' }),
      reason: '受保护条目（feedback/pinned）的修改提议',
      proposedBy: 'model',
    })

    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({
        decisions: [
          { id: globalProposal.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
          { id: archiveProposal.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
          { id: pinnedProposal.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
          { id: lowConfidence.id, decision: 'approve', confidence: 0.4, reason: '有点犹豫' },
          { id: newPinned.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
        ],
      }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    // 只有低置信度那条真的发给了 LLM。
    assert.deepEqual(run.progress.inbox, { reviewed: 1, approved: 0, rejected: 0, deferred: 5 })
    assert.equal((await service.inbox()).length, 6)
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'low-confidence'), null)
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'new-pinned'), null)
    assert.equal(await service.itemDetail('global', 'global-proposal'), null)
    assert.ok(await service.itemDetail(CHILD_SCOPE, 'archivable'))
    assert.match((await service.itemDetail(CHILD_SCOPE, 'pinned-target')).body, /不要改我/)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：inboxReview=user 时不动收件箱；LLM 不可用时提议也保留', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await seedChildProposal(service, { name: 'wait-for-user' })
    await patchSettings(home, { inboxReview: 'user' })
    const llm = fakeLlm([])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.status, 'done')
    assert.equal((await service.inbox()).length, 1)
    assert.equal(llm.calls.some((call) => call.prompt.includes(REVIEW_NEEDLE)), false)
    assert.ok(run.log.some((entry) => entry.phase === 'inbox' && /审阅已关闭/.test(entry.message)))

    // 打开 AI 审阅但 LLM 不可用：提议保持原样，等下一次运行。
    await patchSettings(home, { inboxReview: 'ai' })
    const broken = {
      available: false,
      async complete() {
        const error = new Error('没有可用的 LLM 服务')
        error.code = 'NO_LLM'
        throw error
      },
    }
    const failing = createConsolidator({ service, ctx: null, llm: broken, isBusy: () => false })
    const failedRun = await failing.runDeep({ reason: 'test' })
    assert.equal(failedRun.status, 'done')
    assert.match(failedRun.llmUnavailable, /没有可用的 LLM/)
    assert.equal((await service.inbox()).length, 1)
    assert.equal(failedRun.progress.inbox.reviewed, 0)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：批与批之间被抢占会暂停，空闲后同一个 run 续跑剩余提议', async () => {
  const { service, cleanup } = await testService()
  try {
    for (let i = 0; i < 8; i += 1) {
      // 每条用不同标签，避免审阅之后进入合并阶段产生无关的 LLM 调用。
      await seedChildProposal(service, { name: `batch-child-${i}`, body: `第 ${i} 条子代理结论。`, tags: [`t${i}`] })
    }
    // 第一批评完后就"有会话在跑"，第二帧应该暂停。
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      ({ prompt }) => {
        const ids = [...prompt.matchAll(/--- 提议 \d+：(p-[\w-]+) ---/g)].map((match) => match[1])
        return JSON.stringify({
          decisions: ids.map((id) => ({ id, decision: 'approve', confidence: 0.9, reason: '有长期价值' })),
        })
      },
    ]])
    const busyConsolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => llm.calls.length >= 1 })
    const paused = await busyConsolidator.runDeep({ reason: 'test' })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.progress.inbox.approved, 6)
    assert.equal((await service.inbox()).length, 2)

    const idleConsolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const resumed = await idleConsolidator.resumeIfPaused()
    assert.equal(resumed.id, paused.id)
    assert.equal(resumed.status, 'done')
    assert.equal(resumed.progress.inbox.approved, 8)
    assert.equal((await service.inbox()).length, 0)
    // 两批一共两次审阅调用。
    assert.equal(llm.calls.filter((call) => call.prompt.includes(REVIEW_NEEDLE)).length, 2)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：正文超出审阅窗口的提议不自动批准（防正文盲区）', async () => {
  const { service, cleanup } = await testService()
  try {
    // 用 ASCII 复现真实工具路径能写进去的 3001–8192 字节盲区（中文 3500 字会超过 8KB 上限，写不进来）。
    const proposal = await seedChildProposal(service, { name: 'long-body', body: 'This is a long explanatory line about the task. '.repeat(70) })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({ decisions: [{ id: proposal.id, decision: 'approve', confidence: 0.99, reason: '看着可以' }] }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.inbox.reviewed, 0)
    assert.equal(run.progress.inbox.deferred, 1)
    assert.equal((await service.inbox()).length, 1)
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'long-body'), null)
    assert.equal(llm.calls.filter((call) => call.prompt.includes(REVIEW_NEEDLE)).length, 0)
    assert.ok(run.log.some((entry) => entry.phase === 'inbox' && /超出审阅窗口/.test(entry.message)))
  } finally {
    await cleanup()
  }
})

test('AI 审阅：取消后不再继续审阅和落盘', async () => {
  const { home, service, cleanup } = await testService()
  try {
    for (let i = 0; i < 14; i += 1) {
      await seedChildProposal(service, { name: `cancel-child-${i}`, body: `结论 ${i}。`, tags: [`c${i}`] })
    }
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    let firstCall = true
    let consolidator = null
    let runId = ''
    const llm = {
      available: true,
      async complete({ prompt }) {
        if (!prompt.includes(REVIEW_NEEDLE)) return '{}'
        if (firstCall) {
          firstCall = false
          await gate
          consolidator.cancel(runId)
        }
        const ids = [...prompt.matchAll(/--- 提议 \d+：(p-[\w-]+) ---/g)].map((match) => match[1])
        return JSON.stringify({ decisions: ids.map((id) => ({ id, decision: 'approve', confidence: 0.9, reason: '看着可以' })) })
      },
    }
    consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const runPromise = consolidator.runDeep({ reason: 'test' })
    for (let i = 0; i < 200 && !runId; i += 1) {
      const stored = await readRuns(service.home)
      const running = Object.values(stored).find((run) => run.mode === 'deep' && run.status === 'running')
      if (running) runId = running.id
      else await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(runId, '应该先出现一个 running 的 run')
    releaseGate()
    const run = await runPromise
    assert.equal(run.status, 'canceled')
    assert.equal(run.progress.inbox.approved, 0)
    assert.equal((await service.inbox()).length, 14)
  } finally {
    await cleanup()
  }
})

test('预算耗尽后：不提高 maxLlmCalls 也能续跑完（每次尝试重新计预算）', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await patchSettings(home, { maxLlmCalls: 1 })
    for (let i = 0; i < 8; i += 1) {
      await seedChildProposal(service, { name: `budget-child-${i}`, body: `结论 ${i}。`, tags: [`b${i}`] })
    }
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      ({ prompt }) => {
        const ids = [...prompt.matchAll(/--- 提议 \d+：(p-[\w-]+) ---/g)].map((match) => match[1])
        return JSON.stringify({ decisions: ids.map((id) => ({ id, decision: 'approve', confidence: 0.9, reason: '有长期价值' })) })
      },
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const paused = await consolidator.runDeep({ reason: 'test' })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.progress.inbox.approved, 6)
    // 每次尝试只花 maxLlmCalls=1；不用调大上限，多续跑几次就能做完（关键是不能死循环）。
    let run = paused
    for (let i = 0; i < 6 && run && run.status === 'paused'; i += 1) {
      run = await consolidator.resumeIfPaused()
    }
    assert.equal(run.id, paused.id)
    assert.equal(run.status, 'done')
    assert.equal(run.progress.inbox.approved, 8)
    assert.equal((await service.inbox()).length, 0)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：提议创建后目标被用户手改 → 不覆盖，留给用户', async () => {
  const { service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: CHILD_SCOPE,
      name: 'edited-after',
      description: 'v1 说明',
      type: 'reference',
      tags: ['dsh'],
      body: '原正文 v1',
      sessionId: 's1',
    })
    const item = await service.itemDetail(CHILD_SCOPE, 'edited-after')
    const proposal = await service.propose({
      kind: 'update',
      scope: CHILD_SCOPE,
      name: 'edited-after',
      before: item.raw,
      after: serializeEntry({ ...item.meta, description: 'v2 说明', updated: today() }, '提议正文 v2'),
      reason: '子代理会话的写入提议',
      proposedBy: 'model',
      origin: 'subagent',
      originScope: CHILD_SCOPE,
    })
    // 用户后来手改成 v3
    await service.saveUserItem({
      scope: CHILD_SCOPE,
      name: 'edited-after',
      text: serializeEntry({ ...item.meta, description: 'v3 用户手改', updated: today() }, '用户手改的正文 v3'),
    })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({ decisions: [{ id: proposal.id, decision: 'approve', confidence: 0.95, reason: '值得写入' }] }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.inbox.approved, 0)
    assert.equal(run.progress.inbox.deferred, 1)
    const current = await service.itemDetail(CHILD_SCOPE, 'edited-after')
    assert.match(current.body, /用户手改的正文 v3/)
    assert.equal((await service.inbox()).length, 1)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：永久 defer 的提议不占 inboxReviewMax 名额（不饿死后面的提议）', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await patchSettings(home, { inboxReviewMax: 2 })
    await seedChildProposal(service, { name: 'global-a', scope: 'global', body: '全局 a' })
    await seedChildProposal(service, { name: 'global-b', scope: 'global', body: '全局 b' })
    const good = await seedChildProposal(service, { name: 'good-one', body: '值得记的结论。', tags: ['x'] })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({ decisions: [{ id: good.id, decision: 'approve', confidence: 0.9, reason: '有长期价值' }] }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.inbox.reviewed, 1)
    assert.equal(run.progress.inbox.approved, 1)
    assert.equal(run.progress.inbox.deferred, 2)
    assert.ok(await service.itemDetail(CHILD_SCOPE, 'good-one'))
    assert.equal((await service.inbox()).length, 2)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：跨工作区和新 feedback 类型的提议都留给用户', async () => {
  const { service, cleanup } = await testService()
  try {
    const otherScope = 'workspaces/--home-alice-other--'
    const cross = await service.propose({
      kind: 'create',
      scope: otherScope,
      name: 'cross-write',
      before: null,
      after: childRaw({ name: 'cross-write' }),
      reason: '子代理会话的写入提议',
      proposedBy: 'model',
      origin: 'subagent',
      originScope: CHILD_SCOPE,
    })
    const feedback = await seedChildProposal(service, { name: 'new-feedback', type: 'feedback', body: '子代理声称的用户偏好。' })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({
        decisions: [
          { id: cross.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
          { id: feedback.id, decision: 'approve', confidence: 0.95, reason: '看着可以' },
        ],
      }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.inbox.approved, 0)
    assert.equal(run.progress.inbox.deferred, 2)
    assert.equal(await service.itemDetail(otherScope, 'cross-write'), null)
    assert.equal(await service.itemDetail(CHILD_SCOPE, 'new-feedback'), null)
    assert.equal((await service.inbox()).length, 2)
  } finally {
    await cleanup()
  }
})

test('收件箱：同一条提议的并发决定只有一个生效', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: CHILD_SCOPE,
      name: 'race-target',
      description: 'race',
      type: 'reference',
      tags: ['dsh'],
      body: 'v1',
      sessionId: 's1',
    })
    const item = await service.itemDetail(CHILD_SCOPE, 'race-target')
    const proposal = await service.propose({
      kind: 'update',
      scope: CHILD_SCOPE,
      name: 'race-target',
      before: item.raw,
      after: serializeEntry({ ...item.meta, updated: today() }, 'v2'),
      reason: '测试并发',
      proposedBy: 'model',
    })
    const results = await Promise.allSettled([
      service.decideInbox(proposal.id, 'approve'),
      service.decideInbox(proposal.id, 'reject'),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.match(String(rejected.reason?.message ?? rejected.reason), /正在被处理/)
    const lines = (await readFile(join(home, 'inbox', 'decisions.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal((await service.inbox()).length, 0)
  } finally {
    await cleanup()
  }
})

test('AI 审阅：把现有条目改成 feedback（受保护类型）也留给用户', async () => {
  const { service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: CHILD_SCOPE,
      name: 'promote-to-feedback',
      description: '普通条目',
      type: 'project',
      tags: ['dsh'],
      body: '原本只是项目笔记',
      sessionId: 's1',
    })
    const item = await service.itemDetail(CHILD_SCOPE, 'promote-to-feedback')
    const proposal = await service.propose({
      kind: 'update',
      scope: CHILD_SCOPE,
      name: 'promote-to-feedback',
      before: item.raw,
      after: serializeEntry({ ...item.meta, type: 'feedback', updated: today() }, '子代理声称这是用户确认过的做法'),
      reason: '子代理会话的写入提议',
      proposedBy: 'model',
      origin: 'subagent',
      originScope: CHILD_SCOPE,
    })
    const llm = fakeLlm([[
      REVIEW_NEEDLE,
      JSON.stringify({ decisions: [{ id: proposal.id, decision: 'approve', confidence: 0.95, reason: '看着可以' }] }),
    ]])
    const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
    const run = await consolidator.runDeep({ reason: 'test' })
    assert.equal(run.progress.inbox.approved, 0)
    assert.equal(run.progress.inbox.deferred, 1)
    const current = await service.itemDetail(CHILD_SCOPE, 'promote-to-feedback')
    assert.equal(current.meta.type, 'project')
    assert.equal((await service.inbox()).length, 1)
  } finally {
    await cleanup()
  }
})
