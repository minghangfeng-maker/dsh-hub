<script setup lang="ts">
import type { UserAdminView } from '@dsh-hub/shared'
import { NSelect } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { listUsers } from '@/api/admin-users'

/**
 * 「开放给」的用户多选（18 §6）：远程搜索管理端用户列表（`GET /api/admin/users?q=`）。
 *
 * 选中项单独缓存一份标签：搜索换了关键词、选项里没有它时，标签仍然显示用户名而不是 `#id`。
 */
const props = defineProps<{ modelValue: number[] }>()

const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>()

const options = ref<{ label: string; value: number }[]>([])
const loading = ref(false)
const known = ref(new Map<number, string>())
let timer: ReturnType<typeof setTimeout> | null = null
let requestId = 0

function labelOf(user: UserAdminView): string {
  const name = user.displayName ? `${user.displayName}（@${user.username}）` : `@${user.username}`
  return name
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
    // 搜索失败就让用户继续用已选的内容；表单保存时后端还会再校验一次
  } finally {
    if (current === requestId) loading.value = false
  }
}

function onSearch(keyword: string): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => void search(keyword), 250)
}

/** 选中但不在当前搜索结果里的用户也要有标签，否则 Naive 只显示 id */
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
    multiple
    filterable
    remote
    :options="mergedOptions"
    :loading="loading"
    :clear-filter-after-select="false"
    placeholder="搜索用户名或昵称"
    :max-tag-count="'responsive'"
    data-testid="agent-mode-user-picker"
    @search="onSearch"
    @update:value="(value: number[]) => emit('update:modelValue', value)"
  />
</template>
