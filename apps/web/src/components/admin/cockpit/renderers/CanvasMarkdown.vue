<script setup lang="ts">
import { computed } from 'vue'

/**
 * `markdown` 卡（docs/24 §3：≤ 4000 字，**渲染时禁 HTML**）。
 *
 * 只做最保守的按行排版（标题 / 项目符号 / 段落），不解析行内标记、不注入任何 HTML：
 * 卡片文字是 DSH 输出的外部内容，`v-html` 一律不用，超出长度直接截断。
 */
const MAX_LENGTH = 4000

const props = defineProps<{ text: string }>()

type Block =
  | { kind: 'heading'; key: string; text: string }
  | { kind: 'item'; key: string; text: string }
  | { kind: 'paragraph'; key: string; text: string }

const blocks = computed<Block[]>(() => {
  const raw = props.text.length > MAX_LENGTH ? `${props.text.slice(0, MAX_LENGTH)}…` : props.text
  const result: Block[] = []

  for (const [index, line] of raw.split('\n').entries()) {
    const text = line.trimEnd()
    if (text.trim().length === 0) continue
    const key = `${String(index)}-${text.slice(0, 12)}`

    if (/^#{1,6}\s+/.test(text)) {
      result.push({ kind: 'heading', key, text: text.replace(/^#{1,6}\s+/, '') })
      continue
    }
    if (/^[-*]\s+/.test(text)) {
      result.push({ kind: 'item', key, text: text.replace(/^[-*]\s+/, '') })
      continue
    }
    result.push({ kind: 'paragraph', key, text })
  }
  return result
})
</script>

<template>
  <div class="canvas-markdown">
    <template v-for="block in blocks" :key="block.key">
      <p v-if="block.kind === 'heading'" class="canvas-markdown__heading">{{ block.text }}</p>
      <p v-else-if="block.kind === 'item'" class="canvas-markdown__item">{{ block.text }}</p>
      <p v-else class="canvas-markdown__paragraph">{{ block.text }}</p>
    </template>
    <p v-if="blocks.length === 0" class="canvas-markdown__empty">（空）</p>
  </div>
</template>

<style scoped>
.canvas-markdown {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-13);
  line-height: var(--lh-base);
}

.canvas-markdown__heading {
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.canvas-markdown__item {
  position: relative;
  padding-left: var(--space-4);
}

.canvas-markdown__item::before {
  position: absolute;
  left: 4px;
  color: var(--c-primary);
  content: '·';
  font-weight: var(--fw-bold);
}

.canvas-markdown__paragraph {
  color: var(--c-text);
  /* 段落正文可以换行（07 §2.8） */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.canvas-markdown__empty {
  color: var(--c-text-3);
}
</style>
