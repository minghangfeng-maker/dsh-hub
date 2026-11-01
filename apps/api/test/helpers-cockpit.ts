import Fastify, { type FastifyInstance } from 'fastify'
import type { ProposalStatus, ProposalView } from '@dsh-hub/shared'
import type { CapabilityRegistry } from '../src/modules/cockpit/capabilities/types.js'
import { createCockpitService } from '../src/modules/cockpit/service.js'
import { FakeOpsInstanceProbe, type FakeOpsInstanceProbeOptions } from '../src/modules/cockpit/ops-probe.js'
import { registerCockpitOpsRoutes } from '../src/modules/cockpit/index.js'
import { createTestApp, createUser, type TestApp, type TestSession, type TestUser } from './helpers.js'
import { adminSession, nextIp } from './wp1-helpers.js'

/**
 * 座舱测试脚手架（WP56a）。
 *
 * 三件套：
 * - `FakeOpsInstanceProbe`（固定令牌 + 固定来源 IP），在 `buildApp` **之前**建好注入；
 * - `hub-ops` 系统账号（直接写库，`is_system=1`）—— R1 自动执行的审计 actor；
 * - `/ops/*` 挂在一个**独立 Fastify 实例**上（与生产一样由 `registerCockpitOpsRoutes` 注册），
 *   用 `inject({ remoteAddress })` 模拟「来源 IP 是座舱容器」。
 */
export const OPS_TOKEN = 'ops-test-token-0123456789abcdef'
export const OPS_IP = '10.219.60.2'

export interface CockpitHarness {
  ctx: TestApp
  app: FastifyInstance
  ops: FastifyInstance
  probe: FakeOpsInstanceProbe
  admin: TestSession
  hubOps: TestUser
  close(): Promise<void>
}

export async function createCockpitHarness(
  options: {
    probe?: Partial<FakeOpsInstanceProbeOptions>
    /** 额外的环境变量（WP56f：能力测试要点假 npm 源 / 假上游时用） */
    env?: Record<string, string>
  } = {},
): Promise<CockpitHarness> {
  const probe = new FakeOpsInstanceProbe({
    token: OPS_TOKEN,
    ip: OPS_IP,
    instance: 'running',
    model: 'deepseek-v4.1-flash',
    ...options.probe,
  })
  const ctx = await createTestApp({
    opsProbe: probe,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const hubOps = await createUser(ctx.app, { username: 'hub-ops', displayName: '座舱 DSH' })
  ctx.app.deps.db.run('UPDATE users SET is_system = 1 WHERE id = ?', hubOps.id)
  probe.opsUserId = hubOps.id
  const admin = await adminSession(ctx.app, 'cockpit-admin')

  const ops = Fastify({ logger: false })
  registerCockpitOpsRoutes(ops, ctx.app.deps)
  await ops.ready()

  return {
    ctx,
    app: ctx.app,
    ops,
    probe,
    admin,
    hubOps,
    async close() {
      await ops.close()
      await ctx.close()
    },
  }
}

export interface OpsInjectOptions {
  /** 省略 = 用固定令牌；传 `null` = 不带 Authorization */
  token?: string | null
  ip?: string
  payload?: unknown
}

/** 调 `/ops/*`（`url` 写 `/call` 这样，前缀自动补） */
export async function opsInject(
  harness: CockpitHarness,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: OpsInjectOptions = {},
) {
  const headers: Record<string, string> = {}
  const token = options.token === undefined ? OPS_TOKEN : options.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (options.payload !== undefined) headers['content-type'] = 'application/json'
  return harness.ops.inject({
    method,
    url: `/ops${url}`,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
    remoteAddress: options.ip ?? OPS_IP,
  })
}

/** 管理员调 `/api/admin/cockpit/*`（cookie + Origin 已带） */
export async function adminInject(
  harness: CockpitHarness,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return harness.app.inject({
    method,
    url: `/api/admin/cockpit${url}`,
    headers: { ...harness.admin.headers, ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    remoteAddress: nextIp(),
  })
}

/** 管理员重新输密码（R3 方案批准、改 autoExecuteR1 需要） */
export async function reauth(harness: CockpitHarness): Promise<void> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/reauth',
    headers: harness.admin.headers,
    payload: JSON.stringify({ password: harness.admin.user.password }),
    remoteAddress: nextIp(),
  })
  if (res.statusCode !== 204) throw new Error(`reauth 失败：${String(res.statusCode)} ${res.body}`)
}

export function jsonOf<T = unknown>(res: { body: string }): T {
  return JSON.parse(res.body) as T
}

/** 等方案跑完（`running`/`pending` 之外的状态），默认 5 秒超时 */
export async function waitProposalSettled(
  harness: CockpitHarness,
  id: number,
  timeoutMs = 5_000,
): Promise<ProposalView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = harness.app.deps.services.cockpit.getProposal(id)
    if (view.status !== 'pending' && view.status !== 'running') return view
    if (Date.now() > deadline) throw new Error(`方案 ${String(id)} 在 ${String(timeoutMs)}ms 内没有结束`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function proposalRowStatus(harness: CockpitHarness, id: number): ProposalStatus {
  const row = harness.app.deps.db.get<{ status: ProposalStatus }>(
    'SELECT status FROM cockpit_proposals WHERE id = ?',
    id,
  )
  if (!row) throw new Error(`方案 ${String(id)} 不存在`)
  return row.status
}

/** 用注入的能力注册表另建一个座舱 service（测夹具能力/密钥流程；与 app 共用同一份 deps） */
export function createHarnessService(harness: CockpitHarness, registry: CapabilityRegistry) {
  return createCockpitService({ deps: harness.app.deps, probe: harness.probe, registry })
}
