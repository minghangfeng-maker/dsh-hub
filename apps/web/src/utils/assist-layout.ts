/**
 * AI 助手页的多屏分档（WP58，docs/26 §2.1）。
 *
 * 分档按 **Hub 页面的视口宽度** `window.innerWidth`（CSS px）算，不看设备像素比：
 * 同一块 4K 屏在系统缩放 100% / 150% / 200% 下分别落到 XXL / XL / M —— 系统缩放已经放大过，
 * 就不再叠加。档位切换用 `matchMedia` 监听（见 `composables/useAssistTier.ts`），不用每帧 resize。
 *
 * | 档 | W（CSS px） | 典型屏幕 | 会话列表 | 事件栏宽 | 缩放 |
 * |---|---|---|---|---|---|
 * | S | < 1280 | 小窗口、平板横屏 | App 内下拉 | 抽屉 420 | 1 |
 * | M | 1280 – 1919 | 1366/1440/1536 笔记本；4K@200% | App 内下拉 | 360 | 1 |
 * | L | 1920 – 2559 | 1080P@100%；2K@125% | App 内常驻左栏 | 400 | 1 |
 * | XL | 2560 – 3199 | 2K@100%；4K@150% | 常驻 | 440 | 1.125 |
 * | XXL | ≥ 3200 | 3440/3840 宽@100% | 常驻 | 480 | 1.25 |
 *
 * 表里的宽度都是**缩放前**的值；`scale` 只放大卡片头与事件栏（对话区由 App 按
 * `cockpit.layout` 自己放大，**不要**给 iframe 的祖先加 zoom）。
 */

export type AssistTier = 'S' | 'M' | 'L' | 'XL' | 'XXL'

/** 会话列表形态：`docked` = 对话区里的常驻左栏（L 档及以上），`menu` = App 顶部的下拉 */
export type AssistSessionsMode = 'docked' | 'menu'

export interface AssistTierSpec {
  tier: AssistTier
  /** 档位下限（含），CSS px */
  minWidth: number
  /** 事件栏宽度（缩放前；S 档是抽屉宽度） */
  eventsWidth: number
  /** 会话列表形态 */
  sessions: AssistSessionsMode
  /** 常驻左栏宽度（会话列表在 App 里渲染，Hub 只把这个数通过 cockpit.layout 的档位约定告诉它） */
  sessionsWidth: number
  /** 卡片头 / 事件栏的 zoom */
  scale: number
}

/** 从窄到宽排列；`assistTierOf` 取「不超过视口宽度的最大下限」那一档。 */
export const ASSIST_TIERS: readonly AssistTierSpec[] = [
  { tier: 'S', minWidth: 0, eventsWidth: 420, sessions: 'menu', sessionsWidth: 0, scale: 1 },
  { tier: 'M', minWidth: 1280, eventsWidth: 360, sessions: 'menu', sessionsWidth: 0, scale: 1 },
  { tier: 'L', minWidth: 1920, eventsWidth: 400, sessions: 'docked', sessionsWidth: 248, scale: 1 },
  { tier: 'XL', minWidth: 2560, eventsWidth: 440, sessions: 'docked', sessionsWidth: 264, scale: 1.125 },
  { tier: 'XXL', minWidth: 3200, eventsWidth: 480, sessions: 'docked', sessionsWidth: 280, scale: 1.25 },
]

/**
 * 档位边界（`matchMedia` 用）：每跨过一条线就重算一次档位。
 * 与 {@link ASSIST_TIERS} 的 `minWidth` 一一对应（S 档没有下限）。
 */
export const ASSIST_TIER_QUERIES: readonly string[] = ASSIST_TIERS.slice(1).map(
  (spec) => `(min-width: ${String(spec.minWidth)}px)`,
)

/** 视口宽度 → 档位（非有限数、负数一律按最窄的 S 档兜底）。 */
export function assistTierOf(width: number): AssistTier {
  const safe = Number.isFinite(width) && width > 0 ? width : 0
  let tier: AssistTier = 'S'
  for (const spec of ASSIST_TIERS) {
    if (safe >= spec.minWidth) tier = spec.tier
  }
  return tier
}

/** 档位 → 规格（未知档位按 M 兜底，不至于整页没有尺寸）。 */
export function assistTierSpec(tier: AssistTier): AssistTierSpec {
  return ASSIST_TIERS.find((spec) => spec.tier === tier) ?? (ASSIST_TIERS[1] as AssistTierSpec)
}

/** 档位 → 会话列表形态（L 档及以上 `docked`，其余 `menu`）。 */
export function assistSessionsModeOf(tier: AssistTier): AssistSessionsMode {
  return assistTierSpec(tier).sessions
}

/** 档位 → 缩放（只给卡片头与事件栏用）。 */
export function assistScaleOf(tier: AssistTier): number {
  return assistTierSpec(tier).scale
}

/** 档位 → 事件栏宽度（S 档 = 抽屉宽度）。 */
export function assistEventsWidthOf(tier: AssistTier): number {
  return assistTierSpec(tier).eventsWidth
}

/** 父 → 子的 `cockpit.layout` 载荷（docs/26 §5）：App 自己按 scale 缩放、按 sessions 切列表形态。 */
export interface CockpitLayoutPayload {
  scale: number
  sessions: AssistSessionsMode
}

/** 档位 → `cockpit.layout` 载荷（scale 夹在 1–1.5，协议约定的范围）。 */
export function assistLayoutOf(tier: AssistTier): CockpitLayoutPayload {
  const span = assistTierSpec(tier)
  return {
    scale: Math.min(1.5, Math.max(1, span.scale)),
    sessions: span.sessions,
  }
}
