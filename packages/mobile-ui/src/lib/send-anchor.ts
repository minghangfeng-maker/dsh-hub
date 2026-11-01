/**
 * 发送锚定（0.4.8）的纯计算部分。
 *
 * 交互在 `views/ConversationView.vue` 里（吸底状态机上加一个「锚定模式」），这里只放
 * **留白高度 / 滚动位置**这些与 DOM 无关的算法，方便表驱动单测。
 *
 * 口径（view 侧和 e2e 都按这个口径量）：
 * - `anchorTop`：锚点用户消息的顶部距内容顶部的距离（内容坐标，**不含**留白）；
 * - `belowHeight`：锚点消息顶部 → 内容末尾的高度（**不含**留白；含 `thread__inner` 的底部
 *   padding——底部 padding 也是内容，漏掉它就会多滚出 padding 那么高的空白）；
 * - `viewportHeight`：对话区可视高度（`.thread` 的 clientHeight，键盘弹出时会变小）；
 * - `offset`：锚点顶部与对话区顶部的间距，复用 `RAIL_JUMP_OFFSET`（与问题导航条跳转对齐）。
 *
 * 留白 = `max(0, viewportHeight − belowHeight − offset)`
 *
 * 于是加上留白之后 `scrollHeight − clientHeight` 恰好等于 `anchorTop − offset`：
 * 锚点刚好能停在顶部，往下也再滚不出多余空白 —— 留白只补足，不多给一像素。
 * 内容长高 / 键盘收起时留白同步变小，缩到 0 之后就是正常内容（见 e2e F）。
 */

import { RAIL_JUMP_OFFSET } from './question-rail.js'

/** 锚定后的顶部间距默认值：与导航条跳转同一个常量。 */
export const SEND_ANCHOR_OFFSET = RAIL_JUMP_OFFSET

export interface SendAnchorInput {
  /** 锚点用户消息的顶部距内容顶部的距离（不含留白）。 */
  anchorTop: number
  /** 锚点消息顶部 → 内容末尾的高度（不含留白）。 */
  belowHeight: number
  /** 对话区可视高度（clientHeight）。 */
  viewportHeight: number
  /** 顶部间距，默认 `RAIL_JUMP_OFFSET`。 */
  offset?: number
}

export interface SendAnchorPlan {
  /** 需要补的底部留白（px，≥ 0）；0 表示内容已经够高，不加留白。 */
  spacer: number
  /** 平滑滚动的目标 scrollTop（px，≥ 0）。 */
  scrollTop: number
}

/** 非有限数（NaN / Infinity / undefined 传成 NaN）一律当 0，绝不让 NaN 漏进 CSS。 */
function safe(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function safeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return SEND_ANCHOR_OFFSET
  return Math.max(0, offset)
}

/**
 * 底部留白：把内容补到「刚好够把锚点消息顶到对话区顶部 + offset」。
 *
 * - 内容不够高（短回复）→ 正数，补足整屏；
 * - 内容已经够高 → 0，一点都不多给；
 * - 视口高度 ≤ 0（页面还没布局 / 被隐藏）→ 0，不补。
 */
export function sendAnchorSpacer(input: SendAnchorInput): number {
  const viewport = safe(input.viewportHeight)
  if (viewport <= 0) return 0
  return Math.max(0, viewport - Math.max(0, safe(input.belowHeight)) - safeOffset(input.offset))
}

/** 锚定目标 scrollTop：锚点顶部减去顶部间距（到不了就停在 0）。 */
export function sendAnchorScrollTop(
  anchorTop: number,
  offset: number | undefined = SEND_ANCHOR_OFFSET,
): number {
  return Math.max(0, safe(anchorTop) - safeOffset(offset))
}

/**
 * 加完留白之后的最大可滚距离（`scrollHeight − clientHeight`）。
 *
 * 留白 > 0 时它恰好等于目标 scrollTop（锚点停顶部，往下再滚不出空白）；
 * 留白 = 0 时内容本来就比视口高，可以一直滚到内容末尾。
 */
export function anchoredMaxScroll(input: SendAnchorInput): number {
  const beforeSpacer = safe(input.anchorTop) + Math.max(0, safe(input.belowHeight))
  return Math.max(0, beforeSpacer + sendAnchorSpacer(input) - safe(input.viewportHeight))
}

/** 一次算完：留白 + 目标 scrollTop。 */
export function planSendAnchor(input: SendAnchorInput): SendAnchorPlan {
  return {
    spacer: sendAnchorSpacer(input),
    scrollTop: sendAnchorScrollTop(input.anchorTop, input.offset),
  }
}
