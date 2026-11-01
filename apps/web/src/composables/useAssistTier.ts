import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

import { ASSIST_TIER_QUERIES, assistTierOf, type AssistTier } from '@/utils/assist-layout'

/**
 * AI 助手页的档位（WP58，docs/26 §2.1）：用 `matchMedia` 监听档位边界，跨档时直接切布局，
 * 不做逐帧 `resize` 计算、也不做过渡动画。
 *
 * `matchMedia` 只当「该重算了」的触发器——真正算档位还是用 `window.innerWidth`，
 * 这样档位边界只在一处（`assistTierOf`），也方便单测。
 */
export function useAssistTier(): Ref<AssistTier> {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  const tier = ref<AssistTier>(assistTierOf(width))
  const lists: MediaQueryList[] = []

  function sync(): void {
    if (typeof window === 'undefined') return
    tier.value = assistTierOf(window.innerWidth)
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    for (const query of ASSIST_TIER_QUERIES) {
      const list = window.matchMedia(query)
      list.addEventListener?.('change', sync)
      lists.push(list)
    }
    // 挂载时按当前宽度再确认一次（SSR / 测试环境里 innerWidth 可能在 setup 之后才设好）
    sync()
  })

  onBeforeUnmount(() => {
    for (const list of lists) list.removeEventListener?.('change', sync)
    lists.length = 0
  })

  return tier
}
