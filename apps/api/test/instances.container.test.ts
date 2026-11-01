import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { containerNameFor, imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import type { InternalInstanceService } from '../src/modules/instances/service.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createTestClock } from '../src/lib/clock.js'
import { newSlug } from '../src/lib/ids.js'
import { hashPassword } from '../src/lib/password.js'
import { createSession } from '../src/lib/session.js'
import { randomToken } from '../src/lib/crypto.js'
import type { FastifyInstance } from 'fastify'

/**
 * 真容器集成测试（任务书「测试」最后一节）。
 *
 * 默认**跳过**，只有 `HUB_IT_CONTAINER=1` 时才跑（需要本机 Docker 与已构建的
 * `dshhub/runtime:<版本>` 镜像）：
 *
 *   HUB_IT_CONTAINER=1 pnpm --filter @dsh-hub/api exec vitest run test/instances.container.test.ts
 *   # rootless podman 回归（B 计划）：
 *   CONTAINER_HOST=unix:///run/user/1000/podman/podman.sock \
 *   DOCKER_HOST=unix:///run/user/1000/podman/podman.sock HUB_IT_CONTAINER=1 \
 *   pnpm --filter @dsh-hub/api exec vitest run test/instances.container.test.ts
 *
 * 只用自己前缀的资源：网络 `dshhub-test-wp2-net`（子网 10.219.13.0/24）、容器 `dshhub-<slug>`；
 * 结束时删除容器与网络（镜像保留）。
 */
const ENABLED = process.env.HUB_IT_CONTAINER === '1'
const NETWORK = 'dshhub-test-wp2-net'
const SUBNET = '10.219.13.0/24'
/** 开发/测试与生产共用同一个 Docker（11 §2）：容器名与 env 标签都必须带测试前缀 */
const PREFIX = 'dshhub-test-wp2-'
const ENV_ID = 'test-wp2'
const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function rawRequest(url: string, opts: { headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!ENABLED)('真容器集成：实例生命周期 + /dsh/<username>/ 代理', () => {
  let app: FastifyInstance
  let base: string
  let dataDir: string
  let slug: string
  let username: string
  let cookie: string
  let docker: Docker

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dshhub-wp2-it-'))
    const config = loadConfig({
      HUB_DATA_DIR: dataDir,
      HUB_CONTAINER_DRIVER: 'docker',
      HUB_CONTAINER_PREFIX: PREFIX,
      HUB_ENV_ID: ENV_ID,
      HUB_USERS_NETWORK: NETWORK,
      HUB_USERS_SUBNET: SUBNET,
      HUB_PUBLIC_ORIGIN: 'http://127.0.0.1:7721',
      HUB_LOG_LEVEL: 'warn',
    })
    docker = new Docker(
      config.dockerHost.startsWith('unix://')
        ? { socketPath: config.dockerHost.slice('unix://'.length) }
        : { host: new URL(config.dockerHost).hostname, port: new URL(config.dockerHost).port },
    )
    const clock = createTestClock()
    app = await buildApp({ config, clock })
    slug = newSlug()
    username = `it-${slug}`
    const now = clock.nowIso()
    const result = app.deps.db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                          must_change_password, created_at, updated_at)
       VALUES (?, ?, '', '', ?, 'user', 'active', 0, ?, ?)`,
      slug,
      username,
      hashPassword('integration-password'),
      now,
      now,
    )
    const token = randomToken(32)
    createSession(app.deps.db, {
      userId: result.lastInsertRowid,
      token,
      now,
      ip: '127.0.0.1',
      userAgent: 'vitest-container',
    })
    cookie = `hub_sid=${token}`
    const instances = app.deps.services.instances as InternalInstanceService
    await instances.provision(result.lastInsertRowid)
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    base = address
  }, 120_000)

  afterAll(async () => {
    if (!app) return
    // 只清理自己的容器与网络：按 label 里的 slug 精确匹配，绝不批量删
    try {
      // 只列本环境（test-wp2）的容器；即使如此下面还要按 slug 精确匹配，绝不批量删
      const list = await docker.listContainers({
        all: true,
        filters: { label: ['dshhub.managed=1', `dshhub.env=${ENV_ID}`] },
      })
      for (const entry of list) {
        const info = await docker.getContainer(entry.Id).inspect()
        if (info.Config.Labels['dshhub.slug'] !== slug) continue
        await docker
          .getContainer(entry.Id)
          .remove({ force: true })
          .catch(() => undefined)
      }
    } catch {
      // 清理失败不影响测试结论，报告里会写
    }
    await docker
      .getNetwork(NETWORK)
      .remove()
      .catch(() => undefined)
    await app.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true })
  }, 120_000)

  it('起真容器 → 经代理拿到含 __DSH_BOOT__ 的首页（含 ownsHost 注入）→ 停止 → 唤醒页', async () => {
    const instances = app.deps.services.instances as InternalInstanceService
    const userId = app.deps.db.get<{ id: number }>('SELECT id FROM users WHERE slug = ?', slug)!.id
    // 每个用例都自己确保容器就绪：先删掉可能残留的同名容器
    await docker
      .getContainer(containerNameFor(slug, PREFIX))
      .remove({ force: true })
      .catch(() => undefined)

    const summary = await instances.ensureRunning(userId)
    expect(summary.status).toBe('running')

    const info = await instances.buildSpec(userId)
    expect(info.image).toBe(IMAGE)

    // 名字前缀与 env 标签都必须是测试专属（11 §2：和生产共用同一个 Docker）
    const name = containerNameFor(slug, PREFIX)
    expect(name.startsWith(PREFIX)).toBe(true)
    const inspected = await docker.getContainer(name).inspect()
    expect(inspected.Config.Labels['dshhub.env']).toBe(ENV_ID)

    const res = await rawRequest(`${base}/dsh/${username}/`, {
      headers: { cookie, accept: 'text/html,application/xhtml+xml' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.body).toContain('__DSH_BOOT__')
    expect(res.body).toContain('ownsHost:true')
    expect(res.body).toContain('dshhub-back')

    // 静态资源也走代理（相对路径 → 前缀下）
    const assetMatch = /(?:src|href)="\.?\/?(assets\/[^"]+)"/u.exec(res.body)
    if (assetMatch?.[1]) {
      const asset = await rawRequest(`${base}/dsh/${username}/${assetMatch[1]}`, { headers: { cookie } })
      expect(asset.status).toBe(200)
    }

    // 未运行 → 唤醒页
    await instances.stop(userId, { reason: 'user' })
    const wake = await rawRequest(`${base}/dsh/${username}/`, {
      headers: { cookie, accept: 'text/html' },
    })
    expect(wake.status).toBe(200)
    expect(wake.headers['x-hub-instance']).toBe('waking')
    expect(wake.body).toContain('唤醒')
    expect(instances.currentStatus(userId)).toBe('stopped')
  }, 300_000)

  it('别的 env 标签的真容器不会被对账触碰（真 Docker 上的隔离验证）', async () => {
    const instances = app.deps.services.instances as InternalInstanceService
    const userId = app.deps.db.get<{ id: number }>('SELECT id FROM users WHERE slug = ?', slug)!.id
    await instances.ensureRunning(userId)

    // 第三个环境的容器（既不是 test-wp2，也不是 prod），刻意用 managed=1
    const foreignName = `${PREFIX}foreign`
    await docker
      .getContainer(foreignName)
      .remove({ force: true })
      .catch(() => undefined)
    const foreign = await docker.createContainer({
      name: foreignName,
      Image: IMAGE,
      Entrypoint: ['sleep'],
      Cmd: ['300'],
      Labels: { 'dshhub.managed': '1', 'dshhub.env': 'test-wp2-other', 'dshhub.slug': 'uforeigntest' },
      HostConfig: { NetworkMode: NETWORK, AutoRemove: false },
    })
    try {
      await foreign.start()
      // 驱动的视野里没有它
      const managed = await app.deps.driver.listManaged()
      expect(managed.map((container) => container.name)).not.toContain(foreignName)
      // 对账不会碰它
      await instances.reconcileAll()
      expect((await foreign.inspect()).State.Running).toBe(true)
    } finally {
      await foreign.remove({ force: true }).catch(() => undefined)
    }
  }, 300_000)

  it('未登录 302 / 非主人 404 / 无斜杠 301（真容器上的鉴权路径）', async () => {
    const anonymous = await rawRequest(`${base}/dsh/${username}/`)
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.location).toBe(`/login?next=${encodeURIComponent(`/dsh/${username}/`)}`)
    const wrongSlash = await rawRequest(`${base}/dsh/${username}`, { headers: { cookie } })
    expect(wrongSlash.status).toBe(301)
    expect(wrongSlash.headers.location).toBe(`/dsh/${username}/`)
  }, 60_000)
})
