/**
 * 朗读文本准备（0.4.3 / WP50）：把 Markdown 回复变成适合**用耳朵听**的纯文本，并切段。
 *
 * 为什么要有这一层：
 *  - 语音合成只接受纯文本，代码块/表格/公式读出来是一串噪音（`for(let i=0`），
 *    引用角标与链接地址更是纯干扰；
 *  - Hub 单次只合成 ≤ `maxChars`（默认 200 字）的一段，App 要自己切；
 *  - 切段不能太碎（每段一次 HTTP + 一次排队），也不能太长（首段要等整段合成完才出声，
 *    服务端合成速度约等于实时，200 字就是 20 秒）。
 *
 * 规则（与任务包 WP50 的「朗读文本准备」一致）：
 *  1. 代码块 → 「这里有一段代码」；表格 → 「这里有一张表格」；公式 → 「这里有一个公式」；
 *  2. 图片整段丢掉；链接只读文字；引用角标 `[1]` / 脚注 `[^2]` 丢掉；
 *  3. 标题/列表/引用的 Markdown 记号去掉，只留文字；
 *  4. emoji 与多余符号去掉（朗读出来只是噪音）；
 *  5. 按句号/问号/叹号/分号/换行切句，过短的句子合并，超长的句子在逗号处再切，
 *     **保证每段 ≤ maxChars**；数字与小数点不会被切断（`3.14`、`1,000`、`v1.2.3`）。
 *
 * 全部是纯函数，不依赖 DOM/网络，单测直接跑（见 test/speech-text.test.ts）。
 */

/** 单次合成的默认上限（与 Hub 契约 `MOBILE_TTS_MAX_CHARS` 一致）。 */
export const DEFAULT_SPEECH_MAX_CHARS = 200
/** 合并过短句子的阈值：短于这个长度就并到下一句，避免一句一句地请求。 */
export const DEFAULT_SPEECH_MIN_CHARS = 12

/** 读出来的占位语（代码/表格/公式不能逐字读）。 */
export const SPEECH_TOKENS = {
  code: '这里有一段代码',
  table: '这里有一张表格',
  math: '这里有一个公式',
} as const

export interface SpeechTextOptions {
  /** 每段上限（字符），默认 200；运行时用 `bootstrap.voice.tts.maxChars`。 */
  maxChars?: number
  /** 过短句子的合并阈值（字符），默认 12。 */
  minChars?: number
}

export interface SpeechText {
  /** 适合朗读的纯文本（段与段之间的换行已去掉）。 */
  text: string
  /** 切好的段，每段 ≤ maxChars；没有可读内容时是空数组。 */
  segments: string[]
  /** 纯文本的字符数（诊断 tts:play 的 `chars`）。 */
  chars: number
}

// ── 第一步：Markdown → 纯文本 ────────────────────────────────────────────────

/** 句末标点（中文）：出现在这些字符后就是一句结束。 */
const CN_TERMINATORS = new Set(['。', '！', '？', '；', '…', '‼', '⁉', '｡'])
/** 句末标点（英文）：还要求后面是空白/结尾/中文，避免切到 `3.14`、`v1.2`。 */
const EN_TERMINATORS = new Set(['.', '!', '?', ';'])
/** 句末标点后面紧跟的收尾符号（引号/括号）要留在同一句里。 */
const CLOSERS = new Set(['」', '』', '”', '’', ')', '）', '】', '》', '"', "'"])
/** 逗号类：长句在这里再切（`,` 只认「逗号+空白」，不会切到 `1,000`）。 */
const COMMA_MARKS = new Set(['，', '、'])

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const ASCII_WORD = /[A-Za-z0-9]/
const DIGIT = /[0-9]/

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK.test(ch)
}

/**
 * 代码块 → 占位语。用逐行状态机而不是一条大正则：回复里常出现嵌套的反引号
 * （```` ```md ```` 里的示例代码），正则容易一个都匹配不上。
 */
function replaceFences(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  /** 正在围栏内：字符与长度（结束围栏必须同字符且不短于起始）。 */
  let fence: { char: string; size: number } | null = null
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null && marker) {
      fence = { char: marker[1]![0]!, size: marker[1]!.length }
      continue
    }
    if (fence !== null) {
      // CommonMark：结束围栏与起始同字符、长度不短于起始；` ```` ` 里的 ` ``` ` 不算结束。
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size) {
        fence = null
        out.push(SPEECH_TOKENS.code)
      }
      continue
    }
    out.push(line)
  }
  // 围栏没闭合（流式/半截回复）：仍然读一句占位语，别把代码原样念出来
  if (fence !== null) out.push(SPEECH_TOKENS.code)
  return out.join('\n')
}

/** 显示公式（`$$…$$` / `\[…\]`，可能跨行）→ 占位语。 */
function replaceDisplayMath(text: string): string {
  return text
    .replace(/^\s*\$\$[\s\S]*?\$\$\s*$/gm, SPEECH_TOKENS.math)
    .replace(/\$\$[\s\S]*?\$\$/g, SPEECH_TOKENS.math)
    .replace(/\\\[[\s\S]*?\\\]/g, SPEECH_TOKENS.math)
}

/** 表格：连续几行都带 `|`，且中间有 `---` 分隔行 → 整块读「这里有一张表格」。 */
function replaceTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let index = 0
  const isRow = (line: string): boolean => line.includes('|') && line.trim().length > 0
  const isSeparator = (line: string): boolean => /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(line)
  while (index < lines.length) {
    const line = lines[index]!
    if (isRow(line) && index + 1 < lines.length && isSeparator(lines[index + 1]!)) {
      index += 2
      while (index < lines.length && isRow(lines[index]!)) index += 1
      out.push(SPEECH_TOKENS.table)
      continue
    }
    out.push(line)
    index += 1
  }
  return out.join('\n')
}

/** 行首的 Markdown 结构记号：标题、引用、列表、分隔线。 */
function stripLineMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // 分隔线（`---` / `***` / `___`）整行丢掉
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return ''
      // 标题：`### 标题` → `标题`
      let next = line.replace(/^\s{0,3}#{1,6}\s+/, '')
      // 引用：`> > 引用` → `引用`
      let guard = 0
      while (/^\s{0,3}>\s?/.test(next) && guard < 8) {
        next = next.replace(/^\s{0,3}>\s?/, '')
        guard += 1
      }
      // 列表：`- ` / `* ` / `1. ` / `1) `
      next = next.replace(/^(\s*)(?:[-*+]|\d{1,3}[.)])\s+/, '$1')
      return next
    })
    .join('\n')
}

/** 行内 Markdown → 文字（图片、链接、角标、公式、代码、强调、HTML）。 */
function stripInline(text: string): string {
  return (
    text
      // 图片：整段丢掉（读 `alt` 没有意义）
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
      // 链接：只读文字（`[标题](https://…)` → `标题`）
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      // 引用角标 / 脚注：`[1]`、`[1,2]`、`[^2]`、`^[注]` 全丢
      .replace(/\[\^?[0-9]{1,3}(?:\s*[,-]\s*[0-9]{1,3})*\]/g, '')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/\^\[[^\]]*\]/g, '')
      // 行内公式：`$…$`（长度有限，避免把两段正文之间的金额当成公式）与 `\(…\)`
      .replace(/(?<![\\$])\$(?!\s)([^$\n]{1,80}?)(?<!\s)\$(?!\d)/g, SPEECH_TOKENS.math)
      .replace(/\\\([\s\S]*?\\\)/g, SPEECH_TOKENS.math)
      // 行内代码：`npm install` → `npm install`（内容照读，反引号不要）
      .replace(/`([^`\n]+)`/g, '$1')
      // 强调 / 删除线
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1')
      // 常见 HTML 标签（只认已知标签，别把 `3 < 5 and 5 > 2` 吃掉）
      .replace(
        /<\/?(?:br|p|div|span|strong|em|b|i|u|s|code|pre|a|img|ul|ol|li|blockquote|table|thead|tbody|tr|td|th|h[1-6]|sup|sub|kbd|mark|hr|figure|figcaption|details|summary)(?:\s[^>]*)?\/?>/gi,
        '',
      )
      // HTML 实体
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  )
}

/** emoji（含变体选择符、零宽连接、国旗/键帽）与 Markdown 残留符号。 */
function stripNoise(text: string): string {
  return (
    text
      // emoji：\p{Extended_Pictographic} 覆盖绝大多数表情；再补上常见符号区
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
      .replace(/[\u2190-\u21FF\u2300-\u23FF\u2B00-\u2BFF]/g, ' ')
      // Markdown 残留：`# * _ ~ | ^` 与多余的方括号/反斜杠
      // （`<` / `>` 留着：`5 > 2` 这种比较读出来还有意义，行首的 `>` 已经在上一行走掉了）
      .replace(/[#*_~|`^\\]/g, ' ')
      .replace(/[[\]]/g, ' ')
      // 项目符号等装饰字符
      .replace(/[•·●○◆◇■□▪▫→←↑↓]/g, ' ')
      // 同一个标点连续出现（`。。。`）与标点前的空白
      .replace(/([，。！？；：、,.!?;:])[\s]*\1+/g, '$1')
      .replace(/\s+([，。！？；：、,.!?;:])/g, '$1')
      // 空白规整：段内多空格 → 一个，行首尾去掉，连续空行 → 一个换行
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\s+|\s+$/g, '')
  )
}

/** 单个字符能不能作为有意义的朗读内容（避免整段只剩 `，。`）。 */
function hasSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text) || text.includes(SPEECH_TOKENS.code) || text.includes(SPEECH_TOKENS.table) || text.includes(SPEECH_TOKENS.math)
}

/**
 * Markdown → 适合朗读的纯文本（不切段）。
 *
 * 代码/表格/公式被替换成一句占位语；图片整段去掉；其余只留可朗读的文字。
 */
export function markdownToSpeechText(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) return ''
  let text = markdown.replace(/\r\n?/g, '\n')
  text = replaceFences(text)
  text = replaceTables(text)
  text = replaceDisplayMath(text)
  text = stripLineMarkers(text)
  text = stripInline(text)
  text = stripNoise(text)
  // 逐行清理：只留下有可朗读内容的行（`---`、`|` 之类会变成空行）
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => hasSpeakable(line))
  return lines.join('\n').trim()
}

// ── 第二步：切句 ────────────────────────────────────────────────────────────

/**
 * 按句末标点/换行切句（不做长度处理）。
 *
 * 细节：
 *  - 中文句末标点后面紧跟的收尾引号/括号留在本句；
 *  - 英文句末标点要求后面是空白/结尾/中文，`3.14`、`v1.2.3`、`a@b.com` 不会被切开；
 *  - 换行也算一句结束（列表项/表格行天生一行一句）。
 */
export function splitSpeechSentences(text: string): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  let buffer = ''
  const flush = (): void => {
    const piece = buffer.trim()
    if (piece.length > 0) out.push(piece)
    buffer = ''
  }
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index]!
    if (ch === '\n') {
      flush()
      continue
    }
    buffer += ch
    if (CN_TERMINATORS.has(ch)) {
      // `！？` / `…` 连写、句末引号：都归到本句
      while (index + 1 < chars.length) {
        const next = chars[index + 1]!
        if (CN_TERMINATORS.has(next) || CLOSERS.has(next)) {
          buffer += next
          index += 1
          continue
        }
        break
      }
      flush()
      continue
    }
    if (EN_TERMINATORS.has(ch)) {
      const prev = chars[index - 1]
      const next = chars[index + 1]
      // 小数点 / 版本号 / 域名：前后都是数字，或后面紧跟数字 → 不是句末
      if (ch === '.' && prev !== undefined && DIGIT.test(prev) && next !== undefined && DIGIT.test(next)) {
        continue
      }
      if (next !== undefined && !/\s/.test(next) && !isCjk(next) && !CLOSERS.has(next)) {
        continue
      }
      while (index + 1 < chars.length && CLOSERS.has(chars[index + 1]!)) {
        buffer += chars[index + 1]
        index += 1
      }
      flush()
    }
  }
  flush()
  return out
}

/** 拼接两句：英文/数字接缝补一个空格，中文直接相连。 */
export function joinSpeechSentences(left: string, right: string): string {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const leftChar = left[left.length - 1]!
  const rightChar = right[0]!
  const needsSpace = ASCII_WORD.test(leftChar) || ASCII_WORD.test(rightChar)
  return needsSpace ? `${left} ${right}` : `${left}${right}`
}

/**
 * 在逗号处把超长句切成 ≤ maxChars 的块。
 *
 * 优先切在逗号/顿号后面（`，` / `、` / `, ` / `; `），切不动才硬切；硬切点如果落在
 * 数字中间，就往前退一位（`3.14159` 不能被念成 `3.14` + `159`）。
 */
export function splitLongSentence(sentence: string, maxChars: number): string[] {
  const chars = Array.from(sentence)
  if (chars.length <= maxChars) return [sentence]
  const out: string[] = []
  let start = 0
  while (start < chars.length) {
    const remain = chars.length - start
    if (remain <= maxChars) {
      const tail = chars.slice(start).join('').trim()
      if (tail.length > 0) out.push(tail)
      break
    }
    // 在 [start, start+maxChars] 范围内找最后一个逗号（后面同一块里不能没有内容）
    let cut = -1
    for (let index = start + Math.floor(maxChars * 0.4); index < start + maxChars; index += 1) {
      const ch = chars[index]!
      if (COMMA_MARKS.has(ch)) {
        cut = index + 1
        continue
      }
      if ((ch === ',' || ch === ';') && /\s/.test(chars[index + 1] ?? '')) {
        cut = index + 2
      }
    }
    if (cut <= start) cut = start + maxChars
    // 硬切点落在数字中间（`3.14` / `1,000`）：退到数字前面
    let guard = 0
    while (cut > start + 1 && guard < 8) {
      const prev = chars[cut - 1]!
      const next = chars[cut]!
      if ((DIGIT.test(prev) || prev === '.' || prev === ',') && DIGIT.test(next)) {
        cut -= 1
        guard += 1
        continue
      }
      break
    }
    const piece = chars.slice(start, cut).join('').trim()
    if (piece.length > 0) out.push(piece)
    start = cut
  }
  return out
}

/**
 * 把一段纯文本切成 ≤ maxChars 的朗读段：
 *  1. 先按句切；
 *  2. 过短的句子（< minChars）与下一句合并，但合并后不能超过 maxChars；
 *  3. 单句超长的在逗号处再切（仍超长就硬切），保证每段 ≤ maxChars。
 */
export function splitSpeechSegments(
  text: string,
  options: SpeechTextOptions = {},
): string[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_SPEECH_MAX_CHARS))
  const minChars = Math.max(0, Math.min(options.minChars ?? DEFAULT_SPEECH_MIN_CHARS, maxChars))
  const sentences = splitSpeechSentences(text)
  const segments: string[] = []
  let current = ''
  const push = (): void => {
    const piece = current.trim()
    if (piece.length > 0) segments.push(piece)
    current = ''
  }
  for (const sentence of sentences) {
    // 单句就超过上限：先切好，逐块走合并逻辑（每块自身已 ≤ maxChars）
    const pieces =
      Array.from(sentence).length > maxChars ? splitLongSentence(sentence, maxChars) : [sentence]
    for (const piece of pieces) {
      if (current.length === 0) {
        current = piece
        continue
      }
      const joined = joinSpeechSentences(current, piece)
      if (current.length < minChars && Array.from(joined).length <= maxChars) {
        current = joined
        continue
      }
      push()
      current = piece
    }
  }
  push()
  return segments
}

/**
 * 一步到位：Markdown → `{ text, segments, chars }`。
 *
 * `segments` 为空表示这条回复没有可朗读的内容（纯图片/纯表格以外的空回复）。
 */
export function prepareSpeechText(
  markdown: string,
  options: SpeechTextOptions = {},
): SpeechText {
  const text = markdownToSpeechText(markdown)
  if (text.length === 0) return { text: '', segments: [], chars: 0 }
  const segments = splitSpeechSegments(text, options)
  return { text, segments, chars: Array.from(text).length }
}
