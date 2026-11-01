#!/usr/bin/env -S node --import tsx
/**
 * 座舱「真容器 + 一句话」探针（排障与自测用，评测/冒烟/e2e 都靠它的同一套 harness）。
 *
 *   NODE_ENV=development node --import tsx apps/api/scripts/cockpit-eval/probe.ts \
 *     --prompt "现在有几个实例在跑" [--script probe-basic] [--keep] [--upstream-url http://127.0.0.1:8788/v1]
 *
 * 它做的事：起临时 Hub + 座舱容器（模型指到假上游）→ 用生产同一条 adapter 开会话说一句话
 * → 打印收到的工具调用（`ops_find` / `ops_call` / `canvas_show` …）与助手文本。
 *
 * 退出码：0 = 这一轮跑完且至少有一次工具调用；1 = 没跑通（帧/超时/错误）；2 = 环境不满足。
 */
import { startCockpitHarness } from './harness.js'
import type { ReplayScript } from './upstream.js'

// 本机代理会把 127.0.0.1 的请求也带走；这条链路全是本机流量 → 直接摘掉
for (const key of [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
]) {
  delete process.env[key]
}

const argv = process.argv.slice(2)
const argOf = (name: string): string | null => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] ?? null) : null
}
const prompt = argOf('--prompt') ?? '现在有几个实例在跑？'
const keep = argv.includes('--keep')
const upstreamUrl = argOf('--upstream-url')
const upstreamKey = process.env['COCKPIT_EVAL_UPSTREAM_KEY'] ?? ''
const timeoutSec = Number(argOf('--timeout') ?? '120')

/** 探针脚本：先 ops_find 再 canvas_show 一张说明卡（证明工具→Hub→画布整条链通） */
const PROBE_SCRIPT: ReplayScript = {
  name: 'probe-basic',
  prompts: [],
  steps: [
    { tool: 'ops_find', args: { query: '实例' }, text: '先查一下能力目录。' },
    {
      tool: 'canvas_show',
      args: {
        title: '探针：一句话答复',
        spec: { kind: 'markdown', text: `探针收到的问题：${prompt}` },
        placement: 'left',
      },
      text: '把结果投到左舷。',
    },
  ],
  finalText: '探针完成：能力目录与画布链路都通了。',
}

async function main(): Promise<void> {
  const harness = await startCockpitHarness({
    upstream: upstreamUrl === null ? 'fake' : 'upstream',
    ...(upstreamUrl === null ? {} : { upstreamUrl }),
    ...(upstreamKey === '' ? {} : { upstreamKey }),
    scripts: [PROBE_SCRIPT],
    keepDataDir: keep,
    ...(argv.includes('--verbose') ? { logLevel: 'info' as const } : {}),
  })
  try {
    harness.upstream?.setActiveScript(PROBE_SCRIPT.name)
    const driver = await harness.driver()
    process.stdout.write(`座舱容器 ${harness.containerName} @ ${harness.containerIp}（网关 ${harness.gateway}）\n`)
    process.stdout.write(`问题：${prompt}\n`)
    const result = await driver.runTurn(prompt, timeoutSec * 1000)
    process.stdout.write(`回合结束：${result.finished ? '是' : '否（超时）'}，${String(result.durationMs)}ms\n`)
    process.stdout.write(`助手文本：${result.assistantText.trim() || '（空）'}\n`)
    for (const tool of result.tools) {
      if (tool.phase !== 'end') continue
      process.stdout.write(
        `  · ${tool.name} ${tool.status ?? ''} ${String(tool.durationMs ?? '?')}ms  入参=${(tool.inputPreview ?? '').slice(0, 160)}\n`,
      )
    }
    for (const error of result.errors) process.stdout.write(`  ! ${error.code} ${error.message}\n`)
    if (argv.includes('--frames')) {
      for (const frame of result.frames) {
        process.stdout.write(`  · 帧 ${JSON.stringify(frame).slice(0, 600)}\n`)
      }
    }
    if (harness.upstream !== null) {
      const state = harness.upstream.requests()
      process.stdout.write(`假上游收到 ${String(state.length)} 次模型请求：\n`)
      for (const item of state) {
        process.stdout.write(
          `  · ${item.kind} #${String(item.step)} 脚本=${String(item.script)}（${item.matchedBy}）工具数=${String(item.toolNames.length)}\n`,
        )
      }
    }
    process.exitCode = result.tools.some((tool) => tool.finished) ? 0 : 1
  } finally {
    // 先清理再退出：`process.exit()` 会跳过 finally，容器/网络/临时目录就都留下来了
    await harness.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`探针失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(2)
})
