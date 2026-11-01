<script setup lang="ts">
import type { AuditItem } from '@dsh-hub/shared'

import JsonCollapse from '@/components/admin/JsonCollapse.vue'
import { auditActionIcon, auditActionText } from '@/composables/audit-actions'
import { formatDateTime, fromNow } from '@/composables/useFormat'

/**
 * 审计时间线（07 §7.10）：左侧细轴 + 圆点，右侧动作、操作者、目标与本机时间；
 * 每条可展开原始 `detail` JSON。
 */
withDefaults(
  defineProps<{
    items: AuditItem[]
    /** 紧凑模式（概览页的最近审计） */
    compact?: boolean
    emptyText?: string
  }>(),
  { compact: false, emptyText: '还没有审计记录' },
)
</script>

<template>
  <ol class="audit-timeline" :class="{ 'audit-timeline--compact': compact }">
    <li v-for="item in items" :key="item.id" class="audit-item">
      <span class="audit-item__dot" :class="auditActionIcon(item.action)" aria-hidden="true" />
      <div class="audit-item__body">
        <p class="audit-item__title">
          {{ auditActionText(item.action) }}
          <span v-if="item.targetType" class="audit-item__target">
            {{ item.targetType }}<template v-if="item.targetId"> #{{ item.targetId }}</template>
          </span>
        </p>
        <p class="audit-item__meta">
          <span>{{ item.actorUsername ?? (item.actorId ? `#${item.actorId}` : '系统') }}</span>
          <span v-if="item.actorIp" class="audit-item__ip">{{ item.actorIp }}</span>
          <time :datetime="item.at" :title="formatDateTime(item.at)">{{ fromNow(item.at) }}</time>
        </p>
        <JsonCollapse v-if="!compact" class="mt-1" :value="item.detail" label="detail" />
      </div>
    </li>

    <li v-if="items.length === 0" class="audit-item audit-item--empty">{{ emptyText }}</li>
  </ol>
</template>

<style scoped>
.audit-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.audit-item {
  position: relative;
  display: flex;
  gap: var(--space-3);
  padding-left: var(--space-1);
}

/* 细轴：最后一个条目不画 */
.audit-item::before {
  position: absolute;
  top: 22px;
  bottom: calc(-1 * var(--space-4));
  left: 14px;
  width: 1px;
  background: var(--c-border);
  content: '';
}

.audit-item:last-child::before {
  display: none;
}

.audit-item__dot {
  z-index: 1;
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: 15px;
}

.audit-item__body {
  min-width: 0;
  flex: 1;
}

.audit-item__title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.audit-item__target {
  margin-left: var(--space-1);
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-normal);
}

.audit-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.audit-item__ip {
  font-family: var(--font-mono);
}

.audit-item--empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.audit-item--empty::before {
  display: none;
}

.audit-timeline--compact .audit-item__dot {
  width: 24px;
  height: 24px;
  font-size: 13px;
}
</style>
