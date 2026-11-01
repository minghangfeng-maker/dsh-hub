/**
 * 长按（会话重命名 / 归档的入口，§1.4）。
 *
 * 为什么不用 `@contextmenu`：Android WebView 里长按会同时选中文本并弹系统菜单；
 * 这里自己计时（500ms），移动超过 8px 或提前松手就取消，行为与系统一致。
 *
 * 返回的对象直接用 `v-on="{…}"` 绑到元素上，所以**键必须是 DOM 事件名**
 * （`pointerdown` 而不是 `onPointerdown`）：Vue 的对象语法会给键补 `on` 前缀，
 * 写成 `onPointerdown` 会被拼成 `onOnPointerdown`，监听器永远不触发。
 *
 * 网页版（WP54 / W2）：浏览器在长按时会先起一段文本选择、再弹系统的「选择/分享」菜单
 * （APK 的 WebView 里没有这一套）。按住期间给 `<html>` 挂 `long-pressing` 类，
 * App.vue 的全局样式据此临时关掉 user-select / touch-callout，松手立刻摘掉；
 * `contextmenu` 继续 preventDefault 兜住桌面右键与安卓的上下文菜单。
 * 仅网页构建生效（APK 行为不变）。
 *
 * 长按成功后再补一个「吞掉紧随其后的 click」：手指抬起时浏览器会照常补一次 click，
 * 不拦掉的话「长按弹出重命名菜单」会顺带把会话打开（长按的松手不该等于点击）。
 */

import { IS_WEB_BUILD } from './app-info'

/** 按住期间挂在 `<html>` 上的类（样式在 App.vue 的全局样式块里）。 */
export const LONG_PRESSING_CLASS = 'long-pressing'

export interface LongPressHandlers {
  pointerdown: (event: PointerEvent) => void
  pointerup: () => void
  pointercancel: () => void
  pointermove: (event: PointerEvent) => void
  contextmenu: (event: Event) => void
}

/**
 * 网页版：开始一次「按住」——临时压掉浏览器的文本选择。
 *
 * 松手监听挂在 document 的捕获阶段而不是元素上：长按菜单弹出来以后，手指抬起时
 * 元素上面已经盖了一层遮罩，pointerup 不一定会回到原来那个元素，挂在 document 上
 * 才不会把 `long-pressing` 永久留在页面上（那样整个界面的文本都选不了了）。
 */
let releasePress: (() => void) | null = null

function beginPress(): void {
  if (!IS_WEB_BUILD) return
  const root = document.documentElement
  root.classList.add(LONG_PRESSING_CLASS)
  if (releasePress !== null) return
  const release = (): void => {
    releasePress = null
    root.classList.remove(LONG_PRESSING_CLASS)
    document.removeEventListener('pointerup', release, true)
    document.removeEventListener('pointercancel', release, true)
    document.removeEventListener('touchend', release, true)
    document.removeEventListener('touchcancel', release, true)
  }
  releasePress = release
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  // iOS 某些情况下只给 touchend，不给 pointerup
  document.addEventListener('touchend', release, true)
  document.addEventListener('touchcancel', release, true)
}

function endPress(): void {
  if (!IS_WEB_BUILD) return
  releasePress?.()
  document.documentElement.classList.remove(LONG_PRESSING_CLASS)
}

/**
 * 长按已经触发：吞掉紧随其后的那一次 click。
 *
 * 在 document 的捕获阶段拦（比元素上的 `@click` 早），并且只拦一次：
 * 1 秒内没等到 click（例如手指滑走了）就自动摘掉，不会误伤后面的正常点击。
 */
function swallowNextClick(): void {
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    clearTimeout(expire)
    document.removeEventListener('click', swallow, true)
  }
  const expire = setTimeout(() => document.removeEventListener('click', swallow, true), 1000)
  document.addEventListener('click', swallow, true)
}

export function longPress(onLongPress: () => void, delayMs = 500): LongPressHandlers {
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let fired = false

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    pointerdown(event: PointerEvent) {
      fired = false
      startX = event.clientX
      startY = event.clientY
      clear()
      beginPress()
      timer = setTimeout(() => {
        timer = null
        fired = true
        swallowNextClick()
        onLongPress()
      }, delayMs)
    },
    pointerup() {
      clear()
      endPress()
    },
    pointercancel() {
      clear()
      endPress()
    },
    pointermove(event: PointerEvent) {
      if (timer === null) return
      if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) {
        clear()
        // 手指滑走了：这是滚动/拖动，不是长按，立刻恢复文本选择
        endPress()
      }
    },
    contextmenu(event: Event) {
      // 桌面/调试时的右键等价长按；已由计时器触发过就不重复开。
      event.preventDefault()
      if (fired) return
      fired = true
      clear()
      swallowNextClick()
      onLongPress()
    },
  }
}
