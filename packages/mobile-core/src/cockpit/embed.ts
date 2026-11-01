/**
 * 管理座舱（docs/24 §3.3 / §6）在 App 侧的契约与纯逻辑（WP56d）。
 *
 * App 只做「嵌入模式」这一半：用交接码换座舱令牌、固定节点 `cloud:ops`、把 `ops_call`
 * 的方案结果认出来。真正的座舱能力在 Hub（`apps/api/src/modules/cockpit`），App 不复制任何
 * 能力定义，也不调用 `/ops/*`。
 *
 * 为什么这里自带 zod 而不是从 `@dsh-hub/shared` re-export：本仓库 vendored 的 shared
 * 包（WP54c 那份）还没有 cockpit 契约；Hub 侧 WP56a 的 `CockpitHandoffExchangeRequestSchema`
 * 与这里的形状逐字一致，等 shared 发新版后改成 re-export（同 asr / tts 的路径常量做法）。
 */

import { z } from 'zod'
import { AuthTokensSchema, type AuthTokens } from '../contracts/auth-bootstrap.js'
import type { ToolCard } from '../channel/tools.js'

/**
 * 座舱 DSH 的节点 id（docs/24 §2 / §3.3：`scope=cockpit` 的令牌在 `/api/mobile/nodes`
 * 里只会拿到这一个节点）。App 在嵌入模式里**不提供节点切换**，永远连它。
 *
 * 与 `cloud:self`（用户自己的云实例）不同：座舱 DSH 是系统账号 `hub-ops` 的容器，
 * 多个管理员共享同一个会话列表。
 */
export const COCKPIT_NODE_ID = 'cloud:ops'

/** 嵌入模式的查询参数：`/m/?embed=cockpit`。 */
export const COCKPIT_EMBED_PARAM = 'embed'
export const COCKPIT_EMBED_VALUE = 'cockpit'

/** 交接码在 URL hash 里的键：`/m/?embed=cockpit#code=<交接码>`。 */
export const COCKPIT_CODE_HASH_KEY = 'code'

/** 座舱令牌在 sessionStorage 里的键（键名带 cockpit：与普通 `/m/` 的持久登录互不影响）。 */
export const COCKPIT_TOKEN_STORAGE_KEY = 'dshm.cockpit.auth-v1'

/** `POST /api/mobile/auth/cockpit-exchange` 的请求体（与 Hub 的契约同名同形）。 */
export const CockpitHandoffExchangeRequestSchema = z.object({
  code: z.string().min(1).max(200),
})
export type CockpitHandoffExchangeRequest = z.infer<typeof CockpitHandoffExchangeRequestSchema>

/**
 * 交接码换令牌的响应：与网页版登录同形的令牌对 + `scope: 'cockpit'` + `platform: 'web'`。
 *
 * `scope` / `platform` 用**可选**：老 Hub（还没上 WP56a）不会发，App 读不到也不该报错；
 * 但读到 `scope !== 'cockpit'` 的值时上层要当心（说明拿到的不是座舱令牌）。
 */
export const CockpitExchangeResponseSchema = AuthTokensSchema.extend({
  scope: z.string().optional(),
  platform: z.string().optional(),
})
export type CockpitExchangeResponse = z.infer<typeof CockpitExchangeResponseSchema>

/** 交换结果（gateway 层给出的形状；`scope` 缺省视为 'cockpit'）。 */
export interface CockpitSession {
  tokens: AuthTokens
  scope: 'cockpit'
}

// ── `ops_call` 方案结果 ────────────────────────────────────────────────────

/**
 * `ops_call` 的返回（docs/24 §3 的 `OpsCallResult`）。
 *
 * App 只关心 `kind === 'proposal'`：这时候过程行要显示「方案 #N · 等待确认」，
 * 点一下把 `cockpit.focus-proposal` 发给父页面，让它滚到右边那张方案卡。
 * 其余两种（`data` / `done`）App 不额外渲染 —— 正文里 DSH 自己会说。
 */
export interface OpsCallProposal {
  /** 方案 id（Hub 的 `ProposalView.id`，正整数）。 */
  id: number
  /** 方案标题（DSH 起的，可能没有）。 */
  title: string
  /** 风险等级（`R1`–`R3`，可能没有）。 */
  risk: string | null
}

/** 工具名（Hub 的 `@dshhub/ops` 插件里的工具，docs/24 §5）。 */
export const OPS_CALL_TOOL_NAME = 'ops_call'
/** 兼容带命名空间前缀的工具名（`dshhub_ops.ops_call` 之类）。 */
function isOpsCallName(name: string): boolean {
  const value = name.trim().toLowerCase()
  if (value === '') return false
  const tail = value.includes('.') ? value.slice(value.lastIndexOf('.') + 1) : value
  return tail === OPS_CALL_TOOL_NAME || value.endsWith(`_${OPS_CALL_TOOL_NAME}`)
}

/** 预览里的 `id` 必须是正整数：`0` / 负数 / 非整数都当没认出来。 */
function positiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value, 10)
    return parsed > 0 ? parsed : null
  }
  return null
}

function proposalFromValue(value: unknown): OpsCallProposal | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'proposal') return null
  const proposal = record.proposal
  if (proposal === null || typeof proposal !== 'object') return null
  const fields = proposal as Record<string, unknown>
  const id = positiveInt(fields.id)
  if (id === null) return null
  return {
    id,
    title: typeof fields.title === 'string' ? fields.title.trim() : '',
    risk: typeof fields.risk === 'string' ? fields.risk : null,
  }
}

/**
 * 从工具卡的输出预览里认出「方案」（纯函数，单测见 `test/cockpit-embed.test.ts`）。
 *
 * 输入是 Hub adapter 给的 `outputPreview`：正常情况下就是 `OpsCallResult` 的 JSON 文本。
 * 两种现实情况都要容忍：
 *  1. 预览可能被**截断**（adapter 上限 4 KiB，长方案会切掉），JSON 解析失败；
 *  2. 预览可能被前面加了别的文本（不同 adapter 的包装）。
 * 所以先试 JSON，失败再退回到「在文本里找 `"kind":"proposal"` 与随后出现的 id」的模式匹配。
 *
 * 只在 `phase === 'end'` 且没失败时才认：运行中的 start 帧没有结果。
 */
export function opsCallProposalOf(
  card: Pick<ToolCard, 'name' | 'phase' | 'status' | 'outputPreview'>,
): OpsCallProposal | null {
  if (!isOpsCallName(card.name)) return null
  if (card.phase !== 'end') return null
  if (card.status === 'error') return null
  const preview = card.outputPreview ?? ''
  if (preview.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(preview)
  } catch {
    parsed = null
  }
  const direct = proposalFromValue(parsed)
  if (direct !== null) return direct
  // 截断/被包装：按「kind: proposal 之后第一个 id」找。别把 data/done 的结果误认成方案。
  if (!/"kind"\s*:\s*"proposal"/u.test(preview)) return null
  const matched = /"id"\s*:\s*"?(\d+)"?/u.exec(preview.slice(preview.search(/"kind"\s*:\s*"proposal"/u)))
  if (matched?.[1] === undefined) return null
  const id = positiveInt(matched[1])
  if (id === null) return null
  const titleMatch = /"title"\s*:\s*"([^"]{0,200})"/u.exec(preview)
  const riskMatch = /"risk"\s*:\s*"(R[0-3])"/u.exec(preview)
  return {
    id,
    title: titleMatch?.[1] ?? '',
    risk: riskMatch?.[1] ?? null,
  }
}

// ── 画布投放（`canvas_show` / `canvas_update`，docs/24 §1「投放规则」/§6）──────

/** 卡片落在哪一舷（`auto` 在 Hub 侧已经解析成实际舷位；App 只按结果显示）。 */
export type CockpitPlacement = 'left' | 'right'

/** 过程行上「能点一下跳到画布」的一条（按工具调用的先后顺序）。 */
export type CockpitProcessAction =
  | {
      kind: 'canvas'
      /** `CanvasItem.id`（字符串，Hub 生成）。 */
      id: string
      /** 卡片标题（`canvas_show` 的参数或回包里的 title）。 */
      title: string
      placement: CockpitPlacement
      /** `canvas_update` 还是第一次投放（文案略有不同：更新就写「已更新」）。 */
      update: boolean
    }
  | { kind: 'proposal'; id: number; title: string; risk: string | null }

/** 投放类工具名（Hub 的 `@dshhub/ops` 插件，docs/24 §5）。 */
export function isCanvasToolName(name: string): boolean {
  const value = name.trim().toLowerCase()
  const tail = value.includes('.') ? value.slice(value.lastIndexOf('.') + 1) : value
  return tail === 'canvas_show' || tail === 'canvas_update'
}

/** 行动类卡片（缺省投右舷）：方案、密钥请求、任务进度。 */
const ACTION_CARD_KINDS = new Set(['proposal', 'secret-request', 'job'])

/**
 * 舷位：优先用工具结果里的 `placement`；没给就按卡片类型走「投放规则」
 * （数据类左舷、行动类右舷）。`auto` 也按这条规则兜底。
 */
function placementOf(value: unknown, specKind: string | null): CockpitPlacement {
  if (value === 'left' || value === 'right') return value
  if (value !== 'auto' && value !== undefined && value !== null) return 'left'
  return specKind !== null && ACTION_CARD_KINDS.has(specKind) ? 'right' : 'left'
}

function canvasActionFromValue(value: unknown): Omit<Extract<CockpitProcessAction, { kind: 'canvas' }>, 'update'> | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') return null
  // `canvas_show` 的回包是 `CanvasItem`（id/title/spec/placement…），也可能被包一层
  // （`{ ok: true, item: {...} }`）：两种形状都认。
  const nested =
    record.item !== null && typeof record.item === 'object'
      ? (record.item as Record<string, unknown>)
      : record
  const title =
    shortText(record.title, 80) ?? shortText(nested.title, 80) ?? ''
  const spec = nested.spec !== null && typeof nested.spec === 'object' ? (nested.spec as Record<string, unknown>) : null
  const specKind = spec !== null && typeof spec.kind === 'string' ? spec.kind : null
  const placement = placementOf(
    record.placement ?? nested.placement ?? (spec !== null ? spec.placement : undefined),
    specKind,
  )
  return { kind: 'canvas', id, title, placement }
}

/**
 * `canvas_show` / `canvas_update` 的工具结果 → 「已投放左舷/右舷：标题」。
 *
 * `canvas_update` 只改已有卡（原地更新），文案用「已更新」。和 `ops_call` 一样：
 * 只在 `phase === 'end'` 且没失败时才认；预览被截断时退回正则。
 */
export function canvasActionOf(
  card: Pick<ToolCard, 'name' | 'phase' | 'status' | 'outputPreview'>,
): Extract<CockpitProcessAction, { kind: 'canvas' }> | null {
  if (!isCanvasToolName(card.name)) return null
  if (card.phase !== 'end') return null
  if (card.status === 'error') return null
  const preview = card.outputPreview ?? ''
  if (preview.trim() === '') return null
  const update = card.name.trim().toLowerCase().includes('update')
  let parsed: unknown = null
  try {
    parsed = JSON.parse(preview)
  } catch {
    parsed = null
  }
  const direct = canvasActionFromValue(parsed)
  if (direct !== null) return { ...direct, update }
  // 截断/包装：只接受「能看出是画布卡」的预览，避免把普通结果误认成投放
  if (!/"placement"\s*:/u.test(preview) && !/"spec"\s*:\s*\{/u.test(preview)) return null
  const idMatch = /"id"\s*:\s*"([^"]{1,128})"/u.exec(preview)
  if (idMatch?.[1] === undefined) return null
  const titleMatch = /"title"\s*:\s*"([^"]{0,200})"/u.exec(preview)
  const placementMatch = /"placement"\s*:\s*"(left|right|auto)"/u.exec(preview)
  const kindMatch = /"kind"\s*:\s*"(\w+[-\w]*)"/u.exec(preview)
  return {
    kind: 'canvas',
    id: idMatch[1],
    title: titleMatch?.[1] ?? '',
    placement: placementOf(placementMatch?.[1], kindMatch?.[1] ?? null),
    update,
  }
}

/**
 * 一条过程行里所有可点的投放/方案（**按出现顺序**，一次回合可能投放好几张卡）。
 *
 * docs/24 §1 的示意里就有「⟶ 已投放左舷：近 7 天积分消耗」和「⟶ 已投放右舷：方案 #12」
 * 同时出现，所以这里返回列表而不是单个。
 */
export function cockpitProcessActions(
  rows: ReadonlyArray<{
    kind: string
    card?: Pick<ToolCard, 'name' | 'phase' | 'status' | 'outputPreview'>
  }>,
): CockpitProcessAction[] {
  const actions: CockpitProcessAction[] = []
  for (const row of rows) {
    if (row.kind !== 'tool' || row.card === undefined) continue
    const canvas = canvasActionOf(row.card)
    if (canvas !== null) {
      actions.push(canvas)
      continue
    }
    const proposal = opsCallProposalOf(row.card)
    if (proposal !== null) {
      actions.push({
        kind: 'proposal',
        id: proposal.id,
        title: proposal.title,
        risk: proposal.risk,
      })
    }
  }
  return actions
}

/** 舷位的中文名（两舷各一个，别在模板里散着写）。 */
export function placementText(placement: CockpitPlacement): string {
  return placement === 'left' ? '左舷' : '右舷'
}

/**
 * 过程行上的文案（docs/24 §6）：
 *  - `canvas_show` → 「⟶ 已投放左舷：近 7 天积分消耗」
 *  - `canvas_update` → 「⟶ 已更新左舷：近 7 天积分消耗」
 *  - `ops_call` 出方案 → 「⟶ 方案 #12 · 待确认（右舷）」
 *
 * 控制台主题（`console: true`，Hub 管理台 AI 助手页，docs/26）没有两舷，卡片都在右侧事件栏：
 *  - 「⟶ 已放到右侧：近 7 天积分消耗」/「⟶ 已更新右侧卡片：…」/「⟶ 方案 #12 · 待确认（右侧）」
 */
export function cockpitActionText(
  action: CockpitProcessAction,
  options: { console?: boolean } = {},
): string {
  if (options.console === true) {
    if (action.kind === 'proposal') return `⟶ 方案 #${String(action.id)} · 待确认（右侧）`
    const verb = action.update ? '已更新右侧卡片' : '已放到右侧'
    return action.title === '' ? `⟶ ${verb}` : `⟶ ${verb}：${action.title}`
  }
  if (action.kind === 'proposal') {
    return `⟶ 方案 #${String(action.id)} · 待确认（右舷）`
  }
  const verb = action.update ? '已更新' : '已投放'
  const side = placementText(action.placement)
  return action.title === '' ? `⟶ ${verb}${side}` : `⟶ ${verb}${side}：${action.title}`
}

// ── 会话行的「发起人」（docs/24 §10 第 4 条）─────────────────────────────────

/**
 * 会话行「发起人」的候选键：Hub 侧字段名在 WP56a/b 里还没最终定，这里按几个常见名字容错。
 * 值可以是字符串，也可以是 `{ username, displayName }`。
 */
export const COCKPIT_INITIATOR_KEYS = ['initiator', 'owner', 'createdBy', 'startedBy'] as const

/** 一段短文本（发起人）：去空白、单行、限长；空串当没有。 */
function shortText(value: unknown, max = 32): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text === '') return null
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 发起人字段 → 显示用的名字（`displayName` 优先，退回 `username`）。 */
export function cockpitInitiatorText(value: unknown): string | null {
  const direct = shortText(value)
  if (direct !== null) return direct
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return shortText(record.displayName) ?? shortText(record.username)
}

/**
 * 把原始帧里的发起人字段**补齐**到已校验的 `sessions` 帧上。
 *
 * 为什么需要这一步：`MobileSessionRowV2Schema` 是共享包里的闭合 schema（未知字段会被剥掉），
 * 座舱新增的发起人字段在 App 这边拿不到。这里只做一件事：从**原始 JSON**里读已知的几个键，
 * 归一化成 `initiator: string` 挂在对应行上（UI 只认这一个字段）。读不到就原样返回，
 * 没有额外分配、不影响普通会话列表。
 */
export function withCockpitSessionInitiators<T>(frame: T, raw: unknown): T {
  if (frame === null || typeof frame !== 'object') return frame
  if ((frame as { type?: unknown }).type !== 'sessions') return frame
  const items = (frame as { items?: unknown }).items
  const rawItems = (raw as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items) || !Array.isArray(rawItems)) return frame
  let changed = false
  const next = items.map((item, index) => {
    const rawRow = rawItems[index]
    if (rawRow === null || typeof rawRow !== 'object') return item
    const record = rawRow as Record<string, unknown>
    for (const key of COCKPIT_INITIATOR_KEYS) {
      const text = cockpitInitiatorText(record[key])
      if (text === null) continue
      if ((item as { initiator?: unknown }).initiator === text) return item
      changed = true
      return { ...(item as Record<string, unknown>), initiator: text }
    }
    return item
  })
  return changed ? ({ ...(frame as Record<string, unknown>), items: next } as T) : frame
}

// ── 发送前打码（docs/24 §0 第 4 条：密钥永远不进对话）─────────────────────────

const SECRET_PLACEHOLDER = '[已隐藏]'

/**
 * 与 Hub `packages/shared/src/api/cockpit.ts` 的 `COCKPIT_REDACT_VALUE_RULES` **逐条一致**（改一边同步另一边）。
 * 管理员在座舱对话里贴密钥时，App 先把它换成 `[已隐藏]` 再发：DSH 拒收只能防它被用，
 * 防不了它留在会话记录里。
 */
const SECRET_TEXT_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: SECRET_PLACEHOLDER },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi, replacement: `$1${SECRET_PLACEHOLDER}@` },
  {
    pattern: /(^|[\s?&;])((?:access_)?token|api_?key|key|secret|password|sign|signature)=([^&\s"'#]+)/gi,
    replacement: `$1$2=${SECRET_PLACEHOLDER}`,
  },
]

/** 把文本里像密钥的片段换成 `[已隐藏]`；`masked` = 替换了几处（0 = 原样）。 */
export function maskSecretsInText(text: string): { text: string; masked: number } {
  let masked = 0
  let out = text
  for (const rule of SECRET_TEXT_RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      masked += 1
      // 带捕获组的规则按 String.replace 的 $n 语义展开
      return rule.replacement.replace(/\$(\d)/g, (_m, n: string) => String(args[Number(n)] ?? ''))
    })
  }
  return { text: out, masked }
}
