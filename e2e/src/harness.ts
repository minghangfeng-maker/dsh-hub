import { spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { connect } from 'node:net'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  API_ENTRY,
  CLI_ENTRY,
  CONTAINER_PREFIX,
  DATA_ROOT,
  DSH_VERSION,
  ENV_ID,
  RUNTIME_IMAGE,
  HTTP_PORT,
  PUBLIC_ORIGIN,
  REPO_ROOT,
  USERS_NETWORK,
  USERS_SUBNET,
  WEB_DIST_INDEX,
  WEB_DIST_WAKE,
} from './config.js'

/**
 * 起停 Hub、跑 CLI、清理容器/网络（任务书「环境」表）。
 *
 * 隔离四件套：独立数据目录 `e2e/.data/<run-id>/`、专属网络 `dshhub-test-e2e-net`（10.219.19.0/24）、
 * 端口 7790、容器名前缀 `dshhub-test-e2e-` 与环境标签 `dshhub.env=e2e`（主干 WP2 第二轮已支持这两个变量）。
 * 清理仍然以「挂在 e2e 网络上的 label=dshhub.managed=1 容器」为主判据（与命名无关，最稳），
 * 逐个 `docker inspect` 复核网络名，并在 result.json 里留下容器名单。
 */

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  stdin?: string
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string>
}

/** 跑一个子进程并把 stdout/stderr 收全（不走 shell，避免引号/注入问题） */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} 超时（${String(options.timeoutMs ?? 120_000)}ms）：${stderr.slice(-500)}`))
        return
      }
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

/** e2e 期间传给 Hub 与 CLI 的环境变量（与宿主环境隔离；11 §2 要求先 unset 代理） */
export function e2eEnv(dataDir: string): Record<string, string> {
  return {
    HUB_DATA_DIR: dataDir,
    HUB_HTTP_PORT: String(HTTP_PORT),
    HUB_TLS_PORT: '0',
    HUB_REDIRECT_PORT: '0',
    HUB_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HUB_COOKIE_SECURE: 'false',
    HUB_CONTAINER_DRIVER: 'docker',
    HUB_USERS_NETWORK: USERS_NETWORK,
    HUB_USERS_SUBNET: USERS_SUBNET,
    HUB_DEFAULT_DSH_VERSION: DSH_VERSION,
    HUB_LOG_LEVEL: 'info',
    // 环境标识（WP2 第二轮已支持）：容器名 = 前缀 + slug，并打上 `dshhub.env=<ENV_ID>` 标签，
    // 对账/回收/stop-all 只处理本环境，避免碰到生产容器。
    HUB_ENV_ID: ENV_ID,
    HUB_CONTAINER_PREFIX: CONTAINER_PREFIX,
    NODE_ENV: 'production',
    // 手机网页版产物（`/m/`）：J11 用真 App 网页版嵌进舰桥；没设就用 Hub 的默认目录
    ...(process.env['HUB_MOBILE_WEB_DIR'] === undefined || process.env['HUB_MOBILE_WEB_DIR'] === ''
      ? {}
      : { HUB_MOBILE_WEB_DIR: process.env['HUB_MOBILE_WEB_DIR'] }),
    // 代理在 e2e 子进程里也必须清掉（否则容器内 pnpm / npm 查询会走慢代理）
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    all_proxy: '',
    NODE_USE_ENV_PROXY: '',
  }
}

export interface ContainerRecord {
  name: string
  id: string
  image: string
  status: string
}

/**
 * Hub 进程 + 数据目录 + 容器清理。
 * 生命周期：`start()` → 旅程 → `stop()` → `cleanupContainers()`（run.ts 里用 try/finally 保证）。
 */
export class HubHarness {
  readonly runId: string
  readonly dataDir: string
  readonly logFile: string
  /** 自己写下的 PID 文件（清理残留 Hub 的唯一依据，见 killStaleHubs） */
  readonly pidFile: string
  readonly baseUrl = PUBLIC_ORIGIN
  private child: ReturnType<typeof spawn> | null = null
  private logStream: ReturnType<typeof createWriteStream> | null = null
  private logLines: string[] = []
  private containerLog: ContainerRecord[] = []

  constructor(runId: string) {
    this.runId = runId
    this.dataDir = join(DATA_ROOT, runId)
    this.logFile = join(this.dataDir, 'hub.log')
    this.pidFile = join(this.dataDir, 'hub.pid')
  }

  /** 数据目录（含 secrets/ users/ exports/）在起进程前建好 */
  ensureDirs(): void {
    mkdirSync(this.dataDir, { recursive: true })
  }

  /** 构建产物自检：任务书要求用 `node apps/api/dist/main.js` 与前端产物 */
  static checkBuildArtifacts(): string[] {
    const missing: string[] = []
    for (const [label, path] of [
      ['apps/api/dist/main.js', API_ENTRY],
      ['apps/web/dist/index.html', WEB_DIST_INDEX],
      ['apps/web/dist/wake.html', WEB_DIST_WAKE],
    ] as const) {
      if (!existsSync(path)) missing.push(label)
    }
    return missing
  }

  /**
   * 清理上一次崩掉的 e2e Hub：只认**自己写下的 `hub.pid`**（每个 run 目录一个），
   * 不按端口/进程名猜——本沙箱读不到别的进程的 `/proc/<pid>/environ`，`ss -p` 也不给进程信息，
   * 按名字杀有误伤生产的风险（11 §2）。
   */
  private async killStaleHubs(): Promise<void> {
    let entries: string[]
    try {
      entries = readdirSync(DATA_ROOT).filter((name) => RUN_ID_RE.test(name)).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const pidFile = join(DATA_ROOT, name, 'hub.pid')
      if (!existsSync(pidFile)) continue
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
      if (!isAlive(pid)) {
        rmSync(pidFile, { force: true })
        continue
      }
      this.log(`发现上一次运行残留的 Hub 进程 pid=${String(pid)}（${name}），停掉它`)
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // 已经没了
      }
      if (!(await waitFor(() => !isAlive(pid), 8000, 200))) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 忽略
        }
        await waitFor(() => !isAlive(pid), 3000, 200)
      }
      rmSync(pidFile, { force: true })
    }
  }

  /**
   * **先把用户网段建好再起 Hub**：Hub 的中转站内部监听器（座舱 DSH 的 `/ops` 也挂在它上面）
   * 在启动时就要绑到用户网段的网关 IP；网络不存在时它会「30 秒后重试」。
   * 座舱容器的 `DSHHUB_OPS_URL` 是**建容器时**写进 env 的，那一刻监听器还没起来的
   * 话，容器就永远拿不到地址（J11 踩过：容器 02:33:41 建、监听器 02:34:02 才好）。
   */
  private async ensureUsersNetwork(): Promise<void> {
    const exists = await this.docker(['network', 'inspect', USERS_NETWORK], 20_000)
    if (exists.code === 0) return
    const created = await this.docker(['network', 'create', '--subnet', USERS_SUBNET, USERS_NETWORK], 30_000)
    this.log(
      created.code === 0
        ? `预建用户网络：${USERS_NETWORK}（${USERS_SUBNET}）`
        : `预建用户网络失败（Hub 会自己建）：${created.stderr.trim().slice(0, 200)}`,
    )
  }

  /** 端口必须空着（占着就直接报错，不去猜是谁——避免误杀别的会话/生产进程） */
  private async assertPortFree(): Promise<void> {
    const busy = await isPortBusy(HTTP_PORT)
    if (busy) {
      throw new Error(
        `端口 ${String(HTTP_PORT)} 已被占用：先停掉占用它的进程再跑（上一次 e2e 崩溃残留的 Hub 会在 e2e/.data/<run>/hub.pid 里）`,
      )
    }
  }

  log(line: string): void {
    this.logLines.push(line)
    process.stdout.write(`${line}\n`)
  }

  /** 起 Hub：等待 `/api/health` 返回 `{ok:true, db:'ok', docker:'ok'}` */
  async start(): Promise<void> {
    this.ensureDirs()
    await this.killStaleHubs()
    await this.assertPortFree()
    await this.ensureUsersNetwork()
    this.logStream = createWriteStream(this.logFile, { flags: 'a' })
    this.log(`启动 Hub：node ${API_ENTRY}（数据目录 ${this.dataDir}）`)
    const child = spawn('node', [API_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...e2eEnv(this.dataDir) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    if (child.pid !== undefined) writeFileSync(this.pidFile, `${String(child.pid)}\n`, 'utf8')
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      this.logStream?.write(text)
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) this.logLines.push(line)
      }
      if (this.logLines.length > 4000) this.logLines.splice(0, this.logLines.length - 4000)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    let exited: number | null = null
    child.on('exit', (code) => {
      exited = code ?? -1
    })

    const deadline = Date.now() + 45_000
    for (;;) {
      if (exited !== null) {
        throw new Error(`Hub 启动即退出（code ${String(exited)}）：\n${this.logTail(30)}`)
      }
      const health = await this.health().catch(() => null)
      if (health?.ok === true) {
        // 健康检查可能是**别的进程**答的（端口被别人占着时自己的子进程已经退出）：
        // 隔一拍再确认子进程还活着，避免拿旧进程的响应当真（WP8a 实测踩到过）
        await sleep(400)
        if (exited !== null) {
          throw new Error(`Hub 启动后立刻退出（code ${String(exited)}，端口被占用？）：\n${this.logTail(30)}`)
        }
        if (health.db !== 'ok' || health.docker !== 'ok') {
          throw new Error(`Hub 健康检查异常：db=${String(health.db)} docker=${String(health.docker)}`)
        }
        this.log(`Hub 就绪：${this.baseUrl}（version ${String(health.version)}，docker ${String(health.docker)}）`)
        return
      }
      if (Date.now() > deadline) throw new Error(`Hub 45s 内未就绪：\n${this.logTail(30)}`)
      await sleep(300)
    }
  }

  private async health(): Promise<{ ok: boolean; db?: string; docker?: string; version?: string }> {
    const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error(`health ${String(response.status)}`)
    return (await response.json()) as { ok: boolean; db?: string; docker?: string; version?: string }
  }

  /** 停 Hub：SIGTERM → 最多等 15s → SIGKILL */
  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.pid !== undefined) {
      child.kill('SIGTERM')
      const stopped = await waitFor(() => child.exitCode !== null, 15_000, 200)
      if (!stopped && child.pid !== undefined) {
        child.kill('SIGKILL')
        await waitFor(() => child.exitCode !== null, 5000, 200)
      }
      this.log(`Hub 已停止（exit ${String(child.exitCode)}）`)
    }
    rmSync(this.pidFile, { force: true })
    this.logStream?.end()
    this.logStream = null
  }

  /** Hub 日志尾巴（失败时写进产物） */
  logTail(lines = 120): string {
    return this.logLines.slice(-lines).join('\n')
  }

  /** 跑 CLI（`node apps/api/dist/cli.js …`），stdin 用来喂 `--password-stdin` */
  async cli(args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
    return runCommand('node', [CLI_ENTRY, ...args], {
      ...options,
      cwd: REPO_ROOT,
      env: { ...e2eEnv(this.dataDir), ...options.env },
    })
  }

  /** docker 子命令（只用于 e2e 自己的对象） */
  async docker(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
    return runCommand('docker', args, { timeoutMs })
  }

  /** 本网络的托管容器名单（清理与报告都用它；`--filter network=` 是 docker 原生过滤） */
  async listE2eContainers(): Promise<ContainerRecord[]> {
    const result = await this.docker([
      'ps',
      '-a',
      '--filter',
      `network=${USERS_NETWORK}`,
      '--filter',
      'label=dshhub.managed=1',
      '--format',
      '{{.Names}}\t{{.ID}}\t{{.Image}}\t{{.Status}}',
    ])
    if (result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = '', id = '', image = '', ...rest] = line.split('\t')
        return { name, id, image, status: rest.join('\t') }
      })
  }

  /**
   * 让 DB 里有**默认的 ready runtime**：调用 `cli runtime:adopt <版本> --default`（WP8b P1）登记本机
   * 已存在的 `dshhub/runtime:<版本>` 镜像——校验镜像存在 + 冒烟 `dsh --version`，**不重新构建**。
   *
   * WP8a 时主干没有这个入口，只能对 e2e 自己的数据库直接插一行（`seedDefaultRuntime`）；
   * 现在改走 CLI，顺带把「登记已有镜像」这条真实路径也跑一遍。
   */
  async adoptDefaultRuntime(): Promise<{ adopted: boolean; detail: string }> {
    const result = await this.cli(['runtime:adopt', DSH_VERSION, '--default'], { timeoutMs: 180_000 })
    const output = `${result.stdout}${result.stderr}`.trim()
    if (result.code !== 0) {
      return { adopted: false, detail: `runtime:adopt 失败（exit ${String(result.code)}）：${output}` }
    }
    return { adopted: true, detail: `已登记 ${RUNTIME_IMAGE} 为默认版本（cli runtime:adopt --default）` }
  }

  /** 按 slug 找本网络的容器名（容器名带前缀与否都能找到，J5/J7 用它做 docker exec） */
  async containerForSlug(slug: string): Promise<string | null> {
    const result = await this.docker([
      'ps',
      '-a',
      '--filter',
      `network=${USERS_NETWORK}`,
      '--filter',
      `label=dshhub.slug=${slug}`,
      '--format',
      '{{.Names}}',
    ])
    const name = result.stdout.trim().split('\n')[0]?.trim()
    return name && name.length > 0 ? name : null
  }

  /** 记下本次运行创建的容器（写进 result.json，作为「容器名清单兜底清理」的证据） */
  async recordContainers(): Promise<ContainerRecord[]> {
    const containers = await this.listE2eContainers()
    this.containerLog = containers
    return containers
  }

  containersSeen(): ContainerRecord[] {
    return this.containerLog
  }

  /**
   * 清理容器与网络：**只删挂在本 e2e 网络上的托管容器**，逐个二次确认（inspect 的网络名），
   * 然后删网络。禁止任何批量 prune（11 §2）。数据目录保留（任务书要求留最近一次排障）。
   */
  async cleanupContainers(): Promise<{ removed: string[]; network: string | null; notes: string[] }> {
    const removed: string[] = []
    const notes: string[] = []
    const containers = await this.listE2eContainers()
    for (const container of containers) {
      const inspect = await this.docker(['inspect', container.name, '--format', '{{json .NetworkSettings.Networks}}'])
      if (!inspect.stdout.includes(USERS_NETWORK)) {
        notes.push(`跳过 ${container.name}：不在 ${USERS_NETWORK} 上`)
        continue
      }
      const result = await this.docker(['rm', '-f', container.name], 60_000)
      if (result.code === 0) removed.push(container.name)
      else notes.push(`删除 ${container.name} 失败：${result.stderr.trim()}`)
    }
    let network: string | null = null
    const listed = await this.docker(['network', 'ls', '--filter', `name=^${USERS_NETWORK}$`, '--format', '{{.Name}}'])
    if (listed.stdout.trim() === USERS_NETWORK) {
      const result = await this.docker(['network', 'rm', USERS_NETWORK])
      if (result.code === 0) network = USERS_NETWORK
      else notes.push(`删除网络失败：${result.stderr.trim()}`)
    }
    this.containerLog = containers
    return { removed, network, notes }
  }

  /** 删除本次运行的数据目录（默认不删：保留最近一次用于排障） */
  async removeDataDir(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true })
  }

  /**
   * 构建产物是否比源码旧（只警告不阻塞）：源码改动后忘了 `pnpm -r build` 会白跑一轮。
   */
  static staleArtifacts(): boolean {
    try {
      const distTime = Math.min(statSync(API_ENTRY).mtimeMs, statSync(WEB_DIST_INDEX).mtimeMs)
      const srcTimes = [
        newestMtime(join(REPO_ROOT, 'apps', 'api', 'src')),
        newestMtime(join(REPO_ROOT, 'apps', 'web', 'src')),
        newestMtime(join(REPO_ROOT, 'packages', 'shared', 'src')),
      ]
      return Math.max(...srcTimes) > distTime
    } catch {
      return false
    }
  }

  /** 写一份本次运行的元信息（容器名单、日志路径）到数据目录 */
  writeRunMeta(extra: Record<string, unknown>): void {
    const file = join(this.dataDir, 'run-meta.json')
    const payload = {
      runId: this.runId,
      dataDir: this.dataDir,
      hubLog: this.logFile,
      httpPort: HTTP_PORT,
      network: USERS_NETWORK,
      subnet: USERS_SUBNET,
      dshVersion: DSH_VERSION,
      containers: this.containerLog,
      ...extra,
    }
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}

function newestMtime(dir: string): number {
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs)
        } catch {
          // 忽略
        }
      }
    }
  }
  return newest
}

/** run-id 形状（`20261013-010216-4pi5`）：清理残留 PID 文件时用它筛目录 */
const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/

/** 端口是否已被占用（TCP 连得上就算占用） */
export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (busy: boolean): void => {
      socket.destroy()
      resolve(busy)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 轮询等待条件成立（真容器冷启动、导出完成都用它） */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return true
    if (Date.now() > deadline) return false
    await sleep(intervalMs)
  }
}

/** 跑 `docker exec`（J5 往工作区写文件用），默认 uid 1000:1000 */
export async function dockerExec(
  container: string,
  argv: string[],
  options: { user?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const args = ['exec', '-u', options.user ?? '1000:1000', container, ...argv]
  const result = await runCommand('docker', args, { timeoutMs: options.timeoutMs ?? 60_000 })
  return result
}
