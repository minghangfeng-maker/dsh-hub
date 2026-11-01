import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import {
  CreateRelayChannelRequestSchema,
  CreateRelayModelRequestSchema,
  type CreateRelayChannelRequest,
  type CreateRelayModelRequest,
  type RelayChannel,
  type RelayModel,
} from '@dsh-hub/shared'
import type { TestApp } from './helpers.js'

/**
 * 中转站测试脚手架（WP10a）：进程内假上游 + 直接调 service 造数据的快捷函数。
 * 假上游用 `http.createServer().listen(0, '127.0.0.1')`，不占固定端口，也**不碰任何真实上游**。
 */

export interface FakeUpstreamRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
  /** 请求体 JSON.parse 的结果（不是 JSON 时为 null） */
  json: Record<string, unknown> | null
}

export type FakeUpstreamHandler = (
  req: FakeUpstreamRequest,
  res: ServerResponse,
  /** 原始 IncomingMessage（要监听 aborted/close 之类的事件时用） */
  raw: IncomingMessage,
) => void | Promise<void>

export interface FakeUpstream {
  url: string
  port: number
  requests: FakeUpstreamRequest[]
  /** 换处理器（后续请求用新的） */
  setHandler(handler: FakeUpstreamHandler): void
  /** 关掉所有连接并停止监听（模拟上游挂掉） */
  close(): Promise<void>
}

export async function startFakeUpstream(handler: FakeUpstreamHandler): Promise<FakeUpstream> {
  let current = handler
  const requests: FakeUpstreamRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let json: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(body) as unknown
        if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
      } catch {
        json = null
      }
      const record: FakeUpstreamRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
        json,
      }
      requests.push(record)
      void Promise.resolve(current(record, res, req)).catch(() => {
        if (!res.writableEnded) res.end()
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    requests,
    setHandler(next) {
      current = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 发一段 SSE 响应（含正确的头） */
export function sseResponse(res: ServerResponse, chunks: (string | Buffer)[], delayMs = 0): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  let index = 0
  const writeNext = (): void => {
    if (index >= chunks.length) {
      res.end()
      return
    }
    res.write(chunks[index])
    index += 1
    if (delayMs > 0) setTimeout(writeNext, delayMs)
    else writeNext()
  }
  writeNext()
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

// ── 造数据（直接走 service；REST 路径由 relay.api.test.ts 覆盖）──────────────

export function relayService(app: FastifyInstance) {
  return app.deps.services.relay
}

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

/** 与路由一样先过 zod（补默认值），再交给 service */
export function createChannel(
  app: FastifyInstance,
  input: Partial<CreateRelayChannelRequest> & { baseUrl: string },
): RelayChannel {
  const parsed = CreateRelayChannelRequestSchema.parse(input)
  return relayService(app).createChannel(parsed, 1, META)
}

export async function createRelayModel(
  app: FastifyInstance,
  input: Partial<Omit<CreateRelayModelRequest, 'price'>> & {
    name: string
    price: Partial<CreateRelayModelRequest['price']>
  },
): Promise<RelayModel> {
  const parsed = CreateRelayModelRequestSchema.parse({
    ...input,
    price: {
      inputMicro: 1_000_000,
      outputMicro: 2_000_000,
      cacheReadMicro: null,
      cacheWriteMicro: null,
      perRequestMicro: 0,
      ...input.price,
    },
  })
  return await relayService(app).createModel(parsed, 1, META)
}

/** 给钱包加积分（走 service，会写流水） */
export function grantMicro(app: FastifyInstance, userId: number, amountMicro: number): void {
  relayService(app).adjustWallet(userId, { amountMicro, note: '测试加积分' }, 1, META)
}

/** 造一把用户密钥，返回明文 */
export function issueKey(app: FastifyInstance, userId: number, name = '测试密钥'): string {
  return relayService(app).createKey(userId, { name }, userId, META).secret
}

/** 取该用户的 system 密钥明文（没有就签发） */
export function systemKey(app: FastifyInstance, userId: number): string {
  const secret = relayService(app).systemKeyPlain(userId)
  if (!secret) throw new Error('system 密钥签发失败')
  return secret
}

export interface RelaySetupOptions {
  upstreamUrl: string
  apis?: CreateRelayChannelRequest['apis']
  modelName?: string
  upstreamModel?: string
  price?: Partial<CreateRelayModelRequest['price']>
  streamUsage?: boolean
  visibility?: 'all' | 'admin'
  channelName?: string
}

/** 建一个渠道 + 一个对外模型，返回它们的 id（最常见的测试前置） */
export async function setupChannelAndModel(
  app: FastifyInstance,
  options: RelaySetupOptions,
): Promise<{ channelId: number; modelId: number; modelName: string }> {
  const modelName = options.modelName ?? 'test-model'
  const channel = createChannel(app, {
    name: options.channelName ?? `ch-${Math.random().toString(36).slice(2, 8)}`,
    baseUrl: options.upstreamUrl,
    apis: options.apis ?? ['openai-completions', 'openai-responses', 'anthropic-messages'],
    ...(options.streamUsage === undefined ? {} : { streamUsage: options.streamUsage }),
    keys: ['upstream-key-1'],
  })
  const model = await createRelayModel(app, {
    name: modelName,
    displayName: 'Test Model',
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    price: {
      inputMicro: options.price?.inputMicro ?? 1_000_000,
      outputMicro: options.price?.outputMicro ?? 2_000_000,
      cacheReadMicro: options.price?.cacheReadMicro ?? null,
      cacheWriteMicro: options.price?.cacheWriteMicro ?? null,
      perRequestMicro: options.price?.perRequestMicro ?? 0,
    },
    info: { name: 'Test Model', contextWindow: 128_000, maxTokens: 8_192 },
    routes: [
      { channelId: channel.id, upstreamModel: options.upstreamModel ?? 'upstream-model', enabled: true },
    ],
  })
  return { channelId: channel.id, modelId: model.id, modelName }
}

// ── 标准响应体（三协议）─────────────────────────────────────────────────────

export const OPENAI_NON_STREAM_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'upstream-model',
  choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
}

export const ANTHROPIC_NON_STREAM_BODY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'upstream-model',
  content: [{ type: 'text', text: '你好' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 80, output_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
}

export const RESPONSES_NON_STREAM_BODY = {
  id: 'resp_1',
  object: 'response',
  model: 'upstream-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
  usage: { input_tokens: 60, output_tokens: 20, input_tokens_details: { cached_tokens: 4 } },
}

export const OPENAI_STREAM_CHUNKS = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40}}\n\n',
  'data: [DONE]\n\n',
]

export const ANTHROPIC_STREAM_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":80,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

export const RESPONSES_STREAM_CHUNKS = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":60,"output_tokens":20,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
]

export type { TestApp }
