/**
 * 网页版触感（WP54 / W3）：浏览器里没有 Capacitor Haptics，退到 `navigator.vibrate`。
 *
 * 覆盖范围：
 *  - Android Chrome / Edge：有 `navigator.vibrate`，10ms（轻）/ 20ms（重）与 APK 的
 *    `ImpactStyle.Light` / `ImpactStyle.Medium` 手感接近；
 *  - **iOS Safari 没有 `navigator.vibrate`**（只有 iPhone 的 `Taptic` 私有接口，网页拿不到）：
 *    静默跳过，不抛错、也不弹提示 —— 触感是锦上添花，缺了不能影响主流程；
 *  - 桌面浏览器一般没有（Chrome 桌面有但默认不开）：同样静默。
 *
 * 只在**非原生**运行时被 `lib/platform.ts` 调用：APK 里仍然走 `@capacitor/haptics`
 * （`isNative()` 为真，本文件不会被调用），行为与 0.4.11 完全一致。
 */

/** 轻触（发送、长按、切换）。 */
export const HAPTIC_TAP_MS = 10
/** 重一点（开始录音、按住说话）。 */
export const HAPTIC_STRONG_MS = 20

interface VibrateNavigator {
  vibrate?: (pattern: number | number[]) => boolean
}

/**
 * 触发一次震动（毫秒）。没有 `navigator.vibrate` 就静默返回。
 *
 * 注意 `navigator.vibrate` 必须在**用户手势**里调用，Chrome 才会真的震（否则只是 no-op）；
 * 现有调用点（点击发送、按住麦克风）都在手势里，符合要求。
 */
export function webHaptic(ms: number): void {
  const nav = (globalThis as { navigator?: VibrateNavigator }).navigator
  if (!nav || typeof nav.vibrate !== 'function') return
  try {
    nav.vibrate(ms)
  } catch {
    /* 被浏览器策略禁用 / 设备不支持：静默 */
  }
}
