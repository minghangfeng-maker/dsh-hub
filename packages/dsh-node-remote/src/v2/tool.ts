/**
 * 工具卡投影（契约 §7.2）：把 DSH 的工具名与参数/结果压成手机能显示的一小段摘要。
 *
 * 三条纪律：
 * 1. **白名单**：只有这里列出的工具名有专门 `kind`，其余一律 `other`（不把 DSH 的
 *    原始工具名当 UI 分类，也避免工具改名把 UI 打裂）。
 * 2. **只给摘要**：预览 ≤ 4096 UTF-8 字节，超出按码点截断并标 `truncated`。
 * 3. **绝不转发**：spill 路径、`replayState`、compact `stream`、工具 schema、`meta` 内部结构。
 */
import { extractPathCandidates, redactSpill, truncateUtf8, utf8Bytes } from './text.js'

/** 契约 §7.2 的 `kind` 枚举。 */
export type ToolKind =
  | 'bash'
  | 'python'
  | 'search'
  | 'fetch'
  | 'file-read'
  | 'file-write'
  | 'present'
  | 'question'
  | 'agent'
  | 'other'

/** 预览截断上限（契约 §7.2 规则 1）。 */
export const TOOL_PREVIEW_BYTES = 4096

interface ToolSpec {
  kind: ToolKind
  title: string
}

/** 工具名 → (kind, 人话标题)。`*` 结尾表示前缀匹配（`subagent*`）。 */
const TOOL_SPECS: ReadonlyArray<readonly [string, ToolSpec]> = [
  ['bash', { kind: 'bash', title: '运行命令' }],
  ['shell', { kind: 'bash', title: '运行命令' }],
  ['terminal', { kind: 'bash', title: '运行命令' }],
  ['python', { kind: 'python', title: '运行 Python' }],
  ['ptc', { kind: 'python', title: '运行 Python' }],
  ['ipython', { kind: 'python', title: '运行 Python' }],
  ['web_search', { kind: 'search', title: '搜索网页' }],
  ['search', { kind: 'search', title: '搜索网页' }],
  ['web_fetch', { kind: 'fetch', title: '打开网页' }],
  ['fetch', { kind: 'fetch', title: '打开网页' }],
  ['read', { kind: 'file-read', title: '读取文件' }],
  ['read_image', { kind: 'file-read', title: '查看图片' }],
  ['glob', { kind: 'file-read', title: '查找文件' }],
  ['grep', { kind: 'file-read', title: '搜索文件内容' }],
  ['ls', { kind: 'file-read', title: '列目录' }],
  ['write', { kind: 'file-write', title: '写文件' }],
  ['edit', { kind: 'file-write', title: '修改文件' }],
  ['present', { kind: 'present', title: '交付文件' }],
  ['ask_user_question', { kind: 'question', title: '向你提问' }],
  ['question', { kind: 'question', title: '向你提问' }],
  ['subagent*', { kind: 'agent', title: '委派子任务' }],
  ['workflow', { kind: 'agent', title: '编排子任务' }],
  ['skill', { kind: 'agent', title: '调用技能' }],
]

/** 工具名 → 白名单种类；未知工具是 `other`，标题用原始工具名兜底。 */
export function classifyTool(name: string): ToolSpec {
  for (const [pattern, spec] of TOOL_SPECS) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return spec
      continue
    }
    if (name === pattern) return spec
  }
  return { kind: 'other', title: name.length > 0 ? name : '工具' }
}

/** 安全 JSON 解析（模型给的 arguments 是字符串，可能被截断/非法）。 */
function parseArguments(argumentsJson: string | undefined): Record<string, unknown> | null {
  if (argumentsJson === undefined || argumentsJson === '') return null
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return (index < 0 ? text : text.slice(0, index)).trim()
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export interface ToolCallProjection {
  kind: ToolKind
  title: string
  inputPreview?: string
  inputBytes?: number
  truncatedInput: boolean
}

/**
 * 工具开始：`arguments` 是**模型原始 JSON 字符串**（未解析），失败时只做字符串兜底。
 *
 * 预览按「人读得懂的那一句」取：bash 取 `description` + 命令首行，python 取代码首行，
 * 搜索取查询词，文件类取路径，其余取参数 JSON 前 4 KiB。
 */
export function projectToolCall(name: string, argumentsJson: string | undefined): ToolCallProjection {
  const spec = classifyTool(name)
  const args = parseArguments(argumentsJson)
  const raw = argumentsJson ?? ''
  const inputBytes = utf8Bytes(raw)
  let preview: string | null = null
  switch (spec.kind) {
    case 'bash': {
      const description = stringField(args, 'description')
      const command = stringField(args, 'command') ?? stringField(args, 'script')
      const parts = [description, command === null ? null : firstLine(command)].filter(
        (part): part is string => part !== null && part !== '',
      )
      preview = parts.length > 0 ? parts.join(' · ') : raw
      break
    }
    case 'python': {
      const code = stringField(args, 'code') ?? stringField(args, 'source')
      preview = code === null ? raw : firstLine(code)
      break
    }
    case 'search': {
      const queries = args?.['queries']
      if (Array.isArray(queries)) {
        preview = queries.filter((item): item is string => typeof item === 'string').join('、')
      }
      if (preview === null || preview === '') preview = stringField(args, 'query') ?? raw
      break
    }
    case 'fetch':
      preview = stringField(args, 'url') ?? raw
      break
    case 'file-read':
    case 'file-write': {
      preview =
        stringField(args, 'file_path') ?? stringField(args, 'path') ?? stringField(args, 'pattern') ?? raw
      break
    }
    case 'present': {
      const files = args?.['files']
      if (Array.isArray(files)) {
        const names = files.flatMap((item) => {
          const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
          const path = typeof record['path'] === 'string' ? record['path'] : null
          if (path === null) return []
          const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
          return [cut < 0 ? path : path.slice(cut + 1)]
        })
        preview = `${String(names.length)} 个文件：${names.join('、')}`
      }
      if (preview === null || preview === '') preview = raw
      break
    }
    case 'question': {
      const questions = args?.['questions']
      preview = Array.isArray(questions) ? `${String(questions.length)} 个问题` : raw
      break
    }
    case 'agent':
      preview =
        stringField(args, 'description') ?? stringField(args, 'prompt') ?? stringField(args, 'name') ?? raw
      break
    case 'other':
      preview = raw
      break
  }
  const cleaned = redactSpill(preview ?? '')
  if (cleaned === '') return { kind: spec.kind, title: spec.title, truncatedInput: false }
  const cut = truncateUtf8(cleaned, TOOL_PREVIEW_BYTES)
  return {
    kind: spec.kind,
    title: spec.title,
    inputPreview: cut.text,
    inputBytes,
    truncatedInput: cut.truncated,
  }
}

export interface ToolResultProjection {
  outputPreview?: string
  outputBytes?: number
  truncatedOutput: boolean
  citations?: { title?: string; url: string }[]
  /** 从结果正文里抽到的候选产出文件（还需要 stat + 包含检查才算数）。 */
  pathCandidates: string[]
}

/** 工具结束：正文来自 `tool/result.data.message.content[].text` 的拼接（已由调用方拼好）。 */
export function projectToolResult(name: string, text: string, maxCitations = 5): ToolResultProjection {
  const spec = classifyTool(name)
  const outputBytes = utf8Bytes(text)
  const pathCandidates = spec.kind === 'other' || spec.kind === 'search' ? [] : extractPathCandidates(text)
  const citations = spec.kind === 'search' ? extractCitations(text, maxCitations) : undefined
  const redacted = redactSpill(text).trim()
  if (redacted === '') {
    return {
      outputBytes,
      truncatedOutput: false,
      pathCandidates,
      ...(citations === undefined ? {} : { citations }),
    }
  }
  // `write`/`edit` 的结果对手机没有阅读价值（路径已经在 files[] 里）
  if (spec.kind === 'file-write' || spec.kind === 'question' || spec.kind === 'agent') {
    return {
      outputBytes,
      truncatedOutput: false,
      pathCandidates,
      ...(citations === undefined ? {} : { citations }),
    }
  }
  const cut = truncateUtf8(redacted, TOOL_PREVIEW_BYTES)
  return {
    outputPreview: cut.text,
    outputBytes,
    truncatedOutput: cut.truncated,
    pathCandidates,
    ...(citations === undefined ? {} : { citations }),
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>()\]]{4,2048}/gu

/**
 * Markdown 链接 `[标题](url)`（标题里可以有中文/空格，但不能有 `]`；url 到 `)` 为止）。
 *
 * 只认 `http(s)`：`[设置](/settings)` 这类站内链接不是引用来源，不能进 citations。
 */
const MARKDOWN_LINK_IN_TEXT = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{4,2048})\)/gu

/**
 * 搜索引用来源。
 *
 * **已核实**（WP40 集成联调，2026-10-25）：成功的 `web_search` 结果正文是**Markdown**，
 * 形状固定为（来源是 DSH 的 `dsh-tool-web` 的 `formatSearchOutput`）：
 *
 * ```text
 * <外部内容提示>
 *
 * Sources:
 * - [标题](https://example.com/a) — 摘要 (2026-10-25)
 * - [标题2](https://example.com/b)
 *
 * Cite the relevant URLs above as markdown links in your answer.
 * ```
 *
 * 所以三种来源按优先级解析，先命中先用：
 * 1. 正文是 JSON 且带 `sources`/`results`/`citations` 数组 → `url` + `title`；
 * 2. Markdown 链接 `[标题](url)` → `url` + `title`（**这是真实形状**，标题只能从这里拿到）；
 * 3. 兜底：正则抓前 N 个 http(s) 链接（title 留空）。
 */
export function extractCitations(text: string, limit = 5): { title?: string; url: string }[] | undefined {
  const out: { title?: string; url: string }[] = []
  const seen = new Set<string>()
  const push = (url: string, title?: string): void => {
    if (seen.has(url) || out.length >= limit) return
    seen.add(url)
    out.push({
      ...(title === undefined || title === '' ? {} : { title: title.slice(0, 200) }),
      url: url.slice(0, 2048),
    })
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const containers = Array.isArray(parsed)
        ? [parsed]
        : ['sources', 'results', 'citations'].map((key) =>
            typeof (parsed as Record<string, unknown>)[key] === 'object'
              ? (parsed as Record<string, unknown>)[key]
              : null,
          )
      for (const container of containers) {
        if (!Array.isArray(container)) continue
        for (const item of container) {
          const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null
          const url = typeof record?.['url'] === 'string' ? record['url'] : null
          if (url === null) continue
          const title = typeof record?.['title'] === 'string' ? record['title'] : undefined
          push(url, title)
        }
      }
    } catch {
      // 不是 JSON：退回正则
    }
  }
  if (out.length === 0) {
    // 真实形状：`- [标题](url) — 摘要 (日期)`。链接文字就是标题，别丢。
    for (const match of text.matchAll(MARKDOWN_LINK_IN_TEXT)) {
      push(match[2] ?? '', match[1])
      if (out.length >= limit) break
    }
  }
  if (out.length === 0) {
    for (const match of text.matchAll(URL_IN_TEXT)) {
      push(match[0])
      if (out.length >= limit) break
    }
  }
  return out.length === 0 ? undefined : out
}
