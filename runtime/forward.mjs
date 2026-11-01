#!/usr/bin/env node
/**
 * 容器内的极简 TCP 转发：`0.0.0.0:$DSH_PORT` -> `127.0.0.1:$DSH_UPSTREAM_PORT`。
 *
 * 为什么需要它（WP0b S1 实测）：
 *   1. `dsh web --host` 只接受 `127.0.0.1` / `0.0.0.0`，传容器 IP 直接 config 校验失败；
 *   2. 更要紧的是**第三方插件会检查 `req.socket.remoteAddress`**：例如
 *      `dsh-email@0.16.0` 的设置/资源路由只允许 `127.0.0.1`，Hub 从宿主转发过来的连接
 *      在 DSH 看来来自网桥地址 → 403「localhost-only」。经过这一跳之后，DSH 看到的
 *      对端永远是回环，插件的 localhost 限制自然满足。
 *
 * 转发是纯 TCP pipe，HTTP/WebSocket/SSE 都不需要额外处理（不缓冲、不改写）。
 * 只监听容器网络内的地址，容器没有发布端口，宿主之外不可达。
 *
 * 环境变量：DSH_PORT（默认 3000，转发器监听）、DSH_UPSTREAM_PORT（默认 DSH_PORT+1）。
 */
import { connect, createServer } from 'node:net'

const listenPort = Number(process.env.DSH_PORT ?? 3000)
const upstreamPort = Number(process.env.DSH_UPSTREAM_PORT ?? listenPort + 1)

const server = createServer((client) => {
  const upstream = connect(upstreamPort, '127.0.0.1')
  const shutdown = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', shutdown)
  upstream.on('error', shutdown)
  client.pipe(upstream)
  upstream.pipe(client)
})

server.on('error', (error) => {
  console.error(`forward: ${error.message}`)
  process.exitCode = 1
})

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`forward: 0.0.0.0:${String(listenPort)} -> 127.0.0.1:${String(upstreamPort)}`)
})
