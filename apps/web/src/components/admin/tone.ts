/**
 * 管理端语义色调 → 设计令牌（11 §5：禁止写死颜色值）。
 * `color` 用于文字/图标，`soft` 用于浅底；组件一律通过 CSS 变量消费。
 */
export type AdminTone = 'primary' | 'sky' | 'sakura' | 'butter' | 'danger' | 'success' | 'neutral'

export interface ToneVars {
  color: string
  soft: string
  /** 浅底上的深色文字（保证对比度，WP5a 补的 -ink 令牌） */
  ink: string
}

export const TONE_VARS: Record<AdminTone, ToneVars> = {
  primary: { color: 'var(--c-primary)', soft: 'var(--c-primary-soft)', ink: 'var(--c-primary-press)' },
  sky: { color: 'var(--c-sky)', soft: 'var(--c-sky-soft)', ink: 'var(--c-sky-ink)' },
  sakura: { color: 'var(--c-sakura)', soft: 'var(--c-sakura-soft)', ink: 'var(--c-sakura-ink)' },
  butter: { color: 'var(--c-butter)', soft: 'var(--c-butter-soft)', ink: 'var(--c-butter-ink)' },
  danger: { color: 'var(--c-danger)', soft: 'var(--c-danger-soft)', ink: 'var(--c-danger-ink)' },
  success: { color: 'var(--c-success)', soft: 'var(--c-success-soft)', ink: 'var(--c-success-ink)' },
  neutral: { color: 'var(--c-text-2)', soft: 'var(--c-bg)', ink: 'var(--c-text-2)' },
}

/** Naive UI 组件的 `type` 与我们色调的对照（只用 Naive 已有的四个语义色）。 */
export type NaiveType = 'default' | 'primary' | 'info' | 'success' | 'warning' | 'error'

export function naiveTypeOf(tone: AdminTone): NaiveType {
  if (tone === 'danger') return 'error'
  if (tone === 'butter') return 'warning'
  if (tone === 'sky') return 'info'
  if (tone === 'success') return 'success'
  if (tone === 'primary') return 'primary'
  return 'default'
}
