#!/usr/bin/env node
/**
 * 中转站冒烟用的**假上游**（WP10a）。绝不连任何真实模型服务：只在本机端口上按三家协议回定值。
 *
 *   node apps/api/scripts/fake-upstream.mjs [端口=7813]
 *
 * 支持：`GET /models`、`POST /chat/completions`（流式/非流式）、`POST /responses`、`POST /messages`、
 * `POST /messages/count_tokens`。用量字段是固定的，便于对账（每次 100 输入 / 40 输出）。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 7813)
const HOST = '127.0.0.1'

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({})
      }
    })
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && url === '/models') {
    json(res, 200, {
      object: 'list',
      data: [{ id: 'fake-chat' }, { id: 'fake-reasoner' }],
    })
    return
  }
  void readBody(req).then((body) => {
    const stream = body.stream === true
    if (url === '/chat/completions') {
      if (!stream) {
        json(res, 200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: body.model ?? 'fake-chat',
          choices: [
            { index: 0, message: { role: 'assistant', content: '假上游回复' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
      res.write('data: {"choices":[{"index":0,"delta":{"content":"假上游"}}]}\n\n')
      res.write('data: {"choices":[{"index":0,"delta":{"content":"回复"}}]}\n\n')
      res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (url === '/responses') {
      json(res, 200, {
        id: 'resp-fake',
        object: 'response',
        model: body.model ?? 'fake-chat',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '假上游回复' }] },
        ],
        usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } },
      })
      return
    }
    if (url === '/messages') {
      json(res, 200, {
        id: 'msg-fake',
        type: 'message',
        role: 'assistant',
        model: body.model ?? 'fake-chat',
        content: [{ type: 'text', text: '假上游回复' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })
      return
    }
    if (url === '/messages/count_tokens') {
      json(res, 200, { input_tokens: 42 })
      return
    }
    json(res, 404, { error: { message: `假上游没有这个路径：${url}` } })
  })
})

server.listen(port, HOST, () => {
  console.log(`假上游已监听 http://${HOST}:${port}（/models、/chat/completions、/responses、/messages）`)
})
