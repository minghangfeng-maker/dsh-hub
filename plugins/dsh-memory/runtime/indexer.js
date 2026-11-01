/**
 * 索引生成：MEMORY.md（热记忆 + 主题入口）和 `_topics/<tag>.md`。
 *
 * 这里是**纯函数**：给定条目、stats 和配置，返回文本，不碰文件系统。
 * 这样注入、轻整理、HTTP 概览、单元测试都用同一份渲染逻辑，快照测试也能
 * 固定住格式（DESIGN.md §4.3 / §4.4）。
 *
 * @module @local/dsh-memory/indexer
 */

import { inGrace, heatOf } from './stats.js'

/** 生成物第一行。 */
export const GENERATED_HEADER = '<!-- 由 dsh-memory 生成，不要手改 -->'

/** 描述里会破坏 markdown 链接的字符。 */
function escapeLabel(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]])/g, '\\$1')
}

/** 一行描述最多显示多少字符。 */
function shortDescription(text, max = 60) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...value]
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 给条目挂上热度/冷热层信息。
 * @param {object[]} items - 条目数组（{scope, name, meta, body}）。
 * @param {object} stats - stats 文档。
 * @param {object} config - 插件配置（recentSessions / graceSessions）。
 * @param {{now?: Date}} [options] - 测试注入时间。
 * @returns {object[]} 带 heat/tier/lastUsed 的条目。
 */
export function decorateItems(items, stats, config, options = {}) {
  const now = options.now ?? new Date()
  const decorated = items.map((item) => {
    const info = heatOf(stats, item.scope, item.name, { recentSessions: config.recentSessions })
    return {
      ...item,
      heat: info.heat,
      hits: info.hits,
      lastUsed: info.lastUsed,
      pinned: item.meta?.pinned === true,
      stale: item.meta?.stale === true,
      grace: inGrace(stats, item, config.graceSessions, now),
      tier: 'cold',
    }
  })
  return sortByHeat(decorated)
}

/**
 * 热度排序：pinned > 宽限期内 > 热度 > 最近使用 > 名字。
 * @param {object[]} items - decorateItems 的结果。
 * @returns {object[]} 排好序的新数组。
 */
export function sortByHeat(items) {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.grace !== b.grace) return a.grace ? -1 : 1
    if (a.heat !== b.heat) return b.heat - a.heat
    const used = String(b.lastUsed ?? '').localeCompare(String(a.lastUsed ?? ''))
    if (used !== 0) return used
    return a.name.localeCompare(b.name)
  })
}

/**
 * 一条热记忆的索引行。
 * @param {object} item - decorateItems 的结果。
 * @returns {string} markdown 行。
 */
export function renderHotLine(item) {
  const tags = Array.isArray(item.meta?.tags) && item.meta.tags.length > 0 ? item.meta.tags.join(',') : '无标签'
  const marks = `${item.pinned ? ' 📌' : ''}${item.stale ? ' ⚠️' : ''}`
  return `- [${escapeLabel(item.meta?.description || item.name)}](${item.name}.md) — ${item.meta?.type ?? 'reference'} · ${tags}${marks}`
}

/**
 * 挑出热层条目并计算预算使用。
 *
 * pinned 条目即使超预算也全部进热层（DESIGN.md §4.2），同时把一个警告返回给
 * 设置页；其余条目按热度顺序填到预算用尽为止。
 * @param {object[]} decorated - decorateItems 的结果（已排序）。
 * @param {object} config - 插件配置（hotBudgetChars）。
 * @returns {{hot: object[], cold: object[], usedChars: number, budgetChars: number, pinnedOverBudget: boolean}} 分层结果。
 */
export function splitTiers(decorated, config) {
  const budget = config.hotBudgetChars
  const hot = []
  const cold = []
  let used = 0
  let pinnedTotal = 0
  for (const item of decorated) {
    if (item.pinned) pinnedTotal += charLength(renderHotLine(item))
  }
  const pinnedOverBudget = pinnedTotal > budget
  let pinnedUsed = 0
  for (const item of decorated) {
    const line = renderHotLine(item)
    const lineChars = charLength(line) + 1
    if (item.pinned) {
      hot.push(item)
      pinnedUsed += lineChars
      continue
    }
    if (used + pinnedUsed + lineChars <= budget) {
      hot.push(item)
      used += lineChars
    } else {
      cold.push(item)
    }
  }
  const hotSet = new Set(hot.map((item) => item.name))
  const all = decorated.map((item) => ({ ...item, tier: hotSet.has(item.name) ? 'hot' : 'cold' }))
  return {
    hot: all.filter((item) => item.tier === 'hot'),
    cold: all.filter((item) => item.tier === 'cold'),
    usedChars: pinnedUsed + used,
    budgetChars: budget,
    pinnedOverBudget,
  }
}

/**
 * 按标签分组。
 * @param {object[]} items - 条目数组。
 * @returns {Map<string, object[]>} 标签 → 条目。
 */
export function groupByTag(items) {
  const groups = new Map()
  for (const item of items) {
    for (const tag of item.meta?.tags ?? []) {
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag).push(item)
    }
  }
  return groups
}

/**
 * 主题行摘要：取该标签下热度最高 3 条的 description 的关键词。
 * @param {object[]} items - 该标签下的条目（已按热度排序）。
 * @returns {string} 例如 `部署、代理、WP 进度`；没有内容时返回空串。
 */
export function topicSummary(items) {
  const parts = []
  for (const item of items.slice(0, 3)) {
    const description = String(item.meta?.description ?? '').trim()
    if (!description) continue
    const keyword = description.split(/[，,。;；:：.!?！？]+/).find((part) => part.trim().length > 0)?.trim() ?? description
    const chars = [...keyword]
    let value = keyword
    if (chars.length > 14) {
      const cut = chars.slice(0, 14).join('')
      // 尽量在词边界截断（中文没有空格，就按字符数截）。
      value = cut.replace(/\s+\S*$/, '').trim() || cut
    }
    if (!parts.includes(value)) parts.push(value)
  }
  return parts.join('、')
}

/**
 * 生成一个作用域的 MEMORY.md。
 * @param {object} input - { scope, items, stats, config, notice? }。
 * @returns {{text: string, hot: object[], cold: object[], topics: object[], usedChars: number, budgetChars: number, pinnedOverBudget: boolean}} 渲染结果。
 */
export function renderMemoryIndex(input) {
  const { items, stats, config } = input
  const decorated = decorateItems(items, stats, config, input.options)
  const tiers = splitTiers(decorated, config)
  const topics = [...groupByTag(tiers.hot.concat(tiers.cold)).entries()]
    .map(([tag, tagItems]) => ({
      tag,
      total: tagItems.length,
      hotCount: tagItems.filter((item) => item.tier === 'hot').length,
      items: sortByHeat(tagItems),
    }))
    .sort((a, b) => (b.total - a.total) || a.tag.localeCompare(b.tag))

  const lines = [GENERATED_HEADER, '## 热记忆']
  if (tiers.hot.length === 0) {
    lines.push('（还没有热记忆。用 memory_write 记下第一条。）')
  } else {
    for (const item of tiers.hot) lines.push(renderHotLine(item))
  }
  lines.push('', '## 主题（冷记忆入口，用 memory_topic 查看）')
  if (topics.length === 0) {
    lines.push('（还没有标签。）')
  } else {
    for (const topic of topics) {
      const summary = topicSummary(topic.items)
      const suffix = summary ? `：${summary}` : ''
      lines.push(`- ${topic.tag} — ${topic.total} 条（热 ${topic.hotCount}）${suffix}`)
    }
  }
  if (input.notice) lines.push('', input.notice)
  return {
    text: `${lines.join('\n')}\n`,
    hot: tiers.hot,
    cold: tiers.cold,
    topics,
    usedChars: tiers.usedChars,
    budgetChars: tiers.budgetChars,
    pinnedOverBudget: tiers.pinnedOverBudget,
    decorated,
  }
}

/**
 * 生成一个标签的主题页（第 1 跳）。
 * @param {object} input - { scope, tag, items, stats, config }。
 * @returns {{text: string, items: object[]}} 页面文本与排好序的条目。
 */
export function renderTopicPage(input) {
  const { tag, items, stats, config } = input
  const decorated = sortByHeat(decorateItems(
    items.filter((item) => item.meta?.tags?.includes(tag)),
    stats,
    config,
    input.options,
  ))
  // 主题页也要标对冷热：tier 由全库的预算分配决定，不在这里重新算一遍。
  // 冷热标记要用**全库**的分层结果（调用方传进来）；没有就退化为本标签内部分层。
  const provided = input.hotNames instanceof Set ? input.hotNames : null
  const hotNames = provided ?? new Set(splitTiers(decorated, config).hot.map((item) => item.name))
  const lines = [GENERATED_HEADER, `# 主题：${tag}`, '']
  if (decorated.length === 0) {
    lines.push('（这个标签下还没有条目。）')
  } else {
    for (const item of decorated) {
      const when = item.lastUsed ? item.lastUsed.slice(0, 10) : '未用过'
      const tierLabel = hotNames.has(item.name) ? '热' : '冷'
      lines.push(`- ${item.name} — ${shortDescription(item.meta?.description, 80)}（${item.meta?.type ?? 'reference'}，${tierLabel}，最近使用 ${when}）`)
    }
  }
  return { text: `${lines.join('\n')}\n`, items: decorated }
}

/**
 * 注入用：把 MEMORY.md 里的「主题」区截短到预算内。
 * @param {string} text - 完整索引文本。
 * @param {number} budgetChars - 字符上限。
 * @returns {string} 截断后的文本（保留热记忆区）。
 */
export function clampIndexText(text, budgetChars) {
  if (charLength(text) <= budgetChars) return text
  const marker = '\n## 主题（冷记忆入口，用 memory_topic 查看）'
  const index = text.indexOf(marker)
  const head = index >= 0 ? text.slice(0, index) : text
  if (charLength(head) >= budgetChars) {
    return `${truncateChars(head, Math.max(0, budgetChars - 30))}\n…（索引已截断，用 memory_search 搜索）`
  }
  const notice = '\n- …（主题区已截断，用 memory_topic 或 memory_search 查看其余）\n'
  return `${head}\n## 主题（冷记忆入口，用 memory_topic 查看）${notice}`
}

/** 字符数（按码点，不按 UTF-16 单元）。 */
export function charLength(text) {
  return typeof text === 'string' ? [...text].length : 0
}

/** 按码点截断。 */
export function truncateChars(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('')
}
