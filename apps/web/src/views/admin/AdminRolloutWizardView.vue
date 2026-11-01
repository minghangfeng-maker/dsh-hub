<script setup lang="ts">
import type { DeliveryCreatedResponse, DeliveryPlatform, DeliveryPreviewResponse } from '@dsh-hub/shared'
import { NButton, NCollapse, NCollapseItem, useMessage } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { listDesktopArtifacts } from '@/api/admin-desktop'
import { listPresets } from '@/api/admin-models'
import { listPlugins } from '@/api/admin-plugins'
import { getRelayDsh } from '@/api/admin-relay'
import { listRuntimes } from '@/api/admin-runtimes'
import { listUsers } from '@/api/admin-users'
import { createDelivery, getPluginInstallStats, previewDelivery } from '@/api/deliveries'
import { describeError } from '@/api/errors'
import AdminPage from '@/components/admin/AdminPage.vue'
import DeliveryPreviewStep from '@/components/admin/delivery/DeliveryPreviewStep.vue'
import DeliveryStrategyStep from '@/components/admin/delivery/DeliveryStrategyStep.vue'
import DeliveryTargetsStep from '@/components/admin/delivery/DeliveryTargetsStep.vue'
import FlowChoiceCard from '@/components/admin/delivery/FlowChoiceCard.vue'
import FlowConfigStep from '@/components/admin/delivery/FlowConfigStep.vue'
import FlowStepper from '@/components/admin/delivery/FlowStepper.vue'
import RelayDshTab from '@/components/admin/relay/RelayDshTab.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  buildDeliveryRequest,
  chooseFlowContent,
  chooseFlowPlatform,
  createDeliveryDraft,
  DELIVERY_ACTION_TEXT,
  describeDeliveryTargets,
  effectiveFlowContent,
  FLOW_CONTENT_TEXT,
  FLOW_PLATFORM_TEXT,
  FLOW_STEPS,
  flowPlatformBlockedReason,
  flowPlatformOf,
  itemLabel,
  matchDeliveryUsers,
  mergePluginLibraries,
  otherFlowPlatform,
  parseFlowPrefill,
  validateFlowStep,
  type DeliveryDraft,
  type FlowContent,
  type FlowStep,
} from '@/composables/delivery-draft'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled, sensitive, withReauth } from '@/composables/useReauth'

/**
 * 下发（WP57 改版，docs/25）：`/admin/rollouts`，五步 **内容 → 端 → 配置 → 下发 → 完成**。
 *
 * 一次只发「一类内容 × 一个端」：每一步只回答一个问题；两个端都要发时在「完成」页点「再下发到另一端」。
 * - 内容：模型配置 / 插件 / DSH 版本（大卡片，点了直接进下一步）；
 * - 端：云端（用户实例）/ 桌面端（DSH Hub 桌面客户端），DSH 版本只能发云端；选定后整页换成该端的颜色；
 * - 配置：模型配置 = 直接在这里勾模型、设默认（就是「模型 · 模型配置」那张表，下一步时自动保存）；
 *   插件 = 动作 + 插件与该端版本；DSH 版本 = 升级到哪个版本；
 * - 下发：下发给谁（全部 / 指定用户 / 角色 / 已安装用户 / 条件筛选）、云端的灰度策略（折叠）、实时预览，
 *   「确认下发」走二次密码；
 * - 完成：云端任务链接 / 桌面端清单版本 / 整项跳过，以及「再下发到另一端」。
 *
 * URL 预填仍按契约 `DELIVERY_PREFILL_QUERY_KEYS`（各页面的「下发」按钮不用改），由 `parseFlowPrefill`
 * 收敛成一类一端并决定从哪一步开始。纯逻辑都在 `composables/delivery-draft.ts`（有单测）。
 */
const route = useRoute()
const router = useRouter()
const message = useMessage()

const prefill = parseFlowPrefill({ ...route.query })
const draft = ref<DeliveryDraft>(prefill.draft)
/** 第 1 步选的类别（选了插件但还没挑具体插件时，草稿里没有内容项） */
const chosen = ref<FlowContent | null>(prefill.content)
const step = ref<FlowStep>(prefill.start)
/** 步骤切换的方向：决定内容从右边滑进还是从左边滑进 */
const direction = ref<'next' | 'prev'>('next')
/** 「再下发到另一端」：预填里两个端都有时，第二个端在这里等着 */
const pendingPlatform = ref<DeliveryPlatform | null>(prefill.otherPlatform)

// ── 数据 ──

const { data: cloudPlugins } = useAsyncData(() => listPlugins('cloud'))
const { data: desktopPlugins } = useAsyncData(() => listPlugins('desktop'))
const { data: runtimes } = useAsyncData(() => listRuntimes())
const { data: cloudPresets } = useAsyncData(() => listPresets('cloud'))
const { data: desktopPresets } = useAsyncData(() => listPresets('desktop'))
const { data: cloudModels } = useAsyncData(() => getRelayDsh('cloud'))
const { data: desktopModels } = useAsyncData(() => getRelayDsh('desktop'))
const { data: userPage } = useAsyncData(async () => {
  const first = await listUsers({ page: 1, pageSize: 100 })
  const items = [...first.items]
  for (let page = 2; (page - 1) * first.pageSize < first.total; page += 1) {
    const next = await listUsers({ page, pageSize: first.pageSize })
    items.push(...next.items)
  }
  return { ...first, items }
})
const { data: artifactList } = useAsyncData(() => listDesktopArtifacts())
const { data: installStats } = useAsyncData(() => getPluginInstallStats())

const pluginRows = computed(() => mergePluginLibraries(cloudPlugins.value ?? [], desktopPlugins.value ?? []))
const runtimeRows = computed(() => runtimes.value ?? [])
const presetRows = computed(() => [...(cloudPresets.value ?? []), ...(desktopPresets.value ?? [])])
const users = computed(() => userPage.value?.items ?? [])
const artifactVersionIds = computed(
  () => new Set((artifactList.value?.items ?? []).map((artifact) => artifact.versionId)),
)

/**
 * URL 预填的插件项只有 id（版本 = 最新）。库到了以后把「最新」落成具体版本 id：
 * 下拉里显示的就是真正要下发的版本，预览与提交也一致。只填空值。
 */
watch(pluginRows, (rows) => {
  if (rows.length === 0) return
  let changed = false
  const items = draft.value.items.map((item) => {
    if (item.kind !== 'plugin' || item.pluginId === null) return item
    const view = rows.find((row) => row.id === item.pluginId)
    if (!view) return item
    const next = { ...item }
    if (next.versionId === null && view.cloud?.versions[0] !== undefined) {
      next.versionId = view.cloud.versions[0].id
      changed = true
    }
    if (next.desktopVersionId === null && view.desktop?.versions[0] !== undefined) {
      next.desktopVersionId = view.desktop.versions[0].id
      changed = true
    }
    return next
  })
  if (changed) draft.value = { ...draft.value, items }
})

// ── 当前选择 ──

const content = computed(() => effectiveFlowContent(draft.value, chosen.value))
const platform = computed(() => flowPlatformOf(draft.value))
/** 页面端色：选过端之后整页换色（第 1 步还没到「端」时不着色） */
const pagePlatform = computed(() => {
  if (step.value === 'content' || platform.value === null) return undefined
  return platform.value === 'desktop' ? 'desktop' : 'cloud'
})

const stepIndex = computed(() => FLOW_STEPS.indexOf(step.value))

/** 换步时回到页面顶部（上一步可能滚得很深，比如模型表、预览表） */
const flowRoot = ref<HTMLElement | null>(null)
watch(step, async () => {
  await nextTick()
  let element: HTMLElement | null = flowRoot.value?.parentElement ?? null
  while (element && element.scrollHeight <= element.clientHeight) element = element.parentElement
  if (element && element !== document.documentElement && element !== document.body) element.scrollTop = 0
  else if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0 })
})

/**
 * 步骤滑入期间宽表格（模型表 scroll-x 1040）会把外层滚动容器横向撑出去一截，
 * 动画结束后归位 —— 否则手机上整页停在偏右的位置。
 */
function resetHorizontalScroll(): void {
  let element: HTMLElement | null = flowRoot.value
  while (element) {
    if (element.scrollLeft !== 0) element.scrollLeft = 0
    element = element.parentElement
  }
}

// ── 第 1、2 步的卡片 ──

function selectedCount(response: typeof cloudModels.value): number {
  if (!response) return 0
  const routes = response.models.flatMap((model) => model.routes ?? [])
  if (routes.length > 0) return routes.filter((entry) => entry.selected).length
  return response.models.filter((model) => model.selected).length
}

const CONTENT_CARDS = computed<{ value: FlowContent; icon: string; meta: string }[]>(() => [
  {
    value: 'models',
    icon: 'i-ph-cpu',
    meta: `云端已选 ${String(selectedCount(cloudModels.value))} 个 · 桌面端已选 ${String(selectedCount(desktopModels.value))} 个`,
  },
  {
    value: 'plugin',
    icon: 'i-ph-puzzle-piece',
    meta: `云端 ${String(cloudPlugins.value?.length ?? 0)} 个 · 桌面端 ${String(desktopPlugins.value?.length ?? 0)} 个`,
  },
  {
    value: 'runtime',
    icon: 'i-ph-git-branch',
    meta: (() => {
      const preferred = runtimeRows.value.find((row) => row.isDefault) ?? runtimeRows.value[0]
      return preferred ? `当前默认 ${preferred.dshVersion}` : ''
    })(),
  },
])

function platformMeta(target: DeliveryPlatform): string {
  const key = target === 'desktop' ? 'desktop' : 'cloud'
  if (content.value === 'models') {
    const response = key === 'desktop' ? desktopModels.value : cloudModels.value
    return `已选 ${String(selectedCount(response))} 个模型`
  }
  if (content.value === 'plugin') {
    const rows = key === 'desktop' ? desktopPlugins.value : cloudPlugins.value
    return `插件库 ${String(rows?.length ?? 0)} 个`
  }
  if (content.value === 'runtime' && target === 'instance') {
    const running = users.value.filter((user) => user.instance.status === 'running').length
    return `${String(users.value.length)} 位用户 · ${String(running)} 个实例在运行`
  }
  return ''
}

const PLATFORM_CARDS: { value: DeliveryPlatform; icon: string; tone: 'cloud' | 'desktop' }[] = [
  { value: 'instance', icon: 'i-ph-cloud', tone: 'cloud' },
  { value: 'desktop', icon: 'i-ph-desktop', tone: 'desktop' },
]

/** 选了就往下走（停一拍，让选中态的动效被看见） */
let autoAdvance: ReturnType<typeof setTimeout> | null = null
function advanceSoon(): void {
  if (autoAdvance) clearTimeout(autoAdvance)
  autoAdvance = setTimeout(() => {
    autoAdvance = null
    void next()
  }, 260)
}
onBeforeUnmount(() => {
  if (autoAdvance) clearTimeout(autoAdvance)
})

function pickContent(value: FlowContent): void {
  draft.value = chooseFlowContent(draft.value, value)
  chosen.value = value
  advanceSoon()
}

function pickPlatform(value: DeliveryPlatform): void {
  draft.value = chooseFlowPlatform(draft.value, value)
  advanceSoon()
}

// ── 第 3 步：模型配置直接嵌表 ──

const modelsTab = shallowRef<InstanceType<typeof RelayDshTab> | null>(null)
function setModelsTab(element: Element | ComponentPublicInstance | null): void {
  modelsTab.value = (element as InstanceType<typeof RelayDshTab> | null) ?? null
}

// ── 目标 / 校验 ──

const matchedUserIds = computed(() => matchDeliveryUsers(users.value, draft.value.filter).map((user) => user.id))

function userName(id: number): string {
  return users.value.find((user) => user.id === id)?.username ?? `#${String(id)}`
}

const targetText = computed(() =>
  describeDeliveryTargets(draft.value, userName, { matchedUserIds: matchedUserIds.value }),
)

const labels = computed(() =>
  draft.value.items.map((item) =>
    itemLabel(item, { plugins: pluginRows.value, runtimes: runtimeRows.value, presets: presetRows.value }),
  ),
)

/** 离开模型配置那一步时记下默认模型（表格卸载后就读不到了） */
const modelsDefault = ref('')

/** 「配置」这一步的回显：模型 = 默认模型；插件 = 动作 + 个数；版本 = 版本号 */
const configText = computed(() => {
  if (content.value === 'models') return modelsDefault.value ? `默认 ${modelsDefault.value}` : '已保存'
  if (content.value === 'plugin') {
    return `${DELIVERY_ACTION_TEXT[draft.value.action]} ${String(draft.value.items.length)} 个插件`
  }
  return labels.value[0] ?? ''
})

const stepperValues = computed<Partial<Record<FlowStep, string>>>(() => ({
  content: content.value ? FLOW_CONTENT_TEXT[content.value] : undefined,
  platform: platform.value ? FLOW_PLATFORM_TEXT[platform.value] : undefined,
  config: configText.value,
  deliver: targetText.value,
}))

function errorsOf(target: FlowStep): string[] {
  return validateFlowStep(target, draft.value, {
    content: chosen.value,
    matchedUserIds: matchedUserIds.value,
    deliverableModels:
      target === 'config' && content.value === 'models' ? Number(modelsTab.value?.deliverableCount ?? 0) : undefined,
  })
}

// ── 前进 / 后退 ──

const advancing = ref(false)

async function next(): Promise<void> {
  if (advancing.value || step.value === 'deliver' || step.value === 'done') return
  // 模型配置：有没保存的勾选先保存（保存失败就停在这一步）
  if (step.value === 'config' && content.value === 'models' && modelsTab.value?.dirty) {
    advancing.value = true
    const ok = await modelsTab.value.save()
    advancing.value = false
    if (!ok) return
  }
  const errors = errorsOf(step.value)
  if (errors.length > 0) {
    message.warning(errors[0] ?? '还有没选完的')
    return
  }
  if (step.value === 'config' && content.value === 'models') {
    const label = modelsTab.value?.defaultLabel
    modelsDefault.value = typeof label === 'string' ? label : ''
  }
  direction.value = 'next'
  step.value = FLOW_STEPS[stepIndex.value + 1] ?? step.value
}

async function go(target: FlowStep): Promise<void> {
  if (FLOW_STEPS.indexOf(target) >= stepIndex.value) return
  // 从模型配置往回走：有没保存的改动先问一句（RelayDshTab 的确认框）
  if (step.value === 'config' && content.value === 'models') {
    const ok = (await modelsTab.value?.confirmLeave()) ?? true
    if (!ok) return
  }
  direction.value = 'prev'
  step.value = target
}

function previous(): void {
  const target = FLOW_STEPS[stepIndex.value - 1]
  if (target) void go(target)
}

// ── 预览（进入「下发」与改目标时自动刷新） ──

const preview = ref<DeliveryPreviewResponse | null>(null)
const previewing = ref(false)
const previewError = ref('')

function requestBody() {
  return buildDeliveryRequest(draft.value, { matchedUserIds: matchedUserIds.value })
}

let previewSeq = 0
let previewTimer: ReturnType<typeof setTimeout> | null = null

async function loadPreview(): Promise<void> {
  if (errorsOf('deliver').length > 0) {
    preview.value = null
    previewError.value = ''
    return
  }
  const seq = (previewSeq += 1)
  previewing.value = true
  previewError.value = ''
  try {
    const result = await previewDelivery(requestBody())
    if (seq === previewSeq) preview.value = result
  } catch (cause) {
    if (seq === previewSeq) previewError.value = describeError(cause).message
  } finally {
    if (seq === previewSeq) previewing.value = false
  }
}

const requestKey = computed(() => {
  if (step.value !== 'deliver') return ''
  try {
    return JSON.stringify(requestBody())
  } catch {
    return `invalid:${draft.value.targetMode}`
  }
})

watch(requestKey, (key) => {
  if (key === '') return
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void loadPreview(), 350)
})
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
})

const deliverErrors = computed(() => (step.value === 'deliver' ? errorsOf('deliver') : []))

/** 全是跳过行时后端会 400（什么都不执行）：确认按钮禁用 */
const runnable = computed(
  () => deliverErrors.value.length === 0 && (preview.value?.rows ?? []).some((row) => row.skipReason === null),
)

// ── 提交（二次密码） ──

const submitting = ref(false)
const created = ref<DeliveryCreatedResponse | null>(null)

const consequence = computed(() => {
  const summary = preview.value?.summary
  if (!summary || !platform.value) return '这是敏感操作，请输入密码确认。'
  const scope =
    platform.value === 'instance'
      ? `将在云端执行 ${String(summary.instance.willRun)} 项（${String(summary.instance.users)} 人），每个内容项一个任务`
      : `将向桌面端 ${String(summary.desktop.devices)} 台设备发布新清单，设备心跳时拉取`
  return `${scope}。这是敏感操作，请输入密码确认。`
})

async function submit(): Promise<void> {
  if (created.value || submitting.value) return
  if (!runnable.value) {
    message.warning(deliverErrors.value[0] ?? '这次没有需要执行的行')
    return
  }
  submitting.value = true
  try {
    const result = await sensitive(() => withReauth(() => createDelivery(requestBody())), {
      title: `确认下发到${platform.value ? FLOW_PLATFORM_TEXT[platform.value] : ''}`,
      description: consequence.value,
      confirmText: '确认下发',
    })
    created.value = result
    direction.value = 'next'
    step.value = 'done'
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    submitting.value = false
  }
}

// ── 完成 ──

const otherPlatform = computed(() => pendingPlatform.value ?? otherFlowPlatform(platform.value))
const canSendOther = computed(
  () => content.value !== null && flowPlatformBlockedReason(content.value, otherPlatform.value) === null,
)

function resetResult(): void {
  created.value = null
  preview.value = null
  previewError.value = ''
}

/** 内容、动作、目标照旧，换到另一端，回到「配置」（两个端的模型配置 / 插件版本是两套） */
function sendToOther(): void {
  const target = otherPlatform.value
  pendingPlatform.value = null
  resetResult()
  draft.value = chooseFlowPlatform(draft.value, target)
  // 插件版本：新端缺省 = 该端最新
  draft.value = {
    ...draft.value,
    items: draft.value.items.map((item) => {
      if (item.kind !== 'plugin') return item
      const view = pluginRows.value.find((row) => row.id === item.pluginId)
      return target === 'desktop'
        ? { ...item, desktopVersionId: view?.desktop?.versions[0]?.id ?? null }
        : { ...item, versionId: view?.cloud?.versions[0]?.id ?? null }
    }),
  }
  direction.value = 'prev'
  step.value = 'config'
}

function startOver(): void {
  resetResult()
  draft.value = createDeliveryDraft()
  chosen.value = null
  pendingPlatform.value = null
  direction.value = 'prev'
  step.value = 'content'
  void router.replace({ query: {} })
}

const doneTitle = computed(() =>
  platform.value ? `已下发到${FLOW_PLATFORM_TEXT[platform.value]}` : '已提交',
)
</script>

<template>
  <AdminPage title="下发" :platform="pagePlatform" :animate-platform="false">
    <div ref="flowRoot" class="flow" :class="pagePlatform ? `flow--${pagePlatform}` : ''" data-testid="delivery-flow">
      <FlowStepper :current="step" :values="stepperValues" :locked="step === 'done'" @go="go" />

      <Transition
        :name="direction === 'next' ? 'flow--next' : 'flow--prev'"
        mode="out-in"
        @after-enter="resetHorizontalScroll"
      >
        <!-- 1 内容 -->
        <section v-if="step === 'content'" key="content" class="flow__step">
          <h2 class="flow__question">发什么？</h2>
          <div class="flow__cards flow__cards--3" role="radiogroup" aria-label="下发内容">
            <FlowChoiceCard
              v-for="card in CONTENT_CARDS"
              :key="card.value"
              :title="FLOW_CONTENT_TEXT[card.value]"
              :icon="card.icon"
              :meta="card.meta"
              :selected="content === card.value"
              :data-testid="`flow-content-${card.value}`"
              @select="pickContent(card.value)"
            />
          </div>
        </section>

        <!-- 2 端 -->
        <section v-else-if="step === 'platform'" key="platform" class="flow__step">
          <h2 class="flow__question">发到哪一端？</h2>
          <div class="flow__cards flow__cards--2" role="radiogroup" aria-label="下发到哪一端">
            <FlowChoiceCard
              v-for="card in PLATFORM_CARDS"
              :key="card.value"
              :title="FLOW_PLATFORM_TEXT[card.value]"
              :icon="card.icon"
              :tone="card.tone"
              :meta="platformMeta(card.value)"
              :selected="platform === card.value"
              :disabled-reason="flowPlatformBlockedReason(content, card.value)"
              :data-testid="`flow-platform-${card.value}`"
              @select="pickPlatform(card.value)"
            />
          </div>
        </section>

        <!-- 3 配置 -->
        <section v-else-if="step === 'config'" key="config" class="flow__step">
          <h2 class="flow__question">
            {{ content === 'models' ? '下发哪些模型？' : content === 'plugin' ? '怎么处理哪些插件？' : '升级到哪个版本？' }}
          </h2>
          <RelayDshTab
            v-if="content === 'models'"
            :ref="setModelsTab"
            :platform="pagePlatform ?? 'cloud'"
            embedded
          />
          <FlowConfigStep
            v-else-if="content"
            v-model:draft="draft"
            :content="content"
            :plugins="pluginRows"
            :runtimes="runtimeRows"
            :artifact-version-ids="artifactVersionIds"
          />
        </section>

        <!-- 4 下发 -->
        <section v-else-if="step === 'deliver'" key="deliver" class="flow__step">
          <h2 class="flow__question">发给谁？</h2>
          <DeliveryTargetsStep
            v-model:draft="draft"
            hide-action
            :users="users"
            :install-stats="installStats?.items ?? []"
            :matched-user-ids="matchedUserIds"
            :plugins="pluginRows"
            :runtimes="runtimeRows"
            :presets="presetRows"
          />

          <NCollapse v-if="platform === 'instance'" class="flow__strategy" data-testid="flow-strategy">
            <NCollapseItem name="strategy">
              <template #header>
                <span class="flow__strategy-title">灰度策略</span>
                <span class="flow__strategy-value">
                  并发 {{ draft.strategy.concurrency }} · 金丝雀 {{ draft.strategy.canary }} · 失败
                  {{ Math.round(draft.strategy.maxFailureRatio * 100) }}% 暂停
                </span>
              </template>
              <DeliveryStrategyStep v-model:draft="draft" />
            </NCollapseItem>
          </NCollapse>

          <DeliveryPreviewStep
            :draft="draft"
            :preview="preview"
            :previewing="previewing"
            :preview-error="deliverErrors[0] ?? previewError"
            :submitting="submitting"
            :created="null"
            :action-text="`${DELIVERY_ACTION_TEXT[draft.action]}：${labels.join('、')}`"
            :target-text="`${platform ? FLOW_PLATFORM_TEXT[platform] : ''} · ${targetText}`"
            :runnable="runnable"
            @refresh="loadPreview"
            @submit="submit"
          />
        </section>

        <!-- 5 完成 -->
        <section v-else key="done" class="flow__step">
          <SoftCard class="flow__done" data-testid="delivery-result">
            <svg class="flow__done-mark" viewBox="0 0 52 52" aria-hidden="true">
              <circle class="check-circle" cx="26" cy="26" r="24" fill="none" />
              <path class="check-path" fill="none" d="M15 27 l7 7 l15 -15" />
            </svg>
            <h2 class="flow__done-title">{{ doneTitle }}</h2>
            <p class="flow__done-sub">
              {{ content ? FLOW_CONTENT_TEXT[content] : '' }} · {{ configText }} → {{ targetText }}
            </p>

            <ul v-if="created && created.jobs.length > 0" class="flow__done-list" data-testid="delivery-jobs">
              <li v-for="job in created.jobs" :key="job.jobId">
                <span class="i-ph-list-checks" aria-hidden="true" />
                <RouterLink :to="`/admin/jobs/${job.jobId}`" class="hub-link">任务 #{{ job.jobId }}</RouterLink>
                <span class="flow__done-muted">{{ job.itemLabel }}</span>
              </li>
            </ul>
            <p v-if="created?.desktop" class="flow__done-revision" data-testid="delivery-revision">
              <span class="i-ph-desktop" aria-hidden="true" />
              <template v-if="created.desktop.revision !== null">
                清单 #{{ created.desktop.revision }} · {{ created.desktop.users }} 位用户 ·
                {{ created.desktop.devices }} 台设备，设备下次心跳时拉取
              </template>
              <template v-else>桌面端没有需要更新的内容</template>
            </p>
            <ul v-if="created && created.skippedItems.length > 0" class="flow__done-list flow__done-list--skipped" data-testid="delivery-skipped">
              <li v-for="(item, index) in created.skippedItems" :key="index">
                <span class="i-ph-warning-circle" aria-hidden="true" />
                {{ item.itemLabel }}：{{ item.reason }}
              </li>
            </ul>

            <div class="flow__done-actions">
              <NButton v-if="canSendOther" type="primary" data-testid="delivery-other" @click="sendToOther">
                <template #icon><span :class="otherPlatform === 'desktop' ? 'i-ph-desktop' : 'i-ph-cloud'" /></template>
                再下发到{{ FLOW_PLATFORM_TEXT[otherPlatform] }}
              </NButton>
              <RouterLink v-slot="{ navigate }" to="/admin/jobs" custom>
                <NButton data-testid="delivery-to-jobs" @click="navigate">去任务中心</NButton>
              </RouterLink>
              <NButton quaternary data-testid="delivery-again" @click="startOver">新的下发</NButton>
            </div>
          </SoftCard>
        </section>
      </Transition>

      <!-- 底部操作条：上一步 / 下一步（下发步是「确认下发」） -->
      <footer v-if="step !== 'done'" class="flow__bar" data-testid="flow-bar">
        <NButton :disabled="stepIndex === 0" data-testid="delivery-prev" @click="previous">上一步</NButton>
        <span class="flow__bar-summary">
          <template v-if="content">{{ FLOW_CONTENT_TEXT[content] }}</template>
          <template v-if="platform && stepIndex >= 1">
            <span class="i-ph-caret-right" aria-hidden="true" />
            <span class="flow__bar-plat">{{ FLOW_PLATFORM_TEXT[platform] }}</span>
          </template>
          <template v-if="step === 'deliver' && preview">
            <span class="i-ph-caret-right" aria-hidden="true" />
            {{
              platform === 'desktop'
                ? `${preview.summary.desktop.devices} 台设备`
                : `${preview.summary.instance.users} 位用户`
            }}
          </template>
        </span>
        <NButton
          v-if="step !== 'deliver'"
          type="primary"
          class="flow__primary"
          :loading="advancing"
          data-testid="delivery-next"
          @click="next"
        >
          下一步
        </NButton>
        <NButton
          v-else
          type="primary"
          class="flow__primary"
          :loading="submitting"
          :disabled="!runnable"
          data-testid="delivery-submit"
          @click="submit"
        >
          <template #icon><span class="i-ph-paper-plane-tilt" aria-hidden="true" /></template>
          确认下发
        </NButton>
      </footer>
    </div>
  </AdminPage>
</template>

<style scoped>
.flow {
  --plat: var(--c-primary);
  --plat-soft: var(--c-primary-soft);
  --plat-ink: var(--c-primary-press);

  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-6);
  padding-bottom: 88px;
  /* 步骤左右滑入时不让外层出现横向滚动 */
  overflow-x: clip;
  overflow-clip-margin: 24px;
}

.flow--cloud {
  --plat: var(--c-plat-cloud);
  --plat-soft: var(--c-plat-cloud-soft);
  --plat-ink: var(--c-plat-cloud-ink);
}

.flow--desktop {
  --plat: var(--c-plat-desktop);
  --plat-soft: var(--c-plat-desktop-soft);
  --plat-ink: var(--c-plat-desktop-ink);
}

.flow__step {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.flow__question {
  margin: var(--space-2) 0 0;
  color: var(--c-text);
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
}

.flow__cards {
  display: grid;
  gap: var(--space-4);
}

.flow__cards--3 {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.flow__cards--2 {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.flow__strategy {
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.flow__strategy-title {
  margin-right: var(--space-3);
  font-weight: var(--fw-semibold);
}

.flow__strategy-value {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

/* ── 完成 ── */
.flow__done {
  text-align: center;
}

.flow__done-mark {
  width: 64px;
  height: 64px;
  margin: var(--space-4) auto var(--space-2);
  stroke: var(--plat);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 3;
}

.flow__done-title {
  margin: 0;
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
}

.flow__done-sub {
  margin: var(--space-2) 0 var(--space-4);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.flow__done-list {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 auto var(--space-3);
  padding: 0;
  list-style: none;
  font-size: var(--fs-13);
}

.flow__done-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.flow__done-list--skipped {
  color: var(--c-butter-ink);
}

.flow__done-muted {
  color: var(--c-text-3);
}

.flow__done-revision {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--plat-ink);
  font-size: var(--fs-13);
}

.flow__done-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-3);
  margin: var(--space-4) 0 var(--space-2);
}

/* ── 底部操作条：贴在视口底部，端色描边 ── */
.flow__bar {
  position: sticky;
  z-index: 5;
  bottom: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid color-mix(in srgb, var(--plat) 22%, var(--c-border));
  border-radius: var(--radius-card);
  background: var(--c-surface-glass);
  backdrop-filter: blur(16px);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--plat) 12%, transparent);
  transition: border-color 320ms var(--ease-out-soft);
}

.flow__bar-summary {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  overflow: hidden;
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.flow__bar-plat {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--plat-soft);
  color: var(--plat-ink);
  transition:
    background-color 320ms var(--ease-out-soft),
    color 320ms var(--ease-out-soft);
}

.flow__primary {
  --n-color: var(--plat) !important;
  --n-color-hover: color-mix(in srgb, var(--plat) 88%, var(--c-surface)) !important;
  --n-color-pressed: color-mix(in srgb, var(--plat) 85%, var(--c-text)) !important;
  --n-color-focus: var(--plat) !important;
  --n-border: 1px solid var(--plat) !important;
  --n-border-hover: 1px solid var(--plat) !important;
  --n-border-pressed: 1px solid var(--plat) !important;
  --n-border-focus: 1px solid var(--plat) !important;
  --n-color-disabled: color-mix(in srgb, var(--plat) 45%, var(--c-surface)) !important;
  --n-border-disabled: 1px solid transparent !important;
}

/* ── 步骤切换：往前从右边滑进、往回从左边滑进 ── */
.flow--next-enter-active,
.flow--next-leave-active,
.flow--prev-enter-active,
.flow--prev-leave-active {
  transition:
    opacity 220ms var(--ease-out-soft),
    transform 260ms var(--ease-out-soft);
}

.flow--next-enter-from,
.flow--prev-leave-to {
  opacity: 0;
  transform: translateX(40px);
}

.flow--next-leave-to,
.flow--prev-enter-from {
  opacity: 0;
  transform: translateX(-40px);
}

@media (prefers-reduced-motion: reduce) {
  .flow--next-enter-active,
  .flow--next-leave-active,
  .flow--prev-enter-active,
  .flow--prev-leave-active {
    transition-duration: var(--duration-press);
  }

  .flow--next-enter-from,
  .flow--next-leave-to,
  .flow--prev-enter-from,
  .flow--prev-leave-to {
    transform: none;
  }
}
</style>
