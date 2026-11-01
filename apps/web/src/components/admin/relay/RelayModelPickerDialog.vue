<script setup lang="ts">
import type { RelayChannel, RelayScope } from '@dsh-hub/shared'
import { NModal } from 'naive-ui'
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import RelayModelPicker from '@/components/admin/relay/RelayModelPicker.vue'
import { relayScopePage } from '@/utils/relay-scope'

/**
 * 模型选择器弹窗（12 §10）：渠道 Tab 行操作「选择模型」/ 点模型数，以及模型 Tab 的「添加模型」
 * （`channel = null`，先在弹窗里选渠道）。
 *
 * 每次打开换一个 key，让里面的选择器重新拉一次上游列表与已挂路由；手机上占满视口宽度。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    channel: RelayChannel | null
    channels: RelayChannel[]
    /** 18 §6：模型只属于一个作用域；缺省 = DSH */
    scope?: RelayScope
  }>(),
  { scope: 'dsh' },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  changed: []
}>()

const router = useRouter()
const mountKey = ref(0)

watch(
  () => props.show,
  (visible) => {
    if (visible) mountKey.value += 1
  },
)

/** 导入完点「去定价」：跳「模型与价格」并打开「只看未定价」（12 §10） */
function gotoPricing(): void {
  emit('update:show', false)
  void router.push({ path: relayScopePage(props.scope), query: { tab: 'models', unpriced: '1' } })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="channel ? `选择模型 · ${channel.name}` : '添加模型'"
    :style="{ width: 'calc(100vw - 24px)', maxWidth: '820px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <RelayModelPicker
      v-if="show"
      :key="mountKey"
      :channel="channel"
      :channels="channels"
      :scope="scope"
      @changed="emit('changed')"
      @goto-pricing="gotoPricing"
      @dismiss="emit('update:show', false)"
    />
  </NModal>
</template>
