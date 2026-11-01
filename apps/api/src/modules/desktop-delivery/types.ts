import type {
  CheckClientUpdateResponse,
  DesktopConfigDeliverRequest,
  DesktopDeliverResponse,
  DesktopDeliveryState,
  DesktopManifest,
  DesktopPluginArtifact,
  DesktopPluginDeliverRequest,
  DesktopPluginWithdrawRequest,
  DesktopRelease,
  DesktopReleaseListResponse,
  DesktopReleaseRollbackRequest,
  DesktopReleaseRollbackResponse,
  DesktopUninstallDeliverRequest,
  DesktopUpdateFloorResponse,
  PublicDesktopDownloadResponse,
  DesktopAppDeliverRequest,
  UpdateDesktopFloorRequest,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'

/**
 * 桌面下发模块（WP25b）的类型面。
 *
 * 模块边界：本模块拥有「期望状态 / 发布 revision / 插件整包 / feed / 强更地板」这五块数据与接口；
 * 设备台账与令牌仍归 `modules/desktop`（本模块只读它的表与 `req.desktop`），
 * 中转站密钥与模型预设分别归 `relay` / `models`（本模块只调它们的 service 方法）。
 */

/** 一台设备的清单 + 它的 ETag（路由拿去做 304 判定） */
export interface DesktopManifestEnvelope {
  manifest: DesktopManifest
  etag: string
}

/** 设备取件的结果（路由负责流式回送） */
export interface DesktopArtifactDownload {
  filePath: string
  fileName: string
  bytes: number
  /** 插件整包的 sha256（取件接口写进响应头；安装包没有它） */
  sha256: string | null
  /** 安装包的 sha512（base64，与 feed YAML 里的一致；插件整包没有它） */
  sha512: string | null
}

/**
 * 取件地址里的每设备签名（WP31）：`?d=<deviceId>&sig=<签名>`。
 * 桌面端原样使用清单里的 `artifact.url`（不带任何头）；网页/旧客户端仍可用 Bearer 设备令牌。
 */
export interface DesktopArtifactSignature {
  deviceId: string
  signature: string
}

/** 管理端上传插件整包的入参（文件已经落到临时路径，哈希也已在流里算好） */
export interface DesktopArtifactUploadInput {
  /** 路径里的插件 id（与版本所属插件不一致 → 404，避免「A 插件的包传到 B 插件版本上」） */
  pluginId: number
  versionId: number
  /** 临时文件（service 负责搬进 desktop-plugin-store 并改名） */
  tempFile: string
  bytes: number
  sha256: string
  actorId: number | null
  meta: RequestMeta
}

/** 管理端上传安装包的入参（installer 必填，blockmap 可选） */
export interface DesktopReleaseUploadInput {
  target: string
  channel: string
  version: string
  installer: { tempFile: string; fileName: string; bytes: number; sha512: string }
  blockmap: { tempFile: string; fileName: string; bytes: number; sha512: string } | null
  actorId: number | null
  meta: RequestMeta
}

/** WP38：给已有发布记录挂免安装 ZIP（multipart 字段 portable） */
export interface DesktopReleasePortableInput {
  releaseId: number
  portable: { tempFile: string; fileName: string; bytes: number; sha512: string }
  actorId: number | null
  meta: RequestMeta
}

/** 模型预设片段预览（复用现有「下发到 DSH」选好的系统路由与默认模型） */
export interface DesktopModelFragmentPreview {
  /** `null` = 系统预设（WP25e：请求没带 userId 时） */
  userId: number | null
  fragments: { id: string; config: Record<string, unknown> }[]
  warnings: string[]
}

export interface DesktopDeliveryService {
  // ── 设备侧（设备令牌）──────────────────────────────────────────────────
  /**
   * `GET /api/desktop/manifest`：生成这台设备的期望状态清单。
   * **无副作用**（裁决 #4）：只读库、不写 last_seen / 不改 applied*。
   */
  manifestForDevice(deviceId: string): DesktopManifestEnvelope
  /** 设备取插件整包（`@scope/name/version.tgz` 的原始路径段；Bearer 设备令牌路径） */
  artifactDownload(deviceId: string, rawPath: string): DesktopArtifactDownload
  /**
   * 设备取插件整包（**签名路径**，WP31）：设备令牌不可用时的替代鉴权。
   * 校验签名 + 设备/用户有效 + 这个 (包名, 版本) 在这台设备的当前清单里，否则 401。
   */
  signedArtifactDownload(
    rawPath: string,
    signature: DesktopArtifactSignature,
  ): DesktopArtifactDownload
  /** 这台设备当前应达到的 revision（report 响应里填它） */
  desiredRevisionFor(deviceId: string, userId: number): number | null

  // ── 管理端：下发 ────────────────────────────────────────────────────────
  state(): DesktopDeliveryState
  deliverPlugin(
    input: DesktopPluginDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse
  withdrawPlugin(
    input: DesktopPluginWithdrawRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse
  deliverConfig(
    input: DesktopConfigDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse
  deliverApp(
    input: DesktopAppDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse
  deliverUninstall(
    input: DesktopUninstallDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse

  // ── 管理端：插件整包 / 安装包 / 强更地板 ────────────────────────────────
  uploadPluginArtifact(input: DesktopArtifactUploadInput): Promise<DesktopPluginArtifact>
  listArtifacts(): DesktopPluginArtifact[]
  createRelease(input: DesktopReleaseUploadInput): DesktopRelease
  /** `POST /api/admin/desktop/releases/:id/portable`（WP38）：挂/替换免安装 ZIP，不进 feed */
  attachPortable(input: DesktopReleasePortableInput): DesktopRelease
  listReleases(): DesktopReleaseListResponse
  rollbackRelease(
    input: DesktopReleaseRollbackRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopReleaseRollbackResponse
  getFloor(): DesktopUpdateFloorResponse
  setFloor(
    input: UpdateDesktopFloorRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopUpdateFloorResponse

  /**
   * 复用现有「下发到 DSH」的系统路由与默认模型，给管理端预览 llm-pi-ai / agent-default-model 片段。
   * `userId` 省略 = 系统预设；WP28a 起可以再传 `presetId` 指定预设（统一下发用）。
   */
  modelPresetFragments(userId: number | undefined, presetId?: number): Promise<DesktopModelFragmentPreview>

  // ── 平台（docs/22 §2 §3；WP32a）─────────────────────────────────────────
  /**
   * 把「云上版本」对应的**桌面版本**拿出来（没有就复制一条）。桌面整包上传与管理端下发都经它，
   * 保证 `desktop_plugin_artifacts` / `desktop_plugin_targets` 永远指向桌面版本。
   */
  ensureDesktopVersion(versionId: number): { versionId: number; created: boolean }
  /**
   * 桌面模型基线（迁移 124 的服务侧幂等补齐）：桌面默认预设存在、且 `scope=all` 里还没有
   * `llm-pi-ai` / `agent-default-model` 时，用桌面默认预设渲染写入并生成一个新 revision。
   * 已经有两条片段 → 什么都不做（重复调用安全）。
   */
  ensureModelBaseline(): Promise<{ written: boolean; revision: number | null }>
  /**
   * 桌面受众与「最近一次模型配置下发」的时间：
   * `users` = 有有效设备的用户数、`devices` = 有效设备数、`lastConfigAt` = 最近一次
   * kind in (config,mixed) 的桌面发布的时刻（`/api/admin/relay/dsh?platform=desktop` 的 pending 用）。
   */
  audience(): { users: number; devices: number; lastConfigAt: string | null }
  /**
   * 最近一次**写入桌面模型片段**的清单版本（统一下发 models / 桌面模型基线 / 直接改配置片段）：
   * `/api/admin/relay/dsh?platform=desktop` 的 `lastDelivery`。从没有过 = null。
   */
  lastModelDelivery(): { revision: number; at: string; by: string | null } | null

  // ── 公开（匿名）：feed / bin / 强更地板 ──────────────────────────────────
  /** `GET /desktop/feeds/<target>/<channel>.yml`（no-store） */
  feedYaml(target: string, file: string): string
  /** `GET /desktop/bin/<target>/<file>`（长缓存；安装包与 blockmap） */
  releaseFile(target: string, file: string): DesktopArtifactDownload
  /**
   * `GET /api/public/desktop/download`（匿名，公开主页）：`win-x64` 最新已发布安装包，
   * 优先 `latest` 通道，没有则取 `nightly`；都没有 → `windows: null`。
   */
  publicDownload(ip: string | null, origin: RequestOrigin): PublicDesktopDownloadResponse
  /** `GET /api/v0/check_client_update`（匿名；逐字照 D3 §1.4） */
  checkClientUpdate(
    headers: Record<string, string | string[] | undefined>,
    ip: string | null,
  ): CheckClientUpdateResponse
}
