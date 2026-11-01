/**
 * 索引渲染：热度、宽限期、pinned、预算截断、MEMORY.md / 主题页快照。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { inGrace } from '../runtime/stats.js'
import {
  clampIndexText,
  decorateItems,
  renderMemoryIndex,
  renderTopicPage,
  splitTiers,
  topicSummary,
} from '../runtime/indexer.js'
import { normalizeMeta } from '../runtime/store.js'

const CONFIG = { hotBudgetChars: 6000, recentSessions: 20, graceSessions: 5 }

function item(scope, name, meta, body = '正文') {
  return { scope, name, meta: normalizeMeta(meta, { name }), body }
}

const stats = {
  version: 1,
  scopes: {
    global: { sessions: ['s1', 's2', 's3'] },
    'workspaces/w': { sessions: ['s1'] },
  },
  items: {
    'global/relay-no-proxy': { readSessions: ['s2', 's3'], lastUsed: '2026-10-19T10:00:00Z', hits: 3 },
    'global/cold-note': { readSessions: ['s0'], lastUsed: '2026-09-01T10:00:00Z', hits: 1 },
  },
}

const items = [
  item('global', 'relay-no-proxy', {
    name: 'relay-no-proxy',
    description: '访问 relay 必须设 NO_PROXY',
    type: 'feedback',
    tags: ['网络', 'dsh'],
    links: ['dsh-headless-model'],
    pinned: false,
    created: '2026-10-01',
    updated: '2026-10-19',
    verified_at: '2026-10-19',
    source: 's1',
  }),
  item('global', 'cold-note', {
    name: 'cold-note',
    description: '很旧的一条参考',
    type: 'reference',
    tags: ['网络'],
    created: '2026-08-01',
    updated: '2026-08-01',
    verified_at: '2026-08-01',
    source: 's0',
  }),
  item('global', 'pinned-rule', {
    name: 'pinned-rule',
    description: '永远不要动 prod 数据',
    type: 'feedback',
    tags: ['dsh'],
    pinned: true,
    created: '2026-07-01',
    updated: '2026-07-01',
    verified_at: '2026-09-01',
    source: 's1',
  }),
  item('global', 'fresh-note', {
    name: 'fresh-note',
    description: '刚记下的项目进度',
    type: 'project',
    tags: ['dsh'],
    created: '2026-10-20',
    updated: '2026-10-20',
    verified_at: '2026-10-20',
    source: 's3',
  }),
]

test('热度 = 读过它的会话与最近 N 个会话的交集；宽限期按来源会话位置算', () => {
  const decorated = decorateItems(items, stats, CONFIG)
  const byName = Object.fromEntries(decorated.map((entry) => [entry.name, entry]))
  assert.equal(byName['relay-no-proxy'].heat, 2)
  assert.equal(byName['cold-note'].heat, 0)
  // s3 是最近会话 → fresh-note 在宽限期内；s1 已过去 2 个会话，也在 5 个的宽限期内。
  assert.equal(byName['fresh-note'].grace, true)
  assert.equal(byName['relay-no-proxy'].grace, true)
  // s0 不在最近会话列表里 → 看日期兜底（超过 7 天 → 不在宽限期）。
  assert.equal(byName['cold-note'].grace, false)
  assert.equal(inGrace(stats, items[3], 0), false)
})

test('pinned > 宽限期 > 热度 > 最近使用', () => {
  const decorated = decorateItems(items, stats, CONFIG)
  assert.deepEqual(decorated.map((entry) => entry.name), ['pinned-rule', 'relay-no-proxy', 'fresh-note', 'cold-note'])
})

test('MEMORY.md 快照（热记忆 + 主题入口）', () => {
  // 预算 180 字符：三条热记忆刚好放得下，cold-note 落到冷层（主题入口仍列出）。
  const tight = { ...CONFIG, hotBudgetChars: 180 }
  const rendered = renderMemoryIndex({ scope: 'global', items, stats, config: tight })
  assert.equal(rendered.text, [
    '<!-- 由 dsh-memory 生成，不要手改 -->',
    '## 热记忆',
    '- [永远不要动 prod 数据](pinned-rule.md) — feedback · dsh 📌',
    '- [访问 relay 必须设 NO_PROXY](relay-no-proxy.md) — feedback · 网络,dsh',
    '- [刚记下的项目进度](fresh-note.md) — project · dsh',
    '',
    '## 主题（冷记忆入口，用 memory_topic 查看）',
    '- dsh — 3 条（热 3）：永远不要动 prod 数据、访问 relay 必须设、刚记下的项目进度',
    '- 网络 — 2 条（热 1）：访问 relay 必须设、很旧的一条参考',
    '',
  ].join('\n'))
  assert.equal(rendered.hot.length, 3)
  assert.equal(rendered.cold.length, 1)
})

test('预算截断：没进热层的进冷层；pinned 超预算也全部保留并给出标记', () => {
  const tight = { ...CONFIG, hotBudgetChars: 80 }
  const tiers = splitTiers(decorateItems(items, stats, tight), tight)
  assert.deepEqual(tiers.hot.map((entry) => entry.name), ['pinned-rule'])
  assert.equal(tiers.cold.length, 3)
  assert.ok(tiers.usedChars <= tight.hotBudgetChars)
  const onlyPinned = splitTiers(decorateItems(items.filter((entry) => entry.name === 'pinned-rule'), stats, { ...CONFIG, hotBudgetChars: 10 }), { ...CONFIG, hotBudgetChars: 10 })
  assert.equal(onlyPinned.hot.length, 1)
  assert.equal(onlyPinned.pinnedOverBudget, true)
})

test('主题页快照：按热度排序，标出冷热与最近使用', () => {
  const page = renderTopicPage({
    scope: 'global',
    tag: '网络',
    items,
    stats,
    config: CONFIG,
    hotNames: new Set(['relay-no-proxy', 'pinned-rule', 'fresh-note']),
  })
  const lines = page.text.trim().split('\n')
  assert.equal(lines[0], '<!-- 由 dsh-memory 生成，不要手改 -->')
  assert.equal(lines[1], '# 主题：网络')
  assert.match(page.text, /^- relay-no-proxy — 访问 relay 必须设 NO_PROXY（feedback，热，最近使用 2026-10-19）$/m)
  assert.match(page.text, /^- cold-note — 很旧的一条参考（reference，冷，最近使用 2026-09-01）$/m)
  // 热度高的在前
  assert.ok(page.text.indexOf('relay-no-proxy') < page.text.indexOf('cold-note'))
})

test('主题摘要取前三条 description 的关键词', () => {
  const decorated = decorateItems(items, stats, CONFIG)
  const networks = decorated.filter((entry) => entry.meta.tags.includes('网络'))
  assert.equal(topicSummary(networks), '访问 relay 必须设、很旧的一条参考')
})

test('注入预算截断保留热记忆、砍掉主题区', () => {
  const rendered = renderMemoryIndex({ scope: 'global', items, stats, config: CONFIG })
  const clamped = clampIndexText(rendered.text, 120)
  assert.match(clamped, /## 热记忆/)
  assert.match(clamped, /主题区已截断|索引已截断/)
  assert.ok([...clamped].length < [...rendered.text].length)
})
