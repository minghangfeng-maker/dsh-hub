import { ref } from 'vue'

const STORAGE_KEY = 'hub.welcome.done'

/**
 * 注册后的欢迎引导状态（07 §5.2）。
 *
 * 注册页与 App.vue 的浮层不在同一棵子树上（注册成功后要跳走），所以用模块级 ref 传递：
 * 注册成功 → `requestWelcomeGuide()`；App.vue 渲染浮层；看完/跳过 → `markWelcomeSeen()`。
 */
export const welcomePending = ref(false)

export function requestWelcomeGuide(): void {
  welcomePending.value = true
}

/** 是否已经看过（localStorage 不可用时按「看过」处理，避免每次刷新都弹）。 */
export function hasSeenWelcome(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

export function markWelcomeSeen(): void {
  welcomePending.value = false
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // 隐私模式：忽略
  }
}
