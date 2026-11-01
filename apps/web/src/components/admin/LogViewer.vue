<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'

import {
  matchingLineIndexes,
  shouldStickToBottom,
  splitHighlight,
  splitLogLines,
} from '@/composables/log-lines'
import { useSse } from '@/composables/useSse'

/**
 * 日志查看器（07 §7.3 用户详情「环境」Tab、§7.9 任务详情右侧日志面板）。
 *
 * - 等宽字体、行号、自动换行关掉（横向可滚）；
 * - **跟随**开关：开启时新日志自动滚到底；用户往上翻会自动关闭跟随，翻回底部自动开启；
 * - **关键字搜索**：高亮全部命中、显示命中数，可上/下跳转；
 * - 数据来源二选一：`text`（一次性拉取，如 `GET .../logs`）或 `streamUrl`（SSE `event: line`）。
 */
const props = withDefaults(
  defineProps<{
    /** SSE 地址（04 §4.3 / §4.8）；为空则只显示 `text` */
    streamUrl?: string | null
    /** 一次性日志文本 */
    text?: string
    height?: number
    /** 初始是否跟随 */
    follow?: boolean
    emptyText?: string
    /** 保留的最大行数（防止长任务把 DOM 撑爆） */
    maxLines?: number
  }>(),
  {
    streamUrl: null,
    text: '',
    height: 320,
    follow: true,
    emptyText: '暂无日志',
    maxLines: 2000,
  },
)

const lines = ref<string[]>(splitLogLines(props.text ?? '').slice(-props.maxLines))
const keyword = ref('')
const follow = ref(props.follow)
const cursor = ref(-1)
const scroller = ref<HTMLElement | null>(null)

watch(
  () => props.text,
  (next) => {
    lines.value = splitLogLines(next ?? '').slice(-props.maxLines)
  },
)

const matches = computed(() => matchingLineIndexes(lines.value, keyword.value))
const hitLines = computed(() => new Set(matches.value))

const sse = useSse(() => props.streamUrl ?? '', {
  immediate: Boolean(props.streamUrl),
  events: {
    line: (data) => {
      const payload = data as { line?: unknown } | null
      if (payload && typeof payload.line === 'string') append(payload.line)
    },
  },
})

const status = computed(() => sse.status.value)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element) element.scrollTop = element.scrollHeight
}

function append(chunk: string): void {
  const incoming = splitLogLines(chunk)
  if (incoming.length === 0) return

  lines.value = [...lines.value, ...incoming].slice(-props.maxLines)
  if (follow.value) void scrollToBottom()
}

/** 用户手动滚动：贴底就恢复跟随，往上翻就暂停跟随（不打扰阅读）。 */
function onScroll(): void {
  const element = scroller.value
  if (!element) return
  follow.value = shouldStickToBottom(element)
}

function toggleFollow(): void {
  follow.value = !follow.value
  if (follow.value) void scrollToBottom()
}

function jump(step: number): void {
  if (matches.value.length === 0) return
  cursor.value = (cursor.value + step + matches.value.length) % matches.value.length
  const lineIndex = matches.value[cursor.value]
  if (lineIndex === undefined) return

  void nextTick(() => {
    const node = scroller.value?.querySelector(`[data-line="${lineIndex}"]`)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
  })
}

watch(keyword, () => {
  cursor.value = -1
})

const keywordParts = (line: string): ReturnType<typeof splitHighlight> => splitHighlight(line, keyword.value)

defineExpose({ lines, keyword, follow, matches, jump, append })
</script>

<template>
  <div class="log-viewer">
    <div class="log-viewer__bar">
      <span class="log-viewer__title">
        <span class="i-ph-terminal-window" aria-hidden="true" />
        日志
      </span>

      <span class="log-viewer__status" :class="`log-viewer__status--${status}`">
        {{
          status === 'open'
            ? '实时'
            : status === 'reconnecting'
              ? '重连中'
              : status === 'connecting'
                ? '连接中'
                : '静态'
        }}
      </span>

      <div class="log-viewer__search">
        <NInput
          v-model:value="keyword"
          size="tiny"
          placeholder="搜索关键字"
          clearable
          :input-props="{ 'aria-label': '搜索日志' }"
        />
        <span class="log-viewer__hits" aria-live="polite">
          {{ keyword ? `${matches.length} 处` : '' }}
        </span>
        <NButton
          size="tiny"
          quaternary
          :disabled="matches.length === 0"
          aria-label="上一个命中"
          @click="jump(-1)"
        >
          <span class="i-ph-caret-up" aria-hidden="true" />
        </NButton>
        <NButton
          size="tiny"
          quaternary
          :disabled="matches.length === 0"
          aria-label="下一个命中"
          @click="jump(1)"
        >
          <span class="i-ph-caret-down" aria-hidden="true" />
        </NButton>
      </div>

      <NButton
        size="tiny"
        :type="follow ? 'primary' : 'default'"
        :aria-pressed="follow"
        @click="toggleFollow"
      >
        <template #icon>
          <span :class="follow ? 'i-ph-arrow-line-down' : 'i-ph-pause'" aria-hidden="true" />
        </template>
        {{ follow ? '跟随中' : '已暂停' }}
      </NButton>
    </div>

    <div
      ref="scroller"
      class="log-viewer__scroll"
      :style="{ height: `${height}px` }"
      tabindex="0"
      role="log"
      aria-label="日志内容"
      @scroll.passive="onScroll"
    >
      <p v-if="lines.length === 0" class="log-viewer__empty">{{ emptyText }}</p>

      <ol v-else class="log-viewer__list">
        <li
          v-for="(line, index) in lines"
          :key="index"
          class="log-viewer__line"
          :class="{ 'log-viewer__line--hit': hitLines.has(index) }"
          :data-line="index"
        >
          <span class="log-viewer__no" aria-hidden="true">{{ index + 1 }}</span>
          <span class="log-viewer__text">
            <template v-for="(part, partIndex) in keywordParts(line)" :key="partIndex">
              <mark v-if="part.hit" class="log-viewer__mark">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.log-viewer {
  overflow: hidden;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
}

.log-viewer__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--c-border);
  background: var(--c-bg);
}

.log-viewer__title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.log-viewer__status {
  border-radius: var(--radius-pill);
  padding: 0 var(--space-2);
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.log-viewer__status--open {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.log-viewer__status--reconnecting {
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
}

.log-viewer__search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 220px;
  margin-left: auto;
}

.log-viewer__hits {
  min-width: 44px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-align: right;
}

.log-viewer__scroll {
  overflow: auto;
  background: var(--c-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 20px;
}

.log-viewer__empty {
  padding: var(--space-4);
  color: var(--c-text-3);
}

.log-viewer__list {
  min-width: min-content;
}

.log-viewer__line {
  display: flex;
  gap: var(--space-2);
  padding-inline: var(--space-2);
  white-space: pre;
}

.log-viewer__line--hit {
  background: var(--c-butter-soft);
}

.log-viewer__no {
  width: 44px;
  flex: none;
  color: var(--c-text-3);
  text-align: right;
  user-select: none;
}

.log-viewer__text {
  color: var(--c-text);
}

.log-viewer__mark {
  border-radius: 3px;
  background: var(--c-butter);
  color: var(--c-text);
}
</style>
