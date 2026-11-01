import { createGenerator, type UnoGenerator } from 'unocss'
import { beforeAll, describe, expect, it } from 'vitest'

import unoConfig from '../uno.config'

/**
 * 守卫：**scoped 样式里自定义的类名不能与 UnoCSS 的工具类同名**。
 *
 * 踩过的坑（WP6 第二轮）：`RingProgress.vue` 的根元素用了 `class="ring"`，
 * 而 UnoCSS 的 `ring` 是一个真实的工具类（`--un-ring-shadow` 蓝色 focus ring）——
 * 于是三个环形图外面各多出一个浅蓝矩形框（截图里被编排者发现）。
 * 这类冲突不会报错、只会静默多出样式，所以用一条测试守住。
 */
const files = import.meta.glob(['/src/views/admin/**/*.vue', '/src/components/admin/**/*.vue'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * scoped 样式里的类名必须在模板里真的用到。
 * 踩过的坑（WP6 第二轮）：把 `.ring` 改名成 `.ring-progress` 时只改了 CSS 选择器与根元素，
 * 内层 `ring__svg`/`ring__track` 没跟着改 —— 圆环直接变成黑色实心圆（SVG 默认 fill）。
 * 这类「孤儿样式」不会有任何报错，只能靠测试守。
 */
/** 模板里是否用到这个类名（含动态拼接与 Vue 过渡类两种间接用法）。 */
function isClassUsed(name: string, template: string): boolean {
  if (template.includes(name)) return true

  // 动态拼接：`:class="\`job-progress--${size}\`"` → 模板里能看到 "job-progress--"
  const dynamicPrefix = name.replace(/(__|--)[\w-]+$/, '$1')
  if (dynamicPrefix !== name && template.includes(dynamicPrefix)) return true

  // Vue 过渡：`<Transition name="batch-bar">` 会生成 batch-bar-enter-active 等
  const transition = /-?(enter|leave)(-active|-from|-to)?$/.exec(name)
  if (transition) {
    const base = name.slice(0, transition.index)
    if (template.includes(`name="${base}"`) || template.includes(`name="${base}-`)) return true
  }

  return false
}

function orphanScopedClasses(source: string): string[] {
  const template = source.slice(0, source.indexOf('<style'))
  return scopedClassNames(source).filter((name) => !isClassUsed(name, template))
}

/** 从 scoped 样式块里抽出类选择器（`.foo`、`.foo__bar`、`.foo--baz`）。 */
function scopedClassNames(source: string): string[] {
  const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '')
  const names = new Set<string>()

  for (const block of styleBlocks) {
    for (const match of block.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const name = match[1]
      if (name) names.add(name)
    }
  }

  return [...names]
}

let generator: UnoGenerator

beforeAll(async () => {
  generator = await createGenerator(unoConfig)
})

describe('管理端 scoped 类名不与 UnoCSS 工具类冲突', () => {
  it('每个自定义类名都不会被 UnoCSS 生成样式', async () => {
    const offenders: string[] = []

    for (const [file, source] of Object.entries(files)) {
      for (const name of scopedClassNames(source)) {
        const { css } = await generator.generate(name, { preflights: false })
        if (css.trim())
          offenders.push(`${file} → .${name}（Uno 会生成：${css.replace(/\s+/g, ' ').trim().slice(0, 60)}）`)
      }
    }

    expect(
      offenders,
      `这些类名与 UnoCSS 工具类同名，会多出意料之外的样式：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('检测器本身有效：`ring`、`flex` 这类 Uno 工具类确实会生成样式', async () => {
    // 这条守住「检测方法本身」：如果哪天 Uno 不再把 ring 当工具类，上面的断言才有意义
    expect((await generator.generate('ring', { preflights: false })).css.trim()).not.toBe('')
    expect((await generator.generate('flex', { preflights: false })).css.trim()).not.toBe('')
  })

  it('scoped 样式里的类名都在模板里用到（重命名不会只改一半）', () => {
    const orphans: string[] = []

    for (const [file, source] of Object.entries(files)) {
      for (const name of orphanScopedClasses(source)) orphans.push(`${file} → .${name}`)
    }

    expect(
      orphans,
      `这些类名只写在样式里、模板里没有用到（多半是改名漏了）：\n${orphans.join('\n')}`,
    ).toEqual([])
  })

  it('扫描确实覆盖到了管理端组件（防止 glob 写错导致空跑）', () => {
    const paths = Object.keys(files)
    expect(paths.length).toBeGreaterThan(30)

    const ring = files['/src/components/admin/RingProgress.vue'] ?? ''
    expect(scopedClassNames(ring)).toContain('ring-progress')
  })
})
