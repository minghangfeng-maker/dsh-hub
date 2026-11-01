import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './helpers.js'
import {
  LOOPBACK_HOST,
  startListeners,
  startPlainHttp,
  startRedirect,
  startTlsGateway,
} from '../src/server/listeners.js'
import { loadConfig } from '../src/config.js'

/** WP7a 的调试端口（11 §3）；生产 Hub 用 7700，别的会话用别的端口 */
const TEST_PORT = 7771

let ctx: TestApp | null = null

afterEach(async () => {
  if (ctx) {
    await ctx.close()
    ctx = null
  }
})

describe('明文 HTTP 监听器（01 §2）', () => {
  it('只绑 127.0.0.1，并能真的收到请求', async () => {
    ctx = await createTestApp({ env: { HUB_HTTP_PORT: String(TEST_PORT) } })
    const handle = await startPlainHttp(ctx.app, ctx.config)

    expect(handle.kind).toBe('plain')
    expect(handle.host).toBe(LOOPBACK_HOST)
    expect(handle.port).toBe(TEST_PORT)

    const address = ctx.app.server.address()
    expect(address).toBeTruthy()
    expect(typeof address === 'object' && address !== null ? address.address : '').toBe('127.0.0.1')

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    await handle.close()
  })

  it('宿主非回环 IP 上连不上（0.0.0.0 或局域网都不可达）', async () => {
    ctx = await createTestApp({ env: { HUB_HTTP_PORT: String(TEST_PORT) } })
    await startPlainHttp(ctx.app, ctx.config)

    const external = externalIPv4()
    if (external.length === 0) return // 没有非回环地址就跳过（不影响结论）

    for (const ip of external) {
      const refused = await connectFails(ip, TEST_PORT, 500)
      expect(refused, `${ip}:${TEST_PORT} 不应该被监听`).toBe(true)
    }
  })

  it('HUB_HTTP_HOST=0.0.0.0 时同时服务回环与局域网（手机真机联调）', async () => {
    ctx = await createTestApp({ env: { HUB_HTTP_PORT: String(TEST_PORT), HUB_HTTP_HOST: '0.0.0.0' } })
    const handle = await startPlainHttp(ctx.app, ctx.config)
    expect(handle.host).toBe('0.0.0.0')

    const address = ctx.app.server.address()
    expect(typeof address === 'object' && address !== null ? address.address : '').toBe('0.0.0.0')

    // 回环当然还能连
    const loop = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`)
    expect(loop.status).toBe(200)

    // 有非回环地址时必须真的从那儿也能连上（WSL NAT 下是 172.x）
    for (const ip of externalIPv4()) {
      const res = await fetch(`http://${ip}:${TEST_PORT}/api/health`)
      expect(res.status, `${ip}:${TEST_PORT} 应该被监听`).toBe(200)
      break
    }

    await handle.close()
  })

  it('端口传 0 时用内核分配的临时端口', async () => {
    ctx = await createTestApp({ env: { HUB_HTTP_PORT: '0' } })
    const handle = await startPlainHttp(ctx.app, ctx.config)
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.port).not.toBe(TEST_PORT)
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`)
    expect(res.status).toBe(200)
    await handle.close()
  })
})

describe('阶段二监听器（WP7b）', () => {
  it('端口为 0 → 不启动，返回 null', async () => {
    ctx = await createTestApp()
    expect(await startTlsGateway(ctx.app, ctx.config)).toBeNull()
    expect(await startRedirect(ctx.app, ctx.config)).toBeNull()
  })

  it('startListeners 在阶段一只有明文一个句柄', async () => {
    ctx = await createTestApp({ env: { HUB_HTTP_PORT: '0' } })
    const handles = await startListeners(ctx.app, ctx.config)
    expect(handles.map((h) => h.kind)).toEqual(['plain'])
    await handles[0]?.close()
  })

  it('HUB_REDIRECT_PORT（原 7080 跳转）已废弃 → 明确报错指向 08 §3', async () => {
    const config = loadConfig({
      HUB_DATA_DIR: '/tmp/none',
      HUB_CONTAINER_DRIVER: 'fake',
      HUB_TLS_PORT: '0',
      HUB_REDIRECT_PORT: '7080',
    })
    await expect(startRedirect({} as never, config)).rejects.toThrow(/08 §3/)
  })
})

/** 本机所有非回环 IPv4（WSL NAT 下是 172.x，镜像网络下是局域网地址） */
function externalIPv4(): string[] {
  const result: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

/** true = 连不上（拒绝/超时）；false = 竟然连上了 */
function connectFails(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (failed: boolean): void => {
      socket.destroy()
      resolve(failed)
    }
    socket.setTimeout(timeoutMs, () => done(true))
    socket.on('connect', () => done(false))
    socket.on('error', () => done(true))
  })
}
