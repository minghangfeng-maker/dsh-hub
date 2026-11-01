#!/usr/bin/env node
/**
 * 端到端冒烟（DESIGN.md §13.2）：
 *
 *   DSH_MEMORY_HOME=<临时目录> node tools/smoke.mjs
 *
 * 走的是**真实的 runtime 入口** `apply(ctx, config)`，用一个最小的假 Cordis 上下文
 * 接住它要注册的东西（工具表、HTTP 路由、生命周期），然后：
 *   写 3 条记忆 → 读其中 1 条 → 轻整理 → 检查 MEMORY.md → 通过 HTTP API 读列表和图谱。
 *
 * 不连真实模型、不碰 ~/.dsh/memory、不依赖任何 npm 依赖。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../runtime/index.js'

const checks = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, ok: true })
      console.log(`  ✓ ${name}`)
    })
    .catch((error) => {
      checks.push({ name, ok: false, error })
      console.error(`  ✗ ${name}\n    ${error?.message || error}`)
    })
}

/** 最小假上下文：只实现 apply 用到的 surface。 */
function fakeContext() {
  const tools = new Map()
  const routes = []
  const disposers = []
  const listeners = new Map()
  const toolService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }
  const ctx = {
    toolRegistry: tools,
    tools: toolService,
    routes,
    listeners,
    effect(fn) {
      const value = typeof fn === 'function' ? fn() : undefined
      if (typeof value === 'function') disposers.push(value)
      return value
    },
    inject(_names, callback) {
      return callback(ctx)
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    get(name) {
      if (name === 'tools') return toolService
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => routes.splice(routes.indexOf(route), 1)
          },
        }
      }
      return undefined
    },
    disposeAll() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 卸载期的错误不影响冒烟结论
        }
      }
    },
  }
  return ctx
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-smoke-'))
  process.env.DSH_MEMORY_HOME = home
  const ctx = fakeContext()
  apply(ctx, {
    hotBudgetChars: 4000,
    injectBudgetChars: 8000,
    recentSessions: 20,
    graceSessions: 5,
    staleDays: 30,
    subagentWrites: 'inbox',
  })

  const agent = { session: { id: 'smoke-session-1', header: { id: 'smoke-session-1', cwd: '/tmp/smoke-workspace' } }, options: {} }
  const exec = { agent, signal: new AbortController().signal }
  const tool = (name) => {
    const definition = ctx.toolRegistry.get(name)
    assert.ok(definition, `工具 ${name} 没有注册`)
    return definition
  }

  console.log(`\n记忆目录：${home}\n`)

  console.log('1) 写 3 条记忆')
  await check('memory_write 写全局反馈条目', async () => {
    const value = await tool('memory_write').execute({
      name: 'relay-no-proxy',
      description: '访问 relay 必须设 NO_PROXY，否则 Clash 返回 502',
      type: 'feedback',
      tags: ['dsh', '网络'],
      body: '**Why:** Clash\n\n**How to apply:** export NO_PROXY=127.0.0.1，端口 7890',
      scope: 'global',
    }, exec)
    assert.equal(value.ok, true, value.message)
    assert.match(value.message, /已创建/)
  })
  await check('memory_write 写全局参考条目', async () => {
    const value = await tool('memory_write').execute({
      name: 'dsh-headless-model',
      description: 'DSH headless 用配置里的默认模型跑一次任务',
      type: 'reference',
      tags: ['dsh'],
      body: '`dsh headless "task"`，端口 8080',
      scope: 'global',
      links: ['relay-no-proxy'],
    }, exec)
    assert.equal(value.ok, true, value.message)
  })
  await check('memory_write 写工作区条目（默认作用域）', async () => {
    const value = await tool('memory_write').execute({
      name: 'workspace-smoke',
      description: '工作区作用域的冒烟条目',
      type: 'project',
      tags: ['project'],
      body: '正文 `/tmp/workspace-smoke` 42',
    }, exec)
    assert.equal(value.ok, true, value.message)
    assert.match(value.message, /workspaces\/--tmp-smoke-workspace--/)
  })

  console.log('\n2) 读回一条（记录热度）')
  await check('memory_read 返回完整正文并记 stats', async () => {
    const value = await tool('memory_read').execute({ name: 'relay-no-proxy', scope: 'global' }, exec)
    assert.equal(value.ok, true, value.message)
    assert.match(value.text, /^---\nname: relay-no-proxy/m)
    assert.match(value.text, /NO_PROXY/)
    assert.equal(value.fields.type, 'feedback')
  })
  await check('memory_read 不存在的名字给出可操作提示', async () => {
    const value = await tool('memory_read').execute({ name: 'does-not-exist' }, exec)
    assert.equal(value.ok, false)
    assert.match(value.message, /memory_search/)
  })

  // 起一个真实 HTTP 服务，把请求交给 apply() 注册的 memory 路由。
  const route = ctx.routes.find((entry) => entry.path === '/memory/api')
  assert.ok(route, 'apply() 没有注册 /memory/api 路由')
  const server = http.createServer((req, res) => void route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/memory/api`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json()
    assert.equal(res.status, 200, `${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
    return json
  }

  console.log('\n3) 轻整理 + 检查 MEMORY.md')
  await check('POST /run light 触发轻整理', async () => {
    const data = await call('POST', '/run', { mode: 'light' })
    assert.equal(data.ok, true)
    assert.equal(data.run.status, 'done')
  })
  await check('MEMORY.md 生成并可读', async () => {
    const text = await readFile(join(home, 'global', 'MEMORY.md'), 'utf8')
    assert.match(text, /## 热记忆/)
    assert.match(text, /relay-no-proxy\.md/)
    assert.match(text, /## 主题/)
  })
  await check('主题页生成', async () => {
    const text = await readFile(join(home, 'global', '_topics', 'dsh.md'), 'utf8')
    assert.match(text, /# 主题：dsh/)
    assert.match(text, /relay-no-proxy/)
  })
  await check('stats.json 记了读过的会话', async () => {
    const stats = JSON.parse(await readFile(join(home, 'stats.json'), 'utf8'))
    const item = stats.items['global/relay-no-proxy']
    assert.ok(item, 'stats 里没有 global/relay-no-proxy')
    assert.ok(item.readSessions.includes('smoke-session-1'))
    assert.equal(item.hits, 1)
    assert.ok(stats.scopes.global.sessions.includes('smoke-session-1'))
  })
  await check('journal.jsonl 有 3 条 create', async () => {
    const text = await readFile(join(home, 'journal.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(lines.filter((entry) => entry.op === 'create').length, 3)
    assert.ok(lines.every((entry) => typeof entry.before !== 'undefined' && typeof entry.after !== 'undefined'))
  })

  try {
    console.log('\n4) HTTP API（列表 / 图谱 / 设置 / 日志）')
    await check('GET /items 返回 3 条', async () => {
      const data = await call('GET', '/items')
      assert.equal(data.total, 3)
      assert.ok(data.items.every((item) => typeof item.body === 'undefined'))
    })
    await check('GET /item 返回完整文本', async () => {
      const data = await call('GET', '/item?scope=global&name=relay-no-proxy')
      assert.match(data.item.raw, /name: relay-no-proxy/)
      assert.equal(data.item.stats.hits, 1)
    })
    await check('GET /graph 有条目节点、标签节点和 tag 边', async () => {
      const data = await call('GET', '/graph')
      assert.ok(data.nodes.some((node) => node.id === 'global/relay-no-proxy' && node.kind === 'item'))
      assert.ok(data.nodes.some((node) => node.id === 'tag:dsh' && node.kind === 'tag'))
      assert.ok(data.edges.some((edge) => edge.kind === 'tag' && edge.target === 'tag:dsh'))
      assert.ok(data.edges.some((edge) => edge.kind === 'link' && edge.source === 'global/dsh-headless-model'))
    })
    await check('GET /settings 返回默认设置', async () => {
      const data = await call('GET', '/settings')
      assert.equal(data.settings.deepTime, '03:30')
      assert.equal(data.settings.enabled, true)
    })
    await check('GET /journal 至少有 3 条', async () => {
      const data = await call('GET', '/journal?limit=10')
      assert.ok(data.entries.length >= 3)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    ctx.disposeAll()
    await rm(home, { recursive: true, force: true })
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n冒烟结果：${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) {
    console.error(`失败：${failed.map((entry) => entry.name).join('；')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('冒烟脚本崩溃：', error)
  process.exitCode = 1
})
