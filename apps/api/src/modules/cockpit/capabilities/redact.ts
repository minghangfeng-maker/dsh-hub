import {
  COCKPIT_DATA_MAX_BYTES,
  COCKPIT_REDACT_KEY_PATTERN,
  COCKPIT_REDACT_KEY_WORDS,
  COCKPIT_REDACT_SAFE_KEYS,
  COCKPIT_REDACT_VALUE_RULES,
  COCKPIT_REDACTION_PLACEHOLDER,
} from '@dsh-hub/shared'

/**
 * 能力输出的脱敏（docs/24 I4）。
 *
 * 两层规则，缺一不可：
 *
 * 1. **按键名**：命中 `/(key|token|secret|password|cookie|subscription|credential)/` 或
 *    整词 `authorization|auth|bearer|private|dsn` 的字段一律替换成 `[已隐藏]`，不管值的类型
 *    （整词判定见 `splitKeyWords`：`authHeader` 命中、`authorId` 不命中）。
 *    唯一例外是「纯计数字段」白名单（`COCKPIT_REDACT_SAFE_KEYS`），而且**只有值是 number 或 null
 *    时才放行** —— `{ totalTokens: 'sk-live-…' }` 这种「名字像计数、其实是密钥」的形态照样隐藏。
 * 2. **按值**（WP56e1 加固）：每个字符串值再过一遍 `COCKPIT_REDACT_VALUE_RULES`
 *    （`sk-…`、`Bearer …`、`ghp_…`、JWT、`AKIA…`、URL 里的 `user:pass@`、query 里的 `token=`），
 *    命中即整段或局部替换成 `[已隐藏]`。
 *
 * 为什么两层都要：键名规则拦得住结构化字段，拦不住**自由文本**（日志、错误信息、插件配置、
 * 审计 detail 里被塞进来的 note）；值规则拦得住自由文本，但认不出没有固定形态的口令。
 */
const SAFE_KEYS = new Set<string>(COCKPIT_REDACT_SAFE_KEYS)
/** 键名里出现这些**整词**就脱敏（I4 加固，WP56e1）：`authorization/auth/bearer/private/dsn` */
const SENSITIVE_KEY_WORDS = new Set<string>(COCKPIT_REDACT_KEY_WORDS)

/** 递归深度上限：能力输出偶尔带嵌套结构，超过就整块隐藏（防环 + 防爆栈） */
const MAX_DEPTH = 12

/** 短于此长度的串不可能装下任何一种凭据形态（连 `sk-` + 12 位都不够），直接跳过省一次正则 */
const MIN_REDACTABLE_LENGTH = 8

/**
 * 把键名切成「词」：先按 camelCase / 连续大写拆开，再按非字母数字切开，全部小写。
 *
 * `authHeader` → `[auth, header]`、`x-auth-token` → `[x, auth, token]`、`HTTPServerURL` → `[http, server, url]`、
 * `authorId` → `[author, id]`（`author` 不是敏感词，所以不隐藏）。
 */
export function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0)
}

export function isSensitiveKey(key: string, value: unknown): boolean {
  const byWord = splitKeyWords(key).some((word) => SENSITIVE_KEY_WORDS.has(word))
  if (!byWord && !COCKPIT_REDACT_KEY_PATTERN.test(key)) return false
  if (SAFE_KEYS.has(key.toLowerCase()) && (typeof value === 'number' || value === null)) return false
  return true
}

/**
 * 按值脱敏一个字符串（I4 第二层）。
 *
 * 规则里的正则都是 `g` 正则：`String.prototype.replace` 在全局模式下会先把 `lastIndex` 归零、
 * 结束时也归零，所以这些常量正则可以安全地被反复使用（不需要每次 new 一个）。
 */
export function redactValueText(value: string): string {
  if (value.length < MIN_REDACTABLE_LENGTH) return value
  let out = value
  for (const rule of COCKPIT_REDACT_VALUE_RULES) out = out.replace(rule.pattern, rule.replacement)
  return out
}

/** 深度脱敏：返回**新**对象，不改入参（能力返回的可能是缓存里的引用） */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>())
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null
  // undefined 的键在 JSON 里本来就不存在：保留成 null 会把「可选字段」变成「null 字段」，
  // 落库后再按契约 parse 就会失败（ProposalView.steps[].preview.warnings 就这么踩过）
  if (value === undefined) return undefined
  const type = typeof value
  if (type === 'string') return redactValueText(value as string)
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return value.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[${String(value.length)} 字节]`
  if (depth >= MAX_DEPTH) return COCKPIT_REDACTION_PLACEHOLDER
  const object = value as object
  if (seen.has(object)) return COCKPIT_REDACTION_PLACEHOLDER
  seen.add(object)

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen))
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of value) {
      const name = String(key)
      out[name] = isSensitiveKey(name, item) ? COCKPIT_REDACTION_PLACEHOLDER : walk(item, depth + 1, seen)
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    out[key] = isSensitiveKey(key, item) ? COCKPIT_REDACTION_PLACEHOLDER : walk(item, depth + 1, seen)
  }
  return out
}

/** 截断时给模型的提示（`/ops/call` 的 `hint`） */
export const COCKPIT_TRUNCATE_HINT =
  '输出超过 64 KB 已截断：请加过滤条件（时间范围、pageSize、userId 等）缩小结果，或改用画布卡分页展示'

export interface TruncateResult {
  value: unknown
  truncated: boolean
  hint?: string
}

/**
 * 输出体积上限（docs/24 §3.1：`data` 序列化后 ≤ 64 KB）。
 *
 * 顺序：先砍超长字符串（日志/正文最常见）→ 再按行砍最大的数组（`rows`/`items`）→
 * 都不行就只剩一个预览串。截断后一定带 `truncated=true` 与 `hint`，绝不静默丢数据。
 */
export function truncateResult(result: unknown, maxBytes = COCKPIT_DATA_MAX_BYTES): TruncateResult {
  if (byteSize(result) <= maxBytes) return { value: result, truncated: false }

  const trimmed = trimLongStrings(result, 8_000)
  if (byteSize(trimmed) <= maxBytes) {
    return { value: trimmed, truncated: true, hint: COCKPIT_TRUNCATE_HINT }
  }

  const target = largestArray(trimmed)
  if (target) {
    const rows = target.get()
    let low = 0
    let high = rows.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      target.set(rows.slice(0, mid))
      if (byteSize(trimmed) <= maxBytes) low = mid
      else high = mid - 1
    }
    target.set(rows.slice(0, low))
    if (byteSize(trimmed) <= maxBytes) {
      return {
        value: trimmed,
        truncated: true,
        hint: `${COCKPIT_TRUNCATE_HINT}（已保留前 ${String(low)} 行）`,
      }
    }
  }

  return {
    value: { truncated: true, preview: safeJson(result).slice(0, 2_000) },
    truncated: true,
    hint: COCKPIT_TRUNCATE_HINT,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '[无法序列化]'
  }
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(safeJson(value), 'utf8')
}

/** 把超长字符串砍短（保留开头，末尾加省略号）；递归，不改入参 */
function trimLongStrings(value: unknown, maxChars: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…（已截断）`
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => trimLongStrings(item, maxChars, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = trimLongStrings(item, maxChars, depth + 1)
  }
  return out
}

interface ArrayTarget {
  get(): unknown[]
  set(rows: unknown[]): void
}

/** 找一个可以被按行截断的数组：顶层数组，或顶层对象里最长的数组属性（`rows`/`items` 优先） */
function largestArray(value: unknown): ArrayTarget | null {
  if (Array.isArray(value)) {
    return {
      get: () => value,
      set: (rows) => {
        value.length = 0
        value.push(...rows)
      },
    }
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  let bestKey: string | null = null
  let bestLength = -1
  for (const [key, item] of Object.entries(record)) {
    if (!Array.isArray(item)) continue
    const preferred = key === 'rows' || key === 'items' ? 1 : 0
    const score = preferred * 1_000_000 + item.length
    if (score > bestLength) {
      bestLength = score
      bestKey = key
    }
  }
  if (bestKey === null) return null
  const key = bestKey
  return {
    get: () => record[key] as unknown[],
    set: (rows) => {
      record[key] = rows
    },
  }
}
