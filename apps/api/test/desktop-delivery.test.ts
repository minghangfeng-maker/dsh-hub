import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  createTestApp,
  createUser,
  json,
  loginAs,
  withHeaders,
  type TestApp,
  type TestSession,
} from './helpers.js'
import { deviceHeaders, reportBody, loginDesktop } from './helpers-desktop.js'
import { makeTarGz } from './helpers-wp3.js'
import { multipart } from './wp1-helpers.js'

/**
 * WP25b 集成测试（真走 HTTP：路由 → service → SQLite → 迁移 122）。
 *
 * 覆盖任务书的六个交付物：
 *   1. manifest（revision / plugins / config / app / ETag 304 / 无副作用）
 *   2. 管理端下发（插件 / 配置白名单 / 版本策略 / 灰度 / 审计）
 *   3. 插件整包分发（sha256 头 + 裁决 #16 的 claude 禁运 + LICENSE/NOTICE + 保留 2 版）
 *   4. feed 托管与回滚（electron-updater generic provider 的 YAML）
 *   5. 强更地板（40005 / biz_code 0）
 *   6. report 的 desiredRevision 与设备台账（appliedRevision / applyState）
 */

const schemaPath = fileURLToPath(
  new URL('../../../packages/shared/src/api/desktop-manifest.schema.json', import.meta.url),
)
const manifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>
// ajv-formats 的类型声明在 NodeNext 下被当成模块命名空间（CJS 互操作），运行时它就是默认导出的插件函数
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020, opts?: unknown) => Ajv2020
const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)
const validateManifest = ajv.compile(manifestSchema)

interface Context {
  ctx: TestApp
  admin: TestSession
  user: TestSession
  token: string
  deviceId: string
  relayKeyId: number
}

async function setup(): Promise<Context> {
  const ctx = await createTestApp({ env: { HUB_PUBLIC_ORIGIN: 'https://hub.test' } })
  const adminUser = await createUser(ctx.app, { role: 'admin' })
  const user = await createUser(ctx.app)
  const admin = loginAs(ctx.app, adminUser)
  const userSession = loginAs(ctx.app, user)
  const login = await loginDesktop(ctx.app, userSession, { name: 'WP25b 设备' })
  return {
    ctx,
    admin,
    user: userSession,
    token: login.token,
    deviceId: login.deviceId,
    relayKeyId: login.relay?.keyId ?? 0,
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function seedPlugin(
  app: FastifyInstance,
  input: {
    packageName: string
    version: string
    policy?: 'required' | 'default' | 'optional' | 'hidden'
    needsRestart?: boolean
    bundleOrder?: number
    configYaml?: string
    minDsh?: string | null
  },
): { pluginId: number; versionId: number } {
  const now = app.deps.clock.nowIso()
  const plugin = app.deps.db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, ?, 1, ?, ?, ?, ?, ?)`,
    input.packageName,
    input.packageName,
    input.policy ?? 'default',
    input.bundleOrder ?? 100,
    input.configYaml ?? '',
    input.needsRestart === false ? 0 : 1,
    now,
    now,
  )
  const version = app.deps.db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, 'upload', ?, ?, NULL, NULL, ?, ?)`,
    plugin.lastInsertRowid,
    input.version,
    `${input.packageName}@${input.version}`,
    input.version,
    input.minDsh ?? null,
    now,
  )
  return { pluginId: plugin.lastInsertRowid, versionId: version.lastInsertRowid }
}

/** 给已有插件再加一个版本（package_name 唯一，多版本不能重复建插件行） */
function seedVersion(app: FastifyInstance, pluginId: number, version: string): number {
  const now = app.deps.clock.nowIso()
  const result = app.deps.db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, 'upload', ?, ?, NULL, NULL, NULL, ?)`,
    pluginId,
    version,
    `version-${version}`,
    version,
    now,
  )
  return result.lastInsertRowid
}

/** 一个「像样」的插件整包：package.json + cordis.patch.yml + LICENSE */
function pluginPackage(
  packageName: string,
  version: string,
  extra: { name: string; content: string }[] = [],
): Buffer {
  return makeTarGz([
    {
      name: 'package/package.json',
      content: `${JSON.stringify({ name: packageName, version, description: 'wp25b', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, null, 2)}\n`,
    },
    { name: 'package/cordis.patch.yml', content: '- id: hub-desktop-test\n  config:\n    a: 1\n' },
    { name: 'package/LICENSE', content: 'MIT\n' },
    ...extra.map((entry) => ({ name: `package/${entry.name}`, content: entry.content })),
  ])
}

async function uploadArtifact(
  ctx: Context,
  versionId: number,
  payload: Buffer,
  filename = 'desk-plugin.tgz',
  pluginId = 1,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = multipart(payload, { filename, contentType: 'application/gzip' })
  const res = await ctx.ctx.app.inject({
    method: 'POST',
    url: `/api/admin/desktop/plugins/${String(pluginId)}/versions/${String(versionId)}/package`,
    payload: form.payload,
    headers: withHeaders(ctx.admin, form.headers),
  })
  return { status: res.statusCode, body: json(res) }
}

function manifestOf(res: { statusCode: number; body: string }): Record<string, unknown> {
  const body = JSON.parse(res.body) as Record<string, unknown>
  const valid = validateManifest(body) as boolean
  if (!valid) {
    throw new Error(`清单没通过 JSON Schema：${JSON.stringify(validateManifest.errors)}`)
  }
  return body
}

async function getManifest(
  app: FastifyInstance,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/desktop/manifest',
    headers: { ...deviceHeaders(token), ...extraHeaders },
  })
  return { statusCode: res.statusCode, body: res.body, headers: res.headers as Record<string, unknown> }
}

/** 多字段 + 多文件的 multipart（安装包上传用） */
function multipartForm(
  fields: Record<string, string>,
  files: { field: string; filename: string; content: Buffer; contentType?: string }[],
  boundary = '----dshhubwp25btest',
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    )
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    )
    chunks.push(file.content)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-hub-csrf': '1',
    },
  }
}

describe('WP25b 桌面下发与升级', () => {
  it('清单：未下发时是 revision 1 的空清单，设备令牌必需，且 GET 无副作用', async () => {
    const context = await setup()
    try {
      const first = await getManifest(context.ctx.app, context.token)
      expect(first.statusCode).toBe(200)
      const manifest = manifestOf(first)
      expect(manifest['schemaVersion']).toBe(1)
      expect(manifest['revision']).toBe(1)
      expect(manifest['plugins']).toEqual([])
      expect(manifest['device']).toEqual({ deviceId: context.deviceId, userId: expect.any(Number) })
      // 没配策略/片段时，config 与 app 都不出现
      expect(manifest['config']).toBeUndefined()
      expect(manifest['app']).toBeUndefined()

      // 无副作用：连续两次拉取内容一致（issuedAt 会变，但 revision / ETag 不变）
      const second = await getManifest(context.ctx.app, context.token)
      expect(second.headers['etag']).toBe(first.headers['etag'])

      // 没有设备令牌 → 401
      const noToken = await context.ctx.app.inject({ method: 'GET', url: '/api/desktop/manifest' })
      expect(noToken.statusCode).toBe(401)

      // 网页会话也不行（清单只认设备令牌）
      const cookieOnly = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/desktop/manifest',
        headers: context.user.headers,
      })
      expect(cookieOnly.statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })

  it('插件首发超过已应用的空清单版本，整包可下载且 sha256 一致', async () => {
    const context = await setup()
    try {
      const bootstrap = manifestOf(await getManifest(context.ctx.app, context.token))
      const appliedRevision = Number(bootstrap['revision'])
      const report = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/desktop/devices/report',
        headers: deviceHeaders(context.token),
        payload: reportBody({ appliedRevision, applyState: 'applied' }),
      })
      expect(report.statusCode).toBe(200)
      const { pluginId, versionId } = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-memory',
        version: '0.1.2',
        policy: 'default',
        configYaml:
          '- id: llm-pi-ai\n  config:\n    providers: {}\n- id: dsh-memory\n  config:\n    topK: 8\n',
        minDsh: '>=0.2.1',
      })
      const payload = pluginPackage('@local/desk-memory', '0.1.2')

      // 没有整包时不能下发
      const missing = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'role', role: 'user' }, pluginId, versionId },
        headers: context.admin.headers,
      })
      expect(missing.statusCode).toBe(400)
      expect(JSON.stringify(json(missing))).toContain('桌面整包')

      // 上传整包
      const uploaded = await uploadArtifact(context, versionId, payload, 'desk-plugin.tgz', pluginId)
      expect(uploaded.status).toBe(201)
      const artifact = uploaded.body['artifact'] as Record<string, unknown>
      expect(artifact['sha256']).toBe(sha256(payload))
      expect(artifact['bytes']).toBe(payload.byteLength)
      expect(
        existsSync(join(context.ctx.app.deps.paths.desktopPluginStoreDir, 'desk-memory-0.1.2.tgz')),
      ).toBe(true)

      // 下发给「普通用户」角色
      const delivered = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'role', role: 'user' }, pluginId, versionId, enabled: true },
        headers: context.admin.headers,
      })
      expect(delivered.statusCode).toBe(200)
      const deliveredBody = json<{ revision: number; affectedDevices: number }>(delivered)
      expect(deliveredBody.revision).toBeGreaterThan(appliedRevision)
      expect(deliveredBody.revision).toBe(2)
      expect(deliveredBody.affectedDevices).toBe(1)

      const manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(manifest['revision']).toBe(deliveredBody.revision)
      const plugins = manifest['plugins'] as Record<string, unknown>[]
      expect(plugins).toHaveLength(1)
      expect(plugins[0]).toMatchObject({
        name: '@local/desk-memory',
        version: '0.1.2',
        level: 'default',
        enabled: true,
        needsRestart: true,
        minDsh: '>=0.2.1',
        bundleOrder: 100,
      })
      const artifactView = plugins[0]!['artifact'] as Record<string, unknown>
      // WP31：清单里的取件地址带每设备稳定签名（桌面端不加任何头也能下）
      const artifactUrl = new URL(String(artifactView['url']))
      expect(`${artifactUrl.origin}${artifactUrl.pathname}`).toBe(
        'https://hub.test/api/desktop/plugins/@local/desk-memory/0.1.2.tgz',
      )
      expect(artifactUrl.searchParams.get('d')).toBe(context.deviceId)
      expect(artifactUrl.searchParams.get('sig')).toMatch(/^[0-9A-Za-z_-]{43}$/u)
      expect(artifactView['sha256']).toBe(sha256(payload))
      expect(artifactView['bytes']).toBe(payload.byteLength)
      expect(artifactView['filename']).toBe('desk-memory-0.1.2.tgz')

      // 插件自带配置：保留 id（llm-pi-ai）被丢弃，其余保留
      const pluginConfig = plugins[0]!['config'] as Record<string, unknown>[]
      expect(pluginConfig).toHaveLength(1)
      expect(pluginConfig[0]!['id']).toBe('dsh-memory')

      // ETag/304
      const etag = (await getManifest(context.ctx.app, context.token)).headers['etag'] as string
      const notModified = await getManifest(context.ctx.app, context.token, { 'if-none-match': etag })
      expect(notModified.statusCode).toBe(304)

      // 取件：sha256 / size 都对得上
      const download = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/desktop/plugins/@local/desk-memory/0.1.2.tgz',
        headers: deviceHeaders(context.token),
      })
      expect(download.statusCode).toBe(200)
      expect(download.headers['x-checksum-sha256']).toBe(sha256(payload))
      expect(download.headers['content-length']).toBe(String(payload.byteLength))
      expect(sha256(download.rawPayload)).toBe(sha256(payload))

      // 不存在的包 → 404
      const missingDownload = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/desktop/plugins/@local/desk-memory/9.9.9.tgz',
        headers: deviceHeaders(context.token),
      })
      expect(missingDownload.statusCode).toBe(404)
    } finally {
      await context.ctx.close()
    }
  })

  it('下发目标隔离：角色下发不影响管理员设备；revision 只对受影响设备前进', async () => {
    const context = await setup()
    try {
      const adminLogin = await loginDesktop(context.ctx.app, context.admin, {
        name: '管理员设备',
        installId: null,
      })
      const { pluginId, versionId } = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-memory',
        version: '0.1.2',
      })
      await uploadArtifact(
        context,
        versionId,
        pluginPackage('@local/desk-memory', '0.1.2'),
        'desk-plugin.tgz',
        pluginId,
      )
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'role', role: 'user' }, pluginId, versionId },
        headers: context.admin.headers,
      })

      const userManifest = manifestOf(await getManifest(context.ctx.app, context.token))
      const adminManifest = manifestOf(await getManifest(context.ctx.app, adminLogin.token))
      expect(userManifest['revision']).toBe(2)
      expect((userManifest['plugins'] as unknown[]).length).toBe(1)
      expect(adminManifest['revision']).toBe(1)
      expect(adminManifest['plugins']).toEqual([])

      // 下发给「管理员」角色 → 管理员的 revision 前进，普通用户不动
      const { pluginId: adminPlugin, versionId: adminVersion } = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-admin-tool',
        version: '0.0.1',
        policy: 'optional',
      })
      await uploadArtifact(
        context,
        adminVersion,
        pluginPackage('@local/desk-admin-tool', '0.0.1'),
        'desk-plugin.tgz',
        adminPlugin,
      )
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'role', role: 'admin' }, pluginId: adminPlugin, versionId: adminVersion },
        headers: context.admin.headers,
      })
      const adminAfter = manifestOf(await getManifest(context.ctx.app, adminLogin.token))
      expect(adminAfter['revision']).toBe(3)
      // optional 在清单里是 enabled=false（客户端只当「可安装」）
      expect((adminAfter['plugins'] as Record<string, unknown>[])[0]).toMatchObject({
        level: 'optional',
        enabled: false,
      })
      const userAfter = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(userAfter['revision']).toBe(2)

      // report 的 desiredRevision 必须与清单一致
      const report = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/desktop/devices/report',
        headers: deviceHeaders(context.token),
        payload: reportBody({
          appliedRevision: 1,
          appliedAt: context.ctx.app.deps.clock.nowIso(),
          applyState: 'applied',
          errorCount: 0,
          plugins: [
            { name: '@local/desk-memory', version: '0.1.2', source: 'hub-default', state: 'enabled' },
          ],
        }),
      })
      expect(report.statusCode).toBe(200)
      expect(json<{ desiredRevision: number }>(report).desiredRevision).toBe(2)
    } finally {
      await context.ctx.close()
    }
  })

  it('配置片段：白名单内的能下发（带 digest/allowlistVersion），非白名单键 400', async () => {
    const context = await setup()
    try {
      const ok = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/config',
        payload: {
          target: { scope: 'all' },
          fragments: [
            {
              id: 'llm-pi-ai',
              mode: 'enforce',
              config: {
                providers: {
                  hub: {
                    displayName: 'DSH Hub',
                    api: 'openai-completions',
                    baseURL: 'https://hub.test/v1',
                    apiKeyEnv: 'HUB_MK_HUB',
                    models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
                  },
                },
              },
              note: '中转站',
            },
            {
              id: 'agent-default-model',
              mode: 'enforce',
              config: { provider: 'hub', model: 'deepseek-v4' },
            },
          ],
        },
        headers: context.admin.headers,
      })
      expect(ok.statusCode).toBe(200)
      expect(json<{ revision: number }>(ok).revision).toBe(2)

      const manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      const config = manifest['config'] as Record<string, unknown>
      expect(config['allowlistVersion']).toBe(1)
      expect(config['digest']).toMatch(/^sha256:[0-9a-f]{64}$/u)
      const fragments = config['fragments'] as Record<string, unknown>[]
      expect(fragments.map((fragment) => fragment['id'])).toEqual(['agent-default-model', 'llm-pi-ai'])
      expect(fragments.every((fragment) => fragment['mode'] === 'enforce')).toBe(true)

      // 非白名单键：400，且 details.fields 指出位置
      const bad = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/config',
        payload: {
          target: { scope: 'all' },
          fragments: [
            {
              id: 'agent-default-model',
              mode: 'enforce',
              config: { provider: 'hub', model: 'x', temperature: 0.7 },
            },
          ],
        },
        headers: context.admin.headers,
      })
      expect(bad.statusCode).toBe(400)
      expect(json<{ error: { code: string } }>(bad).error.code).toBe('VALIDATION_FAILED')

      // 不在白名单里的条目 id 也 400
      const unknownEntry = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/config',
        payload: {
          target: { scope: 'all' },
          fragments: [{ id: 'webserver', mode: 'enforce', config: {} }],
        },
        headers: context.admin.headers,
      })
      expect(unknownEntry.statusCode).toBe(400)

      // 整体替换：再下发一次只剩一条
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/config',
        payload: {
          target: { scope: 'all' },
          fragments: [{ id: 'claude-pilot', mode: 'default', config: { hubMode: true } }],
        },
        headers: context.admin.headers,
      })
      const replaced = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(
        (replaced['config'] as { fragments: Record<string, unknown>[] }).fragments.map((f) => f['id']),
      ).toEqual(['claude-pilot'])
    } finally {
      await context.ctx.close()
    }
  })

  it('版本策略：渠道级 targetVersion/minVersion、灰度、按用户覆盖', async () => {
    const context = await setup()
    try {
      const set = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/app',
        payload: {
          channel: 'latest',
          targetVersion: '0.2.2',
          minVersion: '0.2.1',
          minVersionHard: false,
          rolloutPercent: 100,
        },
        headers: context.admin.headers,
      })
      expect(set.statusCode).toBe(200)

      let manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(manifest['app']).toMatchObject({
        channel: 'latest',
        minVersion: '0.2.1',
        minVersionHard: false,
        targetVersion: '0.2.2',
      })

      // 灰度 0%：targetVersion 消失，但安全地板 minVersion 还在
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/app',
        payload: { channel: 'latest', rolloutPercent: 0 },
        headers: context.admin.headers,
      })
      manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(manifest['app']).toMatchObject({ minVersion: '0.2.1', minVersionHard: false })
      expect((manifest['app'] as Record<string, unknown>)['targetVersion']).toBeUndefined()

      // 按用户覆盖：只影响这台设备的所有者
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/app',
        payload: {
          channel: 'latest',
          target: { scope: 'user', userId: context.user.user.id },
          targetVersion: '0.3.0-rc.1',
          rolloutPercent: 100,
        },
        headers: context.admin.headers,
      })
      manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(manifest['app']).toMatchObject({ targetVersion: '0.3.0-rc.1', minVersion: '0.2.1' })

      // 清空覆盖（两个字段都给 null）→ 回到渠道级
      const cleared = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/app',
        payload: {
          channel: 'latest',
          target: { scope: 'user', userId: context.user.user.id },
          targetVersion: null,
          minVersion: null,
        },
        headers: context.admin.headers,
      })
      expect(cleared.statusCode).toBe(200)
      manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect((manifest['app'] as Record<string, unknown>)['targetVersion']).toBeUndefined()

      // nightly 设备看到的策略独立：给 nightly 单独设地板，再把设备通道改成 nightly
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/app',
        payload: { channel: 'nightly', minVersion: '0.1.0' },
        headers: context.admin.headers,
      })
      context.ctx.app.deps.db.run(
        "UPDATE desktop_devices SET app_channel = 'nightly' WHERE device_id = ?",
        context.deviceId,
      )
      manifest = manifestOf(await getManifest(context.ctx.app, context.token))
      expect(manifest['app']).toMatchObject({ channel: 'nightly', minVersion: '0.1.0' })
    } finally {
      await context.ctx.close()
    }
  })

  it('裁决 #16：claude 二进制整包拒绝；codex 整包缺 LICENSE/NOTICE 拒绝；每插件只留最近 2 版', async () => {
    const context = await setup()
    try {
      const claude = seedPlugin(context.ctx.app, { packageName: '@local/desk-claude', version: '0.1.0' })
      const claudePackage = pluginPackage('@local/desk-claude', '0.1.0', [
        {
          name: 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json',
          content: '{"name":"@anthropic-ai/claude-agent-sdk-win32-x64","version":"0.3.303"}\n',
        },
      ])
      const rejected = await uploadArtifact(
        context,
        claude.versionId,
        claudePackage,
        'desk-plugin.tgz',
        claude.pluginId,
      )
      expect(rejected.status).toBe(400)
      expect(JSON.stringify(rejected.body)).toContain('裁决 #16')

      // 裸 claude 二进制也拒绝
      const bareBinary = pluginPackage('@local/desk-claude', '0.1.0', [
        { name: 'vendor/claude', content: 'MZ fake binary' },
      ])
      expect(
        (await uploadArtifact(context, claude.versionId, bareBinary, 'desk-plugin.tgz', claude.pluginId))
          .status,
      ).toBe(400)

      // codex 整包：没有 LICENSE/NOTICE → 拒绝
      const codex = seedPlugin(context.ctx.app, { packageName: '@local/desk-codex', version: '0.1.0' })
      const codexNoLicense = makeTarGz([
        {
          name: 'package/package.json',
          content: `${JSON.stringify({ name: '@local/desk-codex', version: '0.1.0' })}\n`,
        },
        {
          name: 'package/node_modules/@openai/codex-win32-x64/package.json',
          content: '{"name":"@openai/codex-win32-x64"}\n',
        },
      ])
      const denied = await uploadArtifact(
        context,
        codex.versionId,
        codexNoLicense,
        'desk-plugin.tgz',
        codex.pluginId,
      )
      expect(denied.status).toBe(400)
      expect(JSON.stringify(denied.body)).toContain('LICENSE')

      // 带 LICENSE + NOTICE → 接受
      const codexFull = makeTarGz([
        {
          name: 'package/package.json',
          content: `${JSON.stringify({ name: '@local/desk-codex', version: '0.1.0' })}\n`,
        },
        {
          name: 'package/node_modules/@openai/codex-win32-x64/package.json',
          content: '{"name":"@openai/codex-win32-x64"}\n',
        },
        { name: 'package/LICENSE', content: 'Apache-2.0\n' },
        { name: 'package/NOTICE', content: 'Codex\n' },
      ])
      expect(
        (await uploadArtifact(context, codex.versionId, codexFull, 'codex.tgz', codex.pluginId)).status,
      ).toBe(201)

      // 保留最近 2 版：同插件再传两个版本，最早的文件被删
      const versions = [
        { versionId: claude.versionId, version: '0.1.0', file: 'desk-claude-0.1.0.tgz' },
        ...(['0.1.1', '0.1.2'] as const).map((version) => ({
          versionId: seedVersion(context.ctx.app, claude.pluginId, version),
          version,
          file: `desk-claude-${version}.tgz`,
        })),
      ]
      // 先传 v0.1.0 的合法包（前面被拒的那次不落盘）
      expect(
        (
          await uploadArtifact(
            context,
            versions[0]!.versionId,
            pluginPackage('@local/desk-claude', '0.1.0'),
            'desk-plugin.tgz',
            claude.pluginId,
          )
        ).status,
      ).toBe(201)
      for (const entry of versions.slice(1)) {
        expect(
          (
            await uploadArtifact(
              context,
              entry.versionId,
              pluginPackage('@local/desk-claude', entry.version),
              'desk-plugin.tgz',
              claude.pluginId,
            )
          ).status,
        ).toBe(201)
      }
      const files = readdirSync(context.ctx.app.deps.paths.desktopPluginStoreDir).filter((name) =>
        name.startsWith('desk-claude-'),
      )
      expect(files.sort()).toEqual(['desk-claude-0.1.1.tgz', 'desk-claude-0.1.2.tgz'])
      expect(existsSync(join(context.ctx.app.deps.paths.desktopPluginStoreDir, versions[0]!.file))).toBe(
        false,
      )
    } finally {
      await context.ctx.close()
    }
  })

  it('feed：上传安装包 + blockmap → YAML 字段齐全且 sha512 正确；回滚到上一版', async () => {
    const context = await setup()
    try {
      const installer = Buffer.from('fake-installer-bytes-0.2.1')
      const blockmap = Buffer.from('fake-blockmap')
      const boundaried = multipartForm({ target: 'win-x64', channel: 'latest', version: '0.2.1' }, [
        { field: 'installer', filename: 'deepseek-harness-0.2.1-win-x64.exe', content: installer },
        { field: 'blockmap', filename: 'deepseek-harness-0.2.1-win-x64.exe.blockmap', content: blockmap },
      ])
      const created = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/desktop/releases',
        payload: boundaried.payload,
        headers: withHeaders(context.admin, boundaried.headers),
      })
      expect(created.statusCode).toBe(201)
      const release = json<Record<string, unknown>>(created)
      expect(release).toMatchObject({
        target: 'win-x64',
        channel: 'latest',
        version: '0.2.1',
        status: 'published',
      })

      const feed = await context.ctx.app.inject({ method: 'GET', url: '/desktop/feeds/win-x64/latest.yml' })
      expect(feed.statusCode).toBe(200)
      expect(feed.headers['cache-control']).toBe('no-store')
      const parsed = parseYaml(feed.body) as Record<string, unknown>
      expect(parsed['version']).toBe('0.2.1')
      const files = parsed['files'] as Record<string, unknown>[]
      expect(files).toHaveLength(1)
      const file = files[0]!
      const expectedSha512 = createHash('sha512').update(installer).digest('base64')
      expect(file['sha512']).toBe(expectedSha512)
      expect(file['size']).toBe(installer.byteLength)
      expect(file['url']).toBe('https://hub.test/desktop/bin/win-x64/deepseek-harness-0.2.1-win-x64.exe')
      expect(parsed['path']).toBe(file['url'])
      expect(parsed['sha512']).toBe(expectedSha512)
      expect(typeof parsed['releaseDate']).toBe('string')

      // 安装包与 blockmap 可下载
      const bin = await context.ctx.app.inject({
        method: 'GET',
        url: '/desktop/bin/win-x64/deepseek-harness-0.2.1-win-x64.exe',
      })
      expect(bin.statusCode).toBe(200)
      expect(bin.headers['cache-control']).toContain('immutable')
      expect(sha256(bin.rawPayload)).toBe(sha256(installer))
      const map = await context.ctx.app.inject({
        method: 'GET',
        url: '/desktop/bin/win-x64/deepseek-harness-0.2.1-win-x64.exe.blockmap',
      })
      expect(map.statusCode).toBe(200)

      // 发布新版本后 feed 指向新版本；回滚把新版本标 yanked
      const next = multipartForm({ target: 'win-x64', channel: 'latest', version: '0.2.2' }, [
        { field: 'installer', filename: 'deepseek-harness-0.2.2-win-x64.exe', content: Buffer.from('v022') },
      ])
      const createdNext = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/desktop/releases',
        payload: next.payload,
        headers: withHeaders(context.admin, next.headers),
      })
      expect(createdNext.statusCode).toBe(201)
      const feedNew = await context.ctx.app.inject({
        method: 'GET',
        url: '/desktop/feeds/win-x64/latest.yml',
      })
      expect((parseYaml(feedNew.body) as Record<string, unknown>)['version']).toBe('0.2.2')

      const rollback = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/desktop/releases/rollback',
        payload: { target: 'win-x64', channel: 'latest' },
        headers: context.admin.headers,
      })
      expect(rollback.statusCode).toBe(200)
      expect(json<{ yanked: string[]; release: { version: string } }>(rollback)).toMatchObject({
        yanked: ['0.2.2'],
        release: { version: '0.2.1' },
      })
      const feedAfter = await context.ctx.app.inject({
        method: 'GET',
        url: '/desktop/feeds/win-x64/latest.yml',
      })
      expect((parseYaml(feedAfter.body) as Record<string, unknown>)['version']).toBe('0.2.1')

      // 未知通道文件 / 未知目标 → 404
      expect(
        (await context.ctx.app.inject({ method: 'GET', url: '/desktop/feeds/win-x64/beta.yml' })).statusCode,
      ).toBe(404)
      expect(
        (await context.ctx.app.inject({ method: 'GET', url: '/desktop/feeds/mac-arm64/latest-mac.yml' }))
          .statusCode,
      ).toBe(404)
      // latest 通道不接受预发布
      const prerelease = multipartForm({ target: 'win-x64', channel: 'latest', version: '0.2.3-rc.1' }, [
        { field: 'installer', filename: 'rc.exe', content: Buffer.from('rc') },
      ])
      expect(
        (
          await context.ctx.app.inject({
            method: 'POST',
            url: '/api/admin/desktop/releases',
            payload: prerelease.payload,
            headers: withHeaders(context.admin, prerelease.headers),
          })
        ).statusCode,
      ).toBe(400)
    } finally {
      await context.ctx.close()
    }
  })

  it('免安装 ZIP（WP38）：挂到已有发布记录、可下载、公开接口返回、不进 feed；替换删旧文件；撞名/非 zip/不存在拒绝', async () => {
    const context = await setup()
    try {
      const upload = multipartForm({ target: 'win-x64', channel: 'nightly', version: '0.2.1-rc.2' }, [
        { field: 'installer', filename: 'DSH-Hub-Setup-0.2.1-rc.2.exe', content: Buffer.from('installer') },
      ])
      const created = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/desktop/releases',
        payload: upload.payload,
        headers: withHeaders(context.admin, upload.headers),
      })
      expect(created.statusCode).toBe(201)
      const releaseId = json<{ id: number }>(created).id
      const feedBefore = (
        await context.ctx.app.inject({ method: 'GET', url: '/desktop/feeds/win-x64/nightly.yml' })
      ).body

      const attach = async (filename: string, content: Buffer, id = releaseId, field = 'portable') => {
        const form = multipartForm({}, [{ field, filename, content, contentType: 'application/zip' }])
        return context.ctx.app.inject({
          method: 'POST',
          url: `/api/admin/desktop/releases/${String(id)}/portable`,
          payload: form.payload,
          headers: withHeaders(context.admin, form.headers),
        })
      }

      const zip = Buffer.from('portable-zip-v1')
      const attached = await attach('DSH-Hub-0.2.1-rc.2-portable.zip', zip)
      expect(attached.statusCode).toBe(200)
      expect(json(attached)).toMatchObject({
        id: releaseId,
        portableFile: 'DSH-Hub-0.2.1-rc.2-portable.zip',
        portableBytes: zip.byteLength,
      })

      const bin = await context.ctx.app.inject({
        method: 'GET',
        url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-rc.2-portable.zip',
      })
      expect(bin.statusCode).toBe(200)
      expect(sha256(bin.rawPayload)).toBe(sha256(zip))
      expect(bin.headers['x-checksum-sha512']).toBe(createHash('sha512').update(zip).digest('base64'))

      const pub = await context.ctx.app.inject({ method: 'GET', url: '/api/public/desktop/download' })
      expect(json<{ windows: { portable: unknown } }>(pub).windows.portable).toEqual({
        fileName: 'DSH-Hub-0.2.1-rc.2-portable.zip',
        bytes: zip.byteLength,
        url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-rc.2-portable.zip',
      })
      // feed 原样（免安装包不参与自动升级）
      expect(
        (await context.ctx.app.inject({ method: 'GET', url: '/desktop/feeds/win-x64/nightly.yml' })).body,
      ).toBe(feedBefore)

      // 换名替换：新文件可下、旧文件删除
      const v2 = Buffer.from('portable-zip-v2')
      expect((await attach('DSH-Hub-0.2.1-rc.2-portable-b.zip', v2)).statusCode).toBe(200)
      const binDir = join(context.ctx.app.deps.paths.desktopReleaseDir, 'bin', 'win-x64')
      expect(existsSync(join(binDir, 'DSH-Hub-0.2.1-rc.2-portable.zip'))).toBe(false)
      expect(existsSync(join(binDir, 'DSH-Hub-0.2.1-rc.2-portable-b.zip'))).toBe(true)
      expect(
        (
          await context.ctx.app.inject({
            method: 'GET',
            url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-rc.2-portable.zip',
          })
        ).statusCode,
      ).toBe(404)

      // 拒绝：与安装器撞名、非 zip、记录不存在、字段名不对
      expect((await attach('DSH-Hub-Setup-0.2.1-rc.2.exe', zip)).statusCode).toBe(400)
      const clash = await attach('x.zip', zip)
      expect(clash.statusCode).toBe(200)
      // 给另一条记录挂一个已被占用的名字 → 409
      const other = multipartForm({ target: 'win-x64', channel: 'nightly', version: '0.2.1-rc.4' }, [
        { field: 'installer', filename: 'DSH-Hub-Setup-0.2.1-rc.4.exe', content: Buffer.from('i4') },
      ])
      const createdOther = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/desktop/releases',
        payload: other.payload,
        headers: withHeaders(context.admin, other.headers),
      })
      expect(createdOther.statusCode).toBe(201)
      const otherId = json<{ id: number }>(createdOther).id
      expect((await attach('x.zip', zip, otherId)).statusCode).toBe(409)
      expect((await attach('nope.zip', zip, 99_999)).statusCode).toBe(404)
      expect((await attach('y.zip', zip, releaseId, 'installer')).statusCode).toBe(400)
      // 非管理员不行
      const form = multipartForm({}, [{ field: 'portable', filename: 'z.zip', content: zip }])
      const anon = await context.ctx.app.inject({
        method: 'POST',
        url: `/api/admin/desktop/releases/${String(releaseId)}/portable`,
        payload: form.payload,
        headers: form.headers,
      })
      expect(anon.statusCode).toBe(401)
    } finally {
      await context.ctx.close()
    }
  })

  it('强更地板：低于全局最低版本 → 40005；不低 → biz_code 0；匿名可用', async () => {
    const context = await setup()
    try {
      // 默认不强制
      const open = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/v0/check_client_update?scenario=launch',
        headers: { 'x-client-platform': 'desktop-win', 'x-client-version': '0.1.0' },
      })
      expect(open.statusCode).toBe(200)
      expect(json(open)).toEqual({ code: 0, data: { biz_code: 0, biz_data: null } })

      const set = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/update-floor',
        payload: {
          minVersion: '0.2.1',
          title: '需要更新',
          detail: '请安装 0.2.1 或更高版本',
          appLink: 'https://hub.test/download',
        },
        headers: context.admin.headers,
      })
      expect(set.statusCode).toBe(200)
      expect(json<{ floor: Record<string, unknown> }>(set).floor).toMatchObject({
        minVersion: '0.2.1',
        title: '需要更新',
        appLink: 'https://hub.test/download',
      })

      const low = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/v0/check_client_update?scenario=periodic',
        headers: { 'x-client-platform': 'desktop-win', 'x-client-version': '0.2.0' },
      })
      expect(low.statusCode).toBe(200)
      expect(json(low)).toEqual({
        code: 40005,
        data: {
          show_content: { title: '需要更新', detail: '请安装 0.2.1 或更高版本' },
          desktop_app_link: 'https://hub.test/download',
        },
      })

      const equal = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/v0/check_client_update',
        headers: { 'x-client-platform': 'desktop-win', 'x-client-version': '0.2.1' },
      })
      expect(json(equal)).toEqual({ code: 0, data: { biz_code: 0, biz_data: null } })

      // 版本号缺失 → 宁可挡着（40005）
      const missing = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/v0/check_client_update',
        headers: { 'x-client-platform': 'desktop-win' },
      })
      expect(json<{ code: number }>(missing).code).toBe(40005)

      // appLink 必须是 https
      const badLink = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/update-floor',
        payload: { appLink: 'http://insecure' },
        headers: context.admin.headers,
      })
      expect(badLink.statusCode).toBe(400)
    } finally {
      await context.ctx.close()
    }
  })

  it('模型预设预览：复用「下发到 DSH」的 provider 与默认模型，apiKeyEnv 固定 HUB_MK_HUB', async () => {
    const context = await setup()
    try {
      // 带 apiKey 的提供方要求最近输过密码（04 §4.7）：测试里直接把会话标成刚验证过
      context.ctx.app.deps.db.run(
        'UPDATE sessions SET reauth_at = ? WHERE id = ?',
        context.ctx.app.deps.clock.nowIso(),
        context.admin.sessionId,
      )
      const providerRes = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/models/providers',
        payload: {
          routeKey: 'hub',
          displayName: 'DSH Hub',
          kind: 'pi-ai',
          api: 'openai-completions',
          baseUrl: 'https://hub.test/v1',
          models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
          keyMode: 'shared',
          apiKey: 'sk-test-provider',
        },
        headers: context.admin.headers,
      })
      expect(providerRes.statusCode, providerRes.body).toBe(200)
      const providerId = json<{ provider: { id: number } }>(providerRes).provider.id

      const presetRes = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/admin/models/presets',
        payload: {
          name: '桌面默认',
          providerIds: [providerId],
          defaultProvider: 'hub',
          defaultModel: 'deepseek-v4',
          isDefault: true,
        },
        headers: context.admin.headers,
      })
      expect(presetRes.statusCode, presetRes.body).toBe(200)

      const preview = await context.ctx.app.inject({
        method: 'GET',
        url: `/api/admin/desktop/config/model-preset?userId=${String(context.user.user.id)}`,
        headers: context.admin.headers,
      })
      expect(preview.statusCode).toBe(200)
      const body = json<{
        userId: number
        fragments: { id: string; config: Record<string, unknown> }[]
        warnings: string[]
      }>(preview)
      expect(body.userId).toBe(context.user.user.id)
      expect(body.fragments.map((fragment) => fragment.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
      const providers = body.fragments[0]!.config['providers'] as Record<string, Record<string, unknown>>
      expect(providers['hub']).toMatchObject({ displayName: 'DSH Hub', apiKeyEnv: 'HUB_MK_HUB' })
      expect(body.fragments[1]!.config).toMatchObject({ provider: 'hub', model: 'deepseek-v4' })

      // 预览出来的片段必须直接能过白名单（否则「一键带入」是个陷阱）
      const deliver = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/config',
        payload: {
          target: { scope: 'all' },
          fragments: body.fragments.map((fragment) => ({
            id: fragment.id,
            mode: 'enforce',
            config: fragment.config,
          })),
        },
        headers: context.admin.headers,
      })
      expect(deliver.statusCode, deliver.body).toBe(200)
    } finally {
      await context.ctx.close()
    }
  })

  it('复核：设备台账里的 appliedRevision / desiredRevision / applyState 与上报一致', async () => {
    const context = await setup()
    try {
      const { pluginId, versionId } = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-memory',
        version: '0.1.2',
      })
      await uploadArtifact(
        context,
        versionId,
        pluginPackage('@local/desk-memory', '0.1.2'),
        'desk-plugin.tgz',
        pluginId,
      )
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'user', userId: context.user.user.id }, pluginId, versionId },
        headers: context.admin.headers,
      })

      const reported = await context.ctx.app.inject({
        method: 'POST',
        url: '/api/desktop/devices/report',
        headers: deviceHeaders(context.token),
        payload: reportBody({
          appliedRevision: 1,
          appliedAt: context.ctx.app.deps.clock.nowIso(),
          applyState: 'partial',
          applyErrorCode: 'plugin_install_failed',
          errorCount: 1,
          plugins: [
            {
              name: '@local/desk-memory',
              version: '0.1.2',
              source: 'hub-default',
              state: 'failed',
              errorCode: 'plugin_install_failed',
            },
          ],
        }),
      })
      expect(reported.statusCode).toBe(200)
      expect(json<{ desiredRevision: number }>(reported).desiredRevision).toBe(2)

      const list = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/admin/desktop-devices',
        headers: context.admin.headers,
      })
      expect(list.statusCode).toBe(200)
      const item = json<{ items: { device: Record<string, unknown>; pluginCount: number }[] }>(list).items[0]!
      expect(item.device).toMatchObject({
        deviceId: context.deviceId,
        appliedRevision: 1,
        desiredRevision: 2,
        applyState: 'partial',
        applyErrorCode: 'plugin_install_failed',
        errorCount: 1,
      })
      expect(item.pluginCount).toBe(1)

      // 用户自己的设备列表也带 desiredRevision（同一份视图）
      const mine = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/me/desktop-devices',
        headers: context.user.headers,
      })
      expect(json<{ items: Record<string, unknown>[] }>(mine).items[0]).toMatchObject({ desiredRevision: 2 })
    } finally {
      await context.ctx.close()
    }
  })

  it('WP25a 遗留 ④：用户的「API 密钥」列表不含设备密钥，也不能删', async () => {
    const context = await setup()
    try {
      expect(context.relayKeyId).toBeGreaterThan(0)
      const list = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/me/relay/keys',
        headers: context.user.headers,
      })
      expect(list.statusCode).toBe(200)
      const keys = json<{ id: number; name: string }[]>(list)
      expect(keys.map((key) => key.id)).not.toContain(context.relayKeyId)

      const remove = await context.ctx.app.inject({
        method: 'DELETE',
        url: `/api/me/relay/keys/${String(context.relayKeyId)}`,
        headers: context.user.headers,
      })
      expect(remove.statusCode).toBe(404)
    } finally {
      await context.ctx.close()
    }
  })

  it('管理端状态视图：下发历史、目标、告警一目了然', async () => {
    const context = await setup()
    try {
      const { pluginId, versionId } = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-memory',
        version: '0.1.2',
        policy: 'default',
      })
      await uploadArtifact(
        context,
        versionId,
        pluginPackage('@local/desk-memory', '0.1.2'),
        'desk-plugin.tgz',
        pluginId,
      )
      await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'all' }, pluginId, versionId },
        headers: context.admin.headers,
      })
      // 再挂一个没传整包的插件 → 应该出现在 warnings 里
      const noArtifact = seedPlugin(context.ctx.app, { packageName: '@local/desk-other', version: '0.0.1' })
      context.ctx.app.deps.db.run(
        `INSERT INTO desktop_plugin_targets (plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
         VALUES (?, ?, 1, 'all', '', NULL, NULL, ?)`,
        noArtifact.pluginId,
        noArtifact.versionId,
        context.ctx.app.deps.clock.nowIso(),
      )

      const state = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/admin/desktop/delivery',
        headers: context.admin.headers,
      })
      expect(state.statusCode).toBe(200)
      const body = json<Record<string, unknown>>(state)
      expect(body['revision']).toBe(2)
      expect(body['allowlistVersion']).toBe(1)
      expect(body['pluginTargets']).toHaveLength(2)
      expect(body['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('@local/desk-other')]))
      expect(body['app']).toMatchObject({
        channels: expect.arrayContaining([expect.objectContaining({ channel: 'latest' })]),
      })

      // 撤掉受管条目（撤两次：第二次 404）
      const withdraw = await context.ctx.app.inject({
        method: 'DELETE',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'all' }, pluginId: noArtifact.pluginId },
        headers: context.admin.headers,
      })
      expect(withdraw.statusCode).toBe(200)
      expect(json<{ revision: number }>(withdraw).revision).toBe(3)
      const again = await context.ctx.app.inject({
        method: 'DELETE',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'all' }, pluginId: noArtifact.pluginId },
        headers: context.admin.headers,
      })
      expect(again.statusCode).toBe(404)

      // hidden 插件不能下发（裁决 #17）
      const hidden = seedPlugin(context.ctx.app, {
        packageName: '@local/desk-hidden',
        version: '0.0.1',
        policy: 'hidden',
      })
      const denied = await context.ctx.app.inject({
        method: 'PUT',
        url: '/api/admin/desktop/plugins',
        payload: { target: { scope: 'all' }, pluginId: hidden.pluginId, versionId: hidden.versionId },
        headers: context.admin.headers,
      })
      expect(denied.statusCode).toBe(400)

      // 只有管理员能下发
      const forbidden = await context.ctx.app.inject({
        method: 'GET',
        url: '/api/admin/desktop/delivery',
        headers: context.user.headers,
      })
      expect(forbidden.statusCode).toBe(403)
    } finally {
      await context.ctx.close()
    }
  })
})
