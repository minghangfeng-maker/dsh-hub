<script setup lang="ts">
import type { AdminPluginRow, DeliveryAction, DeliveryPlatform } from '@dsh-hub/shared'
import { NButton, NSelect } from 'naive-ui'
import { computed } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import {
  pluginAvailableOn,
  type DeliveryItemDraft,
  type DeliveryPluginView,
  type PluginItemDraft,
} from '@/composables/delivery-draft'

/**
 * 内容项里的「插件」多选（docs/21 §1 ①、docs/22 §2）。
 *
 * 两个平台各有一套插件库：同时选云端与桌面时，每个插件给**两个版本下拉**
 * （`versionId` 云端 / `desktopVersionId` 桌面），各自缺省 = 该平台最新版本。
 * 插件不在某平台的库里时，那一侧直接显示「不在桌面插件库 / 不在云端插件库」，
 * 预览与提交时这一侧整项跳过（原因由后端给）。
 *
 * - `hidden` 的插件不出现在候选里（裁决 #17：hidden 不下发）；
 * - 桌面版本标「有 / 缺桌面整包」：缺整包的版本设备拿不到；
 * - 卸载时版本无意义（版本下拉置灰）。
 */
const props = defineProps<{
  items: DeliveryItemDraft[]
  /** 两个平台库合并后的视图（由页面拉两次 `GET /api/admin/plugins?platform=` 得到） */
  plugins: DeliveryPluginView[]
  platforms: DeliveryPlatform[]
  /** 有桌面整包的版本 id（`GET /api/admin/desktop/artifacts`） */
  artifactVersionIds: Set<number>
  action: DeliveryAction
  disabled?: boolean
  max?: number
}>()

const emit = defineEmits<{ 'update:items': [DeliveryItemDraft[]] }>()

const limit = computed(() => props.max ?? 20)

const showCloud = computed(() => props.platforms.includes('instance'))
const showDesktop = computed(() => props.platforms.includes('desktop'))

const pluginItems = computed(() =>
  props.items.filter((item): item is PluginItemDraft => item.kind === 'plugin'),
)

const selectedIds = computed(() => pluginItems.value.map((item) => item.pluginId ?? 0))

/** 候选：至少一个所选平台能下发（在库里且不是 hidden） */
const candidates = computed(() =>
  props.plugins.filter((view) => props.platforms.some((platform) => pluginAvailableOn(view, platform))),
)

// 已选的也要留在选项里：Naive 的 multiple 下拉靠 options 找已选项的标签，
// 把它们从 options 里过滤掉会让标签退化成原始 id（截图里就是「1 × 3 ×」）
const pluginOptions = computed(() => {
  const ids = new Set([...candidates.value.map((view) => view.id), ...selectedIds.value])
  return props.plugins
    .filter((view) => ids.has(view.id))
    .map((view) => ({
      label: `${view.displayName} · ${view.packageName}`,
      value: view.id,
    }))
})

function pluginOf(pluginId: number | null): DeliveryPluginView | null {
  return props.plugins.find((view) => view.id === pluginId) ?? null
}

function libraryOf(pluginId: number | null, platform: DeliveryPlatform): AdminPluginRow | null {
  const view = pluginOf(pluginId)
  if (!view) return null
  return platform === 'desktop' ? view.desktop : view.cloud
}

/** 默认版本：该平台库里的最新版本（列表第一个） */
function defaultVersionId(pluginId: number, platform: DeliveryPlatform): number | null {
  const library = libraryOf(pluginId, platform)
  return library?.versions[0]?.id ?? null
}

function versionOptions(
  pluginId: number | null,
  platform: DeliveryPlatform,
): { label: string; value: number }[] {
  const library = libraryOf(pluginId, platform)
  if (!library) return []
  if (platform === 'instance') {
    return library.versions.map((version) => ({ label: version.version, value: version.id }))
  }
  return library.versions.map((version) => ({
    label: props.artifactVersionIds.has(version.id)
      ? `${version.version}（有桌面整包）`
      : `${version.version}（缺桌面整包）`,
    value: version.id,
  }))
}

function onChangePlugins(ids: number[]): void {
  const existing = new Set(pluginItems.value.map((item) => item.pluginId ?? 0))
  const next: DeliveryItemDraft[] = []
  // 保留还在的插件（顺序按当前列表），再追加新选的
  for (const item of pluginItems.value) {
    if (item.pluginId !== null && ids.includes(item.pluginId)) next.push(item)
  }
  for (const id of ids) {
    if (existing.has(id)) continue
    next.push({
      kind: 'plugin',
      pluginId: id,
      versionId: defaultVersionId(id, 'instance'),
      desktopVersionId: defaultVersionId(id, 'desktop'),
    })
  }
  // 非插件内容项原样留在列表里（它们由各自的卡片维护）
  const others = props.items.filter((item) => item.kind !== 'plugin')
  emit('update:items', [...next, ...others])
}

function setVersion(pluginId: number | null, platform: DeliveryPlatform, versionId: number | null): void {
  emit(
    'update:items',
    props.items.map((item) => {
      if (item.kind !== 'plugin' || item.pluginId !== pluginId) return item
      return platform === 'desktop' ? { ...item, desktopVersionId: versionId } : { ...item, versionId }
    }),
  )
}

function removePlugin(pluginId: number | null): void {
  emit(
    'update:items',
    props.items.filter((item) => !(item.kind === 'plugin' && item.pluginId === pluginId)),
  )
}

/** 当前选中的桌面版本有没有整包（没有的话提示「设备拿不到」） */
function desktopHasArtifact(item: PluginItemDraft): boolean {
  const versionId = item.desktopVersionId ?? defaultVersionId(item.pluginId ?? 0, 'desktop')
  return versionId !== null && props.artifactVersionIds.has(versionId)
}

/** 下拉里没有版本时的占位 */
function versionPlaceholder(pluginId: number | null, platform: DeliveryPlatform): string {
  const library = libraryOf(pluginId, platform)
  return library?.latestVersion ? `最新（${library.latestVersion}）` : '没有版本'
}
</script>

<template>
  <div class="picker">
    <NSelect
      multiple
      filterable
      :value="selectedIds.filter((id) => id > 0)"
      :options="pluginOptions"
      :disabled="props.disabled"
      :max-tag-count="6"
      placeholder="选择插件（可多选）"
      data-testid="delivery-plugin-select"
      @update:value="(ids: number[]) => onChangePlugins(ids)"
    />

    <ul v-if="pluginItems.length > 0" class="picker__list" data-testid="delivery-plugin-list">
      <li v-for="item in pluginItems" :key="item.pluginId ?? 0" class="picker__row">
        <div class="picker__name">
          <span class="picker__display">{{ pluginOf(item.pluginId)?.displayName ?? '—' }}</span>
          <span class="picker__package">{{ pluginOf(item.pluginId)?.packageName ?? '' }}</span>
        </div>

        <div class="picker__platforms">
          <div
            v-if="showCloud"
            class="picker__platform"
            :data-testid="`delivery-versions-cloud-${item.pluginId ?? 0}`"
          >
            <MiniTag text="云端" tone="neutral" size="sm" />
            <template v-if="libraryOf(item.pluginId, 'instance')">
              <NSelect
                size="small"
                class="picker__select"
                :value="item.versionId"
                :options="versionOptions(item.pluginId, 'instance')"
                :disabled="props.disabled || props.action === 'uninstall'"
                :placeholder="versionPlaceholder(item.pluginId, 'instance')"
                :data-testid="`delivery-version-${item.pluginId ?? 0}`"
                @update:value="(value: number | null) => setVersion(item.pluginId, 'instance', value)"
              />
            </template>
            <MiniTag v-else text="不在云端插件库" tone="danger" size="sm" />
          </div>

          <div
            v-if="showDesktop"
            class="picker__platform"
            :data-testid="`delivery-versions-desktop-${item.pluginId ?? 0}`"
          >
            <MiniTag text="桌面" tone="neutral" size="sm" />
            <template v-if="libraryOf(item.pluginId, 'desktop')">
              <NSelect
                size="small"
                class="picker__select"
                :value="item.desktopVersionId"
                :options="versionOptions(item.pluginId, 'desktop')"
                :disabled="props.disabled || props.action === 'uninstall'"
                :placeholder="versionPlaceholder(item.pluginId, 'desktop')"
                :data-testid="`delivery-desktop-version-${item.pluginId ?? 0}`"
                @update:value="(value: number | null) => setVersion(item.pluginId, 'desktop', value)"
              />
              <MiniTag v-if="desktopHasArtifact(item)" text="有桌面整包" tone="success" size="sm" />
              <MiniTag v-else text="缺桌面整包" tone="butter" size="sm" />
            </template>
            <MiniTag v-else text="不在桌面插件库" tone="danger" size="sm" />
          </div>
        </div>

        <NButton
          size="tiny"
          quaternary
          :disabled="props.disabled"
          :data-testid="`delivery-plugin-remove-${item.pluginId ?? 0}`"
          @click="removePlugin(item.pluginId)"
        >
          移除
        </NButton>
      </li>
    </ul>

    <p v-if="pluginItems.length === 0" class="picker__empty">还没选插件</p>
    <p v-else-if="pluginItems.length >= limit" class="picker__limit">已达上限 {{ limit }} 个</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.picker__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.picker__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.picker__name {
  display: flex;
  min-width: 180px;
  flex: 1 1 180px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.picker__display {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__package {
  overflow: hidden;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__platforms {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.picker__platform {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

.picker__select {
  width: 210px;
}

.picker__empty,
.picker__limit {
  color: var(--c-text-3);
  font-size: var(--fs-13);
  white-space: nowrap;
}
</style>
