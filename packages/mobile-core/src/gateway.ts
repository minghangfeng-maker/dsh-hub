/**
 * App 只依赖这一个「Hub 网关」接口。
 *
 * 两种实现：
 *  - `HubClient`（真实后端）：HTTPS + Bearer，WS 用一次性 ticket；
 *  - `MockHub`（开发版 mock）：进程内假服务，帧与真实通道完全同构，用来在没有 Hub 的
 *    情况下跑通登录、bootstrap、唤醒、连接、发消息、流式、停止、断线续传。
 *
 * 这样「假 SSE」只会存在于 mock 实现里，正式构建不含任何演示路径。
 */

import type {
  AsrResponse,
  AuthTokens,
  Bootstrap,
  LoginRequest,
  TtsAudio,
  TtsStream,
  WakeResponse,
} from './contracts/auth-bootstrap.js'
import type { ChannelLink } from './channel/link.js'
import type { OriginSwitch } from './http/origin-manager.js'

export interface HubGateway {
  /** 'mock' 时界面上仍然不显示地址（用户在真机上看不到 dev 端点）。 */
  readonly mode: 'http' | 'mock'
  readonly origin: string

  // ── 多入口（0.4.11 / WP52；MockHub 没有这些成员）────────────────────────
  /** 有序候选入口（首选在前）。 */
  readonly originCandidates?: readonly string[]
  /** 读持久化的「上次可用入口」（首次请求前会自动调用）。 */
  ensureOriginReady?(): Promise<void>
  /** 入口切换订阅（UI 据此重连通道）。 */
  onOriginChange?(handler: (change: OriginSwitch) => void): () => void
  /** App 回前台：停在备用入口时静默探回首选，通了才切。 */
  preferPrimaryOrigin?(): Promise<boolean>

  /** 本地是否有可用令牌（不访问网络）。 */
  hasSession(): Promise<boolean>
  restore(): Promise<AuthTokens | null>
  login(input: LoginRequest): Promise<AuthTokens>
  /** 退出并吊销本设备（失败也要清本地令牌）。 */
  logout(): Promise<void>
  /**
   * 合并本机历史重复设备（0.2.9）：同名同平台的旧设备记录吊销，只保留当前这台。
   * 幂等；失败返回 0（不影响主流程）。
   */
  consolidateDevices(): Promise<number>
  bootstrap(): Promise<Bootstrap>
  wake(): Promise<WakeResponse>
  /**
   * 服务端语音识别（0.4.2）：上传一段 WAV（16kHz / 单声道 / 16bit PCM），拿回文字。
   * `bootstrap.voice.asr === true` 时才调用；失败语义交给调用方（提示 + 下次退回系统识别）。
   */
  transcribe(wav: Uint8Array, lang?: string): Promise<AsrResponse>
  /**
   * 朗读合成（0.4.3）：把一小段文字合成为星汐的声音，返回 WAV + 采样率 + 实际音色。
   * 只在 `bootstrap.voice.tts.enabled === true` 时调用；切段由 ui 的 speech-text 负责。
   */
  synthesize(input: { text: string; voice?: string }): Promise<TtsAudio>
  /**
   * 流式朗读（0.4.6 / WP51）：边合成边下发原始 PCM16（无 WAV 头）。
   * 只有 `bootstrap.voice.tts.stream === true` 的 Hub 才有；老 Hub 继续用 `synthesize`。
   * `signal` 取消时抛 `cancelled`；开始下发后连接被掐断抛 `stream-interrupted`。
   */
  synthesizeStream(input: { text: string; voice?: string; signal?: AbortSignal }): Promise<TtsStream>
  /** 申请 ticket 并建立一条通道（每次重连都会重新申请）。 */
  openChannel(nodeId: string): Promise<ChannelLink>
  /** 令牌彻底失效（刷新失败/设备被吊销）时通知 UI。 */
  onAuthLost(handler: (reason: string) => void): () => void
}
