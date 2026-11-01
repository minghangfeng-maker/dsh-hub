<script setup lang="ts">
import type { ModelInfo } from '@dsh-hub/shared'
import { NButton, NCheckbox, NCheckboxGroup, NInputNumber, NSelect } from 'naive-ui'

import { MODEL_INPUT_OPTIONS, normalizeInputs } from '@/components/admin/model-info'
import {
  DEEPSEEK_THINKING_LEVELS,
  normalizeThinkingLevels,
  THINKING_LEVEL_OPTIONS,
} from '@/components/admin/thinking-levels'

/**
 * 模型参数编辑：上下文 / 最大输出 / 输入类型（文字、图片）/ 思考档位。
 * 提供方抽屉里的每个模型、模型信息库里的每一条共用这一组字段；改动通过 `patch` 抛出，由调用方合并。
 */
defineProps<{ model: ModelInfo }>()

const emit = defineEmits<{
  patch: [patch: Pick<ModelInfo, 'contextWindow' | 'maxTokens' | 'input' | 'reasoningEfforts'>]
}>()
</script>

<template>
  <div class="params">
    <div class="params__row">
      <label class="params__field">
        <span class="params__label">上下文</span>
        <NInputNumber
          :value="model.contextWindow ?? null"
          size="small"
          :min="1"
          :show-button="false"
          placeholder="未填"
          @update:value="(value: number | null) => emit('patch', { contextWindow: value ?? undefined })"
        />
      </label>
      <label class="params__field">
        <span class="params__label">最大输出</span>
        <NInputNumber
          :value="model.maxTokens ?? null"
          size="small"
          :min="1"
          :show-button="false"
          placeholder="未填"
          @update:value="(value: number | null) => emit('patch', { maxTokens: value ?? undefined })"
        />
      </label>
      <div class="params__field" title="都不勾 = 不声明，DSH 按纯文字处理；支持看图的模型请勾上图片">
        <span class="params__label">输入</span>
        <NCheckboxGroup
          :value="model.input ?? []"
          class="params__inputs"
          @update:value="
            (value: (string | number)[]) => emit('patch', { input: normalizeInputs(value.map(String)) })
          "
        >
          <NCheckbox v-for="option in MODEL_INPUT_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </NCheckbox>
        </NCheckboxGroup>
      </div>
    </div>
    <div class="params__efforts">
      <span class="params__label">思考档位</span>
      <NSelect
        :value="model.reasoningEfforts ?? []"
        :options="THINKING_LEVEL_OPTIONS"
        multiple
        clearable
        size="small"
        placeholder="不选 = 不支持思考（DSH 里不显示档位）"
        @update:value="
          (value: string[]) => emit('patch', { reasoningEfforts: normalizeThinkingLevels(value) })
        "
      />
      <NButton
        size="tiny"
        quaternary
        title="off + low / high / max，与 DeepSeek 官方一致"
        @click="emit('patch', { reasoningEfforts: [...DEEPSEEK_THINKING_LEVELS] })"
      >
        DeepSeek 档位
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.params {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.params__row {
  display: grid;
  align-items: center;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
}

.params__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.params__inputs {
  display: flex;
  gap: var(--space-3);
}

.params__efforts {
  display: grid;
  align-items: center;
  gap: var(--space-2);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.params__label {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
