import { describe, expect, it } from 'vitest'

import { themeOverrides } from '@/styles/naive-theme'
import tokensCss from '@/styles/tokens.css?raw'

/** 07 §2.1 的全部颜色令牌（含暗色模式预留）。 */
const COLOR_TOKENS = [
  '--c-primary',
  '--c-primary-hover',
  '--c-primary-press',
  '--c-primary-soft',
  '--c-brand-ink',
  '--c-sky',
  '--c-sky-soft',
  '--c-sakura',
  '--c-sakura-soft',
  '--c-butter',
  '--c-butter-soft',
  '--c-danger',
  '--c-danger-soft',
  '--c-success',
  '--c-success-soft',
  '--c-bg',
  '--c-bg-grad',
  '--c-surface',
  '--c-surface-glass',
  '--c-border',
  '--c-text',
  '--c-text-2',
  '--c-text-3',
  '--c-dark-bg',
  '--c-dark-surface',
  '--c-dark-primary',
  '--c-wave-1',
  '--c-wave-2',
  '--c-wave-3',
  '--c-ripple',
]

describe('设计令牌与 Naive UI 主题（07 §2.1 / §2.4）', () => {
  it('themeOverrides.common.primaryColor 是 DeepSeek 蓝主色', () => {
    expect(themeOverrides.common?.primaryColor).toBe('#4D6BFE')
  })

  it('themeOverrides 覆盖了 07 §2.4 的组件级主题', () => {
    expect(Object.keys(themeOverrides)).toEqual(
      expect.arrayContaining(['common', 'Card', 'Button', 'Input', 'DataTable', 'Tag', 'Menu']),
    )
  })

  it('tokens.css 包含 --c-primary: #4D6BFE（大小写不敏感：Prettier 会把十六进制小写）', () => {
    expect(tokensCss.toLowerCase()).toContain('--c-primary: #4d6bfe')
  })

  it('Naive 主题的 success / info 与令牌同色', () => {
    expect(themeOverrides.common?.successColor?.toLowerCase()).toBe('#1fbf8f')
    expect(tokensCss.toLowerCase()).toContain('--c-success: #1fbf8f')
    expect(themeOverrides.common?.infoColor?.toLowerCase()).toBe('#3db4f5')
    expect(tokensCss.toLowerCase()).toContain('--c-sky: #3db4f5')
  })

  it('tokens.css 定义了 07 §2.1 的全部颜色令牌', () => {
    for (const token of COLOR_TOKENS) {
      expect(tokensCss, `缺少令牌 ${token}`).toContain(`${token}:`)
    }
  })

  it('tokens.css 定义了圆角 / 阴影 / 间距 / 聚焦环与字体令牌（07 §2.2 / §2.3）', () => {
    const tokens = [
      '--radius-card: 16px',
      '--radius-control: 12px',
      '--radius-pill: 999px',
      '--shadow-card:',
      '--shadow-hover:',
      '--space-4: 16px',
      '--space-6: 24px',
      '--focus-ring:',
      '--font-sans:',
      '--font-mono:',
      '--fs-14: 14px',
      '--lh-base: 1.6',
    ]

    for (const token of tokens) {
      expect(tokensCss, `缺少令牌 ${token}`).toContain(token)
    }
  })
})
