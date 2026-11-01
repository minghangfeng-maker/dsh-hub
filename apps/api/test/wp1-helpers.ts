import type { FastifyInstance } from 'fastify'
import { json, loginAs, type TestSession } from './helpers.js'

/**
 * WP1 测试辅助（新建文件，避免与其它包改同一个 helpers.ts）。
 *
 * 两个关键点：
 * - 注册/登录都有限流（02 §5），同一个 app 实例里从同一个 IP 打多次会被 429；
 *   所以默认给每个请求换一个 `remoteAddress`，要测限流的用例显式传同一个 IP。
 * - 管理端接口需要 admin 会话，`createUser` + `loginAs` 直接造（不依赖注册接口）。
 */

export const TEST_ORIGIN = 'http://127.0.0.1:7701'

let ipCounter = 0

/** 每次调用给一个不同的文档网段 IP（198.51.100.0/24 是 RFC 5737 测试网段） */
export function nextIp(): string {
  ipCounter += 1
  return `198.51.100.${(ipCounter % 250) + 1}`
}

/** 固定的客户端 IP（测限流用） */
export const FIXED_IP = '203.0.113.7'

export function jsonHeaders(app: FastifyInstance, ip?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: app.deps.config.publicOrigin,
    ...(ip ? { 'x-test-ip': ip } : {}),
  }
}

export interface InjectOptions {
  ip?: string
  headers?: Record<string, string>
}

/** POST JSON（带 Origin，绕过 CSRF 钩子） */
export async function postJson(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  opts: InjectOptions = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...jsonHeaders(app), ...opts.headers },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    remoteAddress: opts.ip ?? nextIp(),
  })
}

export async function patchJson(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  opts: InjectOptions = {},
) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: { ...jsonHeaders(app), ...opts.headers },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    remoteAddress: opts.ip ?? nextIp(),
  })
}

export async function getJson(app: FastifyInstance, url: string, opts: InjectOptions = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: { origin: app.deps.config.publicOrigin, ...opts.headers },
    remoteAddress: opts.ip ?? nextIp(),
  })
}

export async function deleteJson(app: FastifyInstance, url: string, opts: InjectOptions = {}) {
  return app.inject({
    method: 'DELETE',
    url,
    headers: { origin: app.deps.config.publicOrigin, ...opts.headers },
    remoteAddress: opts.ip ?? nextIp(),
  })
}

export interface RegisterInput {
  username: string
  password?: string
  displayName?: string
  inviteCode?: string
  ip?: string
}

/** 走真实注册接口；默认密码满足强度要求 */
export async function register(
  app: FastifyInstance,
  input: RegisterInput,
): Promise<{ statusCode: number; body: Record<string, unknown>; setCookie: string | undefined }> {
  const res = await postJson(
    app,
    '/api/auth/register',
    {
      username: input.username,
      password: input.password ?? 'Str0ng-pass-1',
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
    },
    { ip: input.ip },
  )
  return {
    statusCode: res.statusCode,
    body: json<Record<string, unknown>>(res),
    setCookie: res.headers['set-cookie'] as string | undefined,
  }
}

export function errorCode(body: unknown): string | undefined {
  const candidate = body as { error?: { code?: string } }
  return candidate?.error?.code
}

/** 造一个 admin 会话（`createUser` 直写库 + `loginAs` 直建会话） */
export async function adminSession(app: FastifyInstance, username = 'wp1-admin'): Promise<TestSession> {
  const { createUser } = await import('./helpers.js')
  const admin = await createUser(app, { username, role: 'admin' })
  return loginAs(app, admin, { userAgent: 'vitest-admin' })
}

/** 通过管理端接口建邀请码，返回码值列表 */
export async function createInvites(
  app: FastifyInstance,
  admin: TestSession,
  input: { count?: number; maxUses?: number; expiresAt?: string | null; note?: string } = {},
): Promise<{ id: number; code: string }[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/invites',
    headers: admin.headers,
    payload: JSON.stringify({ count: input.count ?? 1, maxUses: input.maxUses ?? 1, ...input, count2: undefined }),
  })
  if (res.statusCode !== 201) throw new Error(`建邀请码失败：${res.statusCode} ${res.body}`)
  const body = json<{ items: { id: number; code: string }[] }>(res)
  return body.items.map((item) => ({ id: item.id, code: item.code }))
}

// ── 图片字节（只要魔数对，服务端就认） ───────────────────────────────────────

export function pngBytes(extra = 64): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 1)])
}

export function jpegBytes(extra = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 2)])
}

export function webpBytes(extra = 64): Buffer {
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(extra + 4, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, Buffer.alloc(extra, 3)])
}

export function htmlBytes(): Buffer {
  return Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8')
}

export interface MultipartPayload {
  payload: Buffer
  headers: Record<string, string>
}

/** 手搓 multipart 请求体（不引依赖，且能精确控制文件名/MIME 来测伪造） */
export function multipart(
  data: Buffer,
  opts: { field?: string; filename?: string; contentType?: string; boundary?: string } = {},
): MultipartPayload {
  const boundary = opts.boundary ?? '----dshhubwp1test'
  const field = opts.field ?? 'file'
  const filename = opts.filename ?? 'avatar.png'
  const contentType = opts.contentType ?? 'image/png'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-hub-csrf': '1',
    },
  }
}
