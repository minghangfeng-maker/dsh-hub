import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  createTestApp,
  createUser,
  loginAs,
  withHeaders,
  type TestApp,
  type TestSession,
} from './helpers.js'
import { deviceHeaders, loginDesktop, reportBody } from './helpers-desktop.js'
import { makeTarGz } from './helpers-wp3.js'
import { multipart } from './wp1-helpers.js'
import {
  artifactSignaturePayload,
  desktopArtifactSigningKey,
  isArtifactSignatureShape,
  signArtifact,
  verifyArtifactSignature,
} from '../src/modules/desktop-delivery/index.js'

/**
 * WP31：桌面插件整包下载的**签名地址**（真链路：路由 → service → SQLite → 磁盘）。
 *
 * 缺陷背景：桌面端取整包是 `fetch(artifact.url)`（不带任何头），下载接口只认 Bearer → 401。
 * 本文件钉住：
 *   1. 清单里的 `artifact.url` 带每设备签名，**原样、不带任何头**就能下载，sha256 与清单一致；
 *   2. 签名确定（同输入同输出）、ETag 稳定（内容不变就不抖）；
 *   3. 错签 / 改包名 / 改版本 / 改设备 id / 无签名 / 无令牌 → 401；
 *   4. 设备吊销、撤回下发、用户停用后，同一 URL 立即 401；
 *   5. 别的设备的签名下不了这台设备的包（签名绑定 deviceId，且必须在它的当前清单里）；
 *   6. Bearer 路径不受影响；`/api/desktop/*` 其余端点无令牌仍 401（回归）。
 */

const SIGNING_KEY_BYTES = 32

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

interface Device {
  token: string
  deviceId: string
}

interface Context {
  ctx: TestApp
  admin: TestSession
  user: TestSession
  userId: number
  first: Device
  other: Device
}

async function setup(): Promise<Context> {
  const ctx = await createTestApp({ env: { HUB_PUBLIC_ORIGIN: 'https://hub.test' } })
  const adminUser = await createUser(ctx.app, { role: 'admin' })
  const user = await createUser(ctx.app)
  const admin = loginAs(ctx.app, adminUser)
  const userSession = loginAs(ctx.app, user)
  const first = await loginDesktop(ctx.app, userSession, { name: 'WP31 设备一' })
  // 「别台设备」用**管理员**的机器：它拿不到发给普通用户的下发（不是同一个用户、也不是同一个角色）
  const other = await loginDesktop(ctx.app, admin, { name: 'WP31 管理员设备' })
  return {
    ctx,
    admin,
    user: userSession,
    userId: user.id,
    first: { token: first.token, deviceId: first.deviceId },
    other: { token: other.token, deviceId: other.deviceId },
  }
}

function seedPlugin(
  app: FastifyInstance,
  input: { packageName: string; version: string; policy?: 'required' | 'default' | 'optional' },
): { pluginId: number; versionId: number } {
  const now = app.deps.clock.nowIso()
  const plugin = app.deps.db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, ?, 1, 100, '', 1, ?, ?)`,
    input.packageName,
    input.packageName,
    input.policy ?? 'default',
    now,
    now,
  )
  const version = app.deps.db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, 'upload', ?, ?, NULL, NULL, NULL, ?)`,
    plugin.lastInsertRowid,
    input.version,
    `${input.packageName}@${input.version}`,
    input.version,
    now,
  )
  return { pluginId: plugin.lastInsertRowid, versionId: version.lastInsertRowid }
}

function pluginPackage(packageName: string, version: string): Buffer {
  return makeTarGz([
    {
      name: 'package/package.json',
      content: `${JSON.stringify({ name: packageName, version, dsh: { bundle: { patch: 'cordis.patch.yml' } } }, null, 2)}\n`,
    },
    { name: 'package/cordis.patch.yml', content: '- id: wp31-sign-test\n  config:\n    a: 1\n' },
    { name: 'package/LICENSE', content: 'MIT\n' },
  ])
}

interface Delivered {
  pluginId: number
  versionId: number
  packageName: string
  version: string
  payload: Buffer
  /** 清单里原样给出的取件地址 */
  url: string
  /** 只取 path + query（app.inject 用） */
  path: string
}

/** 上传整包 → 只下发给这台设备所属用户 → 拉清单拿签名地址 */
async function deliverToDevice(
  context: Context,
  options: { packageName?: string; version?: string } = {},
): Promise<Delivered> {
  const packageName = options.packageName ?? '@local/wp31-signed'
  const version = options.version ?? '0.1.0'
  const { pluginId, versionId } = seedPlugin(context.ctx.app, { packageName, version })
  const payload = pluginPackage(packageName, version)
  const form = multipart(payload, { filename: 'wp31-signed.tgz', contentType: 'application/gzip' })
  const uploaded = await context.ctx.app.inject({
    method: 'POST',
    url: `/api/admin/desktop/plugins/${String(pluginId)}/versions/${String(versionId)}/package`,
    payload: form.payload,
    headers: withHeaders(context.admin, form.headers),
  })
  if (uploaded.statusCode !== 201) throw new Error(`上传整包失败：${uploaded.body}`)

  const delivered = await context.ctx.app.inject({
    method: 'PUT',
    url: '/api/admin/desktop/plugins',
    payload: { target: { scope: 'user', userId: context.userId }, pluginId, versionId, enabled: true },
    headers: context.admin.headers,
  })
  if (delivered.statusCode !== 200) throw new Error(`下发失败：${delivered.body}`)

  const manifest = await getManifest(context.ctx.app, context.first.token)
  const plugins = manifest['plugins'] as Record<string, unknown>[]
  const plugin = plugins.find((entry) => entry['name'] === packageName)
  if (!plugin) throw new Error(`清单里没有 ${packageName}：${JSON.stringify(manifest)}`)
  const url = String((plugin['artifact'] as Record<string, unknown>)['url'])
  const parsed = new URL(url)
  return {
    pluginId,
    versionId,
    packageName,
    version,
    payload,
    url,
    path: `${parsed.pathname}${parsed.search}`,
  }
}

async function getManifest(app: FastifyInstance, token: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/desktop/manifest',
    headers: deviceHeaders(token),
  })
  expect(res.statusCode).toBe(200)
  return res.json() as Record<string, unknown>
}

/** 不带任何头地取件（就是桌面端的真实动作） */
async function downloadNoHeaders(app: FastifyInstance, path: string) {
  return app.inject({ method: 'GET', url: path })
}

function replaceQuery(path: string, params: Record<string, string>): string {
  const parsed = new URL(path, 'https://hub.test')
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value)
  return `${parsed.pathname}${parsed.search}`
}

/** 测试里直接读临时数据目录的主密钥，用来伪造「别的设备的有效签名」 */
function signingKeyOf(context: Context): Buffer {
  const raw = readFileSync(join(context.ctx.dataDir, 'secrets', 'master.key'), 'utf8').trim()
  const master = Buffer.from(raw, 'base64')
  expect(master.length).toBe(SIGNING_KEY_BYTES)
  return desktopArtifactSigningKey(master)
}

describe('WP31 取件签名纯函数', () => {
  const key = Buffer.from('wp31-test-signing-key-32-bytes!!', 'utf8').subarray(0, 32)
  const input = {
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    packageName: '@local/desk-memory',
    version: '0.1.2',
    sha256: 'a'.repeat(64),
  }

  it('签名确定：同输入同输出；原文 = deviceId|包名|版本|sha256', () => {
    const first = signArtifact(key, input)
    const second = signArtifact(key, input)
    expect(first).toBe(second)
    // HMAC-SHA256 的 32 字节 → base64url 43 字符（无 padding）
    expect(first).toMatch(/^[0-9A-Za-z_-]{43}$/u)
    expect(isArtifactSignatureShape(first)).toBe(true)
    expect(artifactSignaturePayload(input)).toBe(
      'dv_0123456789abcdef0123456789abcdef|@local/desk-memory|0.1.2|' + 'a'.repeat(64),
    )
    expect(verifyArtifactSignature(key, input, first)).toBe(true)
  })

  it('改包名 / 版本 / 设备 id / sha256 任一字段 → 签名不同，旧签名验不过', () => {
    const base = signArtifact(key, input)
    const variants = [
      { ...input, packageName: '@local/desk-memory-evil' },
      { ...input, version: '0.1.3' },
      { ...input, deviceId: 'dv_ffffffffffffffffffffffffffffffff' },
      { ...input, sha256: 'b'.repeat(64) },
    ]
    for (const variant of variants) {
      expect(signArtifact(key, variant)).not.toBe(base)
      expect(verifyArtifactSignature(key, variant, base)).toBe(false)
    }
    // 尺寸不对的签名直接 false（不做任何进一步计算）
    expect(verifyArtifactSignature(key, input, 'short')).toBe(false)
    // 换一把密钥（主密钥轮换）→ 旧签名失效
    const rotated = Buffer.from('another-test-signing-key-32-bytes', 'utf8').subarray(0, 32)
    expect(verifyArtifactSignature(rotated, input, base)).toBe(false)
  })
})

describe('WP31 插件整包签名地址（HTTP 真链路）', () => {
  it('清单里的签名地址原样、不带任何头就能下载；签名稳定、ETag 不抖', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      const parsed = new URL(delivered.url)
      expect(parsed.origin).toBe('https://hub.test')
      expect(parsed.searchParams.get('d')).toBe(context.first.deviceId)
      const signature = parsed.searchParams.get('sig') ?? ''
      expect(isArtifactSignatureShape(signature)).toBe(true)
      // 再拉一次：同一份内容 → URL 与 ETag 都不变（签名里不含时间/随机数）
      const first = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/desktop/manifest',
        headers: deviceHeaders(context.first.token),
      })
      const again = first.json() as Record<string, unknown>
      const againPlugins = again['plugins'] as Record<string, unknown>[]
      const againUrl = String((againPlugins[0]!['artifact'] as Record<string, unknown>)['url'])
      expect(againUrl).toBe(delivered.url)
      expect(again['revision']).toBe(2)
      // 304：第二次带 If-None-Match（签名稳定 → ETag 稳定）
      const notModified = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/desktop/manifest',
        headers: { ...deviceHeaders(context.first.token), 'if-none-match': String(first.headers['etag']) },
      })
      expect(notModified.statusCode).toBe(304)

      // 真正的下载：不带任何头 → 200，sha256/长度与清单一致
      const download = await downloadNoHeaders(context.ctx.app, delivered.path)
      expect(download.statusCode).toBe(200)
      expect(download.headers['x-checksum-sha256']).toBe(sha256(delivered.payload))
      expect(download.headers['content-length']).toBe(String(delivered.payload.byteLength))
      expect(download.headers['content-disposition']).toContain('wp31-signed-0.1.0.tgz')
      expect(sha256(download.rawPayload)).toBe(sha256(delivered.payload))
    } finally {
      await context.ctx.close()
    }
  })

  it('错签 / 改包名 / 改版本 / 改设备 id / 无签名 → 401；Bearer 路径照常 200', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      const valid = new URL(delivered.url).searchParams
      const sig = valid.get('sig') ?? ''
      const tampered = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`
      const artifactPath = `/api/desktop/plugins/${delivered.packageName}/${delivered.version}.tgz`
      const deviceParam = `d=${context.first.deviceId}`

      const attempts: { name: string; path: string }[] = [
        { name: '错签', path: replaceQuery(delivered.path, { sig: tampered }) },
        { name: '签名换成别的设备', path: replaceQuery(delivered.path, { d: context.other.deviceId }) },
        { name: '无签名无令牌', path: artifactPath },
        { name: '只有设备 id 没有签名', path: `${artifactPath}?${deviceParam}` },
        { name: '只有签名没有设备 id', path: `${artifactPath}?sig=${sig}` },
        { name: '改版本（签名不变）', path: `/api/desktop/plugins/${delivered.packageName}/9.9.9.tgz${valid.size > 0 ? `?${valid.toString()}` : ''}` },
        { name: '改包名（签名不变）', path: `/api/desktop/plugins/@local/wp31-evil/${delivered.version}.tgz?${valid.toString()}` },
      ]
      for (const attempt of attempts) {
        const res = await downloadNoHeaders(context.ctx.app, attempt.path)
        expect(res.statusCode, attempt.name).toBe(401)
      }

      // Bearer 路径不受影响：不带查询串、带设备令牌照常 200
      const bearer = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/desktop/plugins/${delivered.packageName}/${delivered.version}.tgz`,
        headers: deviceHeaders(context.first.token),
      })
      expect(bearer.statusCode).toBe(200)
      expect(bearer.headers['x-checksum-sha256']).toBe(sha256(delivered.payload))
    } finally {
      await context.ctx.close()
    }
  })

  it('别台设备的签名下不了这台设备的包（签名绑定 deviceId，且必须在它的当前清单里）', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      const params = new URL(delivered.url).searchParams
      const manifest = await getManifest(context.ctx.app, context.first.token)
      expect((manifest['plugins'] as unknown[]).length).toBe(1)

      // ① 用「设备二」自己的 id + 为它算的**有效**签名：设备二没有这条下发 → 401
      const foreignSignature = signArtifact(signingKeyOf(context), {
        deviceId: context.other.deviceId,
        packageName: delivered.packageName,
        version: delivered.version,
        sha256: sha256(delivered.payload),
      })
      const foreign = await downloadNoHeaders(
        context.ctx.app,
        replaceQuery(delivered.path, { d: context.other.deviceId, sig: foreignSignature }),
      )
      expect(foreign.statusCode).toBe(401)

      // ② 设备二自己的清单里确实没有这个插件（所以它连签名地址都拿不到）
      const otherManifest = await getManifest(context.ctx.app, context.other.token)
      expect(otherManifest['plugins']).toEqual([])

      // ③ 把设备一的地址里的 d 换成设备二、签名保持设备一的 → 签名原文不同 → 401
      const swapped = await downloadNoHeaders(
        context.ctx.app,
        replaceQuery(delivered.path, { d: context.other.deviceId, sig: params.get('sig') ?? '' }),
      )
      expect(swapped.statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })

  it('设备吊销后同一 URL 401（Bearer 也 401）', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(200)

      const revoked = await context.ctx.app.inject({
        method: 'DELETE',
        url: `/api/me/desktop-devices/${context.first.deviceId}`,
        headers: context.user.headers,
      })
      expect(revoked.statusCode).toBe(204)

      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(401)
      const bearer = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/desktop/plugins/${delivered.packageName}/${delivered.version}.tgz`,
        headers: deviceHeaders(context.first.token),
      })
      expect(bearer.statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })

  it.each(['classic', 'unified'])('卸载不再同时安装，签名立即失效，同作用域可重新安装（%s）', async (mode) => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      context.ctx.app.deps.db.run(
        'UPDATE sessions SET reauth_at = ? WHERE id = ?',
        context.ctx.clock.nowIso(), context.admin.sessionId,
      )
      const report = async (installed: boolean) => context.ctx.app.inject({
        method: 'POST',
        url: '/api/desktop/devices/report',
        headers: deviceHeaders(context.first.token),
        payload: reportBody({
          appliedRevision: 2,
          applyState: 'applied',
          plugins: installed ? [{ name: delivered.packageName, version: delivered.version, source: 'hub-default', state: 'enabled' }] : [],
        }),
      })
      expect((await report(true)).statusCode).toBe(200)
      const removed = await context.ctx.app.inject(mode === 'classic' ? {
        method: 'PUT',
        url: '/api/admin/desktop/uninstall',
        payload: { target: { scope: 'user', userId: context.userId }, add: [delivered.packageName] },
        headers: context.admin.headers,
      } : {
        method: 'POST',
        url: '/api/admin/deliveries',
        payload: { platforms: ['desktop'], action: 'uninstall', items: [{ kind: 'plugin', pluginId: delivered.pluginId, versionId: delivered.versionId }], targets: { mode: 'users', userIds: [context.userId] } },
        headers: context.admin.headers,
      })
      expect(removed.statusCode, removed.body).toBe(mode === 'classic' ? 200 : 202)
      const manifest = await getManifest(context.ctx.app, context.first.token)
      expect(manifest['plugins']).toEqual([])
      expect(manifest['uninstall']).toContain(delivered.packageName)
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(401)
      context.ctx.clock.advance(60_000)
      expect((await report(false)).statusCode).toBe(200)

      const installed = await context.ctx.app.inject(mode === 'classic' ? {
        method: 'PUT', url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'user', userId: context.userId }, pluginId: delivered.pluginId, versionId: delivered.versionId, enabled: true },
        headers: context.admin.headers,
      } : {
        method: 'POST', url: '/api/admin/deliveries',
        payload: { platforms: ['desktop'], action: 'install', items: [{ kind: 'plugin', pluginId: delivered.pluginId, versionId: delivered.versionId }], targets: { mode: 'users', userIds: [context.userId] } },
        headers: context.admin.headers,
      })
      expect(installed.statusCode, installed.body).toBe(mode === 'classic' ? 200 : 202)
      const after = await getManifest(context.ctx.app, context.first.token)
      expect(after['plugins']).toHaveLength(1)
      expect(after['uninstall'] ?? []).not.toContain(delivered.packageName)
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(200)
    } finally {
      await context.ctx.close()
    }
  })

  it('撤回下发后同一 URL 401（签名仍然对，但已不在当前清单）', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(200)

      const withdrawn = await context.ctx.app.inject({
        method: 'DELETE',
        url: '/api/admin/desktop/plugins',
        payload: {
          target: { scope: 'user', userId: context.userId },
          pluginId: delivered.pluginId,
        },
        headers: context.admin.headers,
      })
      expect(withdrawn.statusCode).toBe(200)

      // 清单里已经没有它，签名地址自然取不到；直接重放旧 URL → 401
      expect((await getManifest(context.ctx.app, context.first.token))['plugins']).toEqual([])
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })

  it('用户停用后同一 URL 401（签名路径自己查 users.status）', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(200)

      // 直接改库：停用账号（不经过会级联吊销设备的接口，单独钉住「用户仍有效」这一条）
      const now = context.ctx.app.deps.clock.nowIso()
      context.ctx.app.deps.db.run(
        `UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?`,
        now,
        context.userId,
      )
      expect((await downloadNoHeaders(context.ctx.app, delivered.path)).statusCode).toBe(401)

      // 设备本身仍是 active（不是靠「设备被吊销」才 401 的）
      const device = context.ctx.app.deps.db.get<{ status: string }>(
        `SELECT status FROM desktop_devices WHERE device_id = ?`,
        context.first.deviceId,
      )
      expect(device?.status).toBe('active')
    } finally {
      await context.ctx.close()
    }
  })

  it('回归：/api/desktop/* 其余端点无令牌仍 401；签名查询串不能当万能钥匙', async () => {
    const context = await setup()
    try {
      const delivered = await deliverToDevice(context)
      // 清单：无令牌 → 401（带签名查询串也没用）
      const manifestNoToken = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/desktop/manifest?d=${context.first.deviceId}`,
      })
      expect(manifestNoToken.statusCode).toBe(401)
      // 设备会话：无令牌 → 401
      const sessionNoToken = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/desktop/session?d=${context.first.deviceId}`,
      })
      expect(sessionNoToken.statusCode).toBe(401)
      // 网页会话 cookie 也不能取件（下载只认 Bearer 或签名）
      const cookieOnly = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/desktop/plugins/${delivered.packageName}/${delivered.version}.tgz`,
        headers: context.user.headers,
      })
      expect(cookieOnly.statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })
})
