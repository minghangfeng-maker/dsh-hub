import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DESKTOP_ARTIFACT_KEEP_VERSIONS,
  DESKTOP_CONFIG_ALLOWLIST_VERSION,
  DESKTOP_INSTALLER_MAX_BYTES,
  DESKTOP_MANDATORY_UPDATE_CODE,
  checkClientUpdateNotMandatory,
  desktopLevelOfPolicy,
  type CheckClientUpdateResponse,
  type DesktopConfigDeliverRequest,
  type DesktopDeliverResponse,
  type DesktopDeliveryState,
  type DesktopPluginArtifact,
  type DesktopPluginDeliverRequest,
  type DesktopPluginTarget,
  type DesktopPluginWithdrawRequest,
  type DesktopRelease,
  type DesktopReleaseListResponse,
  type DesktopReleaseRollbackRequest,
  type DesktopReleaseRollbackResponse,
  type DesktopUninstallDeliverRequest,
  type DesktopUpdateFloorResponse,
  type PublicDesktopDownloadResponse,
  type DesktopAppDeliverRequest,
  type UpdateDesktopFloorRequest,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { createWindowCounter } from '../../lib/rate-limit.js'
import { loadMasterKeyIfExists } from '../../lib/secrets.js'
import type { RequestOrigin } from '../../server/public-request.js'
import {
  addUninstallTarget,
  appendDelivery,
  copyVersionToPlatform,
  countActiveDevicesFor,
  deleteArtifact,
  deletePluginTarget,
  desktopAudience,
  findVersionOfPlatform,
  getPluginPlatformSettings,
  getVersionPlatformRow,
  insertPluginPlatformSettings,
  deletePolicyOverride,
  desiredRevisionFor,
  findArtifactByPackageVersion,
  findReleaseByInstallerFile,
  findReleaseByVersion,
  getArtifact,
  getChannelPolicy,
  getFloor,
  getRelease,
  getUserRole,
  insertRelease,
  latestPublishedRelease,
  listArtifactsByPlugin,
  listChannelPolicies,
  listConfigFragments,
  lastModelConfigDelivery,
  listConfigFragmentsFor,
  listNewerReleases,
  listPluginTargets,
  listPolicyOverrides,
  listReleases,
  listUninstallTargets,
  previousPublishedRelease,
  readCounter,
  removeUninstallTarget,
  replaceConfigFragments,
  scopeOf,
  setReleasePortable,
  setReleaseStatus,
  updateFloor,
  upsertArtifact,
  upsertChannelPolicy,
  upsertPluginTarget,
  upsertPolicyOverride,
  type ArtifactRow,
  type ReleaseRow,
  type ScopeKey,
} from './repo.js'
import {
  buildManifest,
  channelPolicyViewOf,
  effectivePlugins,
  feedFileOf,
  manifestEtagOf,
  policyOverrideViewOf,
  publicizeRelayBaseUrls,
  releaseTargetOf,
  type ManifestDeviceContext,
} from './manifest.js'
import { desktopArtifactSigningKey, signArtifact, verifyArtifactSignature } from './artifact-sign.js'
import {
  carriesCodexBinary,
  findForbiddenClaudeBinary,
  hasFileNamed,
  hasPackageJson,
  scanTarGzNames,
} from './tar-scan.js'
import type {
  DesktopArtifactDownload,
  DesktopArtifactSignature,
  DesktopArtifactUploadInput,
  DesktopDeliveryService,
  DesktopManifestEnvelope,
  DesktopModelFragmentPreview,
  DesktopReleasePortableInput,
  DesktopReleaseUploadInput,
} from './types.js'

/** 清单拉取限流：每台设备每分钟 120 次（10 分钟心跳一次，正常远低于它） */
const MANIFEST_LIMIT_PER_MINUTE = 120
/** 插件包下载限流：每台设备每分钟 60 次（一次下发最多 64 个插件 × 重试） */
const ARTIFACT_LIMIT_PER_MINUTE = 60
/** 强更地板是匿名端点：按 IP 每分钟 120 次（上游 10 分钟一次） */
const FLOOR_LIMIT_PER_MINUTE = 120
/** 公开主页的安装包信息也是匿名端点：按 IP 每分钟 120 次（一次访问只问一次） */
const PUBLIC_DOWNLOAD_LIMIT_PER_MINUTE = 120

/** manifest / feed 的 ETag 命中判断（与 /api/desktop/session 同一写法） */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const values = Array.isArray(header) ? header : [header]
  return values.some(
    (value) => typeof value === 'string' && value.split(',').some((part) => part.trim() === etag),
  )
}

/** semver 比较（够用版：主次修补 + 预发布；不处理 build metadata 的排序，semver 本来也不比它） */
export function compareSemver(a: string, b: string): number {
  const split = (value: string): { core: number[]; pre: string[] } => {
    const [main, prerelease] = value.replace(/\+.*$/u, '').split('-', 2)
    return {
      core: (main ?? '').split('.').map((part) => Number.parseInt(part, 10)),
      pre: prerelease ? prerelease.split('.') : [],
    }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < 3; i += 1) {
    const l = left.core[i] ?? 0
    const r = right.core[i] ?? 0
    if (Number.isFinite(l) && Number.isFinite(r) && l !== r) return l < r ? -1 : 1
  }
  // 没有预发布的一方更大（1.2.3 > 1.2.3-rc.1）
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/u.test(l) ? Number.parseInt(l, 10) : null
    const rn = /^\d+$/u.test(r) ? Number.parseInt(r, 10) : null
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1
      continue
    }
    // 数字标识符永远小于字母标识符
    if (ln !== null) return -1
    if (rn !== null) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** 文件名 → 路径安全段（只允许字母数字点横线下划线，且不以点开头） */
function safeFileSegment(name: string, what: string): string {
  const base = basename(name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base) || base.length > 200) {
    throw new HubError('VALIDATION_FAILED', `${what}的文件名不合法（只允许字母数字 . _ -）`)
  }
  return base
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function removeFileQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // 删不掉不该让业务失败（下次上传会覆盖）
  }
}

/**
 * 桌面下发服务（WP25b）。
 *
 * 一句话：**下发 = 写期望状态 + 追加一条发布日志（新 revision）**；设备端只看到两个纯读接口
 * （清单、取件），它们不改任何 `applied*`/`last_report_at` —— 心跳只走 `POST /api/desktop/devices/report`。
 */
export function createDesktopDeliveryService(deps: BaseDeps): DesktopDeliveryService {
  const { db, clock, audit, logger, paths, config } = deps
  const manifestLimit = createWindowCounter({ capacity: MANIFEST_LIMIT_PER_MINUTE, windowMs: 60_000, clock })
  const artifactLimit = createWindowCounter({ capacity: ARTIFACT_LIMIT_PER_MINUTE, windowMs: 60_000, clock })
  const floorLimit = createWindowCounter({ capacity: FLOOR_LIMIT_PER_MINUTE, windowMs: 60_000, clock })
  const downloadLimit = createWindowCounter({
    capacity: PUBLIC_DOWNLOAD_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clock,
  })

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function now(): string {
    return clock.nowIso()
  }

  function origin(): string {
    return config.publicOrigin
  }

  /** 中转站内部监听器的 origin：桌面片段里指向它的 baseURL 要换成公开 origin（容器网络外连不上） */
  function relayInternalOrigin(): string | null {
    const base = services().relay?.internalBaseUrl() ?? null
    if (base === null) return null
    try {
      return new URL(base).origin
    } catch {
      return null
    }
  }

  function publicize(config: Record<string, unknown>): Record<string, unknown> {
    return publicizeRelayBaseUrls(config, relayInternalOrigin(), origin())
  }

  function auditDeliver(entry: {
    actorId: number | null
    meta: RequestMeta
    action: string
    targetType: string
    targetId: string | number | null
    detail: Record<string, unknown>
  }): void {
    audit.log({
      actorId: entry.actorId,
      actorIp: entry.meta.ip,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail,
    })
  }

  /** 发布：追加发布日志 + 写审计 `desktop.deliver`，返回新 revision 与受影响设备数 */
  function publish(
    scope: ScopeKey,
    kind: 'plugin' | 'config' | 'app' | 'uninstall' | 'mixed',
    actorId: number | null,
    meta: RequestMeta,
    detail: Record<string, unknown>,
  ): DesktopDeliverResponse {
    const revision = appendDelivery(db, {
      scope,
      kind,
      actorId,
      detail,
      at: now(),
    })
    const affectedDevices = countActiveDevicesFor(db, scope)
    auditDeliver({
      actorId,
      meta,
      action: 'desktop.deliver',
      targetType: 'desktop.delivery',
      targetId: revision,
      detail: { ...detail, scope: scope.scope, role: scope.role || null, userId: scope.userId },
    })
    logger.debug({ revision, scope, kind, affectedDevices }, '桌面下发：生成新 revision')
    return { revision, affectedDevices }
  }

  // ── 设备侧 ────────────────────────────────────────────────────────────────

  interface DeviceRow {
    device_id: string
    user_id: number
    app_channel: string | null
    platform: string | null
    arch: string | null
    role: string
    user_status: string
  }

  /** 设备维度上下文（清单渲染与「在不在当前清单里」的判断共用） */
  function manifestDeviceOf(device: DeviceRow): ManifestDeviceContext {
    return {
      deviceId: device.device_id,
      userId: device.user_id,
      role: device.role,
      appChannel: device.app_channel,
      platform: device.platform,
      arch: device.arch,
    }
  }

  function requireDevice(deviceId: string): DeviceRow {
    const row = db.get<DeviceRow>(
      `SELECT d.device_id, d.user_id, d.app_channel, d.platform, d.arch, u.role, u.status AS user_status
         FROM desktop_devices d JOIN users u ON u.id = d.user_id
        WHERE d.device_id = ? AND d.status = 'active' AND u.deleted_at IS NULL`,
      deviceId,
    )
    if (!row) throw new HubError('DEVICE_TOKEN_INVALID')
    return row
  }

  /**
   * 签名路径的设备校验（WP31）：比 Bearer 路径多查一条「用户仍然可用」。
   * Bearer 路径的令牌解析（`resolveDeviceToken`）本来就会拦掉停用用户；签名路径没有令牌，
   * 所以必须自己查 `users.status`，否则管理员停用账号后旧签名还能取件（任务书要求 401）。
   */
  function requireSignedDevice(deviceId: string): DeviceRow {
    const row = requireDevice(deviceId)
    if (row.user_status !== 'active') throw new HubError('DEVICE_TOKEN_INVALID')
    return row
  }

  /** 取件签名密钥（主密钥派生；主密钥没初始化就发不出签名地址 → INTERNAL） */
  function artifactSigningKey(): Buffer {
    const master = loadMasterKeyIfExists(paths.masterKeyFile)
    if (!master) throw new HubError('INTERNAL', '主密钥未初始化，无法签发插件整包的取件地址')
    return desktopArtifactSigningKey(master)
  }

  function manifestForDevice(deviceId: string): DesktopManifestEnvelope {
    const device = requireDevice(deviceId)
    const gate = manifestLimit.consume(deviceId)
    if (!gate.allowed) {
      throw new HubError('RATE_LIMITED', '清单拉取太频繁', { retryAfterSec: gate.retryAfterSec })
    }
    const channel = device.app_channel === 'nightly' ? 'nightly' : 'latest'
    const target = releaseTargetOf(device.platform, device.arch)
    const feedAvailable = target !== null && latestPublishedRelease(db, target, channel) !== undefined
    const signingKey = artifactSigningKey()
    const { manifest } = buildManifest({
      now: now(),
      revision: desiredRevisionFor(db, device.user_id, device.role),
      origin: origin(),
      device: manifestDeviceOf(device),
      plugins: listPluginTargets(db),
      fragments: listConfigFragments(db),
      uninstalls: listUninstallTargets(db),
      channelPolicy: getChannelPolicy(db, channel),
      overrides: listPolicyOverrides(db),
      feedAvailable,
      // WP31：清单里的取件地址带每设备稳定签名（桌面端不带令牌也能下载）
      signArtifact: (input) => signArtifact(signingKey, input),
      relayInternalOrigin: relayInternalOrigin(),
    })
    return { manifest, etag: manifestEtagOf(manifest) }
  }

  function desiredRevisionForDevice(deviceId: string, userId: number): number | null {
    void deviceId
    const role = getUserRole(db, userId)
    if (role === null) return null
    return desiredRevisionFor(db, userId, role)
  }

  /** `@local/dsh-memory/0.1.2.tgz` → 包名 + 版本（包名可能带 scope，所以取最后一段当文件） */
  function parseArtifactPath(rawPath: string): { packageName: string; version: string } {
    const cleaned = rawPath.replace(/^\/+/u, '')
    const slash = cleaned.lastIndexOf('/')
    if (slash <= 0) throw new HubError('NOT_FOUND')
    const packageName = cleaned.slice(0, slash)
    const file = cleaned.slice(slash + 1)
    if (!file.endsWith('.tgz')) throw new HubError('NOT_FOUND')
    return { packageName, version: file.slice(0, -4) }
  }

  /** 库里那行 + 磁盘上那个文件 → 取件结果（Bearer 与签名两条路径共用） */
  function artifactFileOf(artifact: ArtifactRow, packageName: string): DesktopArtifactDownload {
    const filePath = join(paths.desktopPluginStoreDir, artifact.file_name)
    if (!existsSync(filePath)) {
      logger.warn({ filePath, packageName }, '桌面整包的文件不见了（库里还有行）')
      throw new HubError('NOT_FOUND', '插件包文件已丢失，请联系管理员重新上传')
    }
    return {
      filePath,
      fileName: artifact.file_name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sha512: null,
    }
  }

  /** Bearer 路径（旧客户端）：设备令牌已由会话钩子解析，这里沿用原有 404 语义 */
  function artifactDownload(deviceId: string, rawPath: string): DesktopArtifactDownload {
    requireDevice(deviceId)
    const gate = artifactLimit.consume(deviceId)
    if (!gate.allowed) {
      throw new HubError('RATE_LIMITED', '取件太频繁', { retryAfterSec: gate.retryAfterSec })
    }
    const { packageName, version } = parseArtifactPath(rawPath)
    const artifact = findArtifactByPackageVersion(db, packageName, version)
    if (!artifact) throw new HubError('NOT_FOUND', '这个插件的桌面整包不存在')
    return artifactFileOf(artifact, packageName)
  }

  /**
   * 签名路径（WP31，桌面端不带任何头）：`?d=<deviceId>&sig=<签名>`。
   *
   * 校验链（任何一步不过都回 **401 DEVICE_TOKEN_INVALID**，不区分原因，也不透露包/设备是否存在）：
   * ① 设备存在且 active、所属用户未删除且 active；
   * ② 库里有这个 (包名, 版本) 的整包（签名原文要用它的 sha256）；
   * ③ HMAC 签名对得上（改包名/版本/设备 id/sha256 都会失败）；
   * ④ 这个 (包名, 版本) 确实在**这台设备的当前清单**里（撤回下发 → 立即失效）——
   *    与清单渲染同一套 `effectivePlugins` + `toManifestPlugin` 的过滤条件（hidden / 缺整包不下发）；
   * ⑤ 按 deviceId 计限流（放在验签之后：无效请求不消耗别的设备的配额）。
   */
  function signedArtifactDownload(
    rawPath: string,
    signature: DesktopArtifactSignature,
  ): DesktopArtifactDownload {
    const { packageName, version } = parseArtifactPath(rawPath)
    const device = requireSignedDevice(signature.deviceId)
    const artifact = findArtifactByPackageVersion(db, packageName, version)
    if (!artifact) throw new HubError('DEVICE_TOKEN_INVALID')
    const signed = verifyArtifactSignature(
      artifactSigningKey(),
      {
        deviceId: device.device_id,
        packageName: artifact.package_name,
        version: artifact.version,
        sha256: artifact.sha256,
      },
      signature.signature,
    )
    if (!signed) throw new HubError('DEVICE_TOKEN_INVALID')
    if (!isArtifactInDeviceManifest(manifestDeviceOf(device), artifact)) {
      throw new HubError('DEVICE_TOKEN_INVALID')
    }
    const gate = artifactLimit.consume(device.device_id)
    if (!gate.allowed) {
      throw new HubError('RATE_LIMITED', '取件太频繁', { retryAfterSec: gate.retryAfterSec })
    }
    return artifactFileOf(artifact, packageName)
  }

  /** 这个整包是否正在该设备的当前清单里（与清单渲染同一口径：作用域优先级 + policy + 有整包） */
  function isArtifactInDeviceManifest(device: ManifestDeviceContext, artifact: ArtifactRow): boolean {
    return effectivePlugins(listPluginTargets(db), device, listUninstallTargets(db)).some(
      (row) =>
        row.plugin_id === artifact.plugin_id &&
        row.version_id === artifact.version_id &&
        row.package_name === artifact.package_name &&
        row.version === artifact.version &&
        desktopLevelOfPolicy(row.policy as 'required' | 'default' | 'optional' | 'hidden') !== null &&
        row.file_name !== null &&
        row.sha256 !== null &&
        row.bytes !== null,
    )
  }

  // ── 管理端：状态 ──────────────────────────────────────────────────────────

  function artifactView(row: ArtifactRow): DesktopPluginArtifact {
    return {
      pluginId: row.plugin_id,
      packageName: row.package_name,
      versionId: row.version_id,
      version: row.version,
      fileName: row.file_name,
      bytes: row.bytes,
      sha256: row.sha256,
      uploadedAt: row.uploaded_at,
    }
  }

  function scopeView(row: { scope: string; role: string; user_id: number | null }): {
    scope: 'all' | 'role' | 'user'
    role: 'user' | 'admin' | null
    userId: number | null
  } {
    return {
      scope: row.scope === 'user' ? 'user' : row.scope === 'role' ? 'role' : 'all',
      role: row.role === 'user' || row.role === 'admin' ? row.role : null,
      userId: row.user_id,
    }
  }

  function state(): DesktopDeliveryState {
    const warnings: string[] = []
    if (!origin().startsWith('https://')) {
      warnings.push(
        `Hub 的公开 origin（${origin()}）不是 https：清单里的 artifact.url / app.feedUrl 不满足 D3 schema（客户端会整份拒绝）`,
      )
    }
    const pluginTargets: DesktopPluginTarget[] = []
    for (const row of listPluginTargets(db)) {
      const level = desktopLevelOfPolicy(row.policy as 'required' | 'default' | 'optional' | 'hidden')
      if (level === null) {
        warnings.push(`插件 ${row.package_name} 的 policy 已是 hidden，这个受管条目不会下发（请撤掉）`)
        continue
      }
      const artifact =
        row.file_name !== null &&
        row.sha256 !== null &&
        row.bytes !== null &&
        row.artifact_uploaded_at !== null
          ? {
              pluginId: row.plugin_id,
              packageName: row.package_name,
              versionId: row.version_id,
              version: row.version,
              fileName: row.file_name,
              bytes: row.bytes,
              sha256: row.sha256,
              uploadedAt: row.artifact_uploaded_at,
            }
          : null
      if (artifact === null) {
        warnings.push(`插件 ${row.package_name}@${row.version} 还没有上传桌面整包，设备拿不到它`)
      }
      pluginTargets.push({
        id: row.id,
        pluginId: row.plugin_id,
        packageName: row.package_name,
        displayName: row.display_name,
        policy: row.policy as DesktopPluginTarget['policy'],
        versionId: row.version_id,
        version: row.version,
        level,
        enabled: row.enabled === 1,
        needsRestart: row.needs_restart === 1,
        minDsh: row.min_dsh,
        artifact,
        ...scopeView(row),
      })
    }

    const configFragments = listConfigFragments(db).map((row) => {
      let parsed: Record<string, unknown> = {}
      try {
        const value = JSON.parse(row.config_json) as unknown
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          parsed = publicize(value as Record<string, unknown>)
        } else {
          warnings.push(`配置片段 ${row.entry_id} 的内容不是对象`)
        }
      } catch {
        warnings.push(`配置片段 ${row.entry_id} 不是合法 JSON`)
      }
      // hub-connector 的代理地址若指向别的 origin，给一条提示（不阻止 —— 反代/内网镜像都可能）
      const providers = (parsed['providers'] ?? null) as Record<string, { baseURL?: unknown }> | null
      if (providers && typeof providers === 'object') {
        for (const [routeKey, provider] of Object.entries(providers)) {
          const baseURL = typeof provider?.baseURL === 'string' ? provider.baseURL : null
          if (baseURL !== null && !baseURL.startsWith(origin())) {
            warnings.push(
              `配置片段 llm-pi-ai 的 provider ${routeKey} 的 baseURL（${baseURL}）不在 Hub 的公开 origin（${origin()}）下`,
            )
          }
        }
      }
      return {
        id: row.id,
        entryId: row.entry_id,
        mode: row.mode === 'default' ? ('default' as const) : ('enforce' as const),
        config: parsed,
        note: row.note,
        ...scopeView(row),
      }
    })

    const uninstalls = listUninstallTargets(db).map((row) => ({
      id: row.id,
      packageName: row.package_name,
      ...scopeView(row),
    }))

    return {
      revision: readCounter(db),
      allowlistVersion: DESKTOP_CONFIG_ALLOWLIST_VERSION,
      pluginTargets,
      configFragments,
      uninstalls,
      app: {
        channels: listChannelPolicies(db).map(channelPolicyViewOf),
        overrides: listPolicyOverrides(db).map(policyOverrideViewOf),
      },
      warnings,
    }
  }

  // ── 管理端：三类下发 ──────────────────────────────────────────────────────

  function deliverPlugin(
    input: DesktopPluginDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse {
    const plugin = db.get<{ id: number; package_name: string; policy: string }>(
      'SELECT id, package_name, policy FROM plugins WHERE id = ?',
      input.pluginId,
    )
    if (!plugin) throw new HubError('NOT_FOUND', '插件不存在')
    // docs/22 §2.1：下发 level 看**桌面平台**的 policy（云上设为 required 不再等于桌面必装）
    const desktopSettings = getPluginPlatformSettings(db, input.pluginId, 'desktop')
    const desktopPolicy = desktopSettings?.policy ?? plugin.policy
    if (desktopPolicy === 'hidden') {
      throw new HubError('VALIDATION_FAILED', `插件 ${plugin.package_name} 的桌面 policy 是 hidden，不能下发`, {
        fields: { pluginId: 'hidden 不下发（裁决 #17）' },
      })
    }
    // 只管桌面版本：给的是云上版本时自动落到同名桌面版本（桌面整包必须有对应的桌面版本行）
    const target = ensureDesktopVersion(input.versionId)
    const version = db.get<{ id: number; version: string }>(
      'SELECT id, version FROM plugin_versions WHERE id = ? AND plugin_id = ?',
      target.versionId,
      input.pluginId,
    )
    if (!version) throw new HubError('VALIDATION_FAILED', '版本不存在或不属于这个插件')
    const artifact = getArtifact(db, target.versionId)
    if (!artifact) {
      throw new HubError(
        'VALIDATION_FAILED',
        `插件 ${plugin.package_name}@${version.version} 还没有上传桌面整包，先把包传上来再下发`,
        { fields: { versionId: '缺桌面整包' } },
      )
    }
    const scope = scopeOf(input.target)
    upsertPluginTarget(db, {
      scope,
      pluginId: input.pluginId,
      versionId: target.versionId,
      enabled: input.enabled ?? true,
      actorId,
      at: now(),
    })
    removeUninstallTarget(db, scope, plugin.package_name)
    return publish(scope, 'plugin', actorId, meta, {
      pluginId: input.pluginId,
      packageName: plugin.package_name,
      versionId: target.versionId,
      version: version.version,
      enabled: input.enabled ?? true,
      action: 'deliver',
    })
  }

  function withdrawPlugin(
    input: DesktopPluginWithdrawRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse {
    const scope = scopeOf(input.target)
    const changed = deletePluginTarget(db, scope, input.pluginId)
    if (changed === 0) throw new HubError('NOT_FOUND', '这个目标上没有该插件的受管条目')
    return publish(scope, 'plugin', actorId, meta, {
      pluginId: input.pluginId,
      action: 'withdraw',
    })
  }

  function deliverConfig(
    input: DesktopConfigDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse {
    const scope = scopeOf(input.target)
    replaceConfigFragments(db, {
      scope,
      fragments: input.fragments.map((fragment) => ({
        entryId: fragment.id,
        mode: fragment.mode,
        configJson: JSON.stringify(fragment.config),
        note: fragment.note ?? '',
      })),
      actorId,
      at: now(),
    })
    return publish(scope, 'config', actorId, meta, {
      entryIds: input.fragments.map((fragment) => fragment.id),
      count: input.fragments.length,
    })
  }

  function deliverApp(
    input: DesktopAppDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse {
    const channel = input.channel
    const target = input.target ?? { scope: 'all' as const }
    const scope = scopeOf(target)
    if (scope.scope === 'all') {
      // 渠道级策略：没给的字段保持原值（避免一次 PUT 把灰度重置回 100）
      const current = getChannelPolicy(db, channel)
      upsertChannelPolicy(db, {
        channel,
        targetVersion:
          input.targetVersion === undefined ? (current?.target_version ?? null) : input.targetVersion,
        minVersion: input.minVersion === undefined ? (current?.min_version ?? null) : input.minVersion,
        minVersionHard: input.minVersionHard ?? current?.min_version_hard === 1,
        rolloutPercent: input.rolloutPercent ?? current?.rollout_percent ?? 100,
        actorId,
        at: now(),
      })
      return publish(scope, 'app', actorId, meta, {
        channel,
        targetVersion: input.targetVersion ?? null,
        minVersion: input.minVersion ?? null,
        minVersionHard: input.minVersionHard ?? null,
        rolloutPercent: input.rolloutPercent ?? null,
      })
    }
    const allNull =
      input.targetVersion === null &&
      input.minVersion === null &&
      input.minVersionHard === undefined &&
      input.rolloutPercent === undefined
    if (allNull) {
      // 覆盖项整条清空 = 回到渠道级策略
      const removed = deletePolicyOverride(db, channel, scope)
      if (removed === 0) throw new HubError('NOT_FOUND', '这个目标上没有该渠道的覆盖项')
    } else {
      upsertPolicyOverride(db, {
        channel,
        scope,
        targetVersion: input.targetVersion,
        minVersion: input.minVersion,
        minVersionHard: input.minVersionHard,
        rolloutPercent: input.rolloutPercent,
        actorId,
        at: now(),
      })
    }
    return publish(scope, 'app', actorId, meta, {
      channel,
      targetVersion: input.targetVersion ?? null,
      minVersion: input.minVersion ?? null,
      minVersionHard: input.minVersionHard ?? null,
      rolloutPercent: input.rolloutPercent ?? null,
      cleared: allNull,
    })
  }

  function deliverUninstall(
    input: DesktopUninstallDeliverRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopDeliverResponse {
    const scope = scopeOf(input.target)
    const at = now()
    for (const name of input.add ?? []) {
      addUninstallTarget(db, { scope, packageName: name, actorId, at })
    }
    for (const name of input.remove ?? []) {
      removeUninstallTarget(db, scope, name)
    }
    return publish(scope, 'uninstall', actorId, meta, {
      add: input.add ?? [],
      remove: input.remove ?? [],
    })
  }

  // ── 管理端：插件整包 ──────────────────────────────────────────────────────

  /** 云上版本 → 桌面版本（同插件同版本号；没有就复制一条）。桌面整包永远挂桌面版本。 */
  function ensureDesktopVersion(versionId: number): { versionId: number; created: boolean } {
    const row = getVersionPlatformRow(db, versionId)
    if (!row) throw new HubError('NOT_FOUND', '插件版本不存在')
    ensureDesktopLibrary(row.plugin_id)
    if (row.platform === 'desktop') return { versionId: row.id, created: false }
    const existing = findVersionOfPlatform(db, row.plugin_id, row.version, 'desktop')
    if (existing) return { versionId: existing.id, created: false }
    const created = db.tx(() => copyVersionToPlatform(db, row, 'desktop'))
    return { versionId: created, created: true }
  }

  /** 有桌面整包 = 该插件进桌面库；插件还没有桌面设置行时按云上的策略建一行（hidden 保持 hidden） */
  function ensureDesktopLibrary(pluginId: number): void {
    if (getPluginPlatformSettings(db, pluginId, 'desktop')) return
    const plugin = db.get<{
      policy: string
      bundle_order: number
      config_yaml: string
      needs_restart: number
    }>('SELECT policy, bundle_order, config_yaml, needs_restart FROM plugins WHERE id = ?', pluginId)
    if (!plugin) return
    insertPluginPlatformSettings(db, {
      pluginId,
      platform: 'desktop',
      policy: plugin.policy,
      bundleOrder: plugin.bundle_order,
      configYaml: plugin.config_yaml,
      needsRestart: plugin.needs_restart,
      at: now(),
    })
    auditDeliver({
      actorId: null,
      meta: { ip: null, userAgent: null },
      action: 'desktop.plugin-platform.add',
      targetType: 'plugin',
      targetId: pluginId,
      detail: { platform: 'desktop', reason: 'artifact-upload' },
    })
  }

  async function uploadPluginArtifact(input: DesktopArtifactUploadInput): Promise<DesktopPluginArtifact> {
    const source = getVersionPlatformRow(db, input.versionId)
    if (!source || source.plugin_id !== input.pluginId) throw new HubError('NOT_FOUND', '插件版本不存在')
    if (input.bytes <= 0) throw new HubError('VALIDATION_FAILED', '上传的插件包是空的')
    // docs/22 §2.2：桌面整包上传 = 创建桌面版本（给的是云上版本时落到同名桌面版本）
    const desktopVersion = ensureDesktopVersion(input.versionId)
    const pair = db.get<{ version: string; package_name: string }>(
      `SELECT v.version, p.package_name FROM plugin_versions v JOIN plugins p ON p.id = v.plugin_id WHERE v.id = ?`,
      desktopVersion.versionId,
    )
    if (!pair) throw new HubError('INTERNAL', '桌面版本创建后读不到')
    const row = {
      id: desktopVersion.versionId,
      plugin_id: input.pluginId,
      version: pair.version,
      package_name: pair.package_name,
    }

    // 裁决 #16 的服务端检查 + LICENSE/NOTICE 检查（只读 tar 头，不解包）
    const scanned = await scanTarGzNames(input.tempFile)
    if (!hasPackageJson(scanned.names)) {
      throw new HubError('VALIDATION_FAILED', '插件包里没有 package.json')
    }
    const forbidden = findForbiddenClaudeBinary(scanned.names)
    if (forbidden !== null) {
      throw new HubError(
        'VALIDATION_FAILED',
        'Hub 不能托管 Claude Agent SDK / claude-code 的二进制（裁决 #16）：请在客户端按平台从 npm 镜像安装',
        { fields: { file: `命中禁运路径：${forbidden}` } },
      )
    }
    if (carriesCodexBinary(scanned.names) && !hasFileNamed(scanned.names, ['LICENSE', 'NOTICE'])) {
      throw new HubError(
        'VALIDATION_FAILED',
        '带 codex 二进制的整包必须同时包含 LICENSE 与 NOTICE（Apache-2.0 再分发要求）',
        { fields: { file: '缺 LICENSE 或 NOTICE' } },
      )
    }

    const fileName = `${safeFileSegment(
      row.package_name.includes('/')
        ? (row.package_name.split('/')[1] ?? row.package_name)
        : row.package_name,
      '包名',
    )}-${safeFileSegment(row.version, '版本号')}.tgz`
    const target = join(paths.desktopPluginStoreDir, fileName)
    mkdirSync(paths.desktopPluginStoreDir, { recursive: true, mode: 0o700 })
    const previous = getArtifact(db, row.id)
    if (previous && previous.file_name !== fileName) {
      removeFileQuietly(join(paths.desktopPluginStoreDir, previous.file_name))
    }
    moveFile(input.tempFile, target)
    const at = now()
    upsertArtifact(db, {
      versionId: row.id,
      pluginId: row.plugin_id,
      fileName,
      bytes: input.bytes,
      sha256: input.sha256,
      actorId: input.actorId,
      at,
    })
    pruneArtifacts(row.plugin_id)
    auditDeliver({
      actorId: input.actorId,
      meta: input.meta,
      action: 'desktop.plugin-package.upload',
      targetType: 'plugin',
      targetId: row.plugin_id,
      detail: {
        versionId: row.id,
        version: row.version,
        bytes: input.bytes,
        sha256: input.sha256,
        createdDesktopVersion: desktopVersion.created,
      },
    })
    return artifactView({
      version_id: row.id,
      plugin_id: row.plugin_id,
      package_name: row.package_name,
      version: row.version,
      file_name: fileName,
      bytes: input.bytes,
      sha256: input.sha256,
      uploaded_at: at,
    })
  }

  /** 每个插件只保留最近 2 个整包（裁决 #16）：删行 + 删文件 */
  function pruneArtifacts(pluginId: number): void {
    const rows = listArtifactsByPlugin(db, pluginId)
    for (const row of rows.slice(DESKTOP_ARTIFACT_KEEP_VERSIONS)) {
      deleteArtifact(db, row.version_id)
      removeFileQuietly(join(paths.desktopPluginStoreDir, row.file_name))
      logger.debug({ pluginId, versionId: row.version_id }, '桌面整包超出保留版本数，已删除')
    }
  }

  function listArtifacts(): DesktopPluginArtifact[] {
    const rows = db.all<ArtifactRow>(
      `SELECT a.version_id, a.plugin_id, p.package_name, v.version, a.file_name, a.bytes, a.sha256, a.uploaded_at
         FROM desktop_plugin_artifacts a
         JOIN plugins p ON p.id = a.plugin_id
         JOIN plugin_versions v ON v.id = a.version_id
        ORDER BY p.package_name, a.uploaded_at DESC`,
    )
    return rows.map(artifactView)
  }

  // ── 管理端：安装包与 feed ────────────────────────────────────────────────

  function releaseView(row: ReleaseRow): DesktopRelease {
    return {
      id: row.id,
      target: row.target as DesktopRelease['target'],
      channel: row.channel as DesktopRelease['channel'],
      version: row.version,
      installerFile: row.installer_file,
      installerBytes: row.installer_bytes,
      installerSha512: row.installer_sha512,
      blockmapFile: row.blockmap_file,
      portableFile: row.portable_file,
      portableBytes: row.portable_bytes,
      feedFile: row.feed_file,
      status: row.status === 'yanked' ? 'yanked' : 'published',
      publishedAt: row.uploaded_at,
    }
  }

  /** feed YAML 全文（逐字照 D3 §7.2；electron-updater 的 generic provider 只认这些字段） */
  function renderFeedYaml(input: {
    version: string
    url: string
    size: number
    sha512: string
    releaseDate: string
  }): string {
    return [
      `version: ${input.version}`,
      'files:',
      `  - url: ${input.url}`,
      `    size: ${String(input.size)}`,
      `    sha512: ${input.sha512}`,
      `path: ${input.url}`,
      `sha512: ${input.sha512}`,
      `releaseDate: '${input.releaseDate}'`,
      '',
    ].join('\n')
  }

  function createRelease(input: DesktopReleaseUploadInput): DesktopRelease {
    const target = input.target
    const channel = input.channel
    const version = input.version
    if (channel === 'latest' && version.includes('-')) {
      throw new HubError('VALIDATION_FAILED', 'latest 通道不能发布预发布版本（上游会拒绝）', {
        fields: { version: 'latest 通道只收正式版' },
      })
    }
    if (findReleaseByVersion(db, target, channel, version)) {
      throw new HubError('CONFLICT', `${target}/${channel} 已经有 ${version} 的发布记录`)
    }
    if (input.installer.bytes <= 0 || input.installer.bytes > DESKTOP_INSTALLER_MAX_BYTES) {
      throw new HubError('PAYLOAD_TOO_LARGE', '安装包大小超出上限')
    }
    const installerFile = safeFileSegment(input.installer.fileName, '安装包')
    const blockmapFile = input.blockmap ? safeFileSegment(input.blockmap.fileName, 'blockmap') : null
    const binDir = join(paths.desktopReleaseDir, 'bin', target)
    mkdirSync(binDir, { recursive: true, mode: 0o700 })
    // 同一目标串行发布（D3 §7.2）：先落 blockmap 再落安装包，最后才写 feed 行
    if (input.blockmap && blockmapFile) {
      moveFile(input.blockmap.tempFile, join(binDir, blockmapFile))
    }
    moveFile(input.installer.tempFile, join(binDir, installerFile))
    const at = now()
    const feedFile = feedFileOf(target, channel)
    // 配了独立资产基址且是已镜像的 win-x64 时，feed 里的下载地址也指向公网入口（自动更新走快链路）
    const url =
      config.publicAssetsOrigin !== null && target === 'win-x64'
        ? `${config.publicAssetsOrigin}/win-x64/${installerFile}`
        : `${origin()}/desktop/bin/${target}/${installerFile}`
    const yaml = renderFeedYaml({
      version,
      url,
      size: input.installer.bytes,
      sha512: input.installer.sha512,
      releaseDate: at,
    })
    const id = insertRelease(db, {
      target,
      channel,
      version,
      installerFile,
      installerBytes: input.installer.bytes,
      installerSha512: input.installer.sha512,
      blockmapFile,
      blockmapBytes: input.blockmap?.bytes ?? null,
      blockmapSha512: input.blockmap?.sha512 ?? null,
      feedFile,
      yaml,
      actorId: input.actorId,
      at,
    })
    auditDeliver({
      actorId: input.actorId,
      meta: input.meta,
      action: 'desktop.release.publish',
      targetType: 'desktop.release',
      targetId: id,
      detail: {
        target,
        channel,
        version,
        bytes: input.installer.bytes,
        sha512: input.installer.sha512,
        blockmap: blockmapFile,
      },
    })
    const row = getRelease(db, id)
    if (!row) throw new HubError('INTERNAL', '发布记录写入后读不到')
    return releaseView(row)
  }

  /**
   * 给已有发布记录挂免安装 ZIP（WP38）。不进 feed、不改版本；同一条记录再挂一次即替换，
   * 换了文件名时删掉旧文件。文件名不能和同 target 其他记录（或本条的安装器/blockmap）撞名，
   * 否则会覆盖别人的下载。
   */
  function attachPortable(input: DesktopReleasePortableInput): DesktopRelease {
    const row = getRelease(db, input.releaseId)
    if (!row) throw new HubError('NOT_FOUND', '发布记录不存在')
    if (input.portable.bytes <= 0 || input.portable.bytes > DESKTOP_INSTALLER_MAX_BYTES) {
      throw new HubError('PAYLOAD_TOO_LARGE', '免安装包大小超出上限')
    }
    const portableFile = safeFileSegment(input.portable.fileName, '免安装包')
    if (!portableFile.toLowerCase().endsWith('.zip')) {
      throw new HubError('VALIDATION_FAILED', '免安装包应为 .zip', { fields: { portable: '只收 .zip' } })
    }
    const owner = findReleaseByInstallerFile(db, row.target, portableFile)
    if (
      (owner && owner.id !== row.id) ||
      portableFile === row.installer_file ||
      portableFile === row.blockmap_file
    ) {
      throw new HubError('CONFLICT', `${row.target} 下已有同名文件 ${portableFile}`)
    }
    const binDir = join(paths.desktopReleaseDir, 'bin', row.target)
    mkdirSync(binDir, { recursive: true, mode: 0o700 })
    moveFile(input.portable.tempFile, join(binDir, portableFile))
    setReleasePortable(db, row.id, {
      file: portableFile,
      bytes: input.portable.bytes,
      sha512: input.portable.sha512,
    })
    if (row.portable_file && row.portable_file !== portableFile) {
      rmSync(join(binDir, safeFileSegment(row.portable_file, '免安装包')), { force: true })
    }
    auditDeliver({
      actorId: input.actorId,
      meta: input.meta,
      action: 'desktop.release.portable',
      targetType: 'desktop.release',
      targetId: row.id,
      detail: {
        target: row.target,
        channel: row.channel,
        version: row.version,
        file: portableFile,
        bytes: input.portable.bytes,
        sha512: input.portable.sha512,
        replaced: row.portable_file,
      },
    })
    const updated = getRelease(db, row.id)
    if (!updated) throw new HubError('INTERNAL', '发布记录更新后读不到')
    return releaseView(updated)
  }

  function listReleaseRows(): DesktopReleaseListResponse {
    return { items: listReleases(db).map(releaseView) }
  }

  function rollbackRelease(
    input: DesktopReleaseRollbackRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopReleaseRollbackResponse {
    const latest = latestPublishedRelease(db, input.target, input.channel)
    if (!latest) throw new HubError('NOT_FOUND', `${input.target}/${input.channel} 还没有发布过安装包`)
    const previous = previousPublishedRelease(db, input.target, input.channel, latest.id)
    if (!previous) throw new HubError('NOT_FOUND', '没有上一版可回滚（只有一次发布）')
    const newer = listNewerReleases(db, input.target, input.channel, previous.id)
    for (const row of newer) setReleaseStatus(db, row.id, 'yanked')
    setReleaseStatus(db, previous.id, 'published')
    auditDeliver({
      actorId,
      meta,
      action: 'desktop.release.rollback',
      targetType: 'desktop.release',
      targetId: previous.id,
      detail: {
        target: input.target,
        channel: input.channel,
        to: previous.version,
        yanked: newer.map((row) => row.version),
      },
    })
    const row = getRelease(db, previous.id)
    if (!row) throw new HubError('INTERNAL', '回滚后读不到发布记录')
    return { release: releaseView(row), yanked: newer.map((entry) => entry.version) }
  }

  /** 公开：feed 清单（no-store）。文件名必须与 target/channel 推导一致，避免拿 `../../` 之类的东西 */
  function feedYaml(target: string, file: string): string {
    const channel = channelOfFeedFile(file)
    if (channel === null) throw new HubError('NOT_FOUND')
    if (feedFileOf(target, channel) !== file) throw new HubError('NOT_FOUND')
    const release = latestPublishedRelease(db, target, channel)
    if (!release) throw new HubError('NOT_FOUND', `${target}/${channel} 还没有已发布的安装包`)
    return release.yaml
  }

  function channelOfFeedFile(file: string): 'nightly' | 'latest' | null {
    if (file === 'nightly.yml' || file === 'nightly-mac.yml') return 'nightly'
    if (file === 'latest.yml' || file === 'latest-mac.yml') return 'latest'
    return null
  }

  /** 公开：安装包 / blockmap */
  function releaseFile(target: string, file: string): DesktopArtifactDownload {
    const safe = safeFileSegment(file, '安装包')
    const row = findReleaseByInstallerFile(db, target, safe)
    if (!row) throw new HubError('NOT_FOUND')
    const sha =
      row.installer_file === safe
        ? row.installer_sha512
        : row.portable_file === safe
          ? row.portable_sha512
          : row.blockmap_sha512
    const bytes =
      row.installer_file === safe
        ? row.installer_bytes
        : row.portable_file === safe
          ? row.portable_bytes
          : row.blockmap_bytes
    const filePath = join(paths.desktopReleaseDir, 'bin', target, safe)
    if (!existsSync(filePath)) throw new HubError('NOT_FOUND', '安装包文件已丢失')
    return {
      filePath,
      fileName: safe,
      bytes: bytes ?? statSync(filePath).size,
      sha256: null,
      sha512: sha ?? null,
    }
  }

  /**
   * 公开：公开主页左卡的 Windows 安装包（WP36）。
   * 只认 `published`；优先 `latest` 通道（正式版），没有才退到 `nightly`（可能带预发布后缀）。
   * 页面只需要「最新一条」，所以不返回列表，也不暴露 sha / 内部 id。
   */
  function publicDownload(ip: string | null, origin: RequestOrigin): PublicDesktopDownloadResponse {
    const gate = downloadLimit.consume(ip ?? 'unknown')
    if (!gate.allowed) {
      throw new HubError('RATE_LIMITED', '请求太频繁', { retryAfterSec: gate.retryAfterSec })
    }
    const release =
      latestPublishedRelease(db, 'win-x64', 'latest') ?? latestPublishedRelease(db, 'win-x64', 'nightly')
    if (!release) return { windows: null, android: null }
    return {
      windows: {
        version: release.version,
        channel: release.channel === 'latest' ? 'latest' : 'nightly',
        prerelease: release.version.includes('-'),
        fileName: release.installer_file,
        bytes: release.installer_bytes,
        // 与 feed / 管理端展示的地址同一口径：匿名、长缓存、相对站根。
        // WP52：按请求入口取资产基址（公网入口 `:8124/downloads` / 边缘入口 `/downloads`）；
        // 没配资产基址时保持原来的相对站根（由本入口的 Hub 自己提供）。
        url:
          origin.download.assetsOrigin !== null
            ? `${origin.download.assetsOrigin}/win-x64/${release.installer_file}`
            : `/desktop/bin/win-x64/${release.installer_file}`,
        publishedAt: release.uploaded_at,
        // WP38：同一条发布记录挂的免安装 ZIP；没挂就是 null，主页不显示切换
        portable:
          release.portable_file && release.portable_bytes
            ? {
                fileName: release.portable_file,
                bytes: release.portable_bytes,
                url:
                  origin.download.assetsOrigin !== null
                    ? `${origin.download.assetsOrigin}/win-x64/${release.portable_file}`
                    : `/desktop/bin/win-x64/${release.portable_file}`,
              }
            : null,
      },
      android: null,
    }
  }

  // ── 管理端：强更地板 ──────────────────────────────────────────────────────

  function floorView(): DesktopUpdateFloorResponse {
    const row = getFloor(db)
    return {
      floor: {
        minVersion: row.min_version,
        title: row.title,
        detail: row.detail,
        appLink: row.app_link,
        updatedAt: row.updated_at.length > 0 ? row.updated_at : null,
      },
    }
  }

  function setFloor(
    input: UpdateDesktopFloorRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): DesktopUpdateFloorResponse {
    const current = getFloor(db)
    updateFloor(db, {
      minVersion: input.minVersion === undefined ? current.min_version : input.minVersion,
      title: input.title ?? current.title,
      detail: input.detail ?? current.detail,
      appLink: input.appLink === undefined ? current.app_link : input.appLink,
      actorId,
      at: now(),
    })
    auditDeliver({
      actorId,
      meta,
      action: 'desktop.update-floor.set',
      targetType: 'desktop.update-floor',
      targetId: 1,
      detail: { minVersion: input.minVersion ?? null, changed: Object.keys(input) },
    })
    return floorView()
  }

  /** 匿名强更地板（D3 §1.4）：只看全局 minVersion；挡不住时也必须给出**形状正确**的「不强制」 */
  function checkClientUpdate(
    headers: Record<string, string | string[] | undefined>,
    ip: string | null,
  ): CheckClientUpdateResponse {
    const gate = floorLimit.consume(ip ?? 'unknown')
    if (!gate.allowed) {
      throw new HubError('RATE_LIMITED', '请求太频繁', { retryAfterSec: gate.retryAfterSec })
    }
    const floor = getFloor(db)
    if (!floor.min_version) return checkClientUpdateNotMandatory()
    const rawVersion = headerValue(headers, 'x-client-version')
    // 版本号缺失/非法时不放行（上游策略「失败时宁可挡着」的同一条原则）
    const blocked =
      rawVersion === null || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(rawVersion)
        ? true
        : compareSemver(rawVersion, floor.min_version) < 0
    if (!blocked) return checkClientUpdateNotMandatory()
    return {
      code: DESKTOP_MANDATORY_UPDATE_CODE,
      data: {
        show_content: {
          ...(floor.title.length > 0 ? { title: floor.title } : {}),
          ...(floor.detail.length > 0 ? { detail: floor.detail } : {}),
        },
        ...(floor.app_link !== null ? { desktop_app_link: floor.app_link } : {}),
      },
    }
  }

  // ── 复用现有「下发到 DSH」的系统路由与默认模型 ────────────────────────────

  async function modelPresetFragments(
    userId: number | undefined,
    presetId?: number,
  ): Promise<DesktopModelFragmentPreview> {
    const models = services().models as
      | {
          desktopModelFragments?: (
            id: number | null,
            opts?: { presetId?: number },
          ) => Promise<{ fragments: { id: string; config: Record<string, unknown> }[]; warnings: string[] }>
        }
      | undefined
    if (!models?.desktopModelFragments) {
      throw new HubError('INTERNAL', 'models service 没有提供桌面模型片段渲染')
    }
    // WP25e：不带 userId = 系统预设（默认预设 + 全部可下发模型），响应里 userId=null
    // WP28a：`presetId` 指定预设（统一下发的 models 内容项用），渲染口径与系统预设一致
    const result = await models.desktopModelFragments(
      userId ?? null,
      presetId === undefined ? {} : { presetId },
    )
    return {
      userId: userId ?? null,
      fragments: result.fragments.map((fragment) => ({ ...fragment, config: publicize(fragment.config) })),
      warnings: result.warnings,
    }
  }

  // ── 平台与桌面基线（docs/22 §2 §3；WP32a）──────────────────────────────

  /**
   * 桌面模型基线（迁移 124 的服务侧幂等补齐）。
   *
   * 迁移里渲染不出 `llm-pi-ai` / `agent-default-model`（要读中转站路由与提供方），所以放在服务侧：
   * - 桌面默认预设不存在时先从云上默认预设复制一份（`ensureDesktopDefaultPreset`）；
   * - `scope=all` 上已经有这两条片段 → 什么都不做（重复调用安全，不改 revision）；
   * - 否则用桌面默认预设渲染写入，并追加一条 `kind='config'` 的发布（新 revision）。
   *
   * 之后桌面模型配置的修改和云上一样：保存配置 → 统一下发 models（平台桌面）→ 新 revision。
   */
  async function ensureModelBaseline(): Promise<{ written: boolean; revision: number | null }> {
    const scope = scopeOf({ scope: 'all' })
    const existing = listConfigFragmentsFor(db, scope)
    const has = (entryId: string): boolean => existing.some((row) => row.entry_id === entryId)
    if (has('llm-pi-ai') && has('agent-default-model')) return { written: false, revision: null }

    const models = services().models
    if (!models?.desktopModelFragments) return { written: false, revision: null }
    // 桌面默认预设不存在时先建（新装的 Hub 先跑迁移、后配模型）
    const preset = models.ensureDesktopDefaultPreset()
    if (!preset) return { written: false, revision: null }
    const rendered = await models.desktopModelFragments(null, {})
    if (rendered.fragments.length === 0) return { written: false, revision: null }

    const merged = existing.map((row) => ({
      entryId: row.entry_id,
      mode: row.mode,
      configJson: row.config_json,
      note: row.note,
    }))
    for (const fragment of rendered.fragments) {
      const configJson = JSON.stringify(publicize(fragment.config))
      const index = merged.findIndex((row) => row.entryId === fragment.id)
      if (index >= 0) merged[index] = { ...merged[index]!, configJson }
      else merged.push({ entryId: fragment.id, mode: 'enforce', configJson, note: '' })
    }
    const at = now()
    const revision = db.tx(() => {
      replaceConfigFragments(db, { scope, fragments: merged, actorId: null, at })
      return appendDelivery(db, {
        scope,
        kind: 'config',
        actorId: null,
        detail: { reason: 'desktop-model-baseline', entryIds: rendered.fragments.map((item) => item.id) },
        at,
      })
    })
    logger.info({ revision, presetId: preset.presetId }, '已写入桌面模型基线')
    return { written: true, revision }
  }

  return {
    manifestForDevice,
    artifactDownload,
    signedArtifactDownload,
    desiredRevisionFor(deviceId, userId) {
      return desiredRevisionForDevice(deviceId, userId)
    },
    state,
    deliverPlugin,
    withdrawPlugin,
    deliverConfig,
    deliverApp,
    deliverUninstall,
    uploadPluginArtifact,
    listArtifacts,
    createRelease,
    attachPortable,
    listReleases: listReleaseRows,
    rollbackRelease,
    getFloor: floorView,
    setFloor,
    modelPresetFragments,
    ensureDesktopVersion,
    ensureModelBaseline,
    audience() {
      return desktopAudience(db)
    },
    lastModelDelivery() {
      const row = lastModelConfigDelivery(db)
      if (!row) return null
      return { revision: row.revision, at: row.created_at, by: row.actor_name }
    },
    feedYaml,
    releaseFile,
    publicDownload,
    checkClientUpdate,
  }
}

/** 读请求头（大小写不敏感；数组取第一个） */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  }
  return null
}
