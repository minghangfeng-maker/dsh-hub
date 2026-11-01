import type { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import Docker from 'dockerode'
import type { ContainerStats } from 'dockerode'
import { CONTAINER_PORT, type InstanceStats } from '@dsh-hub/shared'
import { dockerHostOptions } from '../../config.js'
import { HubError } from '../../lib/errors.js'
import { DEFAULT_ENV_ID, belongsToEnv, ensureSpecNetwork } from './spec.js'
import type {
  ContainerDriver,
  ContainerInfo,
  ContainerSpec,
  DriverPingResult,
  ExecOptions,
  ExecResult,
  UpstreamTarget,
} from './types.js'

/** 容器内 `/tmp`、安全基线等常量见 spec.ts 与 02 §2 */
const SECURITY_OPTS = ['no-new-privileges']
const CAP_DROP = ['ALL']
const LOG_CONFIG = { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }
/** `exec`/`runOnce` 超时后的退出码（与 coreutils 的 `timeout` 一致） */
export const TIMEOUT_EXIT_CODE = 124

interface DockerDriverOptions {
  /** 对账/日志跟随的默认 tail */
  followTail?: number
  /**
   * 本环境标识（`HUB_ENV_ID`）：`listManaged()` 只返回带这个 `dshhub.env` 标签的容器。
   * 缺省 `prod`；**没有 env 标签的旧容器按生产处理**（升级期向后兼容）。
   */
  envId?: string
}

/**
 * 真实容器驱动：Docker Engine API（dockerode，01 §3）。
 *
 * 目标运行时是本机 rootful Docker（开发与生产同一个守护进程，11 §2 的命名隔离由调用方保证）；
 * 为 B 计划（rootless podman，`systemctl --user start podman.socket`）保留兼容性，只用了 Docker
 * API 的常用子集，差异点在三处做了降级：
 *   1. `ensureNetwork` 的 `com.docker.network.bridge.enable_icc` 选项 podman 可能不认 → 去掉重试
 *      （02 §4 的 nftables 规则才是容器互访的最终防线）；
 *   2. podman 下宿主连不上容器 IP（无到容器网段的路由），故 `resolveUpstream` 支持调用方给出的
 *      发布端口（`spec.env.HUB_PUBLISHED_PORT`，rootless 时由上层设置）；
 *   3. `buildImage` 用经典 builder（`/build`），podman 需要 `--format docker` 才保留 HEALTHCHECK，
 *      由 buildArgs 之外的 `format` 字段表达（podman 会忽略不认识的字段）。
 */
export class DockerDriver implements ContainerDriver {
  readonly #docker: Docker
  readonly #followTail: number
  readonly #envId: string
  #networkName: string | null = null
  /** 容器名 → 容器 ID（cgroup 目录要用真实 ID；容器重建后同名 ID 会变，读不到时清掉重取） */
  readonly #containerIds = new Map<string, string>()
  /** cgroup 的 CPU 是累计值：百分比要用两次采样算（`computeCpuPercent`） */
  readonly #cpuSamples = new Map<string, { atMs: number; usageUsec: number }>()

  constructor(dockerHost: string, opts: DockerDriverOptions = {}) {
    this.#docker = new Docker(dockerHostOptions(dockerHost))
    this.#followTail = opts.followTail ?? 200
    this.#envId = opts.envId ?? DEFAULT_ENV_ID
  }

  /** 本环境标识（诊断/测试用） */
  get envId(): string {
    return this.#envId
  }

  /** 供测试/诊断直接拿到底层客户端 */
  get client(): Docker {
    return this.#docker
  }

  async ping(): Promise<DriverPingResult> {
    try {
      await this.#docker.ping()
      const version = await this.#docker.version()
      return { ok: true, version: version.Version }
    } catch {
      return { ok: false }
    }
  }

  async ensureNetwork(name: string, subnet: string): Promise<void> {
    this.#networkName = name
    const existing = await this.#docker.listNetworks({ filters: { name: [name] } })
    const found = existing.find((network) => network.Name === name)
    if (found) {
      const current = found.IPAM?.Config?.[0]?.Subnet
      if (current && subnet && current !== subnet) {
        throw new HubError('INTERNAL', `网络 ${name} 已存在但子网是 ${current}（期望 ${subnet}）`, {
          network: name,
          expected: subnet,
          actual: current,
        })
      }
      return
    }
    const base = {
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: { 'dshhub.managed': '1' },
      IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
    }
    try {
      await this.#docker.createNetwork({
        ...base,
        // 容器互不可达（02 §2 T4）；podman 不认这个选项，下面降级重试
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      })
    } catch (error) {
      if (!isUnsupportedNetworkOption(error)) throw error
      await this.#docker.createNetwork(base)
    }
  }

  /** 用户网络的网关 IP（中转站内部监听器绑它，12 §3）；网络不存在时 null */
  async networkGateway(name: string): Promise<string | null> {
    try {
      const info = await this.#docker.getNetwork(name).inspect()
      const gateway = info.IPAM?.Config?.[0]?.Gateway
      return typeof gateway === 'string' && gateway.length > 0 ? gateway : null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const container = this.#docker.getContainer(name)
    let info: Docker.ContainerInspectInfo
    try {
      info = await container.inspect()
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    return toContainerInfo(info, this.#networkName)
  }

  async create(spec: ContainerSpec): Promise<{ id: string }> {
    const container = await this.#docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: spec.labels,
      // 镜像 ENTRYPOINT（tini + entry.sh）负责起 DSH，这里不覆盖 Cmd
      User: '1000:1000',
      WorkingDir: '/workspace',
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        Binds: spec.mounts.map((mount) => `${mount.host}:${mount.container}${mount.readOnly ? ':ro' : ''}`),
        NanoCpus: Math.round(spec.cpus * 1e9),
        Memory: spec.memoryMb * 1024 * 1024,
        // MemorySwap = Memory：禁 swap（02 §2），否则内存超限会先吃宿主 swap
        MemorySwap: spec.memoryMb * 1024 * 1024,
        PidsLimit: spec.pidsLimit,
        ReadonlyRootfs: spec.readOnlyRootfs,
        Tmpfs: spec.tmpfs,
        CapDrop: CAP_DROP,
        SecurityOpt: SECURITY_OPTS,
        NetworkMode: spec.network,
        // 崩溃不自动重启：由 Hub 决定（02 §2），避免坏镜像导致重启风暴
        RestartPolicy: { Name: 'no' },
        Init: true,
        OomKillDisable: false,
        LogConfig: LOG_CONFIG,
        // 默认不发布端口（02 §2/§4）：Hub 直连容器 IP；
        // B 计划（rootless podman）下发布到宿主回环，宿主端口由内核分配，见 resolveUpstream
        PortBindings: spec.publishPort ? { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } : {},
      },
      ExposedPorts: spec.publishPort ? { '3000/tcp': {} } : undefined,
      NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
    })
    return { id: container.id }
  }

  async start(name: string): Promise<void> {
    try {
      await this.#docker.getContainer(name).start()
    } catch (error) {
      // 304 = 已经在跑（幂等）
      if (isStatus(error, 304)) return
      throw error
    }
  }

  async stop(name: string, timeoutSec: number): Promise<void> {
    try {
      await this.#docker.getContainer(name).stop({ t: timeoutSec })
    } catch (error) {
      if (isStatus(error, 304) || isNotFound(error)) return
      throw error
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.#docker.getContainer(name).remove({ force: true, v: false })
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
  }

  async restart(name: string, timeoutSec: number): Promise<void> {
    await this.#docker.getContainer(name).restart({ t: timeoutSec })
  }

  async exec(name: string, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const container = this.#docker.getContainer(name)
    const exec = await container.exec({
      Cmd: cmd,
      Env: opts.env ? Object.entries(opts.env).map(([key, value]) => `${key}=${value}`) : undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    })
    const stream = (await exec.start({ hijack: true, stdin: false })) as Readable
    const { output, timedOut } = await collectStream(stream, opts)
    const info = await exec.inspect()
    return {
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : (info.ExitCode ?? -1),
      output: timedOut ? `${output}\n[timeout] 命令超过 ${String(opts.timeoutMs ?? 0)}ms 未结束` : output,
    }
  }

  async runOnce(spec: ContainerSpec, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    // WP8b B1：一次性容器也可能跑在「还没建过」的用户网络上（插件下发给从未启动过实例的用户），
    // 先确保网络存在，否则 createContainer 会 404 `network … not found`
    await ensureSpecNetwork(this, spec)
    const container = await this.#docker.createContainer({
      name: `${spec.name}-once-${Date.now().toString(36)}`,
      Image: spec.image,
      // 一次性维护容器要跑的是命令本身，不能走镜像的 entry.sh
      Entrypoint: cmd,
      Env: Object.entries({ ...spec.env, ...opts.env }).map(([key, value]) => `${key}=${value}`),
      Labels: { ...spec.labels, 'dshhub.once': '1' },
      User: '1000:1000',
      WorkingDir: '/workspace',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: spec.mounts.map((mount) => `${mount.host}:${mount.container}${mount.readOnly ? ':ro' : ''}`),
        NanoCpus: Math.round(spec.cpus * 1e9),
        Memory: spec.memoryMb * 1024 * 1024,
        MemorySwap: spec.memoryMb * 1024 * 1024,
        PidsLimit: spec.pidsLimit,
        ReadonlyRootfs: spec.readOnlyRootfs,
        Tmpfs: spec.tmpfs,
        CapDrop: CAP_DROP,
        SecurityOpt: SECURITY_OPTS,
        NetworkMode: spec.network,
        RestartPolicy: { Name: 'no' },
        Init: true,
        LogConfig: LOG_CONFIG,
        AutoRemove: false,
      },
    })
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        void container.kill().catch(() => undefined)
      },
      Math.max(1, opts.timeoutMs ?? 600_000),
    )
    timer.unref?.()
    try {
      await container.start()
      const logStream = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
      })) as unknown as Readable
      const collector = collectStream(logStream, opts)
      const waitResult = (await container.wait()) as { StatusCode?: number }
      const { output } = await collector
      return {
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (waitResult.StatusCode ?? -1),
        output: timedOut ? `${output}\n[timeout] 一次性容器被终止` : output,
      }
    } finally {
      clearTimeout(timer)
      await container.remove({ force: true, v: false }).catch(() => undefined)
    }
  }

  async logs(name: string, opts: { tail: number; follow?: false }): Promise<string> {
    const buffer = await this.#docker
      .getContainer(name)
      .logs({ stdout: true, stderr: true, tail: Math.max(1, opts.tail), timestamps: false })
    return demuxBuffer(buffer)
  }

  async followLogs(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const stream = (await this.#docker
      .getContainer(name)
      .logs({ follow: true, stdout: true, stderr: true, tail: this.#followTail })) as unknown as Readable
    const decoder = createLineDecoder(onLine)
    await new Promise<void>((resolve) => {
      const done = (): void => {
        stream.destroy()
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      stream.on('data', (chunk: Buffer) => decoder.write(demuxBuffer(chunk)))
      stream.on('error', done)
      stream.on('end', () => {
        decoder.flush()
        resolve()
      })
    })
  }

  /**
   * 容器资源统计。
   *
   * **优先直读 cgroup v2**：Docker Engine 的 `GET /containers/{id}/stats?stream=false` 要等
   * 1 秒采样窗口（实测 `docker stats --no-stream` 1.0–2.0 s），而 `/api/me/instance` 这类首屏
   * 接口每次都要它；cgroup 的 `memory.current` / `pids.current` / `cpu.stat` 读一次只要几百微秒。
   * 读不到（cgroup v1、podman、权限）才回退 Engine 接口。
   */
  async stats(name: string): Promise<Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null> {
    const fast = await this.#cgroupStats(name).catch(() => null)
    if (fast) return fast
    let raw: ContainerStats
    try {
      raw = await this.#docker.getContainer(name).stats({ stream: false })
    } catch {
      // 容器不在运行（409）或已删除
      return null
    }
    return toStats(raw)
  }

  /** cgroup 直读的统计；任何一步读不到都返回 null（调用方回退 Engine 接口） */
  async #cgroupStats(name: string): Promise<Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null> {
    let id = this.#containerIds.get(name)
    if (!id) {
      const info = await this.#docker
        .getContainer(name)
        .inspect()
        .catch(() => null)
      if (!info?.Id) return null
      id = info.Id
      this.#containerIds.set(name, id)
    }
    let snapshot = await readCgroupSnapshot(id).catch(() => null)
    if (!snapshot) {
      // 同名容器可能被重建过（ID 变了）：清缓存后重新 inspect 一次
      this.#containerIds.delete(name)
      const info = await this.#docker
        .getContainer(name)
        .inspect()
        .catch(() => null)
      if (!info?.Id) return null
      id = info.Id
      this.#containerIds.set(name, id)
      snapshot = await readCgroupSnapshot(id).catch(() => null)
      if (!snapshot) return null
    }
    const now = { atMs: Date.now(), usageUsec: snapshot.cpuUsageUsec }
    const prev = this.#cpuSamples.get(id)
    this.#cpuSamples.set(id, now)
    return statsFromCgroup(snapshot, prev)
  }

  /**
   * 一次 `GET /containers/json?all=1` 拿全部托管容器的状态与标签（docs/22 §5.1；WP33）。
   *
   * **不逐容器 inspect**：列表响应里已经有 State / Labels / IP / 端口映射，50 个实例从
   * 50 次往返降到 1 次。代价是拿不到 `StartedAt` 与 `ExitCode`（Docker 的列表接口不返回它们）：
   * `startedAt` 为 null，需要精确启动时刻的调用方（对账发现「刚变成 running」的那一行）
   * 自己再 inspect 那一个容器。
   *
   * 只列本环境的容器：开发/测试与生产共用同一个 Docker（11 §2），靠 `dshhub.env` 标签把
   * 对账/回收的视野限制在自己的环境里。Docker 的 label 过滤器表达不了「标签不存在也算本环境」，
   * 所以先只按 managed 过滤，再用 belongsToEnv 在 JS 里判断——否则升级前建的旧容器会被漏掉。
   */
  async listManaged(): Promise<ContainerInfo[]> {
    const list = await this.#docker.listContainers({
      all: true,
      filters: { label: ['dshhub.managed=1'] },
    })
    const infos: ContainerInfo[] = []
    for (const entry of list) {
      const info = this.#infoFromListEntry(entry)
      if (info && belongsToEnv(info.labels, this.#envId)) infos.push(info)
    }
    return infos
  }

  /** `ContainerSummary`（docker ps 的 JSON）→ `ContainerInfo`；IP 取与 inspect 相同的优先网络 */
  #infoFromListEntry(entry: Docker.ContainerInfo): ContainerInfo | null {
    const name = (entry.Names?.[0] ?? '').replace(/^\//u, '')
    if (!name) return null
    const networks = entry.NetworkSettings?.Networks ?? {}
    const names = Object.keys(networks)
    const preferred =
      (this.#networkName ? names.find((item) => item === this.#networkName) : undefined) ??
      names.find((item) => item !== 'bridge' && item !== 'host' && item !== 'none') ??
      names[0]
    const ip = preferred ? (networks[preferred]?.IPAddress ?? null) : null
    const published = entry.Ports.find((port) => port.PrivatePort === CONTAINER_PORT && port.PublicPort)
    return {
      id: entry.Id,
      name,
      state: entry.State ?? 'unknown',
      ip: ip && ip.length > 0 ? ip : null,
      labels: entry.Labels ?? {},
      // 列表接口不返回 StartedAt / ExitCode（见方法注释）
      startedAt: null,
      exitCode: null,
      publishedPort: published?.PublicPort ?? null,
    }
  }

  async buildImage(
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string>,
    onLog: (line: string) => void,
  ): Promise<{ imageId: string; sizeBytes: number }> {
    const stream = (await this.#docker.buildImage(
      { context: contextDir, src: ['Dockerfile', 'entry.sh', 'forward.mjs', 'healthcheck.mjs', 'README.md'] },
      { t: tag, buildargs: buildArgs, labels: { 'dshhub.built-by': 'dsh-hub' } },
    )) as unknown as Readable
    await consumeBuildLog(stream, onLog)
    const info = await this.#docker.getImage(tag).inspect()
    return { imageId: info.Id, sizeBytes: Number(info.Size ?? 0) }
  }

  async removeImage(tag: string): Promise<void> {
    try {
      await this.#docker.getImage(tag).remove({ force: false })
    } catch (error) {
      if (isNotFound(error) || isStatus(error, 409)) return
      throw error
    }
  }

  async imageExists(tag: string): Promise<boolean> {
    try {
      await this.#docker.getImage(tag).inspect()
      return true
    } catch {
      return false
    }
  }

  async imageInfo(tag: string): Promise<{ imageId: string; sizeBytes: number } | null> {
    try {
      const info = await this.#docker.getImage(tag).inspect()
      return { imageId: info.Id, sizeBytes: Number(info.Size ?? 0) }
    } catch {
      return null
    }
  }

  /**
   * Hub → 容器的上游地址（05 §4）。
   * Docker rootful：宿主直接路由到容器网段，直连 `容器IP:3000`（WP2 实测）；
   * rootless podman：宿主没有到容器网段的路由，调用方在 env 里放了发布端口 → 连 `127.0.0.1:<port>`。
   */
  resolveUpstream(info: ContainerInfo): UpstreamTarget | null {
    // B 计划（rootless podman）：宿主没有到容器网段的路由，只能走发布出来的回环端口
    const published = info.publishedPort ?? Number(info.labels['dshhub.published_port'] ?? Number.NaN)
    if (Number.isInteger(published) && published > 0) return { host: '127.0.0.1', port: published }
    if (!info.ip) return null
    return { host: info.ip, port: CONTAINER_PORT }
  }

  async dispose(): Promise<void> {
    // dockerode 走 unix socket / 默认 agent，没有需要显式关闭的连接池
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

function toContainerInfo(info: Docker.ContainerInspectInfo, preferredNetwork: string | null): ContainerInfo {
  const networks = info.NetworkSettings?.Networks ?? {}
  const names = Object.keys(networks)
  const preferred =
    (preferredNetwork ? names.find((name) => name === preferredNetwork) : undefined) ??
    names.find((name) => name !== 'bridge' && name !== 'host' && name !== 'none') ??
    names[0]
  const ip = preferred ? (networks[preferred]?.IPAddress ?? null) : null
  const published = info.NetworkSettings?.Ports?.['3000/tcp']?.[0]?.HostPort
  const publishedPort = published ? Number(published) : null
  return {
    id: info.Id,
    name: info.Name.replace(/^\//u, ''),
    state: info.State?.Status ?? 'unknown',
    ip: ip && ip.length > 0 ? ip : null,
    labels: info.Config?.Labels ?? {},
    startedAt:
      info.State?.StartedAt && !info.State.StartedAt.startsWith('0001-') ? info.State.StartedAt : null,
    exitCode: info.State?.ExitCode ?? null,
    publishedPort: publishedPort && Number.isInteger(publishedPort) ? publishedPort : null,
  }
}

function toStats(raw: ContainerStats): {
  cpuPercent: number
  memoryBytes: number
  memoryLimitBytes: number
  pids: number
} {
  const cpu = raw.cpu_stats
  const preCpu = raw.precpu_stats
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (preCpu?.cpu_usage?.total_usage ?? 0)
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (preCpu?.system_cpu_usage ?? 0)
  const onlineCpus = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0
  const mem = raw.memory_stats ?? {}
  const rawUsage = mem.usage ?? 0
  const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0
  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryBytes: Math.max(0, rawUsage - cache),
    memoryLimitBytes: mem.limit ?? 0,
    pids: raw.pids_stats?.current ?? 0,
  }
}

// ── cgroup v2 直读的快速统计 ────────────────────────────────────────────────

/** cgroup v2 挂载点 */
export const CGROUP_ROOT = '/sys/fs/cgroup'

/**
 * 容器 ID → 可能的 cgroup 目录（按优先级）。
 * 本机 Docker 用 systemd cgroup 驱动（`system.slice/docker-<id>.scope`）；
 * cgroupfs 驱动的部署是 `docker/<id>`；两种都试，都没有就回退 Engine 统计接口。
 */
export function cgroupDirsFor(id: string): string[] {
  return [`${CGROUP_ROOT}/system.slice/docker-${id}.scope`, `${CGROUP_ROOT}/docker/${id}`]
}

export interface CgroupSnapshot {
  /** `memory.current`（字节，含 page cache） */
  memCurrent: number
  /** `memory.max`（字节；`max` = 不限制 → 0） */
  memMax: number
  /** `pids.current` */
  pidsCurrent: number
  /** `cpu.stat` 的 `usage_usec`（累计微秒） */
  cpuUsageUsec: number
  /** `memory.stat` 的 `inactive_file`（字节；Docker 的口径要减掉它） */
  inactiveFile: number
}

/** 解析 `memory.stat`；只关心 `inactive_file`（与 Docker 的 workingSet 口径一致） */
export function parseMemoryStat(text: string): { inactiveFile: number } {
  let inactiveFile = 0
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/u)
    if (key === 'inactive_file' && value !== undefined) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) inactiveFile = parsed
    }
  }
  return { inactiveFile }
}

/** 解析 `cpu.stat` 的 `usage_usec`（cgroup v2 是微秒；解析不到返回 0） */
export function parseCpuUsageUsec(text: string): number {
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/u)
    if (key === 'usage_usec' && value !== undefined) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

/**
 * 两次 cgroup 采样算 CPU 百分比。
 * 与 Docker 的 `(cpuDelta / systemDelta) * onlineCpus * 100` 等价：**100% = 一个核跑满**
 * （`Δusage_usec / Δ墙钟_us × 100`）。采样窗口太短（< `minWindowMs`）时返回 0，
 * 避免抖动出一个离谱的数字。
 */
export function computeCpuPercent(
  prev: { atMs: number; usageUsec: number } | undefined,
  now: { atMs: number; usageUsec: number },
  minWindowMs = 200,
): number {
  if (!prev) return 0
  const windowUs = (now.atMs - prev.atMs) * 1000
  const usageDelta = now.usageUsec - prev.usageUsec
  if (windowUs < minWindowMs * 1000 || usageDelta <= 0) return 0
  return Math.round((usageDelta / windowUs) * 100 * 100) / 100
}

/** cgroup 快照 + 上一次 CPU 采样 → 与 `toStats` 同形状的统计值 */
export function statsFromCgroup(
  snapshot: CgroupSnapshot,
  prev: { atMs: number; usageUsec: number } | undefined,
): { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; pids: number } {
  const now = { atMs: Date.now(), usageUsec: snapshot.cpuUsageUsec }
  return {
    cpuPercent: computeCpuPercent(prev, now),
    // 与 `toStats` 一致：workingSet = memory.current − inactive_file
    memoryBytes: Math.max(0, snapshot.memCurrent - snapshot.inactiveFile),
    memoryLimitBytes: snapshot.memMax,
    pids: snapshot.pidsCurrent,
  }
}

/** 读一个容器的 cgroup 快照；任一文件读不到就返回 null（调用方回退 Engine 接口） */
export async function readCgroupSnapshot(id: string): Promise<CgroupSnapshot | null> {
  for (const dir of cgroupDirsFor(id)) {
    try {
      const [memCurrent, memMaxRaw, pidsCurrent, cpuStat, memStat] = await Promise.all([
        readFile(`${dir}/memory.current`, 'utf8'),
        readFile(`${dir}/memory.max`, 'utf8'),
        readFile(`${dir}/pids.current`, 'utf8'),
        readFile(`${dir}/cpu.stat`, 'utf8'),
        readFile(`${dir}/memory.stat`, 'utf8'),
      ])
      const memMax = Number(memMaxRaw.trim())
      return {
        memCurrent: Number(memCurrent.trim()) || 0,
        memMax: Number.isFinite(memMax) && memMax > 0 ? memMax : 0,
        pidsCurrent: Number(pidsCurrent.trim()) || 0,
        cpuUsageUsec: parseCpuUsageUsec(cpuStat),
        inactiveFile: parseMemoryStat(memStat).inactiveFile,
      }
    } catch {
      // 这个布局不存在/没权限，试下一个
    }
  }
  return null
}

/**
 * Docker 的多路复用流（`Tty:false`）每帧 8 字节头：`[stream, 0,0,0, size(4 BE)]`。
 * 自己解而不是用 `docker.modem.demuxStream`：只依赖公开的流格式，podman 下行为一致。
 */ function demuxBuffer(buffer: Buffer): string {
  let offset = 0
  let out = ''
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + size, buffer.length)
    if (size === 0) {
      offset = start
      continue
    }
    // 头部的 size 高字节可能是帧类型之外的噪声；用可打印性兜底判断是不是裸文本
    if (size > buffer.length) return buffer.toString('utf8')
    out += buffer.subarray(start, end).toString('utf8')
    offset = end
  }
  if (out.length === 0) return buffer.toString('utf8')
  if (offset < buffer.length) out += buffer.subarray(offset).toString('utf8')
  return out
}

function createLineDecoder(onLine: (line: string) => void): { write(text: string): void; flush(): void } {
  let pending = ''
  return {
    write(text) {
      pending += text
      let index = pending.indexOf('\n')
      while (index >= 0) {
        onLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
    },
    flush() {
      if (pending.length > 0) {
        onLine(pending)
        pending = ''
      }
    },
  }
}

/** 收集一个流到字符串；超时则销毁流（`timedOut`） */
async function collectStream(
  stream: Readable,
  opts: ExecOptions,
): Promise<{ output: string; timedOut: boolean }> {
  let output = ''
  let timedOut = false
  const feed = (chunk: Buffer): void => {
    const text = demuxBuffer(chunk)
    output += text
    opts.onOutput?.(text)
  }
  await new Promise<void>((resolve) => {
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            stream.destroy()
            resolve()
          }, opts.timeoutMs)
    timer?.unref?.()
    stream.on('data', feed)
    stream.on('end', () => {
      if (timer) clearTimeout(timer)
      resolve()
    })
    stream.on('error', () => {
      if (timer) clearTimeout(timer)
      resolve()
    })
    stream.on('close', () => {
      if (timer) clearTimeout(timer)
      resolve()
    })
  })
  return { output, timedOut }
}

/** 逐行消费构建日志（Docker 的 JSON 流；podman 兼容同样的格式） */
async function consumeBuildLog(stream: Readable, onLog: (line: string) => void): Promise<void> {
  const decoder = createLineDecoder((line) => {
    const text = line.trim()
    if (text.length === 0) return
    try {
      const parsed = JSON.parse(text) as {
        stream?: string
        status?: string
        progress?: string
        error?: string
        errorDetail?: { message?: string }
        aux?: { ID?: string }
      }
      if (parsed.stream) {
        for (const part of parsed.stream.split('\n')) if (part.trim().length > 0) onLog(part)
        return
      }
      if (parsed.error || parsed.errorDetail?.message) {
        onLog(`[error] ${parsed.errorDetail?.message ?? parsed.error ?? ''}`)
        return
      }
      if (parsed.status) onLog(parsed.progress ? `${parsed.status} ${parsed.progress}` : parsed.status)
    } catch {
      onLog(text)
    }
  })
  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => decoder.write(chunk.toString('utf8')))
    stream.on('error', (error: Error) => {
      decoder.write(`[error] ${error.message}`)
      resolve()
    })
    stream.on('end', () => {
      decoder.flush()
      resolve()
    })
  })
}

function isNotFound(error: unknown): boolean {
  return isStatus(error, 404)
}

function isStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { statusCode?: unknown; status?: unknown; reason?: unknown }
  const code = typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status
  if (code === status) return true
  return typeof candidate.reason === 'string' && candidate.reason.includes(String(status))
}

/** podman 对 `com.docker.network.bridge.enable_icc` 之类选项的报错形态不固定，做宽松匹配 */
function isUnsupportedNetworkOption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /enable_icc|unknown option|unsupported option|invalid option|unrecognized option/iu.test(message)
}
