<script setup lang="ts">
import { NCollapse, NCollapseItem, NTag } from 'naive-ui'
import { computed } from 'vue'

import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'

/**
 * 接入说明折叠面板（12 §10 第 4 条）：Base URL、Claude Code、OpenAI 兼容客户端、curl
 * 四个可复制片段。密钥不在这里显示（在「API 密钥」里新建 / 重置后复制）。
 *
 * 07 §2.7：四个面板下面的说明句删掉，只在标题后留一个 InfoTip（公网入口的限制）。
 */
const props = withDefaults(
  defineProps<{
    /** `HUB_PUBLIC_ORIGIN` + `/v1` */
    publicBaseUrl: string
    /** 我的 DSH 是否已经接上中转站 */
    dshAttached?: boolean
  }>(),
  { dshAttached: false },
)

/** Claude Code 的 `ANTHROPIC_BASE_URL` 要的是去掉 `/v1` 的地址（12 §10） */
const anthropicBaseUrl = computed(() => props.publicBaseUrl.replace(/\/v1\/?$/, ''))
const keyPlaceholder = 'sk-dsh-……'

const claudeSnippet = computed(
  () => `export ANTHROPIC_BASE_URL=${anthropicBaseUrl.value}
export ANTHROPIC_AUTH_TOKEN=${keyPlaceholder}
# 然后把 Claude Code 指向这个地址即可（模型名用「可用模型」里的名字）`,
)

const openaiSnippet = computed(
  () => `export OPENAI_BASE_URL=${props.publicBaseUrl}
export OPENAI_API_KEY=${keyPlaceholder}`,
)

const curlSnippet = computed(
  () => `curl ${props.publicBaseUrl}/chat/completions \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "content-type: application/json" \\
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'`,
)
</script>

<template>
  <div class="guide">
    <div class="guide__head">
      <p class="guide__title">DSH 接入状态</p>
      <InfoTip
        label="接入说明"
        text="下面的地址给外部工具用；公网入口开通前只能在服务器本机访问，容器里的 DSH 走内部地址，不受影响。"
      />
      <NTag v-if="dshAttached" size="small" :bordered="false" type="success">你的 DSH 已自动接入</NTag>
      <NTag v-else size="small" :bordered="false" type="warning"
        >DSH 还没接上：等管理员通过「统一下发」同步模型配置</NTag
      >
    </div>

    <NCollapse :default-expanded-names="['base']" arrow-placement="right">
      <NCollapseItem title="Base URL（给任意兼容客户端）" name="base">
        <CopyText :text="publicBaseUrl" label="Base URL" truncate />
      </NCollapseItem>

      <NCollapseItem title="Claude Code（Anthropic 协议）" name="claude">
        <CopyText :text="claudeSnippet" block />
      </NCollapseItem>

      <NCollapseItem title="OpenAI 兼容客户端" name="openai">
        <CopyText :text="openaiSnippet" block />
      </NCollapseItem>

      <NCollapseItem title="curl 试一试" name="curl">
        <CopyText :text="curlSnippet" block />
      </NCollapseItem>
    </NCollapse>
  </div>
</template>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.guide__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.guide__title {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}
</style>
