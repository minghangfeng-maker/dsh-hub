<script setup lang="ts">
import type { MyToolsResponse } from '@dsh-hub/shared'
import { onMounted, ref } from 'vue'

import { fetchMyTools } from '@/api/tools'
import { describeError } from '@/api/errors'
import SoftCard from '@/components/base/SoftCard.vue'
import UsageBar from '@/components/base/UsageBar.vue'
import { formatCount } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 「积分与用量」的「搜索与抓取」卡片（14 §7；19 §2.4 起**只显示本月用量三格**）：
 * 本月免费（进度条）、本月调用（次）、本月花费（积分）。逐条明细收进「使用记录」的「搜索与抓取」标签。
 *
 * 总开关关闭（`enabled=false`）时整张卡片不渲染 —— 与 14 §3.2「关掉后用户页隐藏」一致。
 */
const data = ref<MyToolsResponse | null>(null)
const errorText = ref('')

/** 上报总开关状态：页面据此决定「使用记录」里要不要出现「搜索与抓取」标签（避免重复请求） */
const emit = defineEmits<{ 'update:enabled': [enabled: boolean] }>()

async function reload(): Promise<void> {
  try {
    data.value = await fetchMyTools()
    errorText.value = ''
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    emit('update:enabled', data.value?.enabled === true)
  }
}

onMounted(() => {
  void reload()
})

defineExpose({ reload })
</script>

<template>
  <SoftCard v-if="data && data.enabled" title="搜索与抓取" data-testid="tools-card">
    <div class="tools-card__summary">
      <div class="tools-card__block">
        <p class="tools-card__label">本月免费</p>
        <!-- 19 §2.4：标签留在块头，进度条只显示 `已用 / 上限` 与条本身 -->
        <UsageBar
          v-if="data.freeCallsPerMonth > 0"
          :used="data.freeUsed"
          :limit="data.freeCallsPerMonth"
          unit="count"
          label="本月免费"
          hide-label
        />
        <p v-else class="tools-card__value tools-card__value--muted">—</p>
      </div>

      <div class="tools-card__block">
        <p class="tools-card__label">本月调用</p>
        <p class="tools-card__value">{{ formatCount(data.monthCalls) }} 次</p>
      </div>

      <div class="tools-card__block">
        <p class="tools-card__label">本月花费</p>
        <p class="tools-card__value">{{ formatPoints(data.monthCostMicro) }} 积分</p>
      </div>
    </div>

    <p v-if="errorText" class="tools-card__error">{{ errorText }}</p>
  </SoftCard>
</template>

<style scoped>
.tools-card__summary {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.tools-card__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.tools-card__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

/* 「132 次」「0 积分」这类数字 + 单位不断行（07 §2.8） */
.tools-card__value {
  color: var(--c-text);
  font-size: var(--fs-13);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tools-card__value--muted {
  color: var(--c-text-3);
}

.tools-card__error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}
</style>
