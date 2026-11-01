<script setup lang="ts">
/**
 * 登录页「网络检测」弹层（0.4.9）。
 *
 * 三行：手机网络 / 互联网（对照站点）/ DSH Hub，每行一行短说明；下面一句结论 + 对应操作。
 * 检测逻辑全在 `lib/net-diag.ts`（`diagnose()` 是纯函数，单测覆盖各种组合），这里只管呈现：
 *
 *  - 打开即检测；检测期间按钮禁用；
 *  - 「去设置 / 打开网络设置」只在原生出现（浏览器里没有这些系统设置页）；
 *  - 从系统设置返回 App（appStateChange → active）自动再检测一次：
 *    用户去开联网开关、回来立刻能看到结果变化，不用再点一次。
 *
 * 0.4.11 / WP52：DSH Hub 有两个入口（广州首选 / 新加坡备用）。除了三行总览，下面还有
 * 每个入口各自的一行（连通性 + 延迟 + 「当前」标记）——用户能一眼看出「主入口被拦了，
 * 但 App 已经切到备用入口」。
 *
 * 手机网页版（WP54 / C4）：网页版**只有一个入口**（`location.origin`，由 Hub 同源托管），
 * 所以没有多入口列表与「当前」标记，只测当前这一个；文案里也没有 APK 相关的说法。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BottomSheet from './BottomSheet.vue'
import { IS_WEB_BUILD } from '@/lib/app-info'
import { onAppStateChange } from '@/lib/platform'
import {
  actionLabel,
  createNetDiagBridge,
  errorKindLabel,
  hubTargetsOf,
  openAppSettings,
  openNetworkSettings,
  runNetDiag,
  stepLabel,
  verdictTone,
  type DiagAction,
  type HubProbeEntry,
  type HubTarget,
  type NetDiagRun,
  type NetDiagStep,
  type NetDiagStepKey,
} from '@/lib/net-diag'
import { originHost, originLabel, originResultText } from '@/lib/hub-origin'
import { useHubOriginStore } from '@/stores/hub-origin'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; relogin: [] }>()

const hubOrigin = useHubOriginStore()

/** 原生桥：没注册插件（Web/开发环境）时为 null —— 走浏览器回退，设置类动作隐藏。 */
const bridge = createNetDiagBridge()
const native = bridge !== null
/** 手机网页版：单入口 + 网页版文案。 */
const web = IS_WEB_BUILD

const ROW_LABELS: Record<NetDiagStepKey, string> = {
  phone: stepLabel('phone', web),
  internet: stepLabel('internet', web),
  hub: stepLabel('hub', web),
}

function initialSteps(): NetDiagStep[] {
  return [
    { key: 'phone', state: 'pending', note: '' },
    { key: 'internet', state: 'pending', note: '' },
    { key: 'hub', state: 'pending', note: '' },
  ]
}

const steps = ref<NetDiagStep[]>(initialSteps())
const result = ref<NetDiagRun | null>(null)
const running = ref(false)
const failed = ref('')
/** 每次检测发一个号：关掉/重开弹层后，旧的那次结果不要再写回来。 */
let generation = 0
let resumeOff: (() => void) | null = null

const outcome = computed(() => result.value?.outcome ?? null)
/** 每个 Hub 入口的探测结果（0.4.11；单入口时长度为 1）。 */
const hubs = computed<HubProbeEntry[]>(() => result.value?.hubs ?? [])
const tone = computed(() => (outcome.value ? verdictTone(outcome.value.verdict) : 'warn'))
const hint = computed(() => (native ? (outcome.value?.hint ?? '') : ''))

/** 非原生环境不显示系统设置类按钮（浏览器里没有这些页面）。 */
const actions = computed<DiagAction[]>(() => {
  const list = outcome.value?.actions ?? []
  if (native) return list
  return list.filter((action) => action !== 'openAppSettings' && action !== 'openNetworkSettings')
})

/**
 * 这次要探测的 Hub 入口。
 * 网页版（C4）只有一个：当前入口（生产里就是 `location.origin`）——不探测别的入口、
 * 界面也不给切换（`hubs.length === 1` 时下面那段多入口列表本来就不渲染）。
 */
function hubTargets(): HubTarget[] {
  if (web) {
    const origin = hubOrigin.current || hubOrigin.primary
    return hubTargetsOf([origin], origin)
  }
  return hubTargetsOf(hubOrigin.origins, hubOrigin.current)
}

async function detect(): Promise<void> {
  if (running.value) return
  const token = ++generation
  running.value = true
  failed.value = ''
  // 不清 result：上一轮的结论先留着（变淡 + 按钮禁用），新一轮结果回来再换
  steps.value = initialSteps()
  try {
    const targets = hubTargets()
    const run = await runNetDiag({
      bridge,
      web,
      // 多入口：每个入口各探一次（当前入口的结果用于结论）；mock 构建没有真实入口时省略。
      ...(targets.length > 0 ? { hubTargets: targets } : {}),
      onProgress: (next) => {
        if (token === generation) steps.value = next
      },
    })
    if (token !== generation) return
    steps.value = run.steps
    result.value = run
  } catch {
    if (token === generation) failed.value = '检测没跑完，再试一次'
  } finally {
    if (token === generation) running.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      // 关掉就作废在跑的那次（结果回来也不写）
      generation++
      running.value = false
      return
    }
    void detect()
  },
  { immediate: true },
)

onMounted(async () => {
  resumeOff = await onAppStateChange((isActive) => {
    // 从系统设置回来：自动再检测一次，用户能直接看到开关是否生效
    if (isActive && props.open && !running.value) void detect()
  })
})

onBeforeUnmount(() => {
  generation++
  resumeOff?.()
  resumeOff = null
})

function stateNote(step: NetDiagStep): string {
  if (step.note) return step.note
  return step.state === 'running' ? '检测中…' : '等待中'
}

/** 一个入口的结果文案：通了给延迟，失败给中文原因（拦截页单独说）。 */
function entryNote(entry: HubProbeEntry): string {
  return originResultText({
    ok: entry.result.ok,
    ms: entry.result.ms,
    bodyHint: entry.result.bodyHint,
    errorText: errorKindLabel(entry.result.errorKind),
  })
}

async function onAction(action: DiagAction): Promise<void> {
  if (action === 'retry') {
    await detect()
    return
  }
  if (action === 'relogin') {
    emit('relogin')
    return
  }
  const ok =
    action === 'openAppSettings'
      ? await openAppSettings(bridge)
      : await openNetworkSettings(bridge)
  if (!ok) failed.value = '打不开系统设置'
}
</script>

<template>
  <BottomSheet :open="open" label="网络检测" @close="emit('close')">
    <p class="sheet__title">网络检测</p>

    <ul class="diag__rows">
      <li
        v-for="step in steps"
        :key="step.key"
        class="diag__row"
        :data-step="step.key"
        :data-state="step.state"
      >
        <span class="diag__state">
          <span v-if="step.state === 'running'" class="diag__spin" aria-hidden="true" />
          <AppIcon v-else-if="step.state === 'ok'" name="check" :size="15" />
          <AppIcon v-else-if="step.state === 'fail'" name="close" :size="15" />
          <span v-else class="diag__idle" aria-hidden="true" />
        </span>
        <span class="diag__label">{{ ROW_LABELS[step.key] }}</span>
        <span class="diag__note">{{ stateNote(step) }}</span>
      </li>
    </ul>

    <!-- 多入口（0.4.11）：每个入口各自的连通性与延迟，标出当前在用哪个（网页版只有一个入口，不渲染） -->
    <ul v-if="!web && hubs.length > 1" class="diag__entries" data-testid="diag-origins">
      <li
        v-for="entry in hubs"
        :key="entry.origin"
        class="diag__entry"
        :data-origin="entry.origin"
        :data-current="entry.current ? '1' : '0'"
        :data-state="entry.result.ok ? 'ok' : 'fail'"
      >
        <span class="diag__entry-name">
          {{ originLabel(entry.origin) }}
          <span class="diag__entry-rank">{{ hubOrigin.rankOf(entry.origin) }}</span>
          <span v-if="entry.current" class="diag__entry-badge">当前</span>
        </span>
        <span class="diag__entry-host">{{ originHost(entry.origin) }}</span>
        <span class="diag__entry-result">{{ entryNote(entry) }}</span>
      </li>
    </ul>

    <div v-if="outcome" class="diag__verdict" :class="[`is-${tone}`, { 'is-busy': running }]">
      <p class="diag__title">{{ outcome.title }}</p>
      <p class="diag__detail">{{ outcome.detail }}</p>
      <p v-if="hint" class="diag__hint">{{ hint }}</p>
    </div>
    <p v-else-if="failed" class="diag__detail is-fail">{{ failed }}</p>

    <div class="diag__actions">
      <button
        v-for="(action, index) in actions"
        :key="action"
        type="button"
        class="diag__btn"
        :class="{ 'is-primary': index === 0 }"
        :data-action="action"
        :disabled="running"
        @click="onAction(action)"
      >
        {{ actionLabel(action) }}
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.diag__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.diag__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
}
.diag__row:last-child {
  border-bottom: 0;
}
.diag__state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  color: var(--text-3);
}
.diag__row[data-state='ok'] .diag__state {
  color: var(--accent);
}
.diag__row[data-state='fail'] .diag__state {
  color: var(--danger);
}
.diag__idle {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-strong);
}
.diag__spin {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1.8px solid var(--border-strong);
  border-top-color: var(--text-2);
  animation: diag-spin 0.8s linear infinite;
}
@keyframes diag-spin {
  to {
    transform: rotate(360deg);
  }
}
.diag__entries {
  list-style: none;
  margin: 6px 0 0;
  padding: 0 6px;
  background: var(--surface-2, transparent);
  border-radius: 10px;
}
.diag__entry {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 34px;
  padding: 7px 0;
  font-size: 12px;
}
.diag__entry + .diag__entry {
  border-top: 1px solid var(--border);
}
.diag__entry-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--text);
}
.diag__entry-rank {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-3);
}
.diag__entry-badge {
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 15px;
  color: var(--accent);
  border: 1px solid currentColor;
}
.diag__entry-host {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: 11px;
}
.diag__entry-result {
  flex: 0 0 auto;
  color: var(--text-2);
}
.diag__entry[data-state='ok'] .diag__entry-result {
  color: var(--accent);
}
.diag__entry[data-state='fail'] .diag__entry-result {
  color: var(--danger);
}
.diag__label {
  font-size: 14.5px;
  color: var(--text);
}
.diag__note {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-3);
}

.diag__verdict {
  margin: 14px 0 0;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--surface-2);
}
.diag__verdict.is-ok {
  background: var(--accent-soft);
}
.diag__verdict.is-busy {
  opacity: 0.55;
}
.diag__verdict.is-warn {
  background: var(--surface-2);
}
.diag__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text);
}
.diag__verdict.is-ok .diag__title {
  color: var(--accent-ink);
}
.diag__verdict.is-bad .diag__title {
  color: var(--danger);
}
.diag__detail,
.diag__hint {
  margin: 3px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
}
.diag__detail.is-fail {
  margin: 12px 6px 0;
  color: var(--danger);
  font-size: 13px;
}
.diag__hint {
  color: var(--text-3);
}

.diag__actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
.diag__btn {
  flex: 1 1 0;
  min-width: 0;
  height: 46px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 14.5px;
  font-weight: 500;
  white-space: nowrap;
}
.diag__btn.is-primary {
  background: var(--btn);
  color: var(--btn-ink);
  font-weight: 600;
}
.diag__btn:active {
  opacity: 0.86;
}
.diag__btn[disabled] {
  opacity: 0.45;
  background: var(--surface-3);
  color: var(--text-3);
}
</style>
