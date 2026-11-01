import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { CONTAINER_LABEL_MANAGED, type InstanceStats } from '@dsh-hub/shared'
import { systemClock, type Clock } from '../../lib/clock.js'
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

/** 假 DSH 记录的一次请求（代理测试用） */
export interface FakeDshRequest {
  method: string
  url: string
  host: string | null
  origin: string | null
  referer: string | null
  cookie: string | null
  acceptEncoding: string | null
  forwardedFor: string | null
  at: string
}

export type FakeExecHandler = (
  name: string,
  cmd: string[],
  opts?: ExecOptions,
) => ExecResult | Promise<ExecResult>

export interface FakeDriverOptions {
  clock?: Clock
  /** 假 DSH 绑定地址，默认 127.0.0.1（真实容器里是容器 IP） */
  host?: string
  /** 注入 exec/runOnce 的结果（插件安装、pnpm 的测试） */
  execHandler?: FakeExecHandler
  /** 首页是否要求 `dsh-auth-*` cookie（代理测试断言 cookie 注入时打开） */
  requireAuthCookie?: boolean
  /** 容器 start 后多久「写好」browser-session 密钥（模拟 S8 时序；默认 0） */
  readyDelayMs?: number
  /** 本环境标识（`HUB_ENV_ID`）：`listManaged()` 只返回本环境的容器（默认 prod） */
  envId?: string
}

/**
 * 假 DSH 的「会话列表」端点状态（WP33 会话探针用）。
 * 默认 `null` = 端点不生效（走 404）→ 探针失败 → 服务端按**未知**状态走旧的 CPU 规则，
 * 这样既有测试的语义完全不变；测探针的用例显式 `setSessions(...)` 打开它。
 */
export interface FakeSessionListState {
  /** 会话项：`running` 与 `updatedAt`（epoch 毫秒）与上游 `SessionSummary` 同形 */
  sessions: { running: boolean; updatedAt: number }[]
  /** true = 端点返回 500（模拟探针失败 / 旧版 DSH 行为） */
  fail?: boolean
  /** 响应延迟（模拟慢实例；探针 3 s 超时用它验证） */
  delayMs?: number
}

/** 假 stats 的默认值（可被 setStats 覆盖） */
const DEFAULT_STATS: Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> = {
  cpuPercent: 1.5,
  memoryBytes: 128 * 1024 * 1024,
  memoryLimitBytes: 2048 * 1024 * 1024,
  pids: 7,
}

interface FakeContainer {
  id: string
  name: string
  spec: ContainerSpec
  state: 'created' | 'running' | 'exited'
  ip: string | null
  port: number
  server: Server
  startedAt: string | null
  exitCode: number | null
  logs: string[]
  requests: FakeDshRequest[]
  /** 假 DSH 的 browser-session 密钥（43 字符 base64url） */
  secret: string
  readyTimer: NodeJS.Timeout | null
  sockets: Set<Socket>
}

const BOOT_MARKER = '__DSH_BOOT__'

/**
 * `FakeDriver`（05 §8 末段）：内存状态机 + 每容器一个本机假 DSH。
 *
 * 用途：全部单元/集成测试，以及没有 Docker 权限时的开发模式。为了能顶替真容器，
 * 它模拟了三件真实行为：
 *   1. `create` 时按挂载表在 `users/<slug>/home/.dsh/` 写一份 `.credentials.yaml`
 *      （`start` 后 `readyDelayMs` 生效）——Hub 的就绪判据 ③④ 就是读它签 cookie；
 *   2. 假 DSH 支持 HTTP（含 gzip 首页）、WebSocket 回显、SSE 分块推送、`dsh-auth-*` Set-Cookie；
 *   3. `exec`/`runOnce` 行为可注入（模拟 pnpm 成功/失败），`stats` 可覆盖，容器可被 `crash()`。
 */
export class FakeDriver implements ContainerDriver {
  readonly #clock: Clock
  readonly #host: string
  readonly #containers = new Map<string, FakeContainer>()
  readonly #images = new Map<string, { imageId: string; sizeBytes: number }>()
  #network: { name: string; subnet: string } | null = null
  #execHandler: FakeExecHandler | undefined
  #readyDelayMs: number
  #requireAuthCookie: boolean
  #envId: string
  #statsOverride: Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null = null
  #sessionList: FakeSessionListState | null = null
  /** 会话探针收到过多少次请求（断言「停止的实例不被探测」用） */
  #sessionProbeHits = 0
  /** 最近一次 session/list 的请求体（断言线格式用） */
  #lastSessionProbeBody: string | null = null
  #seq = 0

  constructor(opts: FakeDriverOptions = {}) {
    this.#clock = opts.clock ?? systemClock
    this.#host = opts.host ?? '127.0.0.1'
    this.#execHandler = opts.execHandler
    this.#requireAuthCookie = opts.requireAuthCookie ?? false
    this.#readyDelayMs = opts.readyDelayMs ?? 0
    this.#envId = opts.envId ?? DEFAULT_ENV_ID
  }

  /** 本环境标识（测试断言用） */
  get envId(): string {
    return this.#envId
  }

  // ── 测试辅助 ──────────────────────────────────────────────────────────────

  /** 换掉 exec/runOnce 的行为（例如：`dsh plugin add` 返回 1） */
  setExecHandler(handler: FakeExecHandler | undefined): void {
    this.#execHandler = handler
  }

  /** 首页是否要求 cookie（打开后能验证代理确实注入了现签 DSH cookie） */
  setRequireAuthCookie(value: boolean): void {
    this.#requireAuthCookie = value
  }

  /** 密钥落盘延迟（模拟 S8 的「先监听、后写密钥」；设大值可测就绪超时） */
  setReadyDelay(ms: number): void {
    this.#readyDelayMs = ms
  }

  /**
   * 打开/关闭假 DSH 的 `POST /api/session/list`（WP33）：
   * `null` = 关闭（404，探针失败）；传会话数组 = 正常响应。
   */
  setSessions(state: FakeSessionListState | null): void {
    this.#sessionList = state
  }

  /** 会话探针累计打进假 DSH 的次数（所有容器合计） */
  get sessionProbeHits(): number {
    return this.#sessionProbeHits
  }

  /** 最近一次 `session/list` 的请求体（断言 client-request 信封用） */
  lastSessionProbeBody(): string | null {
    return this.#lastSessionProbeBody
  }

  /** 覆盖 stats（`null` 恢复默认） */
  setStats(stats: Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null): void {
    this.#statsOverride = stats
  }

  /** 模拟容器崩溃（对账测试用） */
  crash(name: string, exitCode = 1): void {
    const container = this.#require(name)
    container.state = 'exited'
    container.exitCode = exitCode
    container.logs.push(`fake-driver: crashed with exit code ${exitCode}`)
    for (const socket of container.sockets) socket.destroy()
    container.sockets.clear()
  }

  /** 假 DSH 的端口（代理测试要拼 `http://127.0.0.1:<port>`） */
  getPort(name: string): number | undefined {
    return this.#containers.get(name)?.port
  }

  getBaseUrl(name: string): string | undefined {
    const container = this.#containers.get(name)
    return container ? `http://${this.#host}:${container.port}` : undefined
  }

  getRequests(name: string): FakeDshRequest[] {
    return [...(this.#containers.get(name)?.requests ?? [])]
  }

  clearRequests(name: string): void {
    const container = this.#containers.get(name)
    if (container) container.requests = []
  }

  getContainerNames(): string[] {
    return [...this.#containers.keys()]
  }

  getContainer(name: string): { spec: ContainerSpec; state: string; ip: string | null } | undefined {
    const container = this.#containers.get(name)
    if (!container) return undefined
    return { spec: container.spec, state: container.state, ip: container.ip }
  }

  getNetwork(): { name: string; subnet: string } | null {
    return this.#network
  }

  /** 假 DSH 的 browser-session 密钥（测试要自行校验 cookie 时用） */
  getSecret(name: string): string | undefined {
    return this.#containers.get(name)?.secret
  }

  /** 关闭全部假 DSH 服务（app.close 时调用） */
  async dispose(): Promise<void> {
    for (const container of this.#containers.values()) {
      if (container.readyTimer) clearTimeout(container.readyTimer)
      for (const socket of container.sockets) socket.destroy()
      await closeServer(container.server)
    }
    this.#containers.clear()
  }

  // ── ContainerDriver ──────────────────────────────────────────────────────

  async ping(): Promise<DriverPingResult> {
    return { ok: true, version: 'fake-1.0' }
  }

  async ensureNetwork(name: string, subnet: string): Promise<void> {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/u.test(subnet)) {
      throw new HubError('VALIDATION_FAILED', `子网不合法：${subnet}`)
    }
    this.#network = { name, subnet }
  }

  /** 假驱动固定返回生产网段网关（12 §3），让中转站内部监听器的地址推导有确定结果 */
  async networkGateway(name: string): Promise<string | null> {
    void name
    return '10.213.0.1'
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const container = this.#containers.get(name)
    if (!container) return null
    return this.#info(container)
  }

  async create(spec: ContainerSpec): Promise<{ id: string }> {
    if (this.#containers.has(spec.name)) {
      throw new HubError('CONFLICT', `容器已存在：${spec.name}`)
    }
    const { port, server } = await this.#startFakeDsh(spec)
    this.#seq += 1
    const container: FakeContainer = {
      id: `fake${this.#seq.toString(16).padStart(12, '0')}`,
      name: spec.name,
      spec,
      state: 'created',
      // 真实 Docker 在 create 时就分配 IP；假驱动用回环 + 随机端口
      ip: this.#host,
      port,
      server,
      startedAt: null,
      exitCode: null,
      logs: [`fake-driver: created ${spec.name} from ${spec.image}`],
      requests: [],
      secret: base64url(randomBytes(32)),
      readyTimer: null,
      sockets: new Set(),
    }
    this.#containers.set(spec.name, container)
    return { id: container.id }
  }

  async start(name: string): Promise<void> {
    const container = this.#require(name)
    container.state = 'running'
    container.startedAt = this.#clock.nowIso()
    container.exitCode = null
    container.logs.push('fake-driver: started')
    this.#scheduleSecret(container)
  }

  async stop(name: string, _timeoutSec: number): Promise<void> {
    const container = this.#require(name)
    container.state = 'exited'
    container.exitCode = 0
    container.logs.push('fake-driver: stopped')
    for (const socket of container.sockets) socket.destroy()
    container.sockets.clear()
  }

  async restart(name: string, _timeoutSec: number): Promise<void> {
    const container = this.#require(name)
    container.state = 'running'
    container.startedAt = this.#clock.nowIso()
    container.exitCode = null
    container.logs.push('fake-driver: restarted')
    this.#scheduleSecret(container)
  }

  async remove(name: string): Promise<void> {
    const container = this.#require(name)
    if (container.readyTimer) clearTimeout(container.readyTimer)
    for (const socket of container.sockets) socket.destroy()
    await closeServer(container.server)
    this.#containers.delete(name)
  }

  async exec(name: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    const container = this.#require(name)
    const result = await this.#run(container.name, cmd, opts)
    container.logs.push(`$ ${cmd.join(' ')} → exit ${result.exitCode}`)
    return result
  }

  async runOnce(spec: ContainerSpec, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    // 与 DockerDriver 同语义（WP8b B1）：一次性容器用用户网络前先确保网络存在
    await ensureSpecNetwork(this, spec)
    const result = await this.#run(spec.name, cmd, opts)
    this.#containers.get(spec.name)?.logs.push(`[once] $ ${cmd.join(' ')} → exit ${result.exitCode}`)
    return result
  }

  async logs(name: string, opts: { tail: number; follow?: false }): Promise<string> {
    const container = this.#require(name)
    const tail = Math.max(1, opts.tail)
    return container.logs.slice(-tail).join('\n')
  }

  async followLogs(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const container = this.#require(name)
    for (const line of container.logs) onLine(line)
    if (signal.aborted) return
    let offset = container.logs.length
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        for (const line of container.logs.slice(offset)) onLine(line)
        offset = container.logs.length
      }, 20)
      timer.unref?.()
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  async stats(name: string): Promise<Omit<InstanceStats, 'diskBytes' | 'diskLimitBytes'> | null> {
    const container = this.#require(name)
    if (container.state !== 'running') return null
    if (this.#statsOverride) return { ...this.#statsOverride }
    return { ...DEFAULT_STATS, memoryLimitBytes: container.spec.memoryMb * 1024 * 1024 }
  }

  async listManaged(): Promise<ContainerInfo[]> {
    // 与 DockerDriver 同语义：只列本环境的容器（旧的无 env 标签容器算生产）
    return [...this.#containers.values()]
      .filter((container) => container.spec.labels[CONTAINER_LABEL_MANAGED] === '1')
      .filter((container) => belongsToEnv(container.spec.labels, this.#envId))
      .map((container) => this.#info(container))
  }

  async buildImage(
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string>,
    onLog: (line: string) => void,
  ): Promise<{ imageId: string; sizeBytes: number }> {
    onLog(`fake-driver: build ${tag} from ${contextDir}`)
    for (const [key, value] of Object.entries(buildArgs)) onLog(`  ARG ${key}=${value}`)
    onLog('fake-driver: build done')
    const imageId = `sha256:${'f'.repeat(64)}`
    const sizeBytes = 512 * 1024 * 1024
    this.#images.set(tag, { imageId, sizeBytes })
    return { imageId, sizeBytes }
  }

  async removeImage(tag: string): Promise<void> {
    this.#images.delete(tag)
  }

  async imageExists(tag: string): Promise<boolean> {
    return this.#images.has(tag)
  }

  async imageInfo(tag: string): Promise<{ imageId: string; sizeBytes: number } | null> {
    const info = this.#images.get(tag)
    return info ? { ...info } : null
  }

  /** 测试用：声明某个镜像已经在本地（等价于真环境里 `docker build`/`docker pull` 过了） */
  addImage(tag: string, sizeBytes = 512 * 1024 * 1024): void {
    this.#images.set(tag, { imageId: `sha256:${'f'.repeat(64)}`, sizeBytes })
  }

  resolveUpstream(info: ContainerInfo): UpstreamTarget | null {
    const container = this.#containers.get(info.name)
    if (!container || container.state !== 'running') return null
    return { host: this.#host, port: container.port }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  #require(name: string): FakeContainer {
    const container = this.#containers.get(name)
    if (!container) throw new HubError('NOT_FOUND', `容器不存在：${name}`)
    return container
  }

  #info(container: FakeContainer): ContainerInfo {
    return {
      id: container.id,
      name: container.name,
      state: container.state,
      ip: container.state === 'running' ? container.ip : null,
      labels: container.spec.labels,
      startedAt: container.startedAt,
      exitCode: container.exitCode,
    }
  }

  /** 模拟容器启动后 DSH 写出 browser-session 密钥（S8：先监听、再写密钥） */
  #scheduleSecret(container: FakeContainer): void {
    const write = (): void => {
      const home = container.spec.mounts.find((mount) => mount.container === '/home/dsh')?.host
      if (!home) return
      const dir = join(home, '.dsh')
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, '.credentials.yaml'), credentialsYaml(container.secret), { mode: 0o600 })
        container.logs.push('fake-driver: wrote .credentials.yaml')
      } catch {
        // 卷不存在（例如只测驱动本身）：就绪判据会一直等密钥，测试自己决定超时
      }
    }
    if (container.readyTimer) clearTimeout(container.readyTimer)
    if (this.#readyDelayMs <= 0) {
      write()
      return
    }
    const timer = setTimeout(write, this.#readyDelayMs)
    timer.unref?.()
    container.readyTimer = timer
  }

  async #run(name: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (this.#execHandler) return this.#execHandler(name, cmd, opts)
    const output = `[fake] ${cmd.join(' ')}`
    opts?.onOutput?.(output)
    return { exitCode: 0, output }
  }

  async #startFakeDsh(spec: ContainerSpec): Promise<{ port: number; server: Server }> {
    const server = createServer((req, res) => this.#handle(spec.name, req, res))
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(spec.name, req, socket as Socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, this.#host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new HubError('INTERNAL', '假 DSH 启动失败：没有拿到端口')
    }
    return { port: address.port, server }
  }

  #record(name: string, req: IncomingMessage): void {
    const container = this.#containers.get(name)
    container?.requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      host: header(req, 'host'),
      origin: header(req, 'origin'),
      referer: header(req, 'referer'),
      cookie: header(req, 'cookie'),
      acceptEncoding: header(req, 'accept-encoding'),
      forwardedFor: header(req, 'x-forwarded-for'),
      at: this.#clock.nowIso(),
    })
  }

  #handle(name: string, req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/'
    this.#record(name, req)
    const container = this.#containers.get(name)
    if (!container || container.state !== 'running') {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'INSTANCE_NOT_RUNNING', message: 'fake dsh: 未运行' } }))
      return
    }
    const cookie = header(req, 'cookie')
    if (this.#requireAuthCookie && !/dsh-auth-/.test(cookie ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '缺少 DSH cookie' } }))
      return
    }

    if (url === '/' || url.startsWith('/?') || url.startsWith('/index.html')) {
      const html = fakeIndexHtml()
      const acceptEncoding = header(req, 'accept-encoding') ?? ''
      // 真实 DSH 的 webserver 开了 gzip：代理必须把 HTML 请求改成 identity 才能注入
      if (acceptEncoding.includes('gzip')) {
        const body = gzipSync(Buffer.from(html, 'utf8'))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': String(body.byteLength),
        })
        res.end(body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // DSH 的会话列表 RPC（WP33 探针）：`POST /api/session/list` + client-request 信封
    if (url.split('?')[0] === '/api/session/list') {
      this.#handleSessionList(req, res)
      return
    }

    if (url.startsWith('/api/echo')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          method: req.method ?? 'GET',
          url,
          host: header(req, 'host'),
          origin: header(req, 'origin'),
          cookie,
          referer: header(req, 'referer'),
          forwardedFor: header(req, 'x-forwarded-for'),
          forwardedProto: header(req, 'x-forwarded-proto'),
        }),
      )
      return
    }

    // 上游试图种 dsh-auth-* cookie：代理必须丢弃（02 §7.3）
    if (url.startsWith('/api/set-cookie')) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [
          `dsh-auth-${base64url(createHash('sha256').update('127.0.0.1:3000').digest())}=v1.upstream; Path=/; HttpOnly`,
          'upstream_pref=1; Path=/; Domain=example.com',
        ],
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // SSE：分块推送，用来断言代理不缓冲（05 §5.5）
    if (url.startsWith('/plugins/events')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.write(': connected\n\n')
      let index = 0
      const timer = setInterval(() => {
        index += 1
        res.write(`event: tick\ndata: {"n":${String(index)}}\n\n`)
        if (index >= 3) {
          clearInterval(timer)
          res.end()
        }
      }, 30)
      timer.unref?.()
      res.on('close', () => clearInterval(timer))
      return
    }

    if (url.startsWith('/assets/')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end('/* fake asset */')
      return
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fake dsh: 未知路径' } }))
  }

  /**
   * 假 `session/list`：校验信封（type/rpcId/method），回 `server-response`。
   * 端点总是先拦下来；没调用 `setSessions` 时回 404，等价于「旧版 DSH 没有该能力」→ 探针失败。
   */
  #handleSessionList(req: IncomingMessage, res: ServerResponse): void {
    this.#sessionProbeHits += 1
    const state = this.#sessionList
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      this.#lastSessionProbeBody = raw
      const reply = (status: number, body: unknown): void => {
        const text = JSON.stringify(body)
        try {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(text)
        } catch {
          // 客户端已超时断开：写回去会抛，忽略
        }
      }
      if (!state) {
        reply(404, { error: { code: 'NOT_FOUND', message: 'fake dsh: 没有 session/list' } })
        return
      }
      const send = (): void => {
        if (state.fail) {
          reply(500, { error: { code: 'INTERNAL', message: 'fake dsh: session/list 失败' } })
          return
        }
        let envelope: { type?: unknown; rpcId?: unknown; method?: unknown } = {}
        try {
          envelope = JSON.parse(raw) as typeof envelope
        } catch {
          reply(400, { error: { code: 'BAD_REQUEST', message: 'body 不是 JSON' } })
          return
        }
        if (envelope.type !== 'client-request' || envelope.method !== 'session/list') {
          reply(400, { error: { code: 'BAD_REQUEST', message: '不是 session/list 的 client-request' } })
          return
        }
        reply(200, {
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { items: state.sessions } },
        })
      }
      if (state.delayMs && state.delayMs > 0) {
        const timer = setTimeout(send, state.delayMs)
        timer.unref?.()
        return
      }
      send()
    })
  }

  /** 最小 WebSocket 服务端：握手 + 文本帧回显（`/api/remote.mux`） */
  #handleUpgrade(name: string, req: IncomingMessage, socket: Socket, _head: Buffer): void {
    this.#record(name, req)
    const container = this.#containers.get(name)
    const key = header(req, 'sec-websocket-key')
    const url = req.url ?? '/'
    if (!container || container.state !== 'running' || !key) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (this.#requireAuthCookie && !/dsh-auth-/.test(header(req, 'cookie') ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    container.sockets.add(socket)
    this.#serveWebSocket(socket, url)
  }

  #serveWebSocket(socket: Socket, url: string): void {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const frame = decodeFrame(buffer)
        if (!frame) return
        buffer = buffer.subarray(frame.size)
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(0x8, Buffer.alloc(0)))
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload))
          continue
        }
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString('utf8')
          // 回显里带上路径与 Host，方便断言代理改写（05 §5）
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ echo: text, url }), 'utf8')))
        }
      }
    })
    socket.on('error', () => socket.destroy())
  }
}

function fakeIndexHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Fake DSH</title></head>
<body><div id="root" data-boot="${BOOT_MARKER}">${BOOT_MARKER}</div>
<script>window.__DSH_BOOT__ = true</script></body></html>`
}

function credentialsYaml(secret: string): string {
  return [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    payload:',
    `      secret: ${secret}`,
    '',
  ].join('\n')
}

function base64url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** 解一帧（客户端→服务端的帧一定带 mask） */
function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
    }
  }
  return { opcode, payload, size: offset + maskLength + length }
}

/** 服务端 → 客户端的帧不带 mask */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const headerBytes = payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10
  const frame = Buffer.alloc(headerBytes)
  frame[0] = 0x80 | opcode
  if (payload.length < 126) {
    frame[1] = payload.length
  } else if (payload.length < 65_536) {
    frame[1] = 126
    frame.writeUInt16BE(payload.length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([frame, payload])
}
