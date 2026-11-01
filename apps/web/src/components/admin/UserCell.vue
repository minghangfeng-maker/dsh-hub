<script setup lang="ts">
import type { UserRef } from '@dsh-hub/shared'

import AvatarImg from '@/components/base/AvatarImg.vue'

/**
 * 用户单元格：头像 + 用户名 + 昵称（列表页与任务表共用）。
 * `to` 给了就整块可点（管理端用户详情）。
 */
withDefaults(
  defineProps<{
    user:
      | UserRef
      | { id: number; username: string; displayName?: string; avatarUrl?: string | null; slug?: string }
    to?: string
    size?: number
    /** 是否显示昵称第二行 */
    showDisplayName?: boolean
  }>(),
  { to: undefined, size: 32, showDisplayName: true },
)
</script>

<template>
  <component :is="to ? 'RouterLink' : 'div'" :to="to" class="user-cell">
    <AvatarImg
      :src="user.avatarUrl ?? null"
      :name="user.displayName || user.username"
      :seed="user.slug ?? user.username"
      :size="size"
    />
    <span class="user-cell__body">
      <span class="user-cell__name">{{ user.username }}</span>
      <span v-if="showDisplayName && user.displayName" class="user-cell__display">{{
        user.displayName
      }}</span>
    </span>
  </component>
</template>

<style scoped>
.user-cell {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  color: inherit;
}

.user-cell__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.35;
}

.user-cell__name {
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-cell__display {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
