/**
 * 使用计数与热度。
 *
 * 计数**不写进 frontmatter**（DESIGN.md §3.2）：每次 memory_read 都改条目文件
 * 会让文件在磁盘上不停变化、也让注入缓冲区失去稳定前缀。这里把计数放在
 * `stats.json` 这个 sidecar 里，条目文件只在真正被改写时才动。
 *
 * 热度公式（§4.1）：
 *   heat = |readSessions ∩ 该作用域最近 N 个会话|
 * 新条目在创建后前 graceSessions 个会话里视为热；pinned 永远热。
 *
 * @module @local/dsh-memory/stats
 */

import { metaPath } from './paths.js'
import { readJson, writeJson } from './store.js'

/** 一个作用域里最多记多少个会话 id。 */
const MAX_SCOPE_SESSIONS = 200

/** 一条记忆最多记多少个读过它的会话。 */
const MAX_READ_SESSIONS = 50

/** 新建条目「宽限期」的日期兜底（用户/API 建、没有来源会话时）。 */
const GRACE_DAYS_FALLBACK = 7

/** 空 stats。 */
export function emptyStats() {
  return { version: 1, scopes: {}, items: {} }
}

/** 读 stats（损坏时返回空表）。 */
export async function readStats(home) {
  const doc = await readJson(metaPath(home, 'stats'), null)
  if (!doc || typeof doc !== 'object') return emptyStats()
  return {
    version: 1,
    scopes: doc.scopes && typeof doc.scopes === 'object' ? doc.scopes : {},
    items: doc.items && typeof doc.items === 'object' ? doc.items : {},
  }
}

/** 写 stats。 */
export async function writeStats(home, stats) {
  await writeJson(metaPath(home, 'stats'), {
    version: 1,
    scopes: stats.scopes ?? {},
    items: stats.items ?? {},
  })
}

/** 取某作用域的会话列表。 */
export function scopeSessions(stats, scope) {
  const entry = stats.scopes?.[scope]
  return Array.isArray(entry?.sessions) ? entry.sessions : []
}

/**
 * 记录「本会话碰过这个作用域」。注入 baseline 与写入时调用。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} sessionId - 会话 id（`user` / `system` 也可以，但不算一次会话）。
 * @returns {Promise<void>}
 */
export async function recordScopeSession(home, scope, sessionId) {
  if (!sessionId || sessionId === 'user' || sessionId === 'system') return
  const stats = await readStats(home)
  const entry = stats.scopes[scope] ?? { sessions: [] }
  const sessions = Array.isArray(entry.sessions) ? [...entry.sessions] : []
  if (sessions.at(-1) !== sessionId) {
    const filtered = sessions.filter((id) => id !== sessionId)
    filtered.push(sessionId)
    entry.sessions = filtered.slice(-MAX_SCOPE_SESSIONS)
    stats.scopes[scope] = entry
    await writeStats(home, stats)
  }
}

/**
 * 记录一次「通过 memory_read 读到了这条记忆」。同一会话重复读只算一次。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<void>}
 */
export async function recordItemRead(home, scope, name, sessionId) {
  const stats = await readStats(home)
  const key = `${scope}/${name}`
  const item = stats.items[key] ?? { readSessions: [], lastUsed: null, hits: 0 }
  const readSessions = Array.isArray(item.readSessions) ? [...item.readSessions] : []
  if (sessionId && !readSessions.includes(sessionId)) {
    readSessions.push(sessionId)
  }
  stats.items[key] = {
    readSessions: readSessions.slice(-MAX_READ_SESSIONS),
    lastUsed: new Date().toISOString(),
    hits: Number.isFinite(item.hits) ? item.hits + 1 : 1,
  }
  await writeStats(home, stats)
}

/**
 * 算一条记忆在该作用域的热度。
 * @param {object} stats - stats 文档。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @param {object} [options] - recentSessions 窗口大小。
 * @returns {{heat: number, lastUsed: string|null, hits: number, readSessions: string[]}} 热度信息。
 */
export function heatOf(stats, scope, name, options = {}) {
  const recentSessions = options.recentSessions ?? 20
  const key = `${scope}/${name}`
  const item = stats.items?.[key]
  const reads = Array.isArray(item?.readSessions) ? item.readSessions : []
  const recent = scopeSessions(stats, scope).slice(-recentSessions)
  const heat = reads.filter((id) => recent.includes(id)).length
  return {
    heat,
    lastUsed: typeof item?.lastUsed === 'string' ? item.lastUsed : null,
    hits: Number.isFinite(item?.hits) ? item.hits : 0,
    readSessions: reads,
  }
}

/**
 * 判断新条目是否还在宽限期内。
 *
 * 「创建后的前 N 个会话」用来源会话在最近会话列表里的位置来数：
 * 来源会话就是最新会话 → 0 个会话过去了。来源不在列表里（很早以前、
 * 或用户直接从设置页新建）时退回日期判断（7 天）——见 README 的说明。
 * @param {object} stats - stats 文档。
 * @param {object} item - 条目（{scope, meta}）。
 * @param {number} graceSessions - 宽限会话数。
 * @param {Date} [now] - 测试注入的时间。
 * @returns {boolean} 是否还在宽限期。
 */
export function inGrace(stats, item, graceSessions, now = new Date()) {
  if (!(graceSessions > 0)) return false
  const sessions = scopeSessions(stats, item.scope)
  const source = item.meta?.source
  if (typeof source === 'string' && sessions.includes(source)) {
    const fromEnd = sessions.length - 1 - sessions.lastIndexOf(source)
    return fromEnd < graceSessions
  }
  const created = typeof item.meta?.created === 'string' ? Date.parse(`${item.meta.created}T00:00:00Z`) : NaN
  if (!Number.isFinite(created)) return true
  const days = (now.getTime() - created) / 86_400_000
  return days <= GRACE_DAYS_FALLBACK
}

/**
 * 清理 stats：删掉已不存在的条目、裁剪超长列表。
 * @param {object} stats - stats 文档（原地修改并返回新对象）。
 * @param {Set<string>} validKeys - 仍然存在的条目 key（`scope/name`）。
 * @returns {object} 清理后的 stats。
 */
export function pruneStats(stats, validKeys) {
  const items = {}
  for (const [key, value] of Object.entries(stats.items ?? {})) {
    if (!validKeys.has(key)) continue
    items[key] = {
      readSessions: Array.isArray(value?.readSessions) ? value.readSessions.slice(-MAX_READ_SESSIONS) : [],
      lastUsed: typeof value?.lastUsed === 'string' ? value.lastUsed : null,
      hits: Number.isFinite(value?.hits) ? value.hits : 0,
    }
  }
  const scopes = {}
  for (const [scope, value] of Object.entries(stats.scopes ?? {})) {
    const sessions = Array.isArray(value?.sessions) ? value.sessions.slice(-MAX_SCOPE_SESSIONS) : []
    scopes[scope] = { sessions }
  }
  return { version: 1, scopes, items }
}
