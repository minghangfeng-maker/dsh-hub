<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton, useMessage } from 'naive-ui'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { describeError } from '@/api/errors'
import { useRelayStatus } from '@/composables/useRelayStatus'
import AnnouncementBar from '@/components/user/AnnouncementBar.vue'
import DesktopDevicesCard from '@/components/desktop/DesktopDevicesCard.vue'
import HomeDataSection from '@/components/user/home/HomeDataSection.vue'
import HomeModelsSection from '@/components/user/home/HomeModelsSection.vue'
import HomePluginsSection from '@/components/user/home/HomePluginsSection.vue'
import SwitchPlanDialog from '@/components/user/home/SwitchPlanDialog.vue'
import InstanceMainCard from '@/components/user/InstanceMainCard.vue'
import { useMyCompute } from '@/composables/useMyCompute'
import { useMyInstance } from '@/composables/useMyInstance'
import { hasSeenWelcome, requestWelcomeGuide } from '@/composables/useWelcomeGuide'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 我的工作台 `/home`（15 §2.1，取代 07 §6.1 的旧结构）。
 *
 * 顺序：公告/问候 → 我的 DSH（#dsh，含当前配置 / 切换配置 / 余额与租约）→ 我的模型（#models）→
 * 我的插件（#plugins）→ 我的数据（#data）。每个区块都能被 `/home#models` 这类
 * 旧链接直接定位（`router.scrollBehavior` 负责滚动）。
 *
 * 插件与数据导出各自拉数据并自己轮询，不再由本页转发；模型来自 `useRelayStatus` 的同一份
 * `/api/me/relay` 响应（导航、积分与用量页共用，避免重复请求）。
 */
const auth = useAuthStore()
const site = useSiteStore()
const message = useMessage()
const route = useRoute()

/**
 * 算力租赁（13 §7）：规格、余额、租约。计费关闭时接口也返回 `billingEnabled:false`，
 * 主卡片显示「暂不计费」，不再出现单独的算力租赁区块。
 */
const compute = useMyCompute()
const {
  data: computeData,
  billingEnabled: computeBillingEnabled,
  insufficient: computeInsufficient,
  noPlans: computeNoPlans,
  selectPlan,
  reload: reloadCompute,
} = compute

const instance = useMyInstance({ planId: () => compute.selectedPlanId.value })
const {
  instance: instanceSummary,
  stats,
  quota,
  modelSummary,
  phase,
  phaseMessage,
  loading: instanceLoading,
  action,
  opening,
  errorText,
  errorCode,
  errorDetails,
  refresh,
  start,
  stop,
  restart,
  openDsh,
} = instance

/** 实例是否在跑：决定「切换配置」是只记住还是要确认重启 */
const isRunning = computed(() => instanceSummary.value?.status === 'running')

/**
 * 余额不够开一块（或一个规格都没有）时禁用启动按钮。
 * 后端 402 仍是权威（余额可能刚被别处花掉），这里只是提前告诉用户。
 */
const startDisabled = computed(
  () => computeBillingEnabled.value && (computeInsufficient.value || computeNoPlans.value),
)

const computeBusy = ref(false)
const showSwitchPlan = ref(false)

async function handleSelectPlan(planId: string): Promise<void> {
  computeBusy.value = true
  try {
    const restarted = await selectPlan(planId)
    showSwitchPlan.value = false
    if (restarted) {
      message.success('正在按新规格重启')
      await refresh()
    } else {
      message.success('好的，下次启动用这个规格')
    }
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    computeBusy.value = false
  }
}

// 实例启动 / 停止后租约跟着变，不用等下一轮 30 秒轮询
watch(isRunning, () => {
  if (computeBillingEnabled.value) void reloadCompute()
})

/** `/api/me/relay`：模型列表与积分行都来自同一份响应（未开通时 relayData.enabled=false） */
const { relaySummary, loadRelayStatus } = useRelayStatus()

/** 「已运行 2 小时 13 分」需要一个会走的时钟（30 秒够用，不必每秒重渲染） */
const now = ref(Date.now())
useIntervalFn(() => {
  now.value = Date.now()
}, 30_000)

/** 打开被拦 / 启动失败时的就地提示（主卡片里的薄荷色小条） */
const notice = ref<string | null>(null)
const noticeHref = ref<string | null>(null)

const greeting = computed(() => {
  const hour = new Date(now.value).getHours()
  const prefix =
    hour < 6 ? '凌晨好' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  return `${prefix}，${auth.displayName || '朋友'}`
})

function setNotice(text: string | null, href: string | null = null): void {
  notice.value = text
  noticeHref.value = href
}

async function handleOpen(): Promise<void> {
  setNotice(null)
  const result = await openDsh()
  if (result === 'blocked') {
    setNotice('浏览器拦住了新标签页，点下面手动打开。', instanceSummary.value?.openUrl ?? null)
    return
  }
  if (result === 'opened') setNotice('已经打开了，去新标签页看看吧。')
  // 'busy'：连点的第二下被吞掉了，上一次流程结束时会自己给出提示，这里什么都不用做
}

/** `CAPACITY_FULL` 的重试只重试启动，不开空白标签（免得失败后留个空页面） */
async function handleRetry(): Promise<void> {
  if (errorCode.value === 'CAPACITY_FULL') {
    const ok = await start()
    if (ok) setNotice('已经开始启动了，几秒后点「打开 DSH」就好。')
    return
  }
  await handleOpen()
}

async function handleStop(): Promise<void> {
  setNotice(null)
  if (await stop()) message.success('好的，正在停止')
}

async function handleRestart(): Promise<void> {
  setNotice(null)
  if (await restart()) message.success('正在重启，稍等一会儿')
}

/**
 * 15 §2.4：从 `/me?tab=plugins|exports` 跳过来时，路由的 scrollBehavior 可能在
 * 插件 / 导出数据还没加载、页面高度还没撑开时就把位置定在了一个错误的地方。
 * 这里在挂载后短时间校正几次：只在目标明显不在视口顶部附近时补一次滚动，不跟用户抢滚动条。
 */
function settleHashScroll(): void {
  const hash = route.hash
  if (!hash) return

  let attempts = 0
  const run = (): void => {
    const target = document.querySelector<HTMLElement>(hash)
    if (target && typeof target.scrollIntoView === 'function') {
      const top = target.getBoundingClientRect().top
      if (top < 60 || top > 140) target.scrollIntoView({ block: 'start' })
    }
    attempts += 1
    if (attempts < 8) setTimeout(run, 200)
  }

  void nextTick(() => {
    setTimeout(run, 120)
  })
}

onMounted(() => {
  // 首次进入工作台时弹 3 步引导（localStorage 记住；注册页也触发，共用一个键）
  if (!hasSeenWelcome()) requestWelcomeGuide()

  void loadRelayStatus()
  settleHashScroll()
})
</script>

<template>
  <div class="home-view flex flex-col gap-4 md:gap-6">
    <AnnouncementBar
      v-if="site.announcementVisible"
      :text="site.site.announcement"
      :level="site.site.announcementLevel"
      @dismiss="site.dismissAnnouncement()"
    />

    <header class="flex flex-wrap items-end gap-x-3 gap-y-1">
      <!-- 390 下 24px 的问候语 + 昵称会折行；缩到 20px 保持一行（07 §2.8 不让短标题被拆开） -->
      <h1 class="text-[20px] font-semibold text-1 md:text-[32px]">{{ greeting }}</h1>
    </header>

    <section id="dsh" class="home-section" data-testid="home-section-dsh">
      <InstanceMainCard
        :instance="instanceSummary"
        :stats="stats"
        :quota="quota"
        :phase="phase"
        :phase-message="phaseMessage"
        :now="now"
        :busy-action="action"
        :opening="opening"
        :error-text="errorText"
        :error-code="errorCode"
        :error-details="errorDetails"
        :notice-text="notice"
        :start-disabled="startDisabled"
        :compute="computeData"
        :avatar-url="auth.avatarUrl"
        :display-name="auth.displayName"
        :avatar-seed="auth.user?.slug"
        @open="handleOpen"
        @retry="handleRetry"
        @stop="handleStop"
        @restart="handleRestart"
        @switch-plan="showSwitchPlan = true"
      />

      <!-- 打开被拦时给一个手动链接（07 §6.1 的弹窗拦截兜底） -->
      <p v-if="noticeHref" class="mt-2 text-[13px] text-2">
        手动打开：
        <a class="hub-link" :href="noticeHref" target="_blank" rel="noopener">打开 DSH</a>
      </p>

      <!-- 桌面设备（WP25c，D6 §6.2）：与云端实例同一个「我的实例」区块，排在容器卡片下面 -->
      <DesktopDevicesCard />
    </section>

    <section id="models" class="home-section" data-testid="home-section-models">
      <HomeModelsSection :summary="modelSummary" :relay="relaySummary" :loading="instanceLoading" />
    </section>

    <section id="plugins" class="home-section" data-testid="home-section-plugins">
      <HomePluginsSection />
    </section>

    <section id="data" class="home-section" data-testid="home-section-data">
      <HomeDataSection />
    </section>

    <SwitchPlanDialog
      v-if="computeData"
      v-model:show="showSwitchPlan"
      :compute="computeData"
      :running="isRunning"
      :busy="computeBusy"
      @select="handleSelectPlan"
    />

    <p v-if="instanceLoading" class="text-center text-[12px] text-3">正在读取实例信息…</p>
    <div v-else-if="errorText && !instanceSummary" class="text-center">
      <NButton size="small" secondary @click="refresh()">重新加载</NButton>
    </div>
  </div>
</template>

<style scoped>
/* 锚点定位时给固定顶栏留出空间（15 §2.4：旧链接 /home#plugins 要滚到位） */
.home-section {
  scroll-margin-top: 88px;
}
</style>
