<script setup lang="ts">
import { DSH_HUB_PROVIDER_NAME, type ModelPolicy } from '@dsh-hub/shared'
import { computed } from 'vue'

import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatPoints } from '@/utils/points'

/** 04 §3.1 的 modelSummary（WP5b 只读展示；WP12 起不再显示预设名） */
const props = withDefaults(
  defineProps<{
    summary: { preset: string; defaultModel: string; providers: string[]; policy?: ModelPolicy } | null
    loading?: boolean
    /** 中转站积分（12 §10：`enabled=false` 时由调用方传 null，不显示这一行） */
    points?: { balanceMicro: number; monthCostMicro: number } | null
  }>(),
  { loading: false, points: null },
)

/**
 * 统一管理（managed）= 管理员在「模型 → 下发到 DSH」里配好的模型，带锁；
 * 老响应没有 `policy` 时退回 WP5b 的推断（有预设 = 统一管理）。
 */
const managed = computed(() =>
  props.summary?.policy ? props.summary.policy === 'managed' : (props.summary?.preset ?? '').length > 0,
)

/** 12 §10：统一管理时用户的模型都来自中转站，可用提供方胶囊只显示「DSH Hub」（WP13 起用契约常量） */
const providers = computed(() => (managed.value ? [DSH_HUB_PROVIDER_NAME] : (props.summary?.providers ?? [])))
</script>

<template>
  <SoftCard title="我的模型">
    <template #title-extra>
      <InfoTip
        v-if="managed"
        label="模型由管理员统一配置"
        text="由管理员统一配置，在 DSH 设置页修改不会生效。"
      />
    </template>
    <template #extra>
      <span v-if="managed" class="i-ph-lock-key text-[16px] text-3" aria-label="由管理员统一配置" />
    </template>

    <div v-if="loading" class="skeleton h-[64px] rounded-control" aria-hidden="true" />

    <template v-else-if="summary">
      <p class="text-[20px] font-semibold text-1">{{ summary.defaultModel }}</p>
      <p class="mt-1 text-[13px] text-2">
        {{ managed ? '由管理员统一配置' : '由你自己配置' }}
      </p>

      <div class="mt-3 flex flex-wrap gap-2">
        <span v-for="provider in providers" :key="provider" class="hub-chip">{{ provider }}</span>
        <span v-if="providers.length === 0" class="hub-muted">还没有可用提供方</span>
      </div>

      <!-- 12 §10：中转站开通时加一行积分余额与本月消耗，链到 /usage -->
      <RouterLink v-if="points" to="/usage" class="model-card__points">
        <span class="i-ph-arrows-left-right" aria-hidden="true" />
        <span class="model-card__points-text">
          <span>积分余额 {{ formatPoints(points.balanceMicro) }}</span>
          <span>本月已用 {{ formatPoints(points.monthCostMicro) }}</span>
        </span>
        <span class="i-ph-arrow-right model-card__points-arrow" aria-hidden="true" />
      </RouterLink>
    </template>

    <p v-else class="hub-muted">实例启动后就能看到模型信息了。</p>
  </SoftCard>
</template>

<style scoped>
.model-card__points {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--border-width) solid var(--c-border);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.model-card__points:hover {
  color: var(--c-primary-press);
}

/* 「积分余额 12,345.67」这类成对数据各自不断行，窄屏时两组之间换行（07 §2.8） */
.model-card__points-text {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  min-width: 0;
}

.model-card__points-text > span {
  white-space: nowrap;
}

.model-card__points-arrow {
  margin-left: auto;
}
</style>
