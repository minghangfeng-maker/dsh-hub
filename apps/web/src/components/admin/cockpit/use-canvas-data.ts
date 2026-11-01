import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

import { runCanvasSource, type CanvasData } from '@/api/admin-cockpit'
import { describeError, type ErrorDescription } from '@/api/errors'

/**
 * 画布卡的取数（docs/24 §3 `CanvasData`）：
 *
 * - `{ rows }`：DSH 内联数据，直接用（画布标「DSH 计算」）；
 * - `{ source }`：Hub 用**当前管理员身份**重查一遍（标「Hub 数据」），有 `refreshSec` 时按间隔刷新。
 *
 * 刷新用 `setInterval` 而不是轮询框架：卡片可能在抽屉里被关掉，作用域销毁就停。
 */
export interface UseCanvasDataReturn {
  rows: Ref<Record<string, unknown>[]>
  loading: Ref<boolean>
  error: Ref<ErrorDescription | null>
  truncated: Ref<boolean>
  reload: () => Promise<void>
  /** 是否来自 Hub 数据源（画布角标用） */
  isSource: Ref<boolean>
}

export function useCanvasData(data: MaybeRefOrGetter<CanvasData | null>): UseCanvasDataReturn {
  const rows = ref<Record<string, unknown>[]>([])
  const loading = ref(false)
  const error = ref<ErrorDescription | null>(null)
  const truncated = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null

  const isSource = computed(() => {
    const value = toValue(data)
    return value !== null && 'source' in value
  })

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  async function reload(): Promise<void> {
    const value = toValue(data)
    if (!value) {
      rows.value = []
      return
    }

    if ('rows' in value) {
      rows.value = value.rows
      error.value = null
      truncated.value = false
      return
    }

    loading.value = true
    try {
      const result = await runCanvasSource({
        capability: value.source.capability,
        args: value.source.args,
      })
      rows.value = result.rows
      truncated.value = result.truncated === true
      error.value = null
    } catch (cause) {
      // 数据源失败时保留旧数据（不闪空），错误就地提示
      error.value = describeError(cause)
    } finally {
      loading.value = false
    }
  }

  function schedule(): void {
    clearTimer()
    const value = toValue(data)
    if (!value || !('source' in value)) return

    const seconds = value.source.refreshSec ?? 0
    if (!Number.isFinite(seconds) || seconds <= 0) return

    timer = setInterval(() => {
      // 页面在后台时不刷新，省请求（回到前台靠下一次间隔）
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void reload()
    }, seconds * 1000)
  }

  watch(
    () => JSON.stringify(toValue(data) ?? null),
    () => {
      void reload()
      schedule()
    },
    { immediate: true },
  )

  onScopeDispose(clearTimer)

  return { rows, loading, error, truncated, reload, isSource }
}
