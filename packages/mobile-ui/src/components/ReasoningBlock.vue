<script setup lang="ts">
/**
 * 思考节点（过程行展开后的时间线里的一种节点，0.4.0 §2.2）。
 *
 * 0.4.0 起它**不再**是时间线末尾的独立折叠块，也不是「深度求索中… Ns」胶囊：
 * 实时思考并进过程行的末行，折叠成单行摘要；点开过程行后，这里显示灰色正文，
 * 最多 6 行（运行中始终显示最新的一段），更长的用「展开全文」看完整内容。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  text: string
  /** 还在生成（这一行还是实时内容）。 */
  live?: boolean
}>()

const expanded = ref(false)
const clampEl = ref<HTMLElement | null>(null)
const overflowing = ref(false)

const hasText = computed(() => props.text.trim() !== '')

async function measure(): Promise<void> {
  await nextTick()
  const el = clampEl.value
  if (el === null) return
  overflowing.value = el.scrollHeight > el.clientHeight + 1
}

watch(
  () => props.text,
  () => {
    if (!expanded.value) void measure()
  },
)
watch(expanded, (open) => {
  if (!open) void measure()
})
onMounted(() => void measure())
</script>

<template>
  <div class="reasoning" :class="{ 'reasoning--live': live }">
    <template v-if="hasText">
      <div v-if="!expanded" ref="clampEl" class="reasoning__clamp">
        <p class="reasoning__text">{{ text }}</p>
      </div>
      <p v-else class="reasoning__text">{{ text }}</p>
      <button
        v-if="expanded || overflowing"
        class="reasoning__more"
        type="button"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全文' }}
      </button>
    </template>
    <p v-else class="reasoning__text reasoning__text--muted">思考中…</p>
  </div>
</template>

<style scoped>
.reasoning {
  margin: 2px 0 4px;
  min-width: 0;
}
.reasoning__clamp {
  /* 只显示最后 6 行：flex-end 让溢出部分从顶部裁掉（实时思考始终看到最新一句） */
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 9.9em;
  overflow: hidden;
}
.reasoning__text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.reasoning__text--muted {
  color: var(--text-3);
}
.reasoning__more {
  margin-top: 2px;
  padding: 2px 0;
  color: var(--accent-ink);
  font-size: 12.5px;
  line-height: 1.4;
}
</style>
