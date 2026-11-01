/**
 * hubAgentModes —— 桌面端由 hub-connector 注册的 Cordis 服务。
 *
 * 这**不是**运行时依赖：两个 pilot 只用 `ctx.inject(['hubAgentModes'], …)` 可选注入，
 * 服务不存在（容器里的形态）时一律退回 `HUB_CLAUDE_*` / `HUB_CODEX_*` 环境变量，行为与今天完全一致。
 * 这份声明是给桌面端 hub-connector 实现用的契约，两个插件各带一份、内容一致。
 *
 * 插件实际怎么用它（`runtime/setup.js` 的 `hubFromService()`）：
 *   1. `available(scope) === false` → 当成没有服务（等价于 `credentials()` 返回 null）；
 *   2. `credentials(scope)` 返回 `{ auth, key, baseUrl, model, label }` → 当成 Hub 下发的账号，
 *      后续与容器里那条链完全一样：拼 `/v1/hub/agent-mode`（Claude，base 不带 /v1）或
 *      `/hub/agent-mode`（Codex，base 自带 /v1）、拉模型列表、注入子进程环境、banner 用 Hub 的中文原因；
 *   3. 返回的对象不合法（缺 key、Claude 的 auth 不在三选一里）→ 同样当成没有服务，退回环境变量；
 *   4. 收到 `onChange` 通知 → 清掉 Hub 配置缓存与就绪缓存，下一轮按新配置重新走
 *      （与「设置页改了配置」同一条刷新路径，不需要重启 DSH）。
 *
 * 安全：`credentials()` 返回的是模式密钥（scope = claude-code | codex），插件只把它写进子进程环境 /
 * 自己的 CODEX_HOME 的 config.toml；它不落 DSH 会话日志、不进 `status()`（状态接口只给布尔值与中文原因）。
 */

/** 两个 pilot 的作用域 = Hub 里模式的 scope = 中转站密钥的 scope（也是计费口径，不要改成 `dsh`）。 */
export type PilotScope = 'claude-code' | 'codex'

/**
 * 模型条目：与 Hub 的 `AgentModeClientConfigSchema.models[]`（`docs/18 §3.4`）同形。
 * 插件只用 `id` / `displayName` 做模型选择器；其余字段原样透传给前端。
 */
export interface HubAgentModeModel {
  id: string
  displayName?: string | null
  contextWindow?: number | null
  maxTokens?: number | null
  reasoningEfforts?: string[] | null
  defaultThinking?: string | null
}

/** 一个作用域当前可用的接入点。`key` 是 Hub 签给这台设备/这个用户的模式密钥。 */
export interface HubAgentModeCredentials {
  /**
   * Claude 专用：告诉插件往子进程里注入哪个变量
   *   apiKey → ANTHROPIC_API_KEY（x-api-key），authToken → ANTHROPIC_AUTH_TOKEN（Bearer），
   *   oauthToken → CLAUDE_CODE_OAUTH_TOKEN。
   * Codex 恒为 apiKey（写进 CODEX_HOME/config.toml 的自定义 provider，密钥走 CODEX_PILOT_API_KEY）。
   * 缺省按 `apiKey`（Codex）处理；Claude 缺省视为「不可用」。
   */
  auth?: 'apiKey' | 'authToken' | 'oauthToken'
  /** 中转站密钥（`sk-dsh-…`）。必填；空串视为不可用。插件不解释它的内容。 */
  key: string
  /**
   * 中转站根地址，拼法与容器 env 一致（别在这里多写/少写 `/v1`）：
   *   claude-code：不带 `/v1`（插件拼 `${baseUrl}/v1/hub/agent-mode`，Anthropic SDK 自己拼 `/v1/messages`）；
   *   codex：带 `/v1`（插件拼 `${baseUrl}/hub/agent-mode`）。
   * 缺省时 Claude 视为不可用；Codex 默认 `https://api.openai.com/v1`（与 env 模式一致）。
   */
  baseUrl: string
  /** 管理员设的默认模型（可空 = 跟随 `/v1/hub/agent-mode` 返回的 defaultModel）。 */
  model?: string
  /** Codex 专用：`responses` | `chat`，缺省 `responses`。 */
  wireApi?: 'responses' | 'chat'
  /** 设置页显示的账号名，缺省 `DSH Hub`。 */
  label?: string
  /**
   * 可选扩展（可选扩展，后端可以先不实现）：
   * hub-connector 缓存的模型列表。插件只在拉 `/v1/hub/agent-mode` 没成功时用它兜底模型选择器
   * （就绪判定仍以拉取结果为准），所以不给也不影响功能。
   */
  models?: HubAgentModeModel[]
}

/** `refresh()` 的结果。 */
export interface HubAgentModeRefreshResult {
  ok: boolean
  /** 失败原因（Hub 的中文原因优先；插件会把它显示在输入框上方的提示条里）。 */
  error?: string
  /** 刷新后拿到的模型列表（可选）。 */
  models?: HubAgentModeModel[]
}

/**
 * 服务接口。Cordis 里用 `ctx.set('hubAgentModes', service)` / `Service` 子类注册均可；
 * 插件只依赖 `credentials` 这一个方法存在（其余可选）。
 */
export interface HubAgentModesService {
  /**
   * 同步读：当前是否由 Hub 托管（已登录 + 管理员开通 + 在 targets 内 + 设备未被吊销）。
   * 必须读缓存，不能发起网络请求。
   */
  available(scope: PilotScope): boolean
  /**
   * 同步读：给子进程的凭据；不可用 → null。必须已缓存（网络请求在后台）。
   * 插件每一轮对话都会调用它（可能每秒多次），不要在这里做 IO。
   */
  credentials(scope: PilotScope): HubAgentModeCredentials | null
  /**
   * 异步刷新（设置页打开、每轮开始前、管理员改配置后、设备密钥轮换后）。
   * 插件不强制调用它：拉 `/v1/hub/agent-mode` 的 30 秒缓存已经覆盖了「每轮开始前」这条需求。
   */
  refresh(scope: PilotScope, options?: { force?: boolean }): Promise<HubAgentModeRefreshResult>
  /** 变更通知（登录/登出、下发、管理员改模型、被移出 targets）。返回取消订阅函数。 */
  onChange(scope: PilotScope, listener: () => void): () => void
}

/*
 * 在 hub-connector 里注册与声明（示意；模块名以实际实现里的 import 为准）：
 *
 *   import type { HubAgentModesService } from './hub-agent-modes'
 *
 *   declare module '@deepseek-ai/cordis' {
 *     interface Context {
 *       hubAgentModes?: HubAgentModesService   // 可选：容器里没有
 *     }
 *   }
 *
 *   const service: HubAgentModesService = { available, credentials, refresh, onChange }
 *   ctx.set('hubAgentModes', service)
 */
