/**
 * 剪贴板：优先 `navigator.clipboard.writeText`，失败回退到 textarea + `execCommand('copy')`。
 *
 * 三条路都要能走通：
 *  - **APK（Capacitor）**：Android WebView 里 clipboard API 在非安全上下文/无权限时会拒绝，
 *    回退方案在真机上一直可用；
 *  - **手机网页版（WP54 / W3）**：Chrome / Safari 的 `navigator.clipboard` 只在安全上下文
 *    （https 或 localhost）且有权限时可用；被拒（用户点了「阻止」/ 页面不在前台）时同样回退；
 *  - 两者都失败返回 false，由调用方提示（界面文案在调用处）。
 *
 * 回退方案用一个透明 textarea：`select()` + `execCommand('copy')` 必须在**用户手势**的
 * 同一个任务里完成，所以 `copyText()` 先尝试异步 API，失败后立刻同步走回退。
 */

interface ClipboardLike {
  writeText?: (text: string) => Promise<void>
}

function clipboardOf(): ClipboardLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as { clipboard?: ClipboardLike }).clipboard ?? null
}

/** 异步剪贴板 API 在非安全上下文里不存在（Chrome 会直接 `undefined`）。 */
function hasAsyncClipboard(): boolean {
  if (typeof navigator === 'undefined') return false
  const scope = globalThis as { isSecureContext?: boolean }
  // 安全上下文：https / localhost / 原生壳的 https://localhost。没有这个字段的环境按可用处理。
  if (scope.isSecureContext === false) return false
  return typeof clipboardOf()?.writeText === 'function'
}

function fallbackCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  area.style.pointerEvents = 'none'
  document.body.appendChild(area)
  let ok = false
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
  } catch {
    ok = false
  } finally {
    document.body.removeChild(area)
    // 把焦点还给原来的元素：网页版里复制按钮常在输入框旁边，焦点丢了键盘会收起
    try {
      active?.focus?.({ preventScroll: true })
    } catch {
      /* 元素已经不在文档里：忽略 */
    }
  }
  return ok
}

/** 复制文本；成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
  if (hasAsyncClipboard()) {
    try {
      await clipboardOf()!.writeText!(text)
      return true
    } catch {
      /* 落到回退方案 */
    }
  }
  return fallbackCopy(text)
}
