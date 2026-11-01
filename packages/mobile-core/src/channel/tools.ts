/**
 * 工具卡与「思考过程」的投影（M5 §7 / §17 D3）。
 *
 * 这里只做三件纯函数的事，便于单测（`test/v2-tools.test.ts`）：
 * 1. `tool` 帧 start/end 合并成一张卡（同一个 `callId`，按 `seq` 排序）；
 * 2. 生成人话摘要（「搜索了 3 个网页」「运行了 Python」…）——Hub 给的 `title` 是
 *    英文工具视角的短标题（「搜索网页」），手机上要的是**已经发生的事**；
 * 3. 把消息、工具卡、交付物按 `seq` 合并成一条渲染时间线。
 *
 * 纪律：不猜工具参数，不用工具名做 UI 分类（`kind` 已由 adapter 白名单归一）。
 */

import type { ChatEntry } from './workspace.js'
import type {
  MobileDeliverableFrame,
  MobileFileRef,
  MobileToolFrame,
} from '../contracts/mobile-v2.js'

export interface ToolCard {
  callId: string
  sessionId: string
  kind: MobileToolFrame['kind']
  /** 原始工具名：只在「其它」卡片里兜底显示。 */
  name: string
  /** adapter 给的人话标题（「运行命令」），摘要生成失败时用它。 */
  title: string
  phase: 'start' | 'end'
  status: 'running' | 'ok' | 'error'
  /** start 用 `tool/call` 的 seq，end 用 `tool/result` 的 seq。 */
  seq: number
  turn: number
  step: number
  inputPreview?: string
  outputPreview?: string
  inputBytes?: number
  outputBytes?: number
  truncated?: { input?: true; output?: true }
  files: MobileFileRef[]
  citations: Array<{ title?: string; url: string }>
  error?: { name: string; code: string; reason?: string }
  durationMs?: number
}

export interface DeliverableItem {
  sessionId: string
  seq: number
  turn: number
  callId: string
  files: MobileFileRef[]
}

/** 渲染时间线的一项：消息 / 工具卡 / 交付物，按 seq 与消息交错。 */
export type ThreadItem =
  | { kind: 'message'; key: string; seq: number | null; entry: ChatEntry }
  | { kind: 'tool'; key: string; seq: number; card: ToolCard }
  | { kind: 'deliverable'; key: string; seq: number; item: DeliverableItem }

/** 一张新卡的初值（start 帧；缺 seq 的调用方自己补）。 */
export function toolCardFromFrame(frame: MobileToolFrame, previous?: ToolCard): ToolCard {
  const base: ToolCard = previous ?? {
    callId: frame.callId,
    sessionId: frame.sessionId,
    kind: frame.kind,
    name: frame.name,
    title: frame.title,
    phase: 'start',
    status: 'running',
    seq: frame.seq,
    turn: frame.turn,
    step: frame.step,
    files: [],
    citations: [],
  }
  const merged: ToolCard = {
    ...base,
    sessionId: frame.sessionId,
    kind: frame.kind,
    name: frame.name || base.name,
    title: frame.title || base.title,
    phase: frame.phase === 'end' ? 'end' : base.phase,
    // end 帧的 status 才是权威；start 帧缺省 running。
    status: frame.phase === 'end' ? (frame.status ?? (frame.error ? 'error' : 'ok')) : (frame.status ?? 'running'),
    // start 与 end 的 seq 不同：卡片位置用 start 的 seq（表格里的顺序稳定），
    // end 的 seq 只用于时间线内部诊断。
    seq: base.phase === 'start' ? base.seq : frame.seq,
    turn: frame.turn,
    step: frame.step,
    files: frame.files && frame.files.length > 0 ? frame.files : base.files,
    citations: frame.citations && frame.citations.length > 0 ? frame.citations : base.citations,
  }
  if (frame.inputPreview !== undefined) merged.inputPreview = frame.inputPreview
  if (frame.outputPreview !== undefined) merged.outputPreview = frame.outputPreview
  if (frame.inputBytes !== undefined) merged.inputBytes = frame.inputBytes
  if (frame.outputBytes !== undefined) merged.outputBytes = frame.outputBytes
  if (frame.truncated !== undefined) merged.truncated = frame.truncated
  if (frame.error !== undefined) merged.error = frame.error
  if (frame.durationMs !== undefined) merged.durationMs = frame.durationMs
  return merged
}

/**
 * 卡片摘要（人话、完成态）：
 *   - 搜索且有来源 →「搜索了 N 个网页」；
 *   - 其余按 kind →「运行了 Python」「运行了命令」「读取了文件」…
 *   - 失败追加「· 失败」。
 */
const TARGET_MAX = 42

/** collapse whitespace/newlines into one line and cut to a readable length */
function oneLine(value: string, max = TARGET_MAX): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** last path segment for a command/JSON-ish preview; keeps it readable on a phone */
function baseName(value: string): string {
  const path = value.trim().replace(/^["']|["']$/gu, '')
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = cut < 0 ? path : path.slice(cut + 1)
  return oneLine(name === '' ? path : name, 36)
}

/**
 * 工具卡的人话摘要（移动端时间线用）。
 *
 * 参考 Claude Code：一行能说清「做了什么 + 对象」，不铺输入/输出；具体内容点开看。
 * 目标信息取自 adapter 已经下发的 `inputPreview`（命令首行 / 文件路径 / 搜索词），
 * 因此这里只是展示层，不需要 Hub 改协议。
 */
/**
 * 管理座舱 `@dshhub/ops` 插件的工具（Hub docs/24 §5）：过程行里显示中文动作名，不露 `ops_find` 这类内部名。
 * 只有座舱容器里有这几个工具，普通会话不受影响。
 */
const COCKPIT_TOOL_TITLES: Record<string, string> = {
  ops_find: '查能力目录',
  ops_call: '调用管理能力',
  ops_wait: '等待方案结果',
  canvas_show: '投放画布卡',
  canvas_update: '更新画布卡',
  secret_request: '请求密钥输入卡',
}

export function toolSummary(card: ToolCard): string {
  const failed = card.status === 'error'
  const running = card.phase === 'start' && card.status === 'running'
  const count = card.citations.length
  const preview = oneLine(card.inputPreview ?? '')
  let text: string
  switch (card.kind) {
    case 'search':
      // 有来源时保持「搜索了 N 个网页」的既有口径；没有来源才带搜索词
      text = count > 0 ? `搜索了 ${count} 个网页` : preview === '' ? '搜索了网页' : `搜索「${preview}」`
      break
    case 'fetch':
      text = preview === '' ? '阅读了网页' : `打开 ${preview}`
      break
    case 'python':
      text = '运行 Python'
      break
    case 'bash':
      text = preview === '' ? '运行命令' : `运行 ${preview}`
      break
    case 'file-read':
      text = preview === '' ? '读取文件' : `读取 ${baseName(preview)}`
      break
    case 'file-write':
      text = preview === '' ? '写入文件' : `写入 ${baseName(preview)}`
      break
    case 'present':
      text = card.files.length > 0 ? `交付了 ${card.files.length} 个文件` : '交付了文件'
      break
    case 'question':
      text = '向你提问'
      break
    case 'agent':
      text = '委派了子任务'
      break
    default:
      // 座舱工具优先用中文动作名：adapter 常把 title 填成工具原名（ops_find）
      text = COCKPIT_TOOL_TITLES[card.name] || card.title || (card.name !== '' ? card.name : '调用了工具')
      break
  }
  if (failed) return `${text} · 失败`
  if (running) return `${text}…`
  return text
}

/** 交付物 → 时间线项。 */
export function deliverableFromFrame(frame: MobileDeliverableFrame): DeliverableItem {
  return {
    sessionId: frame.sessionId,
    seq: frame.seq,
    turn: frame.turn,
    callId: frame.callId,
    files: frame.files,
  }
}

/**
 * 时间线合并：消息按 seq，工具卡与交付物按 seq 插在消息之间。
 *
 * 规则（S0 手感规则第 2 条：长会话不能整页重排）：
 * - 没有 seq 的本地气泡（发送中/排队）永远排在最后；
 * - 工具卡按 `callId` 去重，**同一 callId 有交付物时不再画工具卡**（避免「交付了文件」重复）；
 * - 稳定排序：同 seq 时消息在前、工具卡在后。
 */
export function mergeThread(
  messages: readonly ChatEntry[],
  tools: readonly ToolCard[],
  deliverables: readonly DeliverableItem[],
): ThreadItem[] {
  const deliverableCalls = new Set(deliverables.map((d) => d.callId))
  const items: ThreadItem[] = []
  for (const entry of messages) {
    // 注入消息（DSH 的 runtime-context / time-context）在 Hub 侧已经按 source.kind 过滤；
    // 这里再挡一层 `system`（系统提示 / developer 消息）与 `tool` 文本条目：
    // 手机端不该出现任何「不是用户或助手自己说的话」。
    if (entry.role === 'system' || entry.role === 'tool') continue
    // 只思考/只调工具的中间 assistant 步骤：**有思考就保留**（渲染成「思考过程」块，
    // 与工具卡按 seq 交错）；纯空的中间步骤才丢。
    if (entry.role === 'assistant' && entry.text.trim() === '' && !entry.reasoning?.trim()) continue
    items.push({
      kind: 'message',
      key: entry.localId ?? `seq-${String(entry.seq)}`,
      seq: entry.seq,
      entry,
    })
  }
  for (const card of tools) {
    if (deliverableCalls.has(card.callId)) continue
    items.push({ kind: 'tool', key: `tool-${card.callId}`, seq: card.seq, card })
  }
  for (const item of deliverables) {
    items.push({ kind: 'deliverable', key: `deliverable-${item.callId}`, seq: item.seq, item })
  }
  items.sort((a, b) => {
    const as = a.seq ?? Number.MAX_SAFE_INTEGER
    const bs = b.seq ?? Number.MAX_SAFE_INTEGER
    if (as !== bs) return as - bs
    const rank = (item: ThreadItem): number => (item.kind === 'message' ? 0 : item.kind === 'tool' ? 1 : 2)
    return rank(a) - rank(b)
  })
  return items
}

/** 收集时间线里出现过的所有文件（按 fileRef 去重，用于预取与缓存）。 */
export function collectFiles(
  tools: readonly ToolCard[],
  deliverables: readonly DeliverableItem[],
): MobileFileRef[] {
  const seen = new Set<string>()
  const out: MobileFileRef[] = []
  const push = (file: MobileFileRef): void => {
    if (seen.has(file.fileRef)) return
    seen.add(file.fileRef)
    out.push(file)
  }
  for (const item of deliverables) for (const file of item.files) push(file)
  for (const card of tools) for (const file of card.files) push(file)
  return out
}
