/** 渠道标识（16 §2）：对用户可见的短名，模型调用名 `<模型>@<slug>` 的后半部分 */
export const RELAY_CHANNEL_SLUG_MAX_LENGTH = 24

/**
 * 按渠道名称生成标识（16 §2 的规则）：转小写、只保留 `a-z0-9`，其它字符连成的段换成 `-`，
 * 去掉首尾 `-`，截到 24 位。结果为空时返回空串，由调用方决定回退（通常是 `ch<id>`）。
 */
export function slugBaseFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return base.slice(0, RELAY_CHANNEL_SLUG_MAX_LENGTH).replace(/-+$/gu, '')
}

/** 在已有标识集合里找一个不冲突的名字：`base`、`base-2`、`base-3`…… */
export function uniqueChannelSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${String(index)}`
    const prefix = base
      .slice(0, Math.max(0, RELAY_CHANNEL_SLUG_MAX_LENGTH - suffix.length))
      .replace(/-+$/gu, '')
    const candidate = `${prefix}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  // 实际不可能走到：24 位空间里同一个名字撞一万次的概率为零
  throw new Error('无法生成不冲突的渠道标识')
}

/**
 * 新建渠道时的标识：管理员填了就用填的（冲突由 service 报 VALIDATION_FAILED），
 * 没填就按名称生成，结果为空用 `ch<id>`，冲突依次加 `-2`、`-3`……
 */
export function autoChannelSlug(name: string, channelId: number, taken: ReadonlySet<string>): string {
  const base = slugBaseFromName(name) || `ch${String(channelId)}`
  return uniqueChannelSlug(base, taken)
}
