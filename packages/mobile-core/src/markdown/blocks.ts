/**
 * 流式 Markdown 分块。
 *
 * 目的：对话流式生成时，一帧只重排「最后一个还没写完的块」，已经闭合的块
 * 直接复用上一次渲染结果（见开发文档 §6.3 第 1 条）。
 *
 * 关键约束：**分块不能改变渲染结果**。因此这里切出来的每一块都会单独喂给
 * markdown-it，块与块之间必须是各自成立的 Markdown。为了让这条成立，块只在
 * 「空白行」或「围栏闭合」处分隔；宁可把块切大一点，也不能把一个语法结构切开。
 *
 * 块状态：
 * - `closed: true`  —— 后面已经有空白行（或围栏/公式已闭合），内容不会再变，可缓存。
 * - `closed: false` —— 还在流式增长，每帧重解析。
 */

export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'fence'
  | 'table'
  | 'blockquote'
  | 'math'
  | 'hr'
  | 'html'
  | 'blank'

export interface MarkdownBlock {
  /** 在数组中的位置，用作渲染缓存的 key（流式只增不改，位置稳定） */
  index: number
  kind: BlockKind
  /** 该块的原始 Markdown 源码（不含结尾空白行） */
  source: string
  /** 是否已经写完，可以缓存渲染结果 */
  closed: boolean
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/
const HR_RE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/
const UL_RE = /^ {0,3}[-*+]\s+/
const OL_RE = /^ {0,3}\d{1,9}[.)]\s+/
const QUOTE_RE = /^ {0,3}>/
const TABLE_RE = /^ {0,3}\|/
const TABLE_SEP_RE = /^ {0,3}\|?[\s:|-]+\|[\s:|-]*$/
const MATH_FENCE_RE = /^ {0,3}\$\$/
const HTML_RE = /^ {0,3}<([a-zA-Z][\w-]*)(\s|\/?>|$)/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isListMarker(line: string): boolean {
  return UL_RE.test(line) || OL_RE.test(line)
}

/** 把连续文本切成块；行尾空白行会被丢弃 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  if (!text) return blocks
  const lines = text.split('\n')
  // 文本以换行结尾时，split 会多出一个空串，那是「换行之后的位置」，不是真的空行。
  // 不排掉它，表头和首行列表会被误判成「已被空白行终止」。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let i = 0

  const push = (kind: BlockKind, source: string, closed: boolean) => {
    if (source.length === 0) return
    blocks.push({ index: blocks.length, kind, source, closed })
  }

  while (i < lines.length) {
    const line = lines[i] as string

    if (isBlank(line)) {
      i++
      continue
    }

    // ---- 围栏代码块 ``` / ~~~
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1] as string
      const fenceChar = marker[0]
      const body: string[] = [line]
      let closed = false
      i++
      while (i < lines.length) {
        const cur = lines[i] as string
        body.push(cur)
        i++
        const closeRe = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
        if (closeRe.test(cur)) {
          closed = true
          break
        }
      }
      push('fence', body.join('\n'), closed)
      continue
    }

    // ---- 独立公式块 $$ ... $$
    if (MATH_FENCE_RE.test(line)) {
      const trimmed = line.trim()
      // 单行 $$...$$ 形式
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        push('math', line, true)
        i++
        continue
      }
      const body: string[] = [line]
      let closed = false
      i++
      while (i < lines.length) {
        const cur = lines[i] as string
        body.push(cur)
        i++
        if (cur.trim().endsWith('$$') && cur.trim().length >= 2 && cur !== line) {
          closed = true
          break
        }
      }
      push('math', body.join('\n'), closed)
      continue
    }

    // ---- 标题（单行）
    if (HEADING_RE.test(line)) {
      const next = lines[i + 1]
      // 标题后面还有内容（或者已经有换行）才算闭合；最后一行仍在流式时保持 open
      const closed = next !== undefined
      push('heading', line, closed)
      i++
      continue
    }

    // ---- 分隔线
    if (HR_RE.test(line)) {
      push('hr', line, lines[i + 1] !== undefined)
      i++
      continue
    }

    // ---- 列表：遇到空白行时，如果下一条非空行仍是列表项则继续（松散列表）
    if (isListMarker(line)) {
      const body: string[] = []
      let closed = false
      while (i < lines.length) {
        const cur = lines[i] as string
        if (isBlank(cur)) {
          // 向后看一格：仍是列表项 -> 当作同一块继续
          let j = i + 1
          while (j < lines.length && isBlank(lines[j] as string)) j++
          const nextLine = lines[j]
          if (nextLine !== undefined && isListMarker(nextLine)) {
            body.push('')
            i = j
            continue
          }
          closed = true
          i = j
          break
        }
        // 非空行一律吞进列表块：无缩进的续行在 Markdown 里是 lazy continuation，
        // 交给 markdown-it 自己判定，比在这里猜更准确。
        body.push(cur)
        i++
      }
      push('list', body.join('\n'), closed)
      continue
    }

    // ---- 表格
    if (TABLE_RE.test(line) || (i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1] as string) && line.includes('|'))) {
      const body: string[] = []
      let closed = false
      while (i < lines.length) {
        const cur = lines[i] as string
        if (isBlank(cur)) {
          closed = true
          i++
          break
        }
        if (!cur.includes('|')) {
          closed = false
          break
        }
        body.push(cur)
        i++
      }
      push('table', body.join('\n'), closed)
      continue
    }

    // ---- 引用
    if (QUOTE_RE.test(line)) {
      const body: string[] = []
      let closed = false
      while (i < lines.length) {
        const cur = lines[i] as string
        if (isBlank(cur)) {
          closed = true
          i++
          break
        }
        if (!QUOTE_RE.test(cur)) {
          closed = false
          break
        }
        body.push(cur)
        i++
      }
      push('blockquote', body.join('\n'), closed)
      continue
    }

    // ---- HTML 块（简单处理：连续以标签开头的行）
    if (HTML_RE.test(line)) {
      const body: string[] = []
      let closed = false
      while (i < lines.length) {
        const cur = lines[i] as string
        if (isBlank(cur)) {
          closed = true
          i++
          break
        }
        body.push(cur)
        i++
      }
      push('html', body.join('\n'), closed)
      continue
    }

    // ---- 普通段落：到空白行为止
    {
      const body: string[] = []
      let closed = false
      while (i < lines.length) {
        const cur = lines[i] as string
        if (isBlank(cur)) {
          closed = true
          i++
          break
        }
        body.push(cur)
        i++
      }
      push('paragraph', body.join('\n'), closed)
      continue
    }
  }

  // 末尾的块一律视为「还在写」：即使它后面跟了一个空白行，下一个字也可能
  // 继续属于它（表格补一行、列表补一项、段落 lazy continuation）。
  // 这样 stableBlockCount 就是 blocks.length - 1，保证流式追加时不会被缓存污染。
  const last = blocks[blocks.length - 1]
  if (last) last.closed = false
  return blocks
}

/** 只有最后一块可能未闭合；返回可以安全缓存的块数量 */
export function stableBlockCount(blocks: MarkdownBlock[]): number {
  let n = 0
  for (const b of blocks) {
    if (!b.closed) break
    n++
  }
  return n
}

export interface BlockDiff {
  /** 可以复用的块（内容与上次一致） */
  reuse: number
  /** 需要新渲染的块 */
  render: MarkdownBlock[]
  /** 本次被丢弃的旧块数 */
  dropped: number
}

/**
 * 比较两次分块结果，算出哪些块可以复用。
 * 流式场景下绝大多数情况是「前缀完全相同，只多了尾部」，因此 O(n) 比较即可。
 */
export function diffBlocks(prev: MarkdownBlock[], next: MarkdownBlock[]): BlockDiff {
  let reuse = 0
  const limit = Math.min(prev.length, next.length)
  for (let i = 0; i < limit; i++) {
    const a = prev[i] as MarkdownBlock
    const b = next[i] as MarkdownBlock
    if (a.source === b.source && a.closed && b.closed) reuse++
    else break
  }
  return {
    reuse,
    render: next.slice(reuse),
    dropped: prev.length - reuse,
  }
}
