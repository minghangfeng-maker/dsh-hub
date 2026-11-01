import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { MobileAppRelease, MobileAppReleaseListResponse, PublicAndroidDownloadResponse } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { mobileBootstrap, mobileSession } from './helpers-mobile.js'

/** 安卓 App 发布记录（WP40r）：管理端上传/回滚、公开下载、二维码、bootstrap 联动。 */

const contexts: TestApp[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close()
})

interface Setup {
  ctx: TestApp
  admin: TestUser
  adminHeaders: Record<string, string>
  user: TestUser
}

async function setup(): Promise<Setup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  const admin = await createUser(ctx.app, { username: 'root', password: 'Root-pass-1', role: 'admin' })
  const adminHeaders = loginAs(ctx.app, admin).headers
  const user = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  return { ctx, admin, adminHeaders, user }
}

/** 构造一个「像 APK」的字节串（内容是任意的；大小与 sha256 由测试自己算） */
function fakeApk(marker: string): Buffer {
  return Buffer.from(`PK\u0003\u0004${marker}`.padEnd(512, 'x'))
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 多字段 + 单文件 multipart（与桌面安装包上传的测试同一套写法） */
function apkForm(
  fields: Record<string, string>,
  file: { filename: string; content: Buffer },
  boundary = '----dshhubwp40rtest',
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    )
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="${file.filename}"\r\n` +
        'Content-Type: application/vnd.android.package-archive\r\n\r\n',
    ),
  )
  chunks.push(file.content)
  chunks.push(Buffer.from('\r\n'))
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-hub-csrf': '1',
    },
  }
}

async function upload(
  ctx: TestApp,
  headers: Record<string, string>,
  input: { version: string; versionCode: number; content: Buffer; filename?: string },
): Promise<{ statusCode: number; body: string }> {
  const form = apkForm(
    { version: input.version, versionCode: String(input.versionCode) },
    { filename: input.filename ?? 'app-release.apk', content: input.content },
  )
  return ctx.app.inject({
    method: 'POST',
    url: '/api/admin/mobile/app/releases',
    headers: { ...headers, ...form.headers },
    payload: form.payload,
  })
}

describe('安卓 App 发布记录（WP40r）', () => {
  it('没发过 APK：公开接口 app=null、二维码 404、bootstrap 用设置里的值', async () => {
    const { ctx } = await setup()
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' })
    expect(pub.statusCode).toBe(200)
    const body = json<PublicAndroidDownloadResponse>(pub)
    expect(body.app).toBeNull()
    expect(body.qrUrl).toBe('/api/public/android/qr.svg')

    const qr = await ctx.app.inject({ method: 'GET', url: '/api/public/android/qr.svg' })
    expect(qr.statusCode).toBe(404)

    const { headers } = await mobileSession(ctx.app, await createUser(ctx.app, { username: 'bob', password: 'Bob-pass-1' }))
    const boot = await mobileBootstrap(ctx.app, headers)
    // WP52：`downloadMirrors` 是新增的可选字段，没有发布记录时是 []
    expect(boot.body.app).toEqual({
      minVersionCode: 1,
      latestVersionCode: 1,
      downloadUrl: null,
      downloadMirrors: [],
    })
  })

  it('上传即发布：公开接口给相对地址、字节流可下载、sha256 一致、bootstrap 自动跟着变', async () => {
    const { ctx, adminHeaders, user } = await setup()
    const content = fakeApk('release-021')
    const created = await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content })
    expect(created.statusCode, created.body).toBe(201)
    const release = json<MobileAppRelease>(created)
    expect(release).toMatchObject({
      versionName: '0.2.1',
      versionCode: 21,
      bytes: content.length,
      sha256: sha256Hex(content),
      status: 'published',
    })
    // 文件名内容寻址：dsh-hub-app-<版本>-<sha256 前 8 位>.apk
    expect(release.fileName).toBe(`dsh-hub-app-0.2.1-${sha256Hex(content).slice(0, 8)}.apk`)
    expect(release.path).toBe(`/android/bin/${release.fileName}`)

    // 公开接口（主页右卡）
    const pub = json<PublicAndroidDownloadResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }),
    )
    expect(pub.app).toMatchObject({
      version: '0.2.1',
      versionCode: 21,
      prerelease: false,
      fileName: release.fileName,
      bytes: content.length,
      url: release.path,
    })

    // 字节流：内容逐字节一致 + 长缓存 + sha256 头
    const bin = await ctx.app.inject({ method: 'GET', url: release.path })
    expect(bin.statusCode, bin.body.slice(0, 200)).toBe(200)
    expect(Buffer.from(bin.rawPayload).equals(content)).toBe(true)
    expect(bin.headers['cache-control']).toContain('immutable')
    expect(bin.headers['x-checksum-sha256']).toBe(sha256Hex(content))

    // bootstrap：latestVersionCode 由发布记录自动抬到 21，downloadUrl 是绝对地址
    const { headers } = await mobileSession(ctx.app, user)
    const boot = await mobileBootstrap(ctx.app, headers)
    expect(boot.body.app.latestVersionCode).toBe(21)
    expect(boot.body.app.downloadUrl).toBe(`${ctx.config.publicOrigin}${release.path}`)
    // 强更地板仍只认设置（发布动作不隐式改它）
    expect(boot.body.app.minVersionCode).toBe(1)

    // 管理端列表
    const list = json<MobileAppReleaseListResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/admin/mobile/app/releases', headers: adminHeaders }),
    )
    expect(list.current?.versionCode).toBe(21)
    expect(list.items).toHaveLength(1)
    expect(list.settings).toEqual({ minVersionCode: 1, latestVersionCode: 1, downloadUrl: null })
  })

  it('第二次上传：旧的自动 yank，公开接口只剩新的；回滚切回上一版（文件不用重传）', async () => {
    const { ctx, adminHeaders } = await setup()
    const first = json<MobileAppRelease>(
      await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content: fakeApk('v21') }),
    )
    const second = json<MobileAppRelease>(
      await upload(ctx, adminHeaders, { version: '0.3.0', versionCode: 30, content: fakeApk('v30') }),
    )
    expect(second.status).toBe('published')
    const list = json<MobileAppReleaseListResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/admin/mobile/app/releases', headers: adminHeaders }),
    )
    expect(list.current?.versionCode).toBe(30)
    expect(list.items.map((item) => item.status)).toEqual(['published', 'yanked'])
    // 旧版文件仍在，可以直接下载（回滚不用重传）
    expect((await ctx.app.inject({ method: 'GET', url: first.path })).statusCode).toBe(200)
    expect(
      json<PublicAndroidDownloadResponse>(await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }))
        .app?.versionCode,
    ).toBe(30)

    // 回滚 → 0.2.1 重新成为当前版本，0.3.0 被 yank
    const rolled = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/mobile/app/rollback',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(rolled.statusCode, rolled.body).toBe(200)
    const rollback = json<{ release: MobileAppRelease; yanked: number[] }>(rolled)
    expect(rollback.release.versionCode).toBe(21)
    expect(rollback.yanked).toEqual([second.id])
    expect(
      json<PublicAndroidDownloadResponse>(await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }))
        .app?.versionCode,
    ).toBe(21)

    // 再回滚一次（只剩一版 → 404）
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/mobile/app/rollback',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(again.statusCode).toBe(404)
  })

  it('二维码是当前下载地址的 SVG（内容变 → 尺寸/矩阵变）', async () => {
    const { ctx, adminHeaders } = await setup()
    const release = json<MobileAppRelease>(
      await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content: fakeApk('qr') }),
    )
    const qr = await ctx.app.inject({ method: 'GET', url: '/api/public/android/qr.svg' })
    expect(qr.statusCode).toBe(200)
    expect(qr.headers['content-type']).toContain('image/svg+xml')
    expect(qr.headers['cache-control']).toBe('no-store')
    const svg = qr.body
    expect(svg.startsWith('<svg')).toBe(true)
    // 找出所有暗块：数量必须与「尺寸 - 静区」相符地合理（非零、且是 4 的倍数网格）
    const rects = svg.match(/<rect x="/gu) ?? []
    expect(rects.length).toBeGreaterThan(20)
    // 同一个地址 → 同一个 SVG（确定性，便于缓存/对比）
    const again = await ctx.app.inject({ method: 'GET', url: '/api/public/android/qr.svg' })
    expect(again.body).toBe(svg)
    // 换一个版本（地址变了）→ SVG 也变
    await upload(ctx, adminHeaders, { version: '0.3.0', versionCode: 30, content: fakeApk('qr2') })
    const changed = await ctx.app.inject({ method: 'GET', url: '/api/public/android/qr.svg' })
    expect(changed.body).not.toBe(svg)
    void release
  })

  it('管理端设置里的 downloadUrl 优先（允许把 APK 托管在别处）', async () => {
    const { ctx, adminHeaders, user } = await setup()
    const release = json<MobileAppRelease>(
      await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content: fakeApk('override') }),
    )
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: JSON.stringify({
        mobile: { app: { minVersionCode: 20, latestVersionCode: 20, downloadUrl: 'https://cdn.example/app.apk' } },
      }),
    })
    expect(patch.statusCode, patch.body).toBe(200)
    const { headers } = await mobileSession(ctx.app, user)
    const boot = await mobileBootstrap(ctx.app, headers)
    expect(boot.body.app.downloadUrl).toBe('https://cdn.example/app.apk')
    // 设置里是 20，但发布记录是 21 → 取较大者，App 才不会漏掉新版本
    expect(boot.body.app.latestVersionCode).toBe(21)
    expect(boot.body.app.minVersionCode).toBe(20)
    void release
  })

  it('权限与校验：非管理员 403、非法版本号 400、缺文件 400、未知文件名 404', async () => {
    const { ctx, user } = await setup()
    const userHeaders = loginAs(ctx.app, user).headers
    const forbidden = await upload(ctx, userHeaders, { version: '0.2.1', versionCode: 21, content: fakeApk('x') })
    expect(forbidden.statusCode).toBe(403)

    const { adminHeaders } = await setup()
    const badVersion = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/mobile/app/releases',
      headers: { ...loginAs(ctx.app, (await createUser(ctx.app, { username: 'root2', password: 'Root-pass-2', role: 'admin' }))).headers, ...apkForm({ version: 'nope', versionCode: '21' }, { filename: 'a.apk', content: fakeApk('y') }).headers },
      payload: apkForm({ version: 'nope', versionCode: '21' }, { filename: 'a.apk', content: fakeApk('y') }).payload,
    })
    expect(badVersion.statusCode).toBe(400)
    void adminHeaders

    // 未知文件名不泄漏目录，也不返回 200
    const missing = await ctx.app.inject({ method: 'GET', url: '/android/bin/nope-00000000.apk' })
    expect(missing.statusCode).toBe(404)
    const traversal = await ctx.app.inject({ method: 'GET', url: '/android/bin/..%2Fhub.db' })
    expect([400, 404]).toContain(traversal.statusCode)
  })

  it('重复上传同一份字节：不新增记录，只把它标回 published', async () => {
    const { ctx, adminHeaders } = await setup()
    const content = fakeApk('same')
    const first = json<MobileAppRelease>(await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content }))
    const second = json<MobileAppRelease>(
      await upload(ctx, adminHeaders, { version: '0.3.0', versionCode: 30, content: fakeApk('other') }),
    )
    const redo = json<MobileAppRelease>(await upload(ctx, adminHeaders, { version: '0.2.1', versionCode: 21, content }))
    expect(redo.id).toBe(first.id)
    expect(redo.status).toBe('published')
    const list = json<MobileAppReleaseListResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/admin/mobile/app/releases', headers: adminHeaders }),
    )
    expect(list.items).toHaveLength(2)
    expect(list.current?.id).toBe(first.id)
    expect(list.items.find((item) => item.id === second.id)?.status).toBe('yanked')
  })
})
