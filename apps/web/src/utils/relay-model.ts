import type { RelayModel } from '@dsh-hub/shared'

/**
 * 对外模型的纯判断（界面与假数据共用）。放 `utils/` 是因为假数据也要算「未定价」，
 * 不能去 import 组件目录里的东西。
 */

/**
 * 价格全为 0 = 还没定价（12 §10 状态胶囊「未定价」；概览告警 `models-unpriced` 同理）。
 * 缓存读 / 写为 null（同输入价）时按输入价算。
 */
export function isUnpricedModel(model: RelayModel): boolean {
  const { inputMicro, outputMicro, cacheReadMicro, cacheWriteMicro, perRequestMicro } = model.price
  return (
    inputMicro === 0 &&
    outputMicro === 0 &&
    (cacheReadMicro ?? 0) === 0 &&
    (cacheWriteMicro ?? 0) === 0 &&
    perRequestMicro === 0
  )
}
