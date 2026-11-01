import { defineConfig } from 'vitest/config'

// 本机 shell 默认 NODE_ENV=production，会让 vitest 出现假失败（见 docs 硬约束 5）。
// package.json 里已用 cross-env 显式设为 development，这里再兜一层。
process.env.NODE_ENV = 'development'

export default defineConfig({
  test: {
    environment: 'node',
    // CI（GitHub 的 2 核 runner）比开发机慢得多，少数依赖时序的用例会偶发超时；只在 CI 上重试，本地仍一次定生死
    retry: process.env['CI'] ? 2 : 0,
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
})
