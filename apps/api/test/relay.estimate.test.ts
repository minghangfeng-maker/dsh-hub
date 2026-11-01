import { describe, expect, it } from 'vitest'
import {
  collectRequestText,
  estimateInputTokens,
  estimateTokensFromText,
} from '../src/modules/relay/estimate.js'

/** 12 §6.3 的估算：中日韩按字、其他按 1/4，且不把 base64 算进去。 */

const LONG_BASE64 = 'A'.repeat(600)

describe('estimateTokensFromText', () => {
  it('空文本为 0', () => {
    expect(estimateTokensFromText('')).toBe(0)
  })

  it('中日韩字符（汉字 / 假名 / 谚文 / 全角标点）按 1 token', () => {
    expect(estimateTokensFromText('你好')).toBe(2)
    expect(estimateTokensFromText('ひらがな')).toBe(4)
    expect(estimateTokensFromText('한국어')).toBe(3)
    expect(estimateTokensFromText('你好，世界！')).toBe(6)
    expect(estimateTokensFromText('漢字カナ')).toBe(4)
  })

  it('其他字符按 1/4，向上取整', () => {
    expect(estimateTokensFromText('abcd')).toBe(1)
    expect(estimateTokensFromText('abcde')).toBe(2)
    expect(estimateTokensFromText('hello world')).toBe(3)
    expect(estimateTokensFromText('Ω')).toBe(1)
    expect(estimateTokensFromText('😀')).toBe(1)
  })

  it('中日韩与其他字符混合相加', () => {
    expect(estimateTokensFromText('你好world')).toBe(4)
    expect(estimateTokensFromText('你a')).toBe(2)
  })
})

describe('collectRequestText', () => {
  it('递归取所有字符串值（含键名以外的 role/type），用 \\n 连接', () => {
    const body = {
      model: 'gpt-4o',
      stream: true,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
    }
    expect(collectRequestText(body)).toBe('gpt-4o\nsystem\n你是助手\nuser\ntext\n你好')
  })

  it('数组保持书写顺序，非字符串标量忽略', () => {
    expect(collectRequestText(['a', ['b', { c: 'd' }]])).toBe('a\nb\nd')
    expect(collectRequestText({ a: 1, b: true, c: null, d: undefined, e: 'x' })).toBe('x')
  })

  it('超长 base64 字符串跳过，短的原样计入', () => {
    expect(collectRequestText({ content: LONG_BASE64 })).toBe('')
    expect(collectRequestText({ content: 'QUJD' })).toBe('QUJD')
    // 含换行的 base64 也认
    expect(collectRequestText({ content: `${'A'.repeat(300)}\n${'B'.repeat(300)}` })).toBe('')
  })

  it('data: URL 与 http(s) URL 跳过', () => {
    expect(collectRequestText({ content: 'data:image/png;base64,AAAA' })).toBe('')
    expect(collectRequestText({ content: 'https://example.com/a.png' })).toBe('')
    expect(collectRequestText({ content: 'http://example.com/a.png' })).toBe('')
    expect(collectRequestText({ content: 'a https://example.com 不是开头' })).toBe(
      'a https://example.com 不是开头',
    )
  })

  it('image / b64 / base64 / signature 开头的键整棵子树跳过', () => {
    const body = {
      messages: [{ role: 'user', content: '看这张图' }],
      image: { url: 'https://example.com/a.png' },
      image_url: { url: 'https://example.com/a.png', detail: 'high' },
      b64_json: 'QUJD',
      base64Data: 'QUJD',
      signature: { nested: 'sig-value' },
    }
    expect(collectRequestText(body)).toBe('user\n看这张图')
  })

  it('Anthropic 图片块的 base64 载荷不计入估算', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: LONG_BASE64 } },
          ],
        },
      ],
    }
    const text = collectRequestText(body)
    expect(text).not.toContain(LONG_BASE64)
    expect(estimateTokensFromText(text)).toBeLessThan(50)
  })

  it('空值 / 非对象返回空串', () => {
    expect(collectRequestText(null)).toBe('')
    expect(collectRequestText(undefined)).toBe('')
    expect(collectRequestText(42)).toBe('')
    expect(collectRequestText({})).toBe('')
    expect(collectRequestText([])).toBe('')
  })
})

describe('estimateInputTokens', () => {
  it('等于 estimateTokensFromText(collectRequestText(body))', () => {
    const body = {
      model: 'gpt-4o',
      stream: true,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
    }
    expect(estimateInputTokens(body)).toBe(estimateTokensFromText(collectRequestText(body)))
    expect(estimateInputTokens(body)).toBe(13)
  })

  it('Pascal 体：只有正文被算进去', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], image_url: 'data:image/png;base64,AAAA' }
    expect(estimateInputTokens(body)).toBe(estimateTokensFromText('user\nhi'))
  })

  it('空请求为 0', () => {
    expect(estimateInputTokens({})).toBe(0)
    expect(estimateInputTokens(null)).toBe(0)
  })
})
