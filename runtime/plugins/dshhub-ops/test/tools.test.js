/**
 * `@dshhub/ops` 工具单测：起一个假的 `/ops` 服务（真 HTTP，127.0.0.1:8274），
 * 断言工具真的打到了对的路径、带了 Bearer、`sessionId` 只从执行上下文来。
 *
 * 端口用 WP56b 分到的 8274（本仓库的端口约定（见 README）），`--test-concurrency=1` 保证两个测试文件不抢端口。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createOpsClient, resolveOpsEndpoint } from '../client.js'
import { registerOpsTools } from '../tools.js'
import { apply } from '../index.js'

const PORT = 8274
const TOKEN = 'ops-token-for-tests'

/** 假 /ops 服务：记录每一次请求，按路径回预设。 */
function createFakeOps() {
  const requests = []
  const proposal = {
    id: 12,
    sessionId: 'sess-from-context',
    title: '给所有用户下发 dsh-memory 0.1.4',
    rationale: '升级',
    risk: 'R2',
    steps: [{ capability: 'rollouts.plugin', args: {}, preview: { summary: '影响 8 个用户' } }],
    status: 'pending',
    createdAt: '2026-10-29T00:00:00.000Z',
    expiresAt: '2026-10-29T00:30:00.000Z',
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url, `http://127.0.0.1:${String(PORT)}`)
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: req.headers.authorization,
      })
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(401, { error: { code: 'UNAUTHORIZED', message: '座舱令牌无效' } })
      }
      if (url.pathname === '/ops/context') {
        return send(200, {
          version: '0.9.0',
          today: '2026-10-29',
          timezone: 'Asia/Shanghai',
          policy: { autoExecuteR1: true },
          counts: { users: 12, instances: 3 },
        })
      }
      if (url.pathname === '/ops/catalog') {
        const items = [
          {
            id: 'users.list',
            area: 'users',
            title: '列出用户',
            description: '列出全部用户',
            risk: 'R0',
            input: { type: 'object' },
          },
        ]
        return send(200, { items, total: items.length })
      }
      if (url.pathname === '/ops/call' && req.method === 'POST') {
        if (body.capability === 'users.list') {
          return send(200, { kind: 'data', data: { rows: [{ username: 'alice' }] }, truncated: false })
        }
        if (body.capability === 'instances.start') {
          return send(200, { kind: 'done', result: { status: 'running' }, auditId: 77 })
        }
        return send(200, { kind: 'proposal', proposal })
      }
      if (url.pathname.startsWith('/ops/proposals/')) {
        return send(200, { ...proposal, status: 'succeeded', outcome: [{ stepIndex: 0, ok: true }] })
      }
      if (url.pathname === '/ops/canvas' && req.method === 'POST') {
        return send(200, {
          id: 'cv_1',
          // Hub 会把自己的判定结果带回来（舰桥布局：左舷数据 / 右舷行动）
          placement: body.placement === 'right' ? 'right' : 'left',
          sessionId: body.sessionId,
          title: body.title,
          spec: body.spec,
          pinned: false,
          order: 0,
          createdAt: '2026-10-29T00:00:00.000Z',
          updatedAt: '2026-10-29T00:00:00.000Z',
          origin: 'dsh',
        })
      }
      if (url.pathname.startsWith('/ops/canvas/') && req.method === 'PATCH') {
        return send(200, {
          id: url.pathname.split('/').pop(),
          title: body.title ?? '',
          spec: body.spec ?? {},
          placement: body.placement ?? 'left',
          pinned: false,
          order: 0,
          sessionId: body.sessionId,
          createdAt: '2026-10-29T00:00:00.000Z',
          updatedAt: '2026-10-29T00:00:00.000Z',
          origin: 'dsh',
        })
      }
      if (url.pathname === '/ops/secret-requests' && req.method === 'POST') {
        return send(200, {
          id: 'sr_1',
          sessionId: body.sessionId,
          purpose: body.purpose,
          capability: body.capability,
          field: body.field,
          status: 'pending',
          expiresAt: '2026-10-29T00:15:00.000Z',
        })
      }
      return send(404, { error: { code: 'NOT_FOUND', message: `没有 ${url.pathname}` } })
    })
  })
  return { server, requests, proposal }
}

/** 最小 ctx：只实现插件用到的那几个方法。 */
function createFakeCtx() {
  const tools = new Map()
  const handlers = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      const dispose = fn()
      return { dispose }
    },
    inject(deps, callback) {
      if (deps.every((dep) => dep === 'tools')) callback(ctx)
    },
    logger: { debug() {}, warn() {} },
  }
  return { ctx, tools, handlers }
}

const exec = { agent: { session: { id: 'sess-from-context', header: { id: 'sess-from-context' } } } }

/** 工具结果的模型可见文本（`render` 的产物） */
function textOf(name, args, value) {
  const rendered = tools.get(name).output.render(args, value)
  return rendered.map((part) => part.text).join('\n')
}

let fake
let client
let tools

before(async () => {
  fake = createFakeOps()
  await new Promise((resolve) => fake.server.listen(PORT, '127.0.0.1', resolve))
  client = createOpsClient({ baseUrl: `http://127.0.0.1:${String(PORT)}/ops`, token: TOKEN })
  const fakeCtx = createFakeCtx()
  registerOpsTools(fakeCtx.ctx, { client })
  tools = fakeCtx.tools
})

after(async () => {
  await new Promise((resolve) => fake.server.close(resolve))
})

test('注册了六个工具，且参数里没有 sessionId', () => {
  assert.deepEqual([...tools.keys()].sort(), [
    'canvas_show',
    'canvas_update',
    'ops_call',
    'ops_find',
    'ops_wait',
    'secret_request',
  ])
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.additionalProperties, false, `${name} 必须禁止额外参数`)
    assert.equal(tool.parameters.properties?.sessionId, undefined, `${name} 不能暴露 sessionId 参数`)
  }
})

test('ops_call：sessionId 只从执行上下文取，模型塞在 args 里的被丢弃', async () => {
  const result = await tools.get('ops_call').execute(
    {
      capability: 'users.list',
      args: { sessionId: 'attacker-chosen', page: 1 },
      title: '列出用户',
      rationale: '看看',
    },
    exec,
  )
  // 原样返回 OpsCallResult（不包 {ok,...}）
  assert.equal(result.kind, 'data')
  assert.deepEqual(result.data, { rows: [{ username: 'alice' }] })
  // docs/24 §6：工具结果是 `OpsCallResult` 原样 JSON（App 靠它认方案/投放）
  assert.match(textOf('ops_call', {}, result), /"kind"\s*:\s*"data"/)
  const call = fake.requests.filter((item) => item.path === '/ops/call').at(-1)
  assert.equal(call.body.sessionId, 'sess-from-context')
  assert.deepEqual(call.body.args, { page: 1 })
  assert.equal(call.authorization, `Bearer ${TOKEN}`)
})

test('ops_call：写操作返回方案卡，措辞是「等你确认」而不是已完成', async () => {
  const result = await tools.get('ops_call').execute(
    {
      capability: 'rollouts.plugin',
      args: { pluginId: 1, versionId: 2, targets: 'all' },
      title: '下发',
      rationale: '升级',
    },
    exec,
  )
  assert.equal(result.kind, 'proposal')
  assert.equal(result.proposal.id, 12)
  const text = textOf('ops_call', {}, result)
  assert.match(text, /方案卡 #12/)
  assert.match(text, /等你确认/)
  assert.doesNotMatch(text, /已完成/)
})

test('ops_call：steps 多步方案原样送 Hub', async () => {
  const result = await tools.get('ops_call').execute(
    {
      steps: [{ capability: 'users.list' }, { capability: 'instances.start', args: { username: 'a' } }],
      title: '两步',
    },
    exec,
  )
  assert.equal(result.kind, 'proposal')
  const call = fake.requests.filter((item) => item.path === '/ops/call').at(-1)
  assert.equal(call.body.steps.length, 2)
  assert.deepEqual(call.body.steps[1].args, { username: 'a' })
})

test('ops_call：R1 自动执行返回 done + 审计号', async () => {
  const result = await tools.get('ops_call').execute({ capability: 'instances.start', args: {} }, exec)
  assert.equal(result.kind, 'done')
  assert.equal(result.auditId, 77)
  assert.match(textOf('ops_call', {}, result), /"kind"\s*:\s*"done"/)
})

test('ops_call：既没有 capability 也没有 steps → 失败且不打 Hub', async () => {
  const before = fake.requests.length
  const result = await tools.get('ops_call').execute({ title: '空' }, exec)
  assert.equal(result.ok, false)
  assert.equal(fake.requests.length, before)
})

test('没有会话上下文时工具拒绝执行（不编 sessionId）', async () => {
  const before = fake.requests.length
  const result = await tools.get('ops_call').execute({ capability: 'users.list', args: {} }, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NO_SESSION')
  assert.match(textOf('ops_call', {}, result), /座舱调用失败/)
  assert.equal(fake.requests.length, before)
})

test('ops_find 检索目录并回结构化 items', async () => {
  const result = await tools.get('ops_find').execute({ query: '用户' }, exec)
  // 原样返回 /ops/catalog 的 {items,total}
  assert.equal(result.items[0].id, 'users.list')
  assert.equal(result.total, 1)
  assert.match(textOf('ops_find', { query: '用户' }, result), /users\.list/)
})

test('ops_wait 等到 succeeded', async () => {
  const result = await tools.get('ops_wait').execute({ proposalId: 12, waitSec: 5 }, exec)
  // 原样返回 ProposalView
  assert.equal(result.status, 'succeeded')
  assert.equal(result.id, 12)
  assert.match(textOf('ops_wait', {}, result), /succeeded/)
  const request = fake.requests.filter((item) => item.path.startsWith('/ops/proposals/')).at(-1)
  assert.equal(request.query.waitSec, '5')
})

test('canvas_show / canvas_update 带上会话 id', async () => {
  const shown = await tools
    .get('canvas_show')
    .execute({ title: '近 7 天用量', spec: { kind: 'markdown', text: 'x' } }, exec)
  // 原样返回 CanvasItem（含 Hub 解析后的 placement）
  assert.equal(shown.id, 'cv_1')
  assert.equal(shown.placement, 'left')
  const created = fake.requests.filter((item) => item.path === '/ops/canvas').at(-1)
  assert.equal(created.body.sessionId, 'sess-from-context')

  const updated = await tools.get('canvas_update').execute({ id: 'cv_1', title: '新标题' }, exec)
  assert.equal(updated.id, 'cv_1')
  const patched = fake.requests.filter((item) => item.method === 'PATCH').at(-1)
  assert.equal(patched.path, '/ops/canvas/cv_1')
  assert.equal(patched.body.sessionId, 'sess-from-context')
})

test('canvas_show/canvas_update 把 placement 与 size 原样送 Hub，并回投放位置', async () => {
  const shown = await tools
    .get('canvas_show')
    .execute(
      { title: '方案进度', spec: { kind: 'markdown', text: 'x' }, placement: 'right', size: 'l' },
      exec,
    )
  assert.equal(shown.placement, 'right')
  // docs/24 §6：`canvas_show` 的工具结果是 `CanvasItem` 原样 JSON（App 的过程行从 placement/id 解析）
  assert.match(textOf('canvas_show', {}, shown), /"placement"\s*:\s*"right"/)
  const created = fake.requests.filter((item) => item.path === '/ops/canvas').at(-1)
  assert.equal(created.body.placement, 'right')
  assert.equal(created.body.size, 'l')

  const updated = await tools.get('canvas_update').execute({ id: 'cv_1', placement: 'left' }, exec)
  assert.equal(updated.id, 'cv_1')
  assert.match(textOf('canvas_update', {}, updated), /"placement"\s*:\s*"left"/)
  const patched = fake.requests.filter((item) => item.method === 'PATCH').at(-1)
  assert.equal(patched.body.placement, 'left')
})

test('secret_request 只发用途，不收密钥', async () => {
  const result = await tools
    .get('secret_request')
    .execute({ purpose: '渠道 API Key', capability: 'relay.channels.upsert', field: 'apiKey' }, exec)
  assert.equal(result.id, 'sr_1')
  assert.match(textOf('secret_request', {}, result), /密钥输入卡/)
  const request = fake.requests.filter((item) => item.path === '/ops/secret-requests').at(-1)
  assert.deepEqual(Object.keys(request.body).sort(), ['capability', 'field', 'purpose', 'sessionId'])
})

test('Hub 拒绝（401）时工具回一句人能看懂的失败', async () => {
  const badClient = createOpsClient({ baseUrl: `http://127.0.0.1:${String(PORT)}/ops`, token: 'wrong' })
  const fakeCtx = createFakeCtx()
  registerOpsTools(fakeCtx.ctx, { client: badClient })
  const result = await fakeCtx.tools.get('ops_call').execute({ capability: 'users.list', args: {} }, exec)
  assert.equal(result.ok, false)
  assert.match(textOf('ops_call', {}, result), /座舱令牌无效/)
})

test('resolveOpsEndpoint：config 里的空字符串不覆盖容器环境变量（WP56e2 回归）', () => {
  // 真实故障形态：index.js 的 DEFAULT_CONFIG 把 url/token 填成 ''，合并后这两个键永远存在，
  // 旧实现用 `??` 只挡 null/undefined → 空串把 env 全盖掉，容器里每个工具都回
  // 「座舱通道没有配置好」。这里直接钉住 DEFAULT_CONFIG 的形状。
  const env = { DSHHUB_OPS_URL: 'http://10.0.0.1:7710/ops', DSHHUB_OPS_TOKEN: 'tok-from-env' }
  assert.deepEqual(resolveOpsEndpoint(env, { url: '', token: '' }), {
    baseUrl: 'http://10.0.0.1:7710/ops',
    token: 'tok-from-env',
  })
  // 纯空白同样不算覆盖
  assert.deepEqual(resolveOpsEndpoint(env, { url: '   ', token: '\n' }), {
    baseUrl: 'http://10.0.0.1:7710/ops',
    token: 'tok-from-env',
  })
  // 非空的 config 仍然优先（手工排障时可以覆盖）
  assert.deepEqual(resolveOpsEndpoint(env, { url: 'http://127.0.0.1:9999', token: 'tok-config' }), {
    baseUrl: 'http://127.0.0.1:9999/ops',
    token: 'tok-config',
  })
})

test('apply() 用容器 env 就能把客户端配起来（不写 profile 也能用）', async () => {
  const fakeCtx = createFakeCtx()
  const previous = { url: process.env.DSHHUB_OPS_URL, token: process.env.DSHHUB_OPS_TOKEN }
  process.env.DSHHUB_OPS_URL = `http://127.0.0.1:${String(PORT)}/ops`
  process.env.DSHHUB_OPS_TOKEN = TOKEN
  try {
    // 不传 config（等价于 loader 用 DEFAULT_CONFIG 合并出 url:'' / token:''）
    apply(fakeCtx.ctx, {})
    assert.equal(fakeCtx.tools.size, 6)
    // 真的打一次：证明用的是 env 里的地址与令牌，而不是「注册了但没配起来」
    const before = fake.requests.length
    const result = await fakeCtx.tools
      .get('ops_find')
      .execute({ query: '实例' }, { agent: { session: { id: 'sess-env' } } })
    assert.equal(result.ok === false, false, 'apply() 之后工具不该回「没有配置好」')
    assert.ok(fake.requests.length > before, '应该真的发出了一次 /ops 请求')
    const last = fake.requests.at(-1)
    assert.equal(last.path, '/ops/catalog')
    assert.equal(last.authorization, `Bearer ${TOKEN}`)
  } finally {
    if (previous.url === undefined) delete process.env.DSHHUB_OPS_URL
    else process.env.DSHHUB_OPS_URL = previous.url
    if (previous.token === undefined) delete process.env.DSHHUB_OPS_TOKEN
    else process.env.DSHHUB_OPS_TOKEN = previous.token
  }
})

test('apply() 通过 ctx.inject([tools]) 注册工具，并挂上守则注入', () => {
  const fakeCtx = createFakeCtx()
  const previous = { url: process.env.DSHHUB_OPS_URL, token: process.env.DSHHUB_OPS_TOKEN }
  process.env.DSHHUB_OPS_URL = `http://127.0.0.1:${String(PORT)}/ops`
  process.env.DSHHUB_OPS_TOKEN = TOKEN
  try {
    apply(fakeCtx.ctx, {})
  } finally {
    if (previous.url === undefined) delete process.env.DSHHUB_OPS_URL
    else process.env.DSHHUB_OPS_URL = previous.url
    if (previous.token === undefined) delete process.env.DSHHUB_OPS_TOKEN
    else process.env.DSHHUB_OPS_TOKEN = previous.token
  }
  assert.equal(fakeCtx.tools.size, 6)
  assert.equal(fakeCtx.handlers.has('agent/pre-step'), true)
})

test('ops_call 的 R0 数据：小结果原样 JSON；超过预算时截断并明说「不要按全量回答」', () => {
  const small = { kind: 'data', data: [{ user: 'alice', credits: 12 }], truncated: false }
  assert.deepEqual(JSON.parse(textOf('ops_call', {}, small)), small)

  const rows = Array.from({ length: 2000 }, (_, i) => ({ user: `user-${String(i)}`, credits: i }))
  const text = textOf('ops_call', {}, { kind: 'data', data: rows, truncated: false })
  assert.ok(text.length < 17_000, '给模型的文本有上限')
  assert.match(text, /只显示前 16000/u)
  assert.match(text, /不要按全量回答/u)
})
