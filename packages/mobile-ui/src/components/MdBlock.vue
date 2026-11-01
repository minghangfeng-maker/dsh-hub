<script setup lang="ts">
import { computed } from 'vue'
import { parseFence, renderMarkdown } from '@/lib/markdown'
import { ensureHighlighted, getHighlighted, highlightVersion } from '@/lib/highlight'

/**
 * 一个已分好块的 Markdown 片段。
 *
 * 组件化的关键作用：父组件（流式消息）每次提交都会重渲染，但**props 没变的
 * 子组件不会重渲染**，于是「已完成的块」根本不会重新解析 Markdown，也不会
 * 重新写 innerHTML —— 这就是 §6.3 第 1 条要的「已完成的块缓存 VNode」。
 */
const props = defineProps<{
  source: string
  kind: string
  closed: boolean
  caret?: boolean
}>()

const html = computed(() => {
  if (props.kind === 'fence') {
    // 代码高亮是异步的；只有围栏块依赖 highlightVersion，避免高亮完成时
    // 把整条消息的所有块都重算一遍。
    void highlightVersion.value
    const { lang, code } = parseFence(props.source)
    const highlighted = getHighlighted(lang, code)
    if (highlighted) return highlighted
    // 块写完再高亮（文档 §6.3：代码高亮在块完成后再做）
    if (props.closed) ensureHighlighted(lang, code)
  }
  return renderMarkdown(props.source)
})
</script>

<template>
  <div class="md md-block" :class="{ 'md-block--live': !closed }">
    <div v-html="html" />
    <span v-if="caret" class="caret" />
  </div>
</template>
