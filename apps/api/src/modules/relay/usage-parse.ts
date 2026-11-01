import type { ModelApi } from '@dsh-hub/shared'

/** 归一化后的 token 用量（12 §5.5）。reasoning 已含在 output 里，只作展示 */
export interface RelayUsageTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

/** 流式解析器：边透传字节边喂，随时可读已解析出的用量与文本增量 */
export interface StreamUsageParser {
  /** 喂入已透传的原始字节（可能任意切分，包含半个 SSE 事件） */
  push(chunk: Uint8Array | string): void
  /** 当前已解析出的 usage；完全没有 usage 信息时返回 null */
  usage(): RelayUsageTokens | null
  /** 是否见到 `data: [DONE]`（OpenAI 风格的结束标记） */
  sawDone(): boolean
  /**
   * 上游是否已经把这次生成「讲完」：见到 `[DONE]`，或各协议自己的收尾事件
   * （completions 的 `finish_reason`、anthropic 的 `message_stop`、responses 的 `response.completed|incomplete`）。
   * 客户端读到收尾就会主动断开连接，这时它断开的时候流其实已经完整了，不能算「中断」。
   */
  sawComplete(): boolean
  /** 已透传的文本增量（输出估算用：openai delta.content / responses 的 output_text.delta / anthropic 的 text_delta） */
  outputText(): string
}

/**
 * 解析过程中的中间态：undefined = 该字段上游还没出现过。
 * 必须与「出现了但是 0」区分开，否则 message_delta 里缺字段会把 message_start 的输入抹掉。
 */
interface PartialTokens {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

type JsonObject = Record<string, unknown>

const DATA_PREFIX = 'data:'
const DONE_MARKER = '[DONE]'

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 计数收窄：字段缺失/非数字 → undefined；出现负数或非整数 → 0（12 §5.5） */
function countOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  return Number.isInteger(value) && value > 0 ? value : 0
}

/** 三协议的 usage 位置不同：顶层 / choices[i] / response / message，这里只关心本次负载里有没有 */
function extractUsageObject(api: ModelApi, body: JsonObject): JsonObject | null {
  const direct = asObject(body.usage)
  if (direct) return direct
  if (api === 'openai-completions') {
    // DeepSeek 风格把最终 usage 塞在 choices[i] 里
    for (const choice of asArray(body.choices)) {
      const found = asObject(asObject(choice)?.usage)
      if (found) return found
    }
    return null
  }
  if (api === 'openai-responses') return asObject(asObject(body.response)?.usage)
  // anthropic：非流式在顶层，流式在 message_start 的 message.usage
  return asObject(asObject(body.message)?.usage)
}

/** 按协议把上游 usage 字段换算成归一化的部分结果 */
function partialFromUsage(api: ModelApi, usage: JsonObject): PartialTokens {
  const out: PartialTokens = {}
  if (api === 'openai-completions') {
    const prompt = countOrUndefined(usage.prompt_tokens)
    const cached =
      countOrUndefined(asObject(usage.prompt_tokens_details)?.cached_tokens) ??
      countOrUndefined(usage.prompt_cache_hit_tokens)
    if (cached !== undefined) out.cacheRead = cached
    if (prompt !== undefined) out.input = Math.max(0, prompt - (cached ?? 0))
    const completion = countOrUndefined(usage.completion_tokens)
    if (completion !== undefined) out.output = completion
    const reasoning = countOrUndefined(asObject(usage.completion_tokens_details)?.reasoning_tokens)
    if (reasoning !== undefined) out.reasoning = reasoning
    return out
  }
  if (api === 'openai-responses') {
    const input = countOrUndefined(usage.input_tokens)
    const cached = countOrUndefined(asObject(usage.input_tokens_details)?.cached_tokens)
    if (cached !== undefined) out.cacheRead = cached
    if (input !== undefined) out.input = Math.max(0, input - (cached ?? 0))
    const output = countOrUndefined(usage.output_tokens)
    if (output !== undefined) out.output = output
    const reasoning = countOrUndefined(asObject(usage.output_tokens_details)?.reasoning_tokens)
    if (reasoning !== undefined) out.reasoning = reasoning
    return out
  }
  // anthropic 的 input_tokens 本身不含缓存，缓存单列两项；reasoning 不单列
  const input = countOrUndefined(usage.input_tokens)
  if (input !== undefined) out.input = input
  const cacheRead = countOrUndefined(usage.cache_read_input_tokens)
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  const cacheWrite = countOrUndefined(usage.cache_creation_input_tokens)
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
  const output = countOrUndefined(usage.output_tokens)
  if (output !== undefined) out.output = output
  if (Object.keys(out).length > 0) out.reasoning = 0
  return out
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/** 合并多次出现的 usage：OpenAI 取最后出现的（字段级覆盖），Anthropic 输入类取非零较大值 */
function mergePartial(api: ModelApi, prev: PartialTokens | null, next: PartialTokens): PartialTokens {
  if (!prev) return { ...next }
  if (api === 'anthropic-messages') {
    return {
      input: maxDefined(prev.input, next.input),
      cacheRead: maxDefined(prev.cacheRead, next.cacheRead),
      cacheWrite: maxDefined(prev.cacheWrite, next.cacheWrite),
      // output 是累计值：最后一个 message_delta 的才是终值
      output: next.output ?? prev.output,
      reasoning: next.reasoning ?? prev.reasoning,
    }
  }
  return {
    input: next.input ?? prev.input,
    cacheRead: next.cacheRead ?? prev.cacheRead,
    cacheWrite: next.cacheWrite ?? prev.cacheWrite,
    output: next.output ?? prev.output,
    reasoning: next.reasoning ?? prev.reasoning,
  }
}

function hasAnyCount(partial: PartialTokens): boolean {
  return Object.keys(partial).length > 0
}

function tokensFromPartial(partial: PartialTokens): RelayUsageTokens {
  return {
    input: partial.input ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
    output: partial.output ?? 0,
    reasoning: partial.reasoning ?? 0,
  }
}

/** 只取「正文文本增量」，thinking/工具参数等不计入输出估算 */
function extractOutputText(api: ModelApi, body: JsonObject): string {
  if (api === 'openai-completions') {
    let out = ''
    for (const choice of asArray(body.choices)) {
      const content = asObject(asObject(choice)?.delta)?.content
      if (typeof content === 'string') out += content
    }
    return out
  }
  if (api === 'openai-responses') {
    return body.type === 'response.output_text.delta' && typeof body.delta === 'string' ? body.delta : ''
  }
  if (body.type !== 'content_block_delta') return ''
  const delta = asObject(body.delta)
  return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : ''
}

/**
 * 非流式：从上游响应体的 JSON（已 JSON.parse 的对象）解析 usage；拿不到返回 null。
 * 字段缺失一律按 0，出现负数/非整数按 0。
 */
export function parseUsageFromJson(api: ModelApi, body: unknown): RelayUsageTokens | null {
  const obj = asObject(body)
  if (!obj) return null
  const usage = extractUsageObject(api, obj)
  if (!usage) return null
  const partial = partialFromUsage(api, usage)
  if (!hasAnyCount(partial)) return null
  return tokensFromPartial(partial)
}

/** 从完整响应字节（非流式）解析 usage 的便捷函数：先 JSON.parse，失败返回 null */
export function parseUsageFromBytes(api: ModelApi, bytes: Uint8Array): RelayUsageTokens | null {
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  return parseUsageFromJson(api, body)
}

/** 各协议「这次生成已经结束」的事件（见 StreamUsageParser.sawComplete） */
function isTerminalEvent(api: ModelApi, obj: JsonObject): boolean {
  if (api === 'openai-completions') {
    return asArray(obj.choices).some((choice) => {
      const reason = asObject(choice)?.finish_reason
      return typeof reason === 'string' && reason !== ''
    })
  }
  if (api === 'anthropic-messages') return obj.type === 'message_stop'
  return obj.type === 'response.completed' || obj.type === 'response.incomplete'
}

/**
 * 建一个 SSE 旁路解析器。
 * 逐行处理而不是按事件处理：上游会任意切块，按「行」才不依赖事件边界；
 * 半个事件留在缓冲区里等下一块，JSON 坏行/截断行静默丢弃（不影响透传）。
 */
export function createStreamUsageParser(api: ModelApi): StreamUsageParser {
  const decoder = new TextDecoder()
  let buffer = ''
  let partial: PartialTokens | null = null
  let done = false
  let complete = false
  let text = ''

  const handleEvent = (obj: JsonObject): void => {
    if (isTerminalEvent(api, obj)) complete = true
    text += extractOutputText(api, obj)
    const usage = extractUsageObject(api, obj)
    if (!usage) return
    const next = partialFromUsage(api, usage)
    if (!hasAnyCount(next)) return
    partial = mergePartial(api, partial, next)
  }

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim()
    // 空行、`: ping` 注释、`event:` 行都跳过；事件类型从 data 的 JSON 里取（anthropic 的 JSON 也带 type）
    if (line === '' || line.startsWith(':')) return
    if (!line.startsWith(DATA_PREFIX)) return
    const payload = line.slice(DATA_PREFIX.length).trim()
    if (payload === '') return
    if (payload === DONE_MARKER) {
      done = true
      complete = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    const obj = asObject(parsed)
    if (obj) handleEvent(obj)
  }

  return {
    push(chunk: Uint8Array | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    usage(): RelayUsageTokens | null {
      return partial ? tokensFromPartial(partial) : null
    },
    sawDone(): boolean {
      return done
    },
    sawComplete(): boolean {
      return complete
    },
    outputText(): string {
      return text
    },
  }
}
