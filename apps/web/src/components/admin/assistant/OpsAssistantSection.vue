<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { isProposalExpired } from '@/utils/cockpit'
import { assistLayoutOf, assistTierSpec } from '@/utils/assist-layout'
import {
  ASSIST_PHASE_META,
  assistShowsLoadCard,
  synthAssistPhase,
  type CockpitAppStatus,
} from '@/utils/assist-phase'

import AssistantEvents from '@/components/admin/assistant/AssistantEvents.vue'
import AssistantLoadCard from '@/components/admin/assistant/AssistantLoadCard.vue'
import CockpitFrame from '@/components/admin/cockpit/CockpitFrame.vue'
import { DEV_COCKPIT_SESSIONS } from '@/components/admin/cockpit/dev-sessions'
import { useAssistTier } from '@/composables/useAssistTier'
import { useCockpit } from '@/composables/useCockpit'

/**
 * AI 助手页（WP57 立页，WP58 桌面化：docs/26 §2 / §4 / §5 的父页面一侧）。
 *
 * ```
 * ┌ AI 助手  ● 就绪 · 2 项待确认 ………………………… [事件]（仅 S 档） 重启 ┐  ← 卡片头（页标题已合并进来）
 * │ 对话（App 网页版 iframe，theme=console）      │ 事件卡片             │
 * │  启动加载卡盖在上面，下面就是对话                  │ 待确认 / 本次会话 / 最近处理 │
 * └───────────────────────────────────────────────────┴──────────────────────┘
 * ```
 *
 * - **五档布局**（docs/26 §2.1）：按 `window.innerWidth` 用 `matchMedia` 分档，事件栏宽度按档；
 *   S 档把事件栏收进右侧抽屉；卡片头与事件栏按档 `zoom`（**对话区不 zoom**，放大由 App 按
 *   `cockpit.layout.scale` 自己做，否则 Chrome 会把祖先的 zoom 带进 iframe 叠一层）。
 * - **阶段只有一个**（§4）：Hub 的容器状态 + App 报的 `cockpit.status` 合成为 idle / starting /
 *   booting / connecting / ready / offline / failed，胶囊、加载卡、按钮都只看它。
 * - **不自动拉起**座舱容器（`/state?start=0`）：管理员点「启动」才起；重启走同一套。
 * - 老 App 不发 `cockpit.status` / 不带 `caps`：容器 `running` + 收到 `cockpit.ready` 就算 ready。
 */
const props = withDefaults(
  defineProps<{
    /** 独立页面（`/admin/assistant`）：页标题已由本卡片的头部承担，高度撑满视口 */
    page?: boolean
  }>(),
  { page: false },
)

const cockpit = useCockpit({ autoStart: false, board: false })
const { sessionId, items, proposals, secrets, catalog, status, error } = cockpit

const frameRef = ref<InstanceType<typeof CockpitFrame> | null>(null)
const code = ref<string | null>(null)
const prefill = ref<{ text: string; seq: number } | null>(null)
const placeholderPrefill = ref('')

// ── 分档与布局（docs/26 §2.1） ──

const tier = useAssistTier()
const tierSpec = computed(() => assistTierSpec(tier.value))
const layout = computed(() => assistLayoutOf(tier.value))
const isSmall = computed(() => tier.value === 'S')
const drawerOpen = ref(false)

const styleVars = computed(() => ({
  '--assist-scale': String(layout.value.scale),
  '--assist-events-w': `${String(tierSpec.value.eventsWidth)}px`,
}))

/** 生产 = 同源 iframe（App 网页版嵌入）；开发环境没有 `/m/`，用占位面板（`?embed=1` 强制 iframe） */
const frameMode = computed<'iframe' | 'placeholder'>(() => {
  if (typeof window === 'undefined') return 'placeholder'
  const flag = new URLSearchParams(window.location.search).get('embed')
  if (flag === '1') return 'iframe'
  if (flag === '0') return 'placeholder'
  return import.meta.env.DEV ? 'placeholder' : 'iframe'
})

const instance = computed(() => status.value?.instance ?? null)
const running = computed(() => instance.value === 'running')

// ── 阶段合成（docs/26 §4.1） ──

/** 点过「启动 / 重启」之后一直为 true（直到 ready 或判定失败） */
const startRequested = ref(false)
/** 启动 / 重启接口报的错 */
const startError = ref<string | null>(null)
/** App 在 cockpit.ready 里报的 caps；null = 老 App（不发 caps） */
const appCaps = ref<string[] | null>(null)
/** App 最新一条 cockpit.status */
const appStatus = ref<CockpitAppStatus | null>(null)
const readyReceived = ref(false)
/** 本轮是否 ready 过（ready 之后断开 → 「重连中」，不再盖加载卡） */
const everReady = ref(false)
/** 点启动 / 重启的时刻；`null` = 没点过（页面打开时容器已经在跑） */
const startedAt = ref<number | null>(null)
const now = ref(Date.now())
const restarting = ref(false)

/** 失败原因：接口报错优先，其次 Hub 自己报的 reason */
const failureReason = computed(() => {
  if (startError.value) return startError.value
  if (instance.value === 'error') return status.value?.reason?.trim() || null
  return null
})

const phaseResult = computed(() =>
  synthAssistPhase({
    instance: instance.value,
    startRequested: startRequested.value,
    startError: failureReason.value,
    caps: appCaps.value,
    appStatus: appStatus.value,
    readyReceived: readyReceived.value,
    everReady: everReady.value,
    startedAt: startedAt.value,
    now: now.value,
  }),
)

const phase = computed(() => phaseResult.value.phase)
const showLoad = computed(() => assistShowsLoadCard(phase.value))
const statusMeta = computed(() =>
  instance.value === null ? { text: '读取中', tone: 'muted' as const } : ASSIST_PHASE_META[phase.value],
)
const steps = computed(() => phaseResult.value.steps)
const elapsedMs = computed(() => phaseResult.value.elapsedMs)
const failReason = computed(() => phaseResult.value.reason)
const appMessage = computed(() => phaseResult.value.message)

/** 头部主按钮：进行中只显示进度；跑起来了给「重启」；否则「启动」 */
const headAction = computed<'starting' | 'restart' | 'start'>(() => {
  if (phase.value === 'starting' || phase.value === 'booting' || phase.value === 'connecting') return 'starting'
  return running.value ? 'restart' : 'start'
})

/** 加载卡 / 重试：容器已经在跑就重启，否则重新启动 */
function onRetry(): void {
  if (running.value) void onRestart()
  else void onStart()
}

// 计时器：只在「正在启动」的这段时间里每秒推进一次（超时判定与「已用」都靠它）
let ticker: ReturnType<typeof setInterval> | null = null

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

function syncTicker(): void {
  const transient = phase.value === 'starting' || phase.value === 'booting' || phase.value === 'connecting'
  const needed = transient && startedAt.value !== null
  if (needed && ticker === null) {
    ticker = setInterval(() => {
      now.value = Date.now()
    }, 1000)
  } else if (!needed) {
    stopTicker()
  }
}

watch([phase, startedAt], syncTicker, { immediate: true })

watch(phase, (next) => {
  if (next === 'ready') {
    everReady.value = true
    startRequested.value = false
  }
})

function resetRun(): void {
  startError.value = null
  appCaps.value = null
  appStatus.value = null
  readyReceived.value = false
  everReady.value = false
  startRequested.value = true
  startedAt.value = Date.now()
  now.value = Date.now()
}

onMounted(() => {
  void cockpit.load()
})

onBeforeUnmount(() => {
  stopTicker()
  if (shakeTimer !== null) clearTimeout(shakeTimer)
})

/** 跑起来了才要交接码（码写进 iframe 的 hash；没起来时不建 iframe） */
watch(
  running,
  async (value) => {
    if (!value || frameMode.value !== 'iframe' || code.value) return
    code.value = await cockpit.requestHandoff()
  },
  { immediate: true },
)

async function onStart(): Promise<void> {
  resetRun()
  const failure = await cockpit.start()
  if (failure) startError.value = failure.message
}

async function onRestart(): Promise<void> {
  resetRun()
  restarting.value = true
  // 重启后旧码已经兑换过：清掉，running 的 watch 会重新要一个（与 iframe 的 code 变化解耦）
  code.value = null
  try {
    const failure = await cockpit.restart()
    if (failure) startError.value = failure.message
  } finally {
    restarting.value = false
  }
}

// ── iframe 消息（阶段 + 会话） ──

function onSession(id: string | null): void {
  if (id === cockpit.sessionId.value) return
  void cockpit.selectSession(id)
}

async function onAuthExpired(): Promise<void> {
  const next = await cockpit.requestHandoff()
  if (!next) return
  code.value = next
  frameRef.value?.sendHandoff(next)
}

function onAsk(text: string): void {
  prefill.value = { text, seq: (prefill.value?.seq ?? 0) + 1 }
  placeholderPrefill.value = text
}

/** 收到 `cockpit.ready`：老 App 不带 caps（`null`），新 App 带 `['status','layout','console']` */
function onFrameReady(caps?: string[]): void {
  readyReceived.value = true
  appCaps.value = caps ?? null
}

/** 收到 `cockpit.status`（新 App 才会发） */
function onFrameStatus(status: CockpitAppStatus): void {
  appStatus.value = status
}

const flashId = ref<string | null>(null)

function onFocusProposal(id: number): void {
  flashId.value = `proposal-${String(id)}`
  setTimeout(() => {
    if (flashId.value === `proposal-${String(id)}`) flashId.value = null
  }, 1600)
}

function onFocusCanvas(id: string): void {
  flashId.value = id
  setTimeout(() => {
    if (flashId.value === id) flashId.value = null
  }, 1600)
}

// ── 事件卡片（数据在父页面，渲染在 AssistantEvents；常驻栏与抽屉共用） ──

const CLEARED_KEY = 'hub.admin.assistant.clearedAt'

function readClearedAt(): number {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(CLEARED_KEY)
    const value = raw === null ? Number.NaN : Date.parse(raw)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

const clearedAt = ref(readClearedAt())

function visibleAfterClear(iso: string | undefined): boolean {
  if (!iso) return true
  const at = Date.parse(iso)
  return !Number.isFinite(at) || at > clearedAt.value
}

function clearEvents(): void {
  const at = new Date().toISOString()
  clearedAt.value = Date.parse(at)
  try {
    localStorage.setItem(CLEARED_KEY, at)
  } catch {
    // 存不下就只清这一次
  }
}

/** 还能拍板的才算「待确认」：过期的 pending 方案归到「最近处理」（可以被清空） */
const pendingProposals = computed(() =>
  proposals.value.filter((row) => row.status === 'pending' && !isProposalExpired(row)),
)
const pendingSecrets = computed(() => secrets.value.filter((row) => row.status === 'pending'))

/** 本次会话里 AI 产出的结果卡（方案 / 密钥卡在「待确认」里单独列，不重复） */
const resultCards = computed(() =>
  items.value.filter(
    (item) =>
      item.spec.kind !== 'proposal' &&
      item.spec.kind !== 'secret-request' &&
      visibleAfterClear(item.updatedAt),
  ),
)

/** 最近处理过的方案（已执行 / 已拒绝 / 失败 / 过期），新的在上 */
const recentProposals = computed(() =>
  proposals.value
    .filter((row) => !(row.status === 'pending' && !isProposalExpired(row)))
    .filter((row) => visibleAfterClear(row.decidedAt ?? row.expiresAt ?? row.createdAt))
    .slice()
    .sort((left, right) => right.id - left.id)
    .slice(0, 6),
)

const pendingCount = computed(() => pendingProposals.value.length + pendingSecrets.value.length)
const clearable = computed(() => resultCards.value.length > 0 || recentProposals.value.length > 0)

// S 档：有待确认新到且抽屉关着 —— 「事件」按钮抖一下（不自动弹抽屉，docs/26 §2.3）
const shaking = ref(false)
let shakeTimer: ReturnType<typeof setTimeout> | null = null

watch(pendingCount, (next, previous) => {
  if (next <= previous) return
  if (!isSmall.value || drawerOpen.value) return
  shaking.value = true
  if (shakeTimer !== null) clearTimeout(shakeTimer)
  shakeTimer = setTimeout(() => {
    shaking.value = false
  }, 900)
})

// 跨档时抽屉不该留着（从 S 拖到 M 后常驻栏回来了）
watch(tier, (next) => {
  if (next !== 'S') drawerOpen.value = false
})
</script>

<template>
  <section
    class="assistant"
    :class="{ 'assistant--page': props.page }"
    :data-tier="tier"
    :data-phase="phase"
    :style="styleVars"
    data-testid="ops-assistant"
  >
    <header class="assistant__head">
      <span class="assistant__mark" aria-hidden="true"><span class="i-ph-sparkle-fill" /></span>
      <h2 class="assistant__title">AI 助手</h2>
      <span
        class="assistant__status"
        :class="`assistant__status--${statusMeta.tone}`"
        :title="appMessage ?? undefined"
        data-testid="ops-assistant-status"
        :data-phase="phase"
      >
        <span class="assistant__dot" aria-hidden="true" />
        {{ statusMeta.text }}
      </span>
      <span v-if="pendingCount > 0" class="assistant__pending" data-testid="ops-assistant-pending">
        {{ pendingCount }} 项待确认
      </span>
      <span class="assistant__spacer" />

      <NButton
        v-if="isSmall"
        size="small"
        quaternary
        class="assistant__events-btn"
        :class="{ 'assistant__events-btn--shake': shaking }"
        data-testid="ops-assistant-events-open"
        @click="drawerOpen = true"
      >
        <template #icon><span class="i-ph-bell" aria-hidden="true" /></template>
        事件
        <span v-if="pendingCount > 0" class="assistant__badge">{{ pendingCount }}</span>
      </NButton>

      <NButton
        v-if="headAction === 'restart'"
        size="small"
        quaternary
        :loading="restarting"
        data-testid="ops-assistant-restart"
        @click="onRestart"
      >
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        重启
      </NButton>
      <NButton
        v-else
        size="small"
        type="primary"
        :loading="headAction === 'starting'"
        :disabled="headAction === 'starting' || instance === null"
        data-testid="ops-assistant-start"
        @click="onStart"
      >
        <template #icon><span class="i-ph-power" aria-hidden="true" /></template>
        启动
      </NButton>
    </header>

    <div class="assistant__body">
      <!-- 对话 -->
      <div class="assistant__chat" aria-label="和 AI 助手对话">
        <CockpitFrame
          v-if="running && (frameMode === 'placeholder' || code)"
          ref="frameRef"
          :mode="frameMode"
          :code="code"
          :session-id="sessionId"
          :prefill="prefill"
          :placeholder-prefill="placeholderPrefill"
          :sessions="DEV_COCKPIT_SESSIONS"
          :theme="'console'"
          :layout="layout"
          page-background="--c-surface"
          @ready="onFrameReady"
          @status="onFrameStatus"
          @session="onSession"
          @auth-expired="onAuthExpired"
          @focus-proposal="onFocusProposal"
          @focus-canvas="onFocusCanvas"
        />

        <div v-else-if="phase === 'idle'" class="assistant__idle" data-testid="ops-assistant-idle">
          <span class="assistant__idle-icon" aria-hidden="true">
            <span class="i-ph-chat-circle-dots" />
          </span>
          <p class="assistant__idle-title">告诉 AI 要做什么，它出方案、你确认后执行</p>
          <NButton
            v-if="instance !== null"
            type="primary"
            data-testid="ops-assistant-start-big"
            @click="onStart"
          >
            启动 AI 助手
          </NButton>
        </div>

        <p v-else-if="!showLoad" class="assistant__wait">
          <span class="i-ph-circle-notch ring-spin" aria-hidden="true" />
          正在打开对话…
        </p>

        <!-- 启动加载（盖在对话区上；running 之后 iframe 已经在下面加载，卡淡出时对话就位，不闪白） -->
        <Transition name="assist-load">
          <AssistantLoadCard
            v-if="showLoad"
            :phase="phase"
            :steps="steps"
            :elapsed-ms="elapsedMs"
            :reason="failReason"
            :message="appMessage"
            :docked-sessions="layout.sessions === 'docked'"
            @retry="onRetry"
            @restart="onRestart"
          />
        </Transition>
      </div>

      <!-- 事件卡片（M 档及以上常驻；S 档收进右侧抽屉） -->
      <aside v-if="!isSmall" class="assistant__side" aria-label="事件卡片">
        <AssistantEvents
          :pending-proposals="pendingProposals"
          :pending-secrets="pendingSecrets"
          :result-cards="resultCards"
          :recent-proposals="recentProposals"
          :catalog="catalog"
          :error="error"
          :flash-id="flashId"
          :clearable="clearable"
          @clear="clearEvents"
          @proposal-updated="cockpit.applyProposal"
          @secret-updated="cockpit.applySecret"
          @pin="cockpit.togglePin"
          @close="cockpit.closeCard"
          @ask="onAsk"
        />
      </aside>
    </div>

    <NDrawer v-if="isSmall" v-model:show="drawerOpen" :width="tierSpec.eventsWidth" placement="right">
      <NDrawerContent title="事件" closable>
        <AssistantEvents
          bare
          :pending-proposals="pendingProposals"
          :pending-secrets="pendingSecrets"
          :result-cards="resultCards"
          :recent-proposals="recentProposals"
          :catalog="catalog"
          :error="error"
          :flash-id="flashId"
          :clearable="clearable"
          @clear="clearEvents"
          @proposal-updated="cockpit.applyProposal"
          @secret-updated="cockpit.applySecret"
          @pin="cockpit.togglePin"
          @close="cockpit.closeCard"
          @ask="onAsk"
        />
      </NDrawerContent>
    </NDrawer>
  </section>
</template>

<style scoped>
.assistant {
  /* 座舱组件里用到的舰桥令牌，在浅色管理台里给一套对应值（舰桥本身不受影响） */
  --b-panel: var(--c-surface);
  --b-panel-solid: var(--c-surface);
  --b-line-strong: color-mix(in srgb, var(--c-primary) 28%, var(--c-border));
  --b-tick: transparent;
  --b-tick-dim: transparent;
  --b-tick-len: 0px;
  --b-glass: var(--c-surface);
  --b-glass-blur: 0px;
  --b-glass-shadow: var(--shadow-card);
  --b-glow-current: 0 0 0 2px color-mix(in srgb, var(--c-primary) 22%, transparent);
  --b-horizon: var(--c-border);
  --b-gauge-track: var(--c-surface-muted);
  --b-bar-fill: var(--c-primary);
  --b-sky-text-glow: none;
  --b-stat-glow-good: none;
  --b-stat-glow-bad: none;
  --b-stat-glow-warn: none;
  --b-stat-glow-neutral: none;
  --b-arrive-duration: 420ms;

  /* 档位（由 useAssistTier 写入 styleVars；这里给缺省值，非浏览器环境也不至于没有尺寸） */
  --assist-scale: 1;
  --assist-events-w: 360px;

  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

/* 卡片头随档位放大（docs/26 §2.2）；对话区不 zoom —— App 按 cockpit.layout.scale 自己放大 */
.assistant__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-6);
  border-bottom: var(--border-width) solid var(--c-border);
  zoom: var(--assist-scale);
}

.assistant__mark {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--c-plat-cloud), var(--c-plat-desktop));
  color: var(--c-plat-on);
  font-size: 16px;
}

.assistant__title {
  margin: 0;
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.assistant__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--c-surface-muted);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.assistant__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentcolor;
}

.assistant__status--success {
  background: var(--c-success-soft);
  color: var(--c-success-ink);
}

.assistant__status--sky {
  background: var(--c-sky-soft);
  color: var(--c-sky-ink);
}

.assistant__status--warn {
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
}

.assistant__status--danger {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
}

.assistant__pending {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.assistant__spacer {
  flex: 1;
}

/* 事件按钮上的待确认徽标 */
.assistant__badge {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
  font-size: 11px;
  font-weight: var(--fw-semibold);
}

/* 新的待确认到达、事件栏又看不见：抖一下（不做自动弹抽屉） */
.assistant__events-btn--shake {
  animation: assist-events-shake 700ms var(--ease-out-soft);
}

@keyframes assist-events-shake {
  20%,
  60% {
    transform: translateX(-3px);
  }

  40%,
  80% {
    transform: translateX(3px);
  }
}

.assistant__body {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) calc(var(--assist-events-w) * var(--assist-scale));
}

/* S 档：单栏对话，事件栏收进抽屉 */
.assistant[data-tier='S'] .assistant__body {
  grid-template-columns: minmax(0, 1fr);
}

.assistant__chat {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-right: var(--border-width) solid var(--c-border);
  background: var(--c-surface);
}

.assistant[data-tier='S'] .assistant__chat {
  border-right: 0;
}

.assistant__chat > :deep(*) {
  flex: 1;
}

.assistant__side {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--c-surface);
  zoom: var(--assist-scale);
}

.assistant__idle {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-6);
  text-align: center;
}

.assistant__idle-icon {
  display: inline-flex;
  width: 64px;
  height: 64px;
  align-items: center;
  justify-content: center;
  border-radius: 20px;
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: 32px;
}

.assistant__idle-title {
  margin: 0;
  color: var(--c-text-2);
  font-size: var(--fs-14);
}

.assistant__wait {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

/* 加载卡的淡出（200ms）：卡消失时下面已经是就位的对话（docs/26 §4.2） */
.assist-load-leave-active {
  transition: opacity 200ms var(--ease-out-soft);
}

.assist-load-leave-to {
  opacity: 0;
}

/* 独立页：去掉页标题那一大行（AdminPage 的 header 已关掉），卡片撑满视口高 − 顶栏 − 页内边距。
   64px = AdminLayout 顶栏高度，var(--space-8) * 2 = hub-container--admin 的上下内边距；
   最小 560（docs/26 §2.2）。 */
.assistant--page {
  height: calc(100dvh - 64px - var(--space-8) * 2);
  min-height: 560px;
}

.assistant:not(.assistant--page) .assistant__body {
  height: 640px;
}

@media (prefers-reduced-motion: reduce) {
  .assistant__events-btn--shake {
    animation: none;
  }

  .assist-load-leave-active {
    transition-duration: var(--duration-press);
  }
}
</style>
