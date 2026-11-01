<script setup lang="ts">
/**
 * 审批卡（M5 §12 / M4 §9）。
 *
 * v2 通道（`capabilities.approvals=true`）下手机可以直接批准/拒绝：
 * 批准 = approve（允许这一次操作），拒绝 = reject。
 * 老通道没有可回答入口时退化为「请在网页端处理」+ 中止按钮，不画假按钮。
 */
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import type { ApprovalRequest } from '@dsh-hub/mobile-core'
import { useChatStore } from '@/stores/chat'

const props = defineProps<{ approval: ApprovalRequest }>()
const chat = useChatStore()
const busy = ref(false)

const canAnswer = computed(
  () =>
    chat.capabilities?.approvals === true &&
    props.approval.answerable &&
    (props.approval.state === 'open' || props.approval.state === undefined),
)
const canApprove = computed(() => canAnswer.value && props.approval.actions.includes('approve'))
const canReject = computed(() => canAnswer.value && props.approval.actions.includes('reject'))

function answer(approve: boolean): void {
  if (busy.value) return
  busy.value = true
  chat.answerApproval(props.approval.sessionId, props.approval.approvalId, approve)
  // 服务端结算后会推 approval-settled 把卡片移除；这里给个短 loading 防连点。
  setTimeout(() => {
    busy.value = false
  }, 1_500)
}
</script>

<template>
  <div class="approval-card">
    <header class="approval-card__head">
      <AppIcon name="clock" :size="16" />
      <span>这一步需要你批准</span>
    </header>
    <p class="approval-card__text">
      助手想执行「{{ approval.tool }}」<template v-if="approval.reason">：{{ approval.reason }}</template>
    </p>
    <div v-if="canAnswer" class="approval-card__actions">
      <button
        v-if="canReject"
        class="approval-card__btn approval-card__btn--ghost"
        type="button"
        :disabled="busy"
        @click="answer(false)"
      >
        拒绝
      </button>
      <button
        v-if="canApprove"
        class="approval-card__btn approval-card__btn--primary"
        type="button"
        :disabled="busy"
        @click="answer(true)"
      >
        允许一次
      </button>
    </div>
    <p v-else class="approval-card__hint">当前通道不支持手机端批准，请在电脑或网页端处理。</p>
    <button class="approval-card__stop" type="button" @click="chat.stop()">
      <AppIcon name="square" :size="13" />
      中止这一回合
    </button>
  </div>
</template>

<style scoped>
.approval-card {
  margin: 10px 0;
  padding: 12px;
  border: 1px solid rgba(214, 148, 58, 0.4);
  border-radius: 14px;
  background: rgba(214, 148, 58, 0.08);
}
.approval-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 12.5px;
}
.approval-card__text {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-2);
}
.approval-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}
.approval-card__btn {
  padding: 7px 14px;
  border-radius: 10px;
  font-size: 13px;
}
.approval-card__btn:disabled {
  opacity: 0.55;
}
.approval-card__btn--primary {
  background: var(--accent, #111);
  color: var(--on-accent, #fff);
  border: 1px solid transparent;
}
.approval-card__btn--ghost {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.approval-card__hint {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--text-3);
}
.approval-card__stop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border-radius: 9px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12.5px;
}
</style>
