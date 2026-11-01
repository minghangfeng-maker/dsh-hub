/**
 * 日志面板的纯函数（等宽日志查看器：分行、关键字高亮、命中计数、跟随滚动判定）。
 * 与组件分开是为了能直接单测（任务书：日志查看器的跟随/搜索）。
 */

/** 把一段日志文本切成行数组（去掉末尾空行，保留中间空行）。 */
export function splitLogLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface HighlightPart {
  text: string
  /** 命中关键字（渲染成高亮 <mark>） */
  hit: boolean
}

/**
 * 按关键字切开一行文本（大小写不敏感、字面量匹配，不走正则以免关键字里的 `.*` 出意外）。
 * 关键字为空时整行一个片段。
 */
export function splitHighlight(line: string, keyword: string): HighlightPart[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return [{ text: line, hit: false }]

  const haystack = line.toLowerCase()
  const parts: HighlightPart[] = []
  let cursor = 0

  for (;;) {
    const index = haystack.indexOf(needle, cursor)
    if (index === -1) break
    if (index > cursor) parts.push({ text: line.slice(cursor, index), hit: false })
    parts.push({ text: line.slice(index, index + needle.length), hit: true })
    cursor = index + needle.length
  }

  if (cursor < line.length) parts.push({ text: line.slice(cursor), hit: false })
  return parts.length > 0 ? parts : [{ text: line, hit: false }]
}

/** 命中行号（0 基）列表；关键字为空时返回空数组。 */
export function matchingLineIndexes(lines: readonly string[], keyword: string): number[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []

  const hits: number[] = []
  lines.forEach((line, index) => {
    if (line.toLowerCase().includes(needle)) hits.push(index)
  })
  return hits
}

/** 跟随模式是否该滚到底部：用户手动往上翻了就不再打扰（阈值 24px）。 */
export function shouldStickToBottom(element: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24
}
