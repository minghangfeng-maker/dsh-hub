import { randomInt } from 'node:crypto'
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, SLUG_RANDOM_LENGTH } from '@dsh-hub/shared'
import { randomString } from './crypto.js'

/** slug 字符集：小写字母 + 数字（决策 D4） */
export const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 临时密码字符集：去掉 0/O/1/l/I 等易混字符（管理员重置用，只显示一次） */
export const TEMP_PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 用户 URL/容器名/目录名用的不可变 slug：`u` + 7 位 `[a-z0-9]`。
 * 用 `crypto.randomInt` 而不是 `Math.random`（slug 会出现在 URL 与容器名里）。
 */
export function newSlug(): string {
  return `u${randomString(SLUG_RANDOM_LENGTH, SLUG_ALPHABET)}`
}

/** 邀请码：12 位大写字母数字，去掉易混字符（03 §1.1） */
export function newInviteCode(): string {
  return randomString(INVITE_CODE_LENGTH, INVITE_CODE_ALPHABET)
}

/** 管理员重置密码时生成的一次性临时密码（02 §5：14 位） */
export function newTempPassword(length = 14): string {
  return randomString(length, TEMP_PASSWORD_ALPHABET)
}

/** 取 `[min, max]` 的随机整数（限流抖动等场景） */
export function randomBetween(min: number, max: number): number {
  return randomInt(min, max + 1)
}
