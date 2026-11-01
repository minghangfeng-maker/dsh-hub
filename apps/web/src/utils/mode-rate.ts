import { permilleToRateInput, rateToPermille } from './rate'

/**
 * 对话模式「整体倍率」（18 D4）的录入与显示。
 *
 * 界面上写成 `×1.5`，接口里是千分比整数 `1500`；`×0` 是允许的（这个模式免费）。
 * 换算复用渠道倍率那一套（`utils/rate.ts`），只有「×」前缀的进出在这里处理。
 */

/** 界面输入（`×1.5` / `1.5`）→ 千分比；非法给 null */
export function parseModeRate(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  const text = String(input)
    .trim()
    .replace(/^[×xX]\s*/, '')
  return rateToPermille(text)
}

/** 千分比 → 输入框里的文本（`1500` → `1.5`、`1000` → `1`、`0` → `0`） */
export function modeRateInput(permille: number | null | undefined): string {
  return permilleToRateInput(permille)
}

/** 千分比 → 展示文本（`1500` → `×1.5`，去掉多余的 0；非法 → `—`） */
export function formatModeRate(permille: number | null | undefined): string {
  const text = modeRateInput(permille)
  return text ? `×${text}` : '—'
}
