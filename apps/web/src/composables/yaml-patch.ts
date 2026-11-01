/**
 * 插件 `configYaml` 的前端校验与渲染预览（04 §4.5：服务端会做 YAML 语法 + 结构校验，必须是 patch 条目数组）。
 *
 * 这里不引 YAML 库（07 §1 不引大依赖），只做**行级结构检查**，覆盖最常见的四类错误并给出行号：
 * Tab 缩进、顶层不是 `- ` 数组、条目缺 `id:`、id 重复；右侧渲染预览直接把条目按 Hub 的注入格式展示。
 * 真正的 YAML 语法校验仍以服务端为准（错误会通过 `VALIDATION_FAILED` 回显）。
 */

export type YamlSeverity = 'error' | 'warning'

export interface YamlIssue {
  /** 1 基行号（0 表示整段） */
  line: number
  message: string
  severity: YamlSeverity
}

export interface PatchEntry {
  id: string | null
  /** `- ` 所在行（1 基） */
  line: number
  /** 条目原文（含起始行到下一个条目之前） */
  lines: string[]
}

export interface PatchCheckResult {
  ok: boolean
  issues: YamlIssue[]
  entries: PatchEntry[]
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/

function indentationOf(line: string): { indent: number; rest: string; tabbed: boolean } {
  const match = /^[ \t]*/.exec(line)
  const prefix = match?.[0] ?? ''
  return {
    indent: prefix.replace(/\t/g, '  ').length,
    rest: line.slice(prefix.length),
    tabbed: prefix.includes('\t'),
  }
}

function countChar(text: string, char: string): number {
  let count = 0
  for (const item of text) if (item === char) count += 1
  return count
}

/** 校验插件配置片段（patch 条目数组）。 */
export function checkPatchYaml(text: string): PatchCheckResult {
  const issues: YamlIssue[] = []
  const entries: PatchEntry[] = []

  if (!text.trim()) return { ok: true, issues, entries }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let current: PatchEntry | null = null

  lines.forEach((line, index) => {
    const lineNo = index + 1
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const { indent, rest, tabbed } = indentationOf(line)
    if (tabbed) {
      issues.push({ line: lineNo, message: '缩进不能用 Tab，请改成空格', severity: 'error' })
    }

    if (indent === 0) {
      const item = /^-\s*(.*)$/.exec(rest)
      if (!item) {
        issues.push({
          line: lineNo,
          message: '顶层必须是 patch 条目数组：每一项以 “- ” 开头',
          severity: 'error',
        })
        current = null
        return
      }

      current = { id: null, line: lineNo, lines: [line.trimEnd()] }
      entries.push(current)

      const inline = (item[1] ?? '').trim()
      if (!inline) return

      const key = KEY_LINE.exec(inline)
      if (!key) {
        issues.push({
          line: lineNo,
          message: '“- ” 后面要跟键值对，例如 “- id: dsh-email”',
          severity: 'error',
        })
        return
      }
      if (key[1] !== 'id') {
        issues.push({
          line: lineNo,
          message: `条目的第一个键必须是 id，当前是 “${key[1]}”`,
          severity: 'error',
        })
        return
      }
      const value = (key[2] ?? '').trim()
      if (!value) issues.push({ line: lineNo, message: 'id 不能为空', severity: 'error' })
      else current.id = value.replace(/^['"]|['"]$/g, '')
      return
    }

    // 缩进行：必须属于某个条目
    if (!current) {
      issues.push({ line: lineNo, message: '缩进的内容必须属于某个 “- ” 条目', severity: 'error' })
      return
    }

    current.lines.push(line.trimEnd())

    if (indent % 2 !== 0) {
      issues.push({ line: lineNo, message: '建议用 2 个空格递进（当前缩进是奇数）', severity: 'warning' })
    }

    const key = KEY_LINE.exec(rest)
    if (key && indent === 2 && key[1] === 'id' && current.id === null) {
      const value = (key[2] ?? '').trim()
      if (!value) issues.push({ line: lineNo, message: 'id 不能为空', severity: 'error' })
      else current.id = value.replace(/^['"]|['"]$/g, '')
    }

    if (countChar(rest, '"') % 2 !== 0 || countChar(rest, "'") % 2 !== 0) {
      issues.push({ line: lineNo, message: '引号似乎没有闭合', severity: 'warning' })
    }
  })

  for (const entry of entries) {
    if (!entry.id) {
      issues.push({ line: entry.line, message: '这个条目缺少 id', severity: 'error' })
    }
  }

  // 同 id 重复：06 §4.3 规定后者覆盖前者并给出警告
  const seen = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.id) continue
    const first = seen.get(entry.id)
    if (first !== undefined) {
      issues.push({
        line: entry.line,
        message: `id “${entry.id}” 与第 ${first} 行重复，后者会覆盖前者`,
        severity: 'warning',
      })
    } else {
      seen.set(entry.id, entry.line)
    }
  }

  issues.sort((a, b) => a.line - b.line)
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues, entries }
}

/** 第一条错误（给「跳转/提交前拦截」用）。 */
export function firstErrorIssue(result: PatchCheckResult): YamlIssue | null {
  return result.issues.find((issue) => issue.severity === 'error') ?? null
}

export interface PatchPreviewOptions {
  /** 预览头部（默认说明这是注入 managed.patch.yml 的片段） */
  header?: string[]
  /** 插件包名，注释里带上便于确认 */
  packageName?: string
}

/**
 * 渲染「注入 `managed.patch.yml` 的片段」预览：
 * 头部注释 + 条目原文（保持作者写法，仅去掉行尾空白）。
 * 不会出现在预览里的内容：被注释掉的行、空行会被保留（便于对照行号）。
 */
export function renderPatchPreview(text: string, options: PatchPreviewOptions = {}): string {
  const { entries } = checkPatchYaml(text)
  const header = options.header ?? [
    '# 由 DSH Hub 生成，请勿手改 —— 插件配置片段',
    `# 注入位置：managed.patch.yml 的插件配置区（按 bundle_order 排序）`,
  ]

  const head = [...header]
  if (options.packageName) head.splice(1, 0, `# 插件：${options.packageName}`)

  if (entries.length === 0) return [...head, '# （暂无配置：该插件不输出任何配置条目）'].join('\n')
  return [...head, ...entries.flatMap((entry) => entry.lines)].join('\n')
}
