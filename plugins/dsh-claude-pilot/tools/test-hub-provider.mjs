/**
 * Hub 模式接入的回归测试：
 *   - hubAgentModes 服务（桌面端）优先，服务不存在/不合法时退回 HUB_CLAUDE_* 环境变量（容器行为不变）；
 *   - 模型列表仍由插件用「服务给的 baseUrl + 密钥」去拉 /v1/hub/agent-mode（与容器同一条链）；
 *   - Hub 配置变化（onChange → hubConfigChanged）清缓存，下一轮按新配置走；
 *   - Windows 的 Git Bash 注入只发生在 claude 子进程的环境上（有 Git Bash 注入路径，没有则打开 PowerShell 工具）。
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
  HUB_CLAUDE_AUTH: 'apiKey',
  HUB_CLAUDE_KEY: 'sk-env',
  HUB_CLAUDE_BASE_URL: 'https://env.example/',
  HUB_CLAUDE_MODEL: 'm-env',
  HUB_CLAUDE_LABEL: 'env hub',
}
const pick = (hub) => (hub ? { auth: hub.auth, key: hub.key, baseUrl: hub.baseUrl, model: hub.model, label: hub.label } : null)

/* --------------------------------------------------- 服务优先 / env 回退 */

await test('没有服务时读 HUB_CLAUDE_*（容器里就是这条）', () => {
  setup.setHubProvider(null)
  assert.deepEqual(pick(setup.hubAuth(envHub)), { auth: 'apiKey', key: 'sk-env', baseUrl: 'https://env.example', model: 'm-env', label: 'env hub' })
  assert.equal(setup.hubAuth({}), null)
})

await test('服务存在时用服务的 baseUrl / 密钥 / 模型 / 显示名（env 同时存在也不影响）', () => {
  setup.setHubProvider(() => ({ auth: 'authToken', key: 'sk-svc', baseUrl: 'http://127.0.0.1:9/v1/', model: 'm-svc', label: 'Hub Svc' }))
  assert.deepEqual(pick(setup.hubAuth(envHub)), { auth: 'authToken', key: 'sk-svc', baseUrl: 'http://127.0.0.1:9/v1', model: 'm-svc', label: 'Hub Svc' })
})

await test('服务返回不合法凭据 / 抛异常 → 退回 env（不崩）', () => {
  setup.setHubProvider(() => ({ auth: 'nope', key: 'x' }))
  assert.equal(setup.hubAuth(envHub).key, 'sk-env')
  setup.setHubProvider(() => ({}))
  assert.equal(setup.hubAuth(envHub).key, 'sk-env')
  setup.setHubProvider(() => {
    throw new Error('hub-connector 还没登录')
  })
  assert.equal(setup.hubAuth(envHub).key, 'sk-env')
  setup.setHubProvider(null)
})

await test('桌面端：服务在 = Hub 模式（process.env 里没有 HUB_* 也一样）', () => {
  setup.setHubProvider(() => ({ auth: 'apiKey', key: 'sk-svc', baseUrl: 'http://127.0.0.1:9', label: 'Hub Svc' }))
  assert.equal(setup.loadAuth(config).mode, 'hub')
  setup.setHubProvider(null)
  assert.equal(setup.loadAuth(config).mode, 'machine', '没有服务也没有 env 时回到自己的配置')
})

/* ------------------------------------------- 模型列表：用服务的接入点去拉 */

await test('hubConfig 用服务的 baseUrl + 密钥拉 /v1/hub/agent-mode', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({ mode: 'claude-code', label: 'Hub Svc', defaultModel: 'm-svc', smallModel: 'm-small', models: [{ id: 'm-svc' }, { id: 'm-2' }] }),
    }
  }
  try {
    setup.invalidateHubConfig()
    setup.setHubProvider(() => ({ auth: 'apiKey', key: 'sk-svc-2', baseUrl: 'http://svc.local:1', label: 'Hub Svc' }))
    const result = await setup.hubConfig(config, { force: true })
    assert.equal(result.ok, true)
    assert.equal(calls.at(-1).url, 'http://svc.local:1/v1/hub/agent-mode')
    assert.equal(calls.at(-1).headers['x-api-key'], 'sk-svc-2')
    assert.deepEqual(setup.lastHubConfig(config).models.map((model) => model.id), ['m-svc', 'm-2'])
    assert.equal(setup.lastHubConfig(config).smallModel, 'm-small')
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('Hub 配置变化（onChange → hubConfigChanged）：清缓存 + 就绪缓存，下一轮用新配置', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {} })
    return { ok: true, status: 200, json: async () => ({ mode: 'claude-code', label: 'Hub', models: [{ id: 'm' }] }) }
  }
  try {
    setup.setHubProvider(() => ({ auth: 'apiKey', key: 'sk-svc-2', baseUrl: 'http://svc.local:1' }))
    const before = calls.length
    await setup.hubConfig(config) // 30 秒缓存内：不再请求
    assert.equal(calls.length, before, '缓存有效期内不该重复拉')
    const state = { authReady: { at: 1, ready: true } }
    bridge.hubConfigChanged(state)
    assert.equal(state.authReady.at, 0, '就绪缓存失效（与「设置页改了配置」同一条刷新路径）')
    setup.setHubProvider(() => ({ auth: 'apiKey', key: 'sk-svc-3', baseUrl: 'http://svc.local:2' }))
    await setup.hubConfig(config)
    assert.equal(calls.at(-1).url, 'http://svc.local:2/v1/hub/agent-mode')
    assert.equal(calls.at(-1).headers['x-api-key'], 'sk-svc-3')
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
    setup.setHubProvider(() => ({ auth: 'apiKey', key: 'sk-svc-4', baseUrl: 'http://svc.local:3', models: [{ id: 'cached-1', displayName: 'Cached' }] }))
    const failed = await setup.hubConfig(config, { force: true })
    assert.equal(failed.ok, false, '连不上就是没就绪')
    assert.deepEqual(setup.lastHubConfig(config).models.map((model) => model.id), ['cached-1'])
  } finally {
    globalThis.fetch = realFetch
    setup.setHubProvider(null)
    setup.invalidateHubConfig()
  }
})

/* --------------------------------------------- Windows：Git Bash / PowerShell */

await test('applyShellTool：找到 Git Bash 就注入 CLAUDE_CODE_GIT_BASH_PATH', () => {
  const env = setup.applyShellTool({ Path: 'C:\\x' }, { win: true, detect: () => ({ path: 'C:\\Program Files\\Git\\bin\\bash.exe', source: 'common' }) })
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.equal(env.CLAUDE_CODE_USE_POWERSHELL_TOOL, undefined)
  assert.equal(env.Path, 'C:\\x', '只加 claude 要的变量，不动 PATH')
})

await test('applyShellTool：没有 Git Bash 就明确走 PowerShell 工具', () => {
  const env = setup.applyShellTool({}, { win: true, detect: () => null })
  assert.equal(env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1')
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, undefined)
})

await test('applyShellTool：用户/宿主已经指定过就不覆盖', () => {
  const env = setup.applyShellTool({ CLAUDE_CODE_GIT_BASH_PATH: 'E:\\mine\\bash.exe' }, { win: true, detect: () => ({ path: 'C:\\Program Files\\Git\\bin\\bash.exe' }) })
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'E:\\mine\\bash.exe')
  const noGit = setup.applyShellTool({ CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' }, { win: true, detect: () => null })
  assert.equal(noGit.CLAUDE_CODE_USE_POWERSHELL_TOOL, '0', '用户显式关掉就不硬开')
})

await test('applyShellTool / gitBashHint：POSIX 上什么都不做', () => {
  const env = setup.applyShellTool({ PATH: '/usr/bin' }, { win: false })
  assert.deepEqual(env, { PATH: '/usr/bin' })
  assert.equal(setup.gitBashHint({ win: false, detect: () => null }), null)
})

await test('gitBashHint：没有 Git Bash 给一句话，有就不给', () => {
  assert.match(setup.gitBashHint({ win: true, detect: () => null }), /Git Bash/)
  assert.equal(setup.gitBashHint({ win: true, detect: () => ({ path: 'C:\\Program Files\\Git\\bin\\bash.exe' }) }), null)
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\n有失败项')
} else {
  console.log('\n全部通过')
}
