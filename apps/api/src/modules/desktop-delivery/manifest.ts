import {
  DESKTOP_CONFIG_ALLOWLIST_VERSION,
  DESKTOP_MANIFEST_SCHEMA_VERSION,
  desktopLevelOfPolicy,
  type DesktopArtifact,
  type DesktopChannelPolicy,
  type DesktopManifest,
  type DesktopManifestConfigFragment,
  type DesktopManifestPlugin,
  type DesktopPatchEntry,
  type DesktopPolicyOverride,
  type DesktopReleaseChannel,
  type DesktopReleaseTarget,
} from '@dsh-hub/shared'
import { sha256Hex } from '../../lib/crypto.js'
import { RESERVED_ENTRY_IDS } from '../models/render.js'
import { parsePatchEntries } from '../models/patch-entries.js'
import {
  ARTIFACT_SIGN_DEVICE_PARAM,
  ARTIFACT_SIGN_SIGNATURE_PARAM,
  type ArtifactSignatureInput,
} from './artifact-sign.js'
import type {
  ChannelPolicyRow,
  ConfigFragmentRow,
  PluginTargetRow,
  PolicyOverrideRow,
  UninstallRow,
} from './repo.js'

/**
 * 期望状态清单的**纯函数**渲染（不碰数据库、不碰时钟 —— 输入全是普通对象）。
 *
 * 为什么单独一层：清单是两条通道里唯一「客户端会照着执行」的东西，必须
 *   * 可解释（同一组输入永远同一份输出，出了问题能拿库里的行重放）；
 *   * 可测试（把「按设备挑行」「灰度分桶」「level 映射」这些容易错的地方从 SQL 里拆出来）。
 *
 * 语义按 D3 §5 + 裁决 #17：
 * - level = 插件库 policy 的映射（required→core、default→default、optional→optional，hidden **不下发**）；
 * - `optional` 的项在清单里 `enabled: false`（客户端只放进「可安装列表」，不自动装）；
 * - `core` 恒 `enabled: true`；
 * - 插件自带的 `config_yaml` 是 patch 条目数组，**保留 id**（llm-pi-ai 等）的条目丢弃并告警；
 * - 灰度只作用于 `app.targetVersion`（安全地板 minVersion 不灰度）。
 */

/** 设备维度里与下发相关的那几列（来自 desktop_devices） */
export interface ManifestDeviceContext {
  deviceId: string
  userId: number
  /** 用户角色（'user' | 'admin'）：目标为「角色」时用它匹配 */
  role: string
  appChannel: string | null
  platform: string | null
  arch: string | null
}

export interface ManifestInputs {
  /** 生成时刻（服务端时钟） */
  now: string
  revision: number
  /** Hub 的公开 origin（拼 artifact url / feedUrl 用，末尾不带斜杠） */
  origin: string
  device: ManifestDeviceContext
  plugins: PluginTargetRow[]
  fragments: ConfigFragmentRow[]
  uninstalls: UninstallRow[]
  channelPolicy: ChannelPolicyRow | undefined
  overrides: PolicyOverrideRow[]
  /** 该 target+channel 是否有已发布的 feed（没有就不给 feedUrl，免得壳打到一个 404 上） */
  feedAvailable: boolean
  /**
   * 每设备取件签名（WP31）：给了就把 `artifact.url` 渲染成 `…tgz?d=<deviceId>&sig=<签名>`。
   * 不传则只渲染裸 URL（纯函数测试、以及没有主密钥的历史样例走这条）。
   */
  signArtifact?: (input: ArtifactSignatureInput) => string
  /** 中转站内部监听器的 origin（片段里指向它的 `baseURL` 改成 `origin`）；没在监听时为 null */
  relayInternalOrigin?: string | null
}

export interface ManifestResult {
  manifest: DesktopManifest
  /** 渲染时主动跳过的东西（缺整包、坏 YAML、保留 id 冲突…），管理端会展示 */
  warnings: string[]
}

/** 带作用域的行（插件/配置/卸载三张表共用这三列） */
export interface DeviceScopedRow {
  scope: string
  role: string
  user_id: number | null
}

/** 目标的「具体程度」：user 覆盖 role，role 覆盖 all */
function scopeRank(row: DeviceScopedRow): number {
  if (row.scope === 'user') return 3
  if (row.scope === 'role') return 2
  return 1
}

function matchesDevice(row: DeviceScopedRow, device: ManifestDeviceContext): boolean {
  if (row.scope === 'all') return true
  if (row.scope === 'role') return row.role === device.role
  return row.user_id === device.userId
}

/** 平台 + 架构 → electron-builder 的 target 名（D3 §7.2） */
export function releaseTargetOf(platform: string | null, arch: string | null): DesktopReleaseTarget | null {
  if (platform === 'win32' && (arch === 'x64' || arch === null)) return 'win-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'darwin' && (arch === 'x64' || arch === null)) return 'mac-x64'
  return null
}

/** feed 文件名（上游约定：mac 带 `-mac` 后缀，D3 §7.2） */
export function feedFileOf(
  target: DesktopReleaseTarget | string,
  channel: DesktopReleaseChannel | string,
): string {
  const suffix = String(target).startsWith('mac') ? '-mac' : ''
  return `${String(channel)}${suffix}.yml`
}

/**
 * 插件 tgz 的取件 URL（HTTPS + 设备令牌；scoped 包名直接展开成两级路径）。
 *
 * WP31：给了 `signed` 就在后面追加 `?d=<deviceId>&sig=<签名>`。签名只依赖
 * deviceId/包名/版本/sha256，所以同一台设备的同一份内容是**稳定** URL（清单 ETag 不会抖）。
 */
export function artifactUrlOf(
  origin: string,
  packageName: string,
  version: string,
  signed?: { deviceId: string; signature: string },
): string {
  const base = `${origin}/api/desktop/plugins/${packageName}/${version}.tgz`
  if (!signed) return base
  const query = new URLSearchParams({
    [ARTIFACT_SIGN_DEVICE_PARAM]: signed.deviceId,
    [ARTIFACT_SIGN_SIGNATURE_PARAM]: signed.signature,
  })
  return `${base}?${query.toString()}`
}

/** 包名 → 缓存文件名（与插件库 safeStoreFileName 同口径：去掉 scope） */
export function artifactFileNameOf(packageName: string, version: string): string {
  const base = packageName.includes('/') ? (packageName.split('/')[1] ?? packageName) : packageName
  return `${base}-${version}.tgz`
}

/** 稳定分桶：`sha256(deviceId)` 的前 8 位十六进制取模 100 → 0–99（纯函数、可重放） */
export function rolloutBucketOf(deviceId: string): number {
  return Number.parseInt(sha256Hex(`desktop-rollout:${deviceId}`).slice(0, 8), 16) % 100
}

/** 一组片段的规范化摘要（客户端落盘后自校验；**不回传**上报接口，裁决 #3） */
export function configDigestOf(fragments: DesktopManifestConfigFragment[]): string {
  const canonical = fragments.map((fragment) => ({
    id: fragment.id,
    mode: fragment.mode,
    config: fragment.config,
  }))
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`
}

/**
 * 桌面片段里的中转站地址改走公开 origin。
 *
 * 模型 / 搜索片段与容器共用一套渲染，`baseURL` 是中转站的**内部**监听器（如 `http://10.213.0.1:7710/v1`），
 * 只有容器网络能连；桌面设备在公网上，要用 `<公开 origin>/v1`（同一个中转站，经公网入口）。
 * 只改 origin 等于内部监听器的 `baseURL`（保留路径：`/v1` 或 anthropic 的无 `/v1`），别的地址原样不动。
 */
export function publicizeRelayBaseUrls(
  config: Record<string, unknown>,
  internalOrigin: string | null,
  publicOrigin: string,
): Record<string, unknown> {
  if (internalOrigin === null) return config
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value !== 'object' || value === null) return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        key === 'baseURL' && typeof item === 'string' && originOf(item) === internalOrigin
          ? `${publicOrigin.replace(/\/+$/u, '')}${item.slice(internalOrigin.length)}`
          : rewrite(item)
    }
    return out
  }
  return rewrite(config) as Record<string, unknown>
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** 插件自带的 config_yaml → patch 条目（保留 id 丢弃 + 告警；坏 YAML 只跳过自己） */
export function pluginConfigEntriesOf(
  row: PluginTargetRow,
  warnings: string[],
): DesktopPatchEntry[] | undefined {
  const text = row.config_yaml ?? ''
  if (text.trim().length === 0) return undefined
  let entries: DesktopPatchEntry[]
  try {
    entries = parsePatchEntries(text) as DesktopPatchEntry[]
  } catch (error) {
    warnings.push(
      `插件 ${row.package_name} 的 config_yaml 无法解析，已跳过它的配置片段：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
  const kept = entries.filter((entry) => {
    if (entry.id !== undefined && RESERVED_ENTRY_IDS.has(entry.id)) {
      warnings.push(`插件 ${row.package_name} 的配置片段写了保留条目 ${entry.id}，已丢弃`)
      return false
    }
    return true
  })
  return kept.length > 0 ? kept : undefined
}

function toManifestPlugin(
  row: PluginTargetRow,
  device: ManifestDeviceContext,
  origin: string,
  warnings: string[],
  signArtifact?: (input: ArtifactSignatureInput) => string,
): DesktopManifestPlugin | null {
  const level = desktopLevelOfPolicy(row.policy as 'required' | 'default' | 'optional' | 'hidden')
  if (level === null) {
    // hidden 不下发（裁决 #17）；理论上进不来（下发时已拒绝），防御性跳过
    warnings.push(`插件 ${row.package_name} 的 policy=hidden，不下发`)
    return null
  }
  if (!row.file_name || row.sha256 === null || row.bytes === null) {
    warnings.push(`插件 ${row.package_name}@${row.version} 还没有上传桌面整包，本次不下发`)
    return null
  }
  // WP31：签名地址（不带令牌也能取件）；签名只依赖这四个稳定输入，所以清单 ETag 不抖
  const signature = signArtifact?.({
    deviceId: device.deviceId,
    packageName: row.package_name,
    version: row.version,
    sha256: row.sha256,
  })
  const artifact: DesktopArtifact = {
    url: artifactUrlOf(
      origin,
      row.package_name,
      row.version,
      signature === undefined ? undefined : { deviceId: device.deviceId, signature },
    ),
    sha256: row.sha256,
    bytes: row.bytes,
    filename: artifactFileNameOf(row.package_name, row.version),
  }
  const enabled = level === 'core' ? true : level === 'optional' ? false : row.enabled === 1
  const config = pluginConfigEntriesOf(row, warnings)
  return {
    name: row.package_name,
    version: row.version,
    level,
    enabled,
    artifact,
    ...(row.bundle_order > 0 ? { bundleOrder: row.bundle_order } : {}),
    needsRestart: row.needs_restart === 1,
    ...(row.min_dsh ? { minDsh: row.min_dsh } : {}),
    ...(config ? { config } : {}),
  }
}

/** 按「用户 > 角色 > 全部」挑选插件；生效的显式卸载从安装列表中排除。 */
export function effectivePlugins(
  rows: PluginTargetRow[],
  device: ManifestDeviceContext,
  uninstalls: UninstallRow[] = [],
): PluginTargetRow[] {
  const removed = new Set(effectiveUninstalls(uninstalls, device))
  const best = new Map<number, PluginTargetRow>()
  for (const row of rows) {
    if (!matchesDevice(row, device) || removed.has(row.package_name)) continue
    const current = best.get(row.plugin_id)
    if (!current || scopeRank(row) > scopeRank(current)) best.set(row.plugin_id, row)
  }
  return [...best.values()].sort((a, b) => a.package_name.localeCompare(b.package_name))
}

/** 按「用户 > 角色 > 全部」挑出对这台设备生效的配置片段（按条目 id 排序，保证摘要稳定） */
export function effectiveFragments(
  rows: ConfigFragmentRow[],
  device: ManifestDeviceContext,
): ConfigFragmentRow[] {
  const best = new Map<string, ConfigFragmentRow>()
  for (const row of rows) {
    if (!matchesDevice(row, device)) continue
    const current = best.get(row.entry_id)
    if (!current || scopeRank(row) > scopeRank(current)) best.set(row.entry_id, row)
  }
  return [...best.values()].sort((a, b) => a.entry_id.localeCompare(b.entry_id))
}

/** 生效的卸载清单（全量并集：三个作用域的包名都算） */
export function effectiveUninstalls(rows: UninstallRow[], device: ManifestDeviceContext): string[] {
  return [...new Set(rows.filter((row) => matchesDevice(row, device)).map((row) => row.package_name))].sort()
}

export interface ResolvedAppPolicy {
  channel: DesktopReleaseChannel
  targetVersion: string | null
  minVersion: string | null
  minVersionHard: boolean
  rolloutPercent: number
  /** 灰度是否命中（false 时 targetVersion 会被清掉） */
  inRollout: boolean
}

/** 渠道策略 + 角色/用户覆盖 + 灰度分桶 → 这台设备实际看到的 app 策略 */
export function resolveAppPolicy(
  device: ManifestDeviceContext,
  channelPolicy: ChannelPolicyRow | undefined,
  overrides: PolicyOverrideRow[],
): ResolvedAppPolicy {
  const channel: DesktopReleaseChannel = device.appChannel === 'nightly' ? 'nightly' : 'latest'
  const roleOverride = overrides.find(
    (row) => row.channel === channel && row.scope === 'role' && row.role === device.role,
  )
  const userOverride = overrides.find(
    (row) => row.channel === channel && row.scope === 'user' && row.user_id === device.userId,
  )
  const pick = <T>(
    field: 'target_version' | 'min_version' | 'min_version_hard' | 'rollout_percent',
    fallback: T,
  ): T => {
    const userValue = userOverride?.[field]
    if (userValue !== undefined && userValue !== null) return userValue as T
    const roleValue = roleOverride?.[field]
    if (roleValue !== undefined && roleValue !== null) return roleValue as T
    const channelValue = channelPolicy?.[field]
    if (channelValue !== undefined && channelValue !== null) return channelValue as T
    return fallback
  }
  const rolloutPercent = pick('rollout_percent', 100)
  const targetVersion = pick<string | null>('target_version', null)
  const minVersion = pick<string | null>('min_version', null)
  const minVersionHard = pick<number>('min_version_hard', 0) === 1
  const inRollout = rolloutPercent >= 100 || rolloutBucketOf(device.deviceId) < rolloutPercent
  return {
    channel,
    targetVersion: inRollout ? targetVersion : null,
    minVersion,
    minVersionHard,
    rolloutPercent,
    inRollout,
  }
}

/** 生成清单（纯函数）。调用方负责 revision / feedAvailable 这类跨表信息。 */
export function buildManifest(inputs: ManifestInputs): ManifestResult {
  const warnings: string[] = []
  const { device } = inputs

  const plugins = effectivePlugins(inputs.plugins, device, inputs.uninstalls)
    .map((row) => toManifestPlugin(row, device, inputs.origin, warnings, inputs.signArtifact))
    .filter((plugin): plugin is DesktopManifestPlugin => plugin !== null)

  const fragments: DesktopManifestConfigFragment[] = []
  for (const row of effectiveFragments(inputs.fragments, device)) {
    let config: Record<string, unknown>
    try {
      const parsed = JSON.parse(row.config_json) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        warnings.push(`配置片段 ${row.entry_id} 的内容不是对象，已跳过`)
        continue
      }
      config = publicizeRelayBaseUrls(
        parsed as Record<string, unknown>,
        inputs.relayInternalOrigin ?? null,
        inputs.origin,
      )
    } catch {
      warnings.push(`配置片段 ${row.entry_id} 不是合法 JSON，已跳过`)
      continue
    }
    fragments.push({
      id: row.entry_id,
      mode: row.mode === 'default' ? 'default' : 'enforce',
      config,
      ...(row.note ? { note: row.note } : {}),
    })
  }

  const uninstall = effectiveUninstalls(inputs.uninstalls, device)
  const app = resolveAppPolicy(device, inputs.channelPolicy, inputs.overrides)
  const target = releaseTargetOf(device.platform, device.arch)
  const feedUrl = inputs.feedAvailable && target !== null ? `${inputs.origin}/desktop/feeds/${target}/` : null

  const manifest: DesktopManifest = {
    schemaVersion: DESKTOP_MANIFEST_SCHEMA_VERSION,
    revision: inputs.revision,
    issuedAt: inputs.now,
    device: { deviceId: device.deviceId, userId: device.userId },
    plugins,
    ...(uninstall.length > 0 ? { uninstall } : {}),
    ...(fragments.length > 0
      ? {
          config: {
            fragments,
            digest: configDigestOf(fragments),
            allowlistVersion: DESKTOP_CONFIG_ALLOWLIST_VERSION,
          },
        }
      : {}),
    ...(app.minVersion !== null || app.targetVersion !== null || feedUrl !== null
      ? {
          app: {
            channel: app.channel,
            // schema 要求 minVersion 必填；没配地板时用 0.0.0（对任何已装版本都不构成阻塞）
            minVersion: app.minVersion ?? '0.0.0',
            minVersionHard: app.minVersionHard,
            ...(app.targetVersion !== null ? { targetVersion: app.targetVersion } : {}),
            ...(feedUrl !== null ? { feedUrl } : {}),
          },
        }
      : {}),
  }
  return { manifest, warnings }
}

/** 清单的 ETag：内容指纹（**不含 issuedAt**，否则每次拉取都「变了」导致永远 304 不了） */
export function manifestEtagOf(manifest: DesktopManifest): string {
  const { issuedAt: _issuedAt, ...rest } = manifest
  void _issuedAt
  return `"${String(manifest.revision)}-${sha256Hex(JSON.stringify(rest)).slice(0, 32)}"`
}

/** 管理端视图里用的渠道策略 / 覆盖（共享契约形状） */
export function channelPolicyViewOf(row: ChannelPolicyRow): DesktopChannelPolicy {
  return {
    channel: row.channel === 'nightly' ? 'nightly' : 'latest',
    targetVersion: row.target_version,
    minVersion: row.min_version,
    minVersionHard: row.min_version_hard === 1,
    rolloutPercent: row.rollout_percent,
  }
}

export function policyOverrideViewOf(row: PolicyOverrideRow): DesktopPolicyOverride {
  return {
    channel: row.channel === 'nightly' ? 'nightly' : 'latest',
    targetVersion: row.target_version,
    minVersion: row.min_version,
    minVersionHard: row.min_version_hard === null ? null : row.min_version_hard === 1,
    rolloutPercent: row.rollout_percent,
    scope: row.scope === 'user' ? 'user' : 'role',
    role: row.role === 'user' || row.role === 'admin' ? row.role : null,
    userId: row.user_id,
  }
}
