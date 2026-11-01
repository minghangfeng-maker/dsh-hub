<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * 可复制文本（07 §7.10 邀请码注册链接、用户详情里的 slug 等）：
 * 等宽字体 + 一键复制；优先 `navigator.clipboard`（HTTPS / localhost），
 * 否则退回 `textarea + execCommand`（http 局域网调试时也能复制）。
 */
const props = withDefaults(
  defineProps<{
    text: string
    /** 是否显示左侧说明文字 */
    label?: string
    /** 超长文本截断显示（复制仍是全文） */
    truncate?: boolean
    /** 多行代码块（环境变量 / curl）：保留换行、不折行，框内横向滚动（07 §2.8） */
    block?: boolean
    size?: 'sm' | 'md'
    /** 只显示复制图标（表格里省宽度） */
    compact?: boolean
  }>(),
  { label: undefined, truncate: false, block: false, size: 'md', compact: false },
)

const emit = defineEmits<{ copied: [text: string] }>()

type CopyState = 'idle' | 'copied' | 'failed'

const state = ref<CopyState>('idle')
let resetTimer: ReturnType<typeof setTimeout> | null = null

const displayText = computed(() => props.text || '—')
const buttonText = computed(() =>
  state.value === 'copied' ? '已复制' : state.value === 'failed' ? '复制失败' : '复制',
)

function mark(next: CopyState): void {
  state.value = next
  if (resetTimer !== null) clearTimeout(resetTimer)
  resetTimer = setTimeout(() => {
    state.value = 'idle'
    resetTimer = null
  }, 1800)
}

/** 手工降级：选中隐藏 textarea 后 execCommand('copy')（jsdom 与老浏览器里可能不存在） */
function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()

  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

async function onCopy(): Promise<void> {
  if (!props.text) return

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.text)
      mark('copied')
      emit('copied', props.text)
      return
    }
  } catch {
    // 继续降级
  }

  if (legacyCopy(props.text)) {
    mark('copied')
    emit('copied', props.text)
  } else {
    mark('failed')
  }
}

onBeforeUnmount(() => {
  if (resetTimer !== null) clearTimeout(resetTimer)
})
</script>

<template>
  <div class="copy-text" :class="[`copy-text--${size}`, { 'copy-text--block': block }]">
    <span v-if="label" class="copy-text__label">{{ label }}</span>
    <!-- 截断时把完整文本放进 title（07 §2.8：标识符单行省略，悬停看全） -->
    <!-- 多行片段用 <pre>：换行是内容自己的换行，不当作断行问题 -->
    <pre v-if="block" class="copy-text__value copy-text__value--block">{{ displayText }}</pre>
    <code
      v-else
      class="copy-text__value"
      :class="{ 'copy-text__value--truncate': truncate }"
      :title="truncate ? displayText : undefined"
      >{{ displayText }}</code
    >
    <NButton quaternary size="tiny" :disabled="!text" :aria-label="`复制${label ?? '文本'}`" @click="onCopy">
      <template #icon>
        <span :class="state === 'copied' ? 'i-ph-check' : 'i-ph-copy'" aria-hidden="true" />
      </template>
      <template v-if="!compact">{{ buttonText }}</template>
    </NButton>
  </div>
</template>

<style scoped>
.copy-text {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.copy-text__label {
  flex: none;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.copy-text__value {
  min-width: 0;
  margin: 0;
  padding: 2px var(--space-2);
  border-radius: 8px;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-13);
}

/* 复制按钮不挤占文本：文本先缩，按钮保持原样 */
:deep(.n-button) {
  flex: none;
}

.copy-text--sm .copy-text__value {
  font-size: var(--fs-12);
}

.copy-text__value--truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 多行代码块：一行一行留着，放不下就在框里横向滚动（不拆 URL / 标识符） */
.copy-text--block {
  align-items: flex-start;
}

.copy-text__value--block {
  display: block;
  overflow-x: auto;
  white-space: pre;
}
</style>
