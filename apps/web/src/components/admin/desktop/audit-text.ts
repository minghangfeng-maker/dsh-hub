import type { DesktopDeviceAuditItem } from '@dsh-hub/shared'

/**
 * 设备详情抽屉里「这台设备最近发生了什么」→ 一句中文（WP25f 交付物 1）。
 *
 * 只读审计里的**动作 + 少量结构化字段**（`from`/`to`/`mode`/`result`），
 * **不读** `detail.userAgent`、`detail.ip` 这类记录原始上报/来源的键 —— 详情抽屉的隐私口径是
 * 「只显示白名单字段」（WP25e 的设备详情响应里本来就没有 IP / 没有原始上报 JSON）。
 *
 * 认不出的动作原样显示动作名（等宽字体），比猜一句错的好。
 */
export interface DesktopAuditText {
  /** 一句话（动作 + 关键字段） */
  text: string
  /** 认不出这个动作时为 true：界面用等宽字体显示原文 */
  raw: boolean
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function desktopAuditText(item: DesktopDeviceAuditItem): DesktopAuditText {
  const detail = item.detail ?? {}
  switch (item.action) {
    case 'desktop.login': {
      const version = asText(detail['appVersion'])
      return { text: version ? `登录桌面端（客户端 ${version}）` : '登录桌面端', raw: false }
    }
    case 'desktop.rename': {
      const from = asText(detail['from'])
      const to = asText(detail['to'])
      if (from && to) return { text: `设备改名为「${to}」（原来叫「${from}」）`, raw: false }
      return { text: to ? `设备改名为「${to}」` : '设备改名', raw: false }
    }
    case 'desktop.revoke':
      return { text: '用户自己退出登录', raw: false }
    case 'desktop.admin-revoke': {
      if (detail['batch'] !== true) return { text: '管理员吊销', raw: false }
      const result = asText(detail['result'])
      if (result === 'revoked') return { text: '管理员批量吊销（本次成功）', raw: false }
      if (result === 'already_revoked') return { text: '管理员批量吊销（此前已吊销）', raw: false }
      if (result === 'not_found') return { text: '管理员批量吊销（设备不存在）', raw: false }
      if (result === 'failed') return { text: '管理员批量吊销（失败）', raw: false }
      return { text: '管理员批量吊销', raw: false }
    }
    case 'desktop.agent-mode-key': {
      const mode = asText(detail['mode'])
      if (mode === 'claude') return { text: '签发 Claude Code 的对话模式密钥', raw: false }
      if (mode === 'codex') return { text: '签发 Codex 的对话模式密钥', raw: false }
      return { text: '签发对话模式密钥', raw: false }
    }
    case 'desktop.tokens.cleanup': {
      const removed = detail['removed']
      return {
        text: typeof removed === 'number' ? `清理过期令牌 ${String(removed)} 条` : '清理过期令牌',
        raw: false,
      }
    }
    default:
      return { text: item.action, raw: true }
  }
}
