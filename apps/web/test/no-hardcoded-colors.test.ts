import { describe, expect, it } from 'vitest'

/**
 * 11 §5：**禁止写死颜色值**，一律用设计令牌（`var(--c-*)` / `var(--shadow-*)` / `var(--c-scrim)`…）。
 *
 * 令牌本身在 `src/styles/tokens.css`，Naive UI 的主题覆盖在 `src/styles/naive-theme.ts`
 * （Naive 只接受具体值，无法用 CSS 变量）——这两处是唯一的例外，所以扫描时排除 `src/styles/**`。
 * 扫描范围限定 WP5a 归属的目录，避免 WP5b/WP6 的页面被本测试误伤。
 */
const files = import.meta.glob(
  [
    '/src/components/**/*.{vue,ts}',
    '/src/layouts/**/*.{vue,ts}',
    '/src/views/auth/**/*.vue',
    '/src/views/StyleGuideView.vue',
    '/src/composables/**/*.ts',
    '/src/api/**/*.ts',
    '/src/stores/**/*.ts',
    '/src/router/**/*.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

describe('颜色只能来自设计令牌（CONTRIBUTING.md 的工程约定）', () => {
  it('组件/布局/页面/数据层里没有十六进制或 rgb()/hsl() 字面量', () => {
    const offenders: string[] = []

    for (const [file, content] of Object.entries(files)) {
      for (const [index, line] of content.split('\n').entries()) {
        if (COLOR_LITERAL.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`)
      }
    }

    expect(offenders, `以下位置写死了颜色值，请改用令牌：\n${offenders.join('\n')}`).toEqual([])
  })

  it('扫描确实覆盖到了文件（防止 glob 写错导致空跑）', () => {
    const paths = Object.keys(files)

    expect(paths.length).toBeGreaterThan(25)
    expect(paths.some((path) => path.endsWith('StatusPill.vue'))).toBe(true)
    expect(paths.some((path) => path.endsWith('api/http.ts'))).toBe(true)
  })
})
