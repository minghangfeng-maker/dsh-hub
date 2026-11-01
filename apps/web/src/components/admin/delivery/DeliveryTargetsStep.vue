<script setup lang="ts">
import type {
  AdminRuntimeRow,
  DeliveryAction,
  ModelPreset,
  PluginInstallStat,
  UserAdminView,
} from '@dsh-hub/shared'
import { NCollapse, NCollapseItem, NRadio, NRadioGroup, NSelect, NSwitch } from 'naive-ui'
import { computed, ref } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  actionAvailability,
  actionDisabledReason,
  DELIVERY_ACTION_TEXT,
  installCountText,
  installOutdatedText,
  itemKinds,
  itemLabel,
  type DeliveryDraft,
  type DeliveryFilter,
  type DeliveryItemDraft,
  type DeliveryPluginView,
  type DeliveryTargetMode,
} from '@/composables/delivery-draft'

/**
 * 向导第 2 步：**动作与目标**（docs/21 §1 ①）。
 *
 * - 动作按所选内容自动禁用不适用项（安装 / 升级 / 卸载 / 仅应用配置）；
 * - 目标：全部 / 指定用户 / 角色 / **已安装用户**（每个内容项各自解析，人数来自 `install-stats`）；
 * - 旧向导的「按条件筛选」留在折叠的高级选项里（不常驻）：契约的 `targets` 没有 filter 分支，
 *   所以它在提交前解析成明确的用户清单（与「已安装」同一语义：落成清单、之后新装的人不追加）。
 */
const props = defineProps<{
  draft: DeliveryDraft
  users: UserAdminView[]
  installStats: PluginInstallStat[]
  /** 「按条件筛选」匹配到的用户（页面算好传进来） */
  matchedUserIds: number[]
  plugins: DeliveryPluginView[]
  runtimes: AdminRuntimeRow[]
  presets: ModelPreset[]
  /** WP57 五步流程：动作在「配置」步选，这里只管目标 */
  hideAction?: boolean
}>()

const emit = defineEmits<{ 'update:draft': [DeliveryDraft] }>()

function patch(partial: Partial<DeliveryDraft>): void {
  emit('update:draft', { ...props.draft, ...partial })
}

const actionOptions: DeliveryAction[] = ['install', 'upgrade', 'uninstall', 'apply-config']

const kinds = computed(() => itemKinds(props.draft.items))
const availability = computed(() => actionAvailability(kinds.value))

const pluginItems = computed(() => props.draft.items.filter((item) => item.kind === 'plugin'))
const hasRuntime = computed(() => kinds.value.has('runtime'))

function reasonOf(action: DeliveryAction): string | undefined {
  return availability.value[action] ? undefined : actionDisabledReason(action, kinds.value)
}

const action = computed<DeliveryAction>({
  get: () => props.draft.action,
  set: (value) => patch({ action: value }),
})

const targetMode = computed<DeliveryTargetMode | ''>({
  // `filter`（条件筛选）与 `none`（还没选，例如卸载的默认状态）都不在主单选组里
  get: () =>
    props.draft.targetMode === 'filter' || props.draft.targetMode === 'none' ? '' : props.draft.targetMode,
  set: (value) => {
    if (value === '') return
    patch({ targetMode: value })
    if (value === 'filter') advancedOpen.value = ['filter']
  },
})

const userIds = computed<number[]>({
  get: () => props.draft.userIds,
  set: (value) => patch({ userIds: value }),
})

const role = computed({
  get: () => props.draft.role,
  set: (value) => patch({ role: value }),
})

const outdatedOnly = computed<boolean>({
  get: () => props.draft.outdatedOnly,
  set: (value) => patch({ outdatedOnly: value }),
})

const filterStatus = computed({
  get: () => props.draft.filter.status ?? null,
  set: (value) => setFilter({ status: value ?? undefined }),
})

const filterVersion = computed({
  get: () => props.draft.filter.dshVersion ?? null,
  set: (value) => setFilter({ dshVersion: value ?? undefined }),
})

const filterPreset = computed({
  get: () => props.draft.filter.presetId ?? null,
  set: (value) => setFilter({ presetId: value ?? undefined }),
})

function setFilter(partial: DeliveryFilter): void {
  const next: DeliveryFilter = { ...props.draft.filter, ...partial }
  // 清掉 undefined，免得请求体里出现空键
  for (const key of Object.keys(next) as (keyof DeliveryFilter)[]) {
    if (next[key] === undefined) delete next[key]
  }
  patch({ filter: next })
}

const advancedOpen = ref<string[]>([])

/** 「按条件筛选」启用时把折叠展开（不然看不到条件） */
const expanded = computed<string[]>({
  get: () => (props.draft.targetMode === 'filter' ? ['filter'] : advancedOpen.value),
  set: (value) => {
    advancedOpen.value = value.includes('filter') ? ['filter'] : []
  },
})

const targetOptions: { label: string; value: Exclude<DeliveryTargetMode, 'filter' | 'none'> }[] = [
  { label: '全部', value: 'all' },
  { label: '指定用户', value: 'users' },
  { label: '角色', value: 'role' },
  { label: '已安装用户', value: 'installed' },
]

const userOptions = computed(() =>
  props.users.map((user) => ({
    label: `${user.username}（${user.displayName}）`,
    value: user.id,
  })),
)

const roleOptions = [
  { label: '普通用户', value: 'user' as const },
  { label: '管理员', value: 'admin' as const },
]

const statusOptions = [
  { label: '正常', value: 'active' as const },
  { label: '待审批', value: 'pending' as const },
  { label: '已停用', value: 'disabled' as const },
]

const dshVersionOptions = computed(() => {
  const versions = new Set<string>()
  for (const user of props.users) {
    const version = user.instance.runtimeVersion
    if (version !== null) versions.add(version)
  }
  return [...versions].map((version) => ({ label: version, value: version }))
})

const presetOptions = computed(() =>
  props.presets.map((preset) => ({ label: preset.name, value: preset.id })),
)

function labelOf(item: DeliveryItemDraft): string {
  return itemLabel(item, {
    plugins: props.plugins,
    runtimes: props.runtimes,
    presets: props.presets,
  })
}

function statOf(pluginId: number | null): PluginInstallStat | null {
  return props.installStats.find((stat) => stat.pluginId === pluginId) ?? null
}

const installedRows = computed(() =>
  pluginItems.value.map((item) => {
    const stat = statOf(item.pluginId)
    return {
      key: item.pluginId ?? 0,
      label: labelOf(item),
      count: stat ? installCountText(stat, props.draft.platforms) : '—',
      outdated: stat ? installOutdatedText(stat, props.draft.platforms) : '',
    }
  }),
)
</script>

<template>
  <SoftCard v-if="!props.hideAction" title="动作">
    <template #title-extra>
      <InfoTip
        label="动作说明"
        text="「仅应用配置」只重渲染配置、不装包；「卸载」只对插件有意义；DSH 版本只有升级。"
      />
    </template>
    <NRadioGroup :value="action" data-testid="delivery-action" @update:value="(value: DeliveryAction) => (action = value)">
      <NRadio
        v-for="value in actionOptions"
        :key="value"
        :value="value"
        :disabled="!availability[value]"
        :title="reasonOf(value)"
        :data-testid="`delivery-action-${value}`"
      >
        {{ DELIVERY_ACTION_TEXT[value] }}
      </NRadio>
    </NRadioGroup>
  </SoftCard>

  <SoftCard :title="props.hideAction ? '下发给谁' : '目标'">
    <NRadioGroup
      :value="targetMode"
      data-testid="delivery-targets"
      @update:value="(value: Exclude<DeliveryTargetMode, 'filter' | 'none'>) => (targetMode = value)"
    >
      <NRadio
        v-for="option in targetOptions"
        :key="option.value"
        :value="option.value"
        :disabled="option.value === 'installed' && hasRuntime"
        :title="option.value === 'installed' && hasRuntime ? 'DSH 版本不支持「已安装用户」' : undefined"
        :data-testid="`delivery-target-${option.value}`"
      >
        {{ option.label }}
      </NRadio>
    </NRadioGroup>

    <div v-if="props.draft.targetMode === 'users'" class="targets__block">
      <NSelect
        v-model:value="userIds"
        multiple
        filterable
        :options="userOptions"
        :max-tag-count="6"
        placeholder="搜索用户名或昵称"
        data-testid="delivery-users"
      />
      <span class="targets__count">已选 {{ props.draft.userIds.length }} 位用户</span>
    </div>

    <div v-else-if="props.draft.targetMode === 'role'" class="targets__block">
      <NSelect v-model:value="role" :options="roleOptions" class="targets__select" data-testid="delivery-role" />
    </div>

    <div v-else-if="props.draft.targetMode === 'installed'" class="targets__block">
      <label class="targets__switch">
        <NSwitch v-model:value="outdatedOnly" size="small" data-testid="delivery-outdated" />
        <span>只选版本较旧的</span>
      </label>

      <ul v-if="installedRows.length > 0" class="targets__stats" data-testid="delivery-installed-stats">
        <li v-for="row in installedRows" :key="row.key" class="targets__stat">
          <span class="targets__stat-name">{{ row.label }}</span>
          <MiniTag :text="row.count" tone="sky" size="sm" />
          <MiniTag v-if="row.outdated" :text="`其中 ${row.outdated} 版本较旧`" tone="butter" size="sm" />
        </li>
      </ul>
    </div>

    <NCollapse v-model:expanded-names="expanded" class="targets__advanced" data-testid="delivery-advanced">
      <NCollapseItem name="filter">
        <template #header>
          <span class="targets__advanced-title">高级选项：按条件筛选</span>
          <MiniTag
            v-if="props.draft.targetMode === 'filter'"
            :text="`已启用 · 匹配 ${props.matchedUserIds.length} 人`"
            tone="primary"
            size="sm"
          />
        </template>
        <div class="targets__filters">
          <NSelect
            v-model:value="filterStatus"
            clearable
            size="small"
            placeholder="账号状态"
            class="targets__select"
            :options="statusOptions"
            data-testid="delivery-filter-status"
          />
          <NSelect
            v-model:value="filterVersion"
            clearable
            size="small"
            placeholder="当前 DSH 版本"
            class="targets__select"
            :options="dshVersionOptions"
            data-testid="delivery-filter-version"
          />
          <NSelect
            v-model:value="filterPreset"
            clearable
            size="small"
            placeholder="当前模型预设"
            class="targets__select"
            :options="presetOptions"
            data-testid="delivery-filter-preset"
          />
          <NRadioGroup
            :value="props.draft.targetMode === 'filter' ? 'filter' : ''"
            @update:value="(value: 'filter') => (targetMode = value)"
          >
            <NRadio value="filter" data-testid="delivery-target-filter">按这些条件下发</NRadio>
          </NRadioGroup>
        </div>
      </NCollapseItem>
    </NCollapse>
  </SoftCard>
</template>

<style scoped>
.targets__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.targets__count {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.targets__switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.targets__stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.targets__stat {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.targets__stat-name {
  color: var(--c-text);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.targets__select {
  width: 240px;
  max-width: 100%;
}

.targets__advanced {
  margin-top: var(--space-4);
}

.targets__advanced-title {
  font-size: var(--fs-13);
}

.targets__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
</style>
