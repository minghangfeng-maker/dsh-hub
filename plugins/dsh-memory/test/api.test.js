/**
 * HTTP API：§9 全部端点、错误形状、同源写入保护。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createApi } from '../runtime/api.js'
import { createConsolidator } from '../runtime/consolidate.js'
import { addNote } from '../runtime/notes.js'
import { fakeLlm, testService } from './helpers.js'

const FRONTMATTER = (name, description, extra = '') => `---
name: ${name}
description: ${description}
type: reference
tags: [dsh]
links: []
pinned: false
created: 2026-10-01
updated: 2026-10-01
verified_at: 2026-10-01
source: user
${extra}---

正文 \`/tmp/${name}\` 42
`

async function setup() {
  const { home, service, cleanup } = await testService()
  const llm = fakeLlm([
    ['判断它们是否在说同一件事', JSON.stringify({ duplicate: false })],
    ['只用过一次', JSON.stringify({ mapping: {} })],
    ['跨会话仍然有价值', JSON.stringify({ promotions: [] })],
  ])
  const consolidator = createConsolidator({ service, ctx: null, llm, isBusy: () => false })
  const api = createApi({ service, consolidator })
  const server = http.createServer((req, res) => void api.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/memory/api`
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return {
    home,
    service,
    consolidator,
    api,
    base,
    call,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await cleanup()
    },
  }
}

test('GET /overview /items /item 的形状', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'relay-no-proxy', text: FRONTMATTER('relay-no-proxy', '访问 relay 必须设 NO_PROXY') })
    const overview = await ctx.call('GET', '/overview')
    assert.equal(overview.status, 200)
    assert.equal(overview.body.ok, true)
    assert.equal(overview.body.totals.items, 1)
    assert.ok(Array.isArray(overview.body.warnings))
    assert.ok(overview.body.schedule.nextRun)

    const items = await ctx.call('GET', '/items?scope=global&tier=hot')
    assert.equal(items.body.total, 1)
    assert.equal(items.body.items[0].name, 'relay-no-proxy')
    assert.equal(items.body.items[0].tier, 'hot')
    assert.equal(items.body.items[0].body, undefined)

    const detail = await ctx.call('GET', '/item?scope=global&name=relay-no-proxy')
    assert.equal(detail.status, 200)
    assert.match(detail.body.item.raw, /name: relay-no-proxy/)
    assert.equal(detail.body.item.stats.hits, 0)
    assert.ok(Array.isArray(detail.body.item.links))
  } finally {
    await ctx.close()
  }
})

test('POST /item 用户保存、校验与 404/400 错误形状', async () => {
  const ctx = await setup()
  try {
    const bad = await ctx.call('POST', '/item', { scope: 'global', name: '../x', text: 'x' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'invalid-name')

    const missing = await ctx.call('GET', '/item?scope=global&name=nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'not-found')

    const badScope = await ctx.call('GET', '/items?scope=../../etc')
    assert.equal(badScope.status, 400)
    assert.equal(badScope.body.error.code, 'invalid-scope')

    const created = await ctx.call('POST', '/item', { scope: 'global', name: 'user-note', text: FRONTMATTER('user-note', '用户手写的条目') })
    assert.equal(created.body.created, true)
    assert.equal(created.body.item.meta.description, '用户手写的条目')

    const secret = await ctx.call('POST', '/item', {
      scope: 'global',
      name: 'leaky',
      text: FRONTMATTER('leaky', '泄露').replace('正文', 'sk-abcdefghijklmnopqrstuvwx 正文'),
    })
    assert.equal(secret.status, 422)
    assert.equal(secret.body.error.code, 'secret-detected')

    const badType = await ctx.call('POST', '/item', {
      scope: 'global',
      name: 'bad-type',
      text: FRONTMATTER('bad-type', '坏类型').replace('type: reference', 'type: bogus'),
    })
    assert.equal(badType.status, 400)
    assert.equal(badType.body.error.code, 'invalid-type')

    // 纯正文保存只在条目已存在时允许
    const bodyOnly = await ctx.call('POST', '/item', { scope: 'global', name: 'user-note', text: '只改正文，保留字段' })
    assert.equal(bodyOnly.status, 200)
    assert.equal(bodyOnly.body.item.meta.description, '用户手写的条目')
    assert.match(bodyOnly.body.item.body, /只改正文/)
  } finally {
    await ctx.close()
  }
})

test('archive / restore / 归档列表', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'to-archive', text: FRONTMATTER('to-archive', '待归档') })
    const archived = await ctx.call('POST', '/archive', { scope: 'global', name: 'to-archive' })
    assert.equal(archived.status, 200)
    assert.equal(archived.body.archived, true)
    const list = await ctx.call('GET', '/items?tier=archived')
    assert.equal(list.body.total, 1)
    assert.equal(list.body.items[0].archived, true)
    assert.equal(list.body.items[0].tier, 'archived')
    const restored = await ctx.call('POST', '/restore', { scope: 'global', name: 'to-archive' })
    assert.equal(restored.body.restored, true)
    assert.equal((await ctx.call('GET', '/item?scope=global&name=to-archive')).status, 200)
    const missing = await ctx.call('POST', '/archive', { scope: 'global', name: 'nope' })
    assert.equal(missing.status, 404)
  } finally {
    await ctx.close()
  }
})

test('journal 过滤 + undo（单条 / 整次运行）', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'a', text: FRONTMATTER('a', '第一条') })
    await ctx.call('POST', '/item', { scope: 'global', name: 'b', text: FRONTMATTER('b', '第二条') })
    const journal = await ctx.call('GET', '/journal?limit=1')
    assert.equal(journal.body.entries.length, 1)
    const id = journal.body.entries[0].id

    const undone = await ctx.call('POST', '/undo', { journalId: id })
    assert.deepEqual(undone.body.undone, [id])
    assert.equal((await ctx.call('GET', '/item?scope=global&name=b')).status, 404)

    const noTarget = await ctx.call('POST', '/undo', {})
    assert.equal(noTarget.status, 400)

    const missing = await ctx.call('POST', '/undo', { journalId: 'j-nope' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'journal-not-found')
  } finally {
    await ctx.close()
  }
})

test('inbox 列表 / 批准 / 拒绝', async () => {
  const ctx = await setup()
  try {
    const proposal = await ctx.service.propose({
      kind: 'create',
      scope: 'global',
      name: 'from-inbox',
      before: null,
      after: FRONTMATTER('from-inbox', '收件箱提议'),
    })
    const list = await ctx.call('GET', '/inbox')
    assert.equal(list.body.total, 1)
    const approved = await ctx.call('POST', `/inbox/${proposal.id}`, { decision: 'approve' })
    assert.equal(approved.body.applied, true)
    assert.equal((await ctx.call('GET', '/item?scope=global&name=from-inbox')).status, 200)
    assert.equal((await ctx.call('GET', '/inbox')).body.total, 0)

    const second = await ctx.service.propose({ kind: 'create', scope: 'global', name: 'rejected', after: FRONTMATTER('rejected', '会被拒绝') })
    const rejected = await ctx.call('POST', `/inbox/${second.id}`, { decision: 'reject' })
    assert.equal(rejected.body.applied, false)
    assert.equal((await ctx.call('GET', '/item?scope=global&name=rejected')).status, 404)

    const bad = await ctx.call('POST', `/inbox/${second.id}`, { decision: 'maybe' })
    assert.equal(bad.status, 400)
    const unknown = await ctx.call('POST', '/inbox/p-nope', { decision: 'approve' })
    assert.equal(unknown.status, 404)
  } finally {
    await ctx.close()
  }
})

test('settings 读写：只接受白名单字段，lastRun 不会被客户端改', async () => {
  const ctx = await setup()
  try {
    const initial = await ctx.call('GET', '/settings')
    assert.equal(initial.body.settings.deepTime, '03:30')
    assert.equal(initial.body.settings.inboxReview, 'ai')

    const updated = await ctx.call('POST', '/settings', {
      settings: { deepTime: '05:15', idleMinutes: 10, inboxReview: 'user', inboxReviewMax: 5, lastRun: { hacked: true }, bogus: 1 },
    })
    assert.equal(updated.body.settings.deepTime, '05:15')
    assert.equal(updated.body.settings.idleMinutes, 10)
    assert.equal(updated.body.settings.inboxReview, 'user')
    assert.equal(updated.body.settings.inboxReviewMax, 5)
    assert.equal(updated.body.settings.lastRun, null)
    assert.equal('bogus' in updated.body.settings, false)
    assert.ok(updated.body.nextRun)
  } finally {
    await ctx.close()
  }
})

test('run：轻整理同步返回结果，深整理返回 runId 并可查询', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'r1', text: FRONTMATTER('r1', '运行测试条目') })
    const light = await ctx.call('POST', '/run', { mode: 'light' })
    assert.equal(light.status, 200)
    assert.equal(light.body.ok, true)
    assert.match(light.body.runId, /^run-/)
    const lightRun = await ctx.call('GET', `/run/${light.body.runId}`)
    assert.equal(lightRun.body.run.status, 'done')
    assert.equal(lightRun.body.run.mode, 'light')

    const deep = await ctx.call('POST', '/run', { mode: 'deep' })
    assert.equal(deep.body.mode, 'deep')
    assert.ok(deep.body.runId)
    // 等它跑完（假 LLM 很快）
    let run
    for (let i = 0; i < 40; i += 1) {
      const polled = await ctx.call('GET', `/run/${deep.body.runId}`)
      run = polled.body.run
      if (['done', 'error', 'paused', 'canceled'].includes(run.status)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(run.status, 'done')

    const runs = await ctx.call('GET', '/runs')
    assert.ok(runs.body.runs.length >= 2)

    const badMode = await ctx.call('POST', '/run', { mode: 'turbo' })
    assert.equal(badMode.status, 400)
    assert.equal((await ctx.call('GET', '/run/nope')).status, 404)
  } finally {
    await ctx.close()
  }
})

test('graph 与 sessions', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'graph-a', text: FRONTMATTER('graph-a', '图谱条目').replace('tags: [dsh]', 'tags: [dsh, 网络]') })
    await addNote(ctx.home, 'session-note-1', '--home-alice-project--', { text: '不要动 prod', kind: 'constraint' })

    const graph = await ctx.call('GET', '/graph')
    assert.equal(graph.body.ok, true)
    assert.ok(graph.body.nodes.some((node) => node.id === 'global/graph-a' && node.kind === 'item'))
    assert.ok(graph.body.nodes.some((node) => node.id === 'tag:网络' && node.kind === 'tag'))
    assert.ok(graph.body.edges.some((edge) => edge.kind === 'tag'))
    assert.equal(typeof graph.body.hiddenCold, 'number')

    const scoped = await ctx.call('GET', '/graph?scope=workspaces/--home-alice-project--')
    assert.equal(scoped.body.nodes.filter((node) => node.kind === 'item').length, 0)

    const sessions = await ctx.call('GET', '/sessions')
    assert.equal(sessions.body.total, 1)
    assert.equal(sessions.body.sessions[0].sessionId, 'session-note-1')
    assert.equal(sessions.body.sessions[0].notes[0].kind, 'constraint')
  } finally {
    await ctx.close()
  }
})

test('请求体超过 256 KB 返回 413（不是掐连接）', async () => {
  const ctx = await setup()
  try {
    const oversized = await ctx.call('POST', '/item', {
      scope: 'global',
      name: 'too-large',
      text: 'x'.repeat(300 * 1024),
    })
    assert.equal(oversized.status, 413)
    assert.equal(oversized.body.error.code, 'payload-too-large')
  } finally {
    await ctx.close()
  }
})

test('写请求的同源保护、405 与未知端点', async () => {
  const ctx = await setup()
  try {
    await ctx.call('POST', '/item', { scope: 'global', name: 'guard', text: FRONTMATTER('guard', '同源测试') })
    const forbidden = await ctx.call('POST', '/archive', { scope: 'global', name: 'guard' }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.body.error.code, 'forbidden')
    assert.equal((await ctx.call('GET', '/item?scope=global&name=guard')).status, 200)

    const wrongOrigin = await ctx.call('POST', '/archive', { scope: 'global', name: 'guard' }, { origin: 'https://evil.example' })
    assert.equal(wrongOrigin.status, 403)

    const allowed = await ctx.call('POST', '/archive', { scope: 'global', name: 'guard' }, { 'sec-fetch-site': 'same-origin' })
    assert.equal(allowed.status, 200)

    const wrongMethod = await ctx.call('PUT', '/item', {})
    assert.equal(wrongMethod.status, 405)
    const unknown = await ctx.call('GET', '/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'not-found')
  } finally {
    await ctx.close()
  }
})
