<script setup lang="ts">
import type { AdminRuntimeRow, DeliveryPlatform, ModelPreset } from '@dsh-hub/shared'
import { DELIVERY_MAX_ITEMS } from '@dsh-hub/shared'
import { NCheckbox, NSelect, useMessage } from 'naive-ui'
import { computed, watch } from 'vue'

import DeliveryPluginPicker from '@/components/admin/delivery/DeliveryPluginPicker.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  runtimeAvailable,
  type DeliveryDraft,
  type DeliveryItemDraft,
  type DeliveryPluginView,
} from '@/composables/delivery-draft'

/**
 * 向导第 1 步：**平台与内容**（docs/21 §1 ①）。
 *
 * - 平台：实例 / 桌面端两个复选，至少一个；
 * - 内容三类：插件（可多选，每个带版本下拉）、模型与 API 配置、DSH 版本（只在选了实例时可用）。
 *
 * 草稿由页面持有：这里只发 `update:draft`（不在子组件里改 prop）。
 * 说明都收在 InfoTip 里（07 §2.7），页面上不留常驻小字。
 */
const props = defineProps<{
  draft: DeliveryDraft
  /** 两个平台库合并后的视图（docs/22 §2；每个插件带 cloud / desktop 两套版本） */
  plugins: DeliveryPluginView[]
  runtimes: AdminRuntimeRow[]
  presets: ModelPreset[]
  artifactVersionIds: Set<number>
}>()

const emit = defineEmits<{ 'update:draft': [DeliveryDraft] }>()

const message = useMessage()

const platformOptions: { label: string; value: DeliveryPlatform }[] = [
  { label: '实例', value: 'instance' },
  { label: '桌面端', value: 'desktop' },
]

const instanceReady = computed(() => runtimeAvailable(props.draft.platforms))

const items = computed<DeliveryItemDraft[]>({
  get: () => props.draft.items,
  set: (value) => emit('update:draft', { ...props.draft, items: value }),
})

function patch(partial: Partial<DeliveryDraft>): void {
  emit('update:draft', { ...props.draft, ...partial })
}

function togglePlatform(platform: DeliveryPlatform, checked: boolean): void {
  const has = props.draft.platforms.includes(platform)
  if (checked === has) return
  if (!checked && props.draft.platforms.length === 1) {
    // 至少留一个平台：取消最后一个时不动（提示一下就好）
    message.warning('至少要选一个平台')
    return
  }
  const platforms = checked
    ? [...props.draft.platforms, platform]
    : props.draft.platforms.filter((item) => item !== platform)
  patch({
    platforms,
    // DSH 版本只对实例有效：没选实例时把它拿掉，否则用户没有入口取消它
    items: runtimeAvailable(platforms)
      ? props.draft.items
      : props.draft.items.filter((item) => item.kind !== 'runtime'),
  })
}

const pluginItems = computed(() => props.draft.items.filter((item) => item.kind === 'plugin'))
const modelsItem = computed(() => props.draft.items.find((item) => item.kind === 'models') ?? null)
const runtimeItem = computed(() => props.draft.items.find((item) => item.kind === 'runtime') ?? null)

const itemCount = computed(() => props.draft.items.length)
const atCapacity = computed(() => itemCount.value >= DELIVERY_MAX_ITEMS)

function toggleModels(checked: boolean): void {
  if (checked) {
    if (atCapacity.value) {
      message.warning(`一次最多 ${String(DELIVERY_MAX_ITEMS)} 个内容项`)
      return
    }
    items.value = [
      ...props.draft.items.filter((item) => item.kind !== 'models'),
      { kind: 'models', presetId: null },
    ]
    return
  }
  items.value = props.draft.items.filter((item) => item.kind !== 'models')
}

const selectedPreset = computed<number>(() => modelsItem.value?.presetId ?? 0)

function setPreset(value: number): void {
  const presetId = value === 0 ? null : value
  items.value = props.draft.items.map((item) => (item.kind === 'models' ? { ...item, presetId } : item))
}

/**
 * docs/22 §3：预设也按平台分（每个平台一个默认预设）。两个平台同时选时没有「一个预设喂两边」
 * 的语义（契约只有一个 `presetId`），所以只提供「系统预设」——各平台用自己的默认预设。
 */
const presetOptions = computed(() => {
  if (props.draft.platforms.length !== 1) {
    return [{ label: '系统预设（默认）', value: 0 }]
  }
  const target = props.draft.platforms[0] === 'desktop' ? 'desktop' : 'cloud'
  return [
    { label: '系统预设（默认）', value: 0 },
    ...props.presets
      .filter((preset) => preset.platform === target)
      .map((preset) => ({
        label: `${preset.name} · ${preset.defaultProvider}/${preset.defaultModel}`,
        value: preset.id,
      })),
  ]
})

// 切平台后原来选的预设可能不属于新平台：收敛回系统预设（否则提交会发一个跨平台的 presetId）
watch(
  () => props.draft.platforms.join(','),
  () => {
    const current = modelsItem.value?.presetId ?? null
    if (current === null) return
    if (presetOptions.value.some((option) => option.value === current)) return
    items.value = props.draft.items.map((item) =>
      item.kind === 'models' ? { ...item, presetId: null } : item,
    )
  },
  { immediate: true },
)

function setRuntime(runtimeId: number | null): void {
  if (runtimeId === null) {
    items.value = props.draft.items.filter((item) => item.kind !== 'runtime')
    return
  }
  if (runtimeItem.value) {
    items.value = props.draft.items.map((item) => (item.kind === 'runtime' ? { ...item, runtimeId } : item))
    return
  }
  if (atCapacity.value) {
    message.warning(`一次最多 ${String(DELIVERY_MAX_ITEMS)} 个内容项`)
    return
  }
  items.value = [...props.draft.items, { kind: 'runtime', runtimeId }]
}

const readyRuntimes = computed(() =>
  props.runtimes
    .filter((runtime) => runtime.status === 'ready')
    .map((runtime) => ({
      label: `${runtime.dshVersion}${runtime.isDefault ? '（默认）' : ''} · ${String(runtime.usersOnIt)} 人在用`,
      value: runtime.id,
    })),
)

const runtimeLabel = computed(() => {
  const row = props.runtimes.find((runtime) => runtime.id === runtimeItem.value?.runtimeId)
  return row ? `DSH ${row.dshVersion}` : 'DSH 版本'
})
</script>

<template>
  <SoftCard title="平台">
    <template #title-extra>
      <InfoTip
        label="平台说明"
        text="同一个内容可以同时下发给实例与桌面端；插件要两边都有包才都能装（桌面端缺整包会在预览里标出来）。"
      />
    </template>
    <div class="items__platforms">
      <NCheckbox
        v-for="option in platformOptions"
        :key="option.value"
        :checked="props.draft.platforms.includes(option.value)"
        :data-testid="`delivery-platform-${option.value}`"
        @update:checked="(checked: boolean) => togglePlatform(option.value, checked)"
      >
        {{ option.label }}
      </NCheckbox>
      <MiniTag :text="`${props.draft.platforms.length} 个平台`" tone="sky" size="sm" />
    </div>
  </SoftCard>

  <SoftCard title="插件">
    <template #extra>
      <span class="items__count">{{ pluginItems.length }} / {{ DELIVERY_MAX_ITEMS }}</span>
    </template>
    <DeliveryPluginPicker
      :items="props.draft.items"
      :plugins="props.plugins"
      :platforms="props.draft.platforms"
      :artifact-version-ids="props.artifactVersionIds"
      :action="props.draft.action"
      @update:items="(value: DeliveryItemDraft[]) => (items = value)"
    />
  </SoftCard>

  <SoftCard title="模型与 API 配置">
    <template #title-extra>
      <InfoTip
        label="模型与 API 配置说明"
        text="默认使用「模型 → 模型配置」中保存的模型与默认模型，也可以选择指定预设。"
      />
    </template>
    <div class="items__row">
      <NCheckbox
        :checked="modelsItem !== null"
        data-testid="delivery-models-toggle"
        @update:checked="toggleModels"
      >
        加入这次下发
      </NCheckbox>
      <NSelect
        v-if="modelsItem"
        class="items__preset"
        size="small"
        :value="selectedPreset"
        :options="presetOptions"
        data-testid="delivery-models-preset"
        @update:value="(value: number) => setPreset(value)"
      />
    </div>
  </SoftCard>

  <SoftCard title="DSH 版本">
    <template #title-extra>
      <InfoTip
        v-if="!instanceReady"
        label="DSH 版本说明"
        text="DSH 版本只能下发给实例；桌面端的版本在「桌面端 → 版本与升级」里管。"
      />
      <InfoTip
        v-else
        label="DSH 版本说明"
        text="升级会重建容器（换新镜像）并重新安装依赖，失败自动回滚到旧镜像。"
      />
    </template>
    <div class="items__row">
      <NSelect
        class="items__runtime"
        size="small"
        clearable
        :value="runtimeItem?.runtimeId ?? null"
        :options="readyRuntimes"
        :disabled="!instanceReady"
        placeholder="不升级 DSH 版本"
        data-testid="delivery-runtime-select"
        @update:value="(value: number | null) => setRuntime(value)"
      />
      <MiniTag v-if="runtimeItem" :text="runtimeLabel" tone="primary" size="sm" />
    </div>
  </SoftCard>
</template>

<style scoped>
.items__platforms {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
}

.items__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.items__preset {
  width: 320px;
  max-width: 100%;
}

.items__runtime {
  width: 320px;
  max-width: 100%;
}

.items__count {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}
</style>
