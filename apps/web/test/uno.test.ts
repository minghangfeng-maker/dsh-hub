import { createGenerator, type UnoGenerator } from 'unocss'
import { beforeAll, describe, expect, it } from 'vitest'

import unoConfig from '../uno.config'

/**
 * UnoCSS 主题映射（07 §2：把令牌映射为 Uno 主题色/圆角/阴影）。
 * 这里直接跑 Uno 生成器，验证 `bg-primary-soft`、`text-2`、`rounded-card`、`shadow-soft` 真的能产出 CSS。
 */
let generator: UnoGenerator

beforeAll(async () => {
  generator = await createGenerator(unoConfig)
})

async function cssFor(classes: string): Promise<string> {
  const { css } = await generator.generate(classes, { preflights: false })
  return css
}

describe('uno.config.ts：令牌 → 语义类', () => {
  it('颜色类引用设计令牌（不写死色值，11 §5）', async () => {
    expect(await cssFor('bg-primary-soft')).toContain('var(--c-primary-soft)')
    expect(await cssFor('bg-primary')).toContain('var(--c-primary)')
    expect(await cssFor('text-primary-press')).toContain('var(--c-primary-press)')
    expect(await cssFor('border-border')).toContain('var(--c-border)')
    expect(await cssFor('bg-surface')).toContain('var(--c-surface)')
  })

  it('文本三档：text-1 / text-2 / text-3（07 §2 的命名）', async () => {
    expect(await cssFor('text-1')).toContain('var(--c-text)')
    expect(await cssFor('text-2')).toContain('var(--c-text-2)')
    expect(await cssFor('text-3')).toContain('var(--c-text-3)')
  })

  it('点缀色与状态色都可直接用', async () => {
    expect(await cssFor('text-sakura')).toContain('var(--c-sakura)')
    expect(await cssFor('bg-butter-soft')).toContain('var(--c-butter-soft)')
    expect(await cssFor('text-danger')).toContain('var(--c-danger)')
    expect(await cssFor('bg-sky-soft')).toContain('var(--c-sky-soft)')
    expect(await cssFor('text-running')).toContain('var(--c-status-running)')
  })

  it('圆角与阴影映射到令牌', async () => {
    expect(await cssFor('rounded-card')).toContain('var(--radius-card)')
    expect(await cssFor('rounded-control')).toContain('var(--radius-control)')
    expect(await cssFor('rounded-pill')).toContain('var(--radius-pill)')
    expect(await cssFor('shadow-soft')).toContain('var(--shadow-card)')
    expect(await cssFor('shadow-hover')).toContain('var(--shadow-hover)')
  })

  it('字体族映射到 --font-sans / --font-mono', async () => {
    expect(await cssFor('font-sans')).toContain('var(--font-sans)')
    expect(await cssFor('font-mono')).toContain('var(--font-mono)')
  })

  it('主题里的每个颜色都是 var() 令牌引用（杜绝硬编码色值）', () => {
    const theme = unoConfig.theme as { colors?: Record<string, unknown> } | undefined
    const colors = theme?.colors ?? {}

    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value, `${path} 应该引用令牌`).toMatch(/^var\(--c-[a-z0-9-]+\)$/)
        return
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}.${key}`)
    }

    walk(colors, 'colors')
  })

  it('shortcuts 覆盖页面容器、卡片、导航项等复用样式', () => {
    const shortcuts = (unoConfig.shortcuts ?? []) as unknown[]
    const names = shortcuts.map((shortcut) => {
      if (Array.isArray(shortcut)) return String(shortcut[0])
      if (shortcut && typeof shortcut === 'object') return Object.keys(shortcut)[0]
      return ''
    })

    expect(names).toEqual(
      expect.arrayContaining(['hub-page', 'hub-card', 'hub-card-hover', 'hub-nav-item', 'hub-chip', 'hub-link']),
    )
  })

  it('只启用 presetUno + presetIcons（attributify 关闭，07 §1）', () => {
    const presets = (unoConfig.presets ?? []) as unknown[]
    const names = presets.map((preset) => {
      const resolved = Array.isArray(preset) ? preset[0] : preset
      if (typeof resolved === 'function') return 'async'
      if (resolved && typeof resolved === 'object' && 'name' in resolved) {
        return String((resolved as { name?: unknown }).name)
      }
      return 'async'
    })

    expect(names).toContain('@unocss/preset-uno')
    expect(names).toContain('@unocss/preset-icons')
    expect(names).not.toContain('@unocss/preset-attributify')
  })
})
