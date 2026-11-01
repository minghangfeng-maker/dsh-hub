import type { ToolChannel, ToolChannelKey, ToolKeyState, ToolUsageStatus } from '@dsh-hub/shared'

/**
 * 搜索池密钥的纯工具（14 §3）：批量粘贴文本的解析、状态与冷却原因的中文文案。
 *
 * 服务端会按 sha256 去重，这里先把同一段文本里的空行 / 首尾空格 / 重复清掉，
 * 页面上显示的「新增 N、跳过 M」才与用户看到的一致（真正的 M 以接口返回为准）。
 */

export interface ParsedKeys {
  /** 去空行、去首尾空格、去重之后的密钥列表 */
  keys: string[]
  /** 同一次粘贴里重复（或与已有密钥重复）而跳过的条数 */
  skipped: number
}

/**
 * 解析「一行一把」的粘贴文本。
 * @param text 多行文本
 * @param existing 已在池子里的密钥（按原样比较），用于把重复的算进 skipped
 */
export function parsePastedKeys(text: string, existing: readonly string[] = []): ParsedKeys {
  const seen = new Set(existing)
  const keys: string[] = []
  let skipped = 0

  for (const raw of text.split(/\r?\n/)) {
    const key = raw.trim()
    if (!key) continue
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    keys.push(key)
  }

  return { keys, skipped }
}

export const TOOL_KEY_STATE_TEXT: Record<ToolKeyState, string> = {
  active: '可用',
  disabled: '已停用',
  'auto-disabled': '自动停用',
}

/** 密钥状态胶囊的色调（对齐 `components/admin/tone.ts` 的 AdminTone） */
export function toolKeyStateTone(state: ToolKeyState): 'success' | 'neutral' | 'danger' {
  if (state === 'active') return 'success'
  if (state === 'disabled') return 'neutral'
  return 'danger'
}

/** 冷却原因文案（14 §3.1：限流 / 额度用完·下月 1 日恢复 / 出错） */
export function cooldownReasonText(reason: ToolChannelKey['cooldownReason']): string {
  if (reason === 'rate-limit') return '限流冷却中'
  if (reason === 'exhausted') return '额度用完 · 下月 1 日恢复'
  if (reason === 'error') return '上游出错冷却中'
  return '冷却中'
}

/** 渠道类型的中文名（14 §1） */
export function toolChannelKindText(kind: ToolChannel['kind']): string {
  return kind === 'deepseek' ? 'DeepSeek' : 'Tavily'
}

export const TOOL_KIND_TEXT: Record<ToolChannel['tools'][number], string> = {
  search: '搜索',
  fetch: '抓取',
}

/** 密钥池统计：可用 / 冷却 / 额度用完 / 停用（自动停用也计入「停用」） */
export interface ToolKeyCounts {
  active: number
  cooling: number
  exhausted: number
  disabled: number
  total: number
}

export function countToolKeys(keys: readonly ToolChannelKey[], now = Date.now()): ToolKeyCounts {
  const counts: ToolKeyCounts = { active: 0, cooling: 0, exhausted: 0, disabled: 0, total: keys.length }

  for (const key of keys) {
    if (key.state !== 'active') {
      counts.disabled += 1
      continue
    }
    const cooling = key.cooldownUntil !== null && Date.parse(key.cooldownUntil) > now
    if (!cooling) {
      counts.active += 1
    } else if (key.cooldownReason === 'exhausted') {
      counts.exhausted += 1
    } else {
      counts.cooling += 1
    }
  }

  return counts
}

/** 用量状态的中文文案（14 §3.2：ok / client_error / upstream_error / rejected） */
export const TOOL_USAGE_STATUS_TEXT: Record<ToolUsageStatus, string> = {
  ok: '成功',
  client_error: '请求错误',
  upstream_error: '上游错误',
  rejected: '被拒绝',
}

/** 用量状态胶囊的色调（对齐 `components/admin/tone.ts` 的 AdminTone） */
export function toolUsageStatusTone(status: ToolUsageStatus): 'success' | 'butter' | 'danger' | 'neutral' {
  if (status === 'ok') return 'success'
  if (status === 'client_error') return 'butter'
  if (status === 'upstream_error') return 'danger'
  return 'neutral'
}
