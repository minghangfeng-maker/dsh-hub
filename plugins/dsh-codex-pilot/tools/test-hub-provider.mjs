/**
 * Hub 模式接入的回归测试：
 *   - hubAgentModes 服务（桌面端）优先，服务不存在/不合法时退回 HUB_CODEX_* 环境变量（容器行为不变）；
 *   - 模型列表仍由插件用「服务给的 baseUrl + 密钥」去拉 {base}/hub/agent-mode（与容器同一条链）；
 *   - Hub 配置变化（onChange → hubConfigChanged）清缓存，下一轮按新配置走。
 *
 * 跑法：node tools/test-hub-provider.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试进程里不能有容器注入的 HUB_*，否则「服务优先」和「回退」两件事分不清
for (const name of Object.keys(process.env)) if (name.startsWith('HUB_')) delete process.env[name]

const setup = await import('../runtime/setup.js')
const bridge = await import('../runtime/bridge.js')

const results = []
const test = async (name, fn) => {
  try {
    await fn()
    results.push(`✔ ${name}`)
  } catch (error) {
    results.push(`✘ ${name}\n    ${error?.message?.split('\n').join('\n    ')}`)
    process.exitCode = 1
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-hub-provider-'))
const config = { storeFile: join(home, 'sessions.json') }
writeFileSync(join(home, 'auth.json'), JSON.stringify({ mode: 'machine' }))

const envHub = {
  HUB_CODEX_KEY: 'sk-env',
  HUB_CODEX_BASE_URL: 'https://env.example/v1/',
  HUB_CODEX_WIRE_API: 'chat',
  HUB_CODEX_MODEL: 'm-env',
  HUB_CODEX_LABEL: 'env hub',
}
const pick = (hub) => (hub ? { key: hub.key, baseUrl: hub.baseUrl, wireApi: hub.wireApi, model: hub.model, label: hub.label } : null)

/* --------------------------------------------------- 服务优先 / env 回退 */

await test('没有服务时读 HUB_CODEX_*（容器里就是这条）', () => {
  setup.setHubProvider(null)
  assert.deepEqual(pick(setup.hubAuth(envHub)), { key: 'sk-env', baseUrl: 'https://env.example/v1', wireApi: 'chat', model: 'm-env', label: 'env hub' })
  assert.equal(setup.hubAuth({}), null)
  // 只给 key：baseUrl / wireApi / label 用默认值（与旧版一致）
  assert.deepEqual(pick(setup.hubAuth({ HUB_CODEX_KEY: 'sk-only' })), { key: 'sk-only', baseUrl: 'https://api.openai.com/v1', wireApi: 'responses', model: '', label: 'DSH Hub' })
})

await test('服务存在时用服务的 baseUrl / 密钥 / 模型 / 显示名（env 同时存在也不影响）', () => {
  setup.setHubProvider(() => ({ key: 'sk-svc', baseUrl: 'http://127.0.0.1:9/v1/', wireApi: 'chat', model: 'm-svc', label: 'Hub Svc' }))
  assert.deepEqual(pick(setup.hubAuth(envHub)), { key: 'sk-svc', baseUrl: 'http://127.0.0.1:9/v1', wireApi: 'chat', model: 'm-svc', label: 'Hub Svc' })
})

await test('服务返回不合法凭据 / 抛异常 → 退回 env（不崩）', () => {
  setup.setHubProvider(() => ({ key: '' }))
  assert.equal(setup.hubAuth(envHub).key, 'sk-env')
  setup.setHubProvider(() => {
    throw new Error('hub-connector 还没登录')
  })
  assert.equal(setup.hubAuth(envHub).key, 'sk-env')
  setup.setHubProvider(null)
})

await test('桌面端：服务在 = Hub 模式（process.env 里没有 HUB_* 也一样）', () => {
  setup.setHubProvider(() => ({ key: 'sk-svc', baseUrl: 'http://127.0.0.1:9/v1', label: 'Hub Svc' }))
  assert.equal(setup.loadAuth(config).mode, 'hub')
  setup.setHubProvider(null)
  assert.equal(setup.loadAuth(config).mode, 'machine', '没有服务也没有 env 时回到自己的配置')
})

/* ------------------------------------------- 模型列表：用服务的接入点去拉 */

await test('hubConfig 用服务的 baseUrl + 密钥拉 {base}/hub/agent-mode', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({ mode: 'codex', label: 'Hub Svc', defaultModel: 'm-svc', models: [{ id: 'm-svc' }, { id: 'm-2' }] }),
    }
  }
  try {
    setup.invalidateHubConfig()
    setup.setHubProvider(() => ({ key: 'sk-svc-2', baseUrl: 'http://svc.local:1/v1' }))
    const result = await setup.hubConfig({ force: true })
    assert.equal(result.ok, true)
    assert.equal(calls.at(-1).url, 'http://svc.local:1/v1/hub/agent-mode')
    assert.equal(calls.at(-1).headers.authorization, 'Bearer sk-svc-2')
    assert.deepEqual(setup.lastHubConfig().models.map((model) => model.id), ['m-svc', 'm-2'])
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('Hub 配置变化（onChange → hubConfigChanged）：清缓存 + 就绪缓存，下一轮用新配置', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} })
    return { ok: true, status: 200, json: async () => ({ mode: 'codex', label: 'Hub', models: [{ id: 'm' }] }) }
  }
  try {
    setup.setHubProvider(() => ({ key: 'sk-svc-2', baseUrl: 'http://svc.local:1/v1' }))
    const before = calls.length
    await setup.hubConfig()
    assert.equal(calls.length, before, '缓存有效期内不该重复拉')
    const state = { authReady: { at: 1, ready: true } }
    bridge.hubConfigChanged(state)
    assert.equal(state.authReady.at, 0, '就绪缓存失效（与「设置页改了配置」同一条刷新路径）')
    setup.setHubProvider(() => ({ key: 'sk-svc-3', baseUrl: 'http://svc.local:2/v1' }))
    await setup.hubConfig()
    assert.equal(calls.at(-1).url, 'http://svc.local:2/v1/hub/agent-mode')
    assert.equal(calls.at(-1).headers.authorization, 'Bearer sk-svc-3')
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('服务缓存的模型列表：拉取失败时兜底模型选择器（但就绪判定仍然失败）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  try {
    setup.invalidateHubConfig()
    setup.setHubProvider(() => ({ key: 'sk-svc-4', baseUrl: 'http://svc.local:3/v1', models: [{ id: 'cached-1', displayName: 'Cached' }] }))
    const failed = await setup.hubConfig({ force: true })
    assert.equal(failed.ok, false, '连不上就是没就绪')
    assert.deepEqual(setup.lastHubConfig().models.map((model) => model.id), ['cached-1'])
  } finally {
    globalThis.fetch = realFetch
    setup.setHubProvider(null)
    setup.invalidateHubConfig()
  }
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\n有失败项')
} else {
  console.log('\n全部通过')
}
