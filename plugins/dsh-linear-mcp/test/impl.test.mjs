/**
 * linear-mcp —— 离线自检：纯函数、配置归一化、URI/授权 URL 拼装、凭据形状。
 *
 *   node --test test/impl.test.mjs
 *
 * 不联网、不碰真实凭据；端到端（真的连 MCP、真的注册工具）用
 * test/mock-mcp-server.mjs 配合运行中的 DSH 手工验证，见 README。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { __test } = await import('../impl.js')

const { normalizeConfig, readonlyEndpoint, isLoopbackHost, STATE_PATH, ACTION_PATH, DEV_RELOAD_PATH } = __test

test('路由都在 /_dsh/linear-mcp 命名空间下', () => {
  for (const path of [STATE_PATH, ACTION_PATH, DEV_RELOAD_PATH]) {
    assert.match(path, /^\/_dsh\/linear-mcp\//)
  }
})

test('默认配置里只有 API key 一条凭据路径', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.credentialRef, 'LINEAR_API_KEY')
  // 曾经的 OAuth 授权记录 key 已随登录功能一起移除
  assert.equal('grantKey' in defaults, false)
  assert.equal('grantKey' in normalizeConfig({ grantKey: 'x' }), false)
})

test('配置归一化：默认值、校验与只读端点', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.serverName, 'linear')
  assert.equal(defaults.endpoint, 'https://mcp.linear.app/mcp')
  assert.equal(defaults.credentialRef, 'LINEAR_API_KEY')
  assert.equal(defaults.readonly, false)
  // OAuth 授权记录 key 随「账号登录」一起移除，配置里不该再有它
  assert.equal('grantKey' in defaults, false)

  const bad = normalizeConfig({ serverName: 'has space', toolCallTimeoutMs: -5, requestTimeoutMs: 'x' })
  assert.equal(bad.serverName, 'linear')
  assert.equal(bad.toolCallTimeoutMs, 60000)
  assert.equal(bad.requestTimeoutMs, 20000)

  const ro = normalizeConfig({ readonly: true, endpoint: 'https://mcp.linear.app/mcp' })
  assert.equal(ro.endpoint, 'https://mcp.linear.app/mcp/readonly')
  assert.equal(ro.configuredEndpoint, 'https://mcp.linear.app/mcp')
  // 已经是只读端点时不重复追加
  assert.equal(readonlyEndpoint('https://mcp.linear.app/mcp/readonly'), 'https://mcp.linear.app/mcp/readonly')
})

test('回环 Host 判定', () => {
  assert.equal(isLoopbackHost('127.0.0.1:3201'), true)
  assert.equal(isLoopbackHost('localhost:3201'), true)
  assert.equal(isLoopbackHost('[::1]:3201'), true)
  assert.equal(isLoopbackHost('example.com:3201'), false)
  assert.equal(isLoopbackHost(''), false)
  assert.equal(isLoopbackHost(undefined), false)
})

test('只读端点用配置切换，凭据只有 API key 一条路', () => {
  const ro = normalizeConfig({ readonly: true })
  assert.equal(ro.endpoint, 'https://mcp.linear.app/mcp/readonly')
  // 曾经的 OAuth 相关字段已随登录功能移除
  assert.equal('grantKey' in normalizeConfig({ grantKey: 'x' }), false)
})
