import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { initCockpitEmbed } from './lib/cockpit-embed'
import './styles/app.css'
// 舰桥主题（WP56d）：只在 `html.cockpit-bridge` 下生效，普通 /m/ 与 APK 一条都不命中。
import './styles/cockpit-bridge.css'
// 控制台主题（WP58）：只在 `html.cockpit-console` 下生效，同上。
import './styles/cockpit-console.css'
import 'katex/dist/katex.min.css'

/**
 * 管理座舱嵌入模式（WP56d）必须**在 router 之前**读入口：
 *  - 嵌入模式用 `/m/?embed=cockpit#code=<交接码>`；
 *  - 而 App 用的是 hash 路由（`#/`、`#/c/xxx`）—— `#code=…` 会被当成一个不存在的路由，
 *    然后被兜底重定向到首页，路由历史里还会留下这个 URL。
 * 这里先把码取出来并从地址栏抹掉（`replaceState`，不进历史），后面才装 router。
 */
initCockpitEmbed()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
