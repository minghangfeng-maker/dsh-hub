import { describe, expect, it } from 'vitest'
import { parseFence, renderMarkdown } from '../src/lib/markdown'

describe('Markdown 渲染', () => {
  it('标题与段落', () => {
    const html = renderMarkdown('## 标题\n\n正文一句。')
    expect(html).toContain('<h2>标题</h2>')
    expect(html).toContain('<p>正文一句。</p>')
  })

  it('围栏代码块保留语言类名，且不做 HTML 注入', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2\n```')
    expect(html).toContain('class="language-ts"')
    expect(html).toContain('1 &lt; 2')
  })

  it('表格被包进横向滚动容器', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('md-table-wrap')
    expect(html).toContain('<th>a</th>')
  })

  it('行内公式用 KaTeX 渲染', () => {
    const html = renderMarkdown('当 $a^2+b^2=c^2$ 成立')
    expect(html).toContain('katex')
    expect(html).not.toContain('$a^2')
  })

  it('单行块公式（$$...$$）必须走块级渲染而不是行内', () => {
    const html = renderMarkdown('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$')
    expect(html).toContain('md-math-block')
    expect(html).toContain('katex-display')
    // 不能把结尾的 $ 漏成普通文本
    expect(html).not.toContain('{2}$')
  })

  it('多行块公式', () => {
    const html = renderMarkdown('$$\n\\frac{a}{b}\n$$')
    expect(html).toContain('md-math-block')
    expect(html).toContain('katex-display')
  })

  it('未闭合的 $$ 不阻塞渲染（流式中会出现）', () => {
    const html = renderMarkdown('$$\n\\frac{a}{b}')
    expect(typeof html).toBe('string')
    expect(html.length).toBeGreaterThan(0)
  })

  // ── `\(...\)` / `\[...\]`（0.4.0 收尾：mock 正文里就是这种写法）────────────────
  it('LaTeX 原生行内公式 \\(...\\) 走 KaTeX，而不是被 escape 成普通括号', () => {
    const html = renderMarkdown('行内公式也可以显示：\\(E = mc^2\\)。')
    expect(html).toContain('katex')
    expect(html).toContain('katex-mathml')
    expect(html).not.toContain('(E = mc^2)')
    // KaTeX 的 MathML 里应该有等号两侧的语义标记
    expect(html).toContain('E')
  })

  it('LaTeX 原生块级公式 \\[...\\] 走块级渲染', () => {
    const html = renderMarkdown('\\[\\int_0^1 x\\,dx = \\frac{1}{2}\\]')
    expect(html).toContain('md-math-block')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('\\[')
  })

  it('跨行的 \\[...\\] 也能闭合', () => {
    const html = renderMarkdown('\\[\n\\frac{a}{b}\n\\]')
    expect(html).toContain('md-math-block')
    expect(html).toContain('katex-display')
  })

  it('\\[...\\] 后面跟着正文时不当成块级（不生吞后半句）', () => {
    const html = renderMarkdown('\\[a+b\\] 后面还有说明')
    expect(html).toContain('后面还有说明')
    expect(html).toContain('katex')
  })

  it('段落中间的 $$...$$ 也是 display 公式', () => {
    const html = renderMarkdown('前后都有字 $$a+b$$ 结尾')
    expect(html).toContain('md-math-inline-display')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$$a+b$$')
  })

  // ── 金额保护（「$5 和 $10」不能被当成公式）──────────────────────────────────
  it('金额不被当成公式：$5 和 $10', () => {
    const html = renderMarkdown('一共 $5 和 $10 两笔')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
  })

  it('金额不被当成公式：连写的 $5和$10、区间 $100-$200', () => {
    const tight = renderMarkdown('花了 $5和$10')
    expect(tight).not.toContain('katex')
    expect(tight).toContain('$5和$10')
    const range = renderMarkdown('预算 $100-$200 之间')
    expect(range).not.toContain('katex')
    expect(range).toContain('$100-$200')
  })

  it('真正的公式紧挨着中文仍然渲染（闭标记后面不是数字）', () => {
    const html = renderMarkdown('当 $x=1$时成立')
    expect(html).toContain('katex')
  })

  // ── 流式（StreamingMarkdown 分块后逐块渲染）的半截公式 ────────────────────────
  it('半截 \\( 公式不抛错、原样输出，补齐后变成 KaTeX', () => {
    for (const partial of ['\\(E = mc', '\\(', '行内 \\(E = mc^2', '\\[\\frac{a}']) {
      const html = renderMarkdown(partial)
      expect(typeof html).toBe('string')
      expect(html).not.toContain('katex-error')
    }
    // 半截只是文本，闭合后才进 KaTeX —— 渲染不报错，也没有半截的红色错误
    expect(renderMarkdown('\\(E = mc^2\\)')).toContain('katex')
  })

  it('分块后的每一块都能独立渲染（流式逐块喂给 markdown-it）', () => {
    const source = '开头一句。\n\n行内 \\(E = mc^2\\) 与金额 $5 和 $10。\n\n\\[\\frac{a}{b}\\]\n\n结尾。'
    for (const piece of source.split('\n\n')) {
      const html = renderMarkdown(piece)
      expect(typeof html).toBe('string')
      expect(html).not.toContain('katex-error')
    }
  })

  it('代码块里的 $ 不被当作公式', () => {
    const html = renderMarkdown('```sh\necho $HOME\n```')
    expect(html).toContain('$HOME')
    expect(html).not.toContain('katex')
  })

  it('裸 HTML 被转义（html:false）', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('parseFence 取出语言和代码正文', () => {
    expect(parseFence('```python\nprint(1)\n```')).toEqual({ lang: 'python', code: 'print(1)' })
    expect(parseFence('```\nplain\n```')).toEqual({ lang: '', code: 'plain' })
  })
})
