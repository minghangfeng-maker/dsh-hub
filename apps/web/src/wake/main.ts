import { parseUsername, runWake } from './wake'

/**
 * 唤醒页的 DOM 接线（07 §8）：原生 TS，不引 Vue / 组件库，保持极小体积。
 * 逻辑都在 `wake.ts`（那边有测试），这里只负责把状态写到页面上。
 */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function show(element: HTMLElement | null, visible: boolean): void {
  if (!element) return
  if (visible) element.removeAttribute('hidden')
  else element.setAttribute('hidden', '')
}

async function boot(): Promise<void> {
  if (import.meta.env.DEV) {
    // `?mock=1`（WP5b 的假数据，生产构建里是死代码）
    const { setupMocksIfEnabled } = await import('@/mocks')
    await setupMocksIfEnabled()
  }

  const username = parseUsername(window.location.pathname)
  const phaseBoxEl = el('wake-phase')
  const phaseEl = el('wake-phase-text')
  const failureEl = el('wake-failure')
  const failureTextEl = el('wake-failure-text')
  const actionsEl = el('wake-actions')
  const retryEl = el<HTMLButtonElement>('wake-retry')
  const homeEl = el<HTMLAnchorElement>('wake-home')
  const hintEl = el('wake-hint')
  const descEl = el('wake-desc')

  if (username && descEl) {
    descEl.textContent = `正在把 ${username} 的 DSH 叫醒，第一次启动要装插件，通常十几秒。`
  }
  // 唤醒页本身就挂在规范地址下（/dsh/<username>/），返回链接也从路径里取
  if (homeEl && username) homeEl.href = `/dsh/${username}/`

  /** 重试时把界面恢复成「正在唤醒」 */
  function setStarting(): void {
    show(failureEl, false)
    show(actionsEl, false)
    show(hintEl, true)
    show(phaseBoxEl, true)
    if (phaseEl) phaseEl.textContent = '正在准备…'
  }

  async function attempt(): Promise<void> {
    setStarting()
    const result = await runWake({
      username,
      onPhase: (text) => {
        if (phaseEl) phaseEl.textContent = text
      },
      onFailed: (message, code) => {
        if (failureTextEl) failureTextEl.textContent = message
        show(phaseBoxEl, false)
        show(failureEl, true)
        show(actionsEl, true)
        show(hintEl, false)
        if (homeEl && code === 'UNAUTHENTICATED') {
          homeEl.href = `/login?next=${encodeURIComponent(`/dsh/${username ?? ''}/`)}`
          homeEl.textContent = '去登录'
        }
      },
    })

    // ready 时 runWake 内部已经 reload，这里只兜底提示
    if (result === 'ready' && phaseEl) phaseEl.textContent = '已经就绪，正在打开…'
  }

  retryEl?.addEventListener('click', () => void attempt())

  await attempt()
}

void boot()
