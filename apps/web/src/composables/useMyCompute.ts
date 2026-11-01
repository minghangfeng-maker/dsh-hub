import type { MyComputeResponse, MyComputePlan } from '@dsh-hub/shared'
import { useIntervalFn } from '@vueuse/core'
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

import { fetchMyCompute, selectMyComputePlan } from '@/api/compute'
import { useAsyncData } from '@/composables/useAsyncData'

/**
 * 我的算力租赁（13 §7）：规格、选中项、余额、当前租约。
 *
 * 计费关闭时接口照样返回（`billingEnabled:false`），页面据此**完全不渲染**这一块，
 * 工作台保持原样；接口读不到（例如后端还没上线）时同样当作关闭，不给用户添乱。
 *
 * 每 30 秒轮询一次（13 §7.3），页面不可见时不发请求（`document.visibilityState`）。
 */
export interface UseMyComputeReturn {
  /** 接口原始响应（null = 还没读到 / 读不到） */
  data: Ref<MyComputeResponse | null>
  loading: Ref<boolean>
  /** 计费是否开启（页面是否显示整块算力租赁） */
  billingEnabled: ComputedRef<boolean>
  plans: ComputedRef<MyComputePlan[]>
  selectedPlanId: Ref<string | null>
  selectedPlan: ComputedRef<MyComputePlan | null>
  /** 选中规格每 10 分钟的价格（微积分） */
  blockPriceMicro: ComputedRef<number>
  balanceMicro: ComputedRef<number>
  /** 管理员账号且 `billAdmins=false` */
  exempt: ComputedRef<boolean>
  /** 余额不够开一块（且不是免租） */
  insufficient: ComputedRef<boolean>
  /** 一个可用规格都没有（计费开着但管理员没配） */
  noPlans: ComputedRef<boolean>
  /** 今日赠送剩余，展示时再与余额取小（13 §2.5） */
  dailyBonusLeftMicro: ComputedRef<number>
  dailyBonusMicro: ComputedRef<number>
  lease: ComputedRef<MyComputeResponse['lease']>
  reload: () => Promise<MyComputeResponse | null>
  /** 选规格；返回是否因此重启了实例 */
  selectPlan: (planId: string) => Promise<boolean>
}

export interface UseMyComputeOptions {
  /** 轮询间隔，默认 30 秒（13 §7.3） */
  pollMs?: number
  /** 立即拉一次，默认 true */
  immediate?: boolean
}

export function useMyCompute(options: UseMyComputeOptions = {}): UseMyComputeReturn {
  const { pollMs = 30_000, immediate = true } = options

  const { data, loading, reload } = useAsyncData(() => fetchMyCompute(), { immediate: false })
  const selectedPlanId = ref<string | null>(null)

  watch(
    data,
    (value) => {
      if (!value) return
      // 服务端是权威：PUT 之后、轮询刷新之后都按它同步选中项
      selectedPlanId.value = value.selectedPlanId ?? value.plans[0]?.id ?? null
    },
    { immediate: true },
  )

  const billingEnabled = computed(() => data.value?.billingEnabled === true)
  const plans = computed<MyComputePlan[]>(() => data.value?.plans ?? [])
  const selectedPlan = computed<MyComputePlan | null>(
    () => plans.value.find((plan) => plan.id === selectedPlanId.value) ?? plans.value[0] ?? null,
  )
  const blockPriceMicro = computed(() => selectedPlan.value?.blockPriceMicro ?? 0)
  const balanceMicro = computed(() => data.value?.balanceMicro ?? 0)
  const exempt = computed(() => data.value?.exempt === true)
  const insufficient = computed(
    () =>
      billingEnabled.value &&
      !exempt.value &&
      blockPriceMicro.value > 0 &&
      balanceMicro.value < blockPriceMicro.value,
  )
  const noPlans = computed(() => billingEnabled.value && plans.value.length === 0)
  const dailyBonusMicro = computed(() => data.value?.dailyBonusMicro ?? 0)
  const dailyBonusLeftMicro = computed(() => data.value?.dailyBonusLeftMicro ?? 0)
  const lease = computed(() => data.value?.lease ?? null)

  useIntervalFn(() => {
    if (!billingEnabled.value) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void reload()
  }, pollMs)

  async function selectPlan(planId: string): Promise<boolean> {
    const response = await selectMyComputePlan(planId)
    data.value = response.compute
    selectedPlanId.value = response.compute.selectedPlanId ?? planId
    return response.restarted
  }

  if (immediate) void reload()

  return {
    data,
    loading,
    billingEnabled,
    plans,
    selectedPlanId,
    selectedPlan,
    blockPriceMicro,
    balanceMicro,
    exempt,
    insufficient,
    noPlans,
    dailyBonusLeftMicro,
    dailyBonusMicro,
    lease,
    reload,
    selectPlan,
  }
}
