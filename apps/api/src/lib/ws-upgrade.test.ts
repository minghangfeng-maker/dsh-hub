import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { acceptUpgrade, rejectUpgrade, wrapWebSocket, type WsConnection } from './ws-upgrade.js'

/** 真实 raw socket E2E：不用 mock WsConnection，走真握手、真帧、真 socket。 */
let server: Server | null = null
let port = 0
let conn: WsConnection | null = null

async function start(): Promise<string> {
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    conn = acceptUpgrade(req, socket, head)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  return `ws://127.0.0.1:${String(port)}`
}

afterEach(async () => {
  conn?.close()
  conn = null
  if (server !== null) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('ws 薄封装（真实 socket）', () => {
  it('分片累计超过 maxPayload 被 1009 关闭（不是只看单帧）', async () => {
    const url = await start()
    const client = new WebSocket(url)
    await new Promise<void>((resolve) => client.on('open', () => resolve()))
    const result = await new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code))
      // 10 × 40KiB 分片，单帧都合法、累计超 256KiB
      const chunk = Buffer.alloc(40 * 1024, 0x61)
      for (let index = 0; index < 10; index += 1) {
        client.send(chunk, { fin: index === 9 })
      }
    })
    expect(result).toBe(1009)
  })

  it('畸形帧（保留位/非法操作码）被断开', async () => {
    const url = await start()
    const socket = await rawHandshake(url)
    // RSV1 置位 + 文本操作码：ws 应判协议错误并关闭
    const frame = Buffer.from([0xc1, 0x81, 0, 0, 0, 0, 0x61])
    socket.write(frame)
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000)
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.on('data', (data: Buffer) => {
        if ((data[0] ?? 0) === 0x88) {
          clearTimeout(timer)
          resolve(true)
        }
      })
    })
    socket.destroy()
    expect(closed).toBe(true)
  })

  it.skip('慢消费者真实 socket（依赖内核缓冲，保留为手动项）：暂停消费后帧进入发送队列，灌满队列才 1013', async () => {
    const url = await start()
    const client = new WebSocket(url)
    await new Promise<void>((resolve) => client.on('open', () => resolve()))
    ;(client as unknown as { _socket?: { pause(): void } })._socket?.pause()
    const closedCode = new Promise<number>((resolve) => {
      conn?.onClose((code) => resolve(code))
    })
    const payload = 'x'.repeat(48 * 1024)
    for (let sent = 0; sent < 80 && conn !== null && !conn.closed; sent += 1) {
      conn.send(payload)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(conn?.closed).toBe(true)
    expect(await closedCode).toBe(1013)
    client.terminate()
    conn?.close()
  })

  it('关闭后连接对象被回收标记（closed=true），重复 close 幂等', async () => {
    const url = await start()
    const client = new WebSocket(url)
    await new Promise<void>((resolve) => client.on('open', () => resolve()))
    expect(conn?.closed).toBe(false)
    conn?.close(1000, 'bye')
    expect(conn?.closed || conn === null).toBe(true)
    conn?.close(1000, 'again')
    client.terminate()
  })

  /** 受控慢消费者：bufferedAmount 由测试直接改写，模拟「手机端还没消费完」。 */
  function slowConsumer(initialBuffered = 1_100_000) {
    const sent: string[] = []
    let closeCode = 0
    const fake = {
      readyState: 1,
      bufferedAmount: initialBuffered,
      send: (data: string) => sent.push(data),
      ping: () => undefined,
      close: (code?: number) => { closeCode = code ?? 0 },
      terminate: () => undefined,
      on: () => undefined,
    }
    let closed = 0
    const conn = wrapWebSocket(fake, '127.0.0.1')
    conn.onClose((code) => { closed = code })
    return { fake, sent, conn, closeCode: () => closeCode, closed: () => closed }
  }

  it('受控慢消费者：超过水位先入队，消费者排空后按原顺序发出，不再直接断链', async () => {
    const { fake, sent, conn, closeCode } = slowConsumer()
    conn.send('a')
    conn.send('b')
    conn.send('c')
    expect(sent).toHaveLength(0)
    expect(closeCode()).toBe(0)
    expect(conn.closed).toBe(false)
    fake.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(closeCode()).toBe(0)
  })

  it('受控慢消费者：队列超过 32MiB 才按 1013 关闭（一次大文件的多片帧不会断链）', () => {
    const { fake, sent, conn, closeCode, closed } = slowConsumer()
    const frame = 'x'.repeat(1024 * 1024)
    // 3.6MB 级别的文件（19 片 ×192KB）远小于队列上限：不应关闭。
    for (let index = 0; index < 20; index += 1) conn.send(frame.slice(0, 192 * 1024))
    expect(closeCode()).toBe(0)
    expect(conn.closed).toBe(false)
    // 继续灌到超过 32MiB：队列放不下，按慢消费者关闭。
    for (let index = 0; index < 40 && !conn.closed; index += 1) conn.send(frame)
    expect(closeCode()).toBe(1013)
    expect(closed()).toBe(1013)
    expect(sent).toHaveLength(0)
    fake.bufferedAmount = 0
  })

  it('关闭连接时丢弃尚在队列里的帧，不再尝试发送', async () => {
    const { fake, sent, conn } = slowConsumer()
    conn.send('queued-1')
    conn.send('queued-2')
    conn.close(1000, 'bye')
    fake.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sent).toHaveLength(0)
  })

  it('rejectUpgrade 对未鉴权升级返回 401 文本', async () => {
    server = createServer()
    server.on('upgrade', (_req, socket) => rejectUpgrade(socket, 401, 'UNAUTHENTICATED'))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0
    const response = await new Promise<string>((resolve) => {
      const socket: Socket = connect(targetPort, '127.0.0.1', () => {
        socket.write(
          'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        )
      })
      let text = ''
      socket.on('data', (data) => {
        text += data.toString('utf8')
        if (text.includes('\r\n\r\nUNAUTHENTICATED') || text.includes('401')) socket.destroy()
      })
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    expect(response).toContain('401')
  })
})

async function rawHandshake(url: string): Promise<Socket> {
  const target = new URL(url)
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname, () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let buffer = ''
    const onData = (data: Buffer): void => {
      buffer += data.toString('utf8')
      if (buffer.includes('101')) {
        socket.off('data', onData)
        resolve(socket)
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}
