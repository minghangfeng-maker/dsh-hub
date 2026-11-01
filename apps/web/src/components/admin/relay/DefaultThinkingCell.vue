<script setup lang="ts">
import { effectiveDshThinking, type RelayModel, type ThinkingLevel } from '@dsh-hub/shared'
import { NSelect, useMessage, type SelectOption } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import { updateRelayModel } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import {
  defaultThinkingOptions,
  THINKING_NONE,
  thinkingLevelLabel,
  usableThinkingLevels,
} from '@/components/admin/thinking-levels'

/**
 * 「模型与价格」表格的「默认思考」（WP13，12 §10）：
 * - 行内小下拉（不指定 + 该模型声明的档位），选了**立即** `PATCH {defaultThinking}`，乐观更新，失败回滚 + 提示；
 * - 没声明档位的模型显示灰「—」并悬停提示去哪勾；
 * - 设了但 `effectiveDshThinking()` 为 null（声明里没有它、或只声明了 off）→ 琥珀「未生效」。
 *
 * 表格里只显示档位名（`max`），中文（「最高」）放悬停提示里。
 */
const props = defineProps<{ model: RelayModel }>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const NO_LEVELS_HINT = '先在定价 → 更多设置 → 模型参数里勾选它支持的思考档位'

const levels = computed(() => usableThinkingLevels(props.model.info.reasoningEfforts))
/** 生效档位：设了但不生效的当作没设（与下发渲染同一口径） */
const effective = computed(() => effectiveDshThinking(props.model.info, props.model.defaultThinking))
/** 设了、但没生效 → 琥珀「未生效」 */
const ineffective = computed(() => props.model.defaultThinking !== null && effective.value === null)

const current = ref<ThinkingLevel | null>(effective.value)
const saving = ref(false)
// 服务端数据刷新后跟着走；正在保存时不覆盖乐观值
watch(effective, (value) => {
  if (!saving.value) current.value = value
})

const options = computed<SelectOption[]>(() => defaultThinkingOptions(levels.value))

/** 选中项与候选都只显示档位名，中文放 title（表格里省地方） */
function renderLabel(option: SelectOption): ReturnType<typeof h> {
  const value = String(option.value ?? '')
  const title = value === THINKING_NONE ? '不指定：由模型 / 上游自己的默认决定' : thinkingLevelLabel(value as ThinkingLevel)
  return h('span', { title }, value === THINKING_NONE ? '不指定' : value)
}

async function onChange(value: string): Promise<void> {
  const next = value === THINKING_NONE ? null : (value as ThinkingLevel)
  const previous = current.value
  if (next === previous) return
  current.value = next // 乐观更新：先动界面
  saving.value = true
  try {
    await updateRelayModel(props.model.id, { defaultThinking: next })
    message.success(
      next === null
        ? `已把 ${props.model.name} 的默认思考档位改成「不指定」`
        : `已把 ${props.model.name} 的默认思考档位改成 ${next}`,
    )
    emit('changed')
  } catch (cause) {
    current.value = previous // 失败回滚
    message.error(describeError(cause).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="thinking-cell">
    <span
      v-if="levels.length === 0"
      class="thinking-cell__none"
      :title="NO_LEVELS_HINT"
      :data-testid="`model-thinking-none-${model.id}`"
      >—</span
    >
    <NSelect
      v-else
      class="thinking-cell__select"
      :value="current ?? THINKING_NONE"
      :options="options"
      :render-label="renderLabel"
      :loading="saving"
      size="tiny"
      :data-testid="`model-thinking-${model.id}`"
      @update:value="onChange"
    />
    <MiniTag
      v-if="ineffective"
      text="未生效"
      tone="butter"
      size="sm"
      :title="`设了 ${model.defaultThinking}，但模型没有声明这个档位`"
      :data-testid="`model-thinking-ineffective-${model.id}`"
    />
  </div>
</template>

<style scoped>
.thinking-cell {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.thinking-cell__select {
  width: 84px;
  flex: none;
}

.thinking-cell__none {
  color: var(--c-text-3);
}
</style>
