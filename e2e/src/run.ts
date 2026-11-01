import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser } from './browser.js'
import { DATA_ROOT, JOURNEY_TIMEOUT_MS, REPO_ROOT, RUNTIME_IMAGE } from './config.js'
import { JourneyContext, JourneyFailure, JourneySkip, World, type JourneyResult } from './context.js'
import { HubHarness, runCommand } from './harness.js'
import { JOURNEYS } from '../tests/index.js'

/**
 * e2e 运行器：顺序执行旅程、汇总 JSON、自动清理（任务书交付物 1）。
 *
 * 用法：
 *   pnpm e2e                     完整跑（新 run-id；结束时停 Hub、删容器与网络、保留数据目录）
 *   pnpm e2e -- --only J3,J7     只跑指定旅程（复用最近一次的数据目录与会话）
 *   pnpm e2e -- --list           列出旅程与依赖
 *   pnpm e2e -- --build          跑之前先 `pnpm -r build`
 */

interface Options {
  only: string[]
  list: boolean
  build: boolean
  reuse: boolean
  runId?: string
  keepContainers: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { only: [], list: false, build: false, reuse: false, keepContainers: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '--list') options.list = true
    else if (token === '--build') options.build = true
    else if (token === '--keep-containers') options.keepContainers = true
    else if (token === '--only') {
      options.only = (argv[index + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      index += 1
    } else if (token === '--run-id') {
      options.runId = argv[index + 1]
      index += 1
    } else if (token.startsWith('--only=')) {
      options.only = token.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean)
    }
  }
  options.reuse = options.only.length > 0
  return options
}

function makeRunId(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const random = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${random}`
}

const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]{4}$/

/** 最近一次运行目录（`--only` 复用它，接上已注册的用户与已跑过的旅程） */
function latestRunDir(): string | null {
  if (!readdirSync(DATA_ROOT, { withFileTypes: true }).length) return null
  const dirs = readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  return dirs.length > 0 ? (dirs[dirs.length - 1] ?? null) : null
}

/** 只保留最近 N 次运行的数据目录（其余删除；路径必须严格落在 e2e/.data 下且符合 run-id 形状） */
function pruneOldRuns(keep: number): string[] {
  const removed: string[] = []
  const dirs = readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    const target = join(DATA_ROOT, name)
    if (!target.startsWith(`${DATA_ROOT}/`) || !RUN_ID_PATTERN.test(name)) continue
    rmSync(target, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

const TIMEOUT = Symbol('timeout')

/** 带超时的等待：超时后**清掉定时器**（否则 8 分钟的 timer 会拖住进程退出） */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runJourney(
  journey: (typeof JOURNEYS)[number],
  ctx: JourneyContext,
  timeoutMs: number,
): Promise<JourneyResult> {
  const started = Date.now()
  const result: JourneyResult = {
    id: journey.id,
    title: journey.title,
    status: 'passed',
    durationMs: 0,
    assertions: ctx.assertions,
    screenshots: ctx.screenshots,
    artifacts: ctx.artifacts,
    notes: ctx.notes,
  }
  try {
    const outcome = await withTimeout(journey.run(ctx), timeoutMs)
    if (outcome === TIMEOUT) {
      throw new JourneyFailure(`旅程超时（${String(Math.round(timeoutMs / 1000))}s）`)
    }
  } catch (error) {
    if (error instanceof JourneySkip) {
      result.status = 'skipped'
      ctx.skip(journey.id, error.message)
    } else {
      result.status = 'failed'
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      await ctx.captureFailure(ctx.lastPage(), error)
      // 失败的旅程一律补一个说明，避免报告里看起来是静默通过
      if (ctx.assertions.every((item) => item.status !== 'fail')) {
        ctx.fail(`${journey.id} 未完成`, result.error.split('\n')[0])
      }
    }
  }
  result.durationMs = Date.now() - started
  // result.notes 与 ctx.notes 是同一个数组（构造时直接引用），不要再 push 一次
  // 断言失败 = 旅程失败（不能因为异常没抛出就报通过）
  if (result.status === 'passed' && ctx.assertions.some((item) => item.status === 'fail')) {
    result.status = 'failed'
    result.error = ctx.assertions
      .filter((item) => item.status === 'fail')
      .map((item) => `${item.name}${item.detail ? `：${item.detail}` : ''}`)
      .join('\n')
  }
  return result
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.list) {
    process.stdout.write('旅程列表：\n')
    for (const journey of JOURNEYS) {
      process.stdout.write(`  ${journey.id.padEnd(4)} ${journey.title}${journey.dependsOn ? `（依赖 ${journey.dependsOn}）` : ''}\n`)
    }
    return
  }

  process.stdout.write('== DSH Hub 端到端测试（WP8a）==\n')
  const missing = HubHarness.checkBuildArtifacts()
  if (options.build || missing.length > 0) {
    if (missing.length > 0) process.stdout.write(`缺少构建产物（${missing.join('、')}），先跑 pnpm -r build…\n`)
    else process.stdout.write('按 --build 重新构建…\n')
    const build = await runCommand('pnpm', ['-r', 'build'], { cwd: REPO_ROOT, timeoutMs: 15 * 60_000 })
    if (build.code !== 0) {
      process.stderr.write(`构建失败：\n${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}\n`)
      process.exitCode = 1
      return
    }
  } else if (HubHarness.staleArtifacts()) {
    process.stdout.write('⚠ 源码比构建产物新，可能测到旧代码（加 --build 可强制重建）\n')
  }

  const selected = JOURNEYS.filter((journey) => options.only.length === 0 || options.only.includes(journey.id))
  if (selected.length === 0) {
    process.stderr.write(`没有匹配的旅程：${options.only.join('、')}\n`)
    process.exitCode = 1
    return
  }
  // J1/J2 需要干净数据库（CLI 建管理员、邀请码只能消耗一次）：即使给了 --only 也不复用上一次的数据目录
  const needsFreshData = selected.some((journey) => journey.needsFreshData === true)
  const reuse = options.reuse && !needsFreshData
  const runId = options.runId ?? (reuse ? (latestRunDir() ?? makeRunId()) : makeRunId())
  const harness = new HubHarness(runId)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  process.stdout.write(`run-id ${runId}（数据目录 ${harness.dataDir}）\n`)
  if (options.only.length > 0) process.stdout.write(`只跑：${options.only.join('、')}\n`)
  if (options.reuse && !reuse) process.stdout.write('选中的旅程需要干净数据库，已改用新的数据目录（不是复用）\n')
  mkdirSync(DATA_ROOT, { recursive: true })
  harness.ensureDirs()

  const session = await launchBrowser()
  const world = new World(session.browser, runId, harness.dataDir)
  const results: JourneyResult[] = []
  let cleanup: { removed: string[]; network: string | null; notes: string[] } = {
    removed: [],
    network: null,
    notes: [],
  }

  try {
    await harness.start()
    // 任务书：数据库里没有 runtime 记录时，把本机已有的 dshhub/runtime:<版本> 登记为默认版本（不重新构建）。
    // WP8b P1 起统一走 `cli runtime:adopt`（校验镜像存在 + 冒烟 dsh --version）。
    const seeded = await harness.adoptDefaultRuntime()
    process.stdout.write(`默认 runtime：${seeded.detail}\n`)

    for (const journey of selected) {
      process.stdout.write(`\n── ${journey.id} ${journey.title}\n`)
      const ctx = new JourneyContext(journey.id, harness, world, session.browser, harness.dataDir)
      const result = await runJourney(journey, ctx, journey.timeoutMs ?? JOURNEY_TIMEOUT_MS)
      results.push(result)
      process.stdout.write(
        `   ${result.status === 'passed' ? '✅ 通过' : result.status === 'skipped' ? '⏭ 跳过' : '❌ 失败'} ${journey.id}（${(result.durationMs / 1000).toFixed(1)}s）\n`,
      )
    }
  } finally {
    await world.close().catch(() => undefined)
    await session.close().catch(() => undefined)
    await harness.recordContainers().catch(() => undefined)
    if (!options.keepContainers) {
      cleanup = await harness.cleanupContainers().catch((error: unknown) => ({
        removed: [],
        network: null,
        notes: [String(error)],
      }))
    }
    await harness.stop().catch(() => undefined)
  }

  const summary = {
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  }
  const payload = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    baseUrl: harness.baseUrl,
    dataDir: harness.dataDir,
    hubLog: harness.logFile,
    runtimeImage: RUNTIME_IMAGE,
    journeys: results,
    summary,
    containers: harness.containersSeen(),
    cleanup,
  }
  const resultFile = join(harness.dataDir, 'result.json')
  writeFileSync(resultFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  harness.writeRunMeta({ summary, resultFile })

  process.stdout.write('\n== 汇总 ==\n')
  for (const item of results) {
    const failed = item.assertions.filter((assertion) => assertion.status === 'fail')
    process.stdout.write(
      `${item.status === 'passed' ? '✅' : item.status === 'skipped' ? '⏭' : '❌'} ${item.id} ${item.title}（${(item.durationMs / 1000).toFixed(1)}s，断言 ${String(item.assertions.length)} 条${failed.length > 0 ? `，失败 ${String(failed.length)}` : ''}）\n`,
    )
  }
  process.stdout.write(
    `通过 ${String(summary.passed)} / 失败 ${String(summary.failed)} / 跳过 ${String(summary.skipped)}；结果 ${resultFile}\n`,
  )
  process.stdout.write(
    `清理：容器 ${cleanup.removed.length > 0 ? cleanup.removed.join('、') : '无'}；网络 ${cleanup.network ?? '未删除'}；数据目录保留 ${harness.dataDir}\n`,
  )
  const pruned = pruneOldRuns(2)
  if (pruned.length > 0) process.stdout.write(`已清理旧数据目录：${pruned.join('、')}\n`)

  if (summary.failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  process.stderr.write(`运行器异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
