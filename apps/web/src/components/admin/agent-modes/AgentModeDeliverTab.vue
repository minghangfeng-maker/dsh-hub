<script setup lang="ts">
import type {
  AgentModeStateResponse,
  DeliverAgentModeRequest,
  JobSummary,
  UpdateAgentModeRequest,
} from '@dsh-hub/shared'
import { AGENT_MODE_LABEL, AGENT_MODE_PLUGIN_PACKAGE } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NRadio,
  NRadioGroup,
  NSelect,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { deliverAgentMode, updateAgentMode } from '@/api/admin-agent-modes'
import { getJob } from '@/api/admin-jobs'
import { describeError } from '@/api/errors'
import AgentModeDeliverDialog from '@/components/admin/agent-modes/AgentModeDeliverDialog.vue'
import AgentModeUserPicker from '@/components/admin/agent-modes/AgentModeUserPicker.vue'
import AgentModeUserTable from '@/components/admin/agent-modes/AgentModeUserTable.vue'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import { isJobActive, JOB_STATUS_TONE, jobTypeText, pluginPolicyText } from '@/composables/job-meta'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime } from '@/composables/useFormat'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import SoftCard from '@/components/base/SoftCard.vue'
import { modeRateInput, parseModeRate } from '@/utils/mode-rate'

/**
 * 「Claude Code / Codex → 下发」Tab（18 §6）：
 * 设置（开通、整体倍率、默认模型、小模型、显示名、开放给谁）改完立即保存；
 * 插件卡；用户表（插件 / 实例 / env / 本月花费）；「下发」经二次密码后创建 `rollout.agent-mode` 任务，
 * 页内用 `JobProgress` 看进度。
 *
 * 只有「开通」和「开放给谁」需要下发（18 D6），其它字段保存后下一轮对话就生效。
 */
const props = defineProps<{ state: AgentModeStateResponse; loading?: boolean }>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

// ── 表单 ────────────────────────────────────────────────────────────────────

const enabled = ref(false)
const rateText = ref('1')
const defaultModelId = ref<number | null>(null)
const smallModelId = ref<number | null>(null)
const label = ref('')
const targetMode = ref<'all' | 'users'>('users')
const targetUserIds = ref<number[]>([])

const rateError = ref('')
const labelError = ref('')
const saving = ref(false)

function reset(): void {
  const settings = props.state.settings
  enabled.value = settings.enabled
  rateText.value = modeRateInput(settings.ratePermille)
  defaultModelId.value = settings.defaultModelId
  smallModelId.value = settings.smallModelId
  label.value = settings.label
  targetMode.value = 'all' in settings.targets ? 'all' : 'users'
  targetUserIds.value = 'userIds' in settings.targets ? [...settings.targets.userIds] : []
  rateError.value = ''
  labelError.value = ''
}

watch(() => props.state, reset, { immediate: true })

const ratePermille = computed(() => parseModeRate(rateText.value))

watch(rateText, () => {
  rateError.value = ratePermille.value === null ? '填 0–100 的数字，最多 3 位小数' : ''
})

/** 模型下拉：不能路由的模型禁用，并在选项里写原因（18 §6） */
function optionLabel(model: AgentModeStateResponse['models'][number]): string {
  const name =
    model.displayName && model.displayName !== model.name
      ? `${model.name} · ${model.displayName}`
      : model.name
  if (!model.enabled) return `${name}（已停用）`
  if (!model.routable) return `${name}（没有可用渠道）`
  return name
}

const modelOptions = computed(() => {
  const options = props.state.models.map((model) => ({
    label: optionLabel(model),
    value: model.id,
    disabled: !model.enabled || !model.routable,
  }))
  return options
})

const defaultModelOptions = computed(() => [
  {
    label: `自动（${props.state.effectiveDefaultModel ?? '暂无可用模型'}）`,
    value: 0,
  },
  ...modelOptions.value,
])

const smallModelOptions = computed(() => [
  {
    label: `跟随默认模型（${props.state.effectiveSmallModel ?? '暂无可用模型'}）`,
    value: 0,
  },
  ...modelOptions.value,
])

function targetsOf(mode: 'all' | 'users', userIds: number[]): UpdateAgentModeRequest['targets'] {
  return mode === 'all' ? { all: true } : { userIds: [...userIds].sort((left, right) => left - right) }
}

function targetsEqual(
  left: NonNullable<UpdateAgentModeRequest['targets']>,
  right: AgentModeStateResponse['settings']['targets'],
): boolean {
  if ('all' in left && 'all' in right) return true
  if ('userIds' in left && 'userIds' in right) {
    const a = [...left.userIds].sort((x, y) => x - y)
    const b = [...right.userIds].sort((x, y) => x - y)
    return a.length === b.length && a.every((id, index) => id === b[index])
  }
  return false
}

/** 只发改过的字段（18 §4.3 的 PUT 全部可选） */
const patch = computed<UpdateAgentModeRequest>(() => {
  const settings = props.state.settings
  const body: UpdateAgentModeRequest = {}
  if (enabled.value !== settings.enabled) body.enabled = enabled.value
  if (ratePermille.value !== null && ratePermille.value !== settings.ratePermille) {
    body.ratePermille = ratePermille.value
  }
  if (defaultModelId.value !== settings.defaultModelId) body.defaultModelId = defaultModelId.value
  if (props.state.mode === 'claude-code' && smallModelId.value !== settings.smallModelId) {
    body.smallModelId = smallModelId.value
  }
  if (label.value.trim() !== settings.label) body.label = label.value.trim()
  const nextTargets = targetsOf(targetMode.value, targetUserIds.value)
  if (nextTargets && !targetsEqual(nextTargets, settings.targets)) body.targets = nextTargets
  return body
})

const dirty = computed(() => Object.keys(patch.value).length > 0)

async function save(): Promise<void> {
  if (ratePermille.value === null) {
    rateError.value = '填 0–100 的数字，最多 3 位小数'
    return
  }
  if (!label.value.trim()) {
    labelError.value = '显示名不能为空'
    return
  }
  labelError.value = ''
  if (!dirty.value) {
    message.info('没有改动')
    return
  }

  saving.value = true
  try {
    await updateAgentMode(props.state.mode, patch.value)
    message.success('已保存，模型和价格即时生效')
    emit('changed')
  } catch (cause) {
    const description = describeError(cause)
    if (description.fieldErrors['label']) labelError.value = description.fieldErrors['label']
    if (description.fieldErrors['ratePermille']) rateError.value = description.fieldErrors['ratePermille']
    message.error(description.message)
  } finally {
    saving.value = false
  }
}

// ── 下发 ────────────────────────────────────────────────────────────────────

const showDeliver = ref(false)
const submitting = ref(false)
const jobId = ref<number | null>(null)
let settledJobId: number | null = null

const { data: jobDetail } = useAsyncData(async () => (jobId.value === null ? null : getJob(jobId.value)), {
  pollMs: 2000,
})

const deliverJob = computed<JobSummary | null>(() => jobDetail.value?.job ?? null)

watch(deliverJob, (job) => {
  if (!job || isJobActive(job.status) || settledJobId === job.id) return
  settledJobId = job.id
  emit('changed')
  message.success(job.status === 'succeeded' ? '下发完成' : '下发任务已结束，点「任务详情」看结果')
})

function openDeliver(): void {
  showDeliver.value = true
}

async function confirmDeliver(payload: Required<DeliverAgentModeRequest>): Promise<void> {
  submitting.value = true
  try {
    const created = await sensitive(() => deliverAgentMode(props.state.mode, payload), {
      title: `确认下发 ${AGENT_MODE_LABEL[props.state.mode]} 配置`,
      description: `会处理 ${props.state.users.length} 位用户（${
        payload.restart === 'now' ? '立即重启' : '下次启动生效'
      }）。请输入密码确认。`,
      confirmText: '开始下发',
    })
    showDeliver.value = false
    settledJobId = null
    jobId.value = created.jobId
    message.success('下发任务已创建，正在执行')
    emit('changed')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    submitting.value = false
  }
}

// ── 最近一次下发 / 插件 ──────────────────────────────────────────────────────

const plugin = computed(() => props.state.plugin)
const pluginPage = '/admin/plugins'
</script>

<template>
  <div class="agent-deliver">
    <NAlert
      v-if="state.pending"
      type="warning"
      :bordered="false"
      class="agent-deliver__pending"
      data-testid="agent-mode-pending"
    >
      <div class="agent-deliver__pending-row">
        <span> 配置有改动，还没下发到用户（{{ state.pendingUsers }} 位用户需要处理）。 </span>
        <NButton
          size="small"
          type="warning"
          quaternary
          data-testid="agent-mode-pending-deliver"
          @click="openDeliver"
        >
          下发
        </NButton>
      </div>
    </NAlert>

    <SoftCard title="设置">
      <template #extra>
        <div class="agent-deliver__actions">
          <span v-if="state.lastDeliver" class="agent-deliver__last" data-testid="agent-mode-last-deliver">
            最近下发
            <MiniTag
              :text="JOB_STATUS_TEXT[state.lastDeliver?.status ?? 'queued'] ?? '—'"
              :tone="JOB_STATUS_TONE[state.lastDeliver?.status ?? 'queued'] ?? 'neutral'"
              size="sm"
            />
            <RouterLink class="agent-deliver__link" :to="`/admin/jobs/${state.lastDeliver?.jobId}`">
              #{{ state.lastDeliver?.jobId }}
            </RouterLink>
            <span class="agent-deliver__time">{{ formatDateTime(state.lastDeliver?.createdAt) }}</span>
          </span>
          <NButton
            size="small"
            :type="state.pending ? 'primary' : 'default'"
            data-testid="agent-mode-deliver"
            @click="openDeliver"
          >
            {{ state.pending ? `下发（${state.pendingUsers}）` : '重新下发' }}
          </NButton>
        </div>
      </template>

      <NForm label-placement="top" size="small" class="agent-deliver__form">
        <NFormItem label="开通">
          <div class="agent-deliver__switch">
            <NSwitch v-model:value="enabled" data-testid="agent-mode-enabled" />
            <span class="agent-deliver__switch-text">{{ enabled ? '已开通' : '未开通' }}</span>
          </div>
        </NFormItem>

        <NFormItem>
          <template #label>整体倍率</template>
          <NInput
            v-model:value="rateText"
            class="agent-deliver__rate"
            data-testid="agent-mode-rate"
            :status="rateError ? 'error' : undefined"
          >
            <template #prefix>×</template>
          </NInput>
          <span v-if="rateError" class="agent-deliver__error" role="alert">{{ rateError }}</span>
        </NFormItem>

        <NFormItem label="默认模型">
          <NSelect
            :value="defaultModelId ?? 0"
            :options="defaultModelOptions"
            data-testid="agent-mode-default-model"
            @update:value="(value: number) => (defaultModelId = value === 0 ? null : value)"
          />
        </NFormItem>

        <NFormItem v-if="state.mode === 'claude-code'" label="小模型（后台任务）">
          <NSelect
            :value="smallModelId ?? 0"
            :options="smallModelOptions"
            data-testid="agent-mode-small-model"
            @update:value="(value: number) => (smallModelId = value === 0 ? null : value)"
          />
        </NFormItem>

        <NFormItem>
          <template #label>显示名</template>
          <NInput
            v-model:value="label"
            maxlength="32"
            placeholder="DSH Hub"
            data-testid="agent-mode-label"
            :status="labelError ? 'error' : undefined"
            @update:value="labelError = ''"
          />
          <span v-if="labelError" class="agent-deliver__error" role="alert">{{ labelError }}</span>
        </NFormItem>

        <NFormItem label="开放给" class="agent-deliver__targets">
          <div class="agent-deliver__targets-body">
            <NRadioGroup v-model:value="targetMode" data-testid="agent-mode-targets">
              <NRadio value="all">所有用户</NRadio>
              <NRadio value="users">指定用户</NRadio>
            </NRadioGroup>
            <AgentModeUserPicker v-if="targetMode === 'users'" v-model="targetUserIds" />
          </div>
        </NFormItem>
      </NForm>

      <div class="agent-deliver__footer">
        <span v-if="dirty" class="agent-deliver__dirty" data-testid="agent-mode-dirty">有还没保存的改动</span>
        <span v-else class="agent-deliver__saved">已保存</span>
        <NButton
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!dirty"
          data-testid="agent-mode-save"
          @click="save"
        >
          保存
        </NButton>
      </div>
    </SoftCard>

    <SoftCard title="插件">
      <div v-if="plugin" class="agent-deliver__plugin" data-testid="agent-mode-plugin">
        <div class="agent-deliver__plugin-row">
          <span class="agent-deliver__plugin-name">{{ plugin.packageName }}</span>
          <MiniTag :text="`v${plugin.latestVersion ?? '—'}`" tone="sky" size="sm" />
          <MiniTag :text="pluginPolicyText(plugin.policy)" tone="neutral" size="sm" />
        </div>
        <span class="agent-deliver__plugin-count">已装 {{ plugin.installedUsers }} 人</span>
      </div>
      <div v-else class="agent-deliver__plugin-empty" data-testid="agent-mode-plugin-empty">
        <span>插件库里还没有这个插件</span>
        <span class="agent-deliver__plugin-name">{{ AGENT_MODE_PLUGIN_PACKAGE[state.mode] }}</span>
        <RouterLink :to="pluginPage">
          <NButton size="small" data-testid="agent-mode-goto-plugins">去插件页上传</NButton>
        </RouterLink>
      </div>
    </SoftCard>

    <SoftCard title="用户">
      <AgentModeUserTable :users="state.users" :loading="loading" />
    </SoftCard>

    <SoftCard v-if="jobId !== null" title="下发进度">
      <div class="agent-deliver__job" data-testid="agent-mode-job">
        <div class="agent-deliver__job-head">
          <span class="agent-deliver__job-title">
            任务 #{{ jobId }}
            <template v-if="deliverJob"> · {{ jobTypeText(deliverJob.type) }}</template>
          </span>
          <MiniTag
            v-if="deliverJob"
            :text="JOB_STATUS_TEXT[deliverJob.status] ?? deliverJob.status"
            :tone="JOB_STATUS_TONE[deliverJob.status] ?? 'neutral'"
            size="sm"
          />
          <RouterLink
            class="agent-deliver__link"
            :to="`/admin/jobs/${jobId}`"
            data-testid="agent-mode-job-link"
          >
            任务详情
          </RouterLink>
        </div>
        <JobProgress
          v-if="deliverJob"
          :total="deliverJob.total"
          :done="deliverJob.done"
          :failed="deliverJob.failed"
          size="sm"
        />
      </div>
    </SoftCard>

    <AgentModeDeliverDialog
      v-model:show="showDeliver"
      :users="state.users.length"
      :submitting="submitting"
      @confirm="confirmDeliver"
    />
  </div>
</template>

<style scoped>
.agent-deliver {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.agent-deliver__pending {
  border-radius: var(--radius-control);
}

.agent-deliver__pending-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.agent-deliver__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.agent-deliver__last {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-deliver__link {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.agent-deliver__time {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-deliver__form {
  display: grid;
  gap: 0 var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.agent-deliver__switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.agent-deliver__switch-text {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.agent-deliver__rate {
  max-width: 150px;
}

.agent-deliver__error {
  margin-top: 2px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.agent-deliver__targets {
  grid-column: 1 / -1;
}

.agent-deliver__targets-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.agent-deliver__targets-body > :last-child {
  min-width: 260px;
  flex: 1;
}

.agent-deliver__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.agent-deliver__dirty {
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-deliver__saved {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-deliver__plugin {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.agent-deliver__plugin-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.agent-deliver__plugin-name {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.agent-deliver__plugin-count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-deliver__plugin-empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.agent-deliver__job {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.agent-deliver__job-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.agent-deliver__job-title {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}
</style>
