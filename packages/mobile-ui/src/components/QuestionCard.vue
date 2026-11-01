<script setup lang="ts">
/**
 * DSH 提问卡：必须**显式回答**（不自动、不猜默认值）。
 *
 * 数据来自通道 `question` 帧（`state: open|continued`）；电脑端先答了会收到
 * `question-settled`，卡片按 callId 消失（core 处理）。
 */
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import type { QuestionPrompt } from '@dsh-hub/mobile-core'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ prompt: QuestionPrompt }>()
const chat = useChatStore()
const ui = useUiStore()

/** 每个问题的选择：单选用第一个值，多选是数组。 */
const selected = ref<Record<string, string[]>>({})
const custom = ref<Record<string, string>>({})
const submitting = ref(false)

const questions = computed(() => props.prompt.questions)

function toggle(questionId: string, label: string, multi: boolean): void {
  const current = selected.value[questionId] ?? []
  if (multi) {
    selected.value = {
      ...selected.value,
      [questionId]: current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label],
    }
    return
  }
  selected.value = { ...selected.value, [questionId]: [label] }
}

function isOn(questionId: string, label: string): boolean {
  return (selected.value[questionId] ?? []).includes(label)
}

const canSubmit = computed(() =>
  questions.value.every((question) => {
    const picked = (selected.value[question.id] ?? []).length
    const typed = (custom.value[question.id] ?? '').trim()
    // 有选项：必须选；没有选项：必须填空（自由文本问题）。
    if ((question.options?.length ?? 0) === 0) return typed.length > 0 || picked > 0
    return picked > 0 || typed.length > 0
  }),
)

function submit(): void {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const answers = questions.value.map((question) => {
    const picked = selected.value[question.id] ?? []
    const typed = (custom.value[question.id] ?? '').trim()
    if (typed.length > 0) {
      return { id: question.id, selected: [...picked, typed] }
    }
    return { id: question.id, selected: picked }
  })
  chat.answerQuestion(props.prompt, answers)
  ui.toast('已回答')
}
</script>

<template>
  <div class="question-card">
    <header class="question-card__head">
      <AppIcon name="user" :size="16" />
      <span>DSH 想确认一下</span>
    </header>
    <div v-for="question in questions" :key="question.id" class="question">
      <p v-if="question.header" class="question__header">{{ question.header }}</p>
      <p class="question__text">{{ question.question }}</p>
      <p v-if="question.detail" class="question__detail">{{ question.detail }}</p>
      <div v-if="question.options && question.options.length > 0" class="question__options">
        <button
          v-for="option in question.options"
          :key="option.label"
          class="question__option"
          :class="{ 'is-on': isOn(question.id, option.label) }"
          type="button"
          @click="toggle(question.id, option.label, question.multiSelect === true)"
        >
          <span class="question__mark">
            <AppIcon v-if="isOn(question.id, option.label)" name="check" :size="13" />
          </span>
          <span class="question__option-main">
            <span class="question__option-label">{{ option.label }}</span>
            <span v-if="option.description" class="question__option-desc">
              {{ option.description }}
            </span>
          </span>
        </button>
      </div>
      <input
        class="question__input"
        type="text"
        :placeholder="question.options?.length ? '也可以直接输入…' : '输入你的回答'"
        :value="custom[question.id] ?? ''"
        @input="custom = { ...custom, [question.id]: ($event.target as HTMLInputElement).value }"
      />
    </div>
    <button class="question-card__submit" type="button" :disabled="!canSubmit || submitting" @click="submit">
      回答
    </button>
  </div>
</template>

<style scoped>
.question-card {
  margin: 10px 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
}
.question-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--text-2);
  font-size: 12.5px;
}
.question {
  margin-bottom: 10px;
}
.question__header {
  margin: 0 0 2px;
  font-size: 11.5px;
  color: var(--text-3);
}
.question__text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
}
.question__detail {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.question__options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.question__option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  text-align: left;
}
.question__option.is-on {
  border-color: var(--brand-blue, #4a7fd4);
  background: rgba(74, 127, 212, 0.1);
}
.question__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  color: var(--brand-blue, #4a7fd4);
  flex: 0 0 auto;
}
.question__option-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.question__option-label {
  font-size: 13.5px;
  color: var(--text);
  line-height: 1.4;
}
.question__option-desc {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.4;
}
.question__input {
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 13px;
}
.question-card__submit {
  width: 100%;
  padding: 9px;
  border-radius: 10px;
  background: var(--text);
  color: var(--bg);
  font-size: 13.5px;
  font-weight: 600;
}
.question-card__submit[disabled] {
  opacity: 0.4;
}
</style>
