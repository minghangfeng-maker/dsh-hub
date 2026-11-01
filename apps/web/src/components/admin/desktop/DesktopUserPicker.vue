<script setup lang="ts">
import type { UserAdminView } from '@dsh-hub/shared'
import { NSelect } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { listUsers } from '@/api/admin-users'

/**
 * 指定用户单选（目标选择、模型预设取数用）：远程搜索管理端用户（`GET /api/admin/users?q=`）。
 *
 * 选中项单独缓存标签：换了关键词、搜索结果里没有它时，仍显示「昵称（@用户名）」而不是 `#id`。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number[]
    disabled?: boolean
    size?: 'small' | 'medium'
  }>(),
  { disabled: false, size: 'small' },
)

const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>()

const options = ref<{ label: string; value: number }[]>([])
const loading = ref(false)
const known = ref(new Map<number, string>())
let timer: ReturnType<typeof setTimeout> | null = null
let requestId = 0

function labelOf(user: UserAdminView): string {
  return user.displayName ? `${user.displayName}（@${user.username}）` : `@${user.username}`
}

async function search(keyword: string): Promise<void> {
  const current = ++requestId
  loading.value = true
  try {
    const page = await listUsers({ q: keyword.trim() || undefined, pageSize: 20 })
    if (current !== requestId) return
    for (const user of page.items) known.value.set(user.id, labelOf(user))
    options.value = page.items.map((user) => ({ label: labelOf(user), value: user.id }))
  } catch {
    // 搜不到就继续用已选的内容；保存时后端还会校验一次
  } finally {
    if (current === requestId) loading.value = false
  }
}

function onSearch(keyword: string): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => void search(keyword), 250)
}

const mergedOptions = computed(() => {
  const seen = new Set(options.value.map((option) => option.value))
  const extras = props.modelValue
    .filter((id) => !seen.has(id))
    .map((id) => ({ label: known.value.get(id) ?? `#${id}`, value: id }))
  return [...options.value, ...extras]
})

onMounted(() => {
  void search('')
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <NSelect
    :value="modelValue"
    filterable
    remote
    :options="mergedOptions"
    :loading="loading"
    :disabled="disabled"
    :size="size"
    :clear-filter-after-select="false"
    placeholder="搜索用户名或昵称"
    data-testid="desktop-user-picker"
    @search="onSearch"
    @update:value="(value: number[]) => emit('update:modelValue', value)"
  />
</template>
