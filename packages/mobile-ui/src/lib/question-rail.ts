/**
 * 问题导航条（0.4.0 §4）的纯计算部分。
 *
 * 交互在 `components/QuestionRail.vue` 里，这里只放**位置映射 / 吸附 / 简述截断**这些
 * 与 DOM 无关的算法，方便单测：
 * - 圆点在轨道上的位置 = 该用户消息的 `offsetTop / scrollHeight` 映射到轨道高度（§4.1）；
 * - 拖动吸附到最近的提问点；两点挤在一起（< 6px）时按拖动方向继续逐个吸附（§4.1/§4.2）；
 * - 气泡里是提问前 20 字（单行省略，§4.2）。
 */

/** 轨道上下各留的空隙（px）。 */
export const RAIL_PAD = 12
/** 圆点直径（px）。 */
export const RAIL_DOT = 6
/** 两个点视觉上开始挤在一起的间距（px）。 */
export const RAIL_MIN_GAP = 6
/** 气泡里显示的提问字数。 */
export const RAIL_LABEL_MAX = 20
/** 轨道左右各扩的热区（px）：总宽 3 + 14×2 ≈ 31px。 */
export const RAIL_HIT_PAD = 14
/** 跳转后用户消息顶部与对话区顶部的间距（px），e2e 断言 12±4。 */
export const RAIL_JUMP_OFFSET = 12
/** 停止滚动后轨道淡出的延迟（ms）。 */
export const RAIL_FADE_MS = 1500

/** 简述：压成一行、截到 20 字（超出加省略号）。 */
export function railLabel(text: string, max = RAIL_LABEL_MAX): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return '（无内容）'
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 轨道可用高度：对话区可视高度减去上下留白。 */
export function railTrackHeight(viewportHeight: number, pad = RAIL_PAD): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0
  return Math.max(0, viewportHeight - pad * 2)
}

/**
 * 一条用户消息在轨道上的纵向位置。
 *
 * `offsetTop` 是消息相对滚动内容顶部的位置，`scrollHeight` 是整条时间线的高度；
 * 比例乘以轨道高度得到圆点位置（§4.1 的映射口径）。
 */
export function railOffset(
  offsetTop: number,
  scrollHeight: number,
  trackHeight: number,
): number {
  if (!Number.isFinite(offsetTop) || offsetTop <= 0) return 0
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return 0
  if (!Number.isFinite(trackHeight) || trackHeight <= 0) return 0
  const ratio = Math.min(1, Math.max(0, offsetTop / scrollHeight))
  return ratio * trackHeight
}

/** 一批消息 → 一批轨道位置（顺序与输入一致）。 */
export function railOffsets(
  offsetTops: readonly number[],
  scrollHeight: number,
  trackHeight: number,
): number[] {
  return offsetTops.map((offsetTop) => railOffset(offsetTop, scrollHeight, trackHeight))
}

/**
 * 吸附：y 最近的圆点下标。空数组返回 -1。
 *
 * `current` 是当前吸附的下标：两个点的位置差小于 6px（视觉上挤在一起）时，
 * 等距就按拖动方向继续吸附下一个，保证逐个可达（§4.2）。
 */
export function snapIndex(positions: readonly number[], y: number, current = -1): number {
  if (positions.length === 0) return -1
  const start = positions[0] ?? 0
  let best = 0
  let bestDist = Math.abs(start - y)
  const dir =
    current >= 0 && current < positions.length ? Math.sign(y - (positions[current] ?? 0)) : 0
  for (let i = 1; i < positions.length; i += 1) {
    const position = positions[i] ?? 0
    const dist = Math.abs(position - y)
    if (dist < bestDist - 1e-6) {
      best = i
      bestDist = dist
      continue
    }
    // 等距：按拖动方向取更远的那个（挤在一起的点也能逐个吸附）
    if (Math.abs(dist - bestDist) <= 1e-6 && dir !== 0) {
      if ((position - (positions[best] ?? 0)) * dir > 0) {
        best = i
        bestDist = dist
      }
    }
  }
  return best
}

/** 当前视口里的提问点：消息占位与 [scrollTop, scrollTop + viewport) 有交集。 */
export function marksInView(
  offsets: readonly number[],
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
): number[] {
  const out: number[] = []
  for (let i = 0; i < offsets.length; i += 1) {
    const top = offsets[i] ?? 0
    const bottom = top + Math.max(1, heights[i] ?? 1)
    if (bottom >= scrollTop && top <= scrollTop + viewport) out.push(i)
  }
  return out
}

/** 跳转目标：用户消息顶部对齐到对话区顶部下方 12px。 */
export function jumpTop(offsetTop: number, pad = RAIL_JUMP_OFFSET): number {
  return Math.max(0, offsetTop - pad)
}
