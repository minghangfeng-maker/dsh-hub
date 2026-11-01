/**
 * 12 §6.3 的启发式估算：上游没回 usage 时按字数算 token。
 * 只做「宁可少算」的粗略口径，不引入分词器。
 */

/** 中日韩及全角字符的码点区间（含假名、谚文、CJK 扩展） */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2eff],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3130, 0x318f],
  [0x31c0, 0x31ef],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x2fa1f],
]

/** 这些键开头的子树大概率是图片/签名数据，整棵跳过而不是逐字段判断 */
const SKIPPED_KEY_PREFIXES = ['image', 'image_url', 'b64', 'base64', 'signature']

/** base64 字母表（允许换行）；用它 + 长度阈值区分「正文」与「二进制块」 */
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]+$/
const BASE64_MIN_LENGTH = 512

function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isSkippedKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SKIPPED_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function isCountableText(value: string): boolean {
  if (value.length > BASE64_MIN_LENGTH && BASE64_LIKE.test(value)) return false
  const lower = value.toLowerCase()
  if (lower.startsWith('data:')) return false
  return !lower.startsWith('http://') && !lower.startsWith('https://')
}

/** 12 §6.3：文本 → token 估算 = 中日韩字符数 + 其他字符数 / 4（向上取整） */
export function estimateTokensFromText(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (isCjk(codePoint)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 从请求体 JSON 里收集所有「文本内容」并拼接。
 * 用显式栈而不是递归：请求体是外部输入，深度不可控。
 */
export function collectRequestText(body: unknown): string {
  const parts: string[] = []
  const stack: unknown[] = [body]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') {
      if (isCountableText(value)) parts.push(value)
      continue
    }
    if (Array.isArray(value)) {
      // 倒序入栈，保证收集顺序与 JSON 书写顺序一致
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i])
      continue
    }
    const record = asObject(value)
    if (!record) continue
    const entries = Object.entries(record)
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (!entry) continue
      const [key, child] = entry
      if (isSkippedKey(key)) continue
      stack.push(child)
    }
  }
  return parts.join('\n')
}

/** 输入 token 估算 = estimateTokensFromText(collectRequestText(body)) */
export function estimateInputTokens(body: unknown): number {
  return estimateTokensFromText(collectRequestText(body))
}
