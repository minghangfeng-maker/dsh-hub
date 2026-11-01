import { useIntervalFn } from '@vueuse/core'
import { ref, shallowRef, type Ref } from 'vue'

import { describeError, type ErrorDescription } from '@/api/errors'

/**
 * 页面数据加载的通用小工具：`loading` / `error` / 重载 / 可选轮询。
 *
 * 管理端页面几乎都是「拉一份列表 → 渲染 → 出错就地提示 → 有些页 10 秒刷新」，
 * 与其每页抄一遍 try/finally，不如统一在这里收口（错误文案走 `api/errors.ts`）。
 */
export interface UseAsyncDataOptions {
  /** 立即加载（默认 true） */
  immediate?: boolean
  /** 轮询间隔毫秒（> 0 时用 `useIntervalFn`；页面不可见时跳过，省请求） */
  pollMs?: number
  /** 出错时是否把错误写进 `error`（默认 true；false 时只记 `lastError`） */
  captureError?: boolean
}

export interface UseAsyncDataReturn<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  /** 最近一次失败（已解析成界面可用的文案） */
  error: Ref<ErrorDescription | null>
  reload: () => Promise<T | null>
  /** 轮询是否在跑（`pollMs > 0` 才有意义） */
  polling: Ref<boolean>
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  options: UseAsyncDataOptions = {},
): UseAsyncDataReturn<T> {
  const { immediate = true, pollMs = 0, captureError = true } = options

  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref<ErrorDescription | null>(null)
  const polling = ref(false)

  async function reload(): Promise<T | null> {
    // 页面后台时轮询不打扰（手动 reload 不受影响）
    if (polling.value && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return data.value
    }

    loading.value = true
    try {
      const result = await loader()
      data.value = result
      error.value = null
      return result
    } catch (cause) {
      const description = describeError(cause)
      if (captureError) error.value = description
      else error.value = description
      return null
    } finally {
      loading.value = false
    }
  }

  if (pollMs > 0) {
    polling.value = true
    useIntervalFn(() => {
      void reload()
    }, pollMs)
  }

  if (immediate) void reload()

  return { data, loading, error, reload, polling }
}
