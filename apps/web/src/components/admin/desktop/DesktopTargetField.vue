<script setup lang="ts">
import type { Role } from '@dsh-hub/shared'
import { NRadio, NRadioGroup, NSelect } from 'naive-ui'
import { computed } from 'vue'

import DesktopUserPicker from '@/components/admin/desktop/DesktopUserPicker.vue'
import { targetOfDraft, type TargetDraft } from '@/utils/desktop-delivery'

/**
 * 下发目标：全部设备 / 角色 / 指定用户。
 *
 * 契约 `DesktopDeliveryTargetSchema` 是判别联合（`scope` 决定其余字段），这里用一个草稿对象承载三种形态，
 * 提交前由 `targetOfDraft()` 折成契约形状（指定用户没选人时返回 null，调用方提示「先选一个用户」）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: TargetDraft
    /** 配置片段与插件都允许「全部」，覆盖项则只有角色/用户 */
    allowAll?: boolean
    disabled?: boolean
    size?: 'small' | 'medium'
  }>(),
  { allowAll: true, disabled: false, size: 'small' },
)

const emit = defineEmits<{ 'update:modelValue': [value: TargetDraft] }>()

const selectedUserId = computed<number[]>(() =>
  props.modelValue.userId === null ? [] : [props.modelValue.userId],
)

function patch(next: Partial<TargetDraft>): void {
  emit('update:modelValue', { ...props.modelValue, ...next })
}

const roleOptions: { label: string; value: Role }[] = [
  { label: '普通用户', value: 'user' },
  { label: '管理员', value: 'admin' },
]

/** 指定用户还没选人时为 null（父组件据此提示） */
const resolved = computed(() => targetOfDraft(props.modelValue))
</script>

<template>
  <div class="desktop-target" data-testid="desktop-target">
    <NRadioGroup
      :value="modelValue.scope"
      :disabled="disabled"
      :size="size"
      data-testid="desktop-target-scope"
      @update:value="(value: 'all' | 'role' | 'user') => patch({ scope: value })"
    >
      <NRadio v-if="allowAll" value="all" data-testid="desktop-target-all">全部设备</NRadio>
      <NRadio value="role" data-testid="desktop-target-role">角色</NRadio>
      <NRadio value="user" data-testid="desktop-target-user">指定用户</NRadio>
    </NRadioGroup>

    <NSelect
      v-if="modelValue.scope === 'role'"
      class="desktop-target__role"
      :value="modelValue.role"
      :options="roleOptions"
      :disabled="disabled"
      :size="size"
      data-testid="desktop-target-role-select"
      @update:value="(value: Role) => patch({ role: value })"
    />

    <DesktopUserPicker
      v-if="modelValue.scope === 'user'"
      class="desktop-target__user"
      :model-value="selectedUserId"
      :disabled="disabled"
      :size="size"
      data-testid="desktop-target-user-select"
      @update:model-value="(ids: number[]) => patch({ userId: ids[0] ?? null })"
    />

    <span v-if="modelValue.scope === 'user' && resolved === null" class="desktop-target__missing" role="alert">
      选一个用户
    </span>
  </div>
</template>

<style scoped>
.desktop-target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.desktop-target__role {
  width: 132px;
}

.desktop-target__user {
  width: 240px;
  max-width: 100%;
}

.desktop-target__missing {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}
</style>
