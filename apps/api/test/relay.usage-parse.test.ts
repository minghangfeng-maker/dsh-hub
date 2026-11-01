import type { ModelApi } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  createStreamUsageParser,
  parseUsageFromBytes,
  parseUsageFromJson,
  type StreamUsageParser,
} from '../src/modules/relay/usage-parse.js'

/** 三协议 × 流式/非流式的 usage 解析（12 §5.5）。 */

const ZERO = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 按固定字节数切块喂入，模拟 TCP/SSE 的任意切分 */
function feedBySize(api: ModelApi, text: string, size: number): StreamUsageParser {
  const parser = createStreamUsageParser(api)
  const bytes = bytesOf(text)
  for (let i = 0; i < bytes.length; i += size) parser.push(bytes.subarray(i, i + size))
  return parser
}

describe('parseUsageFromJson：非流式', () => {
  it('openai-completions：prompt 含缓存，input 扣掉 cacheRead，reasoning 单列', () => {
    const usage = parseUsageFromJson('openai-completions', {
      id: 'x',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    })
    expect(usage).toEqual({ input: 200, cacheRead: 800, cacheWrite: 0, output: 200, reasoning: 50 })
  })

  it('openai-completions：缓存字段三种写法', () => {
    const base = { usage: { prompt_tokens: 1000, completion_tokens: 10 } }
    // 1) prompt_tokens_details.cached_tokens
    expect(
      parseUsageFromJson('openai-completions', {
        ...base,
        usage: { ...base.usage, prompt_tokens_details: { cached_tokens: 800 } },
      }),
    ).toMatchObject({ input: 200, cacheRead: 800 })
    // 2) DeepSeek 的 prompt_cache_hit_tokens
    expect(
      parseUsageFromJson('openai-completions', {
        ...base,
        usage: { ...base.usage, prompt_cache_hit_tokens: 900 },
      }),
    ).toMatchObject({ input: 100, cacheRead: 900 })
    // 3) 都没有 → cacheRead 0，input = prompt_tokens
    expect(parseUsageFromJson('openai-completions', base)).toMatchObject({ input: 1000, cacheRead: 0 })
    // `??` 语义：cached_tokens 明确为 0 时不回退到 prompt_cache_hit_tokens
    expect(
      parseUsageFromJson('openai-completions', {
        usage: {
          prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 0 },
          prompt_cache_hit_tokens: 500,
        },
      }),
    ).toMatchObject({ input: 1000, cacheRead: 0 })
  })

  it('openai-completions：DeepSeek 风格把 usage 放在 choices[i] 里也能解析', () => {
    const usage = parseUsageFromJson('openai-completions', {
      choices: [{ index: 0, usage: { prompt_tokens: 50, completion_tokens: 7 } }],
    })
    expect(usage).toEqual({ ...ZERO, input: 50, output: 7 })
  })

  it('openai-responses：input 含缓存，扣掉 cached_tokens', () => {
    const usage = parseUsageFromJson('openai-responses', {
      usage: {
        input_tokens: 500,
        output_tokens: 60,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    })
    expect(usage).toEqual({ input: 400, cacheRead: 100, cacheWrite: 0, output: 60, reasoning: 20 })
  })

  it('anthropic-messages：input 不含缓存，缓存两项单列，reasoning 恒 0', () => {
    const usage = parseUsageFromJson('anthropic-messages', {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 40,
      },
    })
    expect(usage).toEqual({ input: 100, cacheRead: 20, cacheWrite: 30, output: 40, reasoning: 0 })
  })

  it('字段缺失一律按 0', () => {
    expect(parseUsageFromJson('openai-completions', { usage: { prompt_tokens: 10 } })).toEqual({
      ...ZERO,
      input: 10,
    })
    expect(parseUsageFromJson('anthropic-messages', { usage: { output_tokens: 3 } })).toEqual({
      ...ZERO,
      output: 3,
    })
  })

  it('负数与非整数按 0，字符串数字也当缺失', () => {
    expect(
      parseUsageFromJson('openai-completions', {
        usage: {
          prompt_tokens: -5,
          completion_tokens: 2.5,
          prompt_tokens_details: { cached_tokens: -1 },
          completion_tokens_details: { reasoning_tokens: '9' },
        },
      }),
    ).toEqual(ZERO)
    expect(
      parseUsageFromJson('openai-responses', {
        usage: { input_tokens: -1, output_tokens: 1.5, input_tokens_details: { cached_tokens: -2 } },
      }),
    ).toEqual(ZERO)
  })

  it('拿不到 usage 时返回 null', () => {
    expect(parseUsageFromJson('openai-completions', { choices: [] })).toBeNull()
    expect(parseUsageFromJson('openai-completions', { usage: null })).toBeNull()
    expect(parseUsageFromJson('openai-responses', { response: { usage: null } })).toBeNull()
    expect(parseUsageFromJson('anthropic-messages', { message: {} })).toBeNull()
    expect(parseUsageFromJson('anthropic-messages', null)).toBeNull()
    expect(parseUsageFromJson('anthropic-messages', 'nope')).toBeNull()
    expect(parseUsageFromJson('anthropic-messages', [1, 2])).toBeNull()
    // usage 对象里一个可识别字段都没有 → 当作没拿到
    expect(parseUsageFromJson('openai-completions', { usage: {} })).toBeNull()
  })

  it('parseUsageFromBytes：合法 JSON 走同一条路，坏 JSON 返回 null', () => {
    const body = { usage: { prompt_tokens: 30, completion_tokens: 4 } }
    expect(parseUsageFromBytes('openai-completions', bytesOf(JSON.stringify(body)))).toEqual({
      ...ZERO,
      input: 30,
      output: 4,
    })
    expect(parseUsageFromBytes('openai-completions', bytesOf('{"usage":'))).toBeNull()
    expect(parseUsageFromBytes('openai-completions', bytesOf('null'))).toBeNull()
    expect(parseUsageFromBytes('openai-completions', new Uint8Array())).toBeNull()
  })
})

describe('流式：openai-completions', () => {
  const stream = [
    'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}',
    '',
    ': ping',
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"你"}}]}',
    '',
    'event: message',
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"好"}}]}',
    '',
    'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"想一下"}}]}',
    '',
    'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
    '',
    'data: {"id":"1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":5}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  it('一个 chunk 喂完：usage 换算正确，输出只算正文增量，见到 [DONE]', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push(stream)
    expect(parser.usage()).toEqual({ input: 60, cacheRead: 40, cacheWrite: 0, output: 20, reasoning: 5 })
    expect(parser.outputText()).toBe('你好')
    expect(parser.sawDone()).toBe(true)
  })

  it('任意切分（含切在半个事件、半个 data 行、多字节字符中间）结果一致', () => {
    const whole = createStreamUsageParser('openai-completions')
    whole.push(stream)
    for (const size of [1, 2, 3, 7, 64]) {
      const parser = feedBySize('openai-completions', stream, size)
      expect(parser.usage(), `chunk=${size}`).toEqual(whole.usage())
      expect(parser.outputText(), `chunk=${size}`).toBe('你好')
      expect(parser.sawDone(), `chunk=${size}`).toBe(true)
    }
  })

  it('一个事件被拆成两个 chunk 也能解析', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push('data: {"choices":[{"delta":{"content":"he')
    parser.push('llo"}}]}\n\ndata: {"usage":{"prompt_tokens":8,')
    parser.push('"completion_tokens":2}}\n\n')
    expect(parser.outputText()).toBe('hello')
    expect(parser.usage()).toEqual({ ...ZERO, input: 8, output: 2 })
  })

  it('多个 usage chunk：最后一个生效（字段级覆盖）', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push('data: {"usage":{"prompt_tokens":50,"completion_tokens":7}}\n\n')
    parser.push(
      'data: {"usage":{"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
    )
    expect(parser.usage()).toEqual({ ...ZERO, input: 50, output: 9, reasoning: 2 })
  })

  it('usage 藏在 choices[i].usage 里（DeepSeek 风格）', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push(
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"usage":{"prompt_tokens":50,"completion_tokens":7}}]}\n\n',
    )
    expect(parser.usage()).toEqual({ ...ZERO, input: 50, output: 7 })
  })

  it('没有 usage 的流返回 null，且不因坏行抛错', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    expect(parser.usage()).toBeNull()
    expect(parser.sawDone()).toBe(false)
    // 截断的 JSON、非 data 行、半个事件留在缓冲区，都不能抛
    expect(() => parser.push('data: {"usage":{"prompt_tokens":1\n')).not.toThrow()
    expect(() => parser.push('data: [DONE]\n\nnoise\n')).not.toThrow()
    expect(parser.usage()).toBeNull()
    expect(parser.sawDone()).toBe(true)
    expect(parser.outputText()).toBe('hi')
  })

  it('`data:[DONE]` 与 `data:   [DONE]` 都认', () => {
    for (const marker of ['data:[DONE]', 'data:   [DONE]', 'data: [DONE] ']) {
      const parser = createStreamUsageParser('openai-completions')
      parser.push(`${marker}\n\n`)
      expect(parser.sawDone(), marker).toBe(true)
      expect(parser.usage(), marker).toBeNull()
    }
  })
})

describe('流式：openai-responses', () => {
  const stream = [
    'data: {"type":"response.created","response":{"id":"r1","usage":null}}',
    '',
    'data: {"type":"response.output_text.delta","delta":"你"}',
    '',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"想想"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"好"}',
    '',
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":300,"output_tokens":40,"input_tokens_details":{"cached_tokens":120},"output_tokens_details":{"reasoning_tokens":8}}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  it('只在 response.completed 取 usage，文本只算 output_text.delta', () => {
    const parser = createStreamUsageParser('openai-responses')
    parser.push(stream)
    expect(parser.usage()).toEqual({ input: 180, cacheRead: 120, cacheWrite: 0, output: 40, reasoning: 8 })
    expect(parser.outputText()).toBe('你好')
    expect(parser.sawDone()).toBe(true)
  })

  it('response.usage 为 null 的事件不算 usage；任意切分结果一致', () => {
    const early = createStreamUsageParser('openai-responses')
    early.push('data: {"type":"response.created","response":{"usage":null}}\n\n')
    expect(early.usage()).toBeNull()
    const whole = createStreamUsageParser('openai-responses')
    whole.push(stream)
    for (const size of [1, 5, 33]) {
      const parser = feedBySize('openai-responses', stream, size)
      expect(parser.usage(), `chunk=${size}`).toEqual(whole.usage())
      expect(parser.outputText(), `chunk=${size}`).toBe('你好')
    }
  })
})

describe('流式：anthropic-messages', () => {
  const stream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"嗯"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
    '',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  it('message_start 给输入+缓存，最后一个 message_delta 给输出', () => {
    const parser = createStreamUsageParser('anthropic-messages')
    parser.push(stream)
    expect(parser.usage()).toEqual({ input: 100, cacheRead: 20, cacheWrite: 30, output: 42, reasoning: 0 })
    expect(parser.outputText()).toBe('你好')
    expect(parser.sawDone()).toBe(false)
  })

  it('message_delta 里也带输入时取非零较大值，输出取最后一个', () => {
    const parser = createStreamUsageParser('anthropic-messages')
    parser.push(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":1}}}\n\n',
    )
    expect(parser.usage()).toEqual({ ...ZERO, input: 100, cacheRead: 20, output: 1 })
    parser.push('data: {"type":"message_delta","usage":{"input_tokens":110,"output_tokens":10}}\n\n')
    expect(parser.usage()).toEqual({ ...ZERO, input: 110, cacheRead: 20, output: 10 })
    parser.push('data: {"type":"message_delta","usage":{"input_tokens":90,"output_tokens":25}}\n\n')
    expect(parser.usage()).toEqual({ ...ZERO, input: 110, cacheRead: 20, output: 25 })
    // 只有 output 的 delta 不能把输入抹成 0
    parser.push('data: {"type":"message_delta","usage":{"output_tokens":30}}\n\n')
    expect(parser.usage()).toEqual({ ...ZERO, input: 110, cacheRead: 20, output: 30 })
  })

  it('任意切分结果一致（含把中文切在字节中间）', () => {
    const whole = createStreamUsageParser('anthropic-messages')
    whole.push(stream)
    for (const size of [1, 4, 17, 128]) {
      const parser = feedBySize('anthropic-messages', stream, size)
      expect(parser.usage(), `chunk=${size}`).toEqual(whole.usage())
      expect(parser.outputText(), `chunk=${size}`).toBe('你好')
    }
  })

  it('没见到 message_start 前 usage 为 null', () => {
    const parser = createStreamUsageParser('anthropic-messages')
    expect(parser.usage()).toBeNull()
    parser.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"嗨"}}\n\n')
    expect(parser.usage()).toBeNull()
    expect(parser.outputText()).toBe('嗨')
  })
})

describe('流式解析器的通用行为', () => {
  it('空行、注释行、event/id 行都不影响解析', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push(
      '\n\n: keep-alive\n\nid: 42\n\nevent: chunk\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n\n',
    )
    expect(parser.usage()).toEqual({ ...ZERO, input: 5, output: 1 })
  })

  it('CRLF 行尾与 string/Uint8Array 混喂也能解析', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push(bytesOf('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n'))
    parser.push('data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\r\n\r\n')
    expect(parser.outputText()).toBe('a')
    expect(parser.usage()).toEqual({ ...ZERO, input: 2, output: 1 })
  })

  it('push 返回 void，多次 usage() 结果稳定', () => {
    const parser = createStreamUsageParser('openai-responses')
    parser.push(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
    )
    const first = parser.usage()
    expect(parser.usage()).toEqual(first)
    expect(parser.usage()).toEqual({ ...ZERO, input: 7, output: 3 })
  })
})

describe('StreamUsageParser.sawComplete：流是否已经讲完', () => {
  it('openai-completions：finish_reason 或 [DONE] 之前都不算讲完，见到任一个就算', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push('data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\n\n')
    expect(parser.sawComplete()).toBe(false)
    parser.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    expect(parser.sawComplete()).toBe(true)
    expect(parser.sawDone()).toBe(false)

    const onlyDone = createStreamUsageParser('openai-completions')
    onlyDone.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
    expect(onlyDone.sawComplete()).toBe(false)
    onlyDone.push('data: [DONE]\n\n')
    expect(onlyDone.sawComplete()).toBe(true)
  })

  it('openai-completions：只带 usage 的事件（上游把 usage 放在第一块里）不算讲完', () => {
    const parser = createStreamUsageParser('openai-completions')
    parser.push(
      'data: {"choices":[{"delta":{"content":"开"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    )
    expect(parser.sawComplete()).toBe(false)
  })

  it('anthropic-messages：message_stop 才算', () => {
    const parser = createStreamUsageParser('anthropic-messages')
    parser.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n')
    expect(parser.sawComplete()).toBe(false)
    parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    expect(parser.sawComplete()).toBe(true)
  })

  it('openai-responses：response.completed / response.incomplete 才算', () => {
    const delta = createStreamUsageParser('openai-responses')
    delta.push('data: {"type":"response.output_text.delta","delta":"你"}\n\n')
    expect(delta.sawComplete()).toBe(false)
    const completed = createStreamUsageParser('openai-responses')
    completed.push(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":2}}}\n\n',
    )
    expect(completed.sawComplete()).toBe(true)
    const incomplete = createStreamUsageParser('openai-responses')
    incomplete.push('data: {"type":"response.incomplete","response":{}}\n\n')
    expect(incomplete.sawComplete()).toBe(true)
  })
})
