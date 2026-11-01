<script setup lang="ts">
import type { DesktopDeliveryState, DesktopDeliveryTarget } from '@dsh-hub/shared'
import { NAlert, NButton, NInput, NInputNumber, NRadio, NRadioGroup, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'

import { describeError } from '@/api/errors'
import { isReauthCanceled } from '@/composables/useReauth'
import DesktopTargetField from '@/components/admin/desktop/DesktopTargetField.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { FragmentValidationError, useDesktopFragments, type FragmentRow } from '@/composables/desktop-fragments'
import {
  RESIDUAL_ENTRIES,
  RESIDUAL_ENTRY_IDS,
  RESIDUAL_SELECTION_KEYS,
  residualDraftOf,
  residualRowsOf,
  type ResidualDraft,
} from '@/utils/desktop-residual-fragments'
import {
  DEFAULT_TARGET,
  scopeText,
  targetOfDraft,
  type FragmentMode,
  type TargetDraft,
} from '@/utils/desktop-delivery'

/**
 * DSH 版本 · 桌面侧的「其它配置片段」（docs/22 §1.3）。
 *
 * 桌面白名单里没被模型 / 代理 / 桥接三页接管的键收在这张卡：两个 pilot 的权限、沙箱、默认模型、
 * 任务预设、输出上限等。**同一个条目由多个页面写**，所以读写都走 `useDesktopFragments()`：
 * 只改本卡接管的键，`hubMode` 与别的条目原样保留（接口本身是整体替换）。
 */
const props = defineProps<{ state: DesktopDeliveryState | null }>()
const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const target = ref<TargetDraft>({ ...DEFAULT_TARGET })
const resolvedTarget = computed<DesktopDeliveryTarget | null>(() => targetOfDraft(target.value))

const fragments = useDesktopFragments({
  state: computed(() => props.state),
  target: resolvedTarget,
  selection: { entryIds: RESIDUAL_ENTRY_IDS, keys: RESIDUAL_SELECTION_KEYS },
})

const saving = fragments.saving

/** 每个条目的草稿（换目标 / 数据刷新时从该目标已有的片段重建） */
const drafts = reactive<Record<string, ResidualDraft>>({})
const errors = ref<string[]>([])
const serverError = ref('')

const MODE_OPTIONS: { label: string; value: FragmentMode }[] = [
  { label: '强制', value: 'enforce' },
  { label: '默认', value: 'default' },
]

function rebuild(): void {
  const existing = fragments.existing.value
  for (const entry of RESIDUAL_ENTRIES) {
    const row = existing.find((item) => item.entryId === entry.entryId)
    drafts[entry.entryId] = residualDraftOf(
      entry,
      fragments.configOf(entry.entryId),
      row?.mode ?? 'enforce',
    )
  }
  errors.value = []
  serverError.value = ''
}

watch([() => props.state, target], rebuild, { deep: true, immediate: true })

/** 模板里取草稿（缺省补一份空草稿，避免模板里到处判空） */
function draftOf(entryId: string): ResidualDraft {
  const draft = drafts[entryId]
  if (draft) return draft
  const entry = RESIDUAL_ENTRIES.find((item) => item.entryId === entryId) ?? RESIDUAL_ENTRIES[0]
  const fresh = residualDraftOf(entry ?? RESIDUAL_ENTRIES[0]!, {})
  drafts[entryId] = fresh
  return fresh
}

/** 这次要写的行（预览与保存共用） */
const built = computed(() => residualRowsOf(drafts, Object.fromEntries(RESIDUAL_ENTRIES.map((entry) => [entry.entryId, drafts[entry.entryId]?.mode ?? 'enforce']))))
const previewText = computed(() => JSON.stringify(fragments.buildMerged(built.value.rows), null, 2))
const showPreview = ref(false)

async function save(): Promise<void> {
  errors.value = []
  serverError.value = ''
  if (!resolvedTarget.value) {
    errors.value = ['指定用户时先选一个用户']
    return
  }
  if (built.value.errors.length > 0) {
    errors.value = built.value.errors
    return
  }
  try {
    const result = await fragments.save(built.value.rows as FragmentRow[], {
      title: '下发配置片段',
      description: `会整体替换「${scopeText(
        resolvedTarget.value.scope === 'all'
          ? { scope: 'all', role: null, userId: null }
          : resolvedTarget.value.scope === 'role'
            ? { scope: 'role', role: resolvedTarget.value.role, userId: null }
            : { scope: 'user', role: null, userId: resolvedTarget.value.userId },
      )}」里这些条目的片段，并生成新 revision（其它页面写的键不受影响）。`,
    })
    message.success(`已下发，新 revision r${String(result.revision)}`)
    emit('changed')
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    if (cause instanceof FragmentValidationError) {
      errors.value = cause.errors
      return
    }
    serverError.value = describeError(cause).message
  }
}
</script>

<template>
  <div class="residual">
    <SoftCard title="其它配置片段">
    <template #title-extra>
      <InfoTip
        text="两个对话模式的其它键（权限、沙箱、默认模型、任务预设、输出上限）。模型、代理、桥接开关在各自的页面维护，这里不会覆盖它们。"
      />
    </template>

    <div class="residual__target">
      <span class="residual__label">目标</span>
      <DesktopTargetField v-model="target" />
      <span class="residual__spacer" />
      <NButton size="small" type="primary" :loading="saving" data-testid="residual-save" @click="save">
        <template #icon><span class="i-ph-paper-plane-tilt" aria-hidden="true" /></template>
        保存并下发
      </NButton>
    </div>

    <ul v-if="errors.length > 0" class="residual__errors" role="alert" data-testid="residual-errors">
      <li v-for="error in errors" :key="error">{{ error }}</li>
    </ul>
      <NAlert v-if="serverError" type="error" :bordered="false" data-testid="residual-server-error">
        {{ serverError }}
      </NAlert>
    </SoftCard>

    <SoftCard
      v-for="entry in RESIDUAL_ENTRIES"
      :key="entry.entryId"
      :data-testid="`residual-${entry.entryId}`"
    >
    <template #header>
      <h3 class="residual__title">{{ entry.title }}</h3>
      <span class="residual__entry">{{ entry.entryId }}</span>
    </template>
    <template #extra>
      <NSwitch
        v-model:value="draftOf(entry.entryId).enabled"
        size="small"
        :data-testid="`residual-${entry.entryId}-enabled`"
      />
    </template>

    <div v-if="draftOf(entry.entryId).enabled" class="residual__body">
      <NRadioGroup
        v-model:value="draftOf(entry.entryId).mode"
        size="small"
        :data-testid="`residual-${entry.entryId}-mode`"
      >
        <NRadio v-for="option in MODE_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </NRadio>
      </NRadioGroup>

      <div class="residual__grid">
        <label v-for="field in entry.fields" :key="field.key" class="residual__field">
          <span class="residual__field-label">{{ field.label }}</span>
          <NSwitch
            v-if="field.kind === 'switch'"
            v-model:value="draftOf(entry.entryId).values[field.key] as boolean"
            size="small"
            :data-testid="`residual-${entry.entryId}-${field.key}`"
          />
          <NSelect
            v-else-if="field.kind === 'select'"
            v-model:value="draftOf(entry.entryId).values[field.key] as string"
            size="small"
            clearable
            :options="field.options ?? []"
            :placeholder="field.placeholder ?? '未设置'"
            :data-testid="`residual-${entry.entryId}-${field.key}`"
          />
          <NInputNumber
            v-else-if="field.kind === 'number'"
            :value="draftOf(entry.entryId).values[field.key] === '' ? null : Number(draftOf(entry.entryId).values[field.key])"
            size="small"
            :min="1000"
            :max="1000000"
            :show-button="false"
            :placeholder="field.placeholder"
            :data-testid="`residual-${entry.entryId}-${field.key}`"
            @update:value="(value: number | null) => (draftOf(entry.entryId).values[field.key] = value === null ? '' : String(value))"
          />
          <NInput
            v-else
            v-model:value="draftOf(entry.entryId).values[field.key] as string"
            size="small"
            :placeholder="field.placeholder"
            :data-testid="`residual-${entry.entryId}-${field.key}`"
          />
        </label>
      </div>
    </div>
    <p v-else class="residual__empty" :data-testid="`residual-${entry.entryId}-empty`">未配置</p>
    </SoftCard>

    <SoftCard>
      <template #header>
        <h3 class="residual__title">将下发的片段</h3>
        <span class="residual__entry">{{ built.rows.length }} 条</span>
      </template>
      <template #extra>
        <NButton size="tiny" quaternary data-testid="residual-preview-toggle" @click="showPreview = !showPreview">
          {{ showPreview ? '收起' : '预览' }}
        </NButton>
      </template>
      <pre v-if="showPreview" class="residual__preview" data-testid="residual-preview">{{ previewText }}</pre>
    </SoftCard>
  </div>
</template>

<style scoped>
.residual {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.residual__target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.residual__label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.residual__spacer {
  flex: 1;
}

.residual__title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.residual__entry {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.residual__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.residual__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}

.residual__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.residual__field-label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.residual__empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.residual__errors {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.residual__preview {
  max-height: 320px;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: pre;
}
</style>
