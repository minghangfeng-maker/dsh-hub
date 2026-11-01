/**
 * 管理端侧边栏（07 §4）：分组 + 条目。
 *
 * 单独放在这里（不是 `AdminLayout.vue` 里的常量）有两个原因：侧边栏是**共享文件**，
 * 多个任务包都要在末尾追加条目，独立文件让追加不会撞上布局组件的改动；
 * 另外测试可以直接断言「入口在哪个组、排在什么位置」。
 */
export interface AdminNavItem {
  label: string
  to: string
  icon: string
}

export interface AdminNavGroup {
  title: string
  items: AdminNavItem[]
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  // WP57：座舱下线，`/admin` 重定向到这里
  {
    title: '',
    items: [
      { label: '概览', to: '/admin/overview', icon: 'i-ph-squares-four' },
      // WP57：座舱的「对话 → 方案 → 确认执行」，独立一页放在概览下面
      { label: 'AI 助手', to: '/admin/assistant', icon: 'i-ph-sparkle' },
    ],
  },
  {
    title: '人与环境',
    items: [
      { label: '用户', to: '/admin/users', icon: 'i-ph-users' },
      { label: '实例', to: '/admin/instances', icon: 'i-ph-hard-drives' },
    ],
  },
  {
    title: '能力下发',
    items: [
      // WP32b：统一下发是插件 / 模型 / DSH 版本各页「下发」的统一入口，放组内第一位
      { label: '下发', to: '/admin/rollouts', icon: 'i-ph-paper-plane-tilt' },
      { label: '插件', to: '/admin/plugins', icon: 'i-ph-puzzle-piece' },
      { label: 'DSH 版本', to: '/admin/runtimes', icon: 'i-ph-git-branch' },
      { label: '模型', to: '/admin/models', icon: 'i-ph-cpu' },
      // 18 §6：两个对话模式各一页（放在「模型」后面）
      { label: 'Claude Code', to: '/admin/claude-code', icon: 'i-ph-robot' },
      { label: 'Codex', to: '/admin/codex', icon: 'i-ph-code' },
      { label: '搜索池', to: '/admin/search', icon: 'i-ph-magnifying-glass' },
      { label: '任务中心', to: '/admin/jobs', icon: 'i-ph-list-checks' },
      // WP32b：独立的「桌面端」入口已删 —— 桌面侧内容拆进各页的「云端 | 桌面」切换（docs/22 §1.1）
    ],
  },
  {
    title: '系统',
    items: [
      { label: '邀请码', to: '/admin/invites', icon: 'i-ph-ticket' },
      { label: '系统设置', to: '/admin/settings', icon: 'i-ph-gear-six' },
      { label: '审计日志', to: '/admin/audit', icon: 'i-ph-scroll' },
    ],
  },
]
