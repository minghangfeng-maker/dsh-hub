/**
 * dev 占位面板里的假会话列表（WP56c）。
 *
 * 真实模式下左侧「会话列表」在 `iframe /m/?embed=cockpit` 里，由 App 网页版提供；
 * 开发环境没有 `/m/`（那份构建在 App 仓库，随 hub-api 发布），所以座舱页显示一个占位面板，
 * 用它模拟 iframe 的 `{ type:'cockpit.session' }` 消息，好让右侧画布能跟着切会话走查与截图。
 *
 * `mocks/cockpit.ts` 的画布卡按这里的 id 分桶 —— 两边共用同一份常量，避免写两次写歪。
 */
export interface DevCockpitSession {
  id: string
  title: string
  /** 会话发起人（多管理员共享会话列表时显示，docs/24 §10 第 4 条） */
  owner: string
}

export const DEV_COCKPIT_SESSIONS: DevCockpitSession[] = [
  { id: 'sess_weekly_usage', title: '本周用量', owner: 'admin' },
  { id: 'sess_plugin_upgrade', title: '插件升级', owner: 'admin' },
  { id: 'sess_oncall_1029', title: '值班 10-29', owner: 'ops' },
]
