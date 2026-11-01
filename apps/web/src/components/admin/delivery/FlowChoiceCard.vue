<script setup lang="ts">
/**
 * 下发流程（WP57）「内容」「端」两步的大卡片：图标 + 标题 + 一行数据（不是说明小字），
 * 选中时描边 + 角标勾。`tone` 给端用：云端蓝 / 桌面端紫；内容卡用品牌主色。
 * 不可选时整卡置灰，原因放在卡片底部（这是「为什么点不了」，不是常驻说明）。
 */
withDefaults(
  defineProps<{
    title: string
    icon: string
    meta?: string
    selected?: boolean
    disabledReason?: string | null
    tone?: 'primary' | 'cloud' | 'desktop'
  }>(),
  { meta: '', selected: false, disabledReason: null, tone: 'primary' },
)

const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button
    type="button"
    class="flow-choice"
    :class="[
      `flow-choice--${tone}`,
      { 'flow-choice--selected': selected, 'flow-choice--disabled': disabledReason !== null },
    ]"
    role="radio"
    :aria-checked="selected"
    :aria-disabled="disabledReason !== null"
    @click="disabledReason === null && emit('select')"
  >
    <span class="flow-choice__icon" aria-hidden="true"><span :class="icon" /></span>
    <span class="flow-choice__title">{{ title }}</span>
    <span v-if="meta" class="flow-choice__meta">{{ meta }}</span>
    <span v-if="disabledReason" class="flow-choice__reason">{{ disabledReason }}</span>
    <span class="flow-choice__check i-ph-check-circle-fill" aria-hidden="true" />
  </button>
</template>

<style scoped>
.flow-choice {
  --tone: var(--c-primary);
  --tone-soft: var(--c-primary-soft);
  --tone-ink: var(--c-primary-press);

  position: relative;
  display: flex;
  min-height: 168px;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-6);
  border: 1.5px solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
  color: var(--c-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    border-color var(--duration-base) var(--ease-out-soft),
    box-shadow var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft),
    background-color var(--duration-base) var(--ease-out-soft);
}

.flow-choice--cloud {
  --tone: var(--c-plat-cloud);
  --tone-soft: var(--c-plat-cloud-soft);
  --tone-ink: var(--c-plat-cloud-ink);
}

.flow-choice--desktop {
  --tone: var(--c-plat-desktop);
  --tone-soft: var(--c-plat-desktop-soft);
  --tone-ink: var(--c-plat-desktop-ink);
}

.flow-choice:hover:not(.flow-choice--disabled) {
  border-color: color-mix(in srgb, var(--tone) 45%, var(--c-border));
  transform: translateY(-2px);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--tone) 14%, transparent);
}

.flow-choice:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 30%, transparent);
}

.flow-choice--selected {
  border-color: var(--tone);
  background: linear-gradient(160deg, var(--c-surface) 40%, var(--tone-soft));
  box-shadow: 0 10px 28px color-mix(in srgb, var(--tone) 18%, transparent);
}

.flow-choice__icon {
  display: inline-flex;
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-2);
  border-radius: 14px;
  background: var(--tone-soft);
  color: var(--tone-ink);
  font-size: 26px;
  transition:
    background-color var(--duration-base) var(--ease-out-soft),
    color var(--duration-base) var(--ease-out-soft);
}

.flow-choice--selected .flow-choice__icon {
  background: var(--tone);
  color: var(--c-plat-on);
}

.flow-choice__title {
  font-size: var(--fs-18);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.flow-choice__meta {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.flow-choice__reason {
  margin-top: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.flow-choice__check {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  color: var(--tone);
  font-size: 24px;
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft);
}

.flow-choice--selected .flow-choice__check {
  opacity: 1;
  transform: none;
}

.flow-choice--disabled {
  cursor: not-allowed;
  opacity: 0.55;
  box-shadow: none;
}
</style>
