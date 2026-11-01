import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import { useAuthStore } from './stores/auth'
import { isCockpitEmbed } from './lib/cockpit-embed'

/**
 * 设置页是懒加载 chunk。0.4.5 起在空闲时/打开抽屉时**预取**（见 App.vue）：
 * 真机上从抽屉点「设置」时，这个 chunk（几 KB）已经在内存里，不会在首帧前再等一次网络。
 * 这里导出同一个加载函数，保证预取的就是路由要用的那一块（同一个模块请求）。
 */
const loadSettingsView = () => import('./views/SettingsView.vue')

export function prefetchSettingsView(): void {
  void loadSettingsView().catch(() => {
    /* 预取失败无所谓：真进设置页时路由会再拉一次 */
  })
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
    },
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/c/:id',
      name: 'conversation',
      component: () => import('./views/ConversationView.vue'),
    },
    {
      path: '/all',
      name: 'all',
      component: () => import('./views/AllChatsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: loadSettingsView,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

/**
 * 登录闸门：首次进入先等令牌恢复（Keystore 读取很快），再决定去首页还是登录页。
 * 卡片/抽屉等页面不单独做权限判断，统一走这里。
 *
 * 嵌入座舱（WP56d）例外：那里**没有登录页**（令牌只来自父页面的交接码），也**没有**账号/
 * 设置页。所以：
 *  - 未登录也放行（App.vue 会盖一层「正在连接座舱」）；
 *  - `/login`、`/settings` 一律改成首页（不渲染登录/设置界面）。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (auth.phase === 'boot') await auth.init()
  if (isCockpitEmbed()) {
    if (to.name === 'login' || to.name === 'settings') return { name: 'home', replace: true }
    return true
  }
  if (!auth.isAuthenticated && to.name !== 'login') {
    return { name: 'login', replace: true }
  }
  if (auth.isAuthenticated && to.name === 'login') {
    return { name: 'home', replace: true }
  }
  return true
})
