<script setup lang="ts">
import type { AdminRuntimeRow, DeliveryAction } from '@dsh-hub/shared'
import { DELIVERY_MAX_ITEMS } from '@dsh-hub/shared'
import { NSelect } from 'naive-ui'
import { computed } from 'vue'

import DeliveryPluginPicker from '@/components/admin/delivery/DeliveryPluginPicker.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  chooseFlowAction,
  DELIVERY_ACTION_TEXT,
  type DeliveryDraft,
  type DeliveryItemDraft,
  type DeliveryPluginView,
  type FlowContent,
} from '@/composables/delivery-draft'

/**
 * 下发流程（WP57）第 3 步「配置」里插件与 DSH 版本两类（模型配置直接嵌 `RelayDshTab`，在页面里）。
 *
 * - 插件：先选动作（安装 / 升级 / 卸载，三选一的大分段），再挑插件与版本 —— 只列**当前端**插件库里的插件、
 *   只给当前端的版本下拉；
 * - DSH 版本：只有「升级到哪个版本」一个问题。
 */
const props = defineProps<{
  draft: DeliveryDraft
  content: FlowContent
  plugins: DeliveryPluginView[]
  runtimes: AdminRuntimeRow[]
  artifactVersionIds: Set<number>
}>()

const emit = defineEmits<{ 'update:draft': [DeliveryDraft] }>()

const PLUGIN_ACTIONS: { value: DeliveryAction; icon: string }[] = [
  { value: 'install', icon: 'i-ph-download-simple' },
  { value: 'upgrade', icon: 'i-ph-arrow-circle-up' },
  { value: 'uninstall', icon: 'i-ph-trash' },
]

function setAction(action: DeliveryAction): void {
  emit('update:draft', chooseFlowAction(props.draft, action))
}

function setItems(items: DeliveryItemDraft[]): void {
  emit('update:draft', { ...props.draft, items })
}

const pluginCount = computed(() => props.draft.items.filter((item) => item.kind === 'plugin').length)

const runtimeId = computed<number | null>(() => {
  const item = props.draft.items.find((entry) => entry.kind === 'runtime')
  return item?.kind === 'runtime' ? item.runtimeId : null
})

function setRuntime(value: number | null): void {
  setItems([{ kind: 'runtime', runtimeId: value }])
}

const runtimeOptions = computed(() =>
  props.runtimes
    .filter((runtime) => runtime.status === 'ready')
    .map((runtime) => ({
      label: `${runtime.dshVersion}${runtime.isDefault ? '（默认）' : ''} · ${String(runtime.usersOnIt)} 人在用`,
      value: runtime.id,
    })),
)
</script>

<template>
  <template v-if="content === 'plugin'">
    <SoftCard title="动作">
      <div class="flow-config__actions" role="radiogroup" aria-label="插件动作" data-testid="flow-plugin-action">
        <button
          v-for="option in PLUGIN_ACTIONS"
          :key="option.value"
          type="button"
          role="radio"
          class="flow-config__action"
          :class="{ 'flow-config__action--active': draft.action === option.value }"
          :aria-checked="draft.action === option.value"
          :data-testid="`flow-action-${option.value}`"
          @click="setAction(option.value)"
        >
          <span :class="option.icon" aria-hidden="true" />
          {{ DELIVERY_ACTION_TEXT[option.value] }}
        </button>
      </div>
    </SoftCard>

    <SoftCard title="插件">
      <template #extra>
        <span class="flow-config__count">{{ pluginCount }} / {{ DELIVERY_MAX_ITEMS }}</span>
      </template>
      <DeliveryPluginPicker
        :items="draft.items"
        :plugins="plugins"
        :platforms="draft.platforms"
        :artifact-version-ids="artifactVersionIds"
        :action="draft.action"
        :max="DELIVERY_MAX_ITEMS"
        @update:items="setItems"
      />
    </SoftCard>
  </template>

  <SoftCard v-else-if="content === 'runtime'" title="升级到">
    <NSelect
      :value="runtimeId"
      :options="runtimeOptions"
      placeholder="选一个已就绪的 DSH 版本"
      class="flow-config__runtime"
      data-testid="flow-runtime"
      @update:value="setRuntime"
    />
  </SoftCard>
</template>

<style scoped>
.flow-config__actions {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(96px, auto));
  gap: var(--space-2);
}

.flow-config__action {
  display: inline-flex;
  height: 40px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 var(--space-4);
  border: 1.5px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  color: var(--c-text-2);
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-14);
  white-space: nowrap;
  transition:
    border-color var(--duration-base) var(--ease-out-soft),
    background-color var(--duration-base) var(--ease-out-soft),
    color var(--duration-base) var(--ease-out-soft);
}

.flow-config__action:hover:not(.flow-config__action--active) {
  color: var(--c-text);
  border-color: color-mix(in srgb, var(--plat, var(--c-primary)) 40%, var(--c-border));
}

.flow-config__action--active {
  border-color: var(--plat, var(--c-primary));
  background: var(--plat-soft, var(--c-primary-soft));
  color: var(--plat-ink, var(--c-primary-press));
  font-weight: var(--fw-semibold);
}

.flow-config__action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--plat, var(--c-primary)) 28%, transparent);
}

.flow-config__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.flow-config__runtime {
  width: 420px;
  max-width: 100%;
}

@media (max-width: 480px) {
  .flow-config__actions {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
