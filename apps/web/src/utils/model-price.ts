import type { MyRelayModel } from '@dsh-hub/shared'

import { formatRatedPrice, isRatedRange } from './rate'

/**
 * 对外模型价格的显示（12 §10）：工作台「我的模型」与「可用模型」表共用。
 *
 * 价格算法只有一处：模型价格 × 渠道倍率（区间取 `min–max`），缓存价为 null 时显示「同输入」；
 * 区间含义放进 `title`（07 §2.8：完整信息悬停看，不在页面上挂说明小字）。
 */
export const MODEL_PRICE_UNIT = '积分 / 百万 token'

export interface ModelPriceText {
  text: string
  title: string
}

/** 单元格文本 + 悬停说明；`micro = null` = 缓存读价格缺省（同输入价） */
export function modelPriceText(
  micro: number | null,
  model: Pick<MyRelayModel, 'channelRate'>,
  unit = MODEL_PRICE_UNIT,
): ModelPriceText {
  if (micro === null) return { text: '同输入', title: '缓存读与输入同价' }

  const text = formatRatedPrice(micro, model.channelRate)
  const range = isRatedRange(model.channelRate) ? '（区间：不同渠道的倍率不同）' : ''
  return { text, title: `${text} ${unit}${range}` }
}
