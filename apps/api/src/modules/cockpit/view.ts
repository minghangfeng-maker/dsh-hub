import {
  CANVAS_LEFT_KINDS,
  CANVAS_RIGHT_KINDS,
  COCKPIT_TABLE_MAX_ROWS,
  type CanvasItem,
  type CanvasSpec,
  type ProposalOutcomeStep,
  type ProposalPreview,
  type ProposalStatus,
  type ProposalStep,
  type ProposalView,
  type SecretRequestStatus,
  type SecretRequestView,
} from '@dsh-hub/shared'
import { HubError } from '../../lib/errors.js'
import type { CanvasRow, ProposalRow, SecretRow } from './repo.js'

/**
 * 行 → 契约视图（docs/24 §3）。损坏的 JSON 不让整页 500：
 * 方案步骤坏了按空步骤返回（并在 `outcome` 里看得出没执行），画布卡坏了直接跳过（返回 null）。
 */

export function proposalRowToView(row: ProposalRow): ProposalView {
  const steps = parseSteps(row.steps_json)
  const outcome = parseOutcome(row.outcome_json)
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    rationale: row.rationale,
    risk: row.risk as ProposalView['risk'],
    steps,
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_by !== null && row.decided_by_username !== null
      ? { decidedBy: { id: row.decided_by, username: row.decided_by_username } }
      : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

function parseSteps(raw: string): ProposalStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as ProposalStep[]
  } catch {
    return []
  }
}

function parseOutcome(raw: string | null): ProposalOutcomeStep[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ProposalOutcomeStep[]) : null
  } catch {
    return null
  }
}

export function canvasRowToItem(row: CanvasRow): CanvasItem | null {
  const spec = parseSpec(row.spec_json)
  if (!spec) return null
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    spec,
    pinned: row.pinned === 1,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    origin: row.origin === 'hub' ? 'hub' : 'dsh',
    placement: row.placement === 'right' ? 'right' : 'left',
    size: row.size === 's' || row.size === 'l' ? row.size : 'm',
  }
}

/**
 * 舷位解析（docs/24 §1 投放规则）：`auto` / 缺省 → 数据类投左舷、行动类投右舷。
 * 「目标舷放不下就投另一舷」是前端按可视区判断的，后端只按类型解析。
 */
export function resolvePlacement(spec: CanvasSpec, requested?: 'left' | 'right' | 'auto'): 'left' | 'right' {
  if (requested === 'left' || requested === 'right') return requested
  const right = (CANVAS_RIGHT_KINDS as readonly string[]).includes(spec.kind)
  const left = (CANVAS_LEFT_KINDS as readonly string[]).includes(spec.kind)
  // 未知 kind 交给 zod 挡；这里保守投右舷（行动类更安全，需要人看）
  return right ? 'right' : left ? 'left' : 'right'
}

function parseSpec(raw: string): CanvasSpec | null {
  try {
    return JSON.parse(raw) as CanvasSpec
  } catch {
    return null
  }
}

/** 密钥请求的视图：落库的 `pending` 一旦过了 `expires_at` 就按 `expired` 展示 */
export function secretRowToView(row: SecretRow, nowIso: string): SecretRequestView {
  const request = parseSecretRequest(row.request_json)
  return {
    id: row.id,
    sessionId: request.sessionId,
    purpose: request.purpose,
    capability: request.capability,
    field: request.field,
    status: secretStatus(row, nowIso),
    expiresAt: row.expires_at,
  }
}

export interface ParsedSecretRequest {
  sessionId: string
  purpose: string
  capability: string
  field: string
}

export function parseSecretRequest(raw: string): ParsedSecretRequest {
  try {
    const parsed = JSON.parse(raw) as Partial<ParsedSecretRequest>
    return {
      sessionId: parsed.sessionId ?? '',
      purpose: parsed.purpose ?? '',
      capability: parsed.capability ?? '',
      field: parsed.field ?? '',
    }
  } catch {
    return { sessionId: '', purpose: '', capability: '', field: '' }
  }
}

export function secretStatus(row: SecretRow, nowIso: string): SecretRequestStatus {
  if (row.status === 'cancelled') return 'cancelled'
  if (row.status === 'expired' || row.used_at !== null) return 'expired'
  if (row.status === 'filled') return row.expires_at <= nowIso ? 'expired' : 'filled'
  return row.expires_at <= nowIso ? 'expired' : 'pending'
}

/**
 * 画布 `source` 是不是一个合法的数据源：必须是 R0 且 `dataSource=true`（§3.2 `/source` 同款规则）。
 * DSH 写了不存在的能力或写类能力时直接 400，而不是让它等到前端渲染才失败。
 */
export function assertSourceAllowed(
  spec: CanvasSpec,
  lookup: (id: string) => { risk: string; dataSource?: boolean } | undefined,
): void {
  const data = dataOf(spec) as { source?: { capability: string } } | null
  if (!data || !data.source) return
  const capability = lookup(data.source.capability)
  if (!capability) {
    throw new HubError('VALIDATION_FAILED', `画布数据源引用了不存在的能力：${data.source.capability}`)
  }
  if (capability.risk !== 'R0' || capability.dataSource !== true) {
    throw new HubError(
      'VALIDATION_FAILED',
      `画布数据源只能用 R0 且 dataSource=true 的能力：${data.source.capability}`,
    )
  }
}

function dataOf(spec: CanvasSpec): unknown {
  switch (spec.kind) {
    case 'table':
    case 'chart':
    case 'logs':
      return spec.data
    default:
      return null
  }
}

/** 能力返回值 → 表格行：`{rows}` / 数组 / `{items}` 三种常见形态都认，其它包成一行 */
export function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.slice(0, COCKPIT_TABLE_MAX_ROWS) as Record<string, unknown>[]
  if (result !== null && typeof result === 'object') {
    const record = result as Record<string, unknown>
    for (const key of ['rows', 'items', 'targets']) {
      const value = record[key]
      if (Array.isArray(value)) return value.slice(0, COCKPIT_TABLE_MAX_ROWS) as Record<string, unknown>[]
    }
    return [record]
  }
  return [{ value: result }]
}

/** 多步方案的风险 = 各步最高级（R3 > R2 > R1 > R0） */
export function highestRisk(risks: readonly string[]): 'R0' | 'R1' | 'R2' | 'R3' {
  const order = ['R0', 'R1', 'R2', 'R3'] as const
  let highest: 'R0' | 'R1' | 'R2' | 'R3' = 'R0'
  for (const risk of risks) {
    const index = order.indexOf(risk as (typeof order)[number])
    if (index > order.indexOf(highest)) highest = order[index]!
  }
  return highest
}

export function previewOf(steps: { preview: ProposalPreview }[]): ProposalPreview {
  if (steps.length === 1) return steps[0]!.preview
  return {
    summary: steps.map((step, index) => `${String(index + 1)}. ${step.preview.summary}`).join('；'),
    affected: steps.flatMap((step) => step.preview.affected ?? []),
    warnings: steps.flatMap((step) => step.preview.warnings ?? []),
  }
}
