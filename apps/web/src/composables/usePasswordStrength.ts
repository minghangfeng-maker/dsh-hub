import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import {
  PASSWORD_MIN_CLASSES,
  PASSWORD_MIN_LENGTH,
  WEAK_PASSWORDS,
} from '@dsh-hub/shared'

export type PasswordLevel = 'weak' | 'medium' | 'strong'

export interface PasswordScore {
  /** 0 = 空，1 弱 / 2 中 / 3 强（对应强度条三段） */
  score: 0 | 1 | 2 | 3
  level: PasswordLevel
  /** 0–100，供进度条使用 */
  percent: number
  /** 不满足的规则（中文，可直接展示，字段顺序与后端 checkPasswordStrength 一致） */
  reasons: string[]
  /** 是否达到后端可接受的下限（reasons 为空） */
  acceptable: boolean
}

const CLASS_PATTERNS = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]

/** 强度条中性的文案，组件与测试共用。 */
export const PASSWORD_LEVEL_TEXT: Record<PasswordLevel, string> = {
  weak: '弱',
  medium: '中',
  strong: '强',
}

/**
 * 纯函数版密码评分：规则必须与后端 `apps/api/src/lib/password.ts` 的 `checkPasswordStrength`
 * 和 02 §5 一致（至少 10 位、至少两类字符、不能与用户名相同、不在弱口令表里）。
 * 「中/强」是给用户的激励，不参与后端校验。
 */
export function scorePassword(password: string, username?: string): PasswordScore {
  const reasons: string[] = []
  if (password.length < PASSWORD_MIN_LENGTH) reasons.push(`至少 ${PASSWORD_MIN_LENGTH} 位`)

  const classes = CLASS_PATTERNS.filter((pattern) => pattern.test(password)).length
  if (classes < PASSWORD_MIN_CLASSES) reasons.push('至少包含字母、数字、符号中的两类')

  const sameAsUsername = Boolean(username) && password.toLowerCase() === username?.toLowerCase()
  if (sameAsUsername) reasons.push('不能与用户名相同')

  const isCommonWeak = (WEAK_PASSWORDS as readonly string[]).includes(password.toLowerCase())
  if (isCommonWeak) reasons.push('这是常见弱口令')

  if (password.length === 0) {
    return { score: 0, level: 'weak', percent: 0, reasons, acceptable: false }
  }

  const acceptable = reasons.length === 0

  // 「强」要求明显超出下限：够长 + 字符种类多；刚好达标只算「中」
  const strong =
    (password.length >= 14 && classes >= 3) || (password.length >= 16 && classes >= PASSWORD_MIN_CLASSES)

  const score = (!acceptable ? 1 : strong ? 3 : 2) as 1 | 2 | 3
  const level: PasswordLevel = score === 1 ? 'weak' : score === 2 ? 'medium' : 'strong'

  return { score, level, percent: (score / 3) * 100, reasons, acceptable }
}

/** 响应式包装：直接绑定表单里的密码字段（逐项返回 ref，模板里不用再写 `.value`）。 */
export function usePasswordStrength(
  password: MaybeRefOrGetter<string>,
  username?: MaybeRefOrGetter<string | undefined>,
): {
  result: ComputedRef<PasswordScore>
  score: ComputedRef<PasswordScore['score']>
  level: ComputedRef<PasswordLevel>
  percent: ComputedRef<number>
  reasons: ComputedRef<string[]>
  acceptable: ComputedRef<boolean>
} {
  const result = computed(() => scorePassword(toValue(password) ?? '', toValue(username)))

  return {
    result,
    score: computed(() => result.value.score),
    level: computed(() => result.value.level),
    percent: computed(() => result.value.percent),
    reasons: computed(() => result.value.reasons),
    acceptable: computed(() => result.value.acceptable),
  }
}
