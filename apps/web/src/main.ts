import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import router from './router'

// 顺序有意为之：Uno 原子类先落地，设计令牌 + 全局基础样式 + 动效随后覆盖
import 'virtual:uno.css'
import '@/styles/tokens.css'
import '@/styles/global.css'
import '@/styles/motion.css'
// 座舱/AI 助手卡片用的深色语义令牌（`--b-*`，在页面里按需覆盖成浅色）
import '@/styles/bridge-tokens.css'

async function bootstrap(): Promise<void> {
  // 开发用假数据开关 `?mock=1`（WP5b；生产构建里这段是死分支，src/mocks/ 不会被摇进产物）
  if (import.meta.env.DEV) {
    const { setupMocksIfEnabled } = await import('@/mocks')
    await setupMocksIfEnabled()
  }

  const app = createApp(App)

  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

void bootstrap()
