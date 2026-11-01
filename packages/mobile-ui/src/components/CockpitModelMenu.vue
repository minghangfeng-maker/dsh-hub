<script setup lang="ts">
/**
 * 控制台主题的模型下拉（WP58 / docs/26 §3.2）：**锚定在模型按钮上方的面板**，
 * 不是手机上的底部抽屉（ModelSheet）。
 *
 * 结构按文档的示意：
 *   列表项「模型名 · 倍率 · 渠道」，当前项打勾；模型超过 8 个时顶上出搜索框；
 *   ↑↓ 选、Enter 确认、Esc 关；没有 models 能力时按钮显示「默认模型」且不可点
 *   （那一条由调用方 Composer 判断，本组件只在能力可用时才被渲染出来）。
 *
 * 生效链路沿用手机的语义：`chat.rememberSelectionBeforeChange()` → `models.selectModel()`
 * → `chat.pushModelSelection()`（失败回滚 + toast 都在 store 里，见 ModelSheet.vue）。
 * 只在 `html.cockpit-console` 下被渲染，APK / 手机网页版 / theme=bridge 都碰不到。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { modelKey, supportsThinking, type CatalogModel } from '@dsh-hub/mobile-core'
import { modelChannelName, modelDisplayName, modelMultiplierText } from '@/lib/model-label'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const chat = useChatStore()
const models = useModelsStore()

const search = ref('')
const activeIndex = ref(0)
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const items = computed<CatalogModel[]>(() => models.catalog.items)
/** 超过 8 个才出搜索框（文档的阈值）。 */
const searchable = computed(() => items.value.length > 8)

const selectedKey = computed(() =>
  models.selection ? modelKey(models.selection) : null,
)

const filtered = computed<CatalogModel[]>(() => {
  const keyword = search.value.trim().toLowerCase()
  if (keyword === '') return items.value
  return items.value.filter((model) => {
    const haystack = [
      modelDisplayName(model),
      model.name ?? '',
      model.model ?? '',
      modelChannelName(model),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(keyword)
  })
})

const nameOf = (model: CatalogModel): string => modelDisplayName(model)
const channelOf = (model: CatalogModel): string => modelChannelName(model)
const multiplierOf = (model: CatalogModel): string => modelMultiplierText(model.multiplier ?? null)
const keyOf = (model: CatalogModel): string => modelKey(model)

function labelOf(model: CatalogModel): string {
  const parts = [nameOf(model)]
  const multiplier = multiplierOf(model)
  if (multiplier) parts.push(multiplier)
  const channel = channelOf(model)
  if (channel) parts.push(channel)
  return parts.join(' · ')
}

function ariaOf(model: CatalogModel): string {
  const meta = supportsThinking(model) ? '可调思考程度' : '不支持调节思考程度'
  return `${labelOf(model)}，${meta}`
}

async function pick(model: CatalogModel): Promise<void> {
  const key = keyOf(model)
  if (key === selectedKey.value) {
    emit('close')
    return
  }
  chat.rememberSelectionBeforeChange()
  await models.selectModel(key)
  // 立刻把选择作用到当前会话；失败会回滚到改之前的选择并 toast
  await chat.pushModelSelection()
  emit('close')
}

/** 键盘：↑↓ 移动、Enter 确认、Esc 关（输入法选词的 Enter 不算）。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  const list = filtered.value
  if (list.length === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % list.length
    scrollActiveIntoView()
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + list.length) % list.length
    scrollActiveIntoView()
    return
  }
  if (event.key === 'Enter') {
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    const model = list[activeIndex.value]
    if (model) void pick(model)
  }
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const rows = listEl.value?.querySelectorAll<HTMLElement>('[data-model-row]')
    rows?.[activeIndex.value]?.scrollIntoView({ block: 'nearest' })
  })
}

/** 打开时：清搜索、光标落到当前项（键盘能接着用），搜索框拿焦点。 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    search.value = ''
    const at = items.value.findIndex((model) => keyOf(model) === selectedKey.value)
    activeIndex.value = at >= 0 ? at : 0
    void nextTick(() => {
      if (searchable.value) searchEl.value?.focus()
      else listEl.value?.focus()
    })
  },
  { immediate: true },
)

/** 搜索过滤后光标不能停在范围外。 */
watch(filtered, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = Math.max(0, list.length - 1)
})
</script>

<template>
  <div
    v-if="open"
    class="model-menu"
    data-testid="console-model-menu"
    role="dialog"
    aria-label="选择模型"
    @keydown="onKeydown"
  >
    <div v-if="searchable" class="model-menu__search">
      <AppIcon name="search" :size="14" />
      <input
        ref="searchEl"
        v-model="search"
        class="model-menu__input"
        type="text"
        placeholder="搜索模型"
        aria-label="搜索模型"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div ref="listEl" class="model-menu__list" role="listbox" tabindex="-1">
      <button
        v-for="(model, index) in filtered"
        :key="keyOf(model)"
        class="model-menu__row"
        :class="{ 'is-selected': keyOf(model) === selectedKey, 'is-active': index === activeIndex }"
        type="button"
        role="option"
        data-model-row
        :data-model-key="keyOf(model)"
        :aria-selected="keyOf(model) === selectedKey"
        :aria-label="ariaOf(model)"
        @mouseenter="activeIndex = index"
        @click="pick(model)"
      >
        <span class="model-menu__main">
          <span class="model-menu__name">{{ nameOf(model) }}</span>
          <span v-if="multiplierOf(model)" class="model-menu__multiplier">
            {{ multiplierOf(model) }}
          </span>
          <span v-if="channelOf(model)" class="model-menu__channel">{{ channelOf(model) }}</span>
        </span>
        <AppIcon v-if="keyOf(model) === selectedKey" name="check" :size="15" />
      </button>
      <p v-if="filtered.length === 0" class="model-menu__empty">没有匹配的模型</p>
    </div>
  </div>
</template>

<style scoped>
.model-menu {
  position: absolute;
  z-index: 30;
  left: 0;
  bottom: calc(100% + 8px);
  width: 320px;
  max-width: min(320px, 72vw);
  display: flex;
  flex-direction: column;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: #ffffff;
  box-shadow: var(--shadow-float);
}
.model-menu__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.model-menu__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  padding: 2px 0;
}
.model-menu__list {
  max-height: min(320px, 44vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  outline: none;
}
.model-menu__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 13px;
  line-height: 1.5;
}
.model-menu__row.is-active {
  background: var(--surface-2);
}
.model-menu__row.is-selected {
  color: var(--accent-ink);
  font-weight: 500;
}
.model-menu__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.model-menu__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.model-menu__multiplier {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--accent-ink);
  opacity: 0.9;
}
.model-menu__channel {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 10.5px;
  line-height: 16px;
}
.model-menu__empty {
  padding: 8px;
  font-size: 12.5px;
  color: var(--text-3);
}
</style>
