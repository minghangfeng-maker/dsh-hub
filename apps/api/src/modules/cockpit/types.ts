import type {
  CanvasItem,
  CanvasPlacement,
  CanvasSize,
  CanvasSpec,
  CockpitStatusStrip,
  CockpitHandoffResponse,
  CockpitSourceResponse,
  CockpitStateResponse,
  CockpitSettingsRequest,
  CockpitSettingsResponse,
  OpsCallRequest,
  OpsCallResult,
  OpsCatalogQuery,
  OpsCatalogResponse,
  OpsContextResponse,
  OpsSecretRequestCreate,
  OpsSecretStatusResponse,
  OpsStatus,
  ProposalStatus,
  ProposalView,
  SecretRequestView,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { CapabilityRegistry } from './capabilities/types.js'
import type { CockpitEventBus } from './events.js'
import type { OpsInstanceProbe } from './ops-probe.js'

/** 管理员身份（审计 actor 用；`req.user` 的子集） */
export interface AdminIdentity {
  id: number
  username: string
}

export interface CreateProposalInput {
  sessionId: string
  title: string
  rationale: string
  steps: { capability: string; args: Record<string, unknown> }[]
  actor: AdminIdentity | null
  meta: RequestMeta
}

export interface CanvasCreateInput {
  sessionId: string
  title: string
  spec: CanvasSpec
  /** 'auto' / 缺省：数据类投左舷、行动类投右舷（§1 投放规则） */
  placement?: CanvasPlacement | 'auto'
  size?: CanvasSize
}

export interface BoardCard {
  item: CanvasItem
  /** 这张卡背后的数据源能力（前端「在经典页面打开」用） */
  classicPath?: string
}

/**
 * 座舱服务（docs/24 §2–§4）：能力调用、方案、画布、密钥、交接码、状态。
 * 两组路由（`/ops/*` 与 `/api/admin/cockpit/*`）都只调这个接口，不直接碰 SQL 或 service。
 */
export interface CockpitService {
  readonly registry: CapabilityRegistry
  readonly events: CockpitEventBus
  readonly probe: OpsInstanceProbe
  /** 能力目录（`GET /ops/catalog`） */
  catalog(query?: OpsCatalogQuery): OpsCatalogResponse
  /** `GET /ops/context`：版本、各域数量摘要、策略、今天日期与时区 */
  context(): Promise<OpsContextResponse>
  /** 顶栏胶囊用的状态（autoExecuteR1 始终来自服务端设置，I1） */
  status(): Promise<OpsStatus>
  /** 状态条的数字（数字变化时同时推 `strip.update`） */
  statusStrip(): CockpitStatusStrip
  /**
   * `GET /state`：状态 + 待处理方案数 + 目录；未运行时自动拉起（ensureStarted）。
   * WP57：`autoStart=false`（`?start=0`，概览里的 AI 助手用）只读状态、不拉起 —— 由管理员点「启动」。
   */
  state(options?: { autoStart?: boolean }): Promise<CockpitStateResponse>
  updateSettings(input: CockpitSettingsRequest, actor: AdminIdentity): Promise<CockpitSettingsResponse>
  startOpsInstance(actor: AdminIdentity): Promise<OpsStatus>
  restartOpsInstance(actor: AdminIdentity): Promise<OpsStatus>
  /** `POST /ops/call`：R0 直接返回 / R1 看设置 / R2 R3 出方案（I1） */
  call(input: OpsCallRequest, meta: RequestMeta): Promise<OpsCallResult>
  /** `POST /source`：用当前管理员身份跑一次数据源（只允许 dataSource=true 的 R0） */
  source(
    input: { capability: string; args?: Record<string, unknown> },
    actor: AdminIdentity,
  ): Promise<CockpitSourceResponse>
  listProposals(query: { status?: ProposalStatus; sessionId?: string; limit?: number }): ProposalView[]
  getProposal(id: number): ProposalView
  /** 长轮询：状态变化或超时都返回当前视图 */
  waitProposal(id: number, waitSec: number): Promise<ProposalView>
  /** 批准并异步执行（I2/I5：只有这条路径能执行） */
  approveProposal(id: number, actor: AdminIdentity, meta: RequestMeta): Promise<ProposalView>
  rejectProposal(id: number, actor: AdminIdentity): ProposalView
  /**
   * 启动清扫（WP56e1）：把上次进程里还在 `running` 的方案标 failed（outcome =「Hub 重启中断」）并推 SSE。
   * 由管理端路由插件的 `onReady` 调用，返回被修正的方案 id。
   */
  reconcileInterruptedProposals(): number[]
  /**
   * SSE 连上时补发的快照（WP56e1）：pending/running 的方案 + pending 的密钥请求。
   * 刷新页面后密钥卡也能拿到用途/来源（密钥请求没有列表接口）。
   */
  pendingSnapshot(): { proposals: ProposalView[]; secretRequests: SecretRequestView[] }
  createCanvas(input: CanvasCreateInput, origin: 'dsh' | 'hub'): CanvasItem
  patchCanvas(
    id: string,
    input: {
      sessionId: string
      title?: string
      spec?: CanvasSpec
      placement?: CanvasPlacement
      size?: CanvasSize
    },
  ): CanvasItem
  listCanvas(sessionId: string): CanvasItem[]
  /**
   * `GET /board`：钉住的卡 + 默认四张（全部 source 卡，不依赖模型）。
   * 左舷是「运行中实例 / 今日中转站用量 / 失败任务」，右舷是「待处理方案」。
   */
  board(): Promise<{ pinned: CanvasItem[]; defaults: CanvasItem[] }>
  setCanvasFlags(
    id: string,
    patch: { pinned?: boolean; order?: number; placement?: CanvasPlacement; size?: CanvasSize },
  ): CanvasItem
  removeCanvas(id: string): void
  createSecretRequest(input: OpsSecretRequestCreate): SecretRequestView
  getSecretRequest(id: string): SecretRequestView
  waitSecretRequest(id: string, waitSec: number): Promise<OpsSecretStatusResponse>
  fillSecretRequest(id: string, value: string, actor: AdminIdentity): void
  cancelSecretRequest(id: string, actor: AdminIdentity): void
  createHandoff(adminId: number): CockpitHandoffResponse
  /** WP56b 的 `POST /api/mobile/auth/cockpit-exchange` 用它换管理员 id */
  consumeHandoff(code: string): number | null
  dispose(): void
}
