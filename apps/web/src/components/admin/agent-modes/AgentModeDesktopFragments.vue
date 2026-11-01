<script setup lang="ts">
import type { DesktopConfigFragmentInput, RelayAgentMode } from '@dsh-hub/shared'
import { AGENT_MODE_LABEL } from '@dsh-hub/shared'
import { NAlert, NButton, NRadio, NRadioGroup, NSwitch, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { getDesktopDelivery } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import DesktopTargetField from '@/components/admin/desktop/DesktopTargetField.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useDesktopFragments, FragmentValidationError, type FragmentRow } from '@/composables/desktop-fragments'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled } from '@/composables/useReauth'
import {
  DEFAULT_TARGET,
  scopeText,
  targetOfDraft,
  validateConfigRequest,
  type FragmentMode,
  type TargetDraft,
} from '@/utils/desktop-delivery'

/**
 * Claude Code / Codex · 桌面侧（docs/22 §1.3 §3）：只编辑对应 pilot 的 `hubMode` 片段。
 *
 * `PUT /api/admin/desktop/config` 是整体替换，所以这里用 `useDesktopFragments` 的
 * 「按条目 + 键接管」：只改 `claude-pilot` / `codex-pilot` 的 `hubMode`，同一个条目里的其它键、
 * 别的条目（模型 / 代理 / DSH 版本）都在合并时原样保留。
 */
const props = defineProps<{ mode: RelayAgentMode }>()

const message = useMessage()

const entryId = computed(() => (props.mode === 'claude-code' ? 'claude-pilot' : 'codex-pilot'))

const { data: delivery, loading, error, reload } = useAsyncData(() => getDesktopDelivery())

const target = ref<TargetDraft>({ ...DEFAULT_TARGET })
const resolvedTarget = computed(() => targetOfDraft(target.value))
const selection = computed(() => ({
  entryIds: [entryId.value],
  keys: { [entryId.value]: ['hubMode'] },
}))

const fragments = useDesktopFragments({
  state: delivery,
  target: resolvedTarget,
  selection: selection.value,
})

const managedRow = computed(() => fragments.managed.value.find((row) => row.entryId === entryId.value) ?? null)

const fragmentMode = ref<FragmentMode>('enforce')
const hubMode = ref(true)
const errors = ref<string[]>([])
const serverError = ref('')

// 目标切换 / 数据刷新：草稿从该目标已有的片段重建（整体替换语义的前提）
watch(
  managedRow,
  (row) => {
    fragmentMode.value = row?.mode ?? 'enforce'
    hubMode.value = row ? row.config['hubMode'] !== false : true
    errors.value = []
    serverError.value = ''
  },
  { immediate: true },
)

const modeOptions: { label: string; value: FragmentMode }[] = [
  { label: '强制', value: 'enforce' },
  { label: '默认', value: 'default' },
]

const nextRow = computed<FragmentRow>(() => ({
  entryId: entryId.value,
  mode: fragmentMode.value,
  config: { hubMode: hubMode.value },
}))

const mergedPreview = computed(() => JSON.stringify(fragments.buildMerged([nextRow.value]), null, 2))

const scopeLabel = computed(() =>
  scopeText(
    resolvedTarget.value?.scope === 'role'
      ? { scope: 'role', role: resolvedTarget.value.role, userId: null }
      : resolvedTarget.value?.scope === 'user'
        ? { scope: 'user', role: null, userId: resolvedTarget.value.userId }
        : { scope: 'all', role: null, userId: null },
  ),
)

async function save(): Promise<void> {
  errors.value = []
  serverError.value = ''
  if (!resolvedTarget.value) {
    errors.value = ['指定用户时先选一个用户']
    return
  }
  const contractError = validateConfigRequest(resolvedTarget.value, [
    { id: entryId.value, mode: fragmentMode.value, config: nextRow.value.config } as DesktopConfigFragmentInput,
  ])
  if (contractError) {
    errors.value = [contractError]
    return
  }
  try {
    const result = await fragments.save([nextRow.value], {
      title: `下发 ${AGENT_MODE_LABEL[props.mode]} 配置片段`,
      description: `会更新「${scopeLabel.value}」的 ${entryId.value} 片段（只改 hubMode），并生成新 revision。`,
    })
    message.success(`已下发，新 revision r${String(result.revision)}`)
  } catch (cause) {
    if (cause instanceof FragmentValidationError) {
      errors.value = cause.errors
    } else if (!isReauthCanceled(cause)) {
      serverError.value = describeError(cause).message
    }
  }
}
</script>

<template>
  <div class="agent-fragment" data-testid="agent-mode-desktop">
    <SoftCard :title="`${AGENT_MODE_LABEL[mode]} · 桌面配置片段`">
      <template #title-extra>
        <MiniTag :text="entryId" tone="neutral" size="sm" />
        <InfoTip
          label="Hub 模式说明"
          text="Hub 模式让桌面端的 Claude Code / Codex 走 Hub 中转站（用 Hub 模型、计入积分）；关闭后用它自己的账号。这里只改 hubMode，同一个条目里的其它键保持不变。"
        />
      </template>
      <template #extra>
        <NButton size="tiny" quaternary :loading="loading" data-testid="agent-fragment-refresh" @click="reload">
          刷新
        </NButton>
      </template>

      <div class="agent-fragment__target">
        <span class="agent-fragment__label">目标</span>
        <DesktopTargetField v-model="target" />
        <span class="agent-fragment__spacer" />
        <NButton
          size="small"
          type="primary"
          :loading="fragments.saving.value"
          data-testid="agent-fragment-save"
          @click="save"
        >
          <template #icon><span class="i-ph-paper-plane-tilt" aria-hidden="true" /></template>
          保存并下发
        </NButton>
      </div>

      <ul v-if="errors.length > 0" class="agent-fragment__errors" role="alert" data-testid="agent-fragment-errors">
        <li v-for="item in errors" :key="item">{{ item }}</li>
      </ul>
      <NAlert v-if="serverError" type="error" :bordered="false" data-testid="agent-fragment-server-error">
        {{ serverError }}
      </NAlert>
      <NAlert
        v-if="error"
        type="error"
        :bordered="false"
        data-testid="agent-fragment-load-error"
      >
        {{ error.message }}
        <NButton size="tiny" quaternary @click="reload">重试</NButton>
      </NAlert>
    </SoftCard>

    <SoftCard title="Hub 模式">
      <div class="agent-fragment__body">
        <NRadioGroup v-model:value="fragmentMode" size="small" data-testid="agent-fragment-mode">
          <NRadio v-for="option in modeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </NRadio>
        </NRadioGroup>
        <label class="agent-fragment__switch">
          <NSwitch v-model:value="hubMode" size="small" data-testid="agent-fragment-hubmode" />
          <span>走 Hub 中转站</span>
        </label>
        <MiniTag
          :text="managedRow ? '已配置' : '尚未配置'"
          :tone="managedRow ? 'success' : 'neutral'"
          size="sm"
        />
        <span class="agent-fragment__spacer" />
        <span class="agent-fragment__scope" data-testid="agent-fragment-scope">{{ scopeLabel }}</span>
      </div>
    </SoftCard>

    <SoftCard title="合并后的片段" :padded="false">
      <pre class="agent-fragment__preview" data-testid="agent-fragment-preview">{{ mergedPreview }}</pre>
    </SoftCard>
  </div>
</template>

<style scoped>
.agent-fragment {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.agent-fragment__target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.agent-fragment__label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-fragment__spacer {
  flex: 1;
}

.agent-fragment__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.agent-fragment__switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.agent-fragment__scope {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.agent-fragment__errors {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.agent-fragment__preview {
  max-height: 280px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: pre;
}
</style>
