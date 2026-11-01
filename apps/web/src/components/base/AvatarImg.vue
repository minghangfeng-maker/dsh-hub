<script setup lang="ts">
import { computed } from 'vue'

/**
 * 头像（07 §6.2）：有图用图；没有头像时用昵称首字 + 由 slug 派生的柔和底色。
 * 底色从 5 组令牌色里按 hash 取，稳定且不刺眼。
 */
const props = withDefaults(
  defineProps<{
    /** 头像地址（`/api/avatars/…`）；为空则用首字兜底 */
    src?: string | null
    /** 昵称或用户名（取首字） */
    name?: string
    /** 派生底色的种子，一般传用户 slug（保证同一用户颜色固定） */
    seed?: string
    /** 直径 px */
    size?: number
    /** 是否描边（樱花粉细边） */
    bordered?: boolean
  }>(),
  { src: null, name: '', seed: '', size: 40, bordered: false },
)

/** 5 组柔和底色：底 + 字（都来自令牌，不写死色值）。 */
const PALETTE = [
  { background: 'var(--c-primary-soft)', color: 'var(--c-primary-press)' },
  { background: 'var(--c-sky-soft)', color: 'var(--c-sky-ink)' },
  { background: 'var(--c-sakura-soft)', color: 'var(--c-sakura-ink)' },
  { background: 'var(--c-butter-soft)', color: 'var(--c-butter-ink)' },
  { background: 'var(--c-danger-soft)', color: 'var(--c-danger-ink)' },
] as const

const initial = computed(() => {
  const source = props.name.trim()
  if (!source) return '？'
  // 取第一个「字」：emoji / 代理对也要完整（Array.from 按码点切）
  const [first] = Array.from(source)
  return (first ?? '？').toUpperCase()
})

const palette = computed(() => {
  const seed = props.seed || props.name || 'dsh'
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) % 100000
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]
})

const boxStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.max(12, Math.round(props.size * 0.42))}px`,
  background: palette.value.background,
  color: palette.value.color,
}))
</script>

<template>
  <span
    class="avatar-img"
    :class="{ 'avatar-img--bordered': bordered }"
    :style="boxStyle"
    :title="name || undefined"
  >
    <img v-if="src" :src="src" :alt="name ? `${name} 的头像` : '头像'" class="avatar-img__img" />
    <span v-else aria-hidden="true">{{ initial }}</span>
    <span v-if="!src && name" class="avatar-img__sr">{{ name }}</span>
  </span>
</template>

<style scoped>
.avatar-img {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  font-weight: var(--fw-semibold);
  line-height: 1;
  user-select: none;
}

.avatar-img--bordered {
  box-shadow: 0 0 0 2px var(--c-sakura-soft);
}

.avatar-img__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-img__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
