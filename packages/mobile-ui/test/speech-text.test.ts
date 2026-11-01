/**
 * 0.4.3 朗读文本准备：Markdown → 纯文本 → ≤ maxChars 的段。
 *
 * 覆盖任务包要求的全部分支：代码块、表格、图片、链接、引用角标/脚注、公式、emoji、
 * 标题、列表、中英混排、数字与小数点、超长句在逗号处切、过短句合并。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEECH_MAX_CHARS,
  SPEECH_TOKENS,
  markdownToSpeechText,
  prepareSpeechText,
  splitLongSentence,
  splitSpeechSegments,
  splitSpeechSentences,
} from '@/lib/speech-text'

/** 每段都不超过 maxChars（切段的核心不变量）。 */
function expectWithin(segments: string[], maxChars: number): void {
  for (const segment of segments) {
    expect(Array.from(segment).length, `「${segment}」超长`).toBeLessThanOrEqual(maxChars)
  }
}

describe('markdownToSpeechText：结构替换', () => {
  it('代码块读成「这里有一段代码」', () => {
    const md = `先看这段：

\`\`\`ts
const a = 1
console.log(a)
\`\`\`

再继续。`
    const text = markdownToSpeechText(md)
    expect(text).toContain(SPEECH_TOKENS.code)
    expect(text).not.toContain('const a')
    expect(text).not.toContain('```')
    expect(text).toContain('再继续')
  })

  it('嵌套反引号的代码块也只读一句占位语', () => {
    const md = ['````md', '```ts', 'const a = 1', '```', '````', '结束'].join('\n')
    const text = markdownToSpeechText(md)
    expect(text.match(/这里有一段代码/g)).toHaveLength(1)
    expect(text).not.toContain('const a')
  })

  it('没闭合的代码块（流式半截回复）也不念代码', () => {
    const text = markdownToSpeechText('说明如下：\n\n```py\ndef f():\n    return 1')
    expect(text).toContain(SPEECH_TOKENS.code)
    expect(text).not.toContain('return 1')
  })

  it('表格读成「这里有一张表格」，表头与单元格不念出来', () => {
    const md = `进度如下：

| 阶段 | 状态 |
| --- | --- |
| 登录 | 完成 |
| 唤醒 | 进行中 |

继续。`
    const text = markdownToSpeechText(md)
    expect(text).toContain(SPEECH_TOKENS.table)
    expect(text).not.toContain('阶段')
    expect(text).not.toContain('进行中')
    expect(text).toContain('继续')
  })

  it('公式读成「这里有一个公式」（行内 / 块级 / 括号写法）', () => {
    const text = markdownToSpeechText(
      ['质能方程 $E = mc^2$ 很出名。', '', '$$', '\\int_0^1 x dx', '$$', '', '另一种 \\(a+b\\) 与', '\\[c+d\\]'].join(
        '\n',
      ),
    )
    expect(text.match(/这里有一个公式/g)?.length).toBe(4)
    expect(text).not.toContain('mc^2')
    expect(text).not.toContain('\\int')
  })

  it('图片整段丢掉', () => {
    const text = markdownToSpeechText('看图：![架构图](/workspace/a.png) 就这样。')
    expect(text).not.toContain('架构图')
    expect(text).not.toContain('png')
    expect(text).toBe('看图： 就这样。'.replace('  ', ' '))
  })

  it('链接只读文字，不读地址', () => {
    const text = markdownToSpeechText('参考 [官方文档](https://example.com/a?b=1) 与 [脚注][1]。')
    expect(text).toContain('官方文档')
    expect(text).toContain('脚注')
    expect(text).not.toContain('https://example.com')
    expect(text).not.toContain('](')
  })

  it('引用角标与脚注标记都去掉', () => {
    const text = markdownToSpeechText('这句话来自[1]与[2,3]，还有[^4]与^[手写注]。')
    expect(text).not.toContain('[1]')
    expect(text).not.toContain('[^4]')
    expect(text).not.toContain('手写注')
    expect(text).toBe('这句话来自与，还有与。')
  })

  it('emoji 与多余符号去掉', () => {
    const text = markdownToSpeechText('搞定 ✅🎉 了 **很快** ~~旧~~ ~新~')
    expect(text).toBe('搞定 了 很快 旧 新')
  })

  it('标题与列表记号去掉，文字保留', () => {
    const text = markdownToSpeechText(['# 一级标题', '', '## 二级标题', '', '- 第一条', '* 第二条', '1. 第三条'].join('\n'))
    expect(text).toBe('一级标题\n二级标题\n第一条\n第二条\n第三条')
  })

  it('引用块去掉 `>`，分隔线整行丢掉', () => {
    const text = markdownToSpeechText(['> 引用的一句话。', '', '---', '', '***', '正文。'].join('\n'))
    expect(text).toBe('引用的一句话。\n正文。')
  })

  it('HTML 标签清掉但保留文字；`3 < 5` 这种比较不会被当成标签吃掉', () => {
    const text = markdownToSpeechText('<p>第一段</p><br/>第二段 3 < 5 and 5 > 2 是对的')
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('<br')
    expect(text).toContain('第一段')
    expect(text).toContain('3 < 5 and 5 > 2')
  })

  it('空输入 / 纯符号 → 空文本', () => {
    expect(markdownToSpeechText('')).toBe('')
    expect(markdownToSpeechText('   \n\n  ')).toBe('')
    expect(markdownToSpeechText('---\n***\n')).toBe('')
    expect(markdownToSpeechText('🎉🎉🎉')).toBe('')
  })
})

describe('splitSpeechSentences：切句边界', () => {
  it('按中文句末标点切，句末引号留在本句', () => {
    expect(splitSpeechSentences('他说「好的。」然后走了。第二句！第三句？')).toEqual([
      '他说「好的。」',
      '然后走了。',
      '第二句！',
      '第三句？',
    ])
  })

  it('换行也是句子边界（列表项一行一句）', () => {
    expect(splitSpeechSentences('第一行\n第二行\n\n第三行')).toEqual(['第一行', '第二行', '第三行'])
  })

  it('小数点 / 版本号 / 域名不被切断', () => {
    expect(splitSpeechSentences('圆周率是 3.14。版本 v1.2.3 已发布。邮箱 a@b.com 可用')).toEqual([
      '圆周率是 3.14。',
      '版本 v1.2.3 已发布。',
      '邮箱 a@b.com 可用',
    ])
  })

  it('英文句号要跟空白才算句末（中英混排）', () => {
    expect(splitSpeechSentences('Use the API. Then stop. 完成了吗？')).toEqual([
      'Use the API.',
      'Then stop.',
      '完成了吗？',
    ])
  })

  it('连续感叹号/省略号算一句', () => {
    expect(splitSpeechSentences('太快了！！真的吗？！等等……')).toEqual(['太快了！！', '真的吗？！', '等等……'])
  })
})

describe('splitLongSentence：逗号处切分', () => {
  it('在逗号后切，每块不超过上限，且切点落在标点后', () => {
    const sentence =
      '第一段内容比较长一点，第二段内容也不短，第三段继续说下去，第四段再补两句，第五段继续说下去，第六段收尾。'
    const pieces = splitLongSentence(sentence, 20)
    expectWithin(pieces, 20)
    expect(pieces.length).toBeGreaterThan(2)
    // 拼起来不丢字
    expect(pieces.join('')).toBe(sentence)
    // 切点都在标点后，读起来是完整的短句（最后一块是收尾，不一定带逗号）
    for (const piece of pieces.slice(0, -1)) {
      expect(/[，、,;]$/.test(piece)).toBe(true)
    }
  })

  it('没有逗号时硬切，但不会把数字切成两半', () => {
    const sentence = `${'很长的句子'.repeat(4)}3.1415926${'继续'.repeat(4)}`
    const pieces = splitLongSentence(sentence, 16)
    expectWithin(pieces, 16)
    // 所有块拼起来要等于原句（不丢字）
    expect(pieces.join('')).toBe(sentence)
    // 小数点两侧的数字必须留在同一块里
    const joined = pieces.find((piece) => piece.includes('3.14') || piece.includes('1415'))
    expect(joined).toBeDefined()
    expect(pieces.some((piece) => piece.startsWith('1592') || piece.startsWith('5926'))).toBe(false)
  })

  it('1,000 这种千分位也不会被切成两块', () => {
    const sentence = `${'数字说明'.repeat(5)}1,000${'单位的说明'.repeat(5)}`
    const pieces = splitLongSentence(sentence, 12)
    expectWithin(pieces, 12)
    expect(pieces.some((piece) => piece.endsWith('1,') || piece.startsWith('000'))).toBe(false)
  })
})

describe('splitSpeechSegments：合并与上限', () => {
  it('过短的句子合并，长句各自成段', () => {
    // 前两句（6 字）短于阈值 → 合并；第三句已经够长，单独成段
    const segments = splitSpeechSegments('好的。收到。今天我们先把发布清单过一遍。', { maxChars: 50, minChars: 6 })
    expect(segments).toEqual(['好的。收到。', '今天我们先把发布清单过一遍。'])
  })

  it('每段都不超过 maxChars（长回复逐段合规）', () => {
    const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}句在这里说明一件事情，里面还有逗号，也有数字 3.14。`).join('')
    const segments = splitSpeechSegments(text, { maxChars: 40 })
    expectWithin(segments, 40)
    expect(segments.length).toBeGreaterThan(4)
  })

  it('maxChars 很小时也能保证不超（含硬切）', () => {
    const segments = splitSpeechSegments('一二三四五六七八九十，甲乙丙丁戊己庚辛壬癸。', { maxChars: 8 })
    expectWithin(segments, 8)
    // 22 个字 + 一个逗号 → 至少 3 段（8/8/6）
    expect(segments.length).toBeGreaterThanOrEqual(3)
  })

  it('空文本 → 空数组', () => {
    expect(splitSpeechSegments('')).toEqual([])
    expect(splitSpeechSegments('   \n ')).toEqual([])
  })
})

describe('prepareSpeechText：端到端', () => {
  const reply = `收到！我先按你的要求把这件事**拆开做**，每一步都给你可核对的结果。

### 先做什么

1. 读一遍现有的接口定义，确认字段没有漂移
2. 用本地假服务跑通登录、唤醒、发送和停止
3. 断线之后带游标续传，确认不重复也不丢字

### 进度

| 阶段 | 状态 |
| --- | --- |
| 登录 | 完成 |
| 唤醒 | 进行中 |

代码示例：

\`\`\`bash
pnpm install
\`\`\`

参考 [Hub 文档](https://hub.example/docs)[1]，公式 $E=mc^2$ 先跳过 ✅`

  it('纯文本没有 Markdown 残留，且包含三种占位语', () => {
    const { text } = prepareSpeechText(reply)
    expect(text).toContain(SPEECH_TOKENS.code)
    expect(text).toContain(SPEECH_TOKENS.table)
    expect(text).toContain(SPEECH_TOKENS.math)
    expect(text).not.toContain('pnpm install')
    expect(text).not.toContain('| 阶段')
    expect(text).not.toContain('https://hub.example')
    expect(text).not.toContain('**')
    expect(text).not.toContain('✅')
    expect(text).not.toContain('E=mc^2')
  })

  it('切出来的段每段 ≤ 200，拼起来覆盖全文', () => {
    const { text, segments, chars } = prepareSpeechText(reply)
    expect(segments.length).toBeGreaterThan(3)
    expectWithin(segments, DEFAULT_SPEECH_MAX_CHARS)
    expect(chars).toBe(Array.from(text).length)
    // 段与段之间只差空白/标点，不丢正文
    const joined = segments.join('')
    for (const token of ['这里有一段代码', '这里有一张表格', '这里有一个公式', '收到']) {
      expect(joined).toContain(token)
    }
  })

  it('maxChars 由调用方决定（bootstrap 的 200 或更小）', () => {
    const { segments } = prepareSpeechText(reply, { maxChars: 30 })
    expectWithin(segments, 30)
  })

  it('只有代码/表格的回复也能读出占位语（不会变成空）', () => {
    const { segments } = prepareSpeechText('```js\nconst a = 1\n```')
    expect(segments).toEqual([SPEECH_TOKENS.code])
  })

  it('纯 emoji 回复 → 没有可朗读内容', () => {
    const { segments, chars } = prepareSpeechText('🎉🎉👍')
    expect(segments).toEqual([])
    expect(chars).toBe(0)
  })
})
