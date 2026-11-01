<script setup lang="ts">
/**
 * 输入卡上方的附件条：图片缩略图 + 文件卡 + 上传进度 + 失败重试 + 移除。
 *
 * 进度来自 core 的 `upload-received`（窗口=1，一片一确认），所以数字是真进度，
 * 不是定时器估的。上传失败不清空附件，用户可以点「重试」从头再传一次。
 */
import AppIcon from './AppIcon.vue'
import { formatBytes } from '@dsh-hub/mobile-core'
import type { LocalAttachment } from '@/stores/chat'

defineProps<{ items: LocalAttachment[] }>()
const emit = defineEmits<{ remove: [localId: string]; retry: [localId: string] }>()
</script>

<template>
  <div v-if="items.length > 0" class="tray">
    <div
      v-for="item in items"
      :key="item.localId"
      class="tray__item"
      :class="{ 'tray__item--file': item.kind === 'file', 'tray__item--failed': item.state === 'failed' }"
    >
      <template v-if="item.kind === 'image' && item.previewUrl">
        <img class="tray__thumb" :src="item.previewUrl" :alt="item.name" />
      </template>
      <span v-else class="tray__file-icon"><AppIcon name="file" :size="16" /></span>

      <span class="tray__meta">
        <span class="tray__name">{{ item.name }}</span>
        <span class="tray__sub">
          <template v-if="item.state === 'failed'">{{ item.error || '上传失败' }}</template>
          <template v-else-if="item.state === 'uploading'">
            上传中 {{ Math.round(item.progress * 100) }}%
          </template>
          <template v-else-if="item.state === 'ready'">
            {{ formatBytes(item.bytes) }} · 已就绪
          </template>
          <template v-else>{{ formatBytes(item.bytes) }}</template>
        </span>
      </span>

      <span v-if="item.state === 'uploading'" class="tray__bar">
        <span class="tray__bar-fill" :style="{ width: `${Math.round(item.progress * 100)}%` }" />
      </span>

      <button
        v-if="item.state === 'failed'"
        class="tray__btn"
        type="button"
        aria-label="重试上传"
        @click="emit('retry', item.localId)"
      >
        <AppIcon name="refresh" :size="14" />
      </button>
      <button class="tray__btn" type="button" aria-label="移除附件" @click="emit('remove', item.localId)">
        <AppIcon name="close" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tray {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.tray__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  overflow: hidden;
}
.tray__item--failed {
  border-color: rgba(214, 81, 58, 0.4);
}
.tray__thumb {
  width: 34px;
  height: 34px;
  border-radius: 7px;
  object-fit: cover;
  flex: 0 0 auto;
  background: var(--surface-3);
}
.tray__file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  background: var(--surface-3);
  color: var(--text-3);
  flex: 0 0 auto;
}
.tray__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.tray__name {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tray__sub {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tray__item--failed .tray__sub {
  color: var(--danger);
}
.tray__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: rgba(74, 127, 212, 0.18);
}
.tray__bar-fill {
  display: block;
  height: 100%;
  background: var(--brand-blue, #4a7fd4);
  transition: width 0.18s linear;
}
.tray__btn {
  display: inline-flex;
  padding: 4px;
  border-radius: 7px;
  color: var(--text-3);
  flex: 0 0 auto;
}
</style>
