<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'

import {
  checkPatchYaml,
  renderPatchPreview,
  type PatchCheckResult,
  type YamlIssue,
} from '@/composables/yaml-patch'

/**
 * 插件配置的 YAML 编辑器（07 §7.5）：**不引 Monaco**，用 `<textarea>` + 行号栏 + 等宽字体，
 * 左侧校验错误就地定位（点错误跳到对应行），右侧显示注入 `managed.patch.yml` 的渲染预览。
 *
 * 客户端只做结构检查（`composables/yaml-patch.ts`），YAML 语法最终以服务端校验为准。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 预览头部里显示的插件包名 */
    packageName?: string
    height?: number
    readonly?: boolean
  }>(),
  { packageName: undefined, height: 320, readonly: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 每次内容变化的校验结果（父组件用它禁用「保存」） */
  validity: [result: PatchCheckResult]
}>()

const LINE_HEIGHT = 20

const textarea = ref<HTMLTextAreaElement | null>(null)
const gutter = ref<HTMLElement | null>(null)

const check = computed(() => checkPatchYaml(props.modelValue))
const lineCount = computed(() => props.modelValue.split('\n').length)
const preview = computed(() => renderPatchPreview(props.modelValue, { packageName: props.packageName }))

watch(check, (result) => emit('validity', result), { immediate: true })

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}

/** 行号栏与文本域一起滚动（等宽字体 + 同一个行高，所以能对齐）。 */
function onScroll(): void {
  if (gutter.value && textarea.value) gutter.value.scrollTop = textarea.value.scrollTop
}

/** 跳到一个问题所在行：选中整行并把视口滚过去。 */
function jumpTo(line: number): void {
  const area = textarea.value
  if (!area || line <= 0) return

  const lines = props.modelValue.split('\n')
  let offset = 0
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) {
    offset += (lines[index] ?? '').length + 1
  }
  const length = (lines[line - 1] ?? '').length

  area.focus()
  area.setSelectionRange(offset, offset + length)
  area.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT - LINE_HEIGHT * 2)
  onScroll()

  void nextTick(() => area.focus())
}

function issueIcon(issue: YamlIssue): string {
  return issue.severity === 'error' ? 'i-ph-x-circle' : 'i-ph-warning'
}

defineExpose({ check, jumpTo, preview })
</script>

<template>
  <div class="yaml-editor">
    <div class="yaml-editor__pane">
      <div class="yaml-editor__frame" :style="{ height: `${height}px` }">
        <pre ref="gutter" class="yaml-editor__gutter" aria-hidden="true">{{
          Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')
        }}</pre>
        <textarea
          ref="textarea"
          class="yaml-editor__area"
          :value="modelValue"
          :readonly="readonly"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          aria-label="插件配置 YAML"
          @input="onInput"
          @scroll="onScroll"
        />
      </div>

      <ul v-if="check.issues.length > 0" class="yaml-editor__issues" aria-live="polite">
        <li v-for="(issue, index) in check.issues" :key="index">
          <button type="button" class="yaml-editor__issue press" @click="jumpTo(issue.line)">
            <span :class="issueIcon(issue)" class="yaml-editor__issue-icon" aria-hidden="true" />
            <span class="yaml-editor__issue-line">第 {{ issue.line }} 行</span>
            <span class="yaml-editor__issue-text">{{ issue.message }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="yaml-editor__ok">
        <span class="i-ph-check-circle" aria-hidden="true" /> 结构检查通过（{{ check.entries.length }}
        个条目）
      </p>
    </div>

    <div class="yaml-editor__pane">
      <div class="yaml-editor__preview-head">
        <span class="i-ph-eye" aria-hidden="true" /> 渲染预览（注入 managed.patch.yml）
      </div>
      <pre class="yaml-editor__preview" :style="{ height: `${height}px` }">{{ preview }}</pre>
      <p class="yaml-editor__hint">
        <NButton text size="tiny" @click="jumpTo(check.issues[0]?.line ?? 1)">跳到第一个问题</NButton>
      </p>
    </div>
  </div>
</template>

<style scoped>
.yaml-editor {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 1100px) {
  .yaml-editor {
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  }
}

.yaml-editor__pane {
  min-width: 0;
}

.yaml-editor__frame {
  display: flex;
  overflow: hidden;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
}

.yaml-editor__gutter {
  width: 44px;
  flex: none;
  overflow: hidden;
  margin: 0;
  padding: var(--space-2) var(--space-1);
  border-right: var(--border-width) solid var(--c-border);
  background: var(--c-bg);
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 20px;
  text-align: right;
  user-select: none;
}

.yaml-editor__area {
  min-width: 0;
  flex: 1;
  padding: var(--space-2);
  border: 0;
  background: transparent;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 20px;
  outline: none;
  resize: none;
  tab-size: 2;
  white-space: pre;
}

.yaml-editor__area:focus-visible {
  box-shadow: inset var(--focus-ring);
}

.yaml-editor__issues {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-2);
}

.yaml-editor__issue {
  display: flex;
  width: 100%;
  align-items: baseline;
  gap: var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  padding: 2px var(--space-2);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--fs-12);
  text-align: left;
}

.yaml-editor__issue:hover {
  background: var(--c-danger-soft);
}

.yaml-editor__issue-icon {
  color: var(--c-danger);
}

.yaml-editor__issue-line {
  flex: none;
  font-family: var(--font-mono);
}

.yaml-editor__ok {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--space-2);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
}

.yaml-editor__preview-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.yaml-editor__preview {
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 20px;
  white-space: pre;
}

.yaml-editor__hint {
  margin-top: var(--space-1);
}
</style>
