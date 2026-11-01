/**
 * 条目存储：frontmatter 子集、原子写、归档、日志、设置。
 *
 * 设计约束（来自 DESIGN.md）：
 *   - frontmatter 只用简单 YAML 子集（标量、字符串数组），自己解析，不引依赖；
 *   - 所有文件 0600、目录 0700，写入一律「临时文件 + rename」；
 *   - 永不删除条目文件，只归档；归档区可以恢复；
 *   - 每次写都进 journal.jsonl，带改前/改后全文，撤销就是把 before 写回。
 *
 * @module @local/dsh-memory/store
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  MAX_BODY_BYTES,
  MAX_DESCRIPTION_CHARS,
  NAME_RE,
  TYPES,
  archivePath,
  assertName,
  assertTags,
  inboxDecisionPath,
  inboxPath,
  isInboxId,
  isSessionId,
  isWorkspaceKey,
  itemPath,
  metaPath,
  scopeDir,
  sessionNotesPath,
} from './paths.js'

/* ────────────────────────────── 基础 IO ────────────────────────────── */

/** 递归建目录（0700）。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** 读文本；不存在返回 null。 */
export async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 原子写文本（临时文件 + rename，0600）。 */
export async function atomicWrite(path, text) {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
}

/** 读 JSON；不存在或损坏返回 fallback。 */
export async function readJson(path, fallback) {
  const text = await readTextOrNull(path)
  if (text === null) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 原子写 JSON（末尾带换行，方便 diff）。 */
export async function writeJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

/* ────────────────────────────── 密钥扫描 ────────────────────────────── */

/**
 * 常见密钥模式。命中就拒绝写入 —— 记忆文件是可以被设置页读出来的。
 * 「长度 ≥32 的 hex/base64 token」两条规则做了收紧（hex 32、base64 40 且必须
 * 同时含字母和数字），避免把普通 UUID / 长英文标识误判成密钥。
 */
const SECRET_PATTERNS = [
  { name: 'sk- 密钥', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'hex token', re: /\b[0-9a-fA-F]{32,}\b/ },
  {
    // 只认标准 base64 字符集（不含 - 和 _）：否则 `session-<uuid>` 这类
    // 40 多个字符的标识会被误判成密钥。base64url 的密钥请改用别的前缀规则。
    name: 'base64 token',
    re: /\b(?=[A-Za-z0-9+/=]{40,}\b)(?=[A-Za-z0-9+/=]*[0-9])(?=[A-Za-z0-9+/=]*[A-Za-z])[A-Za-z0-9+/=]{40,}\b/,
  },
]

/**
 * 检查文本里有没有密钥。
 * @param {string} text - 任意待写入的文本。
 * @returns {string|null} 命中的模式名，没命中返回 null。
 */
export function findSecret(text) {
  if (typeof text !== 'string' || !text) return null
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) return pattern.name
  }
  return null
}

/**
 * 断言没有密钥，否则抛错。
 * @param {string} text - 待写入文本。
 * @throws {Error} code=secret-detected。
 */
export function assertNoSecrets(text) {
  const hit = findSecret(text)
  if (hit !== null) {
    const error = new Error(`不要把密钥写进记忆（检测到 ${hit}）。改成「密钥放在哪里」的说明。`)
    error.code = 'secret-detected'
    throw error
  }
}

/* ────────────────────────────── frontmatter ────────────────────────────── */

const FM_DELIMITER = '---'

/** 去掉值两端的引号。 */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * 切分 `[a, "b,c", d]` 的方括号内部：引号里的逗号不切。
 * @param {string} inner - 去掉方括号后的内容。
 * @returns {string[]} 各项原文。
 */
function splitInlineArray(inner) {
  const items = []
  let current = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '' || items.length > 0) items.push(current)
  return items
}

/** 解析标量。 */
function parseScalar(value) {
  const text = value.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineArray(inner).map((part) => unquote(part)).filter((part) => part !== '')
  }
  return unquote(text)
}

/** 序列化标量/数组。 */
function formatScalar(value) {
  if (Array.isArray(value)) return `[${value.map((item) => formatArrayItem(item)).join(', ')}]`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined) return 'null'
  return formatArrayItem(value)
}

/** 数组项：含逗号、方括号、冒号、引号时用 JSON 引号包起来。 */
function formatArrayItem(value) {
  const text = String(value)
  if (/[,[\]{}:#"]/.test(text) || text !== text.trim()) return JSON.stringify(text)
  return text
}

/**
 * 解析一条条目文件的全文。
 *
 * 只支持 DESIGN.md 约定的 YAML 子集：`key: scalar` 与 `key: [a, b]`。
 * 文件没有 frontmatter 时按「纯正文」解析，meta 只有空对象（调用方补默认值）。
 * @param {string} raw - 文件全文。
 * @returns {{meta: object, body: string, hasFrontmatter: boolean}} 解析结果。
 */
export function parseEntry(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FM_DELIMITER) {
    return { meta: {}, body: text, hasFrontmatter: false }
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FM_DELIMITER) {
      end = i
      break
    }
  }
  if (end < 0) return { meta: {}, body: text, hasFrontmatter: false }
  const meta = {}
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf(':')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue
    meta[key] = parseScalar(trimmed.slice(index + 1))
  }
  return { meta, body: lines.slice(end + 1).join('\n').replace(/^\n/, ''), hasFrontmatter: true }
}

/** frontmatter 字段的固定顺序。 */
const FIELD_ORDER = [
  'name',
  'description',
  'type',
  'tags',
  'links',
  'pinned',
  'created',
  'updated',
  'verified_at',
  'source',
  'stale',
]

/**
 * 序列化条目（meta + body → 文件全文）。
 * @param {object} meta - 条目字段。
 * @param {string} body - 正文。
 * @returns {string} 文件全文。
 */
export function serializeEntry(meta, body) {
  const lines = [FM_DELIMITER]
  for (const key of FIELD_ORDER) {
    if (meta[key] === undefined) continue
    // stale 只在为 true 时写：绝大多数条目不是过期项目，不该每份文件多一行噪音。
    if (key === 'stale' && meta[key] !== true) continue
    lines.push(`${key}: ${formatScalar(meta[key])}`)
  }
  for (const key of Object.keys(meta)) {
    if (FIELD_ORDER.includes(key) || meta[key] === undefined) continue
    lines.push(`${key}: ${formatScalar(meta[key])}`)
  }
  lines.push(FM_DELIMITER, '')
  const text = String(body ?? '').replace(/\r\n/g, '\n').trimEnd()
  return `${lines.join('\n')}\n${text}\n`
}

/** 今天的日期（UTC，YYYY-MM-DD）。 */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 把解析出的原始 meta 归一成条目字段。
 * @param {object} meta - parseEntry 的结果。
 * @param {{name: string}} hints - 文件名之类的兜底。
 * @returns {object} 规整后的 meta。
 */
export function normalizeMeta(meta, hints = {}) {
  const now = today()
  const name = typeof meta.name === 'string' && NAME_RE.test(meta.name) ? meta.name : hints.name
  return {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    type: TYPES.includes(meta.type) ? meta.type : 'reference',
    tags: Array.isArray(meta.tags) ? meta.tags.filter((tag) => typeof tag === 'string') : [],
    links: Array.isArray(meta.links) ? meta.links.filter((link) => typeof link === 'string') : [],
    pinned: meta.pinned === true,
    created: typeof meta.created === 'string' ? meta.created : now,
    updated: typeof meta.updated === 'string' ? meta.updated : now,
    verified_at: typeof meta.verified_at === 'string' ? meta.verified_at : now,
    source: typeof meta.source === 'string' ? meta.source : 'unknown',
    stale: meta.stale === true,
  }
}

/* ────────────────────────────── 条目读写 ────────────────────────────── */

/**
 * 读一条条目。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @returns {Promise<object|null>} 条目对象，或 null（不存在）。
 */
export async function readItem(home, scope, name) {
  assertName(name)
  const path = itemPath(home, scope, name)
  const raw = await readTextOrNull(path)
  if (raw === null) return null
  const parsed = parseEntry(raw)
  const meta = normalizeMeta(parsed.meta, { name })
  return { scope, name, meta, body: parsed.body, raw, path }
}

/**
 * 列出某作用域下的全部条目（不含生成物）。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @returns {Promise<{items: object[], broken: {file: string, error: string}[]}>} 条目与坏文件。
 */
export async function listItems(home, scope) {
  const dir = join(home, scopeDir(scope))
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { items: [], broken: [] }
    throw error
  }
  const items = []
  const broken = []
  for (const file of names.sort()) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue
    const name = file.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    try {
      const item = await readItem(home, scope, name)
      if (item) items.push(item)
    } catch (error) {
      broken.push({ file, error: String(error?.message || error) })
    }
  }
  return { items, broken }
}

/**
 * 列出所有存在的作用域。
 * @param {string} home - 记忆根目录。
 * @returns {Promise<string[]>} `global` 加上各工作区。
 */
export async function listScopes(home) {
  const scopes = []
  if (await exists(join(home, 'global'))) scopes.push('global')
  let dirs = []
  try {
    dirs = await readdir(join(home, 'workspaces'), { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const entry of dirs) {
    // `.` / `..` 不可能出现在 readdir 里，但这里仍走同一个 key 校验，
    // 保证「目录 → 作用域」这条回流路径和写入路径用同一套规则。
    if (entry.isDirectory() && isWorkspaceKey(entry.name)) {
      scopes.push(`workspaces/${entry.name}`)
    }
  }
  return scopes
}

/** 路径是否存在。 */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 整份写一条条目（调用方负责 journal）。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @param {string} raw - 完整文件文本。
 */
export async function writeItemRaw(home, scope, name, raw) {
  await atomicWrite(itemPath(home, scope, name), raw)
}

/* ────────────────────────────── 日志 ────────────────────────────── */

/**
 * 追加一条 journal（一行 JSON）。
 * @param {string} home - 记忆根目录。
 * @param {object} entry - 日志字段（id/at 缺失时自动补）。
 * @returns {Promise<object>} 写进去的完整条目。
 */
export async function appendJournal(home, entry) {
  const record = {
    id: entry.id ?? `j-${randomUUID()}`,
    at: entry.at ?? new Date().toISOString(),
    ...entry,
  }
  delete record.skip
  const path = metaPath(home, 'journal')
  await ensureDir(dirname(path))
  const line = `${JSON.stringify(record)}\n`
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.write(line)
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600).catch(() => {})
  return record
}

/** 进程内 journal 缓存：路径 → { size, entries }。 */
const journalCache = new Map()

/**
 * 读 journal。
 *
 * 注入路径每一步都要问「有没有变化」，所以这里带一个进程内缓存：文件大小没变就
 * 直接用上次解析的结果；变长了只读新增的那一段（跨进程写入也能看到）。
 * @param {string} home - 记忆根目录。
 * @param {{limit?: number, runId?: string, id?: string, after?: number}} [options] - 过滤条件；
 *   `after` 只返回第 after 行之后的条目（配合 journalCount 做增量）。
 * @returns {Promise<object[]>} 按时间正序。
 */
export async function readJournal(home, options = {}) {
  const path = metaPath(home, 'journal')
  let info = null
  try {
    info = await stat(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (info === null) return []
  const cached = journalCache.get(path)
  let entries
  if (cached && cached.size === info.size) {
    entries = cached.entries
  } else if (cached && cached.size < info.size) {
    // 按**字节**偏移读新增段（journal 里有中文，不能按字符切）。
    const buffer = await readFile(path)
    const added = buffer.subarray(cached.size).toString('utf8')
    const parsed = parseJournalLines(added)
    entries = cached.entries.concat(parsed)
    journalCache.set(path, { size: info.size, entries })
  } else {
    const text = await readTextOrNull(path)
    if (text === null) return []
    entries = parseJournalLines(text)
    journalCache.set(path, { size: info.size, entries })
  }
  let selected = entries
  if (typeof options.after === 'number' && options.after >= 0) selected = selected.slice(options.after)
  if (options.runId !== undefined) selected = selected.filter((entry) => entry.runId === options.runId)
  if (options.id !== undefined) selected = selected.filter((entry) => entry.id === options.id)
  if (typeof options.limit === 'number' && options.limit > 0 && selected.length > options.limit) {
    return selected.slice(-options.limit)
  }
  return selected
}

/** 解析 journal 文本（坏行跳过）。 */
function parseJournalLines(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 坏行跳过（journal 是只追加的，不能因为一行坏了就整份读不出来）
    }
  }
  return entries
}

/**
 * journal 当前有多少条可解析的记录（注入用它判断「有没有新变化」）。
 * @param {string} home - 记忆根目录。
 * @returns {Promise<number>} 行数（跳过坏行）。
 */
export async function journalCount(home) {
  return (await readJournal(home)).length
}

/* ────────────────────────────── 归档 / 恢复 ────────────────────────────── */

/** 时间戳后缀（用于同名重复归档）。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 归档一条条目：把文件搬到 archive/<scope>/，保留全文。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @returns {Promise<{archivedTo: string, raw: string}|null>} 归档结果，条目不存在返回 null。
 */
export async function archiveItemFile(home, scope, name) {
  assertName(name)
  const source = itemPath(home, scope, name)
  const raw = await readTextOrNull(source)
  if (raw === null) return null
  let target = archivePath(home, scope, name)
  if (await exists(target)) target = archivePath(home, scope, name, stamp())
  await ensureDir(dirname(target))
  await atomicWrite(target, raw)
  await unlink(source)
  return { archivedTo: target, raw }
}

/**
 * 从归档区恢复一条条目（取最近一份）。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @returns {Promise<{raw: string, from: string}|null>} 恢复结果，没有归档返回 null。
 */
export async function restoreItemFile(home, scope, name) {
  assertName(name)
  const dir = dirname(archivePath(home, scope, name))
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const exact = `${name}.md`
  const candidates = names
    .filter((file) => file === exact || (file.startsWith(`${name}.`) && file.endsWith('.md')))
    .sort()
  const chosen = candidates.includes(exact) ? exact : candidates.at(-1)
  if (!chosen) return null
  const from = join(dir, chosen)
  const raw = await readFile(from, 'utf8')
  await atomicWrite(itemPath(home, scope, name), raw)
  return { raw, from }
}

/* ────────────────────────────── 标签词表 ────────────────────────────── */

/** 读标签词表。 */
export async function readTags(home) {
  const doc = await readJson(metaPath(home, 'tags'), null)
  if (!doc || typeof doc !== 'object') return { tags: {}, synonyms: {} }
  return {
    tags: doc.tags && typeof doc.tags === 'object' ? doc.tags : {},
    synonyms: doc.synonyms && typeof doc.synonyms === 'object' ? doc.synonyms : {},
  }
}

/** 写标签词表。 */
export async function writeTags(home, doc) {
  await writeJson(metaPath(home, 'tags'), {
    tags: doc.tags ?? {},
    synonyms: doc.synonyms ?? {},
  })
}

/**
 * 按同义词表归一标签（只追一层，避免环）。
 * @param {string[]} tags - 原始标签。
 * @param {{synonyms: Record<string,string>}} tagsDoc - 标签词表。
 * @returns {string[]} 归一后的标签（去重）。
 */
export function normalizeTagList(tags, tagsDoc) {
  const synonyms = tagsDoc?.synonyms ?? {}
  const out = []
  for (const tag of tags) {
    let value = tag
    const mapped = synonyms[tag]
    if (typeof mapped === 'string' && mapped.trim()) value = mapped.trim()
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/* ────────────────────────────── 设置 ────────────────────────────── */

/** 定时整理的默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  deepFrequency: 'daily',
  deepTime: '03:30',
  idleMinutes: 30,
  model: null,
  maxLlmCalls: 30,
  sessionIdleHours: 6,
  // 深整理时由 AI 审阅子代理提交的收件箱提议：'ai' 直接决策，'user' 留给用户点批准。
  inboxReview: 'ai',
  // 只有置信度不低于这个值的 approve/reject 才会被执行，其余的继续留在收件箱。
  inboxReviewMinConfidence: 0.7,
  // 每次深整理最多审阅多少条提议（控制 LLM 预算）。
  inboxReviewMax: 20,
  lastLight: null,
  lastDeep: null,
  lastRun: null,
  lastError: null,
})

/** 校验设置字段，返回规整后的对象（未知字段丢弃）。 */
export function normalizeSettings(input, base = DEFAULT_SETTINGS) {
  const source = input && typeof input === 'object' ? input : {}
  const merged = { ...base, ...source }
  const deepFrequency = ['daily', 'weekly', 'off'].includes(merged.deepFrequency) ? merged.deepFrequency : base.deepFrequency
  const deepTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(merged.deepTime)) ? String(merged.deepTime) : base.deepTime
  const clampInt = (value, fallback, min, max) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(max, Math.max(min, Math.round(num)))
  }
  const clampFloat = (value, fallback, min, max) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(max, Math.max(min, num))
  }
  let model = null
  if (merged.model && typeof merged.model === 'object'
    && typeof merged.model.provider === 'string' && typeof merged.model.model === 'string') {
    model = { provider: merged.model.provider, model: merged.model.model }
  }
  return {
    enabled: merged.enabled !== false,
    deepFrequency,
    deepTime,
    idleMinutes: clampInt(merged.idleMinutes, base.idleMinutes, 1, 24 * 60),
    model,
    maxLlmCalls: clampInt(merged.maxLlmCalls, base.maxLlmCalls, 1, 500),
    sessionIdleHours: clampInt(merged.sessionIdleHours, base.sessionIdleHours, 1, 24 * 30),
    // 非法值保守回落到 user（失败开放会让 AI 自动落盘意外开启）。
    inboxReview: ['ai', 'user'].includes(merged.inboxReview) ? merged.inboxReview : 'user',
    inboxReviewMinConfidence: clampFloat(merged.inboxReviewMinConfidence, base.inboxReviewMinConfidence, 0.5, 1),
    inboxReviewMax: clampInt(merged.inboxReviewMax, base.inboxReviewMax, 1, 100),
    lastLight: typeof merged.lastLight === 'string' ? merged.lastLight : null,
    lastDeep: typeof merged.lastDeep === 'string' ? merged.lastDeep : null,
    lastRun: merged.lastRun && typeof merged.lastRun === 'object' ? merged.lastRun : null,
    lastError: typeof merged.lastError === 'string' ? merged.lastError : null,
    // 子代理写入策略的临时覆盖（只能手改 settings.json，设置页 API 不接受），到期自动失效。
    subagentWritesOverride: ['inbox', 'deny', 'allow'].includes(merged.subagentWritesOverride)
      ? merged.subagentWritesOverride
      : null,
    subagentWritesOverrideUntil: typeof merged.subagentWritesOverrideUntil === 'string'
      && Number.isFinite(Date.parse(merged.subagentWritesOverrideUntil))
      ? merged.subagentWritesOverrideUntil
      : null,
  }
}

/**
 * 当前生效的子代理写入策略：settings.json 里未过期的临时覆盖优先，否则用插件配置。
 * @param {object} settings - readSettings 的结果。
 * @param {string} configured - 插件配置里的 subagentWrites。
 * @param {number} [now] - 当前时间戳（测试用）。
 */
export function effectiveSubagentWrites(settings, configured, now = Date.now()) {
  const override = settings?.subagentWritesOverride
  const until = Date.parse(settings?.subagentWritesOverrideUntil ?? '')
  if (override && Number.isFinite(until) && until > now) return override
  return configured
}

/** 读设置（自动补默认值）。 */
export async function readSettings(home) {
  const doc = await readJson(metaPath(home, 'settings'), null)
  return normalizeSettings(doc)
}

/** 写设置。 */
export async function writeSettings(home, settings) {
  const normalized = normalizeSettings(settings)
  await writeJson(metaPath(home, 'settings'), normalized)
  return normalized
}

/** 合并写设置（只覆盖传入字段）。 */
export async function patchSettings(home, patch) {
  const current = await readSettings(home)
  const next = normalizeSettings({ ...current, ...patch }, current)
  await writeJson(metaPath(home, 'settings'), next)
  return next
}

/* ────────────────────────────── 会话笔记 ────────────────────────────── */

/** 读一份会话笔记文件。 */
export async function readSessionNotes(home, sessionId) {
  const doc = await readJson(sessionNotesPath(home, sessionId), null)
  if (!doc || typeof doc !== 'object') return null
  return {
    sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : sessionId,
    workspace: typeof doc.workspace === 'string' ? doc.workspace : '',
    notes: Array.isArray(doc.notes) ? doc.notes.filter((note) => note && typeof note.text === 'string') : [],
    promoted: Array.isArray(doc.promoted) ? doc.promoted : [],
  }
}

/** 写一份会话笔记文件。 */
export async function writeSessionNotes(home, sessionId, doc) {
  await writeJson(sessionNotesPath(home, sessionId), {
    sessionId,
    workspace: doc.workspace ?? '',
    notes: doc.notes ?? [],
    promoted: doc.promoted ?? [],
  })
  return doc
}

/** 列出全部会话笔记文件（按修改时间倒序）。 */
export async function listSessionNotes(home) {
  const dir = metaPath(home, 'sessions')
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    // 文件名本身也必须是安全会话 id；否则不把它当成可操作的数据文件。
    const fileId = basename(file, '.json')
    if (!isSessionId(fileId)) continue
    const path = join(dir, file)
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const doc = JSON.parse(raw)
      // JSON 里的 sessionId 可能被手工改成 `../x`：只有合法的才采信，否则用文件名。
      const sessionId = isSessionId(doc.sessionId) ? doc.sessionId : fileId
      out.push({
        sessionId,
        workspace: typeof doc.workspace === 'string' ? doc.workspace : '',
        notes: Array.isArray(doc.notes) ? doc.notes : [],
        promoted: Array.isArray(doc.promoted) ? doc.promoted : [],
        mtime: info.mtimeMs,
      })
    } catch {
      // 坏文件跳过（设置页只需要能看的）
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/* ────────────────────────────── 收件箱 ────────────────────────────── */

/** 写一条收件箱提议。 */
export async function writeInboxItem(home, proposal) {
  await writeJson(inboxPath(home, proposal.id), proposal)
  return proposal
}

/** 列出收件箱（按时间正序）。 */
export async function listInbox(home) {
  const dir = metaPath(home, 'inbox')
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    if (!isInboxId(basename(file, '.json'))) continue
    try {
      out.push(JSON.parse(await readFile(join(dir, file), 'utf8')))
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** 读一条收件箱提议。 */
export async function readInboxItem(home, id) {
  return readJson(inboxPath(home, id), null)
}

/** 删一条收件箱提议（批准/拒绝后）。 */
export async function removeInboxItem(home, id) {
  try {
    await unlink(inboxPath(home, id))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** 决定记录（含正文，给用户复核）最多留多少条；更久的元信息仍在 decisions.jsonl 里。 */
const MAX_INBOX_DECISIONS = 1000

/**
 * 把一条收件箱决定（批准/拒绝、谁做的、为什么）留档到 `inbox/decided/`。
 * 提议本身会被删掉，审计记录保留；裁剪失败不影响主流程。
 * @param {string} home - 记忆根目录。
 * @param {object} record - {id, decision, by, reason, proposal}。
 * @returns {Promise<string>} 决定记录路径。
 */
export async function writeInboxDecision(home, record) {
  const path = inboxDecisionPath(home, record.id)
  const doc = {
    id: record.id,
    decidedAt: record.decidedAt ?? new Date().toISOString(),
    decision: record.decision,
    by: record.by ?? 'user',
    ...(typeof record.runId === 'string' && record.runId ? { runId: record.runId } : {}),
    reason: String(record.reason ?? '').slice(0, 500),
    proposal: record.proposal ?? null,
  }
  // append-only 决定日志：不裁剪、不含正文，用来长期复盘「AI/用户批准或拒绝了什么、为什么」。
  // 放在 decided 文件之前、独立 try —— decided 写失败时至少还有这一行审计。
  try {
    const logPath = metaPath(home, 'inbox/decisions.jsonl')
    await ensureDir(dirname(logPath))
    const proposal = record.proposal && typeof record.proposal === 'object' ? record.proposal : null
    const line = `${JSON.stringify({
      id: doc.id,
      at: doc.decidedAt,
      decision: doc.decision,
      by: doc.by,
      ...(doc.runId ? { runId: doc.runId } : {}),
      scope: proposal && typeof proposal.scope === 'string' ? proposal.scope : null,
      name: proposal && typeof proposal.name === 'string' ? proposal.name : null,
      kind: proposal && typeof proposal.kind === 'string' ? proposal.kind : null,
      reason: doc.reason,
    })}\n`
    const handle = await open(logPath, 'a', 0o600)
    try {
      await handle.write(line)
    } finally {
      await handle.close()
    }
    await chmod(logPath, 0o600).catch(() => {})
  } catch {
    // 决定日志失败不影响主流程
  }
  await writeJson(path, doc)
  try {
    const dir = dirname(path)
    const files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
    if (files.length > MAX_INBOX_DECISIONS) {
      const listed = await Promise.all(files.map(async (file) => {
        const full = join(dir, file)
        const info = await stat(full)
        return { full, mtime: info.mtimeMs }
      }))
      listed.sort((a, b) => a.mtime - b.mtime)
      for (const file of listed.slice(0, listed.length - MAX_INBOX_DECISIONS)) {
        await unlink(file.full).catch(() => {})
      }
    }
  } catch {
    // 审计裁剪失败不影响写入结果
  }
  return path
}

/* ────────────────────────────── 文件锁 ────────────────────────────── */

/**
 * 抢整理锁（`<home>/.lock`，带 pid 和过期时间）。
 * @param {string} home - 记忆根目录。
 * @param {{ttlMs?: number, now?: number}} [options] - 过期时间。
 * @returns {Promise<{ok: boolean, lock?: object, owner?: object}>} 抢锁结果。
 */
export async function acquireLock(home, options = {}) {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000
  const now = options.now ?? Date.now()
  const path = metaPath(home, 'lock')
  const payload = { pid: process.pid, at: new Date(now).toISOString(), expiresAt: now + ttlMs }
  await ensureDir(home)
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.write(JSON.stringify(payload))
    } finally {
      await handle.close()
    }
    return { ok: true, lock: payload }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const current = await readJson(path, null)
    if (current && typeof current.expiresAt === 'number' && current.expiresAt > now) {
      return { ok: false, owner: current }
    }
    // 过期锁：删掉重抢（这里容忍竞态，抢不到就返回 false）
    try {
      await unlink(path)
      return await acquireLock(home, options)
    } catch {
      return { ok: false, owner: current }
    }
  }
}

/** 释放整理锁（只删自己的）。 */
export async function releaseLock(home) {
  const path = metaPath(home, 'lock')
  const current = await readJson(path, null)
  if (current && current.pid !== process.pid) return
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/* ────────────────────────────── 运行记录 ────────────────────────────── */

/** 读运行记录（runId → 状态）。 */
export async function readRuns(home) {
  const doc = await readJson(metaPath(home, 'runs'), null)
  if (!doc || typeof doc !== 'object') return {}
  return doc
}

/** 写运行记录，最多保留 20 条。 */
export async function writeRuns(home, runs) {
  const entries = Object.entries(runs)
    .sort((a, b) => String(b[1]?.startedAt ?? '').localeCompare(String(a[1]?.startedAt ?? '')))
    .slice(0, 20)
  await writeJson(metaPath(home, 'runs'), Object.fromEntries(entries))
}

/* ────────────────────────────── 概览辅助 ────────────────────────────── */

/** 统计一个作用域的字符预算（供概览显示）。 */
export function charCount(text) {
  return typeof text === 'string' ? [...text].length : 0
}

/** 条目正文的字符数。 */
export function bodyChars(body) {
  return charCount(body)
}

/** 描述截断到上限。 */
export function clampDescription(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim()
  if ([...text].length <= MAX_DESCRIPTION_CHARS) return text
  return `${[...text].slice(0, MAX_DESCRIPTION_CHARS - 1).join('')}…`
}

/** 校验正文大小。 */
export function assertBodySize(body) {
  const bytes = Buffer.byteLength(String(body ?? ''), 'utf8')
  if (bytes > MAX_BODY_BYTES) {
    const error = new Error(`正文太长：${bytes} 字节 > ${MAX_BODY_BYTES} 字节。记结论，别记流水账。`)
    error.code = 'body-too-large'
    throw error
  }
}

/** 校验 tags 并归一（写入口用）。 */
export function validateTags(tags, tagsDoc) {
  const normalized = normalizeTagList(assertTags(tags), tagsDoc)
  return assertTags(normalized)
}

/** 把未知标签加进词表。 */
export async function learnTags(home, tags) {
  const doc = await readTags(home)
  let changed = false
  for (const tag of tags) {
    if (!doc.tags[tag]) {
      doc.tags[tag] = {}
      changed = true
    }
  }
  if (changed) await writeTags(home, doc)
  return doc
}
