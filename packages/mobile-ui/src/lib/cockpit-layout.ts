/**
 * 控制台主题的布局（WP58 / docs/26 §3.3、§5）：父页面发来的 `cockpit.layout` 怎么落到界面上。
 *
 * 三件纯逻辑（都能单测，不碰 store）：
 *  1. `dockedRailWidth(scale)`：会话列表常驻左栏的宽度——按 docs/26 §2.1 的表由 Hub 的档位
 *     决定，而 App 只知道 `scale`，所以三档锚点 1→248 / 1.125→264 / 1.25→280 之间线性插值，
 *     超过 1.25 一律 280（文档里没有再往上的档）；
 *  2. `applyCockpitZoom(scale, root)`：`document.documentElement.style.zoom = scale`
 *     （Hub 不给 iframe 的祖先加 zoom，所以这里只放大对话区这一块，不会叠两次）；
 *  3. `cockpitLayoutState(scale, sessions)`：把消息归一化成界面状态。
 *
 * 为什么宽度跟着 scale 走而不是写死在 CSS 里：Hub 的档位表把三件事绑在一起（档位越宽、
 * 缩放越大、会话栏越宽），而 App 只知道 `scale`——所以按 1 / 1.125 / 1.25 三个锚点插值。
 * 248/264/280 都是**缩放前**的 CSS px（docs/26 §2.1 的脚注）：Hub 给 iframe 的宽度本身随档位
 * 变大，App 的 zoom 再把内容整体放大，两者不会叠加成双份宽度。
 */

import {
  COCKPIT_SCALE_MAX,
  COCKPIT_SCALE_MIN,
  clampCockpitScale,
  type CockpitLayoutSessions,
} from './cockpit'

/** 常驻左栏宽度的三个锚点（docs/26 §2.1：L / XL / XXL 档，缩放前的 CSS px）。 */
const RAIL_WIDTHS: ReadonlyArray<{ scale: number; width: number }> = [
  { scale: 1, width: 248 },
  { scale: 1.125, width: 264 },
  { scale: 1.25, width: 280 },
]

/**
 * 常驻左栏宽度（CSS px，缩放前）。
 *
 * `1 → 248`、`1.125 → 264`、`1.25 → 280`；两档之间线性插值并取整；
 * `<= 1` 取 248，`>= 1.25` 取 280（Hub 的档位表到 XXL 为止）。
 */
export function dockedRailWidth(scale: number): number {
  const value = clampCockpitScale(scale)
  const first = RAIL_WIDTHS[0]!
  const last = RAIL_WIDTHS[RAIL_WIDTHS.length - 1]!
  if (value <= first.scale) return first.width
  if (value >= last.scale) return last.width
  for (let index = 1; index < RAIL_WIDTHS.length; index += 1) {
    const low = RAIL_WIDTHS[index - 1]!
    const high = RAIL_WIDTHS[index]!
    if (value > high.scale) continue
    const ratio = (value - low.scale) / (high.scale - low.scale)
    return Math.round(low.width + (high.width - low.width) * ratio)
  }
  return last.width
}

/** 缩放作用的根元素（单测注入；真实环境是 `<html>`）。 */
export interface CockpitZoomRoot {
  style: { zoom?: string; removeProperty?: (name: string) => void }
}

/**
 * 应用缩放：`<html style="zoom: 1.25">`。
 *
 * 夹在 1–1.5（`clampCockpitScale`）；scale=1 时**删掉** zoom 而不是写 1，
 * 免得在 `zoom: initial` 与 `zoom: 1` 之间有实现差异（Chrome 之外还有 WebKit）。
 * 删要用 `style.removeProperty('zoom')`：`delete style.zoom` 对 CSSStyleDeclaration 无效
 * （它是原型上的访问器，删了 inline 声明还在）。
 * 返回实际写进去的值。
 */
export function applyCockpitZoom(scale: number, root: CockpitZoomRoot | null | undefined): number {
  const value = clampCockpitScale(scale)
  if (!root || typeof root.style !== 'object') return value
  if (value === COCKPIT_SCALE_MIN) {
    if (typeof root.style.removeProperty === 'function') root.style.removeProperty('zoom')
    else delete root.style.zoom
  } else {
    root.style.zoom = String(value)
  }
  return value
}

/** 界面上的布局状态（store 里的 `layoutScale` / `layoutSessions` → 组件用）。 */
export interface CockpitLayoutState {
  scale: number
  sessions: CockpitLayoutSessions
  /** 会话列表常驻左栏（`sessions === 'docked'`）。 */
  docked: boolean
  railWidth: number
}

/** 归一化布局（scale 夹 1–1.5、sessions 只认两个值）。 */
export function cockpitLayoutState(
  scale: number,
  sessions: CockpitLayoutSessions,
): CockpitLayoutState {
  const clamped = clampCockpitScale(scale)
  return {
    scale: clamped,
    sessions,
    docked: sessions === 'docked',
    railWidth: dockedRailWidth(clamped),
  }
}

/** 默认布局（Hub 还没发 `cockpit.layout` 时）：不缩放、会话列表走下拉（M/S 档的行为）。 */
export const DEFAULT_COCKPIT_LAYOUT: CockpitLayoutState = cockpitLayoutState(1, 'menu')

/** 缩放上限/下限（组件里做断言与提示用）。 */
export const COCKPIT_ZOOM_RANGE = { min: COCKPIT_SCALE_MIN, max: COCKPIT_SCALE_MAX }
