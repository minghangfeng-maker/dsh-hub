import { RELAY_CHANNEL_SLUG_REGEX } from '@dsh-hub/shared'

import { formatRate } from './rate'

/**
 * 渠道标识（16 §2）：对用户可见的短名，模型名后面的 `@` 就是它。
 * 生成规则与后端一致：小写、只留 `a-z0-9`，其它字符合并成 `-`，去首尾 `-`，最长 24 位。
 */
export const CHANNEL_SLUG_HINT =
  '用户会看到它，模型名后面的 @ 就是它。只能用小写字母、数字和 -，最长 24 位；留空按名称生成。'

export function isValidChannelSlug(value: string): boolean {
  return RELAY_CHANNEL_SLUG_REGEX.test(value)
}

/** 按名称生成候选标识（前端只用于编辑时把空的字段填回来，唯一性仍由服务端保证） */
export function channelSlugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
}

/** 「标识 ×倍率」：模型与价格页的渠道胶囊、用量记录的渠道列共用（16 §5 §6.3） */
export function channelTagText(slug: string | null | undefined, permille: number | null | undefined): string {
  const rate = formatRate(permille)
  if (!slug) return rate
  return `${slug} ${rate}`
}
