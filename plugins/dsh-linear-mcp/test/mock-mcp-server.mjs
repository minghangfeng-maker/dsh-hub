/**
 * 离线测试用的最小 MCP server（Streamable HTTP）。
 *
 * 用途：在没有 Linear 凭据的情况下，验证 linear-mcp 插件的「凭据 → 挂载
 * dsh-mcp-client → 注册 mcp__linear__* 工具 → 真正调用工具」这整条链路。
 *
 *   node test/mock-mcp-server.mjs 4610
 *
 * 只实现 initialize / notifications/initialized / tools/list / tools/call，
 * GET 用 SSE 回一个 keepalive 流（SDK 不会主动开），DELETE 直接 200。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.argv[2] ?? 4610)

/** 暴露给客户端的工具。 */
const TOOLS = [
  {
    name: 'echo',
    description: '原样回显 text 参数（mock）。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'whoami',
    description: '返回 mock 身份信息，用来验证带 Authorization 的调用链。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** 处理一个 JSON-RPC 报文。 */
function handle(message, authorization) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mock-linear', version: '0.0.1' },
        instructions: 'mock server for dsh-linear-mcp tests',
      },
    }
  }
  if (method === 'notifications/initialized') return undefined
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }] } }
    }
    if (name === 'whoami') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify({ authorization: authorization ?? null, server: 'mock-linear' }) }] },
      }
    }
    return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.write(': mock-mcp\n\n')
    return
  }
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const sessionId = req.headers['mcp-session-id'] ?? randomUUID()
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }
    const messages = Array.isArray(payload) ? payload : [payload]
    const responses = messages.map((message) => handle(message, req.headers.authorization)).filter(Boolean)
    if (responses.length === 0) {
      res.writeHead(202, { 'mcp-session-id': sessionId })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId })
    res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-mcp listening on http://127.0.0.1:${port}/mcp`)
})
