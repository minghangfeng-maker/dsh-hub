import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublicDesktopDownloadResponseSchema } from '@dsh-hub/shared'
import type { FastifyInstance } from 'fastify'
import { createTestApp, type TestApp } from './helpers.js'
import { insertRelease } from '../src/modules/desktop-delivery/repo.js'

/**
 * 公开主页的安装包信息（WP36）：`GET /api/public/desktop/download`。
 *
 * 口径：`desktop_releases` 里 `win-x64` 最新一条 **published** 记录，优先 `latest` 通道，
 * 没有才退到 `nightly`；撤回（yanked）的不算，其它 target 不算。免登录、按 IP 限流。
 */
let ctx: TestApp
let app: FastifyInstance

const DB = (): FastifyInstance['deps']['db'] => app.deps.db

interface SeedOptions {
  target?: string
  channel?: 'latest' | 'nightly'
  version?: string
  status?: 'published' | 'yanked'
  bytes?: number
  uploadedAt?: string
}

let seedSeq = 0

/** 直接写 `desktop_releases`（上传接口要 multipart，这里只验证读取口径） */
function seed(options: SeedOptions = {}): number {
  seedSeq += 1
  const channel = options.channel ?? 'nightly'
  const version = options.version ?? '0.2.1-rc.2'
  const fileName = `DSH-Hub-Setup-${version}.exe`
  const id = insertRelease(DB(), {
    target: options.target ?? 'win-x64',
    channel,
    version,
    installerFile: fileName,
    installerBytes: options.bytes ?? 376_438_784,
    installerSha512: 'c2hhNTEyLXRlc3Q=',
    blockmapFile: null,
    blockmapBytes: null,
    blockmapSha512: null,
    feedFile: channel === 'latest' ? 'latest.yml' : 'nightly.yml',
    yaml: `version: ${version}\nfiles:\n  - url: ${fileName}\n`,
    actorId: null,
    at: options.uploadedAt ?? `2026-10-23T00:00:0${String(seedSeq % 10)}.000Z`,
  })
  if (options.status === 'yanked') {
    DB().run("UPDATE desktop_releases SET status = 'yanked' WHERE id = ?", id)
  }
  return id
}

async function getDownload() {
  return app.inject({ method: 'GET', url: '/api/public/desktop/download' })
}

beforeEach(async () => {
  seedSeq = 0
  ctx = await createTestApp()
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
})

describe('GET /api/public/desktop/download（WP36）', () => {
  it('没有任何发布记录：windows / android 都是 null', async () => {
    const response = await getDownload()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(PublicDesktopDownloadResponseSchema.parse(response.json())).toEqual({
      windows: null,
      android: null,
    })
  })

  it('只有 nightly：返回 nightly，预发布版本 prerelease=true', async () => {
    seed({ channel: 'nightly', version: '0.2.1-rc.2' })

    const body = PublicDesktopDownloadResponseSchema.parse((await getDownload()).json())
    expect(body.windows).toEqual({
      version: '0.2.1-rc.2',
      channel: 'nightly',
      prerelease: true,
      fileName: 'DSH-Hub-Setup-0.2.1-rc.2.exe',
      bytes: 376_438_784,
      url: '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1-rc.2.exe',
      publishedAt: '2026-10-23T00:00:01.000Z',
      portable: null,
    })
    expect(body.android).toBeNull()
  })

  it('latest 与 nightly 都有（nightly 更晚）：latest 优先，且正式版 prerelease=false', async () => {
    seed({ channel: 'latest', version: '0.2.0' })
    seed({ channel: 'nightly', version: '0.2.1-rc.2' })

    const body = PublicDesktopDownloadResponseSchema.parse((await getDownload()).json())
    expect(body.windows?.channel).toBe('latest')
    expect(body.windows?.version).toBe('0.2.0')
    expect(body.windows?.prerelease).toBe(false)
    expect(body.windows?.url).toBe('/desktop/bin/win-x64/DSH-Hub-Setup-0.2.0.exe')
  })

  it('撤回（yanked）的不算：latest 被撤回后退到 nightly', async () => {
    seed({ channel: 'latest', version: '0.2.0', status: 'yanked' })
    seed({ channel: 'nightly', version: '0.2.1-rc.2' })

    const body = PublicDesktopDownloadResponseSchema.parse((await getDownload()).json())
    expect(body.windows?.channel).toBe('nightly')
    expect(body.windows?.version).toBe('0.2.1-rc.2')
  })

  it('全部撤回 → null；其它 target（mac）不算', async () => {
    seed({ target: 'mac-arm64', channel: 'latest', version: '0.2.0' })
    seed({ channel: 'latest', version: '0.2.0', status: 'yanked' })
    seed({ channel: 'nightly', version: '0.2.1-rc.2', status: 'yanked' })

    expect((await getDownload()).json()).toEqual({ windows: null, android: null })
  })

  it('同通道里取最后发布的一条（id 最大）', async () => {
    seed({ channel: 'latest', version: '0.1.0' })
    seed({ channel: 'latest', version: '0.2.0' })
    seed({ channel: 'latest', version: '0.1.9' })

    const body = PublicDesktopDownloadResponseSchema.parse((await getDownload()).json())
    expect(body.windows?.version).toBe('0.1.9')
  })

  it('匿名端点按 IP 限流：第 121 次请求 429', async () => {
    for (let index = 0; index < 120; index += 1) {
      expect((await getDownload()).statusCode).toBe(200)
    }
    const blocked = await getDownload()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error.code).toBe('RATE_LIMITED')
  })
})
