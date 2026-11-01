<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, ref } from 'vue'

import {
  approveProposal,
  rejectProposal,
  type CapabilityDescriptor,
  type ProposalView,
} from '@/api/admin-cockpit'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import { isReauthCanceled, sensitive, withReauth } from '@/composables/useReauth'
import { formatDateTime } from '@/composables/useFormat'
import {
  PROPOSAL_STATUS_TEXT,
  canDecideProposal,
  capabilityClassicPath,
  capabilityTitle,
  isProposalExpired,
  proposalStatusTone,
  riskMeta,
} from '@/utils/cockpit'

/**
 * 方案卡（docs/24 §1、§3、§7）：
 * - 影响面来自 Hub 的 preview，**不来自 DSH**；`rationale` 用纯文本渲染并标明「DSH 的说明」；
 * - R2 点一次「执行」；R3 还要输入管理员密码（复用 `useReauth` 的 `sensitive`）；
 * - 执行是异步的，状态经 SSE 推回来（卡片自己也会接收一次 PATCH 的返回）。
 */
const props = defineProps<{
  proposal?: ProposalView | null
  catalog: CapabilityDescriptor[]
}>()

const emit = defineEmits<{ updated: [proposal: ProposalView] }>()

const busy = ref<'approve' | 'reject' | null>(null)
const error = ref<string | null>(null)

const expired = computed(() => (props.proposal ? isProposalExpired(props.proposal) : true))
const decidable = computed(() => (props.proposal ? canDecideProposal(props.proposal) : false))
const risk = computed(() => riskMeta(props.proposal?.risk ?? 'R2'))
const statusText = computed(() =>
  props.proposal ? (PROPOSAL_STATUS_TEXT[props.proposal.status] ?? props.proposal.status) : '',
)
const statusTone = computed(() => proposalStatusTone(props.proposal?.status ?? 'pending'))

const steps = computed(() =>
  (props.proposal?.steps ?? []).map((step, index) => ({
    index,
    capability: step.capability,
    title: capabilityTitle(props.catalog, step.capability),
    summary: step.preview.summary,
    affected: step.preview.affected ?? [],
    warnings: step.preview.warnings ?? [],
    secretFields: props.catalog.find((item) => item.id === step.capability)?.secretFields ?? [],
  })),
)

/** 结果按步骤顺序展示；没有结果但有状态时也占位（执行中） */
const outcomes = computed(() =>
  (props.proposal?.outcome ?? []).map((outcome) => ({
    stepIndex: outcome.stepIndex,
    ok: outcome.ok,
    error: outcome.error,
  })),
)

const classicPath = computed(() => {
  const first = props.proposal?.steps[0]
  if (!first) return undefined
  return capabilityClassicPath(props.catalog, first.capability)
})

async function approve(): Promise<void> {
  const proposal = props.proposal
  if (!proposal || !decidable.value) return

  busy.value = 'approve'
  error.value = null
  try {
    const run = (): Promise<{ proposal: ProposalView }> => approveProposal(proposal.id)
    // R3：先输管理员密码（10 分钟内有效，沿用现有 reauth）
    const result =
      proposal.risk === 'R3'
        ? await sensitive(run, {
            title: '确认身份',
            description: `这是 R3 敏感操作：「${proposal.title}」。请输入管理员密码。`,
            confirmText: '确认执行',
            type: 'error',
          })
        : await withReauth(run, { description: '执行方案前确认一下是你本人。' })
    emit('updated', result.proposal)
  } catch (cause) {
    if (!isReauthCanceled(cause)) error.value = describeError(cause).message
  } finally {
    busy.value = null
  }
}

async function reject(): Promise<void> {
  const proposal = props.proposal
  if (!proposal || !decidable.value) return

  busy.value = 'reject'
  error.value = null
  try {
    const result = await rejectProposal(proposal.id)
    emit('updated', result.proposal)
  } catch (cause) {
    error.value = describeError(cause).message
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="!proposal" class="proposal proposal--missing">方案数据还没到</div>

  <article v-else class="proposal" :class="{ 'proposal--done': !decidable }" :data-proposal-id="proposal.id">
    <header class="proposal__head">
      <!-- 卡片外壳的标题已经是「方案 #N · 标题」，这里只留给读屏，视觉上不重复 -->
      <span class="proposal__id sr-only">#{{ proposal.id }}</span>
      <h4 class="proposal__title sr-only">{{ proposal.title }}</h4>
      <MiniTag :text="risk.text" :tone="risk.tone" />
      <MiniTag :text="statusText" :tone="statusTone" />
    </header>

    <section v-if="proposal.rationale" class="proposal__rationale">
      <p class="proposal__label">DSH 的说明</p>
      <p class="proposal__text">{{ proposal.rationale }}</p>
    </section>

    <ol class="proposal__steps">
      <li v-for="step in steps" :key="step.index" class="proposal__step">
        <p class="proposal__step-head">
          <span class="proposal__step-index">{{ step.index + 1 }}</span>
          <span class="proposal__step-title">{{ step.title }}</span>
          <span class="proposal__step-capability">{{ step.capability }}</span>
        </p>
        <p class="proposal__summary">{{ step.summary }}</p>

        <ul v-if="step.affected.length > 0" class="proposal__affected">
          <li v-for="item in step.affected" :key="`${item.kind}-${String(item.id)}`">
            <span class="proposal__affected-kind">{{ item.kind }}</span>
            <span class="proposal__affected-label">{{ item.label }}</span>
          </li>
        </ul>

        <ul v-if="step.warnings.length > 0" class="proposal__warnings">
          <li v-for="warning in step.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <p v-if="step.secretFields.length > 0" class="proposal__secret">
          需要密钥：{{ step.secretFields.join(' / ') }}（走右侧密钥输入卡）
        </p>

        <p
          v-for="outcome in outcomes.filter((item) => item.stepIndex === step.index)"
          :key="`outcome-${outcome.stepIndex}`"
          class="proposal__outcome"
          :class="outcome.ok ? 'proposal__outcome--ok' : 'proposal__outcome--fail'"
        >
          <span :class="outcome.ok ? 'i-ph-check-circle' : 'i-ph-x-circle'" aria-hidden="true" />
          {{ outcome.ok ? '这一步已执行' : (outcome.error?.message ?? '执行失败') }}
        </p>
      </li>
    </ol>

    <p v-if="error" class="proposal__error" role="alert">{{ error }}</p>

    <footer class="proposal__foot">
      <template v-if="decidable">
        <span class="proposal__expiry">有效期至 {{ formatDateTime(proposal.expiresAt) }}</span>
        <div class="proposal__buttons">
          <NButton size="small" :disabled="busy !== null" :loading="busy === 'reject'" @click="reject">
            拒绝
          </NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="busy !== null"
            :loading="busy === 'approve'"
            @click="approve"
          >
            {{ proposal.risk === 'R3' ? '执行（需密码）' : '执行' }}
          </NButton>
        </div>
      </template>

      <span v-else-if="proposal.status === 'running'" class="proposal__state">
        <span class="i-ph-circle-notch ring-spin" aria-hidden="true" />
        正在执行…
      </span>

      <span v-else-if="expired && proposal.status !== 'succeeded'" class="proposal__state"> 方案已过期 </span>

      <template v-else>
        <span v-if="proposal.decidedBy" class="proposal__state">
          {{ proposal.decidedBy.username }} · {{ statusText }}
        </span>
      </template>

      <RouterLink v-if="classicPath" :to="classicPath" class="hub-link proposal__classic">
        在经典页面打开
      </RouterLink>
    </footer>
  </article>
</template>

<style scoped>
.proposal {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.proposal--done {
  opacity: 0.92;
}

.proposal--missing {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.proposal__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.proposal__id {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.proposal__title {
  min-width: 0;
  /* 方案标题是标识性文字，允许换行（长标题），但不从中间断词 */
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.proposal__rationale {
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--c-primary);
  border-radius: 0 var(--radius-control-sm) var(--radius-control-sm) 0;
  background: color-mix(in srgb, var(--c-primary-soft) 55%, transparent);
}

.proposal__label {
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}

.proposal__text {
  margin-top: 2px;
  color: var(--c-text);
  font-size: var(--fs-13);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.proposal__steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.proposal__step {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.proposal__step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.proposal__step-index {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}

.proposal__step-title {
  color: var(--c-text);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.proposal__step-capability {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.proposal__summary {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  overflow-wrap: anywhere;
}

.proposal__affected {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  font-size: var(--fs-12);
}

.proposal__affected li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-bg);
  /* 影响面里的名字（用户名、插件名）不从中间断开（07 §2.8） */
  white-space: nowrap;
}

.proposal__affected-kind {
  color: var(--c-text-3);
}

.proposal__affected-label {
  color: var(--c-text);
  font-family: var(--font-mono);
}

.proposal__warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.proposal__warnings li::before {
  margin-right: 4px;
  content: '⚠';
}

.proposal__secret {
  color: var(--c-sakura-ink);
  font-size: var(--fs-12);
}

.proposal__outcome {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-12);
}

.proposal__outcome--ok {
  color: var(--c-success-ink);
}

.proposal__outcome--fail {
  color: var(--c-danger-ink);
}

.proposal__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.proposal__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: var(--border-width) solid var(--c-border);
}

.proposal__expiry,
.proposal__state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.proposal__buttons {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.proposal__classic {
  font-size: var(--fs-12);
}
</style>
