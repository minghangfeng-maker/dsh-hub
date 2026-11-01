/**
 * 强度拖动条的**吸附**规则（纯函数，供 EffortSheet 与单测共用）。
 *
 * 四档是固定顺序，但某个模型可能只支持其中几档（catalog 的 `efforts[]`）。
 * 不支持的档位要置灰、**不可拖到**：拖动/点击的落点先四舍五入到最近档，
 * 再吸附到最近的**可用**档（等距时取左边，行为稳定可测）。
 */

/**
 * @param rawIndex 指针落点四舍五入后的档位下标（0..n-1）
 * @param available 每个档位是否可用（长度 = 档位总数）
 * @param fallback 一个档位都不可用时返回的下标（默认 0）
 */
export function nearestAvailableIndex(
  rawIndex: number,
  available: readonly boolean[],
  fallback = 0,
): number {
  const indexes: number[] = []
  for (let i = 0; i < available.length; i++) if (available[i]) indexes.push(i)
  if (indexes.length === 0) return fallback
  const raw = Number.isFinite(rawIndex) ? rawIndex : indexes[0]!
  let best = indexes[0]!
  for (const index of indexes) {
    const distance = Math.abs(index - raw)
    const bestDistance = Math.abs(best - raw)
    if (distance < bestDistance || (distance === bestDistance && index < best)) best = index
  }
  return best
}

/** 指针 x 比例（0..1，轨道内部坐标）→ 档位下标（四舍五入，越界钳制）。 */
export function indexFromRatio(ratio: number, count: number): number {
  if (count <= 1) return 0
  const safe = Number.isFinite(ratio) ? ratio : 0
  const clamped = Math.min(1, Math.max(0, safe))
  return Math.round(clamped * (count - 1))
}
