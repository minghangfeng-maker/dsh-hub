import { http } from './http'

import type {
  CanvasItem,
  CanvasPlacement,
  CockpitBoardResponse,
  CockpitHandoffResponse,
  CockpitSourceResponse,
  CockpitStateResponse,
  CockpitStatusStrip,
  OpsStatus,
  ProposalStatus,
  ProposalView,
} from '@dsh-hub/shared'

/**
 * 管理座舱（docs/24）前端接口。契约类型全部来自 `@dsh-hub/shared`（WP56a），这里只做转发；
 * 组件沿用从本文件导入类型的写法，所以下面原样再导出一遍。
 */
export {
  CANVAS_LEFT_KINDS,
  CANVAS_RIGHT_KINDS,
  type CanvasData,
  type CanvasItem,
  type CanvasPlacement,
  type CanvasPlacementRequest,
  type CanvasSize,
  type CanvasSpec,
  type CanvasStatsItem,
  type CapabilityDescriptor,
  type CapabilityRisk,
  type CockpitArea,
  type CockpitEvent,
  type CockpitHandoffResponse,
  type CockpitSourceResponse,
  type CockpitStateResponse,
  type CockpitStatusStrip,
  type EntityKind,
  type OpsInstanceState,
  type OpsStatus,
  type ProposalPreview,
  type ProposalStatus,
  type ProposalStep,
  type ProposalView,
  type SecretRequestView,
} from '@dsh-hub/shared'

/** 表格列格式（契约里是 `CanvasSpec` 表格列的内联枚举，这里单独起名给渲染器用） */
export type CanvasColumnFormat = 'text' | 'number' | 'datetime' | 'bytes' | 'credits' | 'status'

export interface CockpitListResponse<T> {
  items: T[]
}

// ────────────────────────────── 接口（docs/24 §3.2） ──────────────────────────────

const BASE = '/api/admin/cockpit'

/**
 * 座舱状态 + 待处理方案数 + 能力目录。缺省会顺手把没在跑的座舱容器拉起来；
 * `autoStart: false`（WP57 概览里的 AI 助手）只读状态 —— `?start=0`。
 */
export function fetchCockpitState(options: { autoStart?: boolean } = {}): Promise<CockpitStateResponse> {
  return http.get<CockpitStateResponse>(`${BASE}/state`, options.autoStart === false ? { query: { start: '0' } } : {})
}

/** 状态条（`GET /status-strip`：SSE 的 `strip.update` 掉线时的兜底）。 */
export function fetchStatusStrip(): Promise<CockpitStatusStrip> {
  return http.get<CockpitStatusStrip>(`${BASE}/status-strip`)
}

/** SSE 地址（`event:` 名 = `CockpitEvent.type`）。 */
export function cockpitEventsUrl(): string {
  return `${BASE}/events`
}

/** 起 / 重启座舱容器（R1 语义，直接执行）。 */
export function startOpsInstance(): Promise<{ status: OpsStatus }> {
  return http.post<{ status: OpsStatus }>(`${BASE}/ops-instance/start`)
}

export function restartOpsInstance(): Promise<{ status: OpsStatus }> {
  return http.post<{ status: OpsStatus }>(`${BASE}/ops-instance/restart`)
}

/** 座舱设置（改 `autoExecuteR1` 需要 reauth，调用方套 `withReauth`）。 */
export function updateCockpitSettings(input: {
  model?: string
  autoExecuteR1?: boolean
}): Promise<{ status: OpsStatus }> {
  return http.put<{ status: OpsStatus }>(`${BASE}/settings`, { body: input })
}

/** 换交接码：iframe 首次 ready 与令牌过期时各换一次。 */
export function createHandoff(): Promise<CockpitHandoffResponse> {
  return http.post<CockpitHandoffResponse>(`${BASE}/handoff`)
}

/** 某会话的画布卡。 */
export function listCanvas(sessionId: string): Promise<CockpitListResponse<CanvasItem>> {
  return http.get<CockpitListResponse<CanvasItem>>(`${BASE}/canvas`, { query: { sessionId } })
}

/** 态势板：钉住的卡 + 默认四张（无会话 / 没选会话时显示）。 */
export async function fetchBoard(): Promise<CockpitListResponse<CanvasItem>> {
  // 后端分成「钉住」与「默认」两组（CockpitBoardResponse）；画布只关心一条卡片流，钉住的排前面
  const board = await http.get<CockpitBoardResponse>(`${BASE}/board`)
  return { items: [...board.pinned, ...board.defaults] }
}

/** 钉住 / 排序 / 换舷（docs/24 §3.2：拖动卡片时发 `placement` + `order`）。 */
export function patchCanvasItem(
  id: string,
  input: { pinned?: boolean; order?: number; placement?: CanvasPlacement },
): Promise<CanvasItem> {
  return http.patch<CanvasItem>(`${BASE}/canvas/${encodeURIComponent(id)}`, { body: input })
}

/** 关闭卡。 */
export function closeCanvasItem(id: string): Promise<void> {
  return http.delete<void>(`${BASE}/canvas/${encodeURIComponent(id)}`)
}

/** 用管理员身份跑一次数据源（`source` 数据卡）。 */
export function runCanvasSource(input: {
  capability: string
  args: Record<string, unknown>
}): Promise<CockpitSourceResponse> {
  return http.post<CockpitSourceResponse>(`${BASE}/source`, { body: input })
}

export function listProposals(
  query: { status?: ProposalStatus; sessionId?: string } = {},
): Promise<CockpitListResponse<ProposalView>> {
  return http.get<CockpitListResponse<ProposalView>>(`${BASE}/proposals`, { query })
}

/** 批准即执行（异步，状态经 SSE 推）；R3 由服务端要求 reauth。 */
export async function approveProposal(id: number): Promise<{ proposal: ProposalView }> {
  // 后端直接返回 ProposalView；包一层保持组件侧的调用形状不变
  return { proposal: await http.post<ProposalView>(`${BASE}/proposals/${id}/approve`) }
}

export async function rejectProposal(id: number): Promise<{ proposal: ProposalView }> {
  return { proposal: await http.post<ProposalView>(`${BASE}/proposals/${id}/reject`) }
}

/** 密钥卡填写：值只到这里，不进对话、不进 SSE。 */
export function submitSecretRequest(id: string, value: string): Promise<void> {
  return http.post<void>(`${BASE}/secret-requests/${encodeURIComponent(id)}`, { body: { value } })
}

export function cancelSecretRequest(id: string): Promise<void> {
  return http.delete<void>(`${BASE}/secret-requests/${encodeURIComponent(id)}`)
}
