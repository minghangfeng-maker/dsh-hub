/**
 * 记忆图谱数据（DESIGN.md §11.1）。
 *
 * 纯函数：输入条目、stats、分层表和配置，输出节点与边。客户端的力导向布局
 * 只消费这份数据，不再做语义计算。
 *
 * 节点 id：条目是 `scope/name`，标签是 `tag:<tag>`；
 * 边：tag（条目→标签）、link（条目→条目）、coread（共同读过 ≥2 个会话，
 * 权重 = 共同会话数，每个节点最多 5 条）。
 *
 * @module @local/dsh-memory/graph
 */

import { itemKey } from './paths.js'
import { heatOf } from './stats.js'

/** 每个节点最多保留多少条 coread 边。 */
const MAX_COREAD_PER_NODE = 5

/**
 * 构建图谱。
 * @param {object} input - {items, stats, tiers, config, scope}。
 * @returns {{nodes: object[], edges: object[], hiddenCold: number, totalNodes: number}} 图数据。
 */
export function buildGraph(input) {
  const { items, stats, config } = input
  const tiers = input.tiers ?? new Map()
  const selected = input.scope ? items.filter((item) => item.scope === input.scope) : items
  const nodes = []
  const edges = []
  const byKey = new Map()
  const tagCounts = new Map()

  for (const item of selected) {
    const key = itemKey(item.scope, item.name)
    const heat = heatOf(stats, item.scope, item.name, { recentSessions: config.recentSessions })
    const tier = tiers.get(item.scope)?.hot.has(item.name) ? 'hot' : 'cold'
    const node = {
      id: key,
      kind: 'item',
      label: item.meta.description || item.name,
      name: item.name,
      type: item.meta.type,
      scope: item.scope,
      tier,
      heat: heat.heat,
      pinned: item.meta.pinned === true,
      stale: item.meta.stale === true,
      description: item.meta.description,
      tags: item.meta.tags ?? [],
    }
    nodes.push(node)
    byKey.set(key, node)
    for (const tag of item.meta.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      edges.push({ source: key, target: `tag:${tag}`, kind: 'tag' })
    }
  }

  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    nodes.push({ id: `tag:${tag}`, kind: 'tag', label: tag, count })
  }

  // link 边：`global:<name>` 跨作用域；同作用域写裸 name。
  for (const item of selected) {
    const key = itemKey(item.scope, item.name)
    for (const link of item.meta.links ?? []) {
      const target = link.includes(':')
        ? link.replace(':', '/')
        : (item.scope === 'global' ? `global/${link}` : `${item.scope}/${link}`)
      if (!byKey.has(target)) continue
      edges.push({ source: key, target, kind: 'link' })
    }
  }

  // coread 边：两条记忆在 ≥2 个相同会话里都被读过。
  const readMap = new Map()
  for (const item of selected) {
    const key = itemKey(item.scope, item.name)
    const readSessions = stats.items?.[key]?.readSessions
    if (Array.isArray(readSessions) && readSessions.length > 0) readMap.set(key, new Set(readSessions))
  }
  const perNode = new Map()
  const keys = [...readMap.keys()]
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = readMap.get(keys[i])
      const b = readMap.get(keys[j])
      let shared = 0
      for (const id of a) if (b.has(id)) shared += 1
      if (shared < 2) continue
      if ((perNode.get(keys[i]) ?? 0) >= MAX_COREAD_PER_NODE) continue
      if ((perNode.get(keys[j]) ?? 0) >= MAX_COREAD_PER_NODE) continue
      perNode.set(keys[i], (perNode.get(keys[i]) ?? 0) + 1)
      perNode.set(keys[j], (perNode.get(keys[j]) ?? 0) + 1)
      edges.push({ source: keys[i], target: keys[j], kind: 'coread', weight: shared })
    }
  }

  // 超过 300 个节点时告知客户端「默认隐藏冷条目」，数据仍然完整。
  const hiddenCold = nodes.length > 300
    ? nodes.filter((node) => node.kind === 'item' && node.tier === 'cold').length
    : 0
  return {
    nodes,
    edges,
    hiddenCold,
    totalNodes: nodes.length,
    generatedAt: new Date().toISOString(),
  }
}
