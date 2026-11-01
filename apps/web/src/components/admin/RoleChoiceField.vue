<script setup lang="ts">
import { ROLE_LABEL_MAX_LENGTH, ROLE_TEXT_ADMIN, ROLE_TEXT_USER, type RoleLabelUsage } from '@dsh-hub/shared'
import { NInput, NSelect, type SelectOption } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'

import { createRoleOption, roleChoiceOptions } from './role'

/**
 * 角色控件（07 §7.2，WP13）：候选 = 普通用户 + 在用的自定义标签 + 管理员（`allowAdmin`）+ 最后一项「＋ 新建角色…」。
 *
 * 为什么要有这个组件：WP9 用的 `NSelect tag` 其实支持新建，但必须**打字后按回车或点那条候选**才算数，
 * 打完字直接点别处（或点「创建」）值会退回「普通用户」，用户完全发现不了能输入。这里补上两条路：
 * - 显式的「＋ 新建角色…」→ 下拉下方出现自动聚焦的输入框，输入的内容就是角色值（空 → 提交报「请输入角色名」）；
 * - 下拉里直接打字（tag 模式）继续可用，且**失焦时把打了字但没回车的内容当作选中值**。
 *
 * v-model 的值始终是角色显示文字（沿用 `role.ts` 的 `parseRoleChoice` 语义）；父组件提交前调 `validate()`。
 */
const props = withDefaults(
  defineProps<{
    value: string
    /** 在用的自定义标签（`GET /api/admin/users/role-labels`） */
    labels?: readonly RoleLabelUsage[]
    /** 邀请码只发普通用户：`false` 时没有「管理员」候选（07 §7.10） */
    allowAdmin?: boolean
    size?: 'tiny' | 'small' | 'medium'
    placeholder?: string
    /**
     * 下拉下方的说明（可选）。默认不显示：07 §2.7 不放常驻小字，
     * 「＋ 新建角色…」这条候选本身已经说明能新建，失焦即提交由交互保证。
     */
    hint?: string
  }>(),
  {
    labels: () => [],
    allowAdmin: true,
    size: 'small',
    placeholder: '选一个，或直接输入新角色名',
    hint: '',
  },
)

const emit = defineEmits<{ 'update:value': [value: string] }>()

/** 「＋ 新建角色…」的哨兵值：只在本组件内部用，不会作为角色值抛给父组件 */
const NEW_ROLE = '\u0000new-role'
const NEW_ROLE_TEXT = '＋ 新建角色…'

/** 本地即时值：emit 之后父组件的 props 要等一轮才回流，而 `validate()` 在提交时要立刻读到新值 */
const current = ref(props.value)
watch(
  () => props.value,
  (value) => {
    if (value !== current.value) current.value = value
  },
)

const mode = ref<'select' | 'custom'>('select')
const customName = ref('')
/** `NSelect` 里打字但还没回车的内容（tag 模式的「失焦即提交」靠它） */
const searchText = ref('')
const errorText = ref('')
const inputRef = ref<{ focus: () => void } | null>(null)
let blurTimer: ReturnType<typeof setTimeout> | null = null

const options = computed<SelectOption[]>(() => [
  ...roleChoiceOptions(props.labels, current.value, { allowAdmin: props.allowAdmin }),
  { label: NEW_ROLE_TEXT, value: NEW_ROLE },
])

/** 选「新建角色…」时下拉本身显示占位（值在下面的输入框里） */
const selectValue = computed(() => (mode.value === 'custom' ? null : current.value))

function clearBlurTimer(): void {
  if (blurTimer !== null) {
    clearTimeout(blurTimer)
    blurTimer = null
  }
}

function setValue(value: string): void {
  current.value = value
  emit('update:value', value)
}

/** 把一段文字定成角色值：trim + 截断（`createRoleOption`）；是已知候选就切回下拉态（输入「管理员」= 选管理员） */
function applyText(raw: string): string {
  const label = String(createRoleOption(raw).value ?? '')
  customName.value = label
  setValue(label)
  const known =
    label === ROLE_TEXT_USER ||
    (props.allowAdmin && label === ROLE_TEXT_ADMIN) ||
    props.labels.some((item) => item.label === label)
  if (known) mode.value = 'select'
  return label
}

function onUpdateValue(value: string): void {
  clearBlurTimer()
  searchText.value = ''
  errorText.value = ''
  if (value === NEW_ROLE) {
    mode.value = 'custom'
    // 下拉里已经打了字（想做新角色名）就带过来，省得再打一遍
    const seed = customName.value.trim()
    customName.value = seed
    setValue(seed)
    void nextTick(() => inputRef.value?.focus())
    return
  }
  mode.value = 'select'
  setValue(value)
}

function onSearch(text: string): void {
  searchText.value = text
}

/**
 * 失焦：把打了字但没按回车的内容当作选中值。
 * 点候选时 blur 可能先于 `update:value`，所以延后一拍——期间真的选中了就丢掉这段输入（不冲突）。
 */
function onBlur(): void {
  if (mode.value === 'custom') return
  const pending = searchText.value.trim()
  if (!pending) return
  clearBlurTimer()
  blurTimer = setTimeout(() => {
    blurTimer = null
    if (mode.value === 'custom') return
    if (searchText.value.trim() !== pending) return
    onUpdateValue(String(createRoleOption(pending).value ?? ''))
  }, 0)
}

function onCustomInput(text: string): void {
  customName.value = text
  errorText.value = ''
  setValue(text)
}

/** 校验（四个提交入口都要调）：空名报「请输入角色名」，同时把空格 / 超长规范化掉 */
function validate(): boolean {
  clearBlurTimer()
  if (searchText.value.trim()) {
    onUpdateValue(String(createRoleOption(searchText.value).value ?? ''))
  } else if (mode.value === 'custom') {
    applyText(customName.value)
  } else {
    applyText(current.value)
  }
  if (!current.value.trim()) {
    errorText.value = '请输入角色名'
    return false
  }
  errorText.value = ''
  return true
}

/** 当前值不是已知候选（父组件拿它决定要不要显示输入框之类的场景） */
const isCustom = computed(
  () => current.value !== ROLE_TEXT_USER && current.value !== ROLE_TEXT_ADMIN && !props.labels.some((item) => item.label === current.value),
)

defineExpose({ validate, isCustom, focus: () => inputRef.value?.focus() })
</script>

<template>
  <div class="role-choice" :data-testid="'role-choice'">
    <NSelect
      :value="selectValue"
      :options="options"
      :on-create="createRoleOption"
      :size="size"
      :placeholder="placeholder"
      :status="errorText ? 'error' : undefined"
      filterable
      tag
      data-testid="role-choice-select"
      @update:value="onUpdateValue"
      @search="onSearch"
      @blur="onBlur"
    />

    <NInput
      v-if="mode === 'custom'"
      ref="inputRef"
      :value="customName"
      :size="size"
      :maxlength="ROLE_LABEL_MAX_LENGTH"
      :status="errorText ? 'error' : undefined"
      placeholder="输入角色名，如 家人、朋友"
      data-testid="role-choice-input"
      @update:value="onCustomInput"
      @blur="applyText(customName)"
      @keydown.enter.prevent="applyText(customName)"
    />

    <p v-if="errorText" class="role-choice__error" role="alert" data-testid="role-choice-error">
      {{ errorText }}
    </p>
    <p v-else-if="hint" class="role-choice__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.role-choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.role-choice__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.role-choice__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}
</style>
