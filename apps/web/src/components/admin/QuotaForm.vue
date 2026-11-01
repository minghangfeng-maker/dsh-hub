<script setup lang="ts">
import type { Quota } from '@dsh-hub/shared'
import { NButton, NInputNumber, NSwitch } from 'naive-ui'
import { computed } from 'vue'

import { DEFAULT_QUOTA_VALUE } from '@dsh-hub/shared'

/**
 * 配额表单（07 §7.3 用户详情「环境」Tab）：字段 + 「恢复全局默认」。
 * WP33 加了 `idleNoClientMinutes`（没人看时多久休眠，docs/22 §6.2；0 = 沿用 idleStopMinutes）。
 *
 * `modelValue === null` 表示沿用全局默认配额；此时表单只读展示默认值，
 * 点「自定义」才把默认值灌进来开始编辑（04 §4.2：`quota: null` = 恢复默认）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: Quota | null
    /** 全局默认配额（来自系统设置，缺省用 03 §1.5 的默认值） */
    globalQuota?: Quota | null
    loading?: boolean
  }>(),
  { globalQuota: null, loading: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: Quota | null]
  /** 表单值变化（父组件用来置「有改动」） */
  change: []
}>()

const fallback = computed<Quota>(() => props.globalQuota ?? DEFAULT_QUOTA_VALUE)
const isDefault = computed(() => props.modelValue === null)
const current = computed<Quota>(() => props.modelValue ?? fallback.value)

function patch(part: Partial<Quota>): void {
  emit('update:modelValue', { ...current.value, ...part })
  emit('change')
}

function useCustom(): void {
  emit('update:modelValue', { ...fallback.value })
  emit('change')
}

function useDefault(): void {
  emit('update:modelValue', null)
  emit('change')
}
</script>

<template>
  <div class="quota-form">
    <div class="quota-form__head">
      <span v-if="isDefault" class="quota-form__badge">使用全局默认配额</span>
      <span v-else class="quota-form__badge quota-form__badge--custom">自定义配额</span>
      <NButton v-if="isDefault" size="tiny" :disabled="loading" @click="useCustom">自定义</NButton>
      <NButton v-else size="tiny" quaternary :disabled="loading" @click="useDefault">恢复默认</NButton>
    </div>

    <div class="quota-form__grid">
      <label class="quota-form__field">
        <span>CPU 核数</span>
        <NInputNumber
          :value="current.cpus"
          :min="0.5"
          :max="8"
          :step="0.5"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) => value !== null && patch({ cpus: value })"
        />
      </label>

      <label class="quota-form__field">
        <span>内存（MB）</span>
        <NInputNumber
          :value="current.memoryMb"
          :min="512"
          :max="8192"
          :step="256"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) => value !== null && patch({ memoryMb: value })"
        />
      </label>

      <label class="quota-form__field">
        <span>进程数上限</span>
        <NInputNumber
          :value="current.pidsLimit"
          :min="64"
          :max="8192"
          :step="64"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) => value !== null && patch({ pidsLimit: value })"
        />
      </label>

      <label class="quota-form__field">
        <span>磁盘（GB）</span>
        <NInputNumber
          :value="current.diskGb"
          :min="1"
          :max="200"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) => value !== null && patch({ diskGb: value })"
        />
      </label>

      <label class="quota-form__field">
        <span>空闲回收（分钟）</span>
        <NInputNumber
          :value="current.idleStopMinutes"
          :min="0"
          :max="10080"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) => value !== null && patch({ idleStopMinutes: value })"
        />
      </label>

      <label class="quota-form__field">
        <span>没人看时休眠（分钟）</span>
        <NInputNumber
          :value="current.idleNoClientMinutes"
          :min="0"
          :max="10080"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: number | null) =>
            value !== null && patch({ idleNoClientMinutes: value })
          "
        />
      </label>

      <label class="quota-form__field quota-form__field--switch">
        <span>允许自助安装插件</span>
        <NSwitch
          :value="current.allowUserPlugins"
          size="small"
          :disabled="isDefault || loading"
          @update:value="(value: boolean) => patch({ allowUserPlugins: value })"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.quota-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.quota-form__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.quota-form__badge {
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}

.quota-form__badge--custom {
  background: var(--c-sky-soft);
  color: var(--c-sky-ink);
}

.quota-form__grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.quota-form__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.quota-form__field--switch {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
</style>
