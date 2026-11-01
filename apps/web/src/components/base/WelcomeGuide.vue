<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { markWelcomeSeen } from '@/composables/useWelcomeGuide'

/**
 * 注册后的一次性欢迎引导（07 §5.2：3 步气泡：这是你的 DSH → 点这里打开 → 这里能导出数据）。
 * 状态（是否看过 / 何时触发）在 composables/useWelcomeGuide.ts，注册页跳转后由 App.vue 挂载。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()

const STEPS = [
  {
    icon: 'i-ph-rocket-launch',
    title: '这是你的 DSH',
    // 一次性引导（07 §5.2）：只在注册后的第一次进工作台时出现，文案保持一句话
    text: '工作台中间那张卡片，只有你能打开。',
  },
  {
    icon: 'i-ph-cursor-click',
    title: '点这里打开',
    text: '第一次打开会先启动容器，几秒钟就好。',
  },
  {
    icon: 'i-ph-airplane-takeoff',
    title: '这里能导出数据',
    text: '在工作台的「我的数据」里随时把数据带走。',
  },
] as const

const step = ref(0)
const current = computed(() => STEPS[step.value] ?? STEPS[0])
const isLast = computed(() => step.value >= STEPS.length - 1)

watch(
  () => props.show,
  (visible) => {
    if (visible) step.value = 0
  },
)

function finish(): void {
  markWelcomeSeen()
  emit('update:show', false)
}

function next(): void {
  if (isLast.value) finish()
  else step.value += 1
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="欢迎加入，先看三步"
    class="welcome-guide"
    :style="{ maxWidth: '440px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="welcome-guide__body">
      <span :class="current.icon" class="welcome-guide__icon" aria-hidden="true" />
      <div>
        <p class="welcome-guide__title">{{ current.title }}</p>
        <p class="welcome-guide__text">{{ current.text }}</p>
      </div>
    </div>

    <div class="welcome-guide__dots" aria-hidden="true">
      <span
        v-for="(item, index) in STEPS"
        :key="item.title"
        class="welcome-guide__dot"
        :class="{ 'welcome-guide__dot--active': index === step }"
      />
    </div>

    <template #footer>
      <div class="welcome-guide__footer">
        <NButton quaternary @click="finish">跳过</NButton>
        <NButton type="primary" round @click="next">{{ isLast ? '开始使用' : '下一步' }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.welcome-guide__body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.welcome-guide__icon {
  color: var(--c-primary);
  font-size: 28px;
}

.welcome-guide__title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.welcome-guide__text {
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.welcome-guide__dots {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.welcome-guide__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-border);
}

.welcome-guide__dot--active {
  background: var(--c-primary);
}

.welcome-guide__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
