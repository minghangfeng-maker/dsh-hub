import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { ApiClient, describeApi, type ApiResult } from './api.js'
import { ConsoleCollector, newContext, saveFailureArtifacts, screenshot, type ConsoleIssue } from './browser.js'
import { PUBLIC_ORIGIN, SHOTS_DIR, USER_A, USER_B, ADMIN_PASSWORD, ADMIN_USERNAME } from './config.js'
import type { HubHarness } from './harness.js'

/** 三个会话身份：管理员、用户 A（主旅程）、用户 B（越权隔离用） */
export type Role = 'admin' | 'A' | 'B'

export interface UserState {
  username: string
  password: string
  displayName: string
  slug?: string
  userId?: number
  containerName?: string
}

export interface WorldState {
  runId: string
  admin: { username: string; password: string; userId?: number }
  users: { A?: UserState; B?: UserState }
  /** 邀请码（J2 生成，失败用例与 B 的注册复用） */
  invites: { A?: string; B?: string }
  /** 最近一次导出（J6 记录，供报告与重跑用） */
  export?: { id: number; sha256: string | null; fileName: string; bytes: number }
  notes: string[]
}

export interface AssertionResult {
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail?: string
}

export interface JourneyResult {
  id: string
  title: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  assertions: AssertionResult[]
  error?: string
  screenshots: string[]
  artifacts: string[]
  notes: string[]
}

/** 一条旅程（`tests/J*.ts` 的默认导出） */
export interface Journey {
  id: string
  title: string
  /** 依赖说明（只用于 `--list` 与报告，不做自动跳过） */
  dependsOn?: string
  /** 需要干净数据库（CLI 建管理员、邀请码注册）：`--only` 时不能复用上一次的数据目录 */
  needsFreshData?: boolean
  timeoutMs?: number
  run(ctx: JourneyContext): Promise<void>
}

/** 旅程内部用来「中止但记失败」的错误；runner 会把它当成普通失败 */
export class JourneyFailure extends Error {}

/** 用来标记整条旅程 skipped（依赖未合并等） */
export class JourneySkip extends Error {}

interface RoleSession {
  context: BrowserContext
  collector: ConsoleCollector
  page: Page | null
}

/**
 * 跨旅程共享的世界状态：浏览器上下文（会话 cookie 天然保持登录）、
 * 已注册用户的凭据与 slug、运行中产生的 id。落盘到 `.data/<run-id>/state.json`，
 * 这样 `--only J3` 之类的单条重跑也能接上。
 */
export class World {
  readonly state: WorldState
  private readonly sessions = new Map<Role, RoleSession>()
  private readonly stateFile: string

  constructor(
    private readonly browser: Browser,
    runId: string,
    private readonly runDir: string,
  ) {
    this.stateFile = join(runDir, 'state.json')
    this.state = loadState(this.stateFile) ?? {
      runId,
      admin: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      users: {
        A: { ...USER_A },
        B: { ...USER_B },
      },
      invites: {},
      notes: [],
    }
    this.state.runId = runId
  }

  save(): void {
    mkdirSync(this.runDir, { recursive: true })
    writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
  }

  note(text: string): void {
    this.state.notes.push(text)
  }

  private async session(role: Role): Promise<RoleSession> {
    const existing = this.sessions.get(role)
    if (existing) return existing
    const { context, collector } = await newContext(this.browser, { trackWebSockets: role !== 'admin' })
    const session: RoleSession = { context, collector, page: null }
    this.sessions.set(role, session)
    return session
  }

  async contextFor(role: Role): Promise<BrowserContext> {
    return (await this.session(role)).context
  }

  collectorFor(role: Role): ConsoleCollector {
    const session = this.sessions.get(role)
    if (!session) throw new Error(`角色 ${role} 的上下文还没创建`)
    return session.collector
  }

  async apiFor(role: Role): Promise<ApiClient> {
    const context = await this.contextFor(role)
    return new ApiClient(context.request, PUBLIC_ORIGIN)
  }

  /** 该角色的常驻页面（同一个上下文里的第一个页面；DSH 新标签不在其中） */
  async pageFor(role: Role): Promise<Page> {
    const session = await this.session(role)
    if (session.page && !session.page.isClosed()) return session.page
    const page = await session.context.newPage()
    session.page = page
    return page
  }

  credentials(role: Role): { username: string; password: string } {
    if (role === 'admin') return this.state.admin
    const user = this.state.users[role]
    if (!user) throw new Error(`用户 ${role} 的凭据还没准备好`)
    return { username: user.username, password: user.password }
  }

  /**
   * 确保该角色已登录：先看 `/api/auth/me`，未登录就用凭据 POST login。
   * （界面登录只在 J1 里做一次——那是 J1 要验证的行为；其余旅程复用会话更稳。）
   */
  async ensureLogin(role: Role): Promise<void> {
    const api = await this.apiFor(role)
    const me = await api.get('/api/auth/me')
    if (me.status === 200) return
    const { username, password } = this.credentials(role)
    const login = await api.post('/api/auth/login', { username, password, remember: true })
    if (!login.ok) {
      throw new JourneyFailure(
        `以 ${role}（${username}）登录失败：${describeApi(login)}` +
          '（该账号是否还没创建？J1 建管理员、J2 建用户 A —— 单跑后续旅程前要先跑过它们）',
      )
    }
  }

  /** 关掉该角色上下文里除常驻页之外的标签（例如 J3 打开的 DSH 页） */
  async closeExtraPages(role: Role): Promise<number> {
    const session = this.sessions.get(role)
    if (!session) return 0
    let closed = 0
    for (const page of session.context.pages()) {
      if (page === session.page || page.isClosed()) continue
      await page.close().catch(() => undefined)
      closed += 1
    }
    return closed
  }

  /** 把用户 id/slug 之类回写到世界状态 */
  patchUser(role: Exclude<Role, 'admin'>, patch: Partial<UserState>): void {
    const current = this.state.users[role] ?? { ...(role === 'A' ? USER_A : USER_B) }
    this.state.users[role] = { ...current, ...patch }
    this.save()
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.context.close().catch(() => undefined)
    }
    this.sessions.clear()
  }
}

function loadState(file: string): WorldState | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WorldState
  } catch {
    return null
  }
}

export const SHOTS = SHOTS_DIR

/**
 * WP3（插件/版本/模型）未合并时前端必然拿 404 的接口。
 * 只在探测确认 WP3 未合并时才放行（见 `checkConsoleClean`）。
 */
export const WP3_GAP_HTTP: { status: number; pathIncludes: string }[] = [
  { status: 404, pathIncludes: '/api/me/plugins' },
  { status: 404, pathIncludes: '/api/admin/plugins' },
  { status: 404, pathIncludes: '/api/admin/runtimes' },
  { status: 404, pathIncludes: '/api/admin/models' },
  { status: 404, pathIncludes: '/api/admin/rollouts' },
  { status: 501, pathIncludes: '/api/admin/plugins' },
  { status: 501, pathIncludes: '/api/me/plugins' },
]

/**
 * 一条旅程的运行上下文：断言记录 + 截图 + 失败产物 + 常用便捷方法。
 */
export class JourneyContext {
  readonly assertions: AssertionResult[] = []
  readonly screenshots: string[] = []
  readonly artifacts: string[] = []
  readonly notes: string[] = []
  /** 当前旅程的失败产物目录 */
  readonly artifactDir: string
  /** 旅程里用过的页面（失败时抓最后一个） */
  private activePages: Page[] = []
  /** WP3 是否已合并（探测一次） */
  private wp3State: boolean | undefined

  constructor(
    readonly journeyId: string,
    readonly hub: HubHarness,
    readonly world: World,
    readonly browser: Browser,
    readonly runDir: string,
  ) {
    this.artifactDir = join(runDir, 'artifacts', journeyId)
  }

  log(message: string): void {
    process.stdout.write(`      · ${message}\n`)
  }

  note(message: string): void {
    this.notes.push(message)
    process.stdout.write(`      · ${message}\n`)
  }

  /** 记录一条通过的断言 */
  pass(name: string, detail?: string): void {
    this.assertions.push({ name, status: 'pass', detail })
    process.stdout.write(`      ✓ ${name}${detail ? `（${detail}）` : ''}\n`)
  }

  /** 记录失败但继续（尽量多收集证据） */
  fail(name: string, detail?: string): void {
    this.assertions.push({ name, status: 'fail', detail })
    process.stdout.write(`      ✗ ${name}${detail ? `（${detail}）` : ''}\n`)
  }

  skip(name: string, reason: string): void {
    this.assertions.push({ name, status: 'skip', detail: reason })
    process.stdout.write(`      - ${name}（跳过：${reason}）\n`)
  }

  /** 断言 + 不中止 */
  expect(name: string, condition: boolean, detail?: string): boolean {
    if (condition) this.pass(name, detail)
    else this.fail(name, detail)
    return condition
  }

  /** 断言失败即中止本旅程（后续断言记 skip） */
  require(name: string, condition: unknown, detail?: string): boolean {
    if (condition) {
      this.pass(name, detail)
      return true
    }
    this.fail(name, detail)
    throw new JourneyFailure(`${name}${detail ? `：${detail}` : ''}`)
  }

  /** 断言「值存在」并把它返回给调用方（需要类型收窄时用它，等价于 require 后返回值） */
  requireDefined<T>(name: string, value: T | null | undefined, detail?: string): T {
    if (value === null || value === undefined) {
      this.fail(name, detail)
      throw new JourneyFailure(`${name}${detail ? `：${detail}` : ''}`)
    }
    this.pass(name, detail)
    return value
  }

  /** 跑一段检查逻辑，抛错即记为失败（不中止） */
  async check(name: string, fn: () => Promise<void> | void): Promise<boolean> {
    try {
      await fn()
      this.pass(name)
      return true
    } catch (error) {
      this.fail(name, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** 断言接口成功（2xx），失败时把状态码与错误码带进详情 */
  requireOk(name: string, result: ApiResult): void {
    this.require(name, result.ok, result.ok ? undefined : describeApi(result))
  }

  /** 关键步骤截图（写到 e2e/.data/shots/） */
  async shot(page: Page, name: string, fullPage = false): Promise<string> {
    this.trackPage(page)
    const file = await screenshot(page, SHOTS, name, fullPage)
    this.screenshots.push(file)
    this.log(`截图 ${file.replace(`${process.cwd()}/`, '')}`)
    return file
  }

  /** 最近一次用过的页面（失败产物要抓它） */
  lastPage(): Page | null {
    return this.activePages[this.activePages.length - 1] ?? null
  }

  private trackPage(page: Page): void {
    this.activePages = this.activePages.filter((item) => !item.isClosed() && item !== page)
    this.activePages.push(page)
  }

  /** 失败产物：页面 HTML、console、Hub 日志尾巴 */
  async captureFailure(page: Page | null, error: unknown, collector?: ConsoleCollector): Promise<void> {
    const files = await saveFailureArtifacts(page, this.artifactDir, {
      error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
      consoleText: collector?.dump() ?? '（无收集器）',
      hubTail: this.hub.logTail(160),
    })
    this.artifacts.push(...files)
  }

  consoleIssues(role: Role): ConsoleIssue[] {
    return this.world.collectorFor(role).errors()
  }

  /**
   * WP3（插件/版本/模型）是否已合并。未合并时前端仍会调 `/api/me/plugins` 之类的接口，
   * 拿到 404 —— 这是「依赖未合并」而不是产品缺陷，允许但不隐藏（记一条 skip）。
   */
  async wp3Merged(): Promise<boolean> {
    if (this.wp3State === undefined) {
      const api = await this.api('admin')
      const probe = await api.get('/api/admin/plugins')
      this.wp3State = probe.status !== 404 && probe.status !== 501
      this.note(`WP3（插件/模型）探测：GET /api/admin/plugins → ${String(probe.status)}（${this.wp3State ? '已合并' : '未合并'}）`)
    }
    return this.wp3State
  }

  /**
   * 一条旅程的 console 体检：0 个 JS error + 没有预期外的 4xx/5xx。
   * `httpAllowed` 用来放行设计内的探测失败（例如登录前的 `/api/auth/me` 401）。
   */
  async checkConsoleClean(
    role: Role,
    label: string,
    httpAllowed: { status: number; pathIncludes: string }[] = [],
  ): Promise<void> {
    const collector = this.world.collectorFor(role)
    const jsErrors = collector.errors()
    this.expect(
      `${label}：0 个 JS console error / 未捕获异常`,
      jsErrors.length === 0,
      jsErrors.map((issue) => `[${issue.kind}] ${issue.text} @ ${issue.url ?? ''}`).join(' | ').slice(0, 500),
    )

    const wp3Merged = await this.wp3Merged()
    const allowed = [...httpAllowed, ...(wp3Merged ? [] : WP3_GAP_HTTP)]
    const gapHits = collector
      .httpErrors()
      .filter((issue) => WP3_GAP_HTTP.some((rule) => rule.status === issue.status && (issue.url ?? '').includes(rule.pathIncludes)))
    const unexpected = collector.unexpectedHttpErrors(allowed)
    if (gapHits.length > 0) {
      this.skip(
        'WP3 未合并导致的接口 404（不计为缺陷）',
        gapHits.map((issue) => `${String(issue.status)} ${(issue.url ?? '').replace(PUBLIC_ORIGIN, '')}`).join('、'),
      )
    }
    this.expect(
      `${label}：没有预期外的 4xx/5xx 响应`,
      unexpected.length === 0,
      unexpected.map((issue) => `${String(issue.status)} ${issue.url ?? ''}`).join(' | ').slice(0, 400),
    )
    const summary = collector
      .httpErrors()
      .map((issue) => `${String(issue.status)} ${(issue.url ?? '').replace(PUBLIC_ORIGIN, '')}`)
      .join('、')
    this.note(`${label}：JS error ${String(jsErrors.length)} 条、4xx/5xx ${String(collector.httpErrors().length)} 条（${summary || '无'}）`)
  }

  /** 页面冲到站内路径（相对 baseUrl） */
  async goto(page: Page, path: string): Promise<void> {
    await page.goto(`${PUBLIC_ORIGIN}${path}`, { waitUntil: 'domcontentloaded' })
  }

  async api(role: Role): Promise<ApiClient> {
    await this.world.ensureLogin(role)
    return this.world.apiFor(role)
  }

  async page(role: Role): Promise<Page> {
    await this.world.ensureLogin(role)
    const page = await this.world.pageFor(role)
    this.trackPage(page)
    return page
  }
}
