import { PASSWORD_MIN_LENGTH, WEAK_PASSWORDS } from '@dsh-hub/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PasswordStrength from '@/components/base/PasswordStrength.vue'
import { PASSWORD_LEVEL_TEXT, scorePassword } from '@/composables/usePasswordStrength'

describe('scorePassword（与后端 apps/api/src/lib/password.ts 规则一致）', () => {
  it('空密码：0 分，不算可接受', () => {
    const score = scorePassword('')
    expect(score.score).toBe(0)
    expect(score.percent).toBe(0)
    expect(score.acceptable).toBe(false)
  })

  it(`少于 ${PASSWORD_MIN_LENGTH} 位：弱 + 提示位数`, () => {
    const score = scorePassword('abc123')
    expect(score.score).toBe(1)
    expect(score.level).toBe('weak')
    expect(score.reasons).toContain(`至少 ${PASSWORD_MIN_LENGTH} 位`)
    expect(score.acceptable).toBe(false)
  })

  it('只用一类字符：给出「至少两类」提示', () => {
    const score = scorePassword('abcdefghijkl')
    expect(score.reasons).toContain('至少包含字母、数字、符号中的两类')
  })

  it('10 位两类字符：通过后端校验，评「中」', () => {
    const score = scorePassword('mint-tea26')
    expect(score.acceptable).toBe(true)
    expect(score.score).toBe(2)
    expect(score.level).toBe('medium')
    expect(score.percent).toBeCloseTo(66.7, 0)
  })

  it('14 位以上三类字符：评「强」', () => {
    const score = scorePassword('Mint#Soda-2026!long')
    expect(score.level).toBe('strong')
    expect(score.score).toBe(3)
    expect(score.reasons).toEqual([])
  })

  it('常见弱口令：即使长度和字符种类达标也压到「弱」', () => {
    // 取一个 12 位以上、字母+数字的弱口令样例（长度本身是够的，只因为命中黑名单才判弱）
    const weak = WEAK_PASSWORDS.find((item) => item.length >= 12 && /[a-z]/.test(item) && /[0-9]/.test(item))
    expect(weak, '弱口令表里应该有这样的样例').toBeTruthy()

    const score = scorePassword(weak as string)
    expect(score.level).toBe('weak')
    expect(score.score).toBe(1)
    expect(score.reasons).toContain('这是常见弱口令')
  })

  it('与用户名相同：提示并压到「弱」', () => {
    const score = scorePassword('Mint-Tea-2026', 'mint-tea-2026')
    expect(score.reasons).toContain('不能与用户名相同')
    expect(score.level).toBe('weak')
  })

  it('三类字符但刚好 10 位：中（不是强）', () => {
    expect(scorePassword('Mint#2026x').score).toBe(2)
  })
})

describe('PasswordStrength 组件（07 §5.2 三段渐变）', () => {
  it('渲染三段色块，弱/中/强分别点亮 1/2/3 段', () => {
    const weak = mount(PasswordStrength, { props: { password: 'abc' } })
    expect(weak.findAll('.password-strength__segment')).toHaveLength(3)
    expect(weak.text()).toContain(`强度：${PASSWORD_LEVEL_TEXT.weak}`)
    const filled = (wrapper: ReturnType<typeof mount>) =>
      wrapper
        .findAll('.password-strength__segment')
        .filter((segment) => !segment.attributes('style')?.includes('var(--c-border)')).length
    expect(filled(weak)).toBe(1)

    const medium = mount(PasswordStrength, { props: { password: 'mint-tea26' } })
    expect(medium.text()).toContain(`强度：${PASSWORD_LEVEL_TEXT.medium}`)
    expect(filled(medium)).toBe(2)

    const strong = mount(PasswordStrength, { props: { password: 'Mint#Soda-2026!long' } })
    expect(strong.text()).toContain(`强度：${PASSWORD_LEVEL_TEXT.strong}`)
    expect(filled(strong)).toBe(3)
  })

  it('段落颜色顺序是 珊瑚 → 琥珀 → 水绿', () => {
    const wrapper = mount(PasswordStrength, { props: { password: 'Mint#Soda-2026!long' } })
    const styles = wrapper.findAll('.password-strength__segment').map((s) => s.attributes('style') ?? '')

    expect(styles[0]).toContain('var(--c-danger)')
    expect(styles[1]).toContain('var(--c-warning)')
    expect(styles[2]).toContain('var(--c-success)')
  })

  it('列出不满足的规则（aria-live，读屏可读）；强密码不显示任何提示', () => {
    const weak = mount(PasswordStrength, { props: { password: 'abc' } })
    expect(weak.find('.password-strength__reasons').attributes('aria-live')).toBe('polite')
    expect(weak.text()).toContain('至少 10 位')

    const strong = mount(PasswordStrength, { props: { password: 'Mint#Soda-2026!long' } })
    expect(strong.find('.password-strength__reasons').exists()).toBe(false)
  })

  it('showReasons=false 时只留强度条', () => {
    const wrapper = mount(PasswordStrength, { props: { password: 'abc', showReasons: false } })
    expect(wrapper.find('.password-strength__reasons').exists()).toBe(false)
  })
})
