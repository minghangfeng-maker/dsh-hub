<script setup lang="ts">
import { NAlert, NProgress } from 'naive-ui'
import { computed } from 'vue'

import { formatBytes } from '@/composables/useFormat'

/**
 * 上传进度（插件整包 / 安装包）：进度条 + 已传字节，失败时把**服务端原话**显示出来。
 *
 * 两个 400（claude 二进制禁运、codex 整包缺 LICENSE/NOTICE）是服务端算好的文案，
 * 这里不做二次改写：管理员要照着这句去换包。
 */
const props = withDefaults(
  defineProps<{
    /** 0–100；null = 还在等第一个进度事件（不确定态） */
    percent: number | null
    loaded: number
    total: number
    fileName?: string
    error?: string | null
    /** 出错时的补充说明（服务端 details.fields 里的原因，例如「命中禁运路径：…」） */
    errorDetail?: string | null
  }>(),
  { fileName: undefined, error: null, errorDetail: null },
)

const percent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent ?? 0))))
const indeterminate = computed(() => props.percent === null)
const sizeText = computed(() =>
  props.total > 0 ? `${formatBytes(props.loaded)} / ${formatBytes(props.total)}` : formatBytes(props.loaded),
)
</script>

<template>
  <div class="desktop-upload" data-testid="desktop-upload">
    <div class="desktop-upload__head">
      <span class="desktop-upload__name" :title="fileName">{{ fileName ?? '上传中' }}</span>
      <span class="desktop-upload__size">{{ sizeText }}</span>
    </div>
    <NProgress
      type="line"
      :percentage="percent"
      :indeterminate="indeterminate"
      :show-indicator="!indeterminate"
      :height="6"
      :border-radius="6"
      data-testid="desktop-upload-progress"
    />
    <NAlert v-if="error" type="error" :bordered="false" class="desktop-upload__error" data-testid="desktop-upload-error">
      <p class="desktop-upload__error-title">{{ error }}</p>
      <p v-if="errorDetail" class="desktop-upload__error-detail">{{ errorDetail }}</p>
    </NAlert>
  </div>
</template>

<style scoped>
.desktop-upload {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 240px;
}

.desktop-upload__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--fs-13);
  color: var(--c-text-2);
}

.desktop-upload__name {
  overflow: hidden;
  min-width: 0;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-upload__size {
  white-space: nowrap;
}

.desktop-upload__error {
  margin-top: var(--space-1);
}

.desktop-upload__error-title {
  font-weight: var(--fw-semibold);
}

.desktop-upload__error-detail {
  margin-top: 2px;
  font-size: var(--fs-12);
}
</style>
