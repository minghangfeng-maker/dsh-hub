import type { InstanceProbe } from '@dsh-hub/shared'

import type { AdminTone } from '@/components/admin/tone'

/**
 * 「会话」列的文案（docs/22 §6.3；WP33）：`进行中 N` / `有人在看` / `空闲 X 分钟（Y 分钟后休眠）` /
 * `未知`。规则（判定与阈值）全在服务端，这里只把 `InstanceProbe` 翻成给人看的一句话。
 */
export interface ProbeText {
  /** 主文案 */
  label: string
  /** 次行/悬浮说明（判定依据与时间点） */
  hint: string
  tone: AdminTone
}

function minutesOf(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000))
}

function timeLabel(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * @param probe 服务端给的探针结果（`null` = 实例没在跑 / 还没探过）
 * @param nowMs 当前时间（父页轮询时更新，用来算「空闲 X 分钟」）
 */
export function probeTextOf(probe: InstanceProbe | null | undefined, nowMs: number): ProbeText {
  if (!probe) return { label: '—', hint: '实例未运行', tone: 'neutral' }
  const probeAt = timeLabel(probe.probeAt)
  const probeHint = probeAt ? `探针 ${probeAt}` : '还没探过'
  if (probe.state === 'busy') {
    const running = probe.runningSessions ?? 0
    return {
      label: `进行中 ${String(running)}`,
      hint: `${probeHint}·${probe.openClients > 0 ? `有人在看（${String(probe.openClients)} 条连接）` : '没人看'}`,
      tone: 'success',
    }
  }
  if (probe.state === 'unknown') {
    return { label: '未知', hint: `${probeHint}·探针失败或旧版 DSH，按 CPU 规则回收`, tone: 'neutral' }
  }
  const idleStart = probe.idleSince ? Date.parse(probe.idleSince) : Number.NaN
  const idleMinutes = Number.isFinite(idleStart) ? minutesOf(nowMs - idleStart) : null
  const stopAt = probe.stopAt ? Date.parse(probe.stopAt) : Number.NaN
  const sleepMinutes = Number.isFinite(stopAt) ? Math.max(0, Math.ceil((stopAt - nowMs) / 60_000)) : null
  const parts: string[] = []
  if (idleMinutes !== null) parts.push(`空闲 ${String(idleMinutes)} 分钟`)
  if (sleepMinutes !== null) parts.push(`${String(sleepMinutes)} 分钟后休眠`)
  const idleText = parts.length > 0 ? parts.join('（') + (parts.length > 1 ? '）' : '') : ''
  const stateLabel = probe.state === 'watching' ? '有人在看' : idleText || '空闲'
  const basis: string[] = [probeHint]
  const promptAt = timeLabel(probe.lastPromptAt)
  const clientAt = timeLabel(probe.lastClientAt)
  if (promptAt) basis.push(`最近提问 ${promptAt}`)
  if (probe.state === 'unattended' && clientAt) basis.push(`最后断开 ${clientAt}`)
  if (probe.openClients > 0) basis.push(`${String(probe.openClients)} 条连接`)
  return {
    label: stateLabel,
    hint: basis.join('·'),
    tone:
      probe.state === 'watching' ? 'sky' : sleepMinutes !== null && sleepMinutes <= 5 ? 'butter' : 'neutral',
  }
}
