#!/usr/bin/env node
/**
 * 模型芯片回归测试：冷启动（新模块 + 空 state）时，适配器 listModels 必须自己把
 * app-server 的 model/list 拉进来，而不是只返回「跟随 Codex 默认」。
 *
 *   node tools/test-models.mjs
 *
 * ⚠️ 可选脚本，不在 `npm test` 里：它要 app-server 真回一份 model/list，
 * 所以在**没有已登录 codex** 的机器上，「模型目录多于一条」「拉到目录后广播
 * llm/adapters-updated」两项会失败（只拿到 `cli-default`）—— 那是环境缺失，
 * 不是代码回归。跑之前先确认本机能用 codex（`codex login status` / 已配好 API key），
 * 或干脆只在有登录的机器上跑。
 *
 * 它用临时的 CODEX_HOME 起 app-server（不碰 ~/.codex 的登录与配置）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-codex-models-'))
process.env.CODEX_HOME = home

const problems = []
const check = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`)
  if (!ok) problems.push(message)
}

let mod
try {
  mod = await import('../runtime/bridge.js')
} catch (error) {
  // 宿主可能没装 @openai/codex，那就没法起 app-server：直接跳过
  console.log(`跳过：导入 runtime/bridge.js 失败（${error.message}）`)
  process.exit(0)
}

const emitted = []
const slots = {}
const ctx = {
  get: (name) =>
    name === 'llm'
      ? {
          registerAdapter: (providers, adapter) => {
            slots.providers = providers
            slots.adapter = adapter
            return () => {}
          },
        }
      : undefined,
  events: { dispatch: (mode, args) => emitted.push([mode, args]) },
  on: () => () => {},
}

const state = {}
const started = Date.now()
const registered = mod.ensureModelAdapter(ctx, state, {})
check(registered === true, '适配器注册成功')
check(JSON.stringify(slots.providers) === '["codex"]', '只注册 codex 一个提供者')

try {
  const models = await slots.adapter.listModels('codex')
  const ids = models.map((model) => model.id)
  console.log(`  listModels ${Date.now() - started}ms，${models.length} 条：${ids.join(', ')}`)
  check(models.length > 1, '模型目录多于一条（不是只剩「跟随」）')
  check(ids[0] === 'cli-default', '第一条是「跟随 Codex 默认」（cli-default）')
  check(models.length === (state.models?.length || 0) + 1, '目录 = 跟随 + app-server model/list')
  check(emitted.some(([mode, args]) => mode === 'emit' && args?.[0] === 'llm/adapters-updated'), '拉到目录后广播 llm/adapters-updated')

  const meta = models.find((model) => model.id === 'cli-default')
  check(meta?.name === '跟随 Codex 默认', '跟随项的名字正确')
  const concrete = models.find((model) => model.id !== 'cli-default')
  if (concrete) {
    const resolved = await slots.adapter.resolveModel('codex', concrete.id)
    check(resolved.id === concrete.id, `resolveModel 认得 ${concrete.id}`)
    check((resolved.reasoning?.efforts?.length || 0) > 0, `${concrete.id} 有思考程度选项`)
  }

  // 第二次调用不再重复拉（有目录就直接返回）
  const again = await slots.adapter.listModels('codex')
  check(again.length === models.length && again[0].id === 'cli-default', '第二次 listModels 结果一致（走缓存）')
} catch (error) {
  check(false, `listModels 失败：${error?.stack || error?.message}`)
} finally {
  try {
    await mod.shutdownAll(state)
  } catch {
    /* 忽略清理失败 */
  }
  rmSync(home, { recursive: true, force: true })
}

if (problems.length) {
  console.error(`\n失败 ${problems.length} 项`)
  process.exit(1)
}
console.log('\n全部通过')
