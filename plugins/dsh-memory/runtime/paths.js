/**
 * `@local/dsh-memory` 的路径与命名规则。
 *
 * 所有「客户端/模型传什么」的校验都集中在这里：
 *   - 条目名是身份键，只能是 `^[a-z0-9][a-z0-9-]{0,63}$`；
 *   - 作用域只有 `global` 与 `workspaces/<ws-key>` 两种；
 *   - 任何参数都不会被当成路径拼接（标签名先编码成文件名，名字先过白名单）。
 *
 * `workspaceKey` 是 `dsh-session-persistence-jsonl` 里 projectKey 的**逐字复制**，
 * 这样记忆目录和工作区会话目录用同一个 key（`/home/alice/project` →
 * `--home-alice-project--`），用户看到的两处目录名一致。
 *
 * @module @local/dsh-memory/paths
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 默认数据目录。 */
export const DEFAULT_HOME = '~/.dsh/memory'

/** 条目名白名单：也会被当作文件名使用。 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 工作区 key：与 DSH 会话目录名同构的单段名字，并**显式排除 `.` / `..`**。
 * `workspaces/..` / `workspaces/.` 曾经能通过旧的 SCOPE_RE，拼出 home 之外的路径。
 */
export const WORKSPACE_KEY_RE = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,255}$/

/** 作用域字符串：global 或 workspaces/<合法 key>。 */
export const SCOPE_RE = /^(?:global|workspaces\/(?!\.{1,2}$)[A-Za-z0-9._~-]{1,255})$/

/** 会话笔记文件名（不含 `.json`）：同样排除 `.` / `..`。 */
export const SESSION_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,200}$/

/** 收件箱提议 id：用于文件名，同样排除 `.` / `..`。 */
export const INBOX_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,200}$/

/** 条目类型。 */
export const TYPES = ['user', 'feedback', 'project', 'reference']

/** 会话笔记类型。 */
export const NOTE_KINDS = ['constraint', 'decision', 'fact', 'todo']

/** 正文字节上限（8 KB）。 */
export const MAX_BODY_BYTES = 8 * 1024

/** 会话笔记总字符上限。 */
export const MAX_SESSION_NOTES_CHARS = 4000

/** description 的字符上限。 */
export const MAX_DESCRIPTION_CHARS = 120

/* ────────────────────────────── 数据目录 ────────────────────────────── */

/** 展开 `~` / `~/` 前缀。 */
export function expandHomePath(path) {
  if (typeof path !== 'string') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 解析数据根目录。优先级：config.home > $DSH_MEMORY_HOME > ~/.dsh/memory。
 * @param {object} config - 插件配置。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源（测试注入）。
 * @returns {string} 绝对路径。
 */
export function resolveMemoryHome(config = {}, env = process.env) {
  const configured = typeof config.home === 'string' && config.home.trim() ? config.home.trim() : ''
  const fromEnv = typeof env.DSH_MEMORY_HOME === 'string' && env.DSH_MEMORY_HOME.trim()
    ? env.DSH_MEMORY_HOME.trim()
    : ''
  return resolve(expandHomePath(configured || fromEnv || DEFAULT_HOME))
}

/**
 * 把会话工作目录编码成项目目录名。
 *
 * 逐字复制自 `@deepseek-ai/dsh-session-persistence-jsonl` 的 projectKey：
 * 分隔符折叠成 `-`，不安全码元写成 `~XXXX`，首尾 `--` 包裹，最长 251。
 * @param {string} cwd - 会话的项目目录。
 * @returns {string} 例如 `/home/alice/project` → `--home-alice-project--`。
 */
export function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/* ────────────────────────────── 校验 ────────────────────────────── */

/** 带 code 的错误（API 层据此映射状态码）。 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 判断一个工作区 key 是否合法（单段、非 `.`/`..`）。
 * @param {unknown} value - 候选 key。
 * @returns {boolean} 是否合法。
 */
export function isWorkspaceKey(value) {
  return typeof value === 'string' && WORKSPACE_KEY_RE.test(value)
}

/**
 * 断言作用域合法。所有拼路径的底层函数都必须先过这一关。
 * @param {unknown} scope - 候选作用域。
 * @returns {string} 原作用域。
 * @throws {Error} code=invalid-scope。
 */
export function assertScope(scope) {
  if (!isScope(scope)) {
    throw codedError('invalid-scope', `作用域不合法：${JSON.stringify(scope)}（只能是 global 或 workspaces/<key>）`)
  }
  return scope
}

/**
 * 判断会话 id 能否安全用作文件名。
 * @param {unknown} value - 候选会话 id。
 * @returns {boolean} 是否合法。
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/**
 * 断言会话 id 能安全用作文件名。
 * @param {unknown} id - 候选会话 id。
 * @returns {string} 原 id。
 * @throws {Error} code=invalid-session-id。
 */
export function assertSessionId(id) {
  if (!isSessionId(id)) {
    throw codedError('invalid-session-id', `会话 id 不能用作文件名：${JSON.stringify(id)}`)
  }
  return id
}

/** 判断收件箱 id 是否安全。 */
export function isInboxId(value) {
  return typeof value === 'string' && INBOX_ID_RE.test(value)
}

/**
 * 断言收件箱 id 安全。
 * @param {unknown} id - 候选 id。
 * @returns {string} 原 id。
 * @throws {Error} code=invalid-id。
 */
export function assertInboxId(id) {
  if (!isInboxId(id)) throw codedError('invalid-id', `收件箱 id 非法：${JSON.stringify(id)}`)
  return id
}

/**
 * 断言目标路径仍在记忆根目录之内（纵深防御的最后一道）。
 *
 * 只做**词法**判断：`resolve` 之后用 `path.relative` 看是否越界。
 * 不解析符号链接 —— 数据目录由用户自己指定，插件不引入新的链接。
 * @param {string} home - 记忆根目录。
 * @param {string} target - 拼好的绝对/相对目标。
 * @param {string} [label] - 报错里的人类可读名字。
 * @returns {string} resolve 后的绝对路径。
 * @throws {Error} code=invalid-path。
 */
export function assertInside(home, target, label = '路径') {
  if (typeof home !== 'string' || home.length === 0) throw codedError('invalid-path', '记忆根目录不合法')
  const base = resolve(home)
  const full = resolve(target)
  const rel = relative(base, full)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw codedError('invalid-path', `${label}越出了记忆目录：${full}`)
  }
  return full
}

/**
 * 校验条目名。
 * @param {unknown} name - 候选身份键。
 * @returns {string} 合法名字。
 * @throws {Error} 名字非法（带 code=invalid-name）。
 */
export function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    const error = new Error(
      `记忆名不合法：${JSON.stringify(name)}。只能是小写字母、数字和连字符，以字母或数字开头，最长 64。`,
    )
    error.code = 'invalid-name'
    throw error
  }
  return name
}

/** 名字是否合法（不抛错）。 */
export function isName(value) {
  return typeof value === 'string' && NAME_RE.test(value)
}

/**
 * 归一作用域：接受 `global` / `workspace` / `workspaces/<key>`。
 * @param {unknown} input - 客户端或模型给的作用域。
 * @param {{wsKey: string, fallback?: 'global'|'workspace'}} options - 当前会话的工作区 key。
 * @returns {string} 规整后的作用域字符串。
 */
export function normalizeScope(input, { wsKey, fallback = 'workspace' }) {
  if (!isWorkspaceKey(wsKey)) {
    throw codedError('invalid-scope', `当前工作区 key 不合法：${JSON.stringify(wsKey)}`)
  }
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === 'global') return 'global'
  if (raw === 'workspace' || raw === '') return `workspaces/${wsKey}`
  if (raw.startsWith('workspaces/')) {
    const key = raw.slice('workspaces/'.length)
    // 显式传了 workspaces/... 但 key 非法（`.`、`..`、多段、URL 编码残留）时
    // **不**拼进路径：回落到当前工作区，绝不让调用方借此指定任意目录。
    if (isWorkspaceKey(key)) return `workspaces/${key}`
  }
  if (fallback === 'global') return 'global'
  return `workspaces/${wsKey}`
}

/**
 * 判断一个作用域字符串是否合法。
 * @param {unknown} scope - 候选作用域。
 * @returns {boolean} 是否合法。
 */
export function isScope(scope) {
  return typeof scope === 'string' && SCOPE_RE.test(scope)
}

/**
 * 校验标签：1～3 个、非空、最长 32 字符、不含控制字符。
 * @param {unknown} tags - 候选标签数组。
 * @returns {string[]} 去重后的标签数组。
 * @throws {Error} 标签非法（code=invalid-tags）。
 */
export function assertTags(tags) {
  if (!Array.isArray(tags)) {
    const error = new Error('tags 必须是字符串数组（1～3 个）')
    error.code = 'invalid-tags'
    throw error
  }
  const cleaned = []
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      const error = new Error('标签必须是字符串')
      error.code = 'invalid-tags'
      throw error
    }
    const value = tag.trim()
    if (!value || value.length > 32 || /[\u0000-\u001f\u007f]/.test(value)) {
      const error = new Error(`标签不合法：${JSON.stringify(tag)}（1～32 字符）`)
      error.code = 'invalid-tags'
      throw error
    }
    if (!cleaned.includes(value)) cleaned.push(value)
  }
  if (cleaned.length < 1 || cleaned.length > 3) {
    const error = new Error(`标签数量必须是 1～3 个（当前 ${cleaned.length}）`)
    error.code = 'invalid-tags'
    throw error
  }
  return cleaned
}

/**
 * 把一个标签编码成安全的单段文件名（`_topics/<file>.md`）。
 * 中文等非 ASCII 字符保留（Linux 文件名没问题），只替换路径分隔符、
 * 控制字符、`.`/`..` 和首尾的空白/点。
 * @param {string} tag - 标签原文。
 * @returns {string} 文件名主干。
 */
export function tagFileKey(tag) {
  const value = String(tag).trim()
  const escaped = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  const trimmed = escaped.replace(/^[.\s]+|[.\s]+$/g, '') || 'tag'
  if (trimmed.length <= 80) return trimmed
  return `${trimmed.slice(0, 60)}-${createHash('sha1').update(value).digest('hex').slice(0, 8)}`
}

/* ────────────────────────────── 文件布局 ────────────────────────────── */

/** 记忆目录里的相对路径（全部相对 home）。 */
export const LAYOUT = {
  global: 'global',
  workspaces: 'workspaces',
  sessions: 'sessions',
  archive: 'archive',
  inbox: 'inbox',
  stats: 'stats.json',
  tags: 'tags.json',
  journal: 'journal.jsonl',
  settings: 'settings.json',
  runs: 'runs.json',
  lock: '.lock',
}

/** 生成物名字（不当作条目）。 */
export const GENERATED_MEMORY_FILE = 'MEMORY.md'
export const TOPICS_DIR = '_topics'

/**
 * 作用域 → 目录名（相对 home）。
 * 先断言作用域，再拼路径 —— 这里不允许任何调用方跳过校验。
 * @param {string} scope - 作用域。
 * @returns {string} 相对 home 的目录名。
 */
export function scopeDir(scope) {
  assertScope(scope)
  if (scope === 'global') return LAYOUT.global
  return join(LAYOUT.workspaces, scope.slice('workspaces/'.length))
}

/**
 * 条目文件绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function itemPath(home, scope, name) {
  const target = join(home, scopeDir(scope), `${assertName(name)}.md`)
  return assertInside(home, target, '条目路径')
}

/**
 * 作用域索引文件绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function memoryIndexPath(home, scope) {
  return assertInside(home, join(home, scopeDir(scope), GENERATED_MEMORY_FILE), '索引路径')
}

/**
 * 主题页绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} tag - 标签（文件名会编码）。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function topicPath(home, scope, tag) {
  return assertInside(home, join(home, scopeDir(scope), TOPICS_DIR, `${tagFileKey(tag)}.md`), '主题页路径')
}

/**
 * 主题页目录绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function topicsDir(home, scope) {
  return assertInside(home, join(home, scopeDir(scope), TOPICS_DIR), '主题页目录')
}

/**
 * 归档文件绝对路径。`stamp` 用于同名重复归档时避免覆盖。
 * @param {string} home - 记忆根目录。
 * @param {string} scope - 作用域。
 * @param {string} name - 条目名。
 * @param {string} [stamp] - 内部生成的时间戳后缀。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function archivePath(home, scope, name, stamp) {
  if (stamp !== undefined && (typeof stamp !== 'string' || !/^[A-Za-z0-9._~-]{1,80}$/.test(stamp))) {
    throw codedError('invalid-path', `归档时间戳不合法：${JSON.stringify(stamp)}`)
  }
  const file = stamp ? `${assertName(name)}.${stamp}.md` : `${assertName(name)}.md`
  return assertInside(home, join(home, LAYOUT.archive, scopeDir(scope), file), '归档路径')
}

/**
 * 会话笔记文件绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function sessionNotesPath(home, sessionId) {
  assertSessionId(sessionId)
  return assertInside(home, join(home, LAYOUT.sessions, `${sessionId}.json`), '会话笔记路径')
}

/**
 * 收件箱文件绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} id - 提议 id。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function inboxPath(home, id) {
  assertInboxId(id)
  return assertInside(home, join(home, LAYOUT.inbox, `${id}.json`), '收件箱路径')
}

/** 收件箱决定记录的子目录（审计用，不参与待审批列表）。 */
export const INBOX_DECIDED_DIR = 'decided'

/**
 * 收件箱决定记录的绝对路径（批准/拒绝后留档，方便事后核对 AI 或用户的决定）。
 * @param {string} home - 记忆根目录。
 * @param {string} id - 提议 id。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function inboxDecisionPath(home, id) {
  assertInboxId(id)
  return assertInside(home, join(home, LAYOUT.inbox, INBOX_DECIDED_DIR, `${id}.json`), '收件箱决定路径')
}

/**
 * 各类 sidecar / 动态数据文件的绝对路径。
 * @param {string} home - 记忆根目录。
 * @param {string} key - LAYOUT 里的键，或 `inbox/<id>.json` 这样的相对路径。
 * @returns {string} 绝对路径（断言仍在 home 内）。
 */
export function metaPath(home, key) {
  const relativeKey = LAYOUT[key] ?? key
  if (typeof relativeKey !== 'string' || relativeKey.length === 0 || isAbsolute(relativeKey)) {
    throw codedError('invalid-path', `数据文件 key 不合法：${JSON.stringify(key)}`)
  }
  return assertInside(home, join(home, relativeKey), '数据文件路径')
}

/** 条目 key（`scope/name`），也是 stats 的 items 键和图谱节点 id。 */
export function itemKey(scope, name) {
  return `${assertScope(scope)}/${assertName(name)}`
}

/** 从条目 key 拆回 scope 与 name。 */
export function parseItemKey(key) {
  const index = String(key).indexOf('/')
  if (index < 0) return null
  const scope = key.slice(0, index)
  const name = key.slice(index + 1)
  if (!isScope(scope) || !isName(name)) return null
  return { scope, name }
}
