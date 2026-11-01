<script setup lang="ts">
import { NInput } from 'naive-ui'

import type { PriceForm } from './price-form'

/**
 * 价格录入（12 §6.1）：界面按「积分 / 百万 token」填，接口收「微积分 / 百万 token」。
 *
 * 值是**文本**（`PriceForm`），由调用方在提交时用 `pointsToMicro` 换算 —— 这样空串能区分
 * 「不填 / 同输入价」（cache 两项为空 = null），半途的数字也不会被 Number 悄悄改掉。
 */
const props = defineProps<{ price: PriceForm; disabled?: boolean }>()

const emit = defineEmits<{ 'update:price': [price: PriceForm] }>()

function patch(key: keyof PriceForm, value: string): void {
  emit('update:price', { ...props.price, [key]: value })
}
</script>

<template>
  <div class="price-fields">
    <label class="price-fields__field">
      <span class="price-fields__label">输入</span>
      <NInput
        :value="price.input"
        size="small"
        :disabled="disabled"
        placeholder="1"
        @update:value="(value: string) => patch('input', value)"
      />
    </label>
    <label class="price-fields__field">
      <span class="price-fields__label">输出</span>
      <NInput
        :value="price.output"
        size="small"
        :disabled="disabled"
        placeholder="2"
        @update:value="(value: string) => patch('output', value)"
      />
    </label>
    <label class="price-fields__field">
      <span class="price-fields__label" title="留空 = 与输入价相同">缓存读</span>
      <NInput
        :value="price.cacheRead"
        size="small"
        :disabled="disabled"
        placeholder="0.1"
        @update:value="(value: string) => patch('cacheRead', value)"
      />
    </label>
    <label class="price-fields__field">
      <span class="price-fields__label" title="留空 = 与输入价相同">缓存写</span>
      <NInput
        :value="price.cacheWrite"
        size="small"
        :disabled="disabled"
        placeholder="留空"
        @update:value="(value: string) => patch('cacheWrite', value)"
      />
    </label>
    <label class="price-fields__field">
      <span class="price-fields__label" title="每次请求的固定费用（积分 / 次）">每次请求</span>
      <NInput
        :value="price.perRequest"
        size="small"
        :disabled="disabled"
        placeholder="0"
        @update:value="(value: string) => patch('perRequest', value)"
      />
    </label>
  </div>
</template>

<style scoped>
.price-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}

.price-fields__field {
  display: flex;
  width: 104px;
  flex-direction: column;
  gap: 2px;
}

.price-fields__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
