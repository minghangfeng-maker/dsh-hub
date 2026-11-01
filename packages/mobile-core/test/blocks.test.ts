import { describe, expect, it } from 'vitest'
import { diffBlocks, splitMarkdownBlocks, stableBlockCount } from '../src/markdown/blocks.js'

describe('splitMarkdownBlocks', () => {
  it('按空白行切段，只有尾部未闭合', () => {
    const blocks = splitMarkdownBlocks('# 标题\n\n第一段\n\n第二段还在写')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(blocks.map((b) => b.closed)).toEqual([true, true, false])
  })

  it('未闭合的代码围栏吞掉后面所有内容，且保持 open', () => {
    const blocks = splitMarkdownBlocks('前言\n\n```ts\nconst a = 1\n\nconst b = 2')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]?.kind).toBe('fence')
    expect(blocks[1]?.closed).toBe(false)
    expect(blocks[1]?.source).toContain('const b = 2')
  })

  it('闭合的代码围栏可以缓存', () => {
    const blocks = splitMarkdownBlocks('```js\nlet x = 1\n```\n\n后面')
    expect(blocks[0]).toMatchObject({ kind: 'fence', closed: true })
  })

  it('$$ 公式块未闭合时保持 open', () => {
    const blocks = splitMarkdownBlocks('前文\n\n$$\n\\frac{a}{b}')
    expect(blocks[1]?.kind).toBe('math')
    expect(blocks[1]?.closed).toBe(false)
  })

  it('单行 $$...$$ 公式立即闭合', () => {
    const blocks = splitMarkdownBlocks('$$E=mc^2$$\n\n说明')
    expect(blocks[0]).toMatchObject({ kind: 'math', closed: true })
  })

  it('表格逐行累加在同一个块里，遇到空白行才闭合', () => {
    const part1 = '| 模型 | 速度 |\n| --- | --- |\n| V4 | 快'
    const blocks = splitMarkdownBlocks(part1)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('table')
    expect(blocks[0]?.closed).toBe(false)

    const part2 = part1 + ' |\n\n收尾段落'
    const blocks2 = splitMarkdownBlocks(part2)
    expect(blocks2[0]).toMatchObject({ kind: 'table', closed: true })
    expect(blocks2[1]?.kind).toBe('paragraph')
  })

  it('列表项和松散列表合为一块', () => {
    const blocks = splitMarkdownBlocks('- 一\n- 二\n\n- 三\n\n结束')
    expect(blocks[0]?.kind).toBe('list')
    expect(blocks[0]?.source.split('\n')).toHaveLength(4) // - 一 / - 二 / 空行 / - 三
    expect(blocks[0]?.closed).toBe(true)
  })

  it('引用块与分隔线', () => {
    const blocks = splitMarkdownBlocks('> 引用一\n> 引用二\n\n---\n\n正文')
    expect(blocks.map((b) => b.kind)).toEqual(['blockquote', 'hr', 'paragraph'])
    expect(blocks[0]?.closed).toBe(true)
  })

  it('最后一块在流式中 never 闭合（哪怕语法上已经完整）', () => {
    const blocks = splitMarkdownBlocks('# 只有标题')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.closed).toBe(false)
  })

  it('空文本返回空数组', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })
})

describe('流式追加的前缀稳定性（缓存能否复用）', () => {
  const final = [
    '# 标题一',
    '',
    '这是一段中文长段落，用来验证分块在追加时前缀不变。',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '结尾',
  ].join('\n')

  it('逐字追加时，已闭合的块内容始终是最终内容的前缀', () => {
    let lastStable = 0
    let prevSources: string[] = []
    for (let n = 1; n <= final.length; n++) {
      const blocks = splitMarkdownBlocks(final.slice(0, n))
      const stable = stableBlockCount(blocks)
      expect(stable).toBeGreaterThanOrEqual(lastStable) // 已闭合的块数只增不减
      const sources = blocks.slice(0, stable).map((b) => b.source)
      // 之前已经闭合的块，内容不能再变
      expect(sources.slice(0, prevSources.length)).toEqual(prevSources)
      prevSources = sources
      lastStable = stable
    }
    // 设计约定：除最后一块外都已闭合，最后一块永远视为「还在写」
    const all = splitMarkdownBlocks(final)
    expect(all.slice(0, -1).every((b) => b.closed)).toBe(true)
    expect(all[all.length - 1]?.closed).toBe(false)
  })

  it('diffBlocks 只把尾部未闭合的块算作需要重渲染', () => {
    const prev = splitMarkdownBlocks('# 标题\n\n段落已经写完\n\n正在写的段')
    const next = splitMarkdownBlocks('# 标题\n\n段落已经写完\n\n正在写的段落更长了')
    const diff = diffBlocks(prev, next)
    expect(diff.reuse).toBe(2)
    expect(diff.render).toHaveLength(1)
    expect(diff.render[0]?.source).toContain('更长了')
  })
})
