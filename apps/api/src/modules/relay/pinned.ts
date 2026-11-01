import { RELAY_PINNED_MODEL_SEPARATOR } from '@dsh-hub/shared'

export interface PinnedModelName {
  /** 模型本名（用量 `base_model`、会合哈希与统计用） */
  baseModel: string
  /** 指定的渠道标识；null = 没指定渠道（老写法，或整串是一个本来就叫这个名字的模型） */
  channelSlug: string | null
}

/**
 * 解析请求体里的 `model`（16 §3）：**先整串精确匹配模型名**（兼容本来名字就带 `@` 的模型），
 * 找不到再按**最后一个**分隔符切开，要求前半是已存在的模型、后半是已存在的渠道标识。
 * 任何一边不存在都当作「没指定渠道」，由调用方按整串查模型并给出 404。
 */
export function resolvePinnedModelName(
  requested: string,
  lookups: {
    modelExists: (name: string) => boolean
    channelExists: (slug: string) => boolean
    separator?: string
  },
): PinnedModelName {
  if (lookups.modelExists(requested)) return { baseModel: requested, channelSlug: null }
  const separator = lookups.separator ?? RELAY_PINNED_MODEL_SEPARATOR
  const index = requested.lastIndexOf(separator)
  if (index <= 0 || index >= requested.length - separator.length) {
    return { baseModel: requested, channelSlug: null }
  }
  const baseModel = requested.slice(0, index)
  const channelSlug = requested.slice(index + separator.length)
  if (baseModel.length === 0 || channelSlug.length === 0) {
    return { baseModel: requested, channelSlug: null }
  }
  if (!lookups.modelExists(baseModel) || !lookups.channelExists(channelSlug)) {
    return { baseModel: requested, channelSlug: null }
  }
  return { baseModel, channelSlug }
}
