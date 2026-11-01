import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { statfs } from 'node:fs/promises'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import {
  DEFAULT_QUOTA_VALUE,
  INSTANCE_ACTIVITY_FLUSH_MS,
  INSTANCE_READY_TIMEOUT_MS,
  QuotaSchema,
  type AdminInstanceStatsRow,
  type ComputeLeaseEndReason,
  type InstancePhase,
  type InstanceProbe,
  type InstanceProbeState,
  type InstanceStats,
  type InstanceSummary,
  type Quota,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { userLocks, withUserLock } from '../../lib/locks.js'
import { ensureUserDirs } from '../../lib/paths.js'
import { createDiskUsageCache, type DiskUsageCache } from './disk.js'
import { DEFAULT_AUTHORITY, createDshCookieMinter, type DshCookieMinter } from './dsh-cookie.js'
import {
  SESSION_PROBE_CONCURRENCY,
  SESSION_PROBE_TIMEOUT_MS,
  probeSessions,
} from './probe.js'
import { redactLogText, waitForReady } from './readiness.js'
import { isSystemUserId } from '../../lib/system-account.js'
import {
  createInstanceRepo,
  laterOf,
  parseQuotaJson,
  type InstanceListRow,
  type InstanceRow,
  type InstanceUserRow,
} from './repo.js'
import {
  FALLBACK_DSH_VERSION,
  FALLBACK_MANAGED_PATCH,
  LABEL_CONFIG_HASH,
  containerNameFor,
  buildContainerSpec,
  computeConfigHash,
  withConfigHash,
} from './spec.js'
import {
  resolveUpstreamTarget,
  type AdminInstanceEntry,
  type ComputeHooks,
  type ComputeSpec,
  type ContainerSpec,
  type EnsureRunningOptions,
  type HostSnapshot,
  type InstanceCounts,
  type InstanceService,
  type InstanceSpecOverlay,
  type RemoveUserDataResult,
  type StartReason,
} from './types.js'

/** 实例操作锁等待上限（启动最长 90s，锁要比它宽裕） */
export const INSTANCE_LOCK_TIMEOUT_MS = 150_000
/** 对账间隔（05 §6：启动时 + 每 60 秒） */
export const RECONCILE_INTERVAL_MS = 60_000
/** 空闲检查间隔（05 §6：每分钟） */
export const IDLE_CHECK_INTERVAL_MS = 60_000
/** CPU 采样窗口（最近 5 分钟；每分钟一个样本） */
export const CPU_SAMPLE_SIZE = 5
/** CPU 采样窗口时长（毫秒）：`CPU_SAMPLE_SIZE` 个「每分钟一个」的样本 ≈ 最近 5 分钟 */
export const CPU_WINDOW_MS = CPU_SAMPLE_SIZE * 60_000
/** 空闲判据的 CPU 阈值（05 §6：< 3%） */
export const IDLE_CPU_THRESHOLD_PERCENT = 3
/** `docker stop -t`（05 §6） */
export const STOP_TIMEOUT_SEC = 15
/** 期望哈希缓存时长（getSummary/listForAdmin 会频繁算） */
export const SPEC_HASH_CACHE_MS = 5_000
/**
 * stats 采样器（docs/22 §5.3；WP33）：运行中实例每 15 s 一轮，只在最近 2 分钟有管理员请求过
 * 列表时运转；采集并发 ≤ 4。列表与 `GET /api/admin/instances/stats` 都只读这份缓存。
 */
export const ADMIN_STATS_SAMPLE_INTERVAL_MS = 15_000
/** 「最近有管理员看列表」的窗口（docs/22 §5.3：2 分钟） */
export const ADMIN_LIST_INTEREST_MS = 120_000
/** stats 采集并发上限（docs/22 §5.3：≤ 4） */
export const ADMIN_STATS_CONCURRENCY = 4
/** 列表里期望 config_hash 的并发上限（docs/22 §5.2「至少并发计算」） */
export const EXPECTED_HASH_CONCURRENCY = 8
/** 错误信息里保留的日志长度（03 §1.2 的 error 列） */
export const ERROR_TEXT_LIMIT = 2_000
/**
 * 启动准入里「磁盘配额」这一步最多愿意等多久（毫秒）。
 *
 * 配额要统计整个用户目录（几万个文件），**不能让它成为冷启动的关键路径**：命中 10 分钟
 * 缓存直接返回；冷缓存最多等这么久，超时先放行、统计继续在后台完成（下一次启动检查
 * 按真实值拒绝）。250 ms 足够让「目录很小 / 刚统计过」的情况给出硬结论。
 */
export const DISK_QUOTA_CHECK_BUDGET_MS = 250
/** 管理端日志跟随的起始行数 */
export const FOLLOW_TAIL = 200

/**
 * 跨模块协作者（WP3 的 plugins/models）。
 * `createServices` 创建实例服务时只拿得到 `BaseDeps`（WP0a 的组装顺序），所以这些钩子由
 * 模块注册阶段（`instancesPlugin` 收到的是完整 `AppDeps`）补上；缺失时降级为「桩行为」：
 * bootstrap 跳过、managed.patch.yml 写占位注释、模型 env 为空、模型摘要为空。
 */
export interface InstanceCollaborators {
  /** `deps.services.plugins.bootstrapUser(userId)`（06 §2.5） */
  bootstrapUser?(userId: number, opts?: { restart: 'now' | 'next-start' }): Promise<void>
  /** `deps.services.models.renderManaged(userId)`：自己写 `managed/` 下两个文件 */
  renderManaged?(userId: number): Promise<unknown>
  /** `deps.services.models.containerEnv(userId)`：模型密钥 env（05 §4） */
  containerEnv?(userId: number): Promise<Record<string, string>>
  /** `deps.services.models.summaryForUser(userId)`（04 §3.1 §10.4 的 modelSummary） */
  summaryForUser?(userId: number): Promise<{
    policy: 'managed' | 'free'
    preset: string
    defaultModel: string
    providers: string[]
  }>
}

/** 内部方法（不进 `InstanceService` 公共接口）：模块注册阶段补协作者 */
export const ATTACH_COLLABORATORS = Symbol('instances.attachCollaborators')

/**
 * 内部方法：算力租赁在启动时注册钩子（13 §4）。
 * 用晚绑定避免 instances ↔ compute 的循环 import；没注册 = 现状（免费、按 Quota）。
 */
export const ATTACH_COMPUTE_HOOKS = Symbol('instances.attachComputeHooks')

export interface InternalInstanceService extends InstanceService {
  [ATTACH_COLLABORATORS](collaborators: InstanceCollaborators): void
  [ATTACH_COMPUTE_HOOKS](hooks: ComputeHooks | null): void
  /** 代理层读 DSH cookie 用（同一份 mtime 缓存） */
  cookieMinter(userId: number, slug: string): DshCookieMinter
  /** `GET /api/me/instance` 的 modelSummary（WP3 的 `models.summaryForUser`；不可用时空串） */
  modelSummary(userId: number): Promise<{
    policy: 'managed' | 'free'
    preset: string
    defaultModel: string
    providers: string[]
  }>
  /** 会话探针跑一轮（WP33；只探 running 实例，并发 ≤ 8，不更新活跃度）；返回每行的判定 */
  probeRunningInstances(): Promise<{ userId: number; state: InstanceProbeState }[]>
  /** 立刻采样一轮 stats 缓存（WP33 的采样器与测试/冒烟用） */
  refreshStatsCache(): Promise<number>
  /** 读 stats 缓存快照（`GET /api/admin/instances/stats`） */
  adminStatsSnapshot(): AdminInstanceStatsRow[]
  /** 缓存里缺运行中实例的样本时，后台补一轮（不阻塞调用方） */
  kickStatsSample(): void
}

/** 探针一轮里一个实例的判定（WP33；docs/22 §6.1） */
interface ProbeRoundEntry {
  userId: number
  state: InstanceProbeState
  /** 进行中的会话数（walked items[].running）；未知为 null */
  runningSessions: number | null
  /** max(items[].updatedAt)，epoch 毫秒；没有会话消息时为 null */
  lastPromptAtMs: number | null
  openClients: number
  lastClientAtMs: number | null
  /** 判定依据（日志/诊断用） */
  message: string
}

/** 模型摘要的兜底（WP3 未接线时）：不编造内容，前端显示为空 */
const MODEL_SUMMARY_FALLBACK = {
  policy: 'managed' as const,
  preset: '',
  defaultModel: '',
  providers: [] as string[],
}

export interface InstanceServiceOptions {
  collaborators?: InstanceCollaborators
  readyPollMs?: number
  /** 就绪等待上限；默认 90s（05 §6），可用 `HUB_INSTANCE_READY_TIMEOUT_MS` 覆盖（测试用） */
  readyTimeoutMs?: number
  /** 单次 HTTP 就绪探测超时 */
  probeTimeoutMs?: number
}

/** 就绪等待上限：环境变量优先（集成/单元测试把 90s 调小），否则 05 §6 的 90s */
function defaultReadyTimeoutMs(): number {
  const raw = process.env.HUB_INSTANCE_READY_TIMEOUT_MS
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : INSTANCE_READY_TIMEOUT_MS
}

/**
 * 缓存用的时间源：**刻意用真实时间**而不是 `deps.clock`。
 * 这些只是性能缓存（期望哈希 5s、管理端 stats 10s），用可控时钟会让「时间不前进」
 * 的测试永远读到旧值；业务判据（空闲回收）仍然走 `deps.clock`。
 */
const realNow = (): number => Date.now()

export function createInstanceService(
  deps: BaseDeps,
  opts: InstanceServiceOptions = {},
): InternalInstanceService {
  const repo = createInstanceRepo(deps.db, () => deps.clock.nowIso())
  const disk: DiskUsageCache = createDiskUsageCache({ clock: deps.clock })
  const collaborators: InstanceCollaborators = { ...opts.collaborators }
  /** 算力租赁钩子（13 §4）；没注册时所有启动行为与 WP2 完全一致 */
  let computeHooks: ComputeHooks | null = null
  /**
   * 系统账号容器的规格覆盖（WP56b）：座舱 DSH 的 2C2G / 无出网代理 / `/ops` env。
   * 只对注册者自己的 userId 生效，且只允许改 cpus/memoryMb/env（见 `InstanceSpecOverlay`）。
   */
  const specOverlays: InstanceSpecOverlay[] = []
  const minters = new Map<number, DshCookieMinter>()
  const specHashes = new Map<number, { hash: string | null; at: number }>()
  const inFlight = new Map<number, Promise<InstanceSummary>>()
  const pendingActivity = new Map<number, string>()
  /**
   * CPU 样本按「哪一轮运行」分组：`startedAt` 变了（重启/重建/对账恢复）整组作废，
   * 免得拿上一轮运行的旧样本判定这一轮是否空闲（WP15 ②）。
   */
  const cpuSamples = new Map<
    number,
    { startedAt: string | null; samples: { at: number; cpuPercent: number }[] }
  >()
  /**
   * stats 缓存（WP33，docs/22 §5.3）：后台采样器每 15 s 采一轮运行中实例，列表与
   * `GET /api/admin/instances/stats` 只读它。`atIso` 走业务时钟（展示值），
   * `sampledAtMs` 走真实时间（「最近有没有人看列表」的调度判断）。
   */
  const adminStats = new Map<number, { atIso: string; sampledAtMs: number; stats: InstanceStats }>()
  /** 最近一次管理员请求列表的时刻（真实时间；决定 stats 采样器是否运转） */
  let lastAdminListAt = 0
  /** 连续 busy 的起点（内存足够：Hub 重启后保守地重新计时，不会提前停） */
  const busySince = new Map<number, number>()
  /** 是否有一轮 stats 采样在跑（采样可能比 15 s 间隔长，避免叠起来） */
  let statsSampling = false
  let timers: NodeJS.Timeout[] = []

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function lock<T>(userId: number, fn: () => Promise<T> | T): Promise<T> {
    return withUserLock(userId, fn, { timeoutMs: INSTANCE_LOCK_TIMEOUT_MS })
  }

  function cookieMinter(userId: number, slug: string): DshCookieMinter {
    let minter = minters.get(userId)
    if (!minter) {
      // 刻意不传 deps.clock：cookie 的 issuedAt/expiresAt 必须是真实时间。
      // 用可控时钟（测试里冻结在过去）签出来的 cookie 会被实例直接判为过期 → 401。
      minter = createDshCookieMinter({ dshHome: deps.paths.userDshHome(slug) })
      minters.set(userId, minter)
    }
    return minter
  }

  /** 容器名 = `HUB_CONTAINER_PREFIX` + slug（开发/测试/生产共用同一个 Docker，11 §2） */
  function nameFor(slug: string): string {
    return containerNameFor(slug, deps.config.containerPrefix)
  }

  function imageVersion(image: string | null): string | null {
    if (!image) return null
    const index = image.lastIndexOf(':')
    return index >= 0 ? image.slice(index + 1) : image
  }

  function summaryOf(row: InstanceRow, user: InstanceUserRow, needsRecreate = false): InstanceSummary {
    return {
      status: row.status,
      runtimeVersion: imageVersion(row.image),
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
      needsRecreate,
      error: row.error,
      openUrl: `/dsh/${user.username}/`,
    }
  }

  function absentSummary(user: InstanceUserRow | undefined): InstanceSummary {
    return {
      status: 'absent',
      runtimeVersion: null,
      startedAt: null,
      lastActiveAt: null,
      needsRecreate: false,
      error: null,
      openUrl: user ? `/dsh/${user.username}/` : '/',
    }
  }

  async function emitPhase(
    userId: number,
    phase: InstancePhase | undefined,
    message?: string,
    onPhase?: (phase: InstancePhase, message?: string) => void,
  ): Promise<void> {
    const row = repo.find(userId)
    const user = repo.findUser(userId)
    if (!row || !user) return
    if (phase) onPhase?.(phase, message)
    deps.events.emit('instance.status', {
      userId,
      event: {
        instance: summaryOf(row, user),
        ...(phase ? { phase } : {}),
        ...(message ? { message } : {}),
      },
    })
  }

  function truncated(text: string): string {
    return text.length > ERROR_TEXT_LIMIT ? text.slice(0, ERROR_TEXT_LIMIT) : text
  }

  /**
   * 期望的 config_hash。`fresh` 用于「必须准确」的场景（状态页的 needsRecreate、restart 决策）：
   * 直接重算并刷新缓存；管理端列表（N 个用户）用缓存，避免每次列表都重算 N 份规格。
   */
  async function expectedHash(userId: number, opts: { fresh?: boolean } = {}): Promise<string | null> {
    const nowMs = realNow()
    const hit = specHashes.get(userId)
    if (!opts.fresh && hit && nowMs - hit.at < SPEC_HASH_CACHE_MS) return hit.hash
    try {
      const spec = await buildSpec(userId)
      const hash = computeConfigHash(spec)
      specHashes.set(userId, { hash, at: nowMs })
      return hash
    } catch (error) {
      deps.logger.debug({ err: error, userId }, '计算期望 config_hash 失败')
      specHashes.set(userId, { hash: null, at: nowMs })
      return null
    }
  }

  /** 限并发 map（失败项返回 null，调用方自己兜底） */
  async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await fn(items[index]!, index)
      }
    })
    await Promise.all(workers)
    return results
  }

  function parseMs(value: string | null | undefined): number {
    if (!value) return Number.NaN
    return Date.parse(value)
  }

  function isoOfMs(ms: number): string {
    return new Date(ms).toISOString()
  }

  /** 若干时间戳里最晚的那个（NaN 忽略；全无效返回 NaN） */
  function latestMs(...values: number[]): number {
    let latest = Number.NaN
    for (const value of values) {
      if (!Number.isFinite(value)) continue
      if (!Number.isFinite(latest) || value > latest) latest = value
    }
    return latest
  }

  /**
   * 代理层的「在场」信息（docs/22 §6.1）：打开的 WS 数 + 最后一次断开时刻（真实毫秒）。
   * 代理模块可能未装配（只测实例模块的裁剪装配）→ 当作没人看。
   */
  function clientPresenceOf(userId: number): { openClients: number; lastClientAtMs: number | null } {
    const proxy = (deps as Partial<AppDeps>).services?.proxy
    if (!proxy || typeof proxy.openClients !== 'function') return { openClients: 0, lastClientAtMs: null }
    try {
      return { openClients: proxy.openClients(userId), lastClientAtMs: proxy.lastClientAt(userId) }
    } catch (error) {
      deps.logger.debug({ err: error, userId }, '读取代理在场信息失败，按无人处理')
      return { openClients: 0, lastClientAtMs: null }
    }
  }

  async function modelEnv(userId: number): Promise<Record<string, string>> {
    if (!collaborators.containerEnv) return {}
    try {
      return await collaborators.containerEnv(userId)
    } catch (error) {
      // WP3 未实现时是桩异常；不让模型服务的问题挡住实例启动，但要在日志里留痕
      deps.logger.warn({ err: error, userId }, '模型密钥 env 获取失败，本次启动不带模型密钥')
      return {}
    }
  }

  /**
   * 计费规格覆盖（13 §4）：有进行中租约 → 租约快照；计费开启 → 用户已选规格；否则 null。
   * 钩子异常时回退 Quota（实例操作不该被计费模块的脏数据挡住），但记 warn。
   */
  function currentComputeSpec(userId: number): ComputeSpec | null {
    if (!computeHooks) return null
    try {
      return computeHooks.currentSpec(userId)
    } catch (error) {
      deps.logger.warn({ err: error, userId }, '读取算力规格失败，本次回退 Quota')
      return null
    }
  }

  function resolveRuntime(user: InstanceUserRow): { version: string; runtimeId: number | null } {
    const hasTable = deps.db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtimes'",
    )
    if (hasTable) {
      const row = user.runtime_id
        ? deps.db.get<{ id: number; dsh_version: string }>(
            "SELECT id, dsh_version FROM runtimes WHERE id = ? AND status = 'ready'",
            user.runtime_id,
          )
        : deps.db.get<{ id: number; dsh_version: string }>(
            "SELECT id, dsh_version FROM runtimes WHERE is_default = 1 AND status = 'ready' ORDER BY id LIMIT 1",
          )
      if (row) return { version: row.dsh_version, runtimeId: row.id }
    }
    return { version: FALLBACK_DSH_VERSION, runtimeId: null }
  }

  /** 渲染 `managed/`（WP3 的 models.renderManaged；不可用时写占位注释文件） */
  async function renderManagedFiles(user: InstanceUserRow): Promise<void> {
    const dir = deps.paths.userManaged(user.slug)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (collaborators.renderManaged) {
      try {
        await collaborators.renderManaged(user.id)
        return
      } catch (error) {
        if (!isNotImplemented(error)) throw error
        deps.logger.debug({ userId: user.id }, 'models.renderManaged 尚未实现，写占位 managed.patch.yml')
      }
    }
    writeFileSync(`${dir}/managed.patch.yml`, FALLBACK_MANAGED_PATCH, { mode: 0o600 })
    writeFileSync(
      `${dir}/manifest.json`,
      `${JSON.stringify(
        {
          userId: user.id,
          slug: user.slug,
          presetId: null,
          presetRevision: null,
          runtimeVersion: null,
          plugins: [],
          generatedAt: deps.clock.nowIso(),
          source: 'fallback',
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  }

  async function provisionUnlocked(userId: number): Promise<InstanceSummary> {
    const user = repo.requireUser(userId)
    ensureUserDirs(deps.paths, user.slug)
    repo.insertStopped(userId, nameFor(user.slug), DEFAULT_AUTHORITY)
    await renderManagedFiles(user)
    specHashes.delete(userId)
    const row = repo.find(userId)
    return row ? summaryOf(row, user) : absentSummary(user)
  }

  function buildSpecSyncParts(userId: number): {
    user: InstanceUserRow
    quota: Quota
    runtime: { version: string; runtimeId: number | null }
  } {
    const user = repo.requireUser(userId)
    return { user, quota: resolveQuota(userId), runtime: resolveRuntime(user) }
  }

  async function buildSpec(userId: number): Promise<ContainerSpec> {
    const { user, quota, runtime } = buildSpecSyncParts(userId)
    const base = buildContainerSpec({
      user,
      quota,
      dshVersion: runtime.version,
      runtimeId: runtime.runtimeId,
      paths: deps.paths,
      npmRegistry: deps.config.npmRegistry,
      modelEnv: await modelEnv(userId),
      // 容器内权限预设（WP40d）：系统设置 container.permissionPreset，缺省完全放行
      permissionPreset: deps.settings.get('container').permissionPreset,
      containerPrefix: deps.config.containerPrefix,
      envId: deps.config.envId,
    })
    // 计费规格覆盖 cpus/memoryMb（13 §4）：**不经过 QuotaSchema 校验**，定制规格可以超过 8 核 / 8 GB；
    // 其余字段（pids、磁盘、空闲回收、插件权限）仍来自 Quota。
    const override = currentComputeSpec(userId)
    // 带上子网：一次性维护容器（runOnce）在「用户从未启动过实例」时会用到它先建网（WP8b B1）
    const built: ContainerSpec = {
      ...base,
      ...(override ? { cpus: override.cpus, memoryMb: override.memoryMb } : {}),
      network: deps.config.usersNetwork,
      networkSubnet: deps.config.usersSubnet,
    }
    // 系统账号容器的覆盖（WP56b）：只改 cpus/memoryMb/env，挂载与网络保持 05 §4 的基线
    let spec = built
    for (const overlay of specOverlays) {
      const next = overlay(userId, spec)
      if (next !== null && next !== undefined) spec = next
    }
    return spec
  }

  function resolveQuota(userId: number): Quota {
    const defaults = deps.settings.get('default_quota') ?? DEFAULT_QUOTA_VALUE
    const user = repo.findUser(userId)
    const partial = parseQuotaJson(user?.quota_json ?? null)
    if (!partial) return defaults
    const merged = QuotaSchema.safeParse({ ...defaults, ...partial })
    if (!merged.success) {
      deps.logger.warn({ userId }, '用户配额不合法，回退全局默认值')
      return defaults
    }
    return merged.data
  }

  // ── 启动路径 ──────────────────────────────────────────────────────────────

  interface EnsureUpOptions {
    reason: StartReason
    /** `POST /api/me/instance/start` 的可选规格（13 §6） */
    planId?: string
    onPhase?: (phase: InstancePhase, message?: string) => void
    /** restart 时容器已在运行且规格没变 → 用 restart 而不是 start */
    restartIfRunning?: boolean
  }

  /** 算力租约结束通知（13 §4）：计费模块的失败不能反过来破坏实例操作，只记 warn */
  async function notifyStopped(userId: number, reason: ComputeLeaseEndReason): Promise<void> {
    if (!computeHooks) return
    // 系统账号（座舱 DSH）从不计费，也就没有租约要结束
    if (isSystemUserId(deps.db, userId)) return
    try {
      await computeHooks.onStopped(userId, reason)
    } catch (error) {
      deps.logger.warn({ err: error, userId, reason }, '结束算力租约失败')
    }
  }

  /** stop 的 reason → 租约结束原因（13 §4 的映射表；其它一律 system） */
  function leaseEndReasonForStop(reason: StartReason): ComputeLeaseEndReason {
    switch (reason) {
      case 'user':
      case 'admin':
      case 'idle':
      case 'insufficient':
        return reason
      default:
        return 'system'
    }
  }

  /** 启动失败：落库 error + 审计 + 事件，返回给调用方抛出（`throw await ...` 保持类型收窄） */
  async function startFailure(
    userId: number,
    message: string,
    logTail: string,
    reason: string,
  ): Promise<HubError> {
    repo.markError(userId, truncated(`${message}\n${logTail}`))
    deps.audit.log({
      actorId: userId,
      action: 'instance.error',
      targetType: 'instance',
      targetId: userId,
      detail: { reason },
    })
    await notifyStopped(userId, 'crash')
    await emitPhase(userId, undefined, message)
    return new HubError('INSTANCE_START_FAILED', message, { logTail })
  }

  async function ensureUpUnlocked(userId: number, o: EnsureUpOptions): Promise<InstanceSummary> {
    const user = repo.requireUser(userId)
    // 系统账号（座舱 DSH）不走算力租赁：没有钱包、没有租约，也不该扣任何人的积分
    const systemAccount = isSystemUserId(deps.db, userId)
    // 实例行已存在时 provisionUnlocked 不会再跑（例如上一轮一次性容器留下的行），但目录可能
    // 被搬走/清理过：起容器前必须由 Hub 补建（幂等），否则 Docker 会以 root 建 bind mount 目录
    ensureUserDirs(deps.paths, user.slug)
    if (!repo.find(userId)) await provisionUnlocked(userId)
    const row0 = repo.find(userId)
    if (!row0) throw new HubError('INTERNAL', '实例行创建失败')
    const name = row0.container_name || nameFor(user.slug)
    let info = await deps.driver.inspect(name)

    // 幂等：已经在跑且库里也是 running，直接返回（并发 3 次 start 只建一个容器）
    if (!o.restartIfRunning && info?.state === 'running' && row0.status === 'running') {
      return summaryOf(row0, user)
    }
    // 这次调用之前容器与库都认为在跑 → restart 路径，不重复开租约、也不做启动准入（13 §4）
    const wasRunning = info?.state === 'running' && row0.status === 'running'

    const capacity = deps.settings.get('capacity')
    if (info?.state !== 'running') {
      // 磁盘配额（05 §7）：超过 diskGb 就拒绝再启动；已运行的不强停。
      // 统计整目录要遍历几万个文件，**不能让它成为冷启动的关键路径**：命中缓存直接用，
      // 冷缓存最多等 DISK_QUOTA_CHECK_BUDGET_MS，超时先放行、后台补测（下一次启动按真实值拒绝）。
      // 磁盘配额是防滥用，不是安全边界；「偶尔放行一次」比「每次冷启动白等几秒」更划算。
      const quota = resolveQuota(userId)
      const limitBytes = Math.round(quota.diskGb * 1024 * 1024 * 1024)
      const usedBytes = await disk.getWithin(
        user.slug,
        deps.paths.userDir(user.slug),
        DISK_QUOTA_CHECK_BUDGET_MS,
      )
      if (usedBytes === null) {
        deps.logger.info({ userId }, '磁盘配额检查：还没有统计值（冷缓存），先放行并在后台补测')
      } else if (usedBytes >= limitBytes) {
        throw new HubError(
          'DISK_QUOTA_EXCEEDED',
          `磁盘用量 ${formatGiB(usedBytes)} 已超过配额 ${String(quota.diskGb)}GB，请先清理工作区`,
          { usedBytes, limitBytes },
        )
      }
      const running = repo.countByStatus(['running', 'starting'], userId)
      if (running >= capacity.maxRunning) {
        throw new HubError(
          'CAPACITY_FULL',
          `同时运行的实例已达上限（${String(running)}/${String(capacity.maxRunning)}）`,
          { running, max: capacity.maxRunning },
        )
      }
    }

    // 算力租赁启动准入（13 §4）：在磁盘与 maxRunning 检查之后、建容器之前。
    // 放在 buildSpec 之前，这样 beforeStart 记住的规格能直接影响这次的容器规格与 config_hash。
    if (info?.state !== 'running' && computeHooks && !systemAccount) {
      await computeHooks.beforeStart(userId, {
        reason: o.reason,
        ...(o.planId === undefined ? {} : { planId: o.planId }),
      })
    }

    const spec = await buildSpec(userId)
    const hash = computeConfigHash(spec)
    if (!(await deps.driver.imageExists(spec.image))) {
      throw new HubError('RUNTIME_NOT_READY', `运行时镜像尚未就绪：${spec.image}`, { image: spec.image })
    }

    await deps.driver.ensureNetwork(deps.config.usersNetwork, deps.config.usersSubnet)

    // 规格变了（配额/镜像/模型密钥/挂载）→ 删旧重建（05 §6）
    if (info) {
      const actual = info.labels[LABEL_CONFIG_HASH] ?? row0.config_hash
      if (actual !== hash) {
        deps.logger.info({ userId, container: name }, '规格已变化，重建容器')
        await deps.driver.remove(name)
        info = null
      }
    }

    repo.markStarting(userId, {
      reason: o.reason,
      configHash: hash,
      runtimeId: specRuntimeId(user),
      image: spec.image,
      authority: DEFAULT_AUTHORITY,
    })

    if (!info) {
      await emitPhase(userId, 'creating', undefined, o.onPhase)
      const created = await deps.driver.create(withConfigHash(spec))
      repo.setContainer(userId, created.id, null)
    } else {
      await emitPhase(userId, 'creating', undefined, o.onPhase)
    }

    // 首次启动：**在启动 DSH 之前**离线装好 required/default 插件（06 §2.5）。
    // WP3 用 `driver.runOnce`（同规格一次性容器）实现，所以这里不需要 DSH 在跑。
    // 成功或失败都继续启动并写 bootstrapped_at：失败的插件由 `user_plugins.state=failed` 记录，
    // 状态页提示「有插件没装上，可稍后重试」。
    if (!row0.bootstrapped_at) {
      await emitPhase(userId, 'bootstrapping', undefined, o.onPhase)
      const result = await bootstrap(userId)
      repo.setBootstrapped(userId)
      if (!result.ok) {
        deps.logger.warn({ userId, reason: result.reason }, 'bootstrap 未完成（不阻塞启动）')
        await emitPhase(userId, 'bootstrapping', `插件准备未完成：${result.reason}`, o.onPhase)
      }
    }

    if (o.restartIfRunning && info?.state === 'running') {
      await deps.driver.restart(name, STOP_TIMEOUT_SEC)
    } else {
      await deps.driver.start(name)
    }
    const running = await deps.driver.inspect(name)
    repo.setContainer(userId, running?.id ?? null, running?.ip ?? null)
    await emitPhase(userId, 'booting', undefined, o.onPhase)

    const upstream = running ? resolveUpstreamTarget(deps.driver, running) : null
    const ready = await waitForReady({
      driver: deps.driver,
      name,
      upstream,
      authority: DEFAULT_AUTHORITY,
      minter: cookieMinter(userId, user.slug),
      pollMs: opts.readyPollMs,
      timeoutMs: opts.readyTimeoutMs ?? defaultReadyTimeoutMs(),
      probeTimeoutMs: opts.probeTimeoutMs,
    })
    if (!ready.ok) {
      throw await startFailure(userId, ready.message, ready.logTail, ready.reason)
    }

    repo.markRunning(userId, { ip: ready.ip, startedAt: deps.clock.nowIso(), hash })
    // 新一轮运行：清空 CPU 样本，空闲判据要重新攒「最近 5 分钟」的证据（WP15 ②）
    cpuSamples.delete(userId)
    deps.audit.log({
      actorId: userId,
      action: o.restartIfRunning ? 'instance.restart' : 'instance.start',
      targetType: 'instance',
      targetId: userId,
      detail: { reason: o.reason, waitedMs: ready.waitedMs },
    })

    // 状态写成 running 之后开租（13 §4）。restart 一个本来就在跑的实例沿用原租约，
    // 不重复开租、也不把「计费从关到开」之前的免费运行追认为计费。
    if (computeHooks && !wasRunning && !systemAccount) {
      await computeHooks.onRunning(userId, { reason: o.reason })
    }

    await emitPhase(userId, 'ready', undefined, o.onPhase)
    const finalRow = repo.find(userId)
    return finalRow ? summaryOf(finalRow, user) : absentSummary(user)
  }

  function specRuntimeId(user: InstanceUserRow): number | null {
    return resolveRuntime(user).runtimeId
  }

  async function bootstrap(userId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!collaborators.bootstrapUser) {
      return { ok: false, reason: '插件服务尚未实现（WP3 的 plugins.bootstrapUser）' }
    }
    try {
      await collaborators.bootstrapUser(userId, { restart: 'next-start' })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── 对外方法 ──────────────────────────────────────────────────────────────

  const service: InternalInstanceService = {
    [ATTACH_COLLABORATORS](next) {
      Object.assign(collaborators, next)
    },

    [ATTACH_COMPUTE_HOOKS](hooks) {
      computeHooks = hooks
    },

    cookieMinter,

    async modelSummary(userId) {
      if (!collaborators.summaryForUser) return MODEL_SUMMARY_FALLBACK
      try {
        return await collaborators.summaryForUser(userId)
      } catch (error) {
        deps.logger.debug({ err: error, userId }, '模型摘要不可用（WP3 未实现？）')
        return MODEL_SUMMARY_FALLBACK
      }
    },

    async provision(userId) {
      return lock(userId, async () => {
        const summary = await provisionUnlocked(userId)
        deps.logger.info({ userId }, '实例已 provision（未建容器）')
        return summary
      })
    },

    async ensureRunning(userId, options: EnsureRunningOptions = {}) {
      const existing = inFlight.get(userId)
      if (existing) return existing
      const task: Promise<InstanceSummary> = lock(userId, () =>
        ensureUpUnlocked(userId, {
          reason: options.reason ?? 'user',
          ...(options.planId === undefined ? {} : { planId: options.planId }),
          onPhase: options.onPhase,
        }),
      ).finally(() => {
        if (inFlight.get(userId) === task) inFlight.delete(userId)
      })
      inFlight.set(userId, task)
      return task
    },

    async stop(userId, options = {}) {
      return lock(userId, () =>
        stopUnlocked(userId, options.reason ?? 'user', options.auditDetail ?? null),
      )
    },

    async restart(userId, options = {}) {
      return lock(userId, async () => {
        const user = repo.requireUser(userId)
        const row = repo.find(userId)
        if (!row) return provisionUnlocked(userId)
        const name = row.container_name || nameFor(user.slug)
        const info = await deps.driver.inspect(name)
        const hash = await expectedHash(userId, { fresh: true })
        const actual = info?.labels[LABEL_CONFIG_HASH] ?? row.config_hash
        if (!info || (hash && actual !== hash)) {
          deps.audit.log({
            actorId: userId,
            action: 'instance.recreate',
            targetType: 'instance',
            targetId: userId,
            detail: { reason: options.reason ?? 'user', trigger: 'config-changed' },
          })
          return recreateUnlocked(userId, options.reason ?? 'user', options.onPhase)
        }
        return ensureUpUnlocked(userId, {
          reason: options.reason ?? 'user',
          onPhase: options.onPhase,
          restartIfRunning: true,
        })
      })
    },

    async recreate(userId, options = {}) {
      return lock(userId, async () => {
        deps.audit.log({
          actorId: userId,
          action: 'instance.recreate',
          targetType: 'instance',
          targetId: userId,
          detail: { reason: options.reason ?? 'user', trigger: 'explicit' },
        })
        return recreateUnlocked(userId, options.reason ?? 'user', options.onPhase)
      })
    },

    async removeUserData(userId, opts): Promise<RemoveUserDataResult> {
      return lock(userId, async () => {
        // 删用户时是先软删除再清数据（admin-users.deleteUser），所以不能用严格语义的 requireUser；
        // 用户行还在（包括已软删除）就继续清容器/实例行/目录，物理不存在才抛「用户不存在」
        const user = repo.findUser(userId)
        if (!user) throw new HubError('NOT_FOUND', '用户不存在')
        const row = repo.find(userId)
        const name = row?.container_name ?? nameFor(user.slug)
        await deps.driver.stop(name, STOP_TIMEOUT_SEC).catch(() => undefined)
        await deps.driver.remove(name).catch(() => undefined)
        repo.remove(userId)
        specHashes.delete(userId)
        minters.delete(userId)
        cpuSamples.delete(userId)
        pendingActivity.delete(userId)
        adminStats.delete(userId)
        busySince.delete(userId)
        disk.invalidate(user.slug)
        let trashPath: string | null = null
        const dir = deps.paths.userDir(user.slug)
        if (existsSync(dir) && opts?.purge) {
          // 04 §8.9：purge=true 立即彻底删除，不进回收站
          rmSync(dir, { recursive: true, force: true })
        } else if (existsSync(dir)) {
          const stamp = deps.clock.nowIso().replace(/[:.]/gu, '-').replace(/Z$/u, '')
          trashPath = deps.paths.trashTarget(user.slug, stamp)
          mkdirSync(dirname(trashPath), { recursive: true, mode: 0o700 })
          renameSync(dir, trashPath)
        }
        deps.logger.info({ userId, slug: user.slug, trashPath }, '实例与用户数据已移除')
        return { slug: user.slug, trashPath }
      })
    },

    async getSummary(userId) {
      const user = repo.findUser(userId)
      const row = repo.find(userId)
      if (!row) return absentSummary(user ?? undefined)
      let needsRecreate = false
      if (row.status === 'running') {
        const info = await deps.driver.inspect(row.container_name).catch(() => null)
        const actual = info?.labels[LABEL_CONFIG_HASH] ?? row.config_hash
        const expected = await expectedHash(userId, { fresh: true })
        needsRecreate = Boolean(info && expected && actual && actual !== expected)
      }
      return summaryOf(row, user ?? placeholderUser(userId, row), needsRecreate)
    },

    /**
     * 宿主侧统计。**磁盘用量与容器状态无关**（它在宿主卷上，05 §7），所以实例行存在时总是返回：
     * 容器不在跑时 CPU/内存/进程都是 0、内存上限取配额——这样前端在「已停止」甚至
     * 「磁盘超限被拒绝启动」时也能拿到 `diskBytes/diskLimitBytes` 画 90%/100% 提示。
     * 只有用户/实例行不存在时才返回 null。
     *
     * **磁盘用量不在这里等**：`GET /api/me/instance` 是首屏接口，统计整个用户目录要遍历几万个
     * 文件（旧实现异步遍历实测 8–12 s，会把首屏拖死）。这里只读缓存并触发后台补测，
     * 没测过就先给 `null`（前端按 0 处理），10 秒后的资源条刷新自然补上真实值。
     */
    async getStats(userId) {
      const row = repo.find(userId)
      const user = repo.findUser(userId)
      if (!row || !user) return null
      const quota = resolveQuota(userId)
      const diskBytes = disk.peekOrRefresh(user.slug, deps.paths.userDir(user.slug))
      const diskLimitBytes = Math.round(quota.diskGb * 1024 * 1024 * 1024)
      const info = await deps.driver.inspect(row.container_name).catch(() => null)
      const raw =
        info?.state === 'running' ? await deps.driver.stats(row.container_name).catch(() => null) : null
      // 内存上限也要反映算力规格（13 §4）：有租约/已选规格时用规格，不用 Quota 的 8 GB 上限；
      // 没有算力规格时保持 WP2 的旧口径（优先容器真实 limit）
      const computeSpec = currentComputeSpec(userId)
      const memoryLimitBytes = computeSpec
        ? computeSpec.memoryMb * 1024 * 1024
        : // 容器真实 limit（cgroup 直读可能给 0 = 未设限），0 时退回配额
          raw && raw.memoryLimitBytes > 0
          ? raw.memoryLimitBytes
          : quota.memoryMb * 1024 * 1024
      return {
        cpuPercent: raw?.cpuPercent ?? 0,
        memoryBytes: raw?.memoryBytes ?? 0,
        memoryLimitBytes,
        pids: raw?.pids ?? 0,
        diskBytes,
        diskLimitBytes,
      }
    },

    async withUserLock<T>(userId: number, fn: () => Promise<T> | T) {
      return lock(userId, fn)
    },

    async reconcileAll() {
      const containers = await deps.driver.listManaged().catch((error: unknown) => {
        deps.logger.warn({ err: error }, '对账：listManaged 失败，本轮跳过')
        return []
      })
      const bySlug = new Map<string, (typeof containers)[number]>()
      for (const info of containers) {
        const slug = info.labels['dshhub.slug']
        if (slug) bySlug.set(slug, info)
      }
      for (const row of repo.list()) {
        const user = repo.findUser(row.user_id)
        if (!user || user.deleted_at) continue
        // 先「认领」容器再判断要不要跳过：正在被操作的用户（启动中）跳过本轮，
        // 但它不算「没有对应用户」的孤儿容器
        const info = bySlug.get(user.slug)
        bySlug.delete(user.slug)
        if (userLocks.isLocked(`user:${row.user_id}`)) continue
        if (!info) {
          if (row.status !== 'stopped' && row.status !== 'absent') {
            deps.logger.warn({ userId: row.user_id }, '对账：容器已不存在，状态置 stopped')
            repo.markStopped(row.user_id)
            cpuSamples.delete(row.user_id)
            await notifyStopped(row.user_id, 'system')
            await emitPhase(row.user_id, undefined, '容器已不存在')
          }
          continue
        }
        if (info.state === 'running') {
          if (row.status !== 'running' || row.ip !== info.ip) {
            // `listManaged()` 不返回 StartedAt（docs/22 §5.1）：只对这一行补一次 inspect，
            // 保住「外部启动/恢复时 started_at = 容器真实启动时刻」的原语义（WP15 ②）——稳态 0 次额外 inspect
            const full = info.startedAt ? null : await deps.driver.inspect(info.name).catch(() => null)
            repo.markRunning(row.user_id, {
              ip: info.ip,
              startedAt: info.startedAt ?? full?.startedAt ?? deps.clock.nowIso(),
              hash: info.labels[LABEL_CONFIG_HASH] ?? row.config_hash ?? '',
            })
            // 外部启动/恢复：started_at 换成容器真实启动时刻，样本跟着作废（WP15 ②）
            cpuSamples.delete(row.user_id)
            await emitPhase(row.user_id, undefined, '容器正在运行')
          }
          continue
        }
        if (row.status === 'running' || row.status === 'starting') {
          const tail = await deps.driver
            .logs(info.name, { tail: 50 })
            .then((text) => redactLogText(text))
            .catch(() => '')
          repo.markError(
            row.user_id,
            truncated(
              `容器意外退出（state=${info.state}，exit code=${String(info.exitCode ?? '?')}）\n${tail}`,
            ),
          )
          cpuSamples.delete(row.user_id)
          deps.audit.log({
            actorId: row.user_id,
            action: 'instance.error',
            targetType: 'instance',
            targetId: row.user_id,
            detail: { exitCode: info.exitCode, state: info.state },
          })
          await notifyStopped(row.user_id, 'crash')
          await emitPhase(row.user_id, undefined, '容器意外退出')
        } else if (row.status === 'stopping') {
          repo.markStopped(row.user_id)
          cpuSamples.delete(row.user_id)
          await notifyStopped(row.user_id, 'system')
        }
      }
      for (const [slug, info] of bySlug) {
        deps.logger.warn(
          { slug, container: info.name },
          '对账：容器没有对应用户（可能是已删除用户的数据），跳过（不删别人的容器）',
        )
      }
    },

    async reapIdle() {
      flushActivity()
      const nowMs = deps.clock.now().getTime()
      const rows = repo.listByStatus(['running'])
      if (rows.length === 0) return 0
      // ① 探针一轮（docs/22 §6.1）：只探 running、并发 ≤ 8、超时 3 s、**不 touchActivity**
      let probes = new Map<number, ProbeRoundEntry>()
      try {
        probes = new Map((await runProbeRound()).map((entry) => [entry.userId, entry]))
      } catch (error) {
        deps.logger.warn({ err: error }, '会话探针失败，本轮全部按未知状态处理')
      }
      const busyLimitMinutes = deps.settings.get('capacity').busyMaxMinutes
      let stopped = 0
      for (const row of rows) {
        const userId = row.user_id
        // WP57（docs/25 §5）：座舱 DSH 改成概览里「点了才启动」的 AI 助手，空闲回收与普通实例同一套规则
        // （探针看到会话在跑就不停；没人看着 idleNoClientMinutes 后停）。以前它「随叫随到」常驻，白占内存。
        const quota = resolveQuota(userId)
        // `idleStopMinutes = 0` = 不限（05 §6 的旧语义）：探针照常记录，但这一行不停
        if (quota.idleStopMinutes <= 0) continue
        const entry = probes.get(userId)
        const state: InstanceProbeState = entry?.state ?? 'unknown'
        const presence = entry
          ? { openClients: entry.openClients, lastClientAtMs: entry.lastClientAtMs }
          : clientPresenceOf(userId)
        // 连续 busy 计时（docs/22 §6.2「连续 busy 超过 busyMaxMinutes 才按 idle 规则处理」）
        if (state === 'busy') {
          if (!busySince.has(userId)) busySince.set(userId, nowMs)
        } else {
          busySince.delete(userId)
        }
        const busyMs = state === 'busy' ? nowMs - (busySince.get(userId) ?? nowMs) : 0
        const overBusy = state === 'busy' && busyLimitMinutes > 0 && busyMs >= busyLimitMinutes * 60_000
        if (state === 'busy' && !overBusy) continue
        if (overBusy) {
          deps.logger.warn(
            {
              userId,
              busyMinutes: Math.round(busyMs / 60_000),
              busyMaxMinutes: busyLimitMinutes,
              openClients: presence.openClients,
            },
            '连续进行中超过 busyMaxMinutes，按空闲规则处理',
          )
        }

        const startedMs = parseMs(row.started_at)
        const lastBusyMs = parseMs(row.last_busy_at)
        const lastPromptMs = parseMs(row.last_prompt_at)
        const lastClientMs = latestMs(parseMs(row.last_client_at), presence.lastClientAtMs ?? Number.NaN)

        if (state === 'unknown') {
          // ② 未知状态（探针失败 / 旧版 DSH）：沿用旧规则 lastActiveAt + 最近 5 分钟平均 CPU < 3%
          const activeMs = parseMs(row.last_active_at)
          const sinceMs = latestMs(startedMs, activeMs)
          if (!Number.isFinite(sinceMs)) continue
          const idleMs = nowMs - sinceMs
          if (!Number.isFinite(idleMs)) continue

          let group = cpuSamples.get(userId)
          if (!group || group.startedAt !== row.started_at) {
            group = { startedAt: row.started_at, samples: [] }
            cpuSamples.set(userId, group)
          }

          // 只在可能触发回收前的 CPU_WINDOW_MS 内采样：更早的样本用不上，白调 stats
          const idleStopMs = quota.idleStopMinutes * 60_000
          if (idleMs < Math.max(0, idleStopMs - CPU_WINDOW_MS)) {
            cpuSamples.delete(userId)
            continue
          }
          if (userLocks.isLocked(`user:${userId}`)) continue
          const stats = await deps.driver.stats(row.container_name).catch(() => null)
          if (!stats) continue
          group.samples = [...group.samples, { at: nowMs, cpuPercent: stats.cpuPercent }].slice(
            -CPU_SAMPLE_SIZE,
          )
          // 还没到空闲阈值：继续采样，等真正的超时
          if (idleMs < idleStopMs) continue
          // 样本数不足 CPU_SAMPLE_SIZE 时不停（继续采样）：Hub 刚启动、实例刚恢复或刚开始空闲时
          // 还没有「最近 5 分钟」的证据，不能凭 1 个样本就停掉正在后台跑长任务的 agent。
          if (group.samples.length < CPU_SAMPLE_SIZE) continue
          const avg =
            group.samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / group.samples.length
          if (avg >= IDLE_CPU_THRESHOLD_PERCENT) continue
          const first = group.samples[0]!
          const last = group.samples[group.samples.length - 1]!
          deps.logger.info(
            {
              userId,
              probeState: state,
              idleMinutes: Math.round(idleMs / 60_000),
              cpuPercent: avg,
              samples: group.samples.length,
              cpuWindowMinutes: Math.round((last.at - first.at) / 60_000),
            },
            '空闲回收：停止实例（未知状态，沿用 CPU 规则）',
          )
          await this.stop(userId, {
            reason: 'idle',
            auditDetail: {
              probeState: state,
              runningSessions: null,
              openClients: presence.openClients,
              rule: 'cpu',
              idleMinutes: Math.round(idleMs / 60_000),
              thresholdMinutes: quota.idleStopMinutes,
              cpuPercent: avg,
              samples: group.samples.length,
              startedAt: row.started_at,
              lastActiveAt: row.last_active_at,
              probeAt: entry ? deps.clock.nowIso() : null,
            },
          })
          stopped += 1
          continue
        }

        // ③ watching / unattended（以及超限后的 busy）：按 docs/22 §6.2 的时间点判空闲
        const watching = presence.openClients > 0
        // overBusy 时不再拿 lastBusyAt 当起点：它每分钟都被探针刷新，否则永远到不了阈值
        const busyStartMs = state === 'busy' ? Number.NaN : lastBusyMs
        const idleStartMs = watching
          ? latestMs(startedMs, busyStartMs, lastPromptMs)
          : latestMs(startedMs, busyStartMs, lastPromptMs, lastClientMs)
        if (!Number.isFinite(idleStartMs)) continue
        const thresholdMinutes = watching
          ? quota.idleStopMinutes
          : quota.idleNoClientMinutes > 0
            ? quota.idleNoClientMinutes
            : quota.idleStopMinutes
        const idleMs = nowMs - idleStartMs
        if (!Number.isFinite(idleMs) || idleMs < thresholdMinutes * 60_000) continue
        deps.logger.info(
          {
            userId,
            probeState: state,
            openClients: presence.openClients,
            idleMinutes: Math.round(idleMs / 60_000),
            thresholdMinutes,
          },
          '空闲回收：按会话状态停止实例',
        )
        await this.stop(userId, {
          reason: 'idle',
          auditDetail: {
            probeState: state,
            runningSessions: entry?.runningSessions ?? null,
            openClients: presence.openClients,
            rule: watching ? 'watching' : 'unattended',
            idleMinutes: Math.round(idleMs / 60_000),
            thresholdMinutes,
            busyMinutes: overBusy ? Math.round(busyMs / 60_000) : null,
            startedAt: row.started_at,
            lastBusyAt: row.last_busy_at,
            lastPromptAt: row.last_prompt_at,
            lastClientAt: row.last_client_at,
            lastActiveAt: row.last_active_at,
            probeAt: entry ? deps.clock.nowIso() : null,
          },
        })
        stopped += 1
      }
      return stopped
    },

    async buildSpec(userId) {
      return buildSpec(userId)
    },

    resolveQuota,

    currentStatus(userId) {
      return repo.find(userId)?.status ?? 'absent'
    },

    touchActivity(userId) {
      pendingActivity.set(userId, deps.clock.nowIso())
    },

    flushActivity() {
      flushActivity()
    },

    async probeRunningInstances() {
      const entries = await runProbeRound()
      return entries.map((entry) => ({ userId: entry.userId, state: entry.state }))
    },

    async refreshStatsCache() {
      statsSampling = true
      try {
        return await refreshStats()
      } finally {
        statsSampling = false
      }
    },

    adminStatsSnapshot() {
      return statsSnapshot()
    },

    /**
     * 列表/统计接口都只读缓存；缓存里没有运行中实例的样本时，**后台**补一轮
     * （不阻塞响应），前端下一次轮询就能拿到（docs/22 §5.3「骨架占位后填充」）。
     */
    kickStatsSample() {
      if (statsSampling) return
      const missing = repo.listByStatus(['running']).some((row) => !adminStats.has(row.user_id))
      if (!missing) return
      void sampleStatsTick()
    },

    async listForAdmin(options = {}) {
      const startedMs = realNow()
      lastAdminListAt = startedMs
      const rows = repo.listForAdmin(options.status)
      // ① 一次 `docker ps` 拿全部容器的状态与标签，替代逐行 inspect（docs/22 §5.1）
      const containers = await deps.driver.listManaged().catch((error: unknown) => {
        deps.logger.warn({ err: error }, '管理端列表：listManaged 失败，needsRecreate 本轮按未知处理')
        return []
      })
      const bySlug = new Map<string, (typeof containers)[number]>()
      for (const info of containers) {
        const slug = info.labels['dshhub.slug']
        if (slug) bySlug.set(slug, info)
      }
      // ② 期望 config_hash 并发算（各自有 5 s 记忆）；③ stats 只读后台采样器的缓存
      const hashes = await mapLimit(rows, EXPECTED_HASH_CONCURRENCY, (row) => expectedHash(row.user_id))
      const entries: AdminInstanceEntry[] = rows.map((row, index) => {
        const quota = resolveQuota(row.user_id)
        const info = bySlug.get(row.slug)
        const actual = info?.labels[LABEL_CONFIG_HASH] ?? row.config_hash
        const expected = hashes[index] ?? null
        const cached = row.status === 'running' ? (adminStats.get(row.user_id) ?? null) : null
        if (row.status !== 'running') adminStats.delete(row.user_id)
        return {
          user: {
            id: row.user_id,
            slug: row.slug,
            username: row.username,
            displayName: row.display_name,
            avatarUrl: row.avatar_file ? `/api/avatars/${row.avatar_file}` : null,
          },
          status: row.status,
          runtimeVersion: imageVersion(row.image),
          image: row.image,
          ip: row.ip,
          startedAt: row.started_at,
          lastActiveAt: row.last_active_at,
          bootstrappedAt: row.bootstrapped_at,
          error: row.error,
          quota,
          needsRecreate: Boolean(info && expected && actual && actual !== expected),
          stats: cached?.stats ?? null,
          statsAt: cached?.atIso ?? null,
          probe: probeViewOf(row, quota),
        }
      })
      deps.logger.debug(
        { count: entries.length, ms: Math.round(realNow() - startedMs) },
        '管理端实例列表已返回',
      )
      return entries
    },

    async logsFor(userId, tail) {
      const row = repo.find(userId)
      if (!row) return ''
      const text = await deps.driver.logs(row.container_name, { tail }).catch(() => '')
      return redactLogText(text)
    },

    async followLogsFor(userId, onLine, signal) {
      const row = repo.find(userId)
      if (!row) return
      await deps.driver
        .followLogs(row.container_name, (line) => onLine(line), signal)
        .catch((error: unknown) => {
          if (!signal.aborted) deps.logger.warn({ err: error, userId }, '跟随日志失败')
        })
    },

    async hostSnapshot(): Promise<HostSnapshot> {
      const ping = await deps.driver.ping().catch(() => ({ ok: false, version: undefined }))
      let diskTotal = 0
      let diskFree = 0
      try {
        const fs = await statfs(deps.paths.root)
        diskTotal = Number(fs.blocks) * Number(fs.bsize)
        diskFree = Number(fs.bavail) * Number(fs.bsize)
      } catch {
        // 拿不到就报 0，前端显示「未知」
      }
      const [load1 = 0, load5 = 0] = loadavg()
      return {
        cpuCount: cpus().length,
        load1,
        load5,
        memTotal: totalmem(),
        memAvailable: freemem(),
        diskTotal,
        diskFree,
        dockerOk: ping.ok,
        dockerVersion: ping.version ?? null,
      }
    },

    counts(): InstanceCounts {
      const all = repo.countAll()
      return {
        running: all.running,
        max: deps.settings.get('capacity').maxRunning,
        starting: all.starting,
        error: all.error,
      }
    },

    registerSpecOverlay(overlay: InstanceSpecOverlay): void {
      if (typeof overlay !== 'function') return
      // 同一个函数重复注册（同一进程里 createOpsInstance 被调两次）不叠加
      if (specOverlays.includes(overlay)) return
      specOverlays.push(overlay)
    },

    startSchedulers() {
      if (timers.length > 0) return
      void service.reconcileAll().catch((error: unknown) => deps.logger.warn({ err: error }, '启动对账失败'))
      const reconcile = setInterval(() => {
        void service.reconcileAll().catch((error: unknown) => deps.logger.warn({ err: error }, '对账失败'))
      }, RECONCILE_INTERVAL_MS)
      const idle = setInterval(() => {
        void service.reapIdle().catch((error: unknown) => deps.logger.warn({ err: error }, '空闲回收失败'))
      }, IDLE_CHECK_INTERVAL_MS)
      const flush = setInterval(() => flushActivity(), INSTANCE_ACTIVITY_FLUSH_MS)
      // stats 采样器（docs/22 §5.3）：15 s 一轮，只在最近 2 分钟有管理员看列表时运转
      const stats = setInterval(() => void sampleStatsTick(), ADMIN_STATS_SAMPLE_INTERVAL_MS)
      for (const timer of [reconcile, idle, flush, stats]) timer.unref?.()
      timers = [reconcile, idle, flush, stats]
    },

    stopSchedulers() {
      for (const timer of timers) clearInterval(timer)
      timers = []
    },
  }

  function flushActivity(): void {
    if (pendingActivity.size === 0) return
    for (const [userId, at] of pendingActivity) {
      try {
        repo.setLastActive(userId, at)
      } catch (error) {
        deps.logger.debug({ err: error, userId }, '活跃时间落库失败')
      }
    }
    pendingActivity.clear()
  }

  async function stopUnlocked(
    userId: number,
    reason: StartReason,
    auditDetail: Record<string, unknown> | null = null,
  ): Promise<InstanceSummary> {
    const user = repo.requireUser(userId)
    const row = repo.find(userId)
    if (!row) return absentSummary(user)
    const name = row.container_name || nameFor(user.slug)
    repo.setStatus(userId, 'stopping')
    await emitPhase(userId, undefined, '正在停止')
    try {
      await deps.driver.stop(name, STOP_TIMEOUT_SEC)
    } catch (error) {
      deps.logger.warn({ err: error, userId }, '停止容器失败（继续标记为 stopped）')
    }
    repo.markStopped(userId, { stopReason: reason === 'idle' ? deps.clock.nowIso() : undefined })
    cpuSamples.delete(userId)
    // 离开 running：结束租约（13 §4；当前块不退款）
    await notifyStopped(userId, leaseEndReasonForStop(reason))
    deps.audit.log({
      actorId: userId,
      action: 'instance.stop',
      targetType: 'instance',
      targetId: userId,
      detail: { reason, ...(auditDetail ?? {}) },
    })
    const finalRow = repo.find(userId) ?? row
    await emitPhase(userId, undefined, reason === 'idle' ? '空闲自动停止' : undefined)
    return summaryOf(finalRow, user)
  }

  async function recreateUnlocked(
    userId: number,
    reason: StartReason,
    onPhase?: (phase: InstancePhase, message?: string) => void,
  ): Promise<InstanceSummary> {
    const user = repo.requireUser(userId)
    const row = repo.find(userId)
    const name = row?.container_name ?? nameFor(user.slug)
    repo.setStatus(userId, 'stopping')
    await deps.driver.stop(name, STOP_TIMEOUT_SEC).catch(() => undefined)
    await deps.driver.remove(name).catch(() => undefined)
    repo.setStatus(userId, 'stopped')
    minters.delete(userId)
    return ensureUpUnlocked(userId, { reason, onPhase })
  }


  // ── 会话探针 / stats 采样（WP33，docs/22 §5.3 §6） ────────────────────────

  /**
   * 探针一轮：只探 `running` 的实例（绝不唤醒已停实例），并发 ≤ 8、单次超时 3 s，
   * **不调用 `touchActivity`**（docs/22 §6.1）。结果落库（迁移 102）并返回本轮判定。
   *
   * 容器地址由一次 `listManaged()` 提供（与列表同一条提速路径），不逐行 inspect。
   */
  async function runProbeRound(): Promise<ProbeRoundEntry[]> {
    const rows = repo.listByStatus(['running'])
    if (rows.length === 0) return []
    const containers = await deps.driver.listManaged().catch((error: unknown) => {
      deps.logger.warn({ err: error }, '会话探针：listManaged 失败，本轮按未知处理')
      return []
    })
    const bySlug = new Map<string, (typeof containers)[number]>()
    for (const info of containers) {
      const slug = info.labels['dshhub.slug']
      if (slug) bySlug.set(slug, info)
    }
    const probeAt = deps.clock.nowIso()
    const entries = await mapLimit(
      rows,
      SESSION_PROBE_CONCURRENCY,
      async (row): Promise<ProbeRoundEntry> => {
        const presence = clientPresenceOf(row.user_id)
        const base = {
          userId: row.user_id,
          runningSessions: null as number | null,
          lastPromptAtMs: null as number | null,
          openClients: presence.openClients,
          lastClientAtMs: presence.lastClientAtMs,
        }
        const user = repo.findUser(row.user_id)
        const info = user ? bySlug.get(user.slug) : undefined
        const upstream =
          info && info.state === 'running' ? resolveUpstreamTarget(deps.driver, info) : null
        let entry: ProbeRoundEntry
        if (!user || !upstream) {
          entry = { ...base, state: 'unknown', message: '容器不在运行或没有可用地址' }
        } else {
          const result = await probeSessions(
            upstream,
            DEFAULT_AUTHORITY,
            cookieMinter(row.user_id, user.slug),
            SESSION_PROBE_TIMEOUT_MS,
          )
          if (!result.ok) {
            entry = { ...base, state: 'unknown', message: result.message }
          } else {
            const runningSessions = result.items.filter((item) => item.running).length
            const promptMs = result.items.reduce(
              (latest, item) => (item.updatedAt === null ? latest : Math.max(latest, item.updatedAt)),
              0,
            )
            entry = {
              ...base,
              state:
                runningSessions > 0 ? 'busy' : presence.openClients > 0 ? 'watching' : 'unattended',
              runningSessions,
              lastPromptAtMs: promptMs > 0 ? promptMs : null,
              message: 'ok',
            }
          }
        }
        repo.setProbe(row.user_id, {
          state: entry.state,
          at: probeAt,
          runningSessions: entry.runningSessions,
          // busy 的每一轮都刷新 last_busy_at（连续区间由内存里的 busySince 记）
          lastBusyAt: entry.state === 'busy' ? probeAt : null,
          lastPromptAt: entry.lastPromptAtMs === null ? null : isoOfMs(entry.lastPromptAtMs),
          lastClientAt: entry.lastClientAtMs === null ? null : isoOfMs(entry.lastClientAtMs),
        })
        return entry
      },
    )
    return entries
  }

  /** 采一轮 stats 缓存（运行中实例，并发 ≤ 4，docs/22 §5.3）；返回采到的样本数 */
  async function refreshStats(): Promise<number> {
    const rows = repo.listByStatus(['running'])
    const running = new Set(rows.map((row) => row.user_id))
    for (const userId of [...adminStats.keys()]) {
      if (!running.has(userId)) adminStats.delete(userId)
    }
    let sampled = 0
    await mapLimit(rows, ADMIN_STATS_CONCURRENCY, async (row) => {
      const stats = await service.getStats(row.user_id).catch((error: unknown) => {
        deps.logger.debug({ err: error, userId: row.user_id }, 'stats 采样失败')
        return null
      })
      if (!stats) return
      adminStats.set(row.user_id, {
        atIso: deps.clock.nowIso(),
        sampledAtMs: realNow(),
        stats,
      })
      sampled += 1
    })
    return sampled
  }

  /** 采样器的一拍：只有最近 2 分钟有人看过列表才运转（docs/22 §5.3） */
  async function sampleStatsTick(): Promise<void> {
    if (statsSampling) return
    if (realNow() - lastAdminListAt > ADMIN_LIST_INTEREST_MS) return
    statsSampling = true
    try {
      await refreshStats()
    } catch (error) {
      deps.logger.warn({ err: error }, 'stats 采样失败')
    } finally {
      statsSampling = false
    }
  }

  /** stats 缓存快照（`GET /api/admin/instances/stats`）：只列运行中的实例 */
  function statsSnapshot(): AdminInstanceStatsRow[] {
    return repo.listByStatus(['running']).map((row) => {
      const cached = adminStats.get(row.user_id)
      return {
        userId: row.user_id,
        stats: cached?.stats ?? null,
        statsAt: cached?.atIso ?? null,
      }
    })
  }

  /**
   * 列表里的探针展示值（docs/22 §6.3）：「进行中 N / 有人在看 / 空闲 X 分钟（Y 分钟后休眠）/
   * 未知」。`idleSince` 与 `stopAt` 由服务端按与回收器**同一套**时间点算好，前端不重复推规则。
   */
  function probeViewOf(row: InstanceListRow, quota: Quota): InstanceProbe | null {
    if (row.status !== 'running') return null
    const presence = clientPresenceOf(row.user_id)
    const state: InstanceProbeState = row.probe_state ?? 'unknown'
    const lastClientAt = laterOf(
      row.last_client_at,
      presence.lastClientAtMs === null ? null : isoOfMs(presence.lastClientAtMs),
    )
    let idleSince: string | null = null
    let stopAt: string | null = null
    if (state !== 'unknown' && state !== 'busy') {
      const idleStartMs = latestMs(
        parseMs(row.started_at),
        parseMs(row.last_busy_at),
        parseMs(row.last_prompt_at),
        state === 'unattended' ? parseMs(lastClientAt) : Number.NaN,
      )
      if (Number.isFinite(idleStartMs)) {
        idleSince = isoOfMs(idleStartMs)
        const thresholdMinutes =
          state === 'watching'
            ? quota.idleStopMinutes
            : quota.idleNoClientMinutes > 0
              ? quota.idleNoClientMinutes
              : quota.idleStopMinutes
        if (quota.idleStopMinutes > 0 && thresholdMinutes > 0) {
          stopAt = isoOfMs(idleStartMs + thresholdMinutes * 60_000)
        }
      }
    }
    return {
      state,
      probeAt: row.probe_at,
      runningSessions: row.running_sessions,
      openClients: presence.openClients,
      lastPromptAt: row.last_prompt_at,
      lastBusyAt: row.last_busy_at,
      lastClientAt,
      idleSince,
      stopAt,
    }
  }

  return service
}

/** 人类可读的 GiB（错误文案用；保留一位小数） */
function formatGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
}

function placeholderUser(userId: number, row: InstanceRow): InstanceUserRow {
  return {
    id: userId,
    slug: row.container_name.replace(/^dshhub-/u, ''),
    username: '',
    display_name: '',
    avatar_file: null,
    role: 'user',
    status: 'active',
    quota_json: null,
    runtime_id: row.runtime_id,
    model_preset_id: null,
    model_policy: 'managed',
    deleted_at: null,
  }
}

/** `notImplemented` 桩抛出的错误形态（lib/not-implemented.ts） */
function isNotImplemented(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /尚未实现|not implemented|TODO/iu.test(message)
}
