import type {
  ComputeLeaseEndReason,
  InstancePhase,
  InstanceProbe,
  InstanceStats,
  InstanceStatus,
  InstanceSummary,
  Quota,
  UserRef,
} from '@dsh-hub/shared'

// ── 容器规格（05 §4） ───────────────────────────────────────────────────────

export interface ContainerMount {
  host: string
  container: string
  readOnly: boolean
}

/**
 * `ContainerDriver.create` 的输入；`config_hash` 由 WP2 按 05 §4 的公式算。
 * `env.DSH_AUTHORITY` 取 Hub 实际发送的 Host，推荐 `127.0.0.1:3000`（WP0b S1 结论）。
 * 安全基线（cap-drop ALL / no-new-privileges / MemorySwap / Init）不在规格里，由 driver 统一施加（02 §2）。
 */
export interface ContainerSpec {
  name: string
  image: string
  env: Record<string, string>
  labels: Record<string, string>
  mounts: ContainerMount[]
  cpus: number
  memoryMb: number
  pidsLimit: number
  network: string
  /**
   * `network` 是 Hub 自己管理的用户网络时，这里给出它的子网（`HUB_USERS_SUBNET`）。
   * 一次性维护容器（`runOnce`，05 §8）可能发生在**用户从未启动过实例**的时候，
   * 那时网络还不存在 → 建容器会 404 `network … not found`（WP8b B1）。
   * 驱动据此在建一次性容器前先 `ensureNetwork`；内置网络（none/host/bridge）不需要，留空。
   */
  networkSubnet?: string
  readOnlyRootfs: boolean
  /** tmpfs 挂载（键是容器内路径）：`/tmp` 512MB（02 §2 / S6） */
  tmpfs: Record<string, string>
  /**
   * 是否把容器 3000 发布到宿主回环（B 计划：rootless podman 下宿主没有到容器网段的路由，
   * 05 §4 的退路）。Docker rootful 保持关闭——02 §2 的基线是「无端口发布」。
   * 由 `HUB_CONTAINER_PUBLISH_PORT=1` 打开。
   */
  publishPort?: boolean
}

export interface ContainerInfo {
  id: string
  name: string
  /** docker 的 State.Status：`running` | `exited` | `created` | … */
  state: string
  ip: string | null
  labels: Record<string, string>
  /**
   * 容器真实启动时刻。`listManaged()`（`docker ps` 一次拿全量）拿不到它，返回 null；
   * 调用方需要精确值时对那一个容器再 `inspect()`（docs/22 §5.1；WP33）。
   */
  startedAt: string | null
  exitCode: number | null
  /** 发布到宿主回环的端口（没发布时为 null/undefined） */
  publishedPort?: number | null
}

/** Hub → 容器的上游地址（HTTP/WS/SSE 都走它） */
export interface UpstreamTarget {
  host: string
  port: number
}

export interface ExecOptions {
  env?: Record<string, string>
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}

export interface ExecResult {
  exitCode: number
  output: string
}

export interface DriverPingResult {
  ok: boolean
  version?: string
}

// ── ContainerDriver（05 §8，WP0a 定义、WP2 实现 Docker 版） ─────────────────

export interface ContainerDriver {
  ping(): Promise<DriverPingResult>
  /** 建网并 `enable_icc=false`（容器互不可达，02 §2） */
  ensureNetwork(name: string, subnet: string): Promise<void>
  /**
   * 网络的 IPAM 网关 IP（12 §3：中转站内部监听器要绑在用户网桥网关上，
   * 容器才够得到宿主而 nft 只放行这一个端口）。网络不存在时返回 null。
   */
  networkGateway(name: string): Promise<string | null>
  inspect(name: string): Promise<ContainerInfo | null>
  create(spec: ContainerSpec): Promise<{ id: string }>
  start(name: string): Promise<void>
  stop(name: string, timeoutSec: number): Promise<void>
  remove(name: string): Promise<void>
  restart(name: string, timeoutSec: number): Promise<void>
  exec(name: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  /** 一次性维护容器（`--rm`）：容器停着时改 profile / 装插件用 */
  runOnce(spec: ContainerSpec, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  logs(name: string, opts: { tail: number; follow?: false }): Promise<string>
  followLogs(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void>
  stats(name: string): Promise<Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null>
  /** label `dshhub.managed=1` 的容器（对账用） */
  listManaged(): Promise<ContainerInfo[]>
  buildImage(
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string>,
    onLog: (line: string) => void,
  ): Promise<{ imageId: string; sizeBytes: number }>
  removeImage(tag: string): Promise<void>
  imageExists(tag: string): Promise<boolean>
  /**
   * 镜像元信息（WP8b P1：`cli runtime:adopt` 登记本机已有镜像时记 `image_id`/`size_bytes`）。
   * 镜像不存在返回 `null`；不实现时按「拿不到元信息」处理（登记仍可完成）。
   */
  imageInfo?(tag: string): Promise<{ imageId: string; sizeBytes: number } | null>
  /**
   * Hub 连容器的方式（WP2 扩展，05 §4）：Docker rootful 直连 `容器IP:3000`；
   * rootless podman 需要发布回环端口，此时返回 `127.0.0.1:<发布端口>`。
   * 不实现时按 `{host: info.ip, port: 3000}` 兜底（`resolveUpstreamTarget`）。
   */
  resolveUpstream?(info: ContainerInfo): UpstreamTarget | null
  /** 进程退出前释放驱动资源（04 §8 #13 可选方法） */
  dispose?(): Promise<void>
}

/** 驱动没实现 `resolveUpstream` 时的兜底 */
export function resolveUpstreamTarget(driver: ContainerDriver, info: ContainerInfo): UpstreamTarget | null {
  if (typeof driver.resolveUpstream === 'function') return driver.resolveUpstream(info)
  return info.ip ? { host: info.ip, port: 3000 } : null
}

// ── InstanceService（05 §6；WP2 实现） ──────────────────────────────────────

/** `instances.start_reason` 的取值（03 §1.2）；`insufficient` 只用于余额不足停机（13 §4） */
export type StartReason = 'user' | 'admin' | 'rollout' | 'login' | 'idle' | 'insufficient'

export interface EnsureRunningOptions {
  reason?: StartReason
  /** `POST /api/me/instance/start` 的可选规格（13 §6）；省略 = 用已选规格 */
  planId?: string
  /** 启动阶段回调（SSE `event: status` 的 phase/message） */
  onPhase?: (phase: InstancePhase, message?: string) => void
}

/**
 * 算力租赁与实例生命周期的晚绑定钩子（13 §4）。
 * compute 模块启动时注册；未注册 = 现状（免费、按 Quota）。
 * **钩子在用户锁内被调用**，实现里不得再调 `withUserLock` / `stop` / `ensureRunning`（会死锁）。
 */
export interface ComputeSpec {
  cpus: number
  memoryMb: number
}

/**
 * 系统账号容器的规格覆盖钩子（WP56b：座舱 DSH）。
 *
 * 晚绑定：`modules/cockpit/ops-instance.ts` 创建时注册，只对**它自己的** userId 生效。
 * 只允许改 `cpus/memoryMb/env`（挂载、网络、只读根、标签必须沿用 05 §4 的基线，
 * 免得某个包用这个钩子把宿主特权挂进容器）；返回 `null` = 不覆盖。
 */
export type InstanceSpecOverlay = (userId: number, spec: ContainerSpec) => ContainerSpec | null

export interface ComputeHooks {
  /** 实例当前应使用的 CPU/内存：有进行中租约 → 租约快照；计费开启 → 用户已选规格；否则 null */
  currentSpec(userId: number): ComputeSpec | null
  /** 启动准入（用户锁内、建容器前）：发每日赠送、解析并记住规格、查余额与内存容量；失败抛 HubError */
  beforeStart(userId: number, ctx: { reason: StartReason; planId?: string }): Promise<void> | void
  /** 实例进入 running 后：没有进行中租约就开租（计费的扣第一块） */
  onRunning(userId: number, ctx: { reason: StartReason }): Promise<void> | void
  /** 实例离开 running（stop / 对账发现退出或消失 / 启动失败）：结束进行中租约 */
  onStopped(userId: number, reason: ComputeLeaseEndReason): Promise<void> | void
}

/** stop/restart/recreate 的公共参数 */
export interface InstanceActionOptions {
  reason?: StartReason
  /** restart/recreate 也会经历启动阶段，同样可回调 */
  onPhase?: (phase: InstancePhase, message?: string) => void
  /**
   * 额外的审计 detail（WP33：空闲回收要写清探针状态与各时间点，docs/22 §6.3）。
   * 合并在 `instance.stop` 的 detail 里，键名不与 `reason` 冲突。
   */
  auditDetail?: Record<string, unknown>
}

export interface RemoveUserDataResult {
  slug: string
  /** 数据被移到 `trash/` 下的位置；没有数据时为 null */
  trashPath: string | null
}

/** 管理端实例列表的一行（04 §4.3：`AdminInstanceRow` = user + InstanceSummary + stats） */
export interface AdminInstanceEntry {
  user: UserRef
  status: InstanceStatus
  runtimeVersion: string | null
  image: string | null
  ip: string | null
  startedAt: string | null
  lastActiveAt: string | null
  bootstrappedAt: string | null
  error: string | null
  quota: Quota
  needsRecreate: boolean
  /** 宿主统计（只对 running 采集；WP33 起只读后台采样器的缓存） */
  stats: InstanceStats | null
  /** stats 样本的采集时刻（ISO；还没有样本时为 null） */
  statsAt: string | null
  /** 会话探针（docs/22 §6；停止的实例为 null） */
  probe: InstanceProbe | null
}

/** 宿主资源快照（04 §4.1 overview 的 `host` 字段；WP1 的概览接口调用） */
export interface HostSnapshot {
  cpuCount: number
  load1: number
  load5: number
  memTotal: number
  memAvailable: number
  diskTotal: number
  diskFree: number
  dockerOk: boolean
  dockerVersion: string | null
}

export interface InstanceCounts {
  running: number
  max: number
  starting: number
  error: number
}

/**
 * 实例服务（05 §6）。
 * 所有修改实例的操作都在 `withUserLock` 内；启动阶段事件发到事件总线（`instance.status`）。
 */
export interface InstanceService {
  /** 建目录、渲染 managed、`instances` 行置 stopped（不建容器） */
  provision(userId: number, opts?: { reason?: StartReason }): Promise<InstanceSummary>
  /** 起容器并等就绪（≤90s），首次启动跑 bootstrap；已在运行则直接返回 */
  ensureRunning(userId: number, opts?: EnsureRunningOptions): Promise<InstanceSummary>
  stop(userId: number, opts?: InstanceActionOptions): Promise<InstanceSummary>
  /** 规格哈希变了就 recreate，否则 docker restart */
  restart(userId: number, opts?: InstanceActionOptions): Promise<InstanceSummary>
  /** 停 → 删 → 建 → 起（卷不动） */
  recreate(userId: number, opts?: InstanceActionOptions): Promise<InstanceSummary>
  /** 停容器、删容器；数据默认移入 `trash/`，`purge=true` 时彻底删除（04 §4.2 / §8.9，删用户时调用） */
  removeUserData(userId: number, opts?: { purge?: boolean }): Promise<RemoveUserDataResult>
  /** 读 `instances` 行并算出 InstanceSummary（不存在时 status=absent） */
  getSummary(userId: number): Promise<InstanceSummary>
  /** 宿主侧统计（CPU/内存/进程/磁盘），容器不在时返回 null */
  getStats(userId: number): Promise<InstanceStats | null>
  /** 该用户的异步锁（实例操作、插件安装、导出读 profile 都走它） */
  withUserLock<T>(userId: number, fn: () => Promise<T> | T): Promise<T>
  /** 启动时与每 60 秒：把容器实际状态对齐到 instances 表 */
  reconcileAll(): Promise<void>
  /** 每分钟：空闲回收（返回停掉的实例数） */
  reapIdle(): Promise<number>
  /** 期望规格（WP2 用来算 config_hash；模型密钥 env 变化也在这里体现） */
  buildSpec(userId: number): Promise<ContainerSpec>
  /** 用户配额（`users.quota_json` 覆盖全局默认，03 §1.5） */
  resolveQuota(userId: number): Quota
  /** 容器当前状态（'absent' 表示没有容器） */
  currentStatus(userId: number): InstanceStatus

  // ── WP2 扩展（路由/对账/代理需要，04 §3.1 §4.3） ─────────────────────────
  /** 代理每命中一个请求/WS 帧就调一次（内存里累计，30 秒批量落库，05 §5.8） */
  touchActivity(userId: number): void
  /** 立即把内存里的活跃时间写库（空闲回收前调用） */
  flushActivity(): void
  /** 管理端列表（04 §4.3） */
  listForAdmin(opts?: { status?: InstanceStatus }): Promise<AdminInstanceEntry[]>
  /** 容器日志（已脱敏，04 §4.3 `GET /api/admin/instances/:userId/logs`） */
  logsFor(userId: number, tail: number): Promise<string>
  /** 日志流（已脱敏；`signal` 中止） */
  followLogsFor(userId: number, onLine: (line: string) => void, signal: AbortSignal): Promise<void>
  /** 宿主资源快照（04 §4.1 `host` 字段） */
  hostSnapshot(): Promise<HostSnapshot>
  /** 实例计数（04 §4.1 `instances` 字段） */
  counts(): InstanceCounts
  /**
   * 注册系统账号容器的规格覆盖（WP56b：座舱 DSH 的 2C2G / 无出网代理 / `/ops` env）。
   * 只影响注册者自己的 userId；重复注册同一函数不会重复叠加。
   */
  registerSpecOverlay(overlay: InstanceSpecOverlay): void
  /** 启动后台定时器（对账 60s、空闲检查 60s、活跃度落库 30s）；`testing` 下由测试显式调用 */
  startSchedulers(): void
  stopSchedulers(): void
}
