<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, type Component } from 'vue'

import BubbleCat from '@/components/illustrations/BubbleCat.vue'
import CloudNap from '@/components/illustrations/CloudNap.vue'
import KeyLeaf from '@/components/illustrations/KeyLeaf.vue'
import LeafSprout from '@/components/illustrations/LeafSprout.vue'
import PaperPlane from '@/components/illustrations/PaperPlane.vue'

/**
 * 空状态（07 §2.6）：插画 + 文案 + 一个主要操作。
 * 插画按名字选（默认新芽），也可以直接用 `#illustration` 插槽换成任意内容。
 */
const ILLUSTRATIONS: Record<string, Component> = {
  leaf: LeafSprout,
  cloud: CloudNap,
  plane: PaperPlane,
  cat: BubbleCat,
  key: KeyLeaf,
}

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 插画名：leaf / cloud / plane / cat / key */
    illustration?: keyof typeof ILLUSTRATIONS | string
    /** 操作按钮文案（配合 `@action`） */
    actionText?: string
    /** 操作按钮跳转路径（给了就用 RouterLink） */
    actionTo?: string
    size?: number
  }>(),
  { description: undefined, illustration: 'leaf', actionText: undefined, actionTo: undefined, size: 132 },
)

const emit = defineEmits<{ action: [] }>()

const illustration = computed(() => ILLUSTRATIONS[props.illustration] ?? LeafSprout)
</script>

<template>
  <div class="empty-state">
    <div class="empty-state__art" aria-hidden="true">
      <slot name="illustration">
        <component :is="illustration" :size="size" animated />
      </slot>
    </div>

    <p class="empty-state__title">{{ title }}</p>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>

    <div v-if="actionText" class="empty-state__action">
      <RouterLink v-if="actionTo" :to="actionTo">
        <NButton type="primary" round>{{ actionText }}</NButton>
      </RouterLink>
      <NButton v-else type="primary" round @click="emit('action')">{{ actionText }}</NButton>
    </div>

    <div v-if="$slots.default" class="empty-state__extra">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-8) var(--space-4);
  text-align: center;
}

.empty-state__art {
  margin-bottom: var(--space-4);
}

.empty-state__title {
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.empty-state__desc {
  max-width: 420px;
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.empty-state__action {
  margin-top: var(--space-4);
}

.empty-state__extra {
  margin-top: var(--space-4);
  width: 100%;
}
</style>
