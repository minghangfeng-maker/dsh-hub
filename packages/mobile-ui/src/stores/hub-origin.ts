/**
 * Hub 入口 store（0.4.11 / WP52）：当前在用哪个入口 + 回前台切回首选。
 *
 * 「切换判定/探测/持久化」全在 core 的 `OriginManager`（HubClient 内部，见
 * `packages/core/src/http/origin-manager.ts`）。这里只做 UI 侧的三件事：
 *  1. 订阅切换事件，把「当前入口」变成响应式状态（网络检测页/诊断用）；
 *  2. App 回到前台时静默探测首选入口（通了就切回，避免永远停在备用入口）；
 *  3. 给界面提供入口标签（广州 / 新加坡 / 主机名）。
 *
 * 依赖方向：本 store → instance（网关）/ lib。谁需要重连通道由 App.vue 的 watcher 做
 * （本 store 不认识对话 store）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { OriginSwitch } from '@dsh-hub/mobile-core'
import { HUB_ORIGIN, HUB_ORIGINS, IS_MOCK } from '@/lib/app-info'
import { recordDiag } from '@/lib/diagnostics'
import { originHost, originLabel, originRank } from '@/lib/hub-origin'
import { gateway } from '@/lib/instance'

export const useHubOriginStore = defineStore('hub-origin', () => {
  /** 可用的真实入口（mock 构建没有入口概念）。 */
  const origins = ref<string[]>(
    IS_MOCK ? [] : HUB_ORIGINS.filter((origin) => /^https?:\/\//i.test(origin)),
  )
  const primary = ref(origins.value[0] ?? HUB_ORIGIN)
  const current = ref(gateway.origin ?? primary.value)
  /** 回前台探测首选时置 true（界面不需要展示，只防重入）。 */
  const checking = ref(false)
  let initialized = false
  let unsubscribe: (() => void) | null = null

  const multi = computed(() => origins.value.length > 1)
  const onSecondary = computed(() => multi.value && current.value !== primary.value)
  const currentLabel = computed(() => originLabel(current.value))
  const currentHost = computed(() => originHost(current.value))
  const currentRank = computed(() => originRank(origins.value, current.value))
  const isMock = computed(() => IS_MOCK)

  /** 入口的展示名（网络检测页的每一行）。 */
  function labelOf(origin: string): string {
    return originLabel(origin)
  }

  function rankOf(origin: string): string {
    return originRank(origins.value, origin) ?? ''
  }

  /**
   * 启动时调用一次（App.vue 在 auth.init 之前）。
   *
   * HubClient 会在第一次请求前异步恢复「上次可用入口」，恢复不经过事件的话界面就看不到，
   * 所以订阅之外还要在 `ensureOriginReady()` 之后同步一次当前值。
   */
  function init(): void {
    if (initialized) return
    initialized = true
    current.value = gateway.origin ?? primary.value
    unsubscribe =
      gateway.onOriginChange?.((change: OriginSwitch) => {
        current.value = change.to
        recordDiag(
          'hub:origin',
          `${originLabel(change.from)}→${originLabel(change.to)}:${change.reason}`,
        )
      }) ?? null
    void gateway.ensureOriginReady?.().then(() => {
      current.value = gateway.origin ?? primary.value
    })
  }

  /**
   * App 回到前台：当前停在备用入口时，静默探测首选入口，通了就切回去。
   * 返回 true 表示这次真的切回了首选（App.vue 据此重连通道 —— 其实切换事件也会触发重连，
   * 这里返回只是方便调用方记诊断）。
   */
  async function ensurePrimary(): Promise<boolean> {
    if (!multi.value || checking.value) return false
    const prefer = gateway.preferPrimaryOrigin
    if (typeof prefer !== 'function') return false
    checking.value = true
    try {
      return await prefer.call(gateway)
    } catch {
      return false
    } finally {
      checking.value = false
      current.value = gateway.origin ?? primary.value
    }
  }

  return {
    origins,
    primary,
    current,
    multi,
    onSecondary,
    checking,
    currentLabel,
    currentHost,
    currentRank,
    isMock,
    labelOf,
    rankOf,
    init,
    ensurePrimary,
  }
})
