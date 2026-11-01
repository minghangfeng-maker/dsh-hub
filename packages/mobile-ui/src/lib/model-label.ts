/**
 * 模型 / 强度的**展示短名**（纯函数，只依赖 UI 词表，不动 core 协议）。
 *
 * 背景（Codex 风格芯片）：芯片里要显示「模型名 + 强度」，例如 `DeepSeek Flash Max`。
 * catalog 里的模型名是给人看的全名，可能很长、带版本号、带 provider 后缀：
 *   `DeepSeek V4.1 Flash · upstream-b` → `DeepSeek Flash`
 *
 * 规则集中在这里，芯片、模型列表、弹层共用同一份结果，方便单测（test/model-label.test.ts）：
 *   1. 去掉 `· provider` 后缀（只保留第一个 `·` 之前的部分）；
 *   2. `-` `_` `/` 统一成空格，压掉多余空白；
 *   3. 丢掉纯版本号 token：`V4`、`V4.1`、`4.1`、`4`（`4o` 这种带字母的保留，避免把
 *      `GPT-4o` 削成 `GPT`）；
 *   4. 全被削光时退回第 1 步的结果，绝不让芯片变成空串。
 *
 * 文本宽度由调用方用 CSS 省略号兜底（窄屏 / 系统字体放大 1.3 倍）。
 */

import type { EffortTierId } from '@dsh-hub/mobile-core'

/** 四档强度的英文短名（Codex 风格：Low / Medium / High / Max）。 */
export const EFFORT_SHORT_LABELS: Record<EffortTierId, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Max',
}

/** 档位英文短名；不知道档位时用 —（与中文档位文案的兜底一致）。 */
export function effortShortLabel(tier: EffortTierId | null | undefined): string {
  if (!tier) return '—'
  return EFFORT_SHORT_LABELS[tier] ?? '—'
}

/** `V4` / `V4.1` / `4.1` / `4` → 版本号 token；`4o` / `3.5-turbo` 里的 `3.5` 仍算。 */
const VERSION_TOKEN = /^(?:v\d+(?:\.\d+)*|\d+(?:\.\d+)*)$/i

function tidy(text: string): string {
  return text
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * catalog 全名 → 芯片 / 列表用的短名。
 *
 * @example
 * shortModelName('DeepSeek V4.1 Flash · upstream-b') // 'DeepSeek Flash'
 * shortModelName('DeepSeek-V4.1-Flash')             // 'DeepSeek Flash'
 * shortModelName('DeepSeek-V4-Pro')                 // 'DeepSeek Pro'
 */
export function shortModelName(raw: string | null | undefined): string {
  if (!raw) return ''
  // 1. 去掉 ` · provider` / ` • provider` / 括号里的 provider 后缀
  const head = raw.split(/[·•]/)[0] ?? ''
  const withoutParen = head.replace(/[（(][^（）()]*[）)]\s*$/, ' ')
  const tidyHead = tidy(withoutParen || head)
  if (!tidyHead) return tidy(raw)

  // 3. 丢版本号 token；全被削光时退回 tidyHead（例如名字本身就叫 `V4.1`）
  const tokens = tidyHead.split(' ').filter((token) => !VERSION_TOKEN.test(token))
  return tokens.length > 0 ? tokens.join(' ') : tidyHead
}

/**
 * 模型在 UI 里的显示名：优先短名，其次模型 id，最后给个中性兜底。
 * （catalog 的 `name` 偶发为空，真实 Hub 已经出现过。）
 */
export function modelDisplayName(model: {
  name?: string | null
  model?: string | null
} | null | undefined): string {
  if (!model) return '模型'
  return shortModelName(model.name) || shortModelName(model.model) || '模型'
}

/**
 * 模型「渠道」标签：catalog 全名里 `· channel` 的后半段（真实 Hub 的命名形状，
 * 例如 `DeepSeek V4.1 Flash · upstream-c` → `upstream-c`）；名字里没有就退回模型 id 的
 * `@channel` 后缀（`Qwen/Qwen3.8-Flash-Next@modelscope` → `modelscope`）。
 *
 * 为什么要它：同一个模型会经不同渠道各上一条（upstream-b / upstream-c / modelscope…），
 * `shortModelName` 会把渠道后缀去掉，列表里就变成两条一模一样的「DeepSeek Flash」，
 * 用户没法区分（真机 2026-10-26 反馈）。拿不到渠道时返回 ''，UI 不显示。
 */
export function modelChannelName(model: {
  name?: string | null
  model?: string | null
} | null | undefined): string {
  if (!model) return ''
  const parts = (model.name ?? '').split(/[·•]/)
  if (parts.length > 1) {
    const channel = (parts[parts.length - 1] ?? '').trim()
    if (channel !== '') return channel
  }
  const id = (model.model ?? '').trim()
  const at = id.lastIndexOf('@')
  if (at > 0 && at < id.length - 1) return id.slice(at + 1).trim()
  return ''
}

/** 去掉小数末尾多余的 0（`0.100` → `0.1`，`1.000` → `1`）。 */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * 渠道倍率文案：`0.1` → `X0.1`、`0.3` → `X0.3`、`1` → `X1`。
 * 后端没给价格信息（null/undefined）返回 ''，UI 不显示。
 */
export function modelMultiplierText(multiplier: number | null | undefined): string {
  if (multiplier === null || multiplier === undefined || !Number.isFinite(multiplier)) return ''
  if (multiplier < 0) return ''
  return `X${trimZeros(multiplier.toFixed(3))}`
}

/**
 * 手机端**不展示**的模型渠道（真机 2026-10-26 要求）。
 *
 * Hub 的用户容器里除了中转站（hub-max/hub/…），还可能挂着 Claude Code / Codex 两个插件
 * 提供者（provider id = `claude-code` / `codex`，模型名如「跟随 Claude Code 默认」/「gpt-6.1-sol」）。
 * 手机上只保留中转站的模型，这两类渠道整组隐藏（含展示名里带 GPT/Claude 的兜底）。
 */
const HIDDEN_CHANNEL_TOKEN = /(^|[-_/\s])(claude|codex|gpt)([-_/\s]|$)/i

export function isHiddenModelChannel(
  model: { provider?: string | null; name?: string | null } | null | undefined,
): boolean {
  if (!model) return false
  if (HIDDEN_CHANNEL_TOKEN.test((model.provider ?? '').trim())) return true
  return HIDDEN_CHANNEL_TOKEN.test((model.name ?? '').trim())
}
