<script setup lang="ts">
/**
 * 过程行（0.4.0 §2，取代 0.2.13 的「过程块」）。
 *
 * 一轮助手回复 = 过程行（0..n 行，紧凑）+ 正文。过程行**默认折叠，运行中也折叠**：
 * - 运行中（0.4.9）：左侧固定「正在深度求索中」+ 动态省略号（三个点依次出现，带 shimmer），
 *   右侧是当前状态（运行中的工具摘要 / 最新一句思考），次要颜色、单行省略、占剩余宽度；
 *   没有状态时右侧留空（左侧已经在说「正在深度求索中」，不重复「思考中」）；
 * - 完成后：左侧换回对应图标（思考时钟 / 搜索地球 / 命令终端 / 文件文档），
 *   中间是结果（「思考了 12 秒」「搜索了 5 个网页」「执行了 3 个操作 · 15.8 秒」）；
 * - 右侧 `›`；出错时摘要后跟红色「N 个错误」，不强制展开。
 *
 * 点整行展开成竖向时间线：每一步一个小节点，思考是灰色正文（最多 6 行，带「展开全文」），
 * 工具节点用 `ToolCardItem`（命令/输出/来源）。用户手动展开后以用户的选择为准，
 * 直到这一轮结束（再从运行态回到完成态时折叠）。
 *
 * 折叠态行高固定（单行省略 + 固定 min-height），所以实时内容增长不会推动时间线；
 * 这也是 §2.3「吸底状态机不被破坏」的前提。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolCardItem from './ToolCardItem.vue'
import {
  activityErrorCount,
  activityHeadline,
  activityIcon,
  activityTotalMs,
  durationText,
  LIVE_LABEL,
  liveStatus,
  toolIcon,
  type ActivityRow,
} from '@/lib/activity'
import {
  cockpitActionText,
  cockpitProcessActions,
  type CockpitProcessAction,
} from '@dsh-hub/mobile-core'
import { isCockpitConsoleTheme } from '@/lib/cockpit-embed'

const props = defineProps<{
  /** 时间线里的块 key（e2e 用它断言实时 → 落库前后是同一个 DOM 节点）。 */
  blockKey: string
  rows: ActivityRow[]
  /** 这一块属于正在进行的回合（末行是实时思考 / 占位行）。 */
  live: boolean
  /** 整轮还在跑（正文流式阶段 live 已经是 false，但这一轮没结束）。 */
  running: boolean
}>()

const emit = defineEmits<{
  /** 点了投放行：父页面闪烁并滚到那张画布卡（WP56d，docs/24 §1/§6）。 */
  'focus-canvas': [id: string]
  /** 点了方案行：父页面滚到右舷那张方案卡。 */
  'focus-proposal': [id: number]
}>()

/**
 * 座舱（WP56d）：这一轮过程里的投放/方案（按出现顺序，一轮可能投放好几张卡）。
 *
 * docs/24 §1 的示意里同时有「⟶ 已投放左舷：近 7 天积分消耗」和「⟶ 已投放右舷：方案 #12」，
 * 所以是**一行一条**，不是只显示最后一个。
 */
const actions = computed(() => cockpitProcessActions(props.rows))

/** 控制台主题（docs/26）没有两舷：文案说「右侧」 */
const consoleTheme = isCockpitConsoleTheme()

function actionText(action: CockpitProcessAction): string {
  return cockpitActionText(action, { console: consoleTheme })
}

function onAction(action: CockpitProcessAction): void {
  if (action.kind === 'canvas') emit('focus-canvas', action.id)
  else emit('focus-proposal', action.id)
}

const manual = ref<boolean | null>(null)
const open = computed(() => manual.value ?? false)

/**
 * 「思考了 N 秒」的时长：从这一块第一次进入运行态算到运行态结束。
 * 历史会话没有实时窗口（复用时是完成态），就退回「思考过程」。
 */
const startedAt = ref<number | null>(null)
const elapsedMs = ref<number | null>(null)

function startTimer(): void {
  startedAt.value = Date.now()
  elapsedMs.value = null
}

function stopTimer(): void {
  if (startedAt.value === null) return
  elapsedMs.value = Date.now() - startedAt.value
  startedAt.value = null
}

watch(
  () => props.live,
  (live) => {
    if (live) {
      if (startedAt.value === null && elapsedMs.value === null) startTimer()
      return
    }
    stopTimer()
  },
  { immediate: true },
)

// 「用户手动展开后，以用户的选择为准，直到这一轮结束」：只在整轮结束时收起一次。
// 正文开始流式时 live 已经是 false，但那一轮还没结束，用户展开的面板保持打开。
watch(
  () => props.running,
  (running) => {
    if (!running) manual.value = null
  },
)

onBeforeUnmount(stopTimer)

const errorCount = computed(() => activityErrorCount(props.rows))
const icon = computed(() => activityIcon(props.rows))
/** 完成后折叠行的结果摘要（运行中的头部是「固定文案 + 状态」两段，见 `status`）。 */
const headline = computed(() => activityHeadline(props.rows, { elapsedMs: elapsedMs.value }))
/** 运行中右侧的当前状态：工具摘要 / 最新一句思考；没有状态时是空串（右侧留白）。 */
const status = computed(() => (props.live ? liveStatus(props.rows) : ''))
/**
 * 头部的无障碍名称（0.4.9）：运行中要把「正在深度求索中」和当前状态都念出来——
 * 可见文字外层是装饰（`aria-hidden`），读屏只读这个 label。完成后保持原来的「过程详情」。
 */
const headLabel = computed(() => {
  if (!props.live) return '过程详情'
  return status.value === '' ? `${LIVE_LABEL}…` : `${LIVE_LABEL}… ${status.value}`
})
/**
 * 右侧灰色「总耗时」（§2.2 打磨）：有实时窗口用窗口（含思考 + 工具 + 等待），
 * 历史会话退回落库工具耗时之和。运行中与「只有思考」都不显示：
 * 前者还没跑完、后者头部那句「思考了 N 秒」已经说了时长。
 */
const totalText = computed(() => {
  if (props.live) return ''
  return durationText(activityTotalMs(props.rows, elapsedMs.value))
})

function toggle(): void {
  manual.value = !open.value
}
</script>

<template>
  <section
    class="process"
    :class="{ 'process--live': live, 'process--error': errorCount > 0, 'process--open': open }"
    data-testid="process-row"
    :data-process-key="blockKey"
  >
    <button
      class="process__head"
      type="button"
      :aria-expanded="open"
      :aria-label="headLabel"
      @click="toggle"
    >
      <!-- 运行中（0.4.10 改两行）：第一行固定文案 + 动态省略号（纯 CSS，三点依次出现），
           第二行当前状态（可能为空，但这一行始终占位：状态出现/消失时高度不变） -->
      <span v-if="live" class="process__live-stack">
        <span class="process__live" aria-hidden="true">
          <span class="process__live-label process__shimmer">{{ LIVE_LABEL }}</span>
          <span class="process__ellipsis"><i /><i /><i /><b>…</b></span>
        </span>
        <span
          class="process__status"
          data-testid="process-status"
          aria-hidden="true"
          :title="status === '' ? undefined : status"
          >{{ status }}</span
        >
      </span>
      <span v-else class="process__lead" aria-hidden="true">
        <AppIcon :name="icon" :size="16" />
      </span>
      <span v-if="!live" class="process__text">{{ headline }}</span>
      <span v-if="errorCount > 0" class="process__error">{{ errorCount }} 个错误</span>
      <span v-if="totalText" class="process__time" data-testid="process-time">{{ totalText }}</span>
      <AppIcon class="process__caret" name="chevronRight" :size="14" />
    </button>

    <!-- 座舱（WP56d）：过程行下方的投放/方案提示，点一下让父页面滚到那张卡 -->
    <div v-if="actions.length > 0" class="process__actions" data-testid="process-actions">
      <button
        v-for="(action, index) in actions"
        :key="`${action.kind}-${String(index)}`"
        class="process__action"
        type="button"
        :data-testid="action.kind === 'canvas' ? 'process-canvas' : 'process-proposal'"
        :data-canvas-id="action.kind === 'canvas' ? action.id : undefined"
        :data-proposal-id="action.kind === 'proposal' ? action.id : undefined"
        @click="onAction(action)"
      >
        <span class="process__action-text">{{ actionText(action) }}</span>
        <span class="process__action-go">查看 ›</span>
      </button>
    </div>

    <div v-if="open" class="process__timeline">
      <div v-for="row in rows" :key="row.key" class="process__step">
        <span class="process__node" aria-hidden="true">
          <AppIcon :name="row.kind === 'tool' ? toolIcon(row.card.kind) : 'clock'" :size="13" />
        </span>
        <div class="process__step-body">
          <ToolCardItem v-if="row.kind === 'tool'" :card="row.card" />
          <ReasoningBlock v-else :text="row.text" :live="row.live && live" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.process {
  margin: 6px 0;
}
.process__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 0;
  text-align: left;
  color: var(--text-2);
  font-size: 15px;
  line-height: 1.4;
}
.process__head:active {
  opacity: 0.7;
}
.process__lead {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-3);
}
/* 运行中头部（0.4.10 改两行）：第一行「正在深度求索中」+ 动态省略号，第二行当前状态。
   两行都是固定行高，整个头部恒为 32 + 20 − 4 = 48px：状态出现/变化/清空都不推动下面的内容。 */
.process__live-stack {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.process__live {
  display: inline-flex;
  align-items: center;
  height: 32px;
  white-space: nowrap;
}
.process__live-label {
  white-space: nowrap;
}
.process__ellipsis {
  display: inline-flex;
  align-items: center;
  gap: 0.13em;
  /* 固定宽度：三个点逐个出现时右侧状态不左右抖 */
  width: 0.88em;
  margin-left: 0.04em;
}
.process__ellipsis i {
  width: 0.2em;
  height: 0.2em;
  border-radius: 50%;
  background: var(--text-2);
  opacity: 0;
  animation: process-ellipsis 1.35s linear infinite;
}
.process__ellipsis i:nth-child(2) {
  animation-name: process-ellipsis-2;
}
.process__ellipsis i:nth-child(3) {
  animation-name: process-ellipsis-3;
}
/* 减少动效时代替动态三点（见文件末尾的 media query） */
.process__ellipsis b {
  display: none;
  color: var(--text-2);
  font-weight: 400;
}
/* 一个循环 = 空 → . → .. → ... → 空（三个点依次出现） */
@keyframes process-ellipsis {
  0%,
  24% {
    opacity: 0;
  }
  25%,
  100% {
    opacity: 1;
  }
}
@keyframes process-ellipsis-2 {
  0%,
  49% {
    opacity: 0;
  }
  50%,
  100% {
    opacity: 1;
  }
}
@keyframes process-ellipsis-3 {
  0%,
  74% {
    opacity: 0;
  }
  75%,
  100% {
    opacity: 1;
  }
}
/* 运行中的当前状态（第二行）：次要颜色、单行、超长省略 */
.process__status {
  display: block;
  height: 20px;
  margin-top: -4px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-3);
  font-size: 13px;
  line-height: 20px;
}
.process__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process__shimmer {
  /* 0.4.9：这段文字现在是一行的主文案（右侧状态才是次要的），
     所以流光的两个端点比原来（--text-3 → --text）亮一档：--text-2 → --text。 */
  background: linear-gradient(100deg, var(--text-2) 15%, var(--text) 45%, var(--text-2) 75%);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: process-shimmer 2.2s linear infinite;
}
@keyframes process-shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}
.process__error {
  flex: 0 0 auto;
  color: var(--danger);
  font-size: 13px;
}
/* 右侧灰色总耗时（§2.2 打磨）：比摘要小一号、不抢注意力 */
.process__time {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.process__caret {
  flex: 0 0 auto;
  color: var(--text-3);
  transition: transform 0.16s ease;
}
/* 运行中头部是两行：箭头对齐第一行（32px 行高的中线），不跑到两行中间 */
.process--live .process__caret {
  align-self: flex-start;
  margin-top: 9px;
}
.process--open .process__caret {
  transform: rotate(90deg);
}
.process__actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 6px;
}
.process__action {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  color: var(--text);
  font-size: 13px;
  text-align: left;
}
.process__action:active {
  opacity: 0.75;
}
.process__action-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.process__action-go {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 11.5px;
}
.process__timeline {
  margin: 2px 0 6px 9px;
  padding-left: 15px;
  border-left: 1px solid var(--border);
}
.process__step {
  position: relative;
  padding: 1px 0;
}
.process__node {
  position: absolute;
  left: -24px;
  top: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--text-3);
  background: var(--bg);
}
.process__step-body {
  min-width: 0;
}
/* 节点图标已经在时间线左侧了，工具行自己那个图标就不重复显示 */
.process__step-body :deep(.tool__icon) {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  /* 运行中的文案不做流光，动态三点换成静态「…」 */
  .process__shimmer {
    animation: none;
    color: var(--text-2);
    background: none;
  }
  .process__ellipsis i {
    display: none;
    animation: none;
  }
  .process__ellipsis b {
    display: inline;
  }
}
</style>
