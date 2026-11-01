import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROXY_V1_MAX_BYTES,
  ProxyProtocolError,
  parseProxyV1Line,
  readProxyV1Header,
} from '../src/server/proxy-protocol.js'

/**
 * PROXY protocol v1（任务书「测试」节）：
 * 合法 TCP4/TCP6/UNKNOWN、超长、缺 `\r\n`、超时、非 PROXY 开头、头与 TLS 首包粘在同一个 chunk。
 */

const servers: Server[] = []
/** net.Server 没有 closeAllConnections：自己记连接，afterEach 里断开，否则 server.close 回调不触发 */
const liveSockets: Socket[] = []

afterEach(async () => {
  for (const socket of liveSockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      const timer = setTimeout(resolve, 500)
      timer.unref?.()
    })
  }
})

describe('parseProxyV1Line（纯解析）', () => {
  it('TCP4：解析出源/目标地址与端口', () => {
    const header = parseProxyV1Line('PROXY TCP4 203.0.113.9 10.213.0.1 51234 7443')
    expect(header).toMatchObject({
      family: 'TCP4',
      sourceAddress: '203.0.113.9',
      sourcePort: 51234,
      destinationAddress: '10.213.0.1',
      destinationPort: 7443,
    })
  })

  it('TCP6：解析 IPv6 地址', () => {
    const header = parseProxyV1Line('PROXY TCP6 2001:db8::1 2001:db8::2 40000 7443')
    expect(header.family).toBe('TCP6')
    expect(header.sourceAddress).toBe('2001:db8::1')
    expect(header.sourcePort).toBe(40000)
  })

  it('UNKNOWN：没有地址（IP 保持隧道出口地址），后面多余内容忽略', () => {
    expect(parseProxyV1Line('PROXY UNKNOWN')).toMatchObject({
      family: 'UNKNOWN',
      sourceAddress: null,
      sourcePort: null,
    })
    expect(parseProxyV1Line('PROXY UNKNOWN whatever the sender wants').family).toBe('UNKNOWN')
  })

  it('格式错误：非 PROXY 开头、协议族未知、字段数量不对、地址/端口非法', () => {
    const bad = [
      'GET / HTTP/1.1',
      'PROXY',
      'PROXY TCP5 1.2.3.4 5.6.7.8 1 2',
      'PROXY TCP4 203.0.113.9 10.213.0.1 51234',
      'PROXY TCP4 2001:db8::1 10.213.0.1 51234 7443',
      'PROXY TCP6 203.0.113.9 10.213.0.1 51234 7443',
      'PROXY TCP4 203.0.113.9 10.213.0.1 abc 7443',
      'PROXY TCP4 203.0.113.9 10.213.0.1 70000 7443',
      'proxy TCP4 203.0.113.9 10.213.0.1 51234 7443',
    ]
    for (const line of bad) {
      expect(() => parseProxyV1Line(line), line).toThrow(ProxyProtocolError)
    }
  })
})

describe('readProxyV1Header（真实 socket 分帧）', () => {
  it('合法头 + TLS 首包粘在同一个 chunk：剩余字节 unshift 回流里', async () => {
    const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a, 0x01])
    const result = await runServer(async (socket) => {
      const header = await readProxyV1Header(socket)
      return { header, rest: await readRest(socket) }
    })
    result.client.write(
      Buffer.concat([Buffer.from('PROXY TCP4 203.0.113.9 10.213.0.1 51234 7443\r\n'), hello]),
    )
    const outcome = await result.done
    expect(outcome.header.sourceAddress).toBe('203.0.113.9')
    expect(Buffer.compare(outcome.rest, hello)).toBe(0)
  })

  it('头分两次写入也能拼起来', async () => {
    const result = await runServer(async (socket) => {
      const header = await readProxyV1Header(socket)
      return { header, rest: await readRest(socket) }
    })
    result.client.write('PROXY TCP6 2001:db8::1 2001:db8::2 40000 ')
    await delay(30)
    result.client.write('7443\r\nPING')
    const outcome = await result.done
    expect(outcome.header.family).toBe('TCP6')
    expect(outcome.rest.toString()).toBe('PING')
  })

  it('超过 107 字节还没 CRLF → too-long', async () => {
    const result = await runServer(async (socket) => captureFailure(socket))
    result.client.write(Buffer.alloc(PROXY_V1_MAX_BYTES + 20, 0x41))
    const failure = await result.done
    expect(failure.reason).toBe('too-long')
  })

  it('非 PROXY 开头（明文 HTTP）→ malformed', async () => {
    const result = await runServer(async (socket) => captureFailure(socket))
    result.client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    const failure = await result.done
    expect(failure.reason).toBe('malformed')
  })

  it('3 秒内没读完 → timeout（测试用 60ms 缩短等待）', async () => {
    const result = await runServer(async (socket) => {
      try {
        await readProxyV1Header(socket, { timeoutMs: 60 })
        return { reason: 'none' }
      } catch (error) {
        return { reason: (error as ProxyProtocolError).reason }
      }
    })
    const failure = await result.done
    expect(failure.reason).toBe('timeout')
  })

  it('连接在读头之前就断了 → closed', async () => {
    const result = await runServer(async (socket) => captureFailure(socket))
    result.client.end()
    const failure = await result.done
    expect(failure.reason).toBe('closed')
  })
})

// ── 工具 ────────────────────────────────────────────────────────────────────

interface ServerHarness<T> {
  client: Socket
  done: Promise<T>
}

function runServer<T>(handler: (socket: Socket) => Promise<T>): Promise<ServerHarness<T>> {
  return new Promise((resolve) => {
    let doneResolve: (value: T) => void = () => undefined
    const done = new Promise<T>((res) => {
      doneResolve = res
    })
    const server = createServer((socket) => {
      liveSockets.push(socket)
      socket.on('error', () => undefined)
      void handler(socket)
        .then((value) => doneResolve(value))
        .catch(() => doneResolve(undefined as T))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const client = connect(port, '127.0.0.1')
      client.on('error', () => undefined)
      liveSockets.push(client)
      resolve({ client, done })
    })
  })
}

async function captureFailure(socket: Socket): Promise<{ reason: string }> {
  try {
    await readProxyV1Header(socket)
    return { reason: 'none' }
  } catch (error) {
    return { reason: (error as ProxyProtocolError).reason }
  }
}

function readRest(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
    }
    socket.on('data', onData)
    socket.resume()
    setTimeout(() => {
      socket.removeListener('data', onData)
      socket.pause()
      resolve(Buffer.concat(chunks))
    }, 60)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
