import type {
  DesktopRelayFrameEnvelope,
  MobileTokenScope,
  MobileBootstrapResponse,
  MobileErrorCode,
  MobileNodeCapabilities,
  MobileNodesResponse,
  MobileTicketResponse,
  MobileV2Feature,
  MobileWakeResponse,
} from '@dsh-hub/shared'
import type { NodeRemote } from '@dsh-hub/dsh-node-remote'
import type { SessionUser } from '../../lib/session.js'
import type { RequestOrigin } from '../../server/public-request.js'
import type { NodeSession } from './node-session.js'

/** 桌面中继连接（一个设备一条）。 */
export interface RelayConnection {
  readonly deviceId: string
  /** 每条物理 relay 连接的代际身份：旧实例不得再投递/注销新连接（R2）。 */
  readonly generation: string
  /** 服务端已判定断开（close/心跳/吊销）后为 true。 */
  closed: boolean
  readonly userId: number
  clientVersion: string
  hostStatus: 'running' | 'stopped' | 'starting'
  capabilities: MobileNodeCapabilities | null
  /**
   * 中继 hello 里声明的「中继层能放行的 v2 特性」（WP48 / 评估 R1）。
   *
   * 桌面 connector 的 relay 只放行 v1 的 11 种客户端帧，v2 独有帧在中继层就被丢掉并回
   * `unsupported phone frame`。旧 connector 不发这个字段 → `null` = 只支持 v1；
   * Hub 据此把桌面通道的 hello 降级成 v1 形状（`channel.ts` 的 `echoedHello`）。
   */
  relayFeatures: readonly MobileV2Feature[] | null
  /** 发送外层帧；连接已断时静默丢弃。 */
  send(envelope: DesktopRelayFrameEnvelope): void
  /** 服务端主动断开并给出手机能看懂的错误码。 */
  close(code: MobileErrorCode, reason: string): void
  /** 当前还有哪些手机通道挂在这条中继上（关闭时逐个通知）。 */
  readonly channels: Set<string>
}

export interface RelayRegistry {
  get(deviceId: string): RelayConnection | undefined
  listByUser(userId: number): RelayConnection[]
  attach(connection: RelayConnection): void
  detach(deviceId: string): void
}

/**
 * 一个手机通道的节点来源。
 *
 * - `session`：云节点（WP46）—— 通道是常驻会话代理（`NodeSession`）的观察者，
 *   断开只是 detach，**不会**关掉 adapter、也不会把未决提问 next 回 Host；
 * - `cloud`：一条通道独占一个 adapter（M1 行为；现在只有测试与老调用方在用）；
 * - `desktop`：桌面出站中继，保持原行为（问答生命周期在桌面自己的 adapter 里）。
 */
export type ChannelNode =
  | { kind: 'session'; session: NodeSession }
  | { kind: 'cloud'; remote: NodeRemote }
  | { kind: 'desktop'; relay: RelayConnection }

export interface MobileChannelContext {
  userId: number
  nodeId: string
  node: ChannelNode
  /** 会话/设备是否仍然有效（cookie 过期 / 设备被吊销 / 用户被停用 → null）。 */
  validateSession: () => { id: number } | null
  audit: (action: string, detail?: Record<string, unknown>) => void
}

/** 手机设备令牌的附加身份（`req.mobile`；WP40a） */
export interface MobileDeviceIdentity {
  deviceId: string
  /** `desktop_device_tokens.id` = sha256(access token) */
  tokenId: string
  /**
   * 令牌作用域（WP56b）：`mobile` = 手机/网页版的设备令牌（缺省）；
   * `cockpit` = 管理座舱 iframe 的令牌（只认 `cloud:ops`、不占设备名额）。
   */
  scope?: MobileTokenScope
}

/**
 * 移动端服务（M1 + WP40a）：
 *
 * - `listNodes`：节点列表（v1，cookie 与 Bearer 都能用）；
 * - `bootstrap` / `wake`：App 打开后的第一屏（v2 §4.2）；
 * - `issueTicket`：一次性通道 ticket（30 秒，绑定用户 / 设备 / 节点）；
 * - `attachUpgrade`：把 WS 升级挂到 server 上（不经过 Fastify 钩子）。
 */
export interface MobileService {
  /**
   * 节点列表。`device.scope === 'cockpit'` 时只返回 `cloud:ops`（docs/24 §3.3），
   * 其余（含老客户端不传 device）保持「云实例 + 我的桌面设备」。
   */
  listNodes(
    user: SessionUser,
    options?: { freshCloud?: boolean; device?: MobileDeviceIdentity | null },
  ): Promise<MobileNodesResponse>
  /**
   * `GET /api/mobile/bootstrap`：用户 / 积分 / 后端列表 / 实例状态 / App 版本地板（按入口取下载地址）。
   *
   * `device` = 当前请求的设备身份（Bearer 才有）：手机网页版（`platform='web'`）据此拿到
   * 「没有 APK 更新、没有强更地板」的 `app` 段（WP54a）；null（老 APK 的 cookie 路径）行为不变。
   */
  bootstrap(
    user: SessionUser,
    origin: RequestOrigin,
    device: MobileDeviceIdentity | null,
  ): Promise<MobileBootstrapResponse>
  /** `POST /api/mobile/instance/wake`：复用 instances 的 start（含余额、内存、maxRunning 准入） */
  wake(user: SessionUser): Promise<MobileWakeResponse>
  /** `POST /api/mobile/nodes/:id/ticket` */
  issueTicket(
    user: SessionUser,
    nodeId: string,
    device: MobileDeviceIdentity | null,
  ): Promise<MobileTicketResponse>
  attachUpgrade(server: import('node:http').Server): void
  dispose(): Promise<void>
}
