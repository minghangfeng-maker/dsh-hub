import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Role, UserStatus } from '@dsh-hub/shared'
import { buildApp } from '../src/app.js'
import { loadConfig, type HubConfig } from '../src/config.js'
import { createTestClock, type TestClock } from '../src/lib/clock.js'
import { randomToken } from '../src/lib/crypto.js'
import { newSlug } from '../src/lib/ids.js'
import { hashPassword } from '../src/lib/password.js'
import { createSession } from '../src/lib/session.js'
import { FakeOpsInstanceProbe } from '../src/modules/cockpit/ops-probe.js'
import { FakeDriver } from '../src/modules/instances/fake-driver.js'

/**
 * 测试脚手架（任务书 §3）：临时 HUB_DATA_DIR + FakeDriver + 可控时钟，
 * 直接写库造用户，直接建会话拿 cookie（WP1 的登录接口就绪后可以改成真登录）。
 */
export interface TestApp {
  app: FastifyInstance
  driver: FakeDriver | null
  clock: TestClock
  config: HubConfig
  dataDir: string
  close(): Promise<void>
}

export interface CreateTestAppOptions {
  clock?: TestClock
  /** `null` = 不注入，交给 buildApp 按 HUB_CONTAINER_DRIVER 造（用于测 docker 不可用） */
  driver?: FakeDriver | null
  /** 覆盖任意环境变量（会与测试默认值合并） */
  env?: Record<string, string>
  /** 座舱容器探针（WP56a）：不传就是「容器尚未装配」的安全默认，`/ops/*` 一律 401 */
  opsProbe?: FakeOpsInstanceProbe
}

let tempCounter = 0

export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<TestApp> {
  tempCounter += 1
  const dataDir = mkdtempSync(join(tmpdir(), `dshhub-test-wp0a-${process.pid}-${tempCounter}-`))
  const clock = opts.clock ?? createTestClock()
  const config = loadConfig({
    HUB_DATA_DIR: dataDir,
    HUB_CONTAINER_DRIVER: 'fake',
    HUB_PUBLIC_ORIGIN: 'http://127.0.0.1:7701',
    HUB_LOG_LEVEL: 'silent',
    // WP49/WP50：测试默认不探测真实的本机语音服务（否则本机恰好跑着 dsh-asr / seki-voice 时
    // bootstrap.voice 会随环境变化）；需要测 ASR/TTS 的用例显式覆盖 HUB_ASR_*/HUB_TTS_*。
    HUB_ASR_ENABLED: 'false',
    HUB_TTS_ENABLED: 'false',
    ...opts.env,
  })
  // 环境标识跟随配置：不然测试里 service 建的容器（带 dshhub.env）会被驱动的
  // listManaged 过滤掉，对账/回收看起来「什么都没做」
  const driver: FakeDriver | null =
    opts.driver === undefined ? new FakeDriver({ clock, envId: config.envId }) : opts.driver
  const app = await buildApp({
    config,
    testing: true,
    driver: driver ?? undefined,
    clock,
    ...(opts.opsProbe === undefined ? {} : { opsProbe: opts.opsProbe }),
  })
  return {
    app,
    driver,
    clock,
    config,
    dataDir,
    async close() {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ── 用户与会话 ──────────────────────────────────────────────────────────────

export interface TestUser {
  id: number
  slug: string
  username: string
  password: string
  displayName: string
  role: Role
  status: UserStatus
  mustChangePassword: boolean
}

export interface CreateUserOptions {
  username?: string
  password?: string
  displayName?: string
  role?: Role
  status?: UserStatus
  mustChangePassword?: boolean
  /** 直接给配额 JSON（测试配额逻辑） */
  quotaJson?: string | null
}

let userCounter = 0

/** 直接写库造用户（不经过注册接口，避免测试依赖 WP1 的实现进度） */
export async function createUser(app: FastifyInstance, opts: CreateUserOptions = {}): Promise<TestUser> {
  userCounter += 1
  const username = opts.username ?? `user${userCounter}`
  const password = opts.password ?? 'test-password-1'
  const slug = newSlug()
  const now = app.deps.clock.nowIso()
  const result = app.deps.db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                        must_change_password, quota_json, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    username,
    opts.displayName ?? username,
    hashPassword(password),
    opts.role ?? 'user',
    opts.status ?? 'active',
    opts.mustChangePassword ? 1 : 0,
    opts.quotaJson ?? null,
    now,
    now,
  )
  return {
    id: result.lastInsertRowid,
    slug,
    username,
    password,
    displayName: opts.displayName ?? username,
    role: opts.role ?? 'user',
    status: opts.status ?? 'active',
    mustChangePassword: opts.mustChangePassword ?? false,
  }
}

export interface TestSession {
  user: TestUser
  token: string
  sessionId: string
  /** `hub_sid=<token>`，直接放进请求头 */
  cookie: string
  /** 与 `HUB_PUBLIC_ORIGIN` 一致的 Origin（CSRF 校验用） */
  origin: string
  /** cookie + origin + JSON content-type，直接给 `app.inject({ headers })` */
  headers: Record<string, string>
}

/** 直接建会话并返回带 cookie 的请求头（等价于「已登录」） */
export function loginAs(
  app: FastifyInstance,
  user: TestUser,
  opts: { remember?: boolean; ip?: string; userAgent?: string } = {},
): TestSession {
  const token = randomToken(32)
  const { id, expiresAt } = createSession(app.deps.db, {
    userId: user.id,
    token,
    now: app.deps.clock.nowIso(),
    ip: opts.ip ?? '127.0.0.1',
    userAgent: opts.userAgent ?? 'vitest',
    isAdmin: user.role === 'admin',
    adminSessionHours: app.deps.settings.get('security').adminSessionHours,
  })
  const cookie = `hub_sid=${token}`
  const origin = app.deps.config.publicOrigin
  void expiresAt
  return {
    user,
    token,
    sessionId: id,
    cookie,
    origin,
    headers: { cookie, origin, 'content-type': 'application/json' },
  }
}

/** 解析注入响应体（测试里几乎每条断言都要用） */
export function json<T = unknown>(res: { body: string }): T {
  return JSON.parse(res.body) as T
}

/** 在已有会话头上补充字段（例如 multipart 的 X-Hub-Csrf） */
export function withHeaders(session: TestSession, extra: Record<string, string>): Record<string, string> {
  return { ...session.headers, ...extra }
}
