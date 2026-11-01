import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))
const nodeRemoteSrc = fileURLToPath(new URL('../../packages/dsh-node-remote/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    // 测试直接跑 shared 的 TS 源码，避免「先 build shared 才能 test」的隐式依赖
    alias: { '@dsh-hub/shared': sharedSrc, '@dsh-hub/dsh-node-remote': nodeRemoteSrc },
  },
  test: {
    environment: 'node',
    // CI（GitHub 的 2 核 runner）比开发机慢得多，少数依赖时序的用例会偶发超时；只在 CI 上重试，本地仍一次定生死
    retry: process.env['CI'] ? 2 : 0,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: 'forks',
    // 每个 fork 都会加载整个 app（Fastify + node:sqlite），不限并发时 24 核机器会起十几个、吃掉十几 GB（WP13 OOM）
    maxWorkers: 4,
  },
})
