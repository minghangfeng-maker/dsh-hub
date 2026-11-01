import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// 本机 shell 默认 NODE_ENV=production，测试要显式设成 development（文档 §0 第 5 条）
process.env.NODE_ENV = 'development'

export default defineConfig({
  // 与 vite.config.ts 一致：单测里 `__DSH_MOCK_HUB__` 恒为 false（永远走真实 HubClient，
  // 网络调用由各测试用假网关/假通道替换）。见 src/lib/instance.ts。
  define: {
    __DSH_MOCK_HUB__: 'false',
    // 单测不挂假语音桥（状态机测试自己注入 FakeBridge）
    __DSH_VOICE_DEMO_ENABLED__: 'false',
    // 单测默认按 APK 构建（网页版分支的测试自己 vi.mock app-info 或单独起配置）
    __DSH_WEB__: 'false',
    // 构建信息（vite.config.ts 在真构建里注入）：单测给固定值，断言才不会随机器变
    __DSH_BUILD_SHA__: JSON.stringify('testsha'),
    __DSH_BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
  },
  resolve: {
    alias: {
      '@dsh-hub/mobile-core': fileURLToPath(new URL('../mobile-core/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // CI（GitHub 的 2 核 runner）比开发机慢得多，少数依赖时序的用例会偶发超时；只在 CI 上重试，本地仍一次定生死
    retry: process.env['CI'] ? 2 : 0,
    include: ['test/**/*.test.ts'],
  },
})
