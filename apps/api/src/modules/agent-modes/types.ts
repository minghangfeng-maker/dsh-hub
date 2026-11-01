import type {
  AgentMode,
  AgentModeClientConfig,
  AgentModeSettings,
  AgentModeStateResponse,
  DeliverAgentModeRequest,
  UpdateAgentModeRequest,
  MyAgentMode,
  RelayScope,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/**
 * Claude Code / Codex 管理（18）：设置、下发任务、容器 env、给插件与用户端的只读视图。
 *
 * 模块边界：relay 管渠道/模型/密钥/用量/计费；本模块只读写自己的 settings 键，
 * 其余动作全部通过 `deps.services.<x>`（relay / plugins / instances / jobs）完成。
 */
export interface AgentModesService {
  /** 一个模式的当前设置（内存缓存；PUT 后立即失效） */
  settings(mode: AgentMode): AgentModeSettings
  /** 所有模式的设置（容器 env 用） */
  allSettings(): Record<AgentMode, AgentModeSettings>
  /** 18 §3.2：模式开着且用户在这个模式的 targets 里 */
  isOpenFor(scope: RelayScope, userId: number): boolean
  /** 18 D4：模式整体倍率（千分比）；dsh 不走这里 */
  ratePermille(mode: AgentMode): number
  /**
   * 18 §4.1：该用户两个模式的容器 env（`models.containerEnv` 通过晚绑定桥调用）。
   * 只含开通且在该模式 targets 里的用户；内部监听器关闭 / 密钥签发失败时不注入（告警在管理页）。
   */
  envForUser(userId: number): Record<string, string>
  /** 管理页的即时提示（内部监听器、插件、默认模型失效等） */
  warnings(mode: AgentMode): string[]
  /** `GET /api/admin/agent-modes/:mode` */
  state(mode: AgentMode): Promise<AgentModeStateResponse>
  /** `PUT /api/admin/agent-modes/:mode` */
  update(
    mode: AgentMode,
    input: UpdateAgentModeRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<AgentModeStateResponse>
  /** `POST /api/admin/agent-modes/:mode/deliver`：建 `rollout.agent-mode` 任务 */
  deliver(
    mode: AgentMode,
    input: DeliverAgentModeRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<{ jobId: number }>
  /** 18 §3.4：给插件的配置（`/v1/hub/agent-mode`） */
  clientConfig(mode: AgentMode, userId: number, role: 'user' | 'admin'): AgentModeClientConfig
  /** 18 §7：`/api/me/relay.agentModes`（只含对我开通的模式） */
  myModes(userId: number, role: 'user' | 'admin'): MyAgentMode[]
  /** 下发任务要处理的用户：targets ∪ 运行中容器 env 里还有这个模式的用户 */
  deliverTargetUsers(mode: AgentMode): Promise<number[]>
}
