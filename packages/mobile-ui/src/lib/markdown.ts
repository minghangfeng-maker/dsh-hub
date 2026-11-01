import katex from 'katex'
import MarkdownIt from 'markdown-it'

/**
 * markdown-it + KaTeX。
 *
 * 自己写公式规则而不是用社区插件：依赖少、行为可控，且离线可用。
 * 支持四种写法（0.4.0 收尾）：
 *   - `\(...\)`   行内（LaTeX 原生写法，模型和文档里最常见）
 *   - `\[...\]`   块级（同样允许出现在段落中间，退化成行内的 display 公式）
 *   - `$...$`     行内（markdown-it-katex 的写法）
 *   - `$$...$$`   块级
 * HTML 关闭（html:false），模型输出里的裸标签按文本转义 —— S0 不做作品预览，先保证安全。
 *
 * 为什么 `\(...\)` 必须支持：markdown-it 的 escape 规则会把 `\(` 转义成普通括号 `(`，
 * 于是 `\(E = mc^2\)` 会原样渲染成「(E = mc^2)」——正是真机上看到的样子。
 *
 * `$` 的误伤保护（金额）见 `mathInline` 里的三条规则。
 */

function isValidInlineDelim(src: string, pos: number): { canOpen: boolean; canClose: boolean } {
  const prevChar = pos > 0 ? src[pos - 1] : ''
  const nextChar = pos + 1 < src.length ? src[pos + 1] : ''
  const canOpen = !nextChar || !/\s/.test(nextChar)
  const canClose = !!prevChar && !/\s/.test(prevChar)
  return { canOpen, canClose }
}

/** 从 `from` 起找第一个「没被反斜杠转义」的 `closer`；找不到返回 -1。 */
function findUnescaped(src: string, from: number, closer: string): number {
  let at = from
  while (at <= src.length - closer.length) {
    at = src.indexOf(closer, at)
    if (at === -1) return -1
    let backslashes = 0
    let p = at - 1
    while (p >= 0 && src[p] === '\\') {
      backslashes += 1
      p -= 1
    }
    if (backslashes % 2 === 0) return at
    at += closer.length
  }
  return -1
}

/**
 * `\(...\)` 行内公式。
 *
 * 必须注册在 `escape` 之前：`escape` 会把 `\(` 吃掉变成 `(`。
 * 没有闭合的 `\(`（流式中间态）直接返回 false，交回普通文本，不会抛错。
 */
function mathInlineParen(state: any, silent: boolean): boolean {
  const src: string = state.src
  const pos: number = state.pos
  if (src[pos] !== '\\' || src[pos + 1] !== '(') return false
  const close = findUnescaped(src, pos + 2, '\\)')
  if (close === -1) return false
  const content = src.slice(pos + 2, close)
  if (content.trim() === '') return false
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.markup = '\\('
    token.content = content
  }
  state.pos = close + 2
  return true
}

/**
 * `\[...\]` 块级公式（行内兜底）。
 *
 * 独占一行时由块规则 `mathBlockBracket` 先接走（渲染成真正的块级容器）；
 * 出现在段落中间时走这里，用 `<span class="md-math-inline-display">` 包一个 display 公式。
 */
function mathInlineBracket(state: any, silent: boolean): boolean {
  const src: string = state.src
  const pos: number = state.pos
  if (src[pos] !== '\\' || src[pos + 1] !== '[') return false
  const close = findUnescaped(src, pos + 2, '\\]')
  if (close === -1) return false
  const content = src.slice(pos + 2, close)
  if (content.trim() === '') return false
  if (!silent) {
    const token = state.push('math_display_inline', 'math', 0)
    token.markup = '\\['
    token.content = content
  }
  state.pos = close + 2
  return true
}

/**
 * `$...$` 行内公式，以及段落中间出现的 `$$...$$`（按 display 公式渲染）。
 *
 * 金额保护（三条，缺一条「$5 和 $10」就会被当成公式）：
 *  1. 开标记后面不能是空白（`$ 5` 不算公式）；
 *  2. 闭标记前面不能是空白（`$5 和 $` 不算公式）；
 *  3. 闭标记后面不能是数字 ——「$5和$10」「预算 $100-$200」靠这条挡住，
 *     它同时是 Pandoc / KaTeX auto-render 采用的规则。
 */
function mathInline(state: any, silent: boolean): boolean {
  const src: string = state.src
  if (src[state.pos] !== '$') return false

  // 段落中间的 `$$...$$`：当 display 公式（独占一行的由块规则先接走）
  if (src[state.pos + 1] === '$') {
    const close = findUnescaped(src, state.pos + 2, '$$')
    const content = close === -1 ? '' : src.slice(state.pos + 2, close)
    if (close !== -1 && content.trim() !== '') {
      if (!silent) {
        const token = state.push('math_display_inline', 'math', 0)
        token.markup = '$$'
        token.content = content
      }
      state.pos = close + 2
      return true
    }
    if (!silent) state.pending += '$$'
    state.pos += 2
    return true
  }

  const open = isValidInlineDelim(src, state.pos)
  if (!open.canOpen) {
    if (!silent) state.pending += '$'
    state.pos += 1
    return true
  }
  const start = state.pos + 1
  const match = findUnescaped(src, start, '$')
  if (match === -1) {
    // 没有闭合（流式中间态）：原样输出，不阻塞后面的渲染
    if (!silent) state.pending += '$'
    state.pos = start
    return true
  }
  const close = isValidInlineDelim(src, match)
  const nextChar = match + 1 < src.length ? src[match + 1] : ''
  const looksLikeMoney = nextChar !== '' && /[0-9]/.test(nextChar)
  if (!close.canClose || looksLikeMoney) {
    if (!silent) state.pending += '$'
    state.pos = start
    return true
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.markup = '$'
    token.content = src.slice(start, match)
  }
  state.pos = match + 1
  return true
}

function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (start + 2 > max) return false
  if (state.src.slice(start, start + 2) !== '$$') return false
  if (silent) return true

  let next = startLine
  let found = false
  let content = state.src.slice(start + 2, max)

  // 单行形式 $$...$$
  if (content.trim().endsWith('$$')) {
    content = content.trim().slice(0, -2)
    found = true
    next = startLine + 1
  } else {
    const parts = [content]
    for (let line = startLine + 1; line < endLine; line++) {
      const ls = state.bMarks[line] + state.tShift[line]
      const le = state.eMarks[line]
      const text = state.src.slice(ls, le)
      if (text.trim().endsWith('$$')) {
        parts.push(text.trim().slice(0, -2))
        found = true
        next = line + 1
        break
      }
      parts.push(text)
    }
    content = parts.join('\n')
  }

  // 没有闭合的 $$ 交给段落规则处理（流式过程中会短暂出现）
  if (!found) return false

  state.line = next
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = content
  token.map = [startLine, state.line]
  token.markup = '$$'
  return true
}

/**
 * `\[...\]` 块级公式：以 `\[` 开头、以 `\]` 收尾（可以跨行）。
 *
 * `\]` 之后同一行还有正文时不算块级（返回 false，交给行内规则按 display 公式渲染），
 * 这样「`\[a\] 后面还有话`」不会把后半句吃掉。没闭合（流式中间态）同样返回 false。
 */
function mathBlockBracket(
  state: any,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (start + 2 > max) return false
  if (state.src.slice(start, start + 2) !== '\\[') return false
  if (silent) return true

  const first = state.src.slice(start + 2, max)
  const sameLine = findUnescaped(first, 0, '\\]')
  if (sameLine !== -1) {
    if (first.slice(sameLine + 2).trim() !== '') return false
    state.line = startLine + 1
    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = first.slice(0, sameLine)
    token.map = [startLine, state.line]
    token.markup = '\\['
    return true
  }

  const parts = [first]
  for (let line = startLine + 1; line < endLine; line += 1) {
    const ls = state.bMarks[line] + state.tShift[line]
    const le = state.eMarks[line]
    const text = state.src.slice(ls, le)
    const at = findUnescaped(text, 0, '\\]')
    if (at !== -1) {
      if (text.slice(at + 2).trim() !== '') return false
      parts.push(text.slice(0, at))
      state.line = line + 1
      const token = state.push('math_block', 'math', 0)
      token.block = true
      token.content = parts.join('\n')
      token.map = [startLine, state.line]
      token.markup = '\\['
      return true
    }
    parts.push(text)
  }
  return false
}

export function createMarkdownRenderer(): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  })

  // `\(` / `\[` 必须注册在 escape 之前：escape 会把它们变成普通括号/方括号。
  md.inline.ruler.before('escape', 'math_inline_paren', mathInlineParen)
  md.inline.ruler.before('escape', 'math_inline_bracket', mathInlineBracket)
  md.inline.ruler.after('escape', 'math_inline', mathInline)
  md.block.ruler.before('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.block.ruler.before('fence', 'math_block_bracket', mathBlockBracket, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })

  const renderMath = (source: string, displayMode: boolean): string => {
    try {
      return katex.renderToString(source, {
        displayMode,
        throwOnError: false,
        errorColor: '#c0392b',
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
      })
    } catch (err) {
      return `<code class="math-error">${escapeHtml(source)}</code>`
    }
  }

  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx]!.content, false)
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="md-math-block">${renderMath(tokens[idx]!.content, true)}</div>`
  // 段落中间的 display 公式（`\[...\]` / `$$...$$` 夹在文字里）：块级排版但不跳出段落
  md.renderer.rules.math_display_inline = (tokens, idx) =>
    `<span class="md-math-inline-display">${renderMath(tokens[idx]!.content, true)}</span>`

  // 表格外面套一层横向滚动容器，长表格不撑破气泡
  md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'

  // 正文里的图片：http(s)/data/blob 原样交给浏览器；**云端本地路径**（AI 在云容器里
  // 生成的 `/workspace/.../pelican.png`）不能直接当 URL 用，否则就是破图。
  // 这里改渲染成 <dsh-cloud-image>，由 ConversationView 注册的 resolver 通过
  // 通道的 file-read({path}) 取字节；失败显示「云端图片暂不可预览 · 下载」卡片。
  const defaultImage = md.renderer.rules.image
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const rawSrc = token.attrGet('src')
    const src = typeof rawSrc === 'number' ? String(rawSrc) : rawSrc
    const local = cloudImagePathOf(src)
    if (local === null) {
      if (defaultImage) return defaultImage(tokens, idx, options, env, self)
      return self.renderToken(tokens, idx, options)
    }
    const alt = self.renderInlineAsText(token.children ?? [], options, env)
    const rawTitle = token.attrGet('title')
    const title = typeof rawTitle === 'number' ? String(rawTitle) : rawTitle
    const attrs = [
      `class="md-cloud-image"`,
      `data-path="${escapeHtml(local)}"`,
      `data-alt="${escapeHtml(alt)}"`,
      ...(title === null || title === '' ? [] : [`data-title="${escapeHtml(title)}"`]),
    ]
    return `<dsh-cloud-image ${attrs.join(' ')}></dsh-cloud-image>`
  }

  return md
}

/**
 * Markdown 图片地址 → 云端文件路径（不是云端路径返回 null）。
 *
 * 真机 0.2.13 的正文图片破图就是这里没拦：模型在云容器里生成图片后，正文写的是
 * `/workspace/.../pelican-ride-hd.png`，`<img src>` 在 WebView 里指向一个不存在的
 * 页面路径。识别规则（保守、只放行明确是本地/工作区路径的写法）：
 * - `file://` → 取路径；
 * - posix 绝对路径（`/workspace/...`）/ Windows 盘符（`D:\...`）/ `./`、`../` 相对路径；
 * - 其它协议（http/https/data/blob/ftp/mailto…）一律返回 null，交回默认渲染。
 */
export function cloudImagePathOf(src: string | null | undefined): string | null {
  if (typeof src !== 'string') return null
  const value = src.trim()
  if (value === '') return null
  if (value.startsWith('//')) return null // 协议相对 URL
  if (value.startsWith('#')) return null // 页内锚点
  if (/^file:\/\//i.test(value)) {
    const rest = value.replace(/^file:\/\//i, '')
    // file:///workspace/x → /workspace/x；file://host/x 是网络主机，不碰
    return rest.startsWith('/') ? maybeDecodePath(rest) : null
  }
  // 先判盘符再判协议：`D:\a.png` 会被「单字母 scheme」的正则误伤。
  if (/^[A-Za-z]:[\\/]/.test(value)) return value // Windows 绝对路径
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null // 其它协议
  if (value.startsWith('/')) return maybeDecodePath(value)
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')) {
    return maybeDecodePath(value)
  }
  // 裸相对路径（`outputs/pelican.png`）：手机端没有静态站点，按工作区路径处理；
  // 真的读不到时显示下载卡片，比破图好。
  return maybeDecodePath(value)
}

/** markdown-it 会把链接里的空格等转成 %20：读文件前尽量还原（解不开就按原样）。 */
function maybeDecodePath(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// ── 正文云端图片的 <dsh-cloud-image> 自定义元素 ─────────────────────────────
//
// 为什么用自定义元素：Markdown 是 `v-html` 渲染的静态 HTML，Vue 不会为里面的 <img>
// 建组件、也给不了异步数据。自定义元素是浏览器原生扩展点：挂到 DOM 时自己去取字节、
// 自己管理加载/失败两态，不需要改 MdBlock / StreamingMarkdown 的渲染管线。

const CLOUD_IMAGE_TAG = 'dsh-cloud-image'

export interface CloudImageResource {
  /** 可交给 <img src> 的 object URL。 */
  url: string
  name: string
  mimeType: string
  bytes: number
}

/** 由 UI 层（ConversationView）注册：把路径换成字节/object URL、保存到相册。 */
export interface CloudImageResolver {
  load(path: string, meta?: { alt?: string; force?: boolean }): Promise<CloudImageResource>
  save(path: string, meta?: { alt?: string }): Promise<void>
}

let cloudImageResolver: CloudImageResolver | null = null

/** 注册/注销 resolver（ConversationView 挂载时注册、卸载时置 null）。 */
export function setCloudImageResolver(resolver: CloudImageResolver | null): void {
  cloudImageResolver = resolver
}

export function getCloudImageResolver(): CloudImageResolver | null {
  return cloudImageResolver
}

const CLOUD_IMAGE_STYLE = `
  :host { display: block; margin: 8px 0; }
  .img {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 320px;
    object-fit: contain;
    border-radius: 10px;
    background: var(--surface-2, rgba(127, 127, 127, 0.12));
    cursor: pointer;
  }
  .ph {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 88px;
    padding: 14px 10px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
    border-radius: 10px;
    background: var(--surface-2, rgba(127, 127, 127, 0.12));
    color: var(--text-3, #888);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
    border-radius: 10px;
    background: var(--surface, transparent);
    color: var(--text-3, #888);
    font-size: 12.5px;
  }
  .card__text { flex: 1; min-width: 0; }
  .card__msg { display: block; margin-top: 2px; opacity: 0.75; font-size: 11.5px; }
  .card__btn {
    flex: 0 0 auto;
    padding: 4px 10px;
    border-radius: 8px;
    background: var(--surface-2, rgba(127, 127, 127, 0.16));
    color: var(--text-2, #666);
    font-size: 12px;
    border: none;
  }
`

if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined' && customElements.get(CLOUD_IMAGE_TAG) === undefined) {
  class CloudImageElement extends HTMLElement {
    private path = ''
    private alt = ''
    private state: 'loading' | 'ready' | 'error' = 'loading'
    private message = ''
    private url: string | null = null
    private generation = 0
    private shadow: ShadowRoot | null = null

    connectedCallback(): void {
      this.path = this.getAttribute('data-path') ?? ''
      this.alt = this.getAttribute('data-alt') ?? ''
      if (this.path === '') return
      if (this.shadow === null) this.shadow = this.attachShadow({ mode: 'open' })
      this.state = 'loading'
      this.render()
      void this.load(false)
    }

    disconnectedCallback(): void {
      // 卸载后异步结果一律丢弃。**不要 revoke object URL**：URL 归 chat store 的
      // 会话级缓存所有（Markdown 重渲染时新旧元素会共用同一个 URL，元素自己 revoke
      // 会把新元素刚拿到的图弄坏）；统一由 releaseFileUrls / 切会话时释放。
      this.generation += 1
    }

    /** resolver 可能比首屏渲染晚一帧注册（ConversationView setup 里注册）。 */
    private async waitResolver(): Promise<CloudImageResolver | null> {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (cloudImageResolver !== null) return cloudImageResolver
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      return cloudImageResolver
    }

    private async load(force: boolean): Promise<void> {
      const generation = ++this.generation
      const resolver = await this.waitResolver()
      if (generation !== this.generation) return
      if (resolver === null) {
        this.fail('图片通道还没就绪')
        return
      }
      try {
        const resource = await resolver.load(this.path, {
          ...(this.alt === '' ? {} : { alt: this.alt }),
          ...(force ? { force: true } : {}),
        })
        if (generation !== this.generation) return
        this.url = resource.url
        this.state = 'ready'
        this.render()
      } catch (error) {
        if (generation !== this.generation) return
        this.fail(error instanceof Error ? error.message : '图片加载失败')
      }
    }

    private fail(message: string): void {
      this.state = 'error'
      this.message = message
      this.render()
    }

    private render(): void {
      const root = this.shadow
      if (root === null) return
      if (this.state === 'ready' && this.url !== null) {
        root.innerHTML = `<style>${CLOUD_IMAGE_STYLE}</style><img class="img" src="${escapeHtml(this.url)}" alt="${escapeHtml(this.alt)}" loading="lazy" decoding="async" />`
        root.querySelector('img')?.addEventListener('click', () => {
          void this.save()
        })
        return
      }
      if (this.state === 'error') {
        root.innerHTML = `<style>${CLOUD_IMAGE_STYLE}</style><div class="card"><span class="card__text">云端图片暂不可预览<span class="card__msg">${escapeHtml(this.message)}</span></span><button class="card__btn" type="button">下载</button></div>`
        root.querySelector('button')?.addEventListener('click', () => {
          void this.download()
        })
        return
      }
      root.innerHTML = `<style>${CLOUD_IMAGE_STYLE}</style><div class="ph">正在加载图片…</div>`
    }

    /** 失败卡片上的「下载」：先取字节（成功就先把图显示出来），再存到相册/下载目录。 */
    private async download(): Promise<void> {
      const resolver = await this.waitResolver()
      if (resolver === null) return
      this.state = 'loading'
      this.render()
      const generation = ++this.generation
      try {
        const resource = await resolver.load(this.path, {
          ...(this.alt === '' ? {} : { alt: this.alt }),
          force: true,
        })
        if (generation !== this.generation) return
        this.url = resource.url
        this.state = 'ready'
        this.render()
        await resolver.save(this.path, this.alt === '' ? {} : { alt: this.alt })
      } catch (error) {
        if (generation !== this.generation) return
        // 失败就停在卡片上，不再走一遍 save（那会再触发一次下载与 toast）。
        this.fail(error instanceof Error ? error.message : '下载失败')
      }
    }

    /** 点图保存（与交付物图片的「保存」同一动作）。 */
    private async save(): Promise<void> {
      const resolver = await this.waitResolver()
      if (resolver === null) return
      await resolver.save(this.path, this.alt === '' ? {} : { alt: this.alt })
    }
  }

  customElements.define(CLOUD_IMAGE_TAG, CloudImageElement)
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const shared = createMarkdownRenderer()

/** 同步渲染一个 Markdown 块 */
export function renderMarkdown(source: string): string {
  return shared.render(source)
}

/**
 * 预热渲染器：把 markdown-it 的规则链、KaTeX 的样式计算与表格/公式分支都先走一遍。
 * 首屏之后调用；否则第一条带公式/表格的回复会在流式中间触发 100ms 级首次渲染。
 */
export function warmupRenderer(): void {
  try {
    shared.render(
      '## warmup\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\\(E = mc^2\\)\n\n\\[\\frac{a}{b}\\]\n\n$$\\int_0^1 x dx$$\n\n```ts\nconst a = 1\n```\n',
    )
  } catch {
    /* 预热失败不影响功能 */
  }
}

/** 从围栏块里取出语言和代码正文（用于后续 Shiki 高亮） */
export function parseFence(source: string): { lang: string; code: string } {
  const lines = source.split('\n')
  const head = (lines[0] ?? '').trim()
  const lang = head.replace(/^[`~]+/, '').trim().split(/\s+/)[0] ?? ''
  const body = lines.slice(1)
  if (body.length > 0 && /^[`~]{3,}\s*$/.test(body[body.length - 1] ?? '')) body.pop()
  return { lang: lang.toLowerCase(), code: body.join('\n') }
}
