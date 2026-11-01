/**
 * 图谱：节点/边形状、跨作用域 link、coread 权重与每节点上限、>300 节点提示。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGraph } from '../runtime/graph.js'
import { normalizeMeta } from '../runtime/store.js'

const CONFIG = { recentSessions: 20, graceSessions: 5, hotBudgetChars: 6000 }

function item(scope, name, meta = {}, body = '正文') {
  return { scope, name, meta: normalizeMeta(meta, { name }), body }
}

function statsOf(items) {
  return {
    version: 1,
    scopes: {},
    items: Array.isArray(items) ? Object.fromEntries(items) : { ...items },
  }
}

test('条目节点、标签节点和 tag 边', () => {
  const items = [
    item('global', 'relay-no-proxy', { description: 'relay 必须设 NO_PROXY', type: 'feedback', tags: ['dsh', '网络'], pinned: true }),
    item('global', 'headless', { description: 'headless 用法', type: 'reference', tags: ['dsh'] }),
  ]
  const nodes = new Map()
  const graph = buildGraph({ items, stats: statsOf({}), config: CONFIG, tiers: new Map([['global', { hot: new Set(['relay-no-proxy']) }]]) })
  for (const node of graph.nodes) nodes.set(node.id, node)
  const relay = nodes.get('global/relay-no-proxy')
  assert.equal(relay.kind, 'item')
  assert.equal(relay.type, 'feedback')
  assert.equal(relay.tier, 'hot')
  assert.equal(relay.pinned, true)
  assert.equal(relay.stale, false)
  assert.equal(nodes.get('tag:dsh').count, 2)
  assert.equal(nodes.get('tag:网络').count, 1)
  assert.equal(nodes.get('global/headless').tier, 'cold')
  assert.ok(graph.edges.filter((edge) => edge.kind === 'tag').length === 3)
})

test('link 边：同作用域裸名与 global:<name> 跨作用域', () => {
  const items = [
    item('global', 'a', { description: 'A', tags: ['dsh'], links: ['b', 'global:c'] }),
    item('global', 'b', { description: 'B', tags: ['dsh'] }),
    item('global', 'c', { description: 'C', tags: ['dsh'] }),
  ]
  const graph = buildGraph({ items, stats: statsOf({}), config: CONFIG, tiers: new Map() })
  const links = graph.edges.filter((edge) => edge.kind === 'link')
  assert.deepEqual(
    links.map((edge) => `${edge.source}->${edge.target}`).sort(),
    ['global/a->global/b', 'global/a->global/c'],
  )
  // 指向不存在的条目不会造边
  const dangling = buildGraph({ items: [item('global', 'x', { description: 'X', tags: ['dsh'], links: ['nope'] })], stats: statsOf({}), config: CONFIG, tiers: new Map() })
  assert.equal(dangling.edges.filter((edge) => edge.kind === 'link').length, 0)
})

test('coread：共同读过 ≥2 个会话才连边，权重=共同会话数，每节点最多 5 条', () => {
  const items = []
  const statsItems = {}
  for (let i = 0; i < 8; i += 1) {
    items.push(item('global', `hub-${i}`, { description: `条目 ${i}`, tags: ['dsh'] }))
  }
  // hub-0 和每个其它条目都有 2 个共同会话；其余两两只有 1 个。
  for (let i = 0; i < 8; i += 1) {
    const sessions = i === 0 ? ['s1', 's2'] : ['s1', 's2', `solo-${i}`]
    statsItems[`global/hub-${i}`] = { readSessions: sessions, hits: 1, lastUsed: null }
  }
  const graph = buildGraph({ items, stats: statsOf(statsItems), config: CONFIG, tiers: new Map() })
  const coread = graph.edges.filter((edge) => edge.kind === 'coread')
  assert.ok(coread.length > 0)
  for (const edge of coread) assert.ok(edge.weight >= 2)
  const hubEdges = coread.filter((edge) => edge.source === 'global/hub-0' || edge.target === 'global/hub-0')
  assert.equal(hubEdges.length, 5, 'hub-0 最多保留 5 条 coread 边')
})

test('scope 过滤只保留该作用域', () => {
  const items = [
    item('global', 'g', { description: 'G', tags: ['dsh'] }),
    item('workspaces/w', 'w', { description: 'W', tags: ['dsh'] }),
  ]
  const graph = buildGraph({ items, stats: statsOf({}), config: CONFIG, tiers: new Map(), scope: 'workspaces/w' })
  assert.deepEqual(graph.nodes.filter((node) => node.kind === 'item').map((node) => node.id), ['workspaces/w/w'])
  assert.ok(graph.edges.every((edge) => !edge.source.startsWith('global/')))
})

test('节点超过 300 个时报告隐藏冷条目数量（数据仍然完整）', () => {
  const items = []
  for (let i = 0; i < 301; i += 1) {
    items.push(item('global', `n-${i}`, { description: `条目 ${i}`, tags: ['bulk'] }))
  }
  const graph = buildGraph({ items, stats: statsOf({}), config: CONFIG, tiers: new Map() })
  assert.equal(graph.totalNodes, 302)
  assert.equal(graph.hiddenCold, 301)
})
