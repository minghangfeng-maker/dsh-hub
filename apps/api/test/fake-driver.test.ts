import { get } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTAINER_LABEL_MANAGED } from '@dsh-hub/shared'
import { createTestClock } from '../src/lib/clock.js'
import { FakeDriver, type FakeDshRequest } from '../src/modules/instances/fake-driver.js'
import type { ContainerSpec } from '../src/modules/instances/types.js'

const drivers: FakeDriver[] = []

function makeDriver(): FakeDriver {
  const driver = new FakeDriver({ clock: createTestClock() })
  drivers.push(driver)
  return driver
}

function spec(name = 'dshhub-u7k2m9xz'): ContainerSpec {
  return {
    name,
    image: 'dshhub/runtime:0.2.0-rc.2',
    env: { DSH_AUTHORITY: `${name}:3000` },
    labels: { [CONTAINER_LABEL_MANAGED]: '1', 'dshhub.slug': 'u7k2m9xz' },
    mounts: [],
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 1024,
    network: 'dshhub-users',
    readOnlyRootfs: true,
    tmpfs: { '/tmp': 'rw,size=512m,nosuid,nodev' },
  }
}

/** 用 node:http 而不是 fetch：不受 shell 里 http_proxy 环境变量影响 */
function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
  })
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.dispose()
})

describe('FakeDriver 状态机（05 §8）', () => {
  it('ping / ensureNetwork / 网络子网校验', async () => {
    const driver = makeDriver()
    expect(await driver.ping()).toEqual({ ok: true, version: 'fake-1.0' })
    await driver.ensureNetwork('dshhub-users', '10.213.0.0/20')
    expect(driver.getNetwork()).toEqual({ name: 'dshhub-users', subnet: '10.213.0.0/20' })
    await expect(driver.ensureNetwork('x', 'not-a-subnet')).rejects.toThrow(/子网不合法/)
  })

  it('create → inspect → start → stats → stop → remove', async () => {
    const driver = makeDriver()
    const { id } = await driver.create(spec())
    expect(id).toMatch(/^fake[0-9a-f]{12}$/)

    const created = await driver.inspect('dshhub-u7k2m9xz')
    expect(created).toMatchObject({ state: 'created', ip: null, labels: { [CONTAINER_LABEL_MANAGED]: '1' } })
    expect(await driver.stats('dshhub-u7k2m9xz')).toBeNull()

    await driver.start('dshhub-u7k2m9xz')
    const running = await driver.inspect('dshhub-u7k2m9xz')
    expect(running).toMatchObject({ state: 'running', ip: '127.0.0.1' })
    expect(running?.startedAt).toBe('2026-10-12T13:00:00.000Z')

    const stats = await driver.stats('dshhub-u7k2m9xz')
    expect(stats).toMatchObject({ cpuPercent: 1.5, memoryLimitBytes: 2048 * 1024 * 1024, pids: 7 })

    await driver.restart('dshhub-u7k2m9xz', 15)
    expect((await driver.inspect('dshhub-u7k2m9xz'))?.state).toBe('running')

    await driver.stop('dshhub-u7k2m9xz', 15)
    const stopped = await driver.inspect('dshhub-u7k2m9xz')
    expect(stopped).toMatchObject({ state: 'exited', exitCode: 0, ip: null })

    await driver.remove('dshhub-u7k2m9xz')
    expect(await driver.inspect('dshhub-u7k2m9xz')).toBeNull()
    await expect(driver.start('dshhub-u7k2m9xz')).rejects.toThrow(/容器不存在/)
  })

  it('重复 create 报 CONFLICT；listManaged 只列 managed 容器', async () => {    const driver = makeDriver()
    await driver.create(spec())
    await expect(driver.create(spec())).rejects.toThrow(/容器已存在/)
    await driver.create({ ...spec('dshhub-other'), labels: {} })
    const managed = await driver.listManaged()
    expect(managed.map((c) => c.name)).toEqual(['dshhub-u7k2m9xz'])
  })

  // WP8b B1：一次性维护容器（插件下发 / 依赖重装）可能在用户网络还不存在时创建
  // ——驱动必须先 `ensureNetwork`，而不是让 createContainer 报 `network … not found`
  it('runOnce 带 networkSubnet 时先建用户网络；内建网络（none）不建', async () => {
    const driver = makeDriver()
    const userSpec: ContainerSpec = { ...spec(), networkSubnet: '10.219.21.0/24' }
    expect(driver.getNetwork()).toBeNull()
    await driver.runOnce(userSpec, ['dsh', '--version'])
    expect(driver.getNetwork()).toEqual({ name: 'dshhub-users', subnet: '10.219.21.0/24' })

    const other = makeDriver()
    await other.runOnce({ ...spec(), network: 'none' }, ['dsh', '--version'])
    expect(other.getNetwork()).toBeNull()
  })

  it('exec / runOnce / logs / followLogs', async () => {
    const driver = makeDriver()
    await driver.create(spec())
    await driver.start('dshhub-u7k2m9xz')
    const exec = await driver.exec('dshhub-u7k2m9xz', ['sh', '-lc', 'echo hi'])
    expect(exec.exitCode).toBe(0)
    expect(exec.output).toContain('echo hi')

    driver.setExecHandler((_name, cmd) => ({ exitCode: cmd.includes('fail') ? 1 : 0, output: cmd.join(' ') }))
    expect((await driver.exec('dshhub-u7k2m9xz', ['pnpm', 'install'])).exitCode).toBe(0)
    expect((await driver.runOnce(spec(), ['sh', '-lc', 'fail'])).exitCode).toBe(1)

    const logs = await driver.logs('dshhub-u7k2m9xz', { tail: 2 })
    expect(logs.split('\n')).toHaveLength(2)

    const lines: string[] = []
    const controller = new AbortController()
    const follow = driver.followLogs('dshhub-u7k2m9xz', (line) => lines.push(line), controller.signal)
    controller.abort()
    await follow
    expect(lines.length).toBeGreaterThan(0)
  })

  it('镜像：buildImage / imageExists / removeImage', async () => {
    const driver = makeDriver()
    const logged: string[] = []
    expect(await driver.imageExists('dshhub/runtime:0.2.0-rc.2')).toBe(false)
    const result = await driver.buildImage(
      '/tmp/ctx',
      'dshhub/runtime:0.2.0-rc.2',
      { DSH_VERSION: '0.2.0-rc.2' },
      (l) => logged.push(l),
    )
    expect(result.imageId).toMatch(/^sha256:/)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(logged.join('\n')).toContain('DSH_VERSION=0.2.0-rc.2')
    expect(await driver.imageExists('dshhub/runtime:0.2.0-rc.2')).toBe(true)
    await driver.removeImage('dshhub/runtime:0.2.0-rc.2')
    expect(await driver.imageExists('dshhub/runtime:0.2.0-rc.2')).toBe(false)
  })
})

describe('假 DSH HTTP 服务（任务书 §3：供代理测试）', () => {
  it('GET / 返回含 __DSH_BOOT__ 的 HTML，记录端口', async () => {
    const driver = makeDriver()
    await driver.create(spec())
    await driver.start('dshhub-u7k2m9xz')
    const baseUrl = driver.getBaseUrl('dshhub-u7k2m9xz')
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(driver.getPort('dshhub-u7k2m9xz')).toBeGreaterThan(0)

    const res = await httpGet(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('__DSH_BOOT__')
  })

  it('GET /api/echo 回显 Host/Origin/cookie', async () => {
    const driver = makeDriver()
    await driver.create(spec())
    await driver.start('dshhub-u7k2m9xz')
    const baseUrl = driver.getBaseUrl('dshhub-u7k2m9xz')!
    const res = await httpGet(`${baseUrl}/api/echo`, {
      host: 'dshhub-u7k2m9xz:3000',
      origin: 'http://dshhub-u7k2m9xz:3000',
      cookie: 'dsh-auth-abc=xyz',
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as FakeDshRequest
    expect(body.host).toBe('dshhub-u7k2m9xz:3000')
    expect(body.origin).toBe('http://dshhub-u7k2m9xz:3000')
    expect(body.cookie).toBe('dsh-auth-abc=xyz')

    const recorded = driver.getRequests('dshhub-u7k2m9xz')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ method: 'GET', url: '/api/echo', host: 'dshhub-u7k2m9xz:3000' })
    driver.clearRequests('dshhub-u7k2m9xz')
    expect(driver.getRequests('dshhub-u7k2m9xz')).toHaveLength(0)
  })

  it('未知路径 404、dispose 关闭全部服务', async () => {
    const driver = makeDriver()
    await driver.create(spec())
    await driver.start('dshhub-u7k2m9xz')
    const baseUrl = driver.getBaseUrl('dshhub-u7k2m9xz')!
    expect((await httpGet(`${baseUrl}/nope`)).status).toBe(404)
    expect((await httpGet(`${baseUrl}/assets/app.js`)).status).toBe(200)

    await driver.dispose()
    await expect(httpGet(`${baseUrl}/`)).rejects.toThrow()
    expect(driver.getContainerNames()).toEqual([])
  })

  it('requireAuthCookie 打开时首页需要 dsh-auth-* cookie', async () => {
    const driver = new FakeDriver({ requireAuthCookie: true })
    drivers.push(driver)
    await driver.create(spec())
    await driver.start('dshhub-u7k2m9xz')
    const baseUrl = driver.getBaseUrl('dshhub-u7k2m9xz')!
    expect((await httpGet(`${baseUrl}/`)).status).toBe(401)
    expect((await httpGet(`${baseUrl}/`, { cookie: 'dsh-auth-x=1' })).status).toBe(200)
  })
})
