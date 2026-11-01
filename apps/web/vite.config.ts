import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vitest/config'

/**
 * 这里用 URL 而不是 node:url 取路径：本仓库根没装 @types/node，
 * 而 vite.config.ts 也在 apps/web/tsconfig.json 的 include 里，必须能过 vue-tsc。
 */
const srcDir = new URL('./src', import.meta.url).pathname
const sharedEntry = new URL('../../packages/shared/src/index.ts', import.meta.url).pathname

// 同上：只用到 process.env，不需要引入 @types/node
declare const process: { env: Record<string, string | undefined> }

/**
 * `/api`、`/dsh`、`/u`、`/ca.crt` 代理到哪个后端。
 * 默认是 WP0a 的调试端口 7701（本仓库的端口约定（见 README））；联调时用 `HUB_API_TARGET` 指向自己包的 API 端口
 * （WP5a 第二轮用 7759；WP16 用 7861），这样各包可以同时起自己的 api + vite 而不互相打架。
 */
const apiTarget = process.env['HUB_API_TARGET'] ?? 'http://127.0.0.1:7701'

export default defineConfig({
  plugins: [vue(), UnoCSS()],
  resolve: {
    alias: {
      '@': srcDir,
      // shared 是 TS 源码直引（04 契约），必须指向 src 而不是 dist
      '@dsh-hub/shared': sharedEntry,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5171,
    strictPort: true,
    proxy: Object.fromEntries(
      // `^/dsh`、`^/u/` 用正则（vite 对以 ^ 开头的键按 RegExp 处理）：WP10b 的 `/usage` 不能被 `/u` 前缀吃掉；
      // `/dsh/` 是 DSH 的规范地址（WP16，WS 也要转发），`/u/` 留给旧地址 301 的联调
      ['/api', '^/dsh($|/)', '^/u/', '/ca.crt'].map((path) => [
        path,
        { target: apiTarget, ws: true, changeOrigin: false },
      ]),
    ),
  },
  build: {
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        // 唤醒页：WP5b 会实现真正的唤醒逻辑，这里先占位
        wake: new URL('./wake.html', import.meta.url).pathname,
      },
    },
  },
  test: {
    environment: 'jsdom',
    // CI（GitHub 的 2 核 runner）比开发机慢得多，少数依赖时序的用例会偶发超时；只在 CI 上重试，本地仍一次定生死
    retry: process.env['CI'] ? 2 : 0,
    // 整仓并行跑测试时机器负载高，组件挂载 + 路由懒加载会超过默认 5s；放宽到 20s 消除偶发超时
    testTimeout: 20_000,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // theme.test.ts 需要读取 tokens.css 的原始文本（`?raw`）；Vitest 默认会把 CSS 变成空模块
    css: true,
    // 限并发：整仓测试与别的长任务共用一台 16–24 GB 的机器（WP13 OOM）
    maxWorkers: 4,
  },
})
