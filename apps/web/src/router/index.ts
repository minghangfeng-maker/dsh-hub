import type { Pinia } from 'pinia'
import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'

import { setAuthRedirectHandler } from '@/api/http'
import { desktopLegacyLocation } from '@/composables/admin-platform'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/** 布局名（07 §3 的「布局」列）：App.vue 按 meta.layout 选择外壳；cockpit 是座舱（WP56c，无侧边栏）。 */
export type LayoutName = 'auth' | 'user' | 'admin' | 'blank'

declare module 'vue-router' {
  interface RouteMeta {
    /** 该路由使用哪个布局，缺省 auth */
    layout?: LayoutName
    /** 需要登录 */
    requiresAuth?: boolean
    /** 需要管理员 */
    requiresAdmin?: boolean
    /** 仅游客可见（登录/注册）：已登录访问会被送回 /home */
    guestOnly?: boolean
    /** 面包屑与文档标题用的中文名 */
    title?: string
  }
}

/**
 * 07 §3 路由表。全部懒加载，name 与文档「名称」列完全一致。
 * 布局写在 meta.layout 上，由 App.vue 选择（布局是带 <slot/> 的纯外壳）。
 */
export const routes: RouteRecordRaw[] = [
  {
    // 公开主页（WP36）：免登录，不能再跳到 /home —— 未登录访问 / 会落到登录页
    path: '/',
    name: 'Landing',
    component: () => import('@/views/LandingView.vue'),
    meta: { layout: 'blank', title: 'DSH Hub' },
  },
  {
    // 公开使用文档（WP44）：免登录，从公开主页顶栏与页脚链过来
    path: '/docs',
    name: 'Docs',
    component: () => import('@/views/DocsView.vue'),
    meta: { layout: 'blank', title: '使用文档' },
  },

  // ---- 认证页（AuthLayout） ----
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: { layout: 'auth', guestOnly: true, title: '登录' },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/auth/RegisterView.vue'),
    meta: { layout: 'auth', guestOnly: true, title: '注册' },
  },
  {
    // 必须改密时的独立页（07 §3）：守卫会把 mustChangePassword 的用户按在这里
    path: '/me/password',
    name: 'ForcePassword',
    component: () => import('@/views/auth/ForcePasswordView.vue'),
    meta: { layout: 'auth', requiresAuth: true, title: '修改密码' },
  },
  {
    /**
     * 找回密码（WP54c）：手机 App / 手机网页版的登录页同源打开这个地址
     * （App 侧 `webPage('/forgot-password')`）。Hub 没有自助重置，页面只说明找管理员，
     * 以前这里落 404 —— 在手机上等于没有这条路。
     */
    path: '/forgot-password',
    name: 'ForgotPassword',
    component: () => import('@/views/auth/ForgetPasswordView.vue'),
    meta: { layout: 'auth', guestOnly: true, title: '找回密码' },
  },
  {
    // 手机 App 的「去网页修改密码」打开 `/settings/security`（App 侧写死的路径，WP54c）：
    // Hub 的改密表单在个人中心「安全」Tab，这里原样转到那一页
    path: '/settings/security',
    redirect: { path: '/me', query: { tab: 'security' } },
  },

  // ---- 用户端（UserLayout） ----
  {
    path: '/home',
    name: 'Home',
    component: () => import('@/views/user/HomeView.vue'),
    meta: { layout: 'user', requiresAuth: true, title: '我的工作台' },
  },
  {
    path: '/me',
    name: 'Me',
    component: () => import('@/views/user/MeView.vue'),
    meta: { layout: 'user', requiresAuth: true, title: '个人中心' },
  },
  {
    // 12 §10：中转站未开通（enabled=false）时导航隐藏，直接访问显示未开通空状态
    path: '/usage',
    name: 'Usage',
    component: () => import('@/views/user/UsageView.vue'),
    meta: { layout: 'user', requiresAuth: true, title: '积分与用量' },
  },

  // ---- 管理端（AdminLayout，带侧边栏） ----
  {
    // `/admin` 落到概览
    path: '/admin',
    redirect: (to) => ({ path: '/admin/overview', query: to.query }),
  },
  {
    path: '/admin/overview',
    name: 'AdminOverview',
    component: () => import('@/views/admin/AdminOverviewView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '概览' },
  },
  {
    // WP57：座舱的对话 + 事件卡片，去掉舰桥外壳的独立页（docs/25 §5）
    path: '/admin/assistant',
    name: 'AdminAssistant',
    component: () => import('@/views/admin/AdminAssistantView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: 'AI 助手' },
  },
  {
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('@/views/admin/AdminUsersView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '用户' },
  },
  {
    path: '/admin/users/:id',
    name: 'AdminUserDetail',
    component: () => import('@/views/admin/AdminUserDetailView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '用户详情' },
  },
  {
    path: '/admin/instances',
    name: 'AdminInstances',
    component: () => import('@/views/admin/AdminInstancesView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '实例' },
  },
  {
    path: '/admin/plugins',
    name: 'AdminPlugins',
    component: () => import('@/views/admin/AdminPluginsView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '插件' },
  },
  {
    path: '/admin/plugins/:id',
    name: 'AdminPluginDetail',
    component: () => import('@/views/admin/AdminPluginDetailView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '插件详情' },
  },
  {
    path: '/admin/runtimes',
    name: 'AdminRuntimes',
    component: () => import('@/views/admin/AdminRuntimesView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: 'DSH 版本' },
  },
  {
    path: '/admin/models',
    name: 'AdminModels',
    component: () => import('@/views/admin/AdminModelsView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '模型' },
    /**
     * 15 §1：旧的「模型 → 搜索池」标签（`?tab=tools`）直接跳独立页，
     * 不能落到模型概览；其余查询参数（如 `userId`）原样带过去。
     */
    beforeEnter: (to) => {
      const tab = Array.isArray(to.query['tab']) ? to.query['tab'][0] : to.query['tab']
      if (tab !== 'tools') return true
      const query = { ...to.query }
      delete query['tab']
      return { path: '/admin/search', query }
    },
  },
  {
    // 18 §6：Claude Code 与 Codex 各一页，同一个视图组件按 mode 切换文案与协议
    path: '/admin/claude-code',
    name: 'AdminClaudeCode',
    component: () => import('@/views/admin/AdminAgentModeView.vue'),
    props: { mode: 'claude-code' },
    meta: { layout: 'admin', requiresAdmin: true, title: 'Claude Code' },
  },
  {
    path: '/admin/codex',
    name: 'AdminCodex',
    component: () => import('@/views/admin/AdminAgentModeView.vue'),
    props: { mode: 'codex' },
    meta: { layout: 'admin', requiresAdmin: true, title: 'Codex' },
  },
  {
    path: '/admin/search',
    name: 'AdminSearch',
    component: () => import('@/views/admin/AdminSearchView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '搜索池' },
  },
  {
    // 12 §10：WP11 起「中转站」并进「模型」页；旧地址原样带上 tab / userId 等查询参数
    path: '/admin/relay',
    redirect: (to) => ({ path: '/admin/models', query: to.query }),
  },
  {
    // 统一下发向导（docs/21）：规范地址是 `/admin/rollouts`（插件库的批量下发按钮也跳这里）
    path: '/admin/rollouts',
    name: 'AdminRolloutWizard',
    component: () => import('@/views/admin/AdminRolloutWizardView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '下发' },
  },
  {
    // 旧地址：查询串（预填）原样带过去，插件库 / 用户详情 / DSH 版本页上的老按钮仍然能用
    path: '/admin/rollouts/new',
    redirect: (to) => ({ path: '/admin/rollouts', query: to.query }),
  },
  {
    path: '/admin/jobs',
    name: 'AdminJobs',
    component: () => import('@/views/admin/AdminJobsView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '任务中心' },
  },
  {
    path: '/admin/jobs/:id',
    name: 'AdminJobDetail',
    component: () => import('@/views/admin/AdminJobDetailView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '任务详情' },
  },
  {
    path: '/admin/invites',
    name: 'AdminInvites',
    component: () => import('@/views/admin/AdminInvitesView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '邀请码' },
  },
  {
    path: '/admin/settings',
    name: 'AdminSettings',
    component: () => import('@/views/admin/AdminSettingsView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '系统设置' },
  },
  {
    path: '/admin/audit',
    name: 'AdminAudit',
    component: () => import('@/views/admin/AdminAuditView.vue'),
    meta: { layout: 'admin', requiresAdmin: true, title: '审计日志' },
  },

  // ---- 桌面端（WP25c）：授权页 / 隐私说明 / 下载占位 ----
  {
    // 桌面端在系统浏览器里打开：`/desktop/authorize?req=<id>`（D2 §3.2）。
    // 未登录时守卫会把 `next`（含 req）带到登录页，登录后原样回到本页。
    path: '/desktop/authorize',
    name: 'DesktopAuthorize',
    component: () => import('@/views/desktop/DesktopAuthorizeView.vue'),
    meta: { layout: 'auth', requiresAuth: true, title: '登录授权' },
  },
  {
    // 隐私说明：不需要登录（用户还没信任这个站之前就要能读到）
    // WP54c：`/privacy` 是手机 App / 手机网页版「隐私政策」打开的地址（App 侧 `webPage('/privacy')`），
    // 用别名指到同一份说明，不再落 404；文案仍是桌面端口径（见进度报告里给编排者的建议）。
    path: '/desktop/privacy',
    alias: '/privacy',
    name: 'DesktopPrivacy',
    component: () => import('@/views/desktop/DesktopPrivacyView.vue'),
    meta: { layout: 'blank', title: '桌面端隐私说明' },
  },
  {
    // 旧下载地址（WP25c 的占位页）：安装包与下载入口在 WP36 合并到公开主页
    path: '/desktop/download',
    redirect: '/',
  },

  // ---- 桌面端下发（WP25d → WP32b）：独立页已拆进各页的「云上 | 桌面」切换，旧地址只做重定向 ----
  {
    path: '/admin/desktop',
    redirect: (to) => desktopLegacyLocation(to.query),
  },

  // ---- 兜底 404 ----
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/auth/NotFoundView.vue'),
    meta: { layout: 'auth', title: '页面不存在' },
  },
]

/**
 * 样式自查页（任务书交付物 9）：**仅开发环境**存在。
 * 放在路由表末尾，生产构建时这段代码连同组件一起被 tree-shake 掉。
 */
export const devRoutes: RouteRecordRaw[] = import.meta.env.DEV
  ? [
      {
        path: '/__style',
        name: 'StyleGuide',
        component: () => import('@/views/StyleGuideView.vue'),
        meta: { layout: 'blank', title: '样式自查' },
      },
    ]
  : []

/**
 * 是否是可以安全回跳的站内路径（防开放重定向）：
 * 必须以单个 `/` 开头，不能是协议相对地址，也不能回跳到登录/注册页。
 */
export function isSafeInternalPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false
  if (path.includes('://')) return false

  const pathname = path.split(/[?#]/)[0] ?? ''
  return pathname !== '/login' && pathname !== '/register'
}

/** 从 `?next=` 里取安全的回跳路径（不合法就是 null）。 */
export function safeNextPath(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value
  return isSafeInternalPath(first) ? first : null
}

/**
 * 由服务端处理、不属于 SPA 的路径（DSH 代理 `/dsh/<用户名>/`、旧地址 `/u/<slug>/`）。
 * 登录后 `next` 回跳到这些路径必须整页跳转，`router.replace` 只会落到 SPA 的 404。
 */
export function isServerPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0] ?? ''
  return pathname === '/dsh' || pathname.startsWith('/dsh/') || pathname.startsWith('/u/')
}

/** 需要跳登录时带上 `next`（登录页/根路径不带，避免绕圈）。 */
function nextQuery(fullPath: string): Record<string, string> | undefined {
  if (fullPath === '/' || fullPath.startsWith('/login') || fullPath.startsWith('/me/password'))
    return undefined
  return { next: fullPath }
}

export interface CreateAppRouterOptions {
  /** 显式指定 pinia（测试用）；缺省用当前激活的实例 */
  pinia?: Pinia
  /** 整页跳转（测试用）；缺省 `window.location.assign` */
  assignLocation?: (url: string) => void
}

/**
 * 创建应用路由，并安装守卫（07 §3）：
 * - 游客页：已登录访问 `/login`、`/register` → 回 `next` 或 `/home`；
 * - 登录页/管理员页：未登录 → `/login?next=…`；非管理员访问 `/admin*` → `/home`；
 * - 强制改密：`mustChangePassword` 的用户除 `/me/password` 外一律被拦；
 * - 同时把 `api/http.ts` 的 401 / MUST_CHANGE_PASSWORD 全局跳转接到路由器上。
 */
export function createAppRouter(
  history: RouterHistory = createWebHistory(),
  options: CreateAppRouterOptions = {},
): Router {
  const router = createRouter({
    history,
    routes: [...routes, ...devRoutes],
    // 15 §2.4：`/home#plugins`、`/home#data` 这类旧链接要滚到对应区块；其余路由仍回顶部
    scrollBehavior: (to) => (to.hash ? { el: to.hash, behavior: 'smooth' } : { top: 0 }),
  })

  const useStores = () => ({
    auth: useAuthStore(options.pinia),
    site: useSiteStore(options.pinia),
  })

  router.beforeEach(async (to) => {
    if (isServerPath(to.fullPath)) {
      ;(options.assignLocation ?? ((url: string) => window.location.assign(url)))(to.fullPath)
      return false
    }

    const { auth, site } = useStores()

    // 站点信息（注册开关等）与登录态都以「第一次导航」为界各拉一次
    void site.load()
    await auth.ensureLoaded()

    const requiresAuth = to.matched.some((record) => record.meta.requiresAuth === true)
    const requiresAdmin = to.matched.some((record) => record.meta.requiresAdmin === true)
    const guestOnly = to.matched.some((record) => record.meta.guestOnly === true)

    if (!auth.isLoggedIn) {
      if (requiresAuth || requiresAdmin) {
        return { path: '/login', query: nextQuery(to.fullPath) }
      }
      return true
    }

    if (auth.mustChangePassword && to.name !== 'ForcePassword') {
      return { path: '/me/password', query: nextQuery(to.fullPath) }
    }

    if (guestOnly) {
      return { path: safeNextPath(to.query['next']) ?? '/home' }
    }

    if (requiresAdmin && !auth.isAdmin) {
      return { path: '/home' }
    }

    return true
  })

  // 接口层的认证失效统一走路由（04 §0.2：401 跳登录、MUST_CHANGE_PASSWORD 跳改密）
  setAuthRedirectHandler(({ reason, next }) => {
    const { auth } = useStores()

    if (reason === 'must-change-password') {
      // 服务端说必须先改密：把本地标记同步过来，否则守卫会把 /me/password 又弹回 /home
      auth.patchUser({ mustChangePassword: true })
      if (router.currentRoute.value.name !== 'ForcePassword') {
        void router.replace({ path: '/me/password', query: next ? { next } : undefined })
      }
      return
    }

    // 401 说明会话已经没了：先清本地登录态，否则守卫会把人从 /login 弹回 /home
    auth.setUser(null)
    if (router.currentRoute.value.name === 'Login') return
    void router.replace({ path: '/login', query: next ? { next } : undefined })
  })

  return router
}

const router = createAppRouter()

export default router
