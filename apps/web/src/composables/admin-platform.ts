import type { Platform } from '@dsh-hub/shared'
import { computed, onMounted, ref, watch, type ComputedRef, type WritableComputedRef } from 'vue'
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router'

/**
 * 管理端的「云端 / 桌面」平台切换（docs/22 §1.2）。
 *
 * 规则：
 * - 地址栏 `?platform=cloud|desktop` 优先；
 * - 地址栏没有时用**记忆值** `localStorage['hub.admin.platform']`（上次在任一页选过的平台），
 *   再缺省 `cloud` —— 所以在页面之间跳转（侧边栏链接不带参数）仍然停在桌面侧；
 * - 进入带切换的页面时把最终值写回地址栏（浅替换），链接与截图都能带上平台；
 * - 旧参数兼容：实例页的 `?tab=cloud|desktop`、D6 设想的 `?kind=desktop` 当成平台读，
 *   写回时统一成 `?platform=`（`tab` 与 `kind` 不再保留）；
 * - **没有切换的页面不调用这个 composable**，也就不会改记忆值（docs/22 §1.2 最后一条）。
 */

export type AdminPlatform = Platform

export const ADMIN_PLATFORM_STORAGE_KEY = 'hub.admin.platform'

const PLATFORMS: readonly AdminPlatform[] = ['cloud', 'desktop']

/** 查询串 / 存储里的值 → 平台（不认识的返回 null） */
export function normalizeAdminPlatform(value: unknown): AdminPlatform | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  return (PLATFORMS as readonly string[]).includes(raw) ? (raw as AdminPlatform) : null
}

/** 位置参数里的平台：`?platform=` → `?tab=cloud|desktop` → `?kind=desktop`（旧写法） */
export function platformOfQuery(query: LocationQuery): AdminPlatform | null {
  return (
    normalizeAdminPlatform(query['platform']) ??
    normalizeAdminPlatform(query['tab']) ??
    (normalizeAdminPlatform(query['kind']) === 'desktop' ? 'desktop' : null)
  )
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 记忆值（读不到 / 坏值 → null） */
export function readStoredPlatform(): AdminPlatform | null {
  return normalizeAdminPlatform(storage()?.getItem(ADMIN_PLATFORM_STORAGE_KEY))
}

export function writeStoredPlatform(platform: AdminPlatform): void {
  try {
    storage()?.setItem(ADMIN_PLATFORM_STORAGE_KEY, platform)
  } catch {
    // 隐私模式 / 配额满：记忆值只是便利，写不进去也不影响当前页
  }
}

/** 有效平台：地址栏 → 记忆值 → `cloud` */
export function resolveAdminPlatform(query: LocationQuery): AdminPlatform {
  return platformOfQuery(query) ?? readStoredPlatform() ?? 'cloud'
}

/**
 * 旧地址 `/admin/desktop?tab=…` 的重定向目标（docs/22 §1.4）。
 *
 * `overview` → 实例页、`plugins` → 插件页、`config` → 模型页的「模型配置」、
 * `versions` → DSH 版本页；没有 tab 同 overview。其余查询参数原样带过去。
 */
export function desktopLegacyLocation(query: LocationQuery): {
  path: string
  query: LocationQueryRaw
} {
  const raw = Array.isArray(query['tab']) ? query['tab'][0] : query['tab']
  const target =
    raw === 'plugins'
      ? '/admin/plugins'
      : raw === 'config'
        ? '/admin/models'
        : raw === 'versions'
          ? '/admin/runtimes'
          : '/admin/instances'

  const carried: LocationQueryRaw = {}
  for (const [key, value] of Object.entries(query)) {
    if (key === 'tab' || value === undefined || value === null) continue
    carried[key] = value
  }
  return {
    path: target,
    query: {
      ...carried,
      ...(raw === 'config' ? { tab: 'dsh' } : {}),
      platform: 'desktop',
    },
  }
}

export interface UseAdminPlatform {
  /** 当前平台（可直接 `v-model` 绑到 `PlatformSwitch`） */
  platform: WritableComputedRef<AdminPlatform>
  isDesktop: ComputedRef<boolean>
  /** 切换平台：写记忆值 + 地址栏 */
  setPlatform: (next: AdminPlatform) => void
}

/**
 * 页面用：读当前平台并把切换写回地址栏与记忆值。
 *
 * ```ts
 * const platform = useAdminPlatform()
 * <PlatformSwitch v-model="platform.platform" />
 * ```
 */
export function useAdminPlatform(): UseAdminPlatform {
  const route = useRoute()
  const router = useRouter()

  const current = ref<AdminPlatform>(resolveAdminPlatform(route.query))

  /**
   * 地址栏里的平台与当前值不一致时写回（顺带把旧的 tab / kind 写法清掉）。
   * 云端是缺省值，**不写进地址栏**（链接保持干净）；桌面才显式带 `?platform=desktop`。
   */
  function syncQuery(next: AdminPlatform): void {
    const query: LocationQuery = { ...route.query }
    if (next === 'cloud') delete query['platform']
    else query['platform'] = next
    const legacyTab = normalizeAdminPlatform(route.query['tab'])
    if (legacyTab !== null) delete query['tab']
    if (normalizeAdminPlatform(route.query['kind']) !== null) delete query['kind']
    const samePlatform = next === 'cloud' ? route.query['platform'] === undefined : route.query['platform'] === next
    if (samePlatform && legacyTab === null && route.query['kind'] === undefined) return
    void router.replace({ query })
  }

  onMounted(() => {
    writeStoredPlatform(current.value)
    syncQuery(current.value)
  })

  // 前进 / 后退 / 手改地址栏：以地址栏为准，不覆盖记忆值
  watch(
    () => route.query,
    (query) => {
      const next = platformOfQuery(query)
      if (next !== null && next !== current.value) current.value = next
    },
  )

  const platform = computed<AdminPlatform>({
    get: () => current.value,
    set: (next) => setPlatform(next),
  })

  function setPlatform(next: AdminPlatform): void {
    current.value = next
    writeStoredPlatform(next)
    syncQuery(next)
  }

  return { platform, isDesktop: computed(() => platform.value === 'desktop'), setPlatform }
}
