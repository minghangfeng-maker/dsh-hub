<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'

import type { CanvasItem, CapabilityDescriptor, ProposalView, SecretRequestView } from '@/api/admin-cockpit'
import type { ErrorDescription } from '@/api/errors'
import CanvasCard from '@/components/admin/cockpit/CanvasCard.vue'
import CanvasSpecView from '@/components/admin/cockpit/CanvasSpecView.vue'
import ProposalCard from '@/components/admin/cockpit/ProposalCard.vue'
import SecretRequestCard from '@/components/admin/cockpit/SecretRequestCard.vue'

/**
 * AI 助手页右侧的**事件卡片**（WP58 从 `OpsAssistantSection` 里抽出来，docs/26 §2.3）：
 * 常驻栏（M 档及以上）与 S 档抽屉用的是同一个组件，只是外壳不同 —— 抽屉里不显示「清空」以外的头部。
 *
 * 分组：待确认（方案 / 密钥）→ 本次会话（结果卡）→ 最近处理（已决定的方案）。
 * 外部「定位」某张卡时传 `flashId`，组件自己滚到它并闪一下边框。
 */
const props = withDefaults(
  defineProps<{
    pendingProposals: ProposalView[]
    pendingSecrets: SecretRequestView[]
    resultCards: CanvasItem[]
    recentProposals: ProposalView[]
    catalog: CapabilityDescriptor[]
    error: ErrorDescription | null
    /** 要闪烁定位的卡 / 方案（`proposal-12` / 卡 id） */
    flashId: string | null
    /** 有可清空的东西（待确认的不算） */
    clearable: boolean
    /** 抽屉里用：紧凑一点、不画头部 */
    bare?: boolean
  }>(),
  { bare: false },
)

const emit = defineEmits<{
  clear: []
  'proposal-updated': [proposal: ProposalView]
  'secret-updated': [request: SecretRequestView]
  pin: [item: CanvasItem]
  close: [item: CanvasItem]
  ask: [text: string]
}>()

const eventsRef = ref<HTMLElement | null>(null)

/** 「放大查看」：窄事件栏里放不下的宽表格 / 图表，在大弹窗里完整看 */
const expanded = ref<CanvasItem | null>(null)

const pendingCount = computed(() => props.pendingProposals.length + props.pendingSecrets.length)
const hasEvents = computed(
  () => pendingCount.value > 0 || props.resultCards.length > 0 || props.recentProposals.length > 0,
)

function selectorOf(flashId: string): string {
  const proposal = /^proposal-(\d+)$/.exec(flashId)
  if (proposal) return `[data-event-proposal="${proposal[1] ?? ''}"]`
  return `[data-card-id="${flashId.replace(/["\\]/g, '\\$&')}"]`
}

watch(
  () => props.flashId,
  async (flashId) => {
    if (!flashId) return
    await nextTick()
    const element = eventsRef.value?.querySelector<HTMLElement>(selectorOf(flashId))
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)
</script>

<template>
  <div class="events-wrap">
    <div v-if="!bare" class="events-wrap__head">
      <span class="events-wrap__title">事件</span>
      <NButton
        size="tiny"
        quaternary
        :disabled="!clearable"
        title="清掉结果卡和已处理的方案（待确认的保留）"
        data-testid="ops-assistant-clear"
        @click="emit('clear')"
      >
        <template #icon><span class="i-ph-broom" aria-hidden="true" /></template>
        清空
      </NButton>
    </div>
    <div v-else class="events-wrap__head events-wrap__head--bare">
      <NButton
        size="tiny"
        quaternary
        :disabled="!clearable"
        title="清掉结果卡和已处理的方案（待确认的保留）"
        data-testid="ops-assistant-clear"
        @click="emit('clear')"
      >
        <template #icon><span class="i-ph-broom" aria-hidden="true" /></template>
        清空
      </NButton>
    </div>

    <div ref="eventsRef" class="events" data-testid="ops-assistant-events">
      <template v-if="pendingCount > 0">
        <h3 class="events__group">待确认</h3>
        <div
          v-for="proposal in pendingProposals"
          :key="`p-${String(proposal.id)}`"
          class="events__item events__item--boxed"
          :class="{ 'events__item--flash': flashId === `proposal-${String(proposal.id)}` }"
          :data-event-proposal="proposal.id"
        >
          <ProposalCard :proposal="proposal" :catalog="catalog" @updated="emit('proposal-updated', $event)" />
        </div>
        <div
          v-for="request in pendingSecrets"
          :key="`s-${request.id}`"
          class="events__item events__item--boxed"
        >
          <SecretRequestCard :request-id="request.id" :request="request" @updated="emit('secret-updated', $event)" />
        </div>
      </template>

      <template v-if="resultCards.length > 0">
        <h3 class="events__group">本次会话</h3>
        <CanvasCard
          v-for="item in resultCards"
          :key="item.id"
          :item="item"
          class="events__item"
          :class="{ 'events__item--flash': flashId === item.id }"
          expandable
          :pinnable="false"
          @close="emit('close', $event)"
          @ask="emit('ask', $event)"
          @expand="expanded = $event"
        >
          <!-- CanvasCard 只是外壳，正文（图表 / 表格 / 文字）要塞进默认插槽；方案、密钥卡不在这一组 -->
          <CanvasSpecView :item="item" :catalog="catalog" @ask="emit('ask', $event)" />
        </CanvasCard>
      </template>

      <template v-if="recentProposals.length > 0">
        <h3 class="events__group">最近处理</h3>
        <div
          v-for="proposal in recentProposals"
          :key="`r-${String(proposal.id)}`"
          class="events__item events__item--boxed"
          :class="{ 'events__item--flash': flashId === `proposal-${String(proposal.id)}` }"
          :data-event-proposal="proposal.id"
        >
          <ProposalCard :proposal="proposal" :catalog="catalog" @updated="emit('proposal-updated', $event)" />
        </div>
      </template>

      <div v-if="!hasEvents" class="events__empty" data-testid="ops-assistant-empty">
        <span class="i-ph-tray" aria-hidden="true" />
        AI 出的方案、图表和执行结果会出现在这里
      </div>
      <p v-if="error" class="events__error">{{ error.message }}</p>
    </div>

    <NModal
      :show="expanded !== null"
      preset="card"
      class="events__expanded"
      :title="expanded?.title ?? ''"
      :style="{ width: 'min(1200px, 92vw)' }"
      data-testid="canvas-card-expanded"
      @update:show="(value: boolean) => { if (!value) expanded = null }"
    >
      <CanvasSpecView
        v-if="expanded"
        :item="expanded"
        :catalog="catalog"
        @ask="(text: string) => { expanded = null; emit('ask', text) }"
      />
    </NModal>
  </div>
</template>

<style scoped>
.events-wrap {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--c-surface);
}

.events-wrap__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4) var(--space-2);
}

.events-wrap__head--bare {
  justify-content: flex-end;
  padding: 0 0 var(--space-2);
}

.events-wrap__title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.events {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
  padding: var(--space-2) var(--space-4) var(--space-4);
}

.events__group {
  position: sticky;
  z-index: 1;
  top: calc(var(--space-2) * -1);
  margin: var(--space-2) 0 0;
  padding-block: var(--space-1);
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
}

.events__group:first-child {
  margin-top: 0;
}

.events__item {
  /* 卡片里有几个只有读屏能看到的绝对定位小元素（标题 / 编号）：给个定位上下文，
     否则它们会以更外层为包含块、逃出这个滚动容器，把整页撑出多余高度
     （1366 下能滚 300 多像素的空区） */
  position: relative;
  border-radius: var(--radius-card);
  transition: box-shadow 320ms var(--ease-out-soft);
}

.events__item--boxed {
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  background: var(--c-surface);
}

.events__item--flash {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-primary) 35%, transparent);
}

.events__empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-13);
  text-align: center;
}

.events__empty span {
  font-size: 28px;
}

.events__error {
  margin: 0;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}
</style>
