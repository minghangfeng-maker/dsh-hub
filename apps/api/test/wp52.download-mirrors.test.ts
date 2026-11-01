import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import type { MobileAppRelease, PublicAndroidDownloadResponse } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp } from './helpers.js'
import { mobileBootstrap, mobileSession } from './helpers-mobile.js'
import { startEdgeListener, type ListenerHandle } from '../src/server/listeners.js'

/**
 * WP52 下载镜像（08 §3）：
 *
 * - `bootstrap.app.downloadMirrors` 与 `GET /api/public/android/download` 的 `app.mirrors`
 *   是同一个 APK 的全部可用地址，**本入口排第一**、另一个入口第二、去重；
 * - 没有发布记录时是 `[]`；
 * - 未配置边缘入口时只有公网入口一条（`HUB_EDGE_PORT=0` 不新增海外地址）。
 */

const PUBLIC_ORIGIN = 'https://hub.example.com:8123'
const PUBLIC_ASSETS = 'https://hub.example.com:8124/downloads'
const EDGE_ORIGIN = 'https://edge.example.com'
const EDGE_ASSETS = 'https://edge.example.com/downloads'

interface Setup {
  ctx: TestApp
  edge: ListenerHandle | null
  adminHeaders: Record<string, string>
  base: string
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function setup(env: Record<string, string> = {}): Promise<Setup> {
  const edgeDisabled = env['HUB_EDGE_PORT'] === '0'
  const edgePort = edgeDisabled ? 0 : await freePort()
  const merged: Record<string, string> = {
    HUB_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HUB_PUBLIC_ASSETS_ORIGIN: PUBLIC_ASSETS,
    HUB_EDGE_ORIGIN: EDGE_ORIGIN,
    HUB_EDGE_ASSETS_ORIGIN: EDGE_ASSETS,
    ...env,
  }
  if (!edgeDisabled) merged.HUB_EDGE_PORT = String(edgePort)
  const ctx = await createTestApp({ env: merged })
  const edge = edgeDisabled ? null : await startEdgeListener(ctx.app, ctx.config)
  const admin = await createUser(ctx.app, { username: 'root', password: 'Root-pass-1', role: 'admin' })
  const adminHeaders = loginAs(ctx.app, admin).headers
  cleanups.push(async () => {
    if (edge) await edge.close()
    await ctx.close()
  })
  return {
    ctx,
    edge,
    adminHeaders,
    base: edge ? `http://127.0.0.1:${String(edge.port)}` : '',
  }
}

/** 最小 multipart：一个 APK 文件 + version / versionCode 两个字段 */
async function uploadApk(ctx: TestApp, adminHeaders: Record<string, string>): Promise<MobileAppRelease> {
  const boundary = '----wp52mirrortest'
  const chunks: Buffer[] = []
  for (const [name, value] of [
    ['version', '0.4.11'],
    ['versionCode', '51'],
  ] as const) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="app-release.apk"\r\n` +
        'Content-Type: application/vnd.android.package-archive\r\n\r\n',
    ),
  )
  chunks.push(Buffer.from('PK\u0003\u0004wp52-mirror'.padEnd(512, 'x')))
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/mobile/app/releases',
    headers: { ...adminHeaders, 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-hub-csrf': '1' },
    payload: Buffer.concat(chunks),
  })
  expect(res.statusCode, res.body).toBe(201)
  return json<MobileAppRelease>(res)
}

/** 经边缘端口的 GET（带合法 X-Real-IP） */
async function edgeGet(base: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { ...headers, 'x-real-ip': '203.0.113.7' } })
}

async function edgeJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('下载镜像：本入口第一、另一个入口第二（08 §3）', () => {
  it('没有发布记录时 mirrors 是 []（老 App 只看到 downloadUrl）', async () => {
    const { ctx, base } = await setup()
    const pub = json<PublicAndroidDownloadResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }),
    )
    expect(pub.app).toBeNull()

    const user = await createUser(ctx.app, { username: 'bob', password: 'Bob-pass-1' })
    const { headers } = await mobileSession(ctx.app, user)
    expect((await mobileBootstrap(ctx.app, headers)).body.app.downloadMirrors).toEqual([])

    const edgeRes = await edgeGet(base, '/api/mobile/bootstrap', headers)
    const edgeBody = (await edgeRes.json()) as { app: { downloadMirrors?: string[] } }
    expect(edgeBody.app.downloadMirrors).toEqual([])
  })

  it('经边缘入口：url / downloadUrl / mirrors 都以边缘入口开头（镜像顺序 SG → GZ）', async () => {
    const { ctx, base, adminHeaders } = await setup()
    const release = await uploadApk(ctx, adminHeaders)
    const sgUrl = `${EDGE_ASSETS}/mobile-app/${release.fileName}`
    const gzUrl = `${PUBLIC_ASSETS}/mobile-app/${release.fileName}`

    const pubEdge = await edgeJson<PublicAndroidDownloadResponse>(await edgeGet(base, '/api/public/android/download'))
    expect(pubEdge.app?.url).toBe(sgUrl)
    expect(pubEdge.app?.mirrors).toEqual([sgUrl, gzUrl])

    const user = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
    const { headers } = await mobileSession(ctx.app, user)
    const bootEdge = (await (await edgeGet(base, '/api/mobile/bootstrap', headers)).json()) as {
      app: { downloadUrl: string; downloadMirrors: string[] }
    }
    expect(bootEdge.app.downloadUrl).toBe(sgUrl)
    expect(bootEdge.app.downloadMirrors).toEqual([sgUrl, gzUrl])

    // 同一个 APK 在本机也可以下载（镜像只是换个地址，不是另一份文件）
    const bin = await ctx.app.inject({ method: 'GET', url: release.path })
    expect(bin.statusCode).toBe(200)
  })

  it('经 7700：url / downloadUrl / mirrors 仍以公网入口开头（镜像顺序 GZ → SG）', async () => {
    const { ctx, adminHeaders } = await setup()
    const release = await uploadApk(ctx, adminHeaders)
    const gzUrl = `${PUBLIC_ASSETS}/mobile-app/${release.fileName}`
    const sgUrl = `${EDGE_ASSETS}/mobile-app/${release.fileName}`

    const pub = json<PublicAndroidDownloadResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }),
    )
    expect(pub.app?.url).toBe(gzUrl)
    expect(pub.app?.mirrors).toEqual([gzUrl, sgUrl])

    const user = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
    const { headers } = await mobileSession(ctx.app, user)
    const boot = await mobileBootstrap(ctx.app, headers)
    expect(boot.body.app.downloadUrl).toBe(gzUrl)
    expect(boot.body.app.downloadMirrors).toEqual([gzUrl, sgUrl])
  })

  it('边缘入口没配资产基址时用 HUB_EDGE_ORIGIN + 相对路径', async () => {
    const { ctx, base, adminHeaders } = await setup({ HUB_EDGE_ASSETS_ORIGIN: '' })
    const release = await uploadApk(ctx, adminHeaders)
    const sgUrl = `${EDGE_ORIGIN}${release.path}`
    const gzUrl = `${PUBLIC_ASSETS}/mobile-app/${release.fileName}`

    const pub = await edgeJson<PublicAndroidDownloadResponse>(await edgeGet(base, '/api/public/android/download'))
    expect(pub.app?.url).toBe(release.path) // 边缘入口自己提供 /android/bin/*
    expect(pub.app?.mirrors).toEqual([sgUrl, gzUrl])

    const user = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
    const { headers } = await mobileSession(ctx.app, user)
    const boot = (await (await edgeGet(base, '/api/mobile/bootstrap', headers)).json()) as {
      app: { downloadUrl: string; downloadMirrors: string[] }
    }
    expect(boot.app.downloadUrl).toBe(sgUrl)
    expect(boot.app.downloadMirrors).toEqual([sgUrl, gzUrl])
  })

  it('两个入口资产基址相同 → 去重成一条', async () => {
    const { ctx, base, adminHeaders } = await setup({ HUB_EDGE_ASSETS_ORIGIN: PUBLIC_ASSETS })
    const release = await uploadApk(ctx, adminHeaders)
    const url = `${PUBLIC_ASSETS}/mobile-app/${release.fileName}`

    const pub = await edgeJson<PublicAndroidDownloadResponse>(await edgeGet(base, '/api/public/android/download'))
    expect(pub.app?.mirrors).toEqual([url])
  })

  it('HUB_EDGE_PORT=0：只下发公网入口一条（不新增海外地址）', async () => {
    const { ctx, adminHeaders } = await setup({ HUB_EDGE_PORT: '0', HUB_EDGE_ORIGIN: '', HUB_EDGE_ASSETS_ORIGIN: '' })
    const release = await uploadApk(ctx, adminHeaders)
    const gzUrl = `${PUBLIC_ASSETS}/mobile-app/${release.fileName}`

    const pub = json<PublicAndroidDownloadResponse>(
      await ctx.app.inject({ method: 'GET', url: '/api/public/android/download' }),
    )
    expect(pub.app?.url).toBe(gzUrl)
    expect(pub.app?.mirrors).toEqual([gzUrl])

    const user = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
    const { headers } = await mobileSession(ctx.app, user)
    const boot = await mobileBootstrap(ctx.app, headers)
    expect(boot.body.app.downloadMirrors).toEqual([gzUrl])
  })
})
