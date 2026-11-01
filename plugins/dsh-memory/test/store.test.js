/**
 * 存储层：frontmatter 往返、密钥拒绝、原子写/权限、journal、归档恢复。
 */

import assert from 'node:assert/strict'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SETTINGS,
  appendJournal,
  archiveItemFile,
  assertNoSecrets,
  findSecret,
  normalizeMeta,
  normalizeSettings,
  parseEntry,
  readJournal,
  readItem,
  restoreItemFile,
  serializeEntry,
} from '../runtime/store.js'
import { itemPath } from '../runtime/paths.js'
import { testService } from './helpers.js'

test('frontmatter 解析 ↔ 序列化往返（中文、数组、冒号、引号）', () => {
  const meta = normalizeMeta({
    name: 'relay-no-proxy',
    description: '访问 relay 必须设 NO_PROXY：否则 Clash 返回 502',
    type: 'feedback',
    tags: ['dsh', '网络', 'a,b'],
    links: ['global:other', 'plain'],
    pinned: true,
    created: '2026-10-01',
    updated: '2026-10-20',
    verified_at: '2026-10-19',
    source: 'session-1',
    stale: true,
  })
  const body = '**Why:** 说明\n\n**How to apply:** 用 `export NO_PROXY=127.0.0.1`'
  const raw = serializeEntry(meta, body)
  const parsed = parseEntry(raw)
  assert.equal(parsed.hasFrontmatter, true)
  assert.deepEqual(parsed.meta, {
    name: meta.name,
    description: meta.description,
    type: meta.type,
    tags: meta.tags,
    links: meta.links,
    pinned: true,
    created: meta.created,
    updated: meta.updated,
    verified_at: meta.verified_at,
    source: meta.source,
    stale: true,
  })
  assert.equal(parsed.body.trim(), body)
  // 再序列化一次完全一致（往返稳定）
  assert.equal(serializeEntry(normalizeMeta(parsed.meta, { name: meta.name }), parsed.body), raw)
})

test('没有 frontmatter 的纯正文：按 body 解析，不报错', () => {
  const parsed = parseEntry('# 标题\n\n正文')
  assert.equal(parsed.hasFrontmatter, false)
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, '# 标题\n\n正文')
})

test('stale 只在 true 时写进 frontmatter；pinned 总是写', () => {
  const raw = serializeEntry({ name: 'x', pinned: false, stale: false, created: '2026-01-01' }, 'b')
  assert.match(raw, /^pinned: false$/m)
  assert.doesNotMatch(raw, /^stale:/m)
  const stale = serializeEntry({ name: 'x', pinned: false, stale: true }, 'b')
  assert.match(stale, /^stale: true$/m)
})

test('密钥模式被拒绝；普通 UUID/长英文标识不误伤', () => {
  assert.equal(findSecret('sk-abcdefghijklmnopqrstuvwx'), 'sk- 密钥')
  assert.equal(findSecret('ghp_abcdefghijklmnopqrstuvwxyz'), 'GitHub token')
  assert.equal(findSecret('AKIAIOSFODNN7EXAMPLE'), 'AWS access key')
  assert.equal(findSecret('-----BEGIN RSA PRIVATE KEY-----'), '私钥')
  assert.equal(findSecret('token deadbeefdeadbeefdeadbeefdeadbeef'), 'hex token')
  assert.equal(findSecret('value c2VjcmV0LXRva2VuLTEyMzQ1Njc4OTBhYmNkZWZnaA=='), 'base64 token')
  assert.equal(findSecret('session-19c49d54-35e3-49e0-af2a-ea2c1cdfecc5'), null)
  assert.equal(findSecret('the quick brown fox jumps over the lazy dog'), null)
  assert.throws(() => assertNoSecrets('key=ghp_abcdefghijklmnopqrstuvwxyz'), /不要把密钥写进记忆/)
})

test('原子写、0600 权限、读回一致', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({
      scope: 'global',
      name: 'perm-check',
      description: '权限检查',
      type: 'reference',
      tags: ['dsh'],
      body: '正文',
      sessionId: 's1',
    })
    const path = itemPath(home, 'global', 'perm-check')
    const info = await stat(path)
    assert.equal(info.mode & 0o777, 0o600)
    const raw = await readFile(path, 'utf8')
    assert.match(raw, /^name: perm-check$/m)
    const item = await readItem(home, 'global', 'perm-check')
    assert.equal(item.meta.description, '权限检查')
    assert.equal(item.body.trim(), '正文')
  } finally {
    await cleanup()
  }
})

test('journal 追加、过滤与坏行容错', async () => {
  const { home, cleanup } = await testService()
  try {
    const first = await appendJournal(home, { actor: 'model', op: 'create', scope: 'global', name: 'a', before: null, after: 'A' })
    await appendJournal(home, { actor: 'user', op: 'update', scope: 'global', name: 'a', before: 'A', after: 'B', runId: 'run-1' })
    await writeFile(`${home}/journal.jsonl`, `${await readFile(`${home}/journal.jsonl`, 'utf8')}not-json\n`, 'utf8')
    const all = await readJournal(home)
    assert.equal(all.length, 2)
    assert.equal(all[0].id, first.id)
    assert.equal((await readJournal(home, { runId: 'run-1' })).length, 1)
    assert.equal((await readJournal(home, { limit: 1 }))[0].after, 'B')
    assert.equal((await readJournal(home, { id: first.id }))[0].op, 'create')
  } finally {
    await cleanup()
  }
})

test('归档与恢复：文件不删除、同名重复归档不覆盖', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const input = {
      scope: 'global',
      name: 'archive-me',
      description: '待归档',
      type: 'reference',
      tags: ['dsh'],
      body: '第一版',
      sessionId: 's1',
    }
    await service.upsertEntry(input)
    const first = await archiveItemFile(home, 'global', 'archive-me')
    assert.ok(first.archivedTo.endsWith('archive-me.md'))
    assert.equal(await readItem(home, 'global', 'archive-me'), null)
    await service.upsertEntry(input)
    const second = await archiveItemFile(home, 'global', 'archive-me')
    assert.notEqual(second.archivedTo, first.archivedTo)
    const restored = await restoreItemFile(home, 'global', 'archive-me')
    assert.ok(restored)
    const item = await readItem(home, 'global', 'archive-me')
    assert.ok(item)
  } finally {
    await cleanup()
  }
})

test('正文超过 8KB 被拒绝', async () => {
  const { service, cleanup } = await testService()
  try {
    await assert.rejects(
      service.upsertEntry({
        scope: 'global',
        name: 'too-big',
        description: '太大',
        type: 'reference',
        tags: ['dsh'],
        body: 'x'.repeat(8 * 1024 + 1),
        sessionId: 's1',
      }),
      /正文太长/,
    )
  } finally {
    await cleanup()
  }
})

test('设置：inboxReview 默认 ai、非法值回落到默认、阈值和上限被收敛', () => {
  assert.equal(DEFAULT_SETTINGS.inboxReview, 'ai')
  assert.equal(normalizeSettings({}).inboxReview, 'ai')
  assert.equal(normalizeSettings({ inboxReview: 'user' }).inboxReview, 'user')
  // 非法值保守回落到 user（不要失败开放）
  assert.equal(normalizeSettings({ inboxReview: 'yolo' }).inboxReview, 'user')
  assert.equal(normalizeSettings({ inboxReviewMinConfidence: 0.1 }).inboxReviewMinConfidence, 0.5)
  assert.equal(normalizeSettings({ inboxReviewMinConfidence: 3 }).inboxReviewMinConfidence, 1)
  assert.equal(normalizeSettings({ inboxReviewMinConfidence: 'x' }).inboxReviewMinConfidence, 0.7)
  assert.equal(normalizeSettings({ inboxReviewMax: 0 }).inboxReviewMax, 1)
  assert.equal(normalizeSettings({ inboxReviewMax: 999 }).inboxReviewMax, 100)
})

test('收件箱决定记录：进 decided/ 审计目录，不混进待审批列表', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const proposal = await service.propose({
      kind: 'create',
      scope: 'global',
      name: 'decided-probe',
      before: null,
      after: serializeEntry({
        name: 'decided-probe',
        description: '审计测试',
        type: 'reference',
        tags: ['dsh'],
        created: '2026-10-22',
        updated: '2026-10-22',
        verified_at: '2026-10-22',
        source: 'test',
      }, '正文'),
      reason: '测试',
      origin: 'subagent',
    })
    await service.decideInbox(proposal.id, 'reject', { actor: 'consolidate', runId: 'run-test', reason: 'AI 审阅测试' })
    assert.equal((await service.inbox()).length, 0)
    const doc = JSON.parse(await readFile(join(home, 'inbox', 'decided', `${proposal.id}.json`), 'utf8'))
    assert.equal(doc.decision, 'reject')
    assert.equal(doc.by, 'ai')
    assert.equal(doc.runId, 'run-test')
    assert.equal(doc.proposal.name, 'decided-probe')
    assert.match(doc.reason, /AI 审阅测试/)
    const log = await readFile(join(home, 'inbox', 'decisions.jsonl'), 'utf8')
    const lines = log.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].decision, 'reject')
    assert.equal(lines[0].name, 'decided-probe')
    assert.equal(lines[0].by, 'ai')
    assert.equal('proposal' in lines[0], false)
  } finally {
    await cleanup()
  }
})

test('决定审计：decided 文件写失败时，append-only decisions.jsonl 仍然留档', async () => {
  const { home, service, cleanup } = await testService()
  try {
    const proposal = await service.propose({
      kind: 'create',
      scope: 'global',
      name: 'audit-fallback',
      before: null,
      after: serializeEntry({
        name: 'audit-fallback',
        description: '审计兜底',
        type: 'reference',
        tags: ['dsh'],
        created: '2026-10-22',
        updated: '2026-10-22',
        verified_at: '2026-10-22',
        source: 'test',
      }, '正文'),
      reason: '测试',
      origin: 'subagent',
    })
    // 把 inbox/decided 占成普通文件，让 decided 的原子写失败。
    await writeFile(join(home, 'inbox', 'decided'), 'not a directory', 'utf8')
    const result = await service.decideInbox(proposal.id, 'reject', { actor: 'consolidate', reason: 'AI 审阅测试' })
    assert.equal(result.applied, false)
    const lines = (await readFile(join(home, 'inbox', 'decisions.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).name, 'audit-fallback')
    assert.equal((await service.inbox()).length, 0)
  } finally {
    await cleanup()
  }
})
