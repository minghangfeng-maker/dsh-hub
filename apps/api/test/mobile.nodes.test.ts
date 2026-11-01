import { describe, expect, it } from 'vitest'
import { createTestApp, createUser, json, loginAs } from './helpers.js'

function insertDevice(app: Awaited<ReturnType<typeof createTestApp>>, userId: number, deviceId: string, name: string, online: boolean): void {
  const now = app.clock.nowIso()
  app.app.deps.db.run(
    `INSERT INTO desktop_devices (device_id, user_id, install_key, name, platform, os_major, arch,
       app_version, app_channel, runtime_version, capabilities_json, status,
       registered_at, first_seen_at, last_auth_at, last_report_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'win32', '11', 'x64', '0.9.3', 'latest', '0.2.1', NULL, 'active', ?, ?, ?, ?, ?, ?)`,
    deviceId,
    userId,
    name,
    now,
    now,
    now,
    online ? now : null,
    now,
    now,
  )
}

describe('GET /api/mobile/nodes', () => {
  it('只列自己的节点；presence≠connectable；不含 home/cwd', async () => {
    const test = await createTestApp()
    try {
      const alice = await createUser(test.app)
      const bob = await createUser(test.app)
      const aliceDevice = 'dv_0123456789abcdef0123456789abcdef'
      const bobDevice = 'dv_fedcba9876543210fedcba9876543210'
      insertDevice(test, alice.id, aliceDevice, '爱丽丝的 Windows', true)
      insertDevice(test, bob.id, bobDevice, '鲍勃的 Windows', false)
      const session = loginAs(test.app, alice)

      const res = await test.app.inject({ method: 'GET', url: '/api/mobile/nodes', headers: session.headers })
      expect(res.statusCode).toBe(200)
      const body = json<{ items: Array<Record<string, unknown>> }>(res)
      const ids = body.items.map((item) => item['id'])
      expect(ids).toContain('cloud:self')
      expect(ids).toContain(aliceDevice)
      expect(ids).not.toContain(bobDevice)

      const desktop = body.items.find((item) => item['id'] === aliceDevice)
      expect(desktop).toMatchObject({ kind: 'desktop', presence: 'online', connectable: false })
      expect(desktop?.['reason']).toBe('desktop-relay-disconnected')
      // 路径不进列表
      expect(res.body).not.toMatch(/cwd|"home"|openUrl/)

      // 云实例不存在时不可连接
      const cloud = body.items.find((item) => item['id'] === 'cloud:self')
      expect(cloud).toMatchObject({ kind: 'cloud', connectable: false })
      expect(cloud?.['reason']).toBe('instance-not-running')

      const unauth = await test.app.inject({ method: 'GET', url: '/api/mobile/nodes' })
      expect(unauth.statusCode).toBe(401)
    } finally {
      await test.close()
    }
  })

  it('实例状态一变，探测缓存立刻失效（唤醒后不再等 30 秒）', async () => {
    const test = await createTestApp()
    try {
      const alice = await createUser(test.app)
      const session = loginAs(test.app, alice)
      const cloudOf = async (): Promise<Record<string, unknown>> => {
        const res = await test.app.inject({ method: 'GET', url: '/api/mobile/nodes', headers: session.headers })
        expect(res.statusCode).toBe(200)
        const body = json<{ items: Array<Record<string, unknown>> }>(res)
        const cloud = body.items.find((item) => item['id'] === 'cloud:self')
        expect(cloud).toBeTruthy()
        return cloud as Record<string, unknown>
      }

      // 还没开通：第一次请求把「不可连接」写进 30 秒缓存
      expect(await cloudOf()).toMatchObject({ status: 'absent', connectable: false })

      // 开通（状态 stopped），再模拟唤醒成功：真实路径里 instances 服务在 ready 阶段
      // 一定 emit instance.status —— 这里用同一事件模拟那一刻
      const instances = test.app.deps.services.instances
      expect(instances).toBeTruthy()
      await instances!.provision(alice.id, { reason: 'user' })
      test.app.deps.db.run("UPDATE instances SET status = 'running' WHERE user_id = ?", alice.id)
      const summary = await instances!.getSummary(alice.id)
      expect(summary.status).toBe('running')
      test.app.deps.events.emit('instance.status', { userId: alice.id, event: { instance: summary } })

      // 缓存被清掉：立刻重新探测（FakeDriver 的假 DSH 不是真 adapter，会以 adapter-probe-failed 收尾，
      // 关键是**不再是**缓存里那句 instance-not-running，也不用等 30 秒）
      const after = await cloudOf()
      expect(after['status']).toBe('running')
      expect(after['connectable']).toBe(false)
      expect(after['reason']).toBe('adapter-probe-failed')
    } finally {
      await test.close()
    }
  })
})
