import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  CreateExportResponse,
  ExportEstimateResponse,
  ExportItem,
  ExportListResponse,
} from '@dsh-hub/shared'
import { createUser, json, loginAs, type TestSession } from './helpers.js'
import { cleanupDirs, connectSse, createWp4App, waitFor, type Wp4TestApp } from './helpers-wp4.js'
import { readZip } from './zipfile.js'

/** 04 §3.3 数据导出：estimate / create / list / events / download(Range) / delete + 清理 */
let ctx: Wp4TestApp
let app: FastifyInstance
let alice: TestSession
let bob: TestSession

beforeEach(async () => {
  ctx = await createWp4App()
  app = ctx.app
  const aliceUser = await createUser(app, { username: 'alice', displayName: 'Alice' })
  const bobUser = await createUser(app, { username: 'bob' })
  alice = loginAs(app, aliceUser)
  bob = loginAs(app, bobUser)
  seedUserData(ctx.dataDir, alice.user.slug)
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs([])
})

function userRoot(slug: string): string {
  return join(ctx.dataDir, 'users', slug)
}

function seedUserData(dataDir: string, slug: string): void {
  const root = join(dataDir, 'users', slug)
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'home', '.dsh')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(dshHome, 'sessions'), { recursive: true })
  mkdirSync(join(dshHome, 'attachments'), { recursive: true })
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(dshHome, 'storages'), { recursive: true })

  writeFileSync(join(workspace, 'README.md'), '# 工作区\n')
  writeFileSync(join(workspace, 'docs', 'a.txt'), 'aaa\n')
  writeFileSync(join(workspace, '.env'), 'SECRET=1\n')
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'x\n')
  writeFileSync(join(dshHome, 'sessions', 's1.json'), '{"id":"s1"}\n')
  writeFileSync(join(dshHome, 'attachments', 'a.bin'), 'bin\n')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'token: top-secret\n')
  writeFileSync(join(dshHome, 'storages', 'st.json'), '{"k":1}\n')
  writeFileSync(
    join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dependencies: { 'dsh-email': '1.0.0' } }),
  )
  writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'patch: []\n')
  symlinkSync('/etc/passwd', join(workspace, 'link-out'))
  symlinkSync('docs/a.txt', join(workspace, 'link-in'))
}

async function listExports(session: TestSession): Promise<ExportListResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/me/exports', headers: session.headers })
  expect(res.statusCode).toBe(200)
  return json<ExportListResponse>(res)
}

async function itemOf(session: TestSession, exportId: number) {
  const body = await listExports(session)
  return body.items.find((item) => item.id === exportId) ?? null
}

async function createExport(
  session: TestSession,
  body: { parts: string[]; format?: string },
): Promise<CreateExportResponse['export']> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/me/exports',
    headers: session.headers,
    payload: body,
  })
  expect(res.statusCode).toBe(202)
  return json<CreateExportResponse>(res).export
}

async function waitReady(session: TestSession, exportId: number): Promise<ExportItem> {
  return waitFor(
    async () => {
      const item = await itemOf(session, exportId)
      if (!item) throw new Error('导出记录不存在')
      // 抛错 = 继续等（waitFor 会重试）
      if (item.status === 'queued' || item.status === 'running') throw new Error('导出进行中')
      return item
    },
    { label: `导出 ${exportId} 结束` },
  )
}

describe('导出接口 · 估算与创建', () => {
  it('未登录 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me/exports' })
    expect(res.statusCode).toBe(401)
  })

  it('estimate 递归统计并缓存 60s，时钟前进后重新统计', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/me/exports/estimate?parts=workspace,sessions',
      headers: alice.headers,
    })
    expect(first.statusCode).toBe(200)
    const estimate = json<ExportEstimateResponse>(first)
    expect(Object.keys(estimate.parts).sort()).toEqual(['sessions', 'workspace'])
    expect(estimate.parts.workspace!.files).toBeGreaterThanOrEqual(3)
    expect(estimate.totalBytes).toBe(estimate.parts.workspace!.bytes + estimate.parts.sessions!.bytes)

    // 缓存命中：新文件不会立刻反映
    writeFileSync(join(userRoot(alice.user.slug), 'workspace', 'new.txt'), 'x'.repeat(1000))
    const cached = json<ExportEstimateResponse>(
      await app.inject({
        method: 'GET',
        url: '/api/me/exports/estimate?parts=workspace,sessions',
        headers: alice.headers,
      }),
    )
    expect(cached.parts.workspace!.bytes).toBe(estimate.parts.workspace!.bytes)

    ctx.clock.advance(61_000)
    const refreshed = json<ExportEstimateResponse>(
      await app.inject({
        method: 'GET',
        url: '/api/me/exports/estimate?parts=workspace,sessions',
        headers: alice.headers,
      }),
    )
    expect(refreshed.parts.workspace!.bytes).toBe(estimate.parts.workspace!.bytes + 1000)

    // 四个 part 都能估算：profile-plugins 在同时选了 settings 时只贡献 manifest（0 字节文件条目）
    const allParts = json<ExportEstimateResponse>(
      await app.inject({
        method: 'GET',
        url: '/api/me/exports/estimate?parts=settings,profile-plugins',
        headers: alice.headers,
      }),
    )
    expect(Object.keys(allParts.parts).sort()).toEqual(['profile-plugins', 'settings'])
    expect(allParts.parts.settings!.files).toBeGreaterThanOrEqual(3)

    const pluginsOnly = json<ExportEstimateResponse>(
      await app.inject({
        method: 'GET',
        url: '/api/me/exports/estimate?parts=profile-plugins',
        headers: alice.headers,
      }),
    )
    expect(pluginsOnly.parts['profile-plugins']!.files).toBe(1)

    const bad = await app.inject({
      method: 'GET',
      url: '/api/me/exports/estimate?parts=bogus',
      headers: alice.headers,
    })
    expect(bad.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('VALIDATION_FAILED')
  })

  it('create 建任务并最终 ready，list 返回 sha256/大小/进度为空', async () => {
    const created = await createExport(alice, {
      parts: ['workspace', 'sessions', 'settings', 'profile-plugins'],
      format: 'zip',
    })
    expect(created.fileName).toMatch(/^dsh-alice-\d{8}-\d{4}\.zip$/)
    expect(created.status).toBe('queued')
    expect(created.sha256).toBeNull()

    const ready = await waitReady(alice, created.id)
    expect(ready.status).toBe('ready')
    expect(ready.sizeBytes).toBeGreaterThan(0)
    expect(ready.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ready.progress).toBeNull()
    expect(ready.expiresAt).not.toBeNull()

    // 落盘名是 <exportId>.zip（03 §2），下载名才是 file_name
    const filePath = join(ctx.dataDir, 'exports', alice.user.slug, `${created.id}.zip`)
    expect(existsSync(filePath)).toBe(true)
  })

  it('同一用户同时只能有一个导出（CONFLICT），每日次数超限 429', async () => {
    const first = await createExport(alice, { parts: ['workspace'] })
    await waitReady(alice, first.id)

    // 手工插一条「进行中」的导出 → 再创建应 409
    app.deps.db.run(
      `INSERT INTO exports (user_id, parts_json, format, status, file_name, created_at)
       VALUES (?, '["workspace"]', 'zip', 'running', 'x.zip', ?)`,
      alice.user.id,
      ctx.clock.nowIso(),
    )
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/me/exports',
      headers: alice.headers,
      payload: { parts: ['workspace'], format: 'zip' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe('CONFLICT')
    app.deps.db.run("DELETE FROM exports WHERE file_name = 'x.zip'")

    app.deps.settings.set('exports', { ttlHours: 24, maxBytes: 21474836480, dailyLimit: 1 })
    const limited = await app.inject({
      method: 'POST',
      url: '/api/me/exports',
      headers: alice.headers,
      payload: { parts: ['workspace'], format: 'zip' },
    })
    expect(limited.statusCode).toBe(429)
    expect(json<{ error: { code: string } }>(limited).error.code).toBe('EXPORT_LIMIT')
  })

  it('超过 maxBytes 时导出失败（EXPORT_TOO_LARGE，job 也失败）', async () => {
    app.deps.settings.set('exports', { ttlHours: 24, maxBytes: 8, dailyLimit: 5 })
    const created = await createExport(alice, { parts: ['workspace'] })
    const failed = await waitReady(alice, created.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('过大')

    const jobs = await app.deps.db.all<{ status: string; error: string | null }>(
      'SELECT status, error FROM jobs ORDER BY id DESC LIMIT 1',
    )
    expect(jobs[0]!.status).toBe('failed')
  })

  it('请求体不合法 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/exports',
      headers: alice.headers,
      payload: { parts: [], format: 'zip' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('导出接口 · 下载与删除', () => {
  it('下载返回 RFC 5987 文件名、sha256 头，支持 Range 续传', async () => {
    const created = await createExport(alice, { parts: ['workspace', 'sessions', 'settings'] })
    const ready = await waitReady(alice, created.id)

    const full = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: alice.headers,
    })
    expect(full.statusCode).toBe(200)
    expect(full.headers['content-type']).toContain('application/zip')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(String(full.headers['content-disposition'])).toContain("filename*=UTF-8''")
    const body = full.rawPayload
    expect(body.length).toBe(ready.sizeBytes)
    expect(full.headers['x-hub-sha256']).toBe(ready.sha256)

    // ZIP 结构符合 06 §6，且能被解压校验
    const entries = readZip(body)
    const names = entries.map((entry) => entry.name)
    const root = ready.fileName!.replace(/\.zip$/, '')
    expect(names).toContain(`${root}/README.txt`)
    expect(names).toContain(`${root}/manifest.json`)
    expect(names).toContain(`${root}/workspace/README.md`)
    expect(names).toContain(`${root}/workspace/docs/a.txt`)
    expect(names).toContain(`${root}/dsh/sessions/s1.json`)
    expect(names).toContain(`${root}/dsh/attachments/a.bin`)
    expect(names).toContain(`${root}/dsh/settings/profile/package.json`)
    expect(names).toContain(`${root}/dsh/settings/storages/st.json`)
    expect(names.some((name) => name.includes('node_modules'))).toBe(false)
    expect(names.some((name) => name.includes('.credentials.yaml'))).toBe(false)
    expect(names.some((name) => name.endsWith('.env'))).toBe(false)
    expect(names).not.toContain(`${root}/workspace/link-out`)

    const manifest = JSON.parse(
      entries.find((entry) => entry.name.endsWith('manifest.json'))!.data.toString('utf8'),
    ) as { skipped: { path: string; reason: string }[] }
    expect(manifest.skipped.map((entry) => entry.path)).toContain('workspace/link-out')
    const readme = entries.find((entry) => entry.name.endsWith('README.txt'))!.data.toString('utf8')
    expect(readme).toContain('如何在本机 DSH 里使用这些会话文件')

    // 断点续传：Range 与整包 sha256 一致
    const partial = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: { ...alice.headers, range: 'bytes=0-99' },
    })
    expect(partial.statusCode).toBe(206)
    expect(partial.headers['content-range']).toBe(`bytes 0-99/${ready.sizeBytes}`)
    expect(partial.rawPayload.length).toBe(100)
    expect(partial.rawPayload.equals(body.subarray(0, 100))).toBe(true)
    expect(partial.headers['x-hub-sha256']).toBe(ready.sha256)

    const tail = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: { ...alice.headers, range: 'bytes=-50' },
    })
    expect(tail.statusCode).toBe(206)
    expect(tail.rawPayload.equals(body.subarray(body.length - 50))).toBe(true)

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: { ...alice.headers, range: 'bytes=999999999-' },
    })
    expect(invalid.statusCode).toBe(416)

    const after = await itemOf(alice, created.id)
    expect(after?.downloaded).toBe(true)
  })

  it('同一分钟内两次导出互不覆盖（落盘名按 exportId）', async () => {
    app.deps.settings.set('exports', { ttlHours: 24, maxBytes: 21474836480, dailyLimit: 5 })
    const first = await createExport(alice, { parts: ['workspace'] })
    const firstReady = await waitReady(alice, first.id)
    const second = await createExport(alice, { parts: ['sessions'] })
    const secondReady = await waitReady(alice, second.id)

    // 两次导出的下载名（分钟级时间戳）相同是可能的，但落盘名不同，互不覆盖
    expect(firstReady.fileName).toBe(secondReady.fileName)
    const firstPath = join(ctx.dataDir, 'exports', alice.user.slug, `${first.id}.zip`)
    const secondPath = join(ctx.dataDir, 'exports', alice.user.slug, `${second.id}.zip`)
    expect(existsSync(firstPath)).toBe(true)
    expect(existsSync(secondPath)).toBe(true)

    const firstDownload = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${first.id}/download`,
      headers: alice.headers,
    })
    expect(firstDownload.statusCode).toBe(200)
    const names = readZip(firstDownload.rawPayload).map((entry) => entry.name)
    const firstRoot = firstReady.fileName!.replace(/\.zip$/, '')
    expect(names).toContain(`${firstRoot}/workspace/README.md`)
    expect(names.some((name) => name.includes('sessions'))).toBe(false)
  })

  it('别人的导出 id 一律 404（下载 / 删除 / SSE）', async () => {
    const created = await createExport(alice, { parts: ['workspace'] })
    await waitReady(alice, created.id)

    const download = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: bob.headers,
    })
    expect(download.statusCode).toBe(404)
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/me/exports/${created.id}`,
      headers: bob.headers,
    })
    expect(remove.statusCode).toBe(404)
    const events = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/events`,
      headers: bob.headers,
    })
    expect(events.statusCode).toBe(404)
  })

  it('delete 删文件与记录；进行中的导出不允许删', async () => {
    const created = await createExport(alice, { parts: ['workspace'] })
    const ready = await waitReady(alice, created.id)
    const filePath = join(ctx.dataDir, 'exports', alice.user.slug, `${created.id}.zip`)
    expect(ready.fileName).toMatch(/^dsh-alice-\d{8}-\d{4}\.zip$/)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/me/exports/${created.id}`,
      headers: alice.headers,
    })
    expect(del.statusCode).toBe(204)
    expect(existsSync(filePath)).toBe(false)
    expect(await itemOf(alice, created.id)).toBeNull()

    const again = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: alice.headers,
    })
    expect(again.statusCode).toBe(404)

    const running = app.deps.db.run(
      `INSERT INTO exports (user_id, parts_json, format, status, file_name, created_at)
       VALUES (?, '["workspace"]', 'zip', 'running', 'busy.zip', ?)`,
      alice.user.id,
      ctx.clock.nowIso(),
    ).lastInsertRowid
    const busy = await app.inject({
      method: 'DELETE',
      url: `/api/me/exports/${running}`,
      headers: alice.headers,
    })
    expect(busy.statusCode).toBe(409)
    expect(json<{ error: { code: string } }>(busy).error.code).toBe('CONFLICT')
  })

  it('过期清理：文件删除、状态 expired、下载 404', async () => {
    const created = await createExport(alice, { parts: ['workspace'] })
    await waitReady(alice, created.id)
    const filePath = join(ctx.dataDir, 'exports', alice.user.slug, `${created.id}.zip`)
    expect(existsSync(filePath)).toBe(true)

    ctx.clock.advance(25 * 3_600_000)
    const cleaned = await app.deps.services.exports.cleanupExpired()
    expect(cleaned).toBeGreaterThanOrEqual(1)

    const expired = await itemOf(alice, created.id)
    expect(expired?.status).toBe('expired')
    expect(existsSync(filePath)).toBe(false)

    const download = await app.inject({
      method: 'GET',
      url: `/api/me/exports/${created.id}/download`,
      headers: alice.headers,
    })
    expect(download.statusCode).toBe(404)

    // 清理定时器可重复执行（幂等）
    expect(await app.deps.services.exports.cleanupExpired()).toBe(0)
  })
})

describe('导出接口 · SSE', () => {
  it('已完成的导出连上就收到 done 并关闭', async () => {
    const created = await createExport(alice, { parts: ['workspace'] })
    await waitReady(alice, created.id)
    const probe = await connectSse(app, `/api/me/exports/${created.id}/events`, alice.headers)
    try {
      await probe.waitFor('event: done')
      await probe.waitFor('"status":"ready"')
    } finally {
      await probe.close()
    }
  })

  it('进行中的导出转发 progress / done 事件', async () => {
    const exportId = app.deps.db.run(
      `INSERT INTO exports (user_id, parts_json, format, status, file_name, created_at)
       VALUES (?, '["workspace"]', 'zip', 'running', 'running.zip', ?)`,
      alice.user.id,
      ctx.clock.nowIso(),
    ).lastInsertRowid

    const probe = await connectSse(app, `/api/me/exports/${exportId}/events`, alice.headers)
    try {
      app.deps.events.emit('export.progress', {
        userId: alice.user.id,
        exportId,
        progress: { bytesWritten: 10, filesDone: 1, filesTotal: 3 },
      })
      await probe.waitFor('event: progress')
      await probe.waitFor('"filesTotal":3')

      app.deps.events.emit('export.failed', {
        userId: alice.user.id,
        exportId,
        error: { code: 'INTERNAL', message: '打包失败' },
      })
      await probe.waitFor('event: failed')
      await probe.waitFor('打包失败')
    } finally {
      await probe.close()
    }
  })

  it('失败的导出连上就收到 failed', async () => {
    app.deps.settings.set('exports', { ttlHours: 24, maxBytes: 8, dailyLimit: 5 })
    const created = await createExport(alice, { parts: ['workspace'] })
    await waitReady(alice, created.id)
    const probe = await connectSse(app, `/api/me/exports/${created.id}/events`, alice.headers)
    try {
      await probe.waitFor('event: failed')
    } finally {
      await probe.close()
    }
  })
})

describe('导出文件系统', () => {
  it('清理 *.part 临时文件（超过 1 小时）', async () => {
    const dir = join(ctx.dataDir, 'exports', alice.user.slug)
    mkdirSync(dir, { recursive: true })
    const partFile = join(dir, 'stale.zip.part')
    writeFileSync(partFile, 'partial')
    // 把 mtime 改老（fs.utimes 用真实时间）
    const { utimesSync } = await import('node:fs')
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(partFile, old, old)

    const cleaned = await app.deps.services.exports.cleanupExpired()
    expect(cleaned).toBe(1)
    expect(existsSync(partFile)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
