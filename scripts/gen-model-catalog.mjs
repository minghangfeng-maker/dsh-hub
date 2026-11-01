#!/usr/bin/env node
// 生成内置「模型信息库」：apps/api/src/modules/models/catalog-data.ts
//
// 数据来源是 pi-ai 自带的模型目录（@earendil-works/pi-ai 的 dist/providers/data/*.json）——这就是 DSH 的
// llm-pi-ai 插件自己用来查「某个模型有多大上下文、能不能看图、有哪些思考档位」的那份数据，
// 所以 Hub 里自动补全出来的值和 DSH 对同名内置模型的认知一致。
//
// 用法（升级 DSH 运行时之后重新生成一次）：
//   # 1. 把目录数据拷出来（任选其一）
//   cid=$(docker create dshhub/runtime:<版本> sh)
//   docker cp "$cid:/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/." /tmp/pi-data
//   docker rm "$cid"
//   #    或：cp -r node_modules/@earendil-works/pi-ai/dist/providers/data /tmp/pi-data
//   # 2. 生成
//   node scripts/gen-model-catalog.mjs /tmp/pi-data --source "@earendil-works/pi-ai 0.87.1" \
//     > apps/api/src/modules/models/catalog-data.ts
//
// 取舍：
// - 同名模型按 PRIORITY 的顺序取第一份：模型原厂的数据优先，聚合平台（openrouter 等）可能被砍过上下文，排在后面。
// - 订阅制 / 受限渠道（github-copilot、openai-codex、cloudflare-ai-gateway、radius）的上限不代表模型本身，整个跳过。
// - 思考档位按 pi-ai 的 getSupportedThinkingLevels 规则算：null = 不支持；xhigh / max 只有显式写了才算支持；
//   非推理模型不输出档位（Hub 里「不选 = 不支持思考」）。
import fs from 'node:fs'
import path from 'node:path'

const SKIP_PROVIDERS = new Set(['github-copilot', 'openai-codex', 'cloudflare-ai-gateway', 'radius'])

/** 原厂在前，聚合平台在后；不在表里的按文件名排在最后 */
const PRIORITY = [
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'xai',
  'meta',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'zai',
  'zai-coding-cn',
  'minimax',
  'minimax-cn',
  'xiaomi',
  'ant-ling',
  'openrouter',
  'together',
  'fireworks',
  'groq',
  'cerebras',
  'nvidia',
  'baseten',
  'huggingface',
  'vercel-ai-gateway',
  'google-vertex',
  'azure-openai-responses',
  'amazon-bedrock',
]

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 和 pi-ai models.js 的 getSupportedThinkingLevels 保持一致 */
function supportedLevels(model) {
  if (!model.reasoning) return []
  const levels = LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
  return levels.some((level) => level !== 'off') ? levels : []
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

const args = process.argv.slice(2)
const dataDir = args.find((arg) => !arg.startsWith('--'))
const sourceIndex = args.indexOf('--source')
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : 'pi-ai'
if (!dataDir) {
  console.error('用法：node scripts/gen-model-catalog.mjs <pi-ai 的 providers/data 目录> [--source "说明"]')
  process.exit(2)
}

const files = fs
  .readdirSync(dataDir)
  .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  .map((file) => file.replace(/\.json$/u, ''))
  .filter((provider) => !SKIP_PROVIDERS.has(provider))
  .sort((a, b) => {
    const ia = PRIORITY.indexOf(a)
    const ib = PRIORITY.indexOf(b)
    if (ia !== ib) return (ia === -1 ? 1e6 : ia) - (ib === -1 ? 1e6 : ib)
    return a.localeCompare(b)
  })

const seen = new Set()
const rows = []
for (const provider of files) {
  const groups = JSON.parse(fs.readFileSync(path.join(dataDir, `${provider}.json`), 'utf8'))
  for (const models of Object.values(groups)) {
    if (models === null || typeof models !== 'object') continue
    for (const model of Object.values(models)) {
      if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
      const contextWindow = positiveInt(model.contextWindow)
      const maxTokens = positiveInt(model.maxTokens)
      if (!contextWindow || !maxTokens) continue
      const dedupeKey = model.id.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const input = Array.isArray(model.input)
        ? model.input.filter((item) => item === 'text' || item === 'image')
        : []
      const levels = supportedLevels(model)
      rows.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        contextWindow,
        maxTokens,
        ...(input.length > 0 ? { input } : {}),
        ...(levels.length > 0 ? { reasoningEfforts: levels } : {}),
      })
    }
  }
}

const out = []
out.push('// 由 scripts/gen-model-catalog.mjs 生成，请勿手改（升级 DSH 运行时后按脚本头部说明重新生成）。')
out.push(`// 来源：${source}；${rows.length} 个模型；同名取原厂数据，受限渠道已跳过。`)
out.push("import type { ModelInfo } from '@dsh-hub/shared'")
out.push('')
out.push('export interface BuiltinModel extends ModelInfo {')
out.push('  id: string')
out.push('  name: string')
out.push('}')
out.push('')
out.push(`export const BUILTIN_CATALOG_SOURCE = ${JSON.stringify(source)}`)
out.push('')
out.push('/** 顺序 = 优先级：规范化后同名的，靠前的先命中 */')
out.push('export const BUILTIN_CATALOG: readonly BuiltinModel[] = [')
for (const row of rows) out.push(`  ${JSON.stringify(row)},`)
out.push(']')
out.push('')
process.stdout.write(out.join('\n'))
console.error(`生成 ${rows.length} 条（${files.length} 个来源）`)
