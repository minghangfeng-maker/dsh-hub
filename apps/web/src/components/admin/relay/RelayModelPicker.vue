<script setup lang="ts">
import type { RelayChannel, RelayModel, RelayScope } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NInput,
  NModal,
  NSelect,
  NSpin,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { discoverRelayChannel, importRelayModels, listRelayModels, updateRelayModel } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import {
  channelRoutes,
  pickerRows,
  routesWithoutChannel,
  toImportEntries,
  type PickerModel,
} from '@/components/admin/relay/picker'
import { modelInfoSummary } from '@/components/admin/model-info'

/**
 * 模型选择器（12 §10）：渠道 Tab 的「选择模型」与模型 Tab 的「添加模型」共用。
 *
 * - 勾上 = `import`（**不带价格**，新建的模型是「未定价」，之后去「模型与价格」逐个定价）；
 * - 取消勾选已经挂在本渠道的模型 = 二次确认后 PATCH 该模型的 `routes` 去掉本渠道
 *   （模型与价格保留；只剩这个渠道的模型会变成「无渠道」）；
 * - `discover` 失败时把原因显示出来，手动添加照常可用。
 *
 * 组件是「弹窗里的主体」，不带外壳：调用方用 `NModal`（选择器）或 `NSteps` 的第 2 步（添加渠道）装它。
 */
const props = withDefaults(
  defineProps<{
    /** 已经确定的渠道；null = 让用户先选一个（模型 Tab 的「添加模型」） */
    channel: RelayChannel | null
    channels: RelayChannel[]
    /** 底部左侧按钮的文案（选择器里是「关闭」，添加渠道第 2 步是「跳过」） */
    dismissText?: string
    /** 18 §6：只列出 / 匹配这个作用域里的模型；缺省 = DSH */
    scope?: RelayScope
  }>(),
  { dismissText: '关闭', scope: 'dsh' },
)

const emit = defineEmits<{ changed: []; 'goto-pricing': []; dismiss: [] }>()

const message = useMessage()

const channelId = ref<number | null>(props.channel?.id ?? null)
const loading = ref(false)
const importing = ref(false)
const discoverError = ref('')
const errorText = ref('')
const rows = ref<PickerModel[]>([])
const checked = ref<string[]>([])
const allModels = ref<RelayModel[]>([])
const search = ref('')
const manual = ref('')
const result = ref<{ created: number; routesAdded: number } | null>(null)

/** 取消勾选的二次确认：列出待移除的模型名 */
const pendingRemoval = ref<{ upstreamModel: string; modelId: number; modelName: string }[]>([])
const showConfirm = ref(false)

const currentChannel = computed(() => props.channels.find((item) => item.id === channelId.value) ?? null)
const channelRoutesNow = computed(() => channelRoutes(allModels.value, channelId.value))
const existingNames = computed(() => channelRoutesNow.value.map((route) => route.upstreamModel))

const channelOptions = computed(() =>
  props.channels.map((channel) => ({
    label: `${channel.name}${channel.enabled ? '' : '（已停用）'}`,
    value: channel.id,
  })),
)

/** 这次会新加几个（不含已经挂在本渠道的） */
const newCount = computed(() => toImportEntries(rows.value, checked.value, existingNames.value).length)

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return rows.value
  return rows.value.filter(
    (row) => row.id.toLowerCase().includes(keyword) || (row.name ?? '').toLowerCase().includes(keyword),
  )
})

/** 动态添加的行（上游没有 /models）用「手动」小标区分 */
const manualNames = ref<string[]>([])

function sourceTag(model: PickerModel): { text: string; tone: 'primary' | 'butter' | 'sky' | 'neutral' } {
  if (manualNames.value.includes(model.id)) return { text: '手动', tone: 'butter' }
  switch (model.infoSource) {
    case 'builtin':
      return { text: '模型库', tone: 'primary' }
    case 'custom':
      return { text: '自定义', tone: 'butter' }
    case 'upstream':
      return { text: '端点返回', tone: 'sky' }
    default:
      return { text: '未匹配', tone: 'neutral' }
  }
}

async function load(): Promise<void> {
  const id = channelId.value
  if (id === null) return
  loading.value = true
  discoverError.value = ''
  errorText.value = ''
  manualNames.value = []
  search.value = ''
  try {
    const [discovered, modelList] = await Promise.all([
      discoverRelayChannel(id).catch((cause: unknown) => {
        discoverError.value = describeError(cause).message
        return null
      }),
      listRelayModels(props.scope),
    ])
    allModels.value = modelList
    const routes = channelRoutes(modelList, id)
    rows.value = pickerRows(discovered?.models ?? [], routes, modelList)
    checked.value = routes.map((route) => route.upstreamModel)
  } catch (cause) {
    errorText.value = describeError(cause).message
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.channel?.id, props.channels] as const,
  () => {
    if (props.channel) channelId.value = props.channel.id
  },
  { immediate: true },
)

watch(
  channelId,
  (id) => {
    result.value = null
    if (id === null) {
      rows.value = []
      checked.value = []
      return
    }
    void load()
  },
  // 渠道是父组件给的（`channel` prop 已经确定）时也要立刻拉一次
  { immediate: true },
)

function toggleAll(): void {
  const importable = filtered.value.map((row) => row.id)
  const missing = importable.filter((name) => !checked.value.includes(name))
  if (missing.length === 0) {
    checked.value = checked.value.filter((name) => !importable.includes(name))
    // 取消勾选里可能有本渠道已有的 → 走同一套确认
    queueRemoval(importable.filter((name) => existingNames.value.includes(name)))
    return
  }
  checked.value = [...new Set([...checked.value, ...importable])]
}

/** 用户改勾选：本渠道已有的被取消 → 二次确认；其余直接生效 */
function onChecked(next: string[]): void {
  const removed = checked.value.filter((name) => !next.includes(name) && existingNames.value.includes(name))
  checked.value = next
  queueRemoval(removed)
}

function queueRemoval(names: string[]): void {
  if (names.length === 0) return
  pendingRemoval.value = names.map((name) => {
    const hit = channelRoutesNow.value.find((route) => route.upstreamModel === name)
    return { upstreamModel: name, modelId: hit?.model.id ?? 0, modelName: hit?.model.name ?? name }
  })
  showConfirm.value = true
}

/** 取消：把勾选恢复回来 */
function cancelRemoval(): void {
  checked.value = [...new Set([...checked.value, ...pendingRemoval.value.map((item) => item.upstreamModel)])]
  pendingRemoval.value = []
  showConfirm.value = false
  discoverError.value = ''
}

/** 确认：PATCH 每个模型，把本渠道这条路由去掉 */
async function confirmRemoval(): Promise<void> {
  showConfirm.value = false
  const removing = pendingRemoval.value
  pendingRemoval.value = []
  const id = channelId.value
  if (id === null) return

  for (const item of removing) {
    const model = allModels.value.find((entry) => entry.id === item.modelId)
    if (!model) continue
    try {
      const saved = await updateRelayModel(model.id, {
        routes: routesWithoutChannel(model, id, item.upstreamModel),
      })
      allModels.value = allModels.value.map((entry) => (entry.id === saved.id ? saved : entry))
      message.success(`已从「${currentChannel.value?.name ?? '本渠道'}」移除 ${item.upstreamModel}`)
      emit('changed')
    } catch (cause) {
      errorText.value = describeError(cause).message
      checked.value = [...new Set([...checked.value, item.upstreamModel])]
    }
  }
}

function addManual(): void {
  const name = manual.value.trim()
  if (!name) return
  if (rows.value.some((row) => row.id === name)) {
    message.info('列表里已经有这个模型了')
    manual.value = ''
    return
  }
  const existingModel = allModels.value.find((model) => model.name === name)
  rows.value = [
    ...rows.value,
    { id: name, name: existingModel?.displayName ?? name, existingModelId: existingModel?.id ?? null },
  ]
  manualNames.value = [...manualNames.value, name]
  checked.value = [...checked.value, name]
  manual.value = ''
  search.value = ''
}

async function save(): Promise<void> {
  const id = channelId.value
  if (id === null) {
    message.warning('先选一个渠道')
    return
  }
  const entries = toImportEntries(rows.value, checked.value, existingNames.value)
  if (entries.length === 0) {
    message.info('没有要新加的模型')
    return
  }

  importing.value = true
  errorText.value = ''
  try {
    // 12 §10：不带 price —— 新模型先按「未定价」建出来，再去「模型与价格」定价
    const response = await importRelayModels({ channelId: id, models: entries })
    await load()
    result.value = { created: response.created, routesAdded: response.routesAdded }
    message.success(`已添加 ${response.created} 个模型，还没定价`)
    emit('changed')
  } catch (cause) {
    errorText.value = describeError(cause).message
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="picker">
    <div v-if="!channel" class="picker__channel">
      <span class="picker__label">渠道</span>
      <NSelect
        v-model:value="channelId"
        size="small"
        class="picker__channel-select"
        :options="channelOptions"
        placeholder="选一个渠道，再挑模型"
        data-testid="picker-channel"
      />
    </div>

    <NSpin :show="loading">
      <NAlert
        v-if="discoverError"
        type="warning"
        :bordered="false"
        class="picker__alert"
        data-testid="picker-discover-error"
      >
        拉取上游模型列表失败：{{ discoverError }}。可以手动添加模型名。
      </NAlert>
      <NAlert v-if="errorText" type="error" :bordered="false" class="picker__alert">{{ errorText }}</NAlert>

      <div v-if="result" class="picker__result" data-testid="picker-result">
        <p class="picker__result-text">已添加 {{ result.created }} 个模型，还没定价。</p>
        <div class="picker__result-actions">
          <NButton
            size="small"
            type="primary"
            data-testid="picker-goto-pricing"
            @click="emit('goto-pricing')"
          >
            去定价
          </NButton>
          <NButton size="small" @click="emit('dismiss')">{{ dismissText }}</NButton>
        </div>
      </div>

      <template v-else>
        <div class="picker__bar">
          <NInput
            v-model:value="search"
            size="small"
            class="picker__search"
            placeholder="搜索模型名"
            clearable
          />
          <span class="picker__count" data-testid="picker-count">
            已选 {{ checked.length }} / {{ filtered.length }} ·
            {{ rows.filter((row) => row.existingModelId !== null).length }} 个已有（只加渠道）
          </span>
          <NButton size="tiny" quaternary @click="toggleAll">全选 / 全不选</NButton>
        </div>

        <NCheckboxGroup
          :value="checked"
          @update:value="(value: (string | number)[]) => onChecked(value.map(String))"
        >
          <ul class="picker__list">
            <li v-for="row in filtered" :key="row.id" class="picker__item">
              <NCheckbox :value="row.id">
                <span class="picker__id">{{ row.id }}</span>
                <span v-if="row.name && row.name !== row.id" class="picker__name">{{ row.name }}</span>
              </NCheckbox>
              <div class="picker__meta">
                <MiniTag v-if="existingNames.includes(row.id)" text="已在本渠道" tone="success" size="sm" />
                <MiniTag
                  v-else-if="row.existingModelId !== null"
                  text="已有，只加渠道"
                  tone="butter"
                  size="sm"
                />
                <MiniTag v-else text="新建模型" tone="primary" size="sm" />
                <MiniTag :text="sourceTag(row).text" :tone="sourceTag(row).tone" size="sm" />
                <span class="picker__hint">{{ modelInfoSummary(row) || '没有参数，导入后请补全' }}</span>
              </div>
            </li>
            <li v-if="filtered.length === 0" class="picker__hint" data-testid="picker-empty">
              {{
                loading
                  ? '正在读取上游模型列表…'
                  : channelId === null
                    ? '先在上面选一个渠道。'
                    : '没有可选的模型，下面手动加一个。'
              }}
            </li>
          </ul>
        </NCheckboxGroup>

        <div class="picker__manual">
          <NInput
            v-model:value="manual"
            size="small"
            :disabled="channelId === null"
            placeholder="上游没有 /models 或列表里没有？输入模型名回车加一行"
            data-testid="picker-manual"
            @keyup.enter="addManual"
          />
          <NButton size="small" :disabled="channelId === null" @click="addManual">手动添加</NButton>
        </div>
      </template>
    </NSpin>

    <div v-if="!result" class="picker__actions">
      <NButton size="small" @click="emit('dismiss')">{{ dismissText }}</NButton>
      <NButton
        size="small"
        type="primary"
        :loading="importing"
        :disabled="newCount === 0 || channelId === null"
        data-testid="picker-submit"
        @click="save"
      >
        添加 {{ newCount }} 个模型
      </NButton>
    </div>

    <NModal
      :show="showConfirm"
      preset="card"
      title="从本渠道移除模型？"
      class="picker__confirm"
      :style="{ maxWidth: '460px' }"
      @update:show="(value: boolean) => (value ? undefined : cancelRemoval())"
    >
      <p class="picker__confirm-text">
        将把 {{ pendingRemoval.map((item) => item.modelName).join('、') }} 从「{{
          currentChannel?.name ?? '本渠道'
        }}」移除：只剩这个渠道的模型会变成「无渠道」，模型和价格保留。
      </p>
      <template #footer>
        <div class="picker__footer">
          <NButton size="small" @click="cancelRemoval">取消</NButton>
          <NButton size="small" type="error" data-testid="picker-confirm-remove" @click="confirmRemoval">
            确认移除
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.picker__channel {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.picker__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.picker__channel-select {
  max-width: 280px;
}

.picker__alert {
  border-radius: var(--radius-control);
}

.picker__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.picker__search {
  max-width: 200px;
}

.picker__count {
  flex: 1;
  min-width: 180px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.picker__list {
  display: flex;
  max-height: 320px;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  overflow-y: auto;
}

.picker__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.picker__id {
  font-family: var(--font-mono);
}

.picker__name {
  margin-left: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.picker__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-left: 24px;
}

.picker__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.picker__manual {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.picker__result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
}

.picker__result-text {
  color: var(--c-text);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.picker__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.picker__result-actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.picker__confirm-text {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.picker__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
