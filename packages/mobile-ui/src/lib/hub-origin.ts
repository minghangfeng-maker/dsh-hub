/**
 * 多入口的展示与纯逻辑。
 *
 * 这里只放**不依赖 Vue/Capacitor** 的部分（单测的主战场）：
 *  - 入口的短标签与主机名（网络检测页要标出「当前在用哪个」）；
 *  - 延迟文案（`86ms` / `1.2s`）；
 *  - 入口列表里「当前入口」的位置（首选 / 备用）。
 *
 * 「当前用哪个」由 core 的 `OriginManager` 决定（HubClient 内部），UI 状态在
 * `stores/hub-origin.ts`。
 *
 * 地名标签**不写死在仓库里**：由构建参数 `VITE_HUB_ORIGIN_LABELS` 提供
 * （`<origin>=<标签>`，逗号分隔，见 core 的 `parseHubOriginLabels`），
 * 例如 `VITE_HUB_ORIGIN_LABELS="https://hub.example.com=主站,https://backup.example.com=备用"`。
 * 没配标签的入口一律显示主机名 —— 这是默认形态，不需要任何人填。
 */

import { parseHubOriginLabels } from '@dsh-hub/mobile-core'

/** 构建期入口标签（`VITE_HUB_ORIGIN_LABELS`；没配就是空对象）。 */
export const ORIGIN_LABELS: Readonly<Record<string, string>> = parseHubOriginLabels(
  import.meta.env.VITE_HUB_ORIGIN_LABELS ?? null,
)

/** 去掉协议与末尾斜杠：`https://hub.example.com:8123` → `hub.example.com:8123`。 */
export function originHost(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '')
  const matched = /^https?:\/\/(.+)$/i.exec(trimmed)
  return matched?.[1] ?? trimmed
}

/** 入口短标签（网络检测页的行首）：配了标签的入口给标签，其余给主机名。 */
export function originLabel(
  origin: string,
  labels: Readonly<Record<string, string>> = ORIGIN_LABELS,
): string {
  return labels[origin.trim().replace(/\/+$/, '')] ?? originHost(origin)
}

/** 入口顺序标签：首选 / 备用（第一个是首选）。 */
export function originRank(origins: readonly string[], origin: string): '首选' | '备用' | null {
  const index = origins.indexOf(origin)
  if (index < 0) return null
  return index === 0 ? '首选' : '备用'
}

/** 延迟文案：1 秒以内按毫秒、以上按秒（一位小数）。 */
export function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`
}

/**
 * 网络检测页里一个入口的结果文案：
 *  - 通了：延迟；
 *  - 被拦截页挡住：说明是拦截（域名未备案的典型表现）；
 *  - 其它失败：沿用 `errorKindLabel` 的中文（由调用方传入，避免依赖 net-diag 造成环）。
 */
export function originResultText(
  input: {
    ok: boolean
    ms: number | null
    bodyHint: string | null
    errorText: string
  },
): string {
  if (input.ok) return formatLatency(input.ms) || '已连上'
  if (input.bodyHint) return '被拦截页挡住'
  return input.errorText || '连不上'
}
