#!/usr/bin/env node
/**
 * WP18a 搜索池 / DeepSeek 登录的**假上游**（绝不连真实 DeepSeek / Tavily / platform.deepseek.com）。
 *
 *   node apps/api/scripts/fake-tool-upstream.mjs --port 7883 --kind deepseek
 *   node apps/api/scripts/fake-tool-upstream.mjs --port 7885 --kind tavily
 *   node apps/api/scripts/fake-tool-upstream.mjs --port 7884 --kind platform
 *   node apps/api/scripts/fake-tool-upstream.mjs --port 7883 --kind deepseek --fail-once 432
 *
 * 通用接口：
 *   GET  /__count            → `{count, requests:[{method,url,body}]}`（计数看板）
 *   POST /__reset            → 清零计数
 *   POST /__fail <status>    → 之后的请求一律返回该状态（便于演示 Tavily 432 切换）
 *
 * `--kind deepseek`：`POST /search`（DeepSeek Search 格式）、`POST /fetch`（`{content}`）
 * `--kind tavily`：`POST /search`（Tavily 格式，可带 `--fail-once 432`）、`POST /extract`
 * `--kind platform`：`/auth-api/v0/dsh/{auth_init,auth_exchange,auth_cancel}`、`/auth-api/v0/users/{current,logout}`
 */
import { createServer } from 'node:http'

function parseArgs(argv) {
  const out = { port: 7883, kind: 'deepseek', host: '127.0.0.1', failOnce: null }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--port') out.port = Number(argv[++i])
    else if (token === '--kind') out.kind = argv[++i]
    else if (token === '--host') out.host = argv[++i]
    else if (token === '--fail-once') out.failOnce = Number(argv[++i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const state = { count: 0, requests: [], failStatus: null, failOnce: args.failOnce }

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

function envelope(bizData) {
  return { code: 0, data: { biz_code: 0, biz_data: bizData } }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && url === '/__count') {
      json(res, 200, { count: state.count, requests: state.requests })
      return
    }
    if (req.method === 'POST' && url === '/__reset') {
      state.count = 0
      state.requests = []
      state.failStatus = null
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url === '/__fail') {
      state.failStatus = state.failStatus === null ? 432 : null
      json(res, 200, { failStatus: state.failStatus })
      return
    }

    const body = await readBody(req)
    state.count += 1
    state.requests.push({ method: req.method, url, body })
    process.stderr.write(
      `[fake-tool ${args.kind}:${args.port}] ${req.method} ${url} ${JSON.stringify(body)}\n`,
    )

    if (state.failStatus !== null) {
      json(res, state.failStatus, { error: { message: `fake upstream ${state.failStatus}` } })
      return
    }
    if (state.failOnce !== null) {
      const status = state.failOnce
      state.failOnce = null
      json(res, status, { error: { message: `fake upstream once ${status}` } })
      return
    }

    if (args.kind === 'deepseek') {
      if (url === '/search') {
        json(res, 200, {
          results: [
            {
              url: 'https://fake.test/ds-1',
              title: 'DeepSeek 假结果',
              snippet: '来自假上游',
              date: '2026-10-01',
            },
            { url: 'https://fake.test/ds-2', title: '第二条', snippet: '内容', date: null },
          ],
        })
        return
      }
      if (url === '/fetch') {
        json(res, 200, { content: `# 假抓取\n\n${String(body.url ?? '')}` })
        return
      }
      json(res, 404, { error: { message: 'not found' } })
      return
    }

    if (args.kind === 'tavily') {
      if (url === '/search') {
        json(res, 200, {
          results: [
            { title: 'Tavily 假结果', url: 'https://fake.test/tv-1', content: '来自假 Tavily', score: 0.9 },
          ],
        })
        return
      }
      if (url === '/extract') {
        json(res, 200, {
          results: [{ url: body.urls?.[0], raw_content: '# 假 Tavily 抓取' }],
          failed_results: [],
        })
        return
      }
      json(res, 404, { error: { message: 'not found' } })
      return
    }

    // ── 假 DeepSeek 平台（登录）─────────────────────────────────────────────
    const origin = `http://127.0.0.1:${String(args.port)}`
    if (url === '/auth-api/v0/dsh/auth_init') {
      const stateValue = String(body.state ?? 'state')
      json(
        res,
        200,
        envelope({
          authorize_url: `${origin}/dsh/authorize?state=${encodeURIComponent(stateValue)}`,
          authorize_id: 'fake-authorize-id-1',
          expires_in: 600,
        }),
      )
      return
    }
    if (url === '/auth-api/v0/dsh/auth_exchange') {
      json(
        res,
        200,
        envelope({
          token: 'fake-platform-token-0001',
          authorized_url: `${origin}/dsh/authorized`,
          user: {
            id: 'fake-user-1',
            id_profile: { name: '假账号', picture: null },
            email: 'fake@example.com',
          },
        }),
      )
      return
    }
    if (url === '/auth-api/v0/dsh/auth_cancel') {
      json(res, 200, envelope({}))
      return
    }
    if (url === '/auth-api/v0/users/logout') {
      json(res, 200, envelope({}))
      return
    }
    if (url === '/auth-api/v0/users/current') {
      json(
        res,
        200,
        envelope({
          id: 'fake-user-1',
          id_profile: { name: '假账号', picture: null },
          email: 'fake@example.com',
        }),
      )
      return
    }
    json(res, 404, { code: 404, data: { biz_code: 404, biz_data: null } })
  })().catch((error) => {
    if (!res.writableEnded) json(res, 500, { error: { message: String(error) } })
  })
})

server.listen(args.port, args.host, () => {
  process.stderr.write(`[fake-tool ${args.kind}] listening on http://${args.host}:${String(args.port)}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
