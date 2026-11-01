import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { RequestMeta } from '../src/context.js'
import { loadConfig } from '../src/config.js'
import { createTestClock, type TestClock } from '../src/lib/clock.js'
import { FakeDriver } from '../src/modules/instances/fake-driver.js'

/** WP4 的调试端口（11 §3），测试里只用来做 Origin 校验，不真正监听 */
export const WP4_ORIGIN = 'http://127.0.0.1:7741'

export interface Wp4TestApp {
  app: FastifyInstance
  dataDir: string
  clock: TestClock
  /** 关掉 app；`dataDir` 由创建者负责删除（复用目录模拟重启时用） */
  close(): Promise<void>
}

export interface CreateWp4AppOptions {
  /** 复用已有目录（模拟 Hub 重启） */
  dataDir?: string
  clock?: TestClock
}

/** 与 test/helpers.ts 的 createTestApp 同构，但用 WP4 的 Origin 且支持复用 dataDir */
export async function createWp4App(opts: CreateWp4AppOptions = {}): Promise<Wp4TestApp> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), `dshhub-test-wp4-${process.pid}-`))
  const ownsDir = opts.dataDir === undefined
  const clock = opts.clock ?? createTestClock()
  const config = loadConfig({
    HUB_DATA_DIR: dataDir,
    HUB_CONTAINER_DRIVER: 'fake',
    HUB_PUBLIC_ORIGIN: WP4_ORIGIN,
    HUB_LOG_LEVEL: 'silent',
  })
  const app = await buildApp({
    config,
    testing: true,
    driver: new FakeDriver({ clock }),
    clock,
  })
  return {
    app,
    dataDir,
    clock,
    async close() {
      await app.close()
      if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 建一个临时目录并登记，测试结束统一删（避免忘记清理 .data 之外的残留） */
export function makeTempDir(prefix = 'dshhub-test-wp4-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupDirs(dirs: string[]): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 轮询等待条件成立（引擎是异步调度，测试不要用固定 sleep 猜时间） */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const intervalMs = opts.intervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `waitFor 超时${opts.label ? `（${opts.label}）` : ''}${last === undefined ? '' : `：${String(last)}`}`,
  )
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 服务层调用用的请求元信息（暂停/取消/重试的审计字段） */
export const TEST_META: RequestMeta = { ip: '127.0.0.1', userAgent: 'vitest' }

// ── SSE ─────────────────────────────────────────────────────────────────────

export interface SseProbe {
  /** 目前已收到的原始文本 */
  text(): string
  /** 等到文本里出现某个片段/匹配（超时抛错） */
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>
  close(): Promise<void>
}

/**
 * 真连一次 SSE。`app.inject` 会等响应结束，而 SSE 是长连接，所以这里
 * `listen({port: 0})`（临时端口，不占用 11 §3 的分配端口）后用 fetch 流式读取。
 */
export async function connectSse(
  app: FastifyInstance,
  path: string,
  headers: Record<string, string>,
): Promise<SseProbe> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers,
    signal: controller.signal,
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // abort 时正常抛错
    }
  })()

  return {
    text: () => buffer,
    async waitFor(pattern, timeoutMs = 5000) {
      const matches = () => (typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer))
      await waitFor(matches, { timeoutMs, label: `SSE ${String(pattern)}` })
      return buffer
    },
    async close() {
      controller.abort()
      try {
        await reader.cancel()
      } catch {
        // 已关闭
      }
    },
  }
}
