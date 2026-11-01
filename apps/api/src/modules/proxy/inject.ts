/**
 * HTML 注入（05 §5.6、WP0b S2）。
 *
 * DSH 前端全用相对路径，所以代理**不需要**改写资源路径，也不需要 `<base href>`；
 * 唯一要注入的是 `ownsHost` —— 它决定 `dsh-client-connection` 的 `isLoopback`，
 * 设置页依赖它（缺了会提示 settings unavailable）。顺带注入「回到 Hub」的悬浮按钮。
 */
export const BACK_BUTTON_ID = 'dshhub-back'

/** `ownsHost` 注入片段（与 WP0b 实测过的形态逐字符一致） */
export const OWNS_HOST_SNIPPET =
  '<script>globalThis.__DSH_TRANSPORT__={...globalThis.__DSH_TRANSPORT__,ownsHost:true}</script>'

/** 悬浮按钮 + 注入脚本（极简、无依赖；用设计令牌，避免写死颜色） */
export const BACK_BUTTON_SNIPPET = `<style>
#${BACK_BUTTON_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--c-border,#e4f0ec);border-radius:var(--radius-pill,999px);background:var(--c-surface-glass,rgba(255,255,255,.88));color:var(--c-text-2,#62736d);font-size:13px;font-family:var(--font-sans,system-ui);text-decoration:none;box-shadow:var(--shadow-card,0 6px 24px rgba(52,199,160,.08));backdrop-filter:var(--blur-glass,blur(16px));transition:color var(--duration-base,180ms) var(--ease-out-soft,ease),box-shadow var(--duration-base,180ms) var(--ease-out-soft,ease)}
#${BACK_BUTTON_ID}:hover{color:var(--c-primary,#34c7a0);box-shadow:var(--shadow-hover,0 12px 32px rgba(52,199,160,.14))}
@media (prefers-reduced-motion:reduce){#${BACK_BUTTON_ID}{transition:none}}
</style><a id="${BACK_BUTTON_ID}" href="__HUB_BACK_URL__" title="回到 DSH Hub">← 回到 Hub</a>`

export interface InjectOptions {
  /** 悬浮按钮的目标地址（默认 `/`） */
  backUrl?: string
  /** 是否注入「回到 Hub」按钮（07 里可在设置里关掉；默认注入） */
  withBackButton?: boolean
}

export interface InjectResult {
  html: string
  injected: boolean
  reason?: string
}

/**
 * 把 `ownsHost`（与可选的返回按钮）插到 `</body>` 之前。
 * 只在命中文档标记 `__DSH_BOOT__` 时才动它——避免污染 JSON/静态资源等非文档响应。
 */
export function injectIntoHtml(html: string, options: InjectOptions = {}): InjectResult {
  if (!html.includes('__DSH_BOOT__')) return { html, injected: false, reason: 'no-boot-marker' }
  const backUrl = options.backUrl ?? '/'
  const parts = [OWNS_HOST_SNIPPET]
  if (options.withBackButton !== false) {
    parts.push(BACK_BUTTON_SNIPPET.replaceAll('__HUB_BACK_URL__', backUrl))
  }
  const snippet = parts.join('')
  const closeIndex = html.toLowerCase().lastIndexOf('</body>')
  if (closeIndex === -1) {
    // 没有 </body> 就追加到末尾（浏览器照样解析）
    return { html: html + snippet, injected: true }
  }
  return {
    html: `${html.slice(0, closeIndex)}${snippet}${html.slice(closeIndex)}`,
    injected: true,
  }
}
