import type { MyRelayResponse } from '@dsh-hub/shared'
import { readonly, ref, shallowRef } from 'vue'

import { fetchMyRelay } from '@/api/relay'

/**
 * 中转站是否开通（12 §10：`enabled=false` 时用户导航隐藏「积分与用量」，页面显示未开通空状态）。
 *
 * 只在模块级拉一次：`UserLayout`（导航）、`/usage`、`/home` 三处共用同一份结果，
 * 避免每个组件各打一次 `/api/me/relay`。拿不到就说「没开通」——导航指向一个报错的页面更糟。
 */
const relayEnabled = ref(true)
const relaySummary = shallowRef<MyRelayResponse | null>(null)
const loaded = ref(false)

let pending: Promise<MyRelayResponse | null> | null = null

export interface UseRelayStatusReturn {
  relayEnabled: Readonly<typeof relayEnabled>
  relaySummary: Readonly<typeof relaySummary>
  loaded: Readonly<typeof loaded>
  /** 拉一次（force = 重新拉）；并发调用共用同一个请求 */
  loadRelayStatus: (force?: boolean) => Promise<MyRelayResponse | null>
  /** 页面自己拉到了更新鲜的数据时同步回来（例如 `/usage` 刷新后） */
  setRelaySummary: (summary: MyRelayResponse | null) => void
}

export function useRelayStatus(): UseRelayStatusReturn {
  async function loadRelayStatus(force = false): Promise<MyRelayResponse | null> {
    if (!force && loaded.value) return relaySummary.value
    if (pending) return pending

    pending = (async () => {
      try {
        const summary = await fetchMyRelay()
        relaySummary.value = summary
        relayEnabled.value = summary.enabled
        return summary
      } catch {
        relaySummary.value = null
        relayEnabled.value = false
        return null
      } finally {
        loaded.value = true
        pending = null
      }
    })()

    return pending
  }

  function setRelaySummary(summary: MyRelayResponse | null): void {
    relaySummary.value = summary
    if (summary) relayEnabled.value = summary.enabled
  }

  return {
    relayEnabled: readonly(relayEnabled),
    relaySummary: readonly(relaySummary) as Readonly<typeof relaySummary>,
    loaded: readonly(loaded),
    loadRelayStatus,
    setRelaySummary,
  }
}

/** 测试用：回到「还没拉过」的状态。 */
export function resetRelayStatus(): void {
  relayEnabled.value = true
  relaySummary.value = null
  loaded.value = false
  pending = null
}
