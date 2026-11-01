<script setup lang="ts">
/**
 * 工具卡（M5 §7.2）：一行摘要 + 可展开的输入/输出预览 + 来源列表。
 *
 * 摘要由 core 的 `toolSummary` 生成（「搜索了 3 个网页」「运行了 Python」…），
 * UI 不自己拼文案：同一段话在工具卡、测试和报告里必须是同一个来源。
 */
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import FileAttachment from './FileAttachment.vue'
import { toolSummary, type ToolCard } from '@dsh-hub/mobile-core'

const props = defineProps<{ card: ToolCard }>()

const open = ref(false)
const summary = computed(() => toolSummary(props.card))
const running = computed(() => props.card.phase === 'start' && props.card.status === 'running')
const failed = computed(() => props.card.status === 'error')
const hasDetail = computed(
  () =>
    !!props.card.inputPreview ||
    !!props.card.outputPreview ||
    props.card.citations.length > 0 ||
    props.card.files.length > 0 ||
    !!props.card.error,
)
const icon = computed(() => {
  switch (props.card.kind) {
    case 'search':
      return 'search'
    case 'fetch':
      return 'globe'
    case 'python':
    case 'bash':
      return 'terminal'
    case 'file-read':
    case 'file-write':
    case 'present':
      return 'file'
    case 'question':
      return 'user'
    case 'agent':
      return 'sparkle'
    default:
      return 'layers'
  }
})

const durationText = computed(() => {
  const ms = props.card.durationMs
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
})

function toggle(): void {
  if (!hasDetail.value) return
  open.value = !open.value
}
</script>

<template>
  <div class="tool" :class="{ 'tool--error': failed, 'tool--open': open }">
    <button class="tool__head" type="button" :disabled="!hasDetail" @click="toggle">
      <span class="tool__icon" :class="{ 'tool__icon--spin': running }">
        <AppIcon :name="icon" :size="15" />
      </span>
      <span class="tool__summary">{{ summary }}</span>
      <span v-if="durationText" class="tool__meta">{{ durationText }}</span>
      <AppIcon
        v-if="hasDetail"
        class="tool__caret"
        name="chevronDown"
        :size="13"
        :style="{ transform: open ? 'rotate(180deg)' : 'none' }"
      />
    </button>

    <div v-if="open" class="tool__body">
      <template v-if="card.inputPreview">
        <p class="tool__label">
          输入<template v-if="card.truncated?.input">（已截断）</template>
        </p>
        <pre class="tool__pre">{{ card.inputPreview }}</pre>
      </template>
      <template v-if="card.outputPreview">
        <p class="tool__label">
          输出<template v-if="card.truncated?.output">（已截断）</template>
        </p>
        <pre class="tool__pre">{{ card.outputPreview }}</pre>
      </template>
      <template v-if="card.error">
        <p class="tool__label tool__label--error">失败</p>
        <p class="tool__error">
          {{ card.error.reason || card.error.code || card.error.name }}
        </p>
      </template>
      <template v-if="card.citations.length > 0">
        <p class="tool__label">来源</p>
        <ul class="tool__sources">
          <li v-for="(source, index) in card.citations" :key="source.url">
            <a :href="source.url" target="_blank" rel="noreferrer noopener">
              <span class="tool__source-index">{{ index + 1 }}</span>
              <span class="tool__source-title">{{ source.title || source.url }}</span>
            </a>
          </li>
        </ul>
      </template>
      <div v-if="card.files.length > 0" class="tool__files">
        <FileAttachment
          v-for="file in card.files"
          :key="file.fileRef"
          :file="file"
          compact
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 0.2.13：过程块里的紧凑行（参考 Claude Code 的 `⏺ Bash(cmd)`），不再是一张卡。 */
.tool {
  margin: 0;
  border: 0;
  background: none;
  min-width: 0;
}
.tool--error .tool__summary {
  color: var(--danger);
}
.tool__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 0;
  text-align: left;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-2);
  border-radius: 6px;
}
.tool__head:not(:disabled):active {
  background: var(--surface-2);
}
.tool__head:disabled {
  cursor: default;
}
.tool__icon {
  display: inline-flex;
  color: var(--text-3);
  flex: 0 0 auto;
  opacity: 0.9;
}
.tool__icon--spin {
  animation: tool-spin 1.4s linear infinite;
}
@keyframes tool-spin {
  from {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
  to {
    opacity: 0.5;
  }
}
.tool__summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool__meta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-3);
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
.tool__caret {
  flex: 0 0 auto;
  color: var(--text-3);
  opacity: 0.7;
}
.tool--open .tool__caret {
  transform: rotate(180deg);
}
.tool__body {
  margin: 2px 0 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.tool__label {
  margin: 8px 0 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
.tool__label:first-child {
  margin-top: 0;
}
.tool__label--error {
  color: var(--danger);
}
.tool__pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
  overscroll-behavior: contain;
}
.tool__error {
  margin: 0;
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.5;
}
.tool__sources {
  margin: 0;
  padding: 0;
  list-style: none;
}
.tool__sources a {
  display: flex;
  gap: 6px;
  padding: 3px 0;
  color: var(--brand-blue, #3f6fd0);
  font-size: 12.5px;
  line-height: 1.45;
  text-decoration: none;
}
.tool__source-index {
  flex: 0 0 auto;
  color: var(--text-3);
}
.tool__source-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool__files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
