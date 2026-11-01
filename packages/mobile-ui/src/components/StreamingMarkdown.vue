<script setup lang="ts">
import { computed } from 'vue'
import { splitMarkdownBlocks } from '@dsh-hub/mobile-core'
import MdBlock from './MdBlock.vue'

const props = defineProps<{ text: string; streaming?: boolean }>()

/** 每帧重新分块（纯字符串扫描，几百字的成本可以忽略），渲染交给 MdBlock 缓存 */
const blocks = computed(() => splitMarkdownBlocks(props.text))
</script>

<template>
  <div class="md-stream">
    <MdBlock
      v-for="b in blocks"
      :key="b.index"
      :source="b.source"
      :kind="b.kind"
      :closed="b.closed"
      :caret="streaming && b.index === blocks.length - 1"
    />
  </div>
</template>
