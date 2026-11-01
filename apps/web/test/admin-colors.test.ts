import { describe, expect, it } from 'vitest'

/**
 * 11 §5 / 07 §2.1：管理端页面与组件**禁止写死颜色值**，必须走设计令牌。
 *
 * WP5a 的 `no-hardcoded-colors.test.ts` 只扫它自己的目录；这里补上 WP6 的归属范围
 * （`views/admin/**`、`components/admin/**`），避免新页面把色值写死。
 */
const files = import.meta.glob(['/src/views/admin/**/*.{vue,ts}', '/src/components/admin/**/*.{vue,ts}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

describe('管理端颜色只能来自设计令牌（CONTRIBUTING.md 的工程约定）', () => {
  it('views/admin 与 components/admin 里没有十六进制或 rgb()/hsl() 字面量', () => {
    const offenders: string[] = []

    for (const [file, content] of Object.entries(files)) {
      for (const [index, line] of content.split('\n').entries()) {
        if (COLOR_LITERAL.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`)
      }
    }

    expect(offenders, `以下位置写死了颜色值，请改用令牌：\n${offenders.join('\n')}`).toEqual([])
  })

  it('扫描确实覆盖到了管理端文件（防止 glob 写错导致空跑）', () => {
    const paths = Object.keys(files)
    expect(paths.length).toBeGreaterThan(30)
    expect(paths.some((path) => path.endsWith('views/admin/AdminUsersView.vue'))).toBe(true)
    expect(paths.some((path) => path.endsWith('components/admin/LogViewer.vue'))).toBe(true)
  })
})
