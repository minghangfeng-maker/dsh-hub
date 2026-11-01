<script setup lang="ts">
/**
 * 模型选择弹层（Codex 风格的芯片 → 模型段）。
 *
 * 结构：顶部一段「后端」（云服务器 / 电脑，仍按原需求保留在这里），下面「模型」列表。
 * 不再有第三段「思考程度」——强度改成芯片的强度段 + 横向拖动条弹层（EffortSheet）。
 *
 * 后端列表来自 bootstrap.backends；**只展示当前可连接的**（离线桌面端不占位置，
 * 真机反馈：一屏 8 条「电脑端没有连上 Hub」把可用的云服务器淹了）。
 * 模型目录来自通道 v2 `models` 帧（M5 §17）；服务端没回显时用本地 mock 目录。
 * 模型名用 lib/model-label.ts 的短名，**不显示 provider / 服务器地址**；
 * 「渠道」（upstream-b / upstream-c / modelscope…）来自 catalog 全名 `· channel` 后缀，
 * 用来区分同一个模型经不同渠道的各一条。
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import BottomSheet from './BottomSheet.vue'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useBackendStore } from '@/stores/backend'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useCockpitStore } from '@/stores/cockpit'
import {
  blockedReasonText,
  modelKey,
  supportsThinking,
  type Backend,
  type CatalogModel,
} from '@dsh-hub/mobile-core'
import { modelChannelName, modelDisplayName, modelMultiplierText } from '@/lib/model-label'

const ui = useUiStore()
const auth = useAuthStore()
const backendStore = useBackendStore()
const chat = useChatStore()
const modelsStore = useModelsStore()
/** 嵌入座舱（WP56d）：节点固定 cloud:ops，不提供节点切换（docs/24 §6）。 */
const cockpitStore = useCockpitStore()

const backendTitle = (backend: Backend): string =>
  backend.kind === 'cloud' ? '云服务器' : `电脑（${backend.name}）`

function backendStatus(backend: Backend): { label: string; reason: string } {
  if (backend.connectable) {
    return { label: backend.kind === 'cloud' ? '运行中' : '在线', reason: '' }
  }
  const reason = blockedReasonText(backend.reason) ?? ''
  if (backend.kind === 'cloud') {
    const map: Record<string, string> = {
      absent: '尚未开通',
      stopped: '已休眠',
      starting: '启动中',
      stopping: '停止中',
      error: '启动失败',
      running: '不可用',
    }
    return { label: map[String(backend.status)] ?? '不可用', reason }
  }
  const map: Record<string, string> = {
    'host-running': '在线但不可连接',
    'host-stopped': '电脑上的 DSH 未运行',
    unknown: '状态未知',
  }
  return { label: map[String(backend.status)] ?? '离线', reason }
}

const models = computed(() => modelsStore.catalog.items)
const modelsFeature = computed(() => modelsStore.features.includes('models'))
const selectedModelKey = computed(() => (modelsStore.selection ? modelKey(modelsStore.selection) : null))

/**
 * 后端列表只放「现在可用」的：离线/下线的桌面端直接不展示（真机反馈）。
 * 一个可用的都没有时回退成全部，避免列表空白让人以为坏了（原因仍会灰字显示）。
 */
const backends = computed(() => {
  const available = backendStore.backends.filter((backend) => backend.connectable)
  return available.length > 0 ? available : backendStore.backends
})

const modelName = (model: CatalogModel): string => modelDisplayName(model)
const modelChannel = (model: CatalogModel): string => modelChannelName(model)
/** 渠道倍率（Hub 中转站）：0.1 → `X0.1`；老 Hub 不给就空串，不显示。 */
const modelMultiplier = (model: CatalogModel): string => modelMultiplierText(model.multiplier ?? null)
const modelMeta = (model: CatalogModel): string =>
  supportsThinking(model) ? '可调思考程度' : '不支持调节思考程度'
const modelAriaLabel = (model: CatalogModel): string => {
  const channel = modelChannel(model)
  const multiplier = modelMultiplier(model)
  return `${modelName(model)}${channel ? `，渠道 ${channel}` : ''}${multiplier ? `，倍率 ${multiplier}` : ''}，${modelMeta(model)}`
}

async function pickBackend(backend: Backend): Promise<void> {
  if (!backend.connectable) {
    ui.toast(backendStatus(backend).reason || '这个后端现在不可连接')
    return
  }
  if (backend.id === backendStore.selectedBackendId) return
  await backendStore.selectBackend(backend.id)
  ui.toast(auth.isMock ? `已切换到 ${backendTitle(backend)}（mock）` : `已切换到 ${backendTitle(backend)}`)
}

async function pickModel(key: string): Promise<void> {
  if (key === selectedModelKey.value) {
    ui.closeModelSheet()
    return
  }
  chat.rememberSelectionBeforeChange()
  await modelsStore.selectModel(key)
  // 立即把选择作用到当前会话（服务端回显 models feature 时才发 set-model）；
  // 失败会回滚到 rememberSelectionBeforeChange 记下的那个选择并提示。
  await chat.pushModelSelection()
  ui.closeModelSheet()
}
</script>

<template>
  <BottomSheet :open="ui.modelSheetOpen" label="选择后端与模型" @close="ui.closeModelSheet()">
    <template v-if="!cockpitStore.embed">
      <p class="sheet__title">后端</p>
      <button
        v-for="backend in backends"
      :key="backend.id"
      class="sheet__item backend"
      :class="{
        'is-selected': backend.id === backendStore.selectedBackendId,
        'is-disabled': !backend.connectable,
      }"
      type="button"
      :disabled="!backend.connectable && backend.id !== backendStore.selectedBackendId"
      :aria-pressed="backend.id === backendStore.selectedBackendId"
      @click="pickBackend(backend)"
    >
      <AppIcon :name="backend.kind === 'cloud' ? 'layers' : 'terminal'" :size="18" />
      <span class="backend__main">
        <span class="backend__name">{{ backendTitle(backend) }}</span>
        <span v-if="backendStatus(backend).reason" class="backend__reason">
          {{ backendStatus(backend).reason }}
        </span>
      </span>
      <span class="sheet__item-desc">{{ backendStatus(backend).label }}</span>
      <AppIcon v-if="backend.id === backendStore.selectedBackendId" name="check" :size="17" />
    </button>
      <p v-if="backendStore.backends.length === 0" class="sheet__empty">正在读取后端列表…</p>
    </template>

    <p class="sheet__title">模型</p>
    <p v-if="!modelsFeature" class="sheet__empty">
      当前后端没有上报模型列表，暂时使用默认模型。
    </p>
    <button
      v-for="model in models"
      :key="modelKey(model)"
      class="sheet__item model"
      :class="{ 'is-selected': modelKey(model) === selectedModelKey }"
      type="button"
      :aria-pressed="modelKey(model) === selectedModelKey"
      :aria-label="modelAriaLabel(model)"
      @click="pickModel(modelKey(model))"
    >
      <span class="model__main">
        <span class="model__title">
          <span class="model__name">{{ modelName(model) }}</span>
          <span v-if="modelMultiplier(model)" class="model__multiplier">{{ modelMultiplier(model) }}</span>
        </span>
        <span class="model__meta">
          <span v-if="modelChannel(model)" class="model__channel">{{ modelChannel(model) }}</span>
          <span>{{ modelMeta(model) }}</span>
        </span>
      </span>
      <AppIcon v-if="modelKey(model) === selectedModelKey" name="check" :size="17" />
    </button>
    <p v-if="models.length === 0" class="sheet__empty">这个后端还没有可用模型</p>
  </BottomSheet>
</template>

<style scoped>
.backend__main,
.model__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
/* 模型行：文字占满剩余宽度，选中勾落在最右侧 */
.model__main {
  flex: 1 1 auto;
}
/* 模型名 + 渠道倍率（真机 2026-10-26：名字后面跟一个 X0.1） */
.model__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.model__multiplier {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--brand-blue, #4a7fd4);
  opacity: 0.9;
}
.backend__name,
.model__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backend__reason,
.model__meta {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 渠道标签：upstream-b / upstream-c / modelscope …（同名模型靠它区分） */
.model__meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.model__channel {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 10.5px;
  line-height: 16px;
}
.sheet__item.is-disabled {
  color: var(--text-3);
  opacity: 0.62;
}
.sheet__item.is-disabled .sheet__item-desc {
  color: var(--text-3);
}
.sheet__empty {
  font-size: 12.5px;
  color: var(--text-3);
  padding: 2px 10px 8px;
}
</style>
