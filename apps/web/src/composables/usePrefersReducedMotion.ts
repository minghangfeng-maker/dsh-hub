import { usePreferredReducedMotion } from '@vueuse/core'
import { computed, type ComputedRef } from 'vue'

/**
 * 系统是否开启了「减少动态效果」（07 §2.5、10 §H2）。
 *
 * 所有 JS 驱动的动效（<CountUp> 计数、必要的定时刷新）都必须先问它；
 * CSS 动效由 styles/motion.css 的媒体查询统一关闭。
 */
export function usePrefersReducedMotion(): ComputedRef<boolean> {
  const preference = usePreferredReducedMotion()

  return computed(() => preference.value === 'reduce')
}
