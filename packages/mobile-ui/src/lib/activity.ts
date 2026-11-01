/**
 * 对话时间线的「过程行」分组（0.4.0 §2，取代 0.2.13 的「过程块」）。
 *
 * 目标（参照 Claude 手机端）：每一轮助手回复 = **过程行（0..n 行，紧凑）+ 正文**。
 * - 过程项 = 工具卡 + 「只有思考、没有正文」的 assistant 条目；
 * - 用户消息 / 有正文的助手消息 / 交付物 / 提问、审批、错误等是**边界**，会把过程行断开；
 * - 只做展示层分组，不改变 `mergeThread` 的排序与数据。
 *
 * 0.4.0 的关键变化（§2.1 的跳动根因）：
 * - 块的 key **不再取第一行的 key**，改成「前一个边界条目的 key」（`activity-after-<key>`）。
 *   实时思考落库时，块的第一行会从「实时行」换成「落库条目」，但块 key 不变，
 *   于是 Vue 复用同一个 DOM 节点，位置不跳；
 * - 实时思考（`streamingReasoning`）并进**最后一个过程行**的末行，不再单独渲染在时间线末尾；
 * - 回合开始但还没有任何事件时，也在同一位置给一个空行的运行中占位（`live` 为真，
 *   头部是 0.4.9 的「正在深度求索中…」，右侧暂无状态）。
 *
 * 正文（`streamingText` / 落库的 assistant text）始终在过程行下方：本函数只负责
 * 把「正文开始之前」的实时内容并进过程行；正文开始输出后，新的工具/思考按
 * `mergeThread` 的顺序各自成段。
 */

import { toolSummary, type ThreadItem, type ToolCard } from '@dsh-hub/mobile-core'

export type ActivityRow =
  | { kind: 'reasoning'; key: string; text: string; live: boolean }
  | { kind: 'tool'; key: string; card: ToolCard }

export type ActivityBlock = {
  kind: 'activity'
  /** 由「前一个边界条目」派生：实时 → 落库切换时不变（§2.2）。 */
  key: string
  rows: ActivityRow[]
  /** 属于正在进行的回合：末行是实时思考 / 占位，折叠行显示运行态。 */
  live: boolean
}

export type ConversationBlock =
  | ActivityBlock
  | { kind: 'item'; key: string; item: ThreadItem }

/** 实时回合的输入（都来自 chat store；纯数据，方便单测）。 */
export type LiveActivity = {
  turnRunning: boolean
  streamingReasoning: string
  reasoningDone: boolean
  hasStreamingText: boolean
}

export const IDLE_ACTIVITY: LiveActivity = {
  turnRunning: false,
  streamingReasoning: '',
  reasoningDone: false,
  hasStreamingText: false,
}

/** 实时思考行的 key（只影响行，不影响块）；落库后由条目 key 取代。 */
export const LIVE_REASONING_KEY = 'live-reasoning'

/** 过程块 key：以前一个边界条目派生，实时 ↔ 落库切换时保持不变。 */
export function activityKeyAfter(prevKey: string): string {
  return `activity-after-${prevKey}`
}

export function isProcessItem(item: ThreadItem): boolean {
  if (item.kind === 'tool') return true
  return (
    item.kind === 'message' &&
    item.entry.role === 'assistant' &&
    item.entry.text.trim() === '' &&
    (item.entry.reasoning ?? '').trim() !== ''
  )
}

function rowOf(item: ThreadItem): ActivityRow {
  if (item.kind === 'tool') return { kind: 'tool', key: item.key, card: item.card }
  if (item.kind === 'message') {
    return { kind: 'reasoning', key: item.key, text: item.entry.reasoning ?? '', live: false }
  }
  // 调用方只在 isProcessItem 为真时调用；这里兜底成空思考，不会发生
  throw new Error('rowOf: 非过程项')
}

/**
 * 把 `mergeThread` 的条目压成「过程行 / 普通条目」两种渲染块，并并入实时思考。
 *
 * 实时合并规则（§2.3）：
 * - 只在「回合在跑、正文还没开始」时合并（正文开始后过程行就是完成态）；
 * - 最后一个块是过程行就并进去，否则按「前一个边界条目」新建一个（回合刚开始的占位行）；
 * - 块 key 与实时/落库无关，所以思考落库前后是同一个块。
 */
export function buildConversationBlocks(
  items: readonly ThreadItem[],
  live: LiveActivity = IDLE_ACTIVITY,
): ConversationBlock[] {
  const blocks: ConversationBlock[] = []
  let rows: ActivityRow[] = []
  // 前一个边界条目的 key（没有边界时用 start）
  let prevKey = 'start'
  const flush = (): void => {
    if (rows.length === 0) return
    blocks.push({ kind: 'activity', key: activityKeyAfter(prevKey), rows, live: false })
    rows = []
  }
  for (const item of items) {
    if (isProcessItem(item)) {
      rows.push(rowOf(item))
      continue
    }
    flush()
    blocks.push({ kind: 'item', key: item.key, item })
    prevKey = item.key
  }
  flush()
  if (!live.turnRunning || live.hasStreamingText) return blocks

  let tail = blocks[blocks.length - 1]
  if (tail === undefined || tail.kind !== 'activity') {
    tail = { kind: 'activity', key: activityKeyAfter(prevKey), rows: [], live: true }
    blocks.push(tail)
  }
  tail.live = true
  if (live.streamingReasoning.trim() !== '') {
    tail.rows.push({
      kind: 'reasoning',
      key: LIVE_REASONING_KEY,
      text: live.streamingReasoning,
      live: true,
    })
  }
  return blocks
}

/** 过程行里工具的累计耗时（毫秒）；没有耗时信息返回 0。 */
export function activityDurationMs(rows: readonly ActivityRow[]): number {
  let total = 0
  for (const row of rows) {
    if (row.kind === 'tool' && typeof row.card.durationMs === 'number') total += row.card.durationMs
  }
  return total
}

export function activityToolCount(rows: readonly ActivityRow[]): number {
  let count = 0
  for (const row of rows) if (row.kind === 'tool') count += 1
  return count
}

export function activityErrorCount(rows: readonly ActivityRow[]): number {
  let count = 0
  for (const row of rows) {
    if (row.kind === 'tool' && row.card.status === 'error') count += 1
  }
  return count
}

/** 正在跑的工具（最后一个 start/running 的卡）。 */
export function runningTool(rows: readonly ActivityRow[]): ToolCard | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined) continue
    if (row.kind === 'tool' && row.card.phase === 'start' && row.card.status === 'running') {
      return row.card
    }
  }
  return null
}

/** 最后一行实时思考的文本（落库行不算）。 */
export function liveReasoningText(rows: readonly ActivityRow[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined) continue
    if (row.kind === 'reasoning' && row.live) return row.text
  }
  return ''
}

/** 工具卡 → 过程行图标（与 Claude 一致：搜索地球、命令终端、读写文件文档）。 */
export function toolIcon(kind: ToolCard['kind']): string {
  switch (kind) {
    case 'search':
      return 'search'
    case 'fetch':
      return 'globe'
    case 'python':
    case 'bash':
      return 'terminal'
    case 'file-read':
    case 'file-write':
    case 'present':
      return 'file'
    case 'question':
      return 'user'
    case 'agent':
      return 'sparkle'
    default:
      return 'layers'
  }
}

/** 折叠行左侧图标：只有思考用时钟；单个工具用该工具的图标；多个工具用最后一行的。 */
export function activityIcon(rows: readonly ActivityRow[]): string {
  const tools = rows.filter((row): row is Extract<ActivityRow, { kind: 'tool' }> => row.kind === 'tool')
  if (tools.length === 1) return toolIcon(tools[0]!.card.kind)
  if (tools.length > 1) {
    const last = rows[rows.length - 1]
    return last !== undefined && last.kind === 'tool' ? toolIcon(last.card.kind) : 'layers'
  }
  return 'clock'
}

/**
 * 运行中折叠行左侧的固定文案（0.4.9）：右侧再跟当前状态。
 *
 * 只在这里改一次；组件用「文案 + 动态省略号」，无障碍名称也由它拼。
 * 动态省略号是纯 CSS 装饰（三个点依次出现），所以这个常量里**不带**省略号。
 */
export const LIVE_LABEL = '正在深度求索中'

/**
 * 运行中折叠行右侧的「当前状态」（0.4.9）：
 * 正在跑的工具摘要 → 最新一句思考 → 空串。
 *
 * 以前没有状态时兜底成「思考中」；现在左侧已经在说「正在深度求索中」，
 * 再兜底就成了「正在深度求索中… 思考中」——所以这里**不兜底**，返回空串让右侧留白。
 */
export function liveStatus(rows: readonly ActivityRow[]): string {
  const tool = runningTool(rows)
  if (tool !== null) return toolSummary(tool)
  const reasoning = liveReasoningText(rows)
  if (reasoning !== '') return latestSentence(reasoning)
  return ''
}

/** 把多行思考压成一行，取最后一句（尽量是完整的一句），最多 `max` 个字。 */
export function latestSentence(text: string, max = 30): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return ''
  const parts = flat
    .split(/[。！？!?；;]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const last = parts[parts.length - 1] ?? flat
  return last.length <= max ? last : last.slice(0, max)
}

/** 耗时文案：<1s 用 ms，否则保留一位小数的秒（与设计稿「15.8 秒」一致）。 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/**
 * 折叠行的摘要（§2.2 完成态规则，0.4.0 收尾打磨；0.4.9 运行中改为「左侧固定文案 + 右侧状态」）：
 *
 * - 运行中：交给 `liveStatus`——当前步骤的实时描述（运行中的工具 / 最新一句思考），
 *   没有状态时是空串（左侧的「正在深度求索中…」已经说明了在思考，不重复）；
 * - 只有思考：「思考了 N 秒」——N 取这一块的实时窗口时长；
 *   历史会话没有实时窗口（块是完成态直接复用的），退回「思考过程」；
 * - 思考 + 1 个工具：该工具的结果摘要（「搜索了 3 个网页」）；
 * - ≥2 个工具：「执行了 N 个操作」。
 *
 * **头部的耗时只在「只有思考」时出现**（它就是思考时长本身）；有工具时总耗时
 * 由 `activityTotalMs` 单独交给右侧灰字，避免同一行里出现两次秒数。
 */
export function activityHeadline(
  rows: readonly ActivityRow[],
  options: { live?: boolean; elapsedMs?: number | null } = { live: false },
): string {
  if (options.live) return liveStatus(rows)
  const tools = rows.filter((row): row is Extract<ActivityRow, { kind: 'tool' }> => row.kind === 'tool')
  if (tools.length === 0) {
    const elapsed = options.elapsedMs ?? null
    if (elapsed !== null && elapsed > 0) {
      return `思考了 ${String(Math.max(1, Math.round(elapsed / 1000)))} 秒`
    }
    return '思考过程'
  }
  if (tools.length === 1) return toolSummary(tools[0]!.card)
  return `执行了 ${String(tools.length)} 个操作`
}

/**
 * 过程行右侧的灰色「总耗时」。
 *
 * 有实时窗口就用它（含思考、工具与网络等待，是真的一轮总耗时）；历史会话没有窗口，
 * 退回落库工具卡的 `durationMs` 之和。没有工具时返回 0：那时头部的「思考了 N 秒」
 * 已经把时长说出来了，右侧不再重复。
 */
export function activityTotalMs(
  rows: readonly ActivityRow[],
  liveElapsedMs?: number | null,
): number {
  if (activityToolCount(rows) === 0) return 0
  const live = liveElapsedMs ?? 0
  if (Number.isFinite(live) && live > 0) return live
  return activityDurationMs(rows)
}

export type Citation = { title?: string; url: string }

/**
 * 某条助手消息「本轮」引用到的来源（正文后面的引用角标）。
 *
 * 从这条消息往前扫，直到遇到上一条用户消息为止；只收集过程中的搜索/抓取来源，
 * 按出现顺序去重。没有卡片（历史会话里的搜索没落库）就返回空数组。
 */
export function turnCitations(
  blocks: readonly ConversationBlock[],
  index: number,
): Citation[] {
  // 先回找到本轮的用户消息（块的顺序就是时间线顺序）
  let start = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (block?.kind === 'item' && block.item.kind === 'message' && block.item.entry.role === 'user') {
      start = i + 1
      break
    }
  }
  const seen = new Set<string>()
  const out: Citation[] = []
  for (let i = start; i < index; i += 1) {
    const block = blocks[i]
    if (block === undefined || block.kind !== 'activity') continue
    for (const row of block.rows) {
      if (row.kind !== 'tool') continue
      for (const citation of row.card.citations) {
        if (seen.has(citation.url)) continue
        seen.add(citation.url)
        out.push(citation)
      }
    }
  }
  return out
}
