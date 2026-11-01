<script setup lang="ts">
import type { CatalogResponse, ModelSpec } from '@dsh-hub/shared'
import { NAlert, NButton, NDrawer, NDrawerContent, NInput, useMessage } from 'naive-ui'
import { ref, watch } from 'vue'

import { deleteCatalogEntry, getCatalog, matchModels, saveCatalog } from '@/api/admin-models'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import ModelParamsFields from '@/components/admin/ModelParamsFields.vue'
import { hasModelInfo, modelInfoSummary, toCatalogInput } from '@/components/admin/model-info'
import { thinkingLevelsProblem } from '@/components/admin/thinking-levels'

/**
 * 模型信息库（自定义部分）：按模型名存上下文 / 最大输出 / 输入类型 / 思考档位，
 * 从端点发现模型、按库补全时优先于内置库（内置库来自 pi-ai 自带的模型目录，只读）。
 * 已保存的条目不能改名（名字是匹配键）：要改名就删掉重建。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()

const message = useMessage()

/** 一行：`key` 为空 = 还没保存过的新条目；`name` 在这里恒为空串（库条目的显示名不在这个界面编辑） */
type Row = ModelSpec & { key: string | null }

const rows = ref<Row[]>([])
const builtin = ref<CatalogResponse['builtin'] | null>(null)
const loading = ref(false)
const saving = ref(false)
const errorText = ref('')

function toRows(catalog: CatalogResponse): Row[] {
  return catalog.custom.map(({ updatedAt: _updatedAt, ...entry }) => ({
    ...entry,
    name: entry.name ?? '',
    key: entry.key,
  }))
}

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const catalog = await getCatalog()
    rows.value = toRows(catalog)
    builtin.value = catalog.builtin
  } catch (cause) {
    errorText.value = describeError(cause).message
  } finally {
    loading.value = false
  }
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    lookupText.value = ''
    lookupNote.value = ''
    void load()
  },
)

function patchRow(index: number, patch: Partial<Row>): void {
  rows.value = rows.value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
}

function addRow(seed: Partial<Row> = {}): void {
  rows.value = [{ id: '', name: '', key: null, ...seed }, ...rows.value]
}

async function removeRow(index: number): Promise<void> {
  const row = rows.value[index]
  if (!row) return
  if (row.key) {
    try {
      await deleteCatalogEntry(row.key)
    } catch (cause) {
      message.error(describeError(cause).message)
      return
    }
    message.success(`已从模型库删除 ${row.id}`)
  }
  rows.value = rows.value.filter((_, rowIndex) => rowIndex !== index)
}

async function save(): Promise<void> {
  errorText.value = ''
  const filled = rows.value.filter((row) => row.id.trim() || hasModelInfo(row))
  const nameless = filled.find((row) => !row.id.trim())
  if (nameless) {
    errorText.value = '有一条填了参数但没有模型名'
    return
  }
  const empty = filled.find((row) => !hasModelInfo(row))
  if (empty) {
    errorText.value = `模型 ${empty.id} 还没有填任何参数`
    return
  }
  const problem = thinkingLevelsProblem(filled)
  if (problem) {
    errorText.value = problem
    return
  }
  if (filled.length === 0) {
    message.info('没有需要保存的条目')
    return
  }
  saving.value = true
  try {
    const catalog = await saveCatalog(filled.map((row) => toCatalogInput(row)))
    rows.value = toRows(catalog)
    builtin.value = catalog.builtin
    message.success(`已保存 ${filled.length} 条`)
  } catch (cause) {
    errorText.value = describeError(cause).message
  } finally {
    saving.value = false
  }
}

// ── 查询：看看库对某个模型名的认识（可以直接拿来当起点）──

const lookupText = ref('')
const lookupNote = ref('')
const lookupSeed = ref<Partial<Row> | null>(null)
const looking = ref(false)

async function lookup(): Promise<void> {
  const id = lookupText.value.trim()
  if (!id) return
  looking.value = true
  lookupSeed.value = null
  try {
    const { matches } = await matchModels([id])
    const hit = matches[0]
    if (hit) {
      const { id: _id, source, matchedId, ...info } = hit
      const summary = modelInfoSummary(info)
      if (source === 'custom') {
        // 已经是自定义条目：直接在下面的列表里改，再加一行只会重复
        lookupNote.value = `自定义 · ${matchedId}：${summary}（已在下面的列表里，直接修改即可）`
      } else {
        lookupNote.value = `内置库 · ${matchedId}：${summary}`
        lookupSeed.value = { id, ...info, name: '' }
      }
    } else {
      lookupNote.value = '库里没有这个模型（规则是精确匹配，不做模糊匹配）。'
      lookupSeed.value = { id, name: '' }
    }
  } catch (cause) {
    lookupNote.value = describeError(cause).message
  } finally {
    looking.value = false
  }
}

function addFromLookup(): void {
  if (!lookupSeed.value) return
  addRow(lookupSeed.value)
  lookupText.value = ''
  lookupNote.value = ''
  lookupSeed.value = null
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="720"
    placement="right"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NDrawerContent closable>
      <template #header>
        模型信息库
        <InfoTip
          label="匹配规则"
          text="发现模型或「按模型库补全」时按模型名查上下文、最大输出、输入类型与思考档位。匹配忽略大小写、厂商前缀（如 deepseek/）、日期后缀与 . _ - 的写法差异；自定义条目优先，不做模糊匹配。"
        />
      </template>
      <p v-if="builtin" class="catalog__source">
        内置库 {{ builtin.count }} 条 · {{ builtin.source }} · 只读
      </p>

      <div class="catalog__lookup">
        <NInput
          v-model:value="lookupText"
          size="small"
          placeholder="查一个模型名，看库里怎么认识它，如 deepseek-v4.1-flash"
          clearable
          @keydown.enter="lookup"
        />
        <NButton size="small" :loading="looking" :disabled="!lookupText.trim()" @click="lookup">查询</NButton>
      </div>
      <div v-if="lookupNote" class="catalog__note">
        <span>{{ lookupNote }}</span>
        <NButton v-if="lookupSeed" size="tiny" quaternary @click="addFromLookup">加入自定义（可改）</NButton>
      </div>

      <div class="catalog__head">
        <span class="catalog__section">自定义条目 · {{ rows.length }}</span>
        <NButton size="tiny" @click="addRow()">
          <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
          添加
        </NButton>
      </div>

      <ul class="catalog__rows">
        <li v-for="(row, index) in rows" :key="row.key ?? `new-${index}`" class="catalog__row">
          <div class="catalog__row-head">
            <NInput
              :value="row.id"
              size="small"
              placeholder="模型名，如 my-relay/deepseek-chat"
              :disabled="row.key !== null"
              @update:value="(value: string) => patchRow(index, { id: value })"
            />
            <MiniTag v-if="row.key" text="已保存" tone="primary" size="sm" />
            <MiniTag v-else text="未保存" tone="butter" size="sm" />
            <NButton size="tiny" quaternary aria-label="删除这一条" @click="removeRow(index)">
              <span class="i-ph-trash" aria-hidden="true" />
            </NButton>
          </div>
          <ModelParamsFields :model="row" @patch="(patch) => patchRow(index, patch)" />
        </li>
      </ul>
      <p v-if="!loading && rows.length === 0" class="catalog__empty">
        还没有自定义条目。常见用法：中转站把某个模型的输出上限改小了，或者内部自建模型库里没有。
      </p>

      <NAlert v-if="errorText" type="error" :bordered="false" class="catalog__alert">{{ errorText }}</NAlert>

      <template #footer>
        <div class="catalog__footer">
          <NButton size="small" @click="emit('update:show', false)">关闭</NButton>
          <NButton size="small" type="primary" :loading="saving" @click="save">保存</NButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.catalog__alert {
  margin-bottom: var(--space-3);
  border-radius: var(--radius-control);
}

.catalog__lookup {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1fr) auto;
  margin-bottom: var(--space-2);
}

.catalog__source {
  margin-bottom: var(--space-3);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.catalog__note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.catalog__head {
  display: flex;
  align-items: center;
  margin: var(--space-3) 0 var(--space-2);
}

.catalog__section {
  margin-right: auto;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.catalog__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.catalog__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.catalog__row-head {
  display: grid;
  align-items: center;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.catalog__empty {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.catalog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
