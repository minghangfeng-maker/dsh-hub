<script setup lang="ts">
import type { ModelApi, RelayChannel, RelayScope } from '@dsh-hub/shared'
import { AGENT_MODE_API } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSteps,
  NStep,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { createRelayChannel } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import RelayModelPicker from '@/components/admin/relay/RelayModelPicker.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { CHANNEL_SLUG_HINT, isValidChannelSlug } from '@/utils/channel-slug'
import { permilleToRateInput, rateToPermille } from '@/utils/rate'
import { isAgentModeScope, relayScopePage } from '@/utils/relay-scope'

/**
 * 「添加渠道」两步弹窗（12 §10）：
 * ① 渠道信息（模板预填、名称、地址、密钥、倍率、协议；「更多设置」折叠里是优先级等）
 *    → 「下一步：获取模型」= 建渠道 + 自动拉取上游模型；
 * ② 选择模型（模型选择器，`import` **不带价格**）→ 「去定价」或「跳过」。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    /** 18 §6：在 Claude Code / Codex 页里建渠道时协议固定、不显示协议选择；缺省 = DSH */
    scope?: RelayScope
  }>(),
  { scope: 'dsh' },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  changed: []
}>()

const router = useRouter()
const message = useMessage()

/** 对话模式的渠道协议是固定的（18 D8），界面上不再给选择 */
const fixedApi = computed<ModelApi | null>(() =>
  isAgentModeScope(props.scope) ? AGENT_MODE_API[props.scope] : null,
)
const isAgentMode = computed(() => fixedApi.value !== null)
const baseUrlPlaceholder = computed(() => {
  if (props.scope === 'claude-code') return 'https://api.anthropic.com/v1'
  if (props.scope === 'codex') return 'https://api.openai.com/v1'
  return 'https://api.example.com/v1'
})
const namePlaceholder = computed(() =>
  props.scope === 'claude-code'
    ? 'Anthropic 官方'
    : props.scope === 'codex'
      ? 'OpenAI 官方'
      : '上游渠道 C',
)

const step = ref(0)
const saving = ref(false)
const errorText = ref('')
const created = ref<RelayChannel | null>(null)

/** 只做预填：选了模板会覆盖名称 / 地址 / 协议，其它字段保持不动 */
const TEMPLATES = [
  { label: '自定义（自己填）', name: '', baseUrl: '', apis: [] as ModelApi[] },
  {
    label: 'DeepSeek（OpenAI 兼容）',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    apis: ['openai-completions'] as ModelApi[],
  },
  {
    label: 'OpenRouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apis: ['openai-completions'] as ModelApi[],
  },
  {
    label: 'OpenAI 官方',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apis: ['openai-completions'] as ModelApi[],
  },
  {
    label: 'Anthropic 官方',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apis: ['anthropic-messages'] as ModelApi[],
  },
]

const API_OPTIONS = [
  { label: 'openai-completions（/chat/completions）', value: 'openai-completions' },
  { label: 'openai-responses（/responses）', value: 'openai-responses' },
  { label: 'anthropic-messages（/messages）', value: 'anthropic-messages' },
]

const EMPTY_FORM = {
  name: '',
  slug: '',
  baseUrl: '',
  keysText: '',
  rate: '1',
  apis: ['openai-completions'] as ModelApi[],
  priority: 0,
  weight: 1,
  maxConcurrency: 0,
  timeoutMs: 600_000,
  proxyUrl: '',
  headersText: '',
  streamUsage: true,
  note: '',
}

const form = ref({ ...EMPTY_FORM })
const slugError = ref('')

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    step.value = 0
    created.value = null
    errorText.value = ''
    slugError.value = ''
    form.value = {
      ...EMPTY_FORM,
      apis: fixedApi.value ? [fixedApi.value] : ['openai-completions'],
    }
  },
)

const keyCount = computed(
  () =>
    form.value.keysText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length,
)

function applyTemplate(label: string): void {
  const template = TEMPLATES.find((item) => item.label === label)
  if (!template || !template.baseUrl || isAgentMode.value) return
  form.value.name = template.name
  form.value.baseUrl = template.baseUrl
  form.value.apis = [...template.apis]
}

function parseHeaders(): Record<string, string> | null {
  const text = form.value.headersText.trim()
  if (!text) return null
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('额外请求头必须是 JSON 对象')
  for (const key of Object.keys(parsed)) {
    if (['authorization', 'x-api-key', 'cookie'].includes(key.toLowerCase())) {
      throw new Error('额外请求头里不能写 authorization / x-api-key / cookie')
    }
  }
  return parsed as Record<string, string>
}

/** 「下一步：获取模型」：建渠道（顺带加密钥）→ 交给第 2 步的选择器去 discover */
async function next(): Promise<void> {
  errorText.value = ''
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    errorText.value = '名称与地址都要填'
    return
  }
  if (keyCount.value === 0) {
    errorText.value = '至少填一把密钥（一行一把）'
    return
  }
  slugError.value = ''
  const slug = form.value.slug.trim()
  if (slug && !isValidChannelSlug(slug)) {
    slugError.value = '标识只能用小写字母、数字和 -，以字母或数字开头，最长 24 位'
    return
  }
  const permille = rateToPermille(form.value.rate)
  if (permille === null) {
    errorText.value = '倍率填 0–100 的数字，最多 3 位小数'
    return
  }
  const apis = fixedApi.value ? [fixedApi.value] : form.value.apis
  if (apis.length === 0) {
    errorText.value = '至少选一个协议'
    return
  }

  let headers: Record<string, string> | null
  try {
    headers = parseHeaders()
  } catch (cause) {
    errorText.value = cause instanceof Error ? cause.message : '额外请求头不是合法的 JSON'
    return
  }

  saving.value = true
  try {
    const keys = form.value.keysText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    created.value = await createRelayChannel({
      name: form.value.name.trim(),
      ...(slug ? { slug } : {}),
      baseUrl: form.value.baseUrl.trim(),
      apis,
      ...(props.scope !== 'dsh' ? { scope: props.scope } : {}),
      ratePermille: permille,
      priority: form.value.priority,
      weight: form.value.weight,
      maxConcurrency: form.value.maxConcurrency,
      timeoutMs: form.value.timeoutMs,
      proxyUrl: form.value.proxyUrl.trim() || null,
      headers,
      streamUsage: form.value.streamUsage,
      enabled: true,
      note: form.value.note,
      keys,
    })
    message.success(`已创建渠道 ${created.value.name}`)
    emit('changed')
    step.value = 1
  } catch (cause) {
    const description = describeError(cause)
    if (description.fieldErrors['slug']) slugError.value = description.fieldErrors['slug']
    else errorText.value = description.message
  } finally {
    saving.value = false
  }
}

function close(): void {
  emit('update:show', false)
}

/** 第 2 步的「去定价」：跳「模型与价格」并打开「只看未定价」（12 §10） */
function gotoPricing(): void {
  close()
  void router.push({ path: relayScopePage(props.scope), query: { tab: 'models', unpriced: '1' } })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="添加渠道"
    :style="{ width: 'calc(100vw - 24px)', maxWidth: '760px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NSteps :current="step + 1" size="small" class="add-channel__steps">
      <NStep title="渠道信息" />
      <NStep title="选择模型" />
    </NSteps>

    <NAlert v-if="errorText" type="error" :bordered="false" class="add-channel__alert">{{
      errorText
    }}</NAlert>

    <!-- 第 1 步：渠道信息 -->
    <NForm v-if="step === 0" label-placement="top" size="small" class="add-channel__form">
      <NFormItem v-if="!isAgentMode" label="模板">
        <NSelect
          :options="TEMPLATES.map((item) => ({ label: item.label, value: item.label }))"
          placeholder="选一个常见上游，或者自己填"
          data-testid="add-channel-template"
          @update:value="applyTemplate"
        />
      </NFormItem>

      <NFormItem label="名称" required>
        <NInput v-model:value="form.name" :placeholder="namePlaceholder" data-testid="add-channel-name" />
      </NFormItem>

      <NFormItem>
        <template #label>
          标识
          <InfoTip :text="CHANNEL_SLUG_HINT" label="渠道标识说明" />
        </template>
        <NInput
          v-model:value="form.slug"
          placeholder="留空按名称生成"
          data-testid="add-channel-slug"
          :status="slugError ? 'error' : undefined"
          @update:value="slugError = ''"
        />
        <span v-if="slugError" class="add-channel__field-error" role="alert">{{ slugError }}</span>
      </NFormItem>

      <NFormItem required>
        <template #label>
          地址
          <InfoTip text="填到 `/chat/completions`、`/messages` 之前的那一段，末尾不要带 `/`。" />
        </template>
        <NInput
          v-model:value="form.baseUrl"
          :placeholder="baseUrlPlaceholder"
          data-testid="add-channel-url"
        />
      </NFormItem>

      <NFormItem label="密钥" required>
        <NInput
          v-model:value="form.keysText"
          type="textarea"
          :rows="3"
          placeholder="一行一把，至少一把&#10;sk-xxxx"
          data-testid="add-channel-keys"
        />
      </NFormItem>

      <NFormItem required>
        <template #label>
          倍率
          <InfoTip text="这条渠道上的费用 = 模型价格 × 倍率；倍率在 0–100 之间，最多 3 位小数。" />
        </template>
        <NInput
          v-model:value="form.rate"
          placeholder="1"
          data-testid="add-channel-rate"
          :style="{ maxWidth: '140px' }"
        />
      </NFormItem>

      <NFormItem v-if="!fixedApi" label="支持的协议" required>
        <NCheckboxGroup v-model:value="form.apis">
          <div class="add-channel__apis">
            <NCheckbox v-for="option in API_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </NCheckbox>
          </div>
        </NCheckboxGroup>
      </NFormItem>
      <NFormItem v-else label="协议">
        <span class="add-channel__fixed-api" data-testid="add-channel-fixed-api">
          {{ API_OPTIONS.find((option) => option.value === fixedApi)?.label ?? fixedApi }}
        </span>
      </NFormItem>

      <NCollapse>
        <NCollapseItem title="更多设置（优先级、并发、代理、请求头…）" name="more">
          <div class="add-channel__grid">
            <NFormItem label="优先级（大的优先）">
              <NInputNumber
                v-model:value="form.priority"
                size="small"
                :min="-100"
                :max="100"
                :show-button="false"
              />
            </NFormItem>
            <NFormItem label="权重（同优先级分流）">
              <NInputNumber
                v-model:value="form.weight"
                size="small"
                :min="1"
                :max="100"
                :show-button="false"
              />
            </NFormItem>
            <NFormItem label="并发上限（0 = 不限）">
              <NInputNumber
                v-model:value="form.maxConcurrency"
                size="small"
                :min="0"
                :max="1000"
                :show-button="false"
              />
            </NFormItem>
            <NFormItem label="超时（毫秒）">
              <NInputNumber
                v-model:value="form.timeoutMs"
                size="small"
                :min="5000"
                :max="3600000"
                :show-button="false"
              />
            </NFormItem>
          </div>

          <NFormItem label="代理（可选，给连不上的上游）">
            <NInput v-model:value="form.proxyUrl" placeholder="http://127.0.0.1:7890" />
          </NFormItem>

          <NFormItem label="额外请求头（JSON，可选）">
            <NInput
              v-model:value="form.headersText"
              type="textarea"
              :rows="2"
              placeholder='{ "x-relay-pool": "family" }'
            />
          </NFormItem>

          <NFormItem label="流式请求自动补 stream_options.include_usage">
            <div class="add-channel__switch">
              <NSwitch v-model:value="form.streamUsage" size="small" />
            </div>
          </NFormItem>

          <NFormItem label="备注">
            <NInput v-model:value="form.note" maxlength="500" placeholder="这把池子是谁的、什么时候换密钥" />
          </NFormItem>
        </NCollapseItem>
      </NCollapse>
    </NForm>

    <!-- 第 2 步：选择模型（同一个模型选择器） -->
    <RelayModelPicker
      v-else-if="created"
      :channel="created"
      :channels="[created]"
      :scope="scope"
      dismiss-text="跳过"
      @changed="emit('changed')"
      @goto-pricing="gotoPricing"
      @dismiss="close"
    />

    <!-- 第 2 步的按钮在模型选择器自己的操作行里（跳过 / 添加 N 个模型），所以这里只给第 1 步留页脚 -->
    <template v-if="step === 0" #footer>
      <div class="add-channel__footer">
        <span class="add-channel__hint">
          已填 {{ keyCount }} 把密钥 · 倍率 {{ permilleToRateInput(rateToPermille(form.rate)) || '—' }}
        </span>
        <NButton size="small" @click="close">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" data-testid="add-channel-next" @click="next">
          下一步：获取模型
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.add-channel__steps {
  margin-bottom: var(--space-4);
}

.add-channel__alert {
  border-radius: var(--radius-control);
  margin-bottom: var(--space-3);
}

.add-channel__grid {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.add-channel__apis {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.add-channel__rate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.add-channel__switch {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.add-channel__fixed-api {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.add-channel__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.add-channel__field-error {
  margin-top: 2px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.add-channel__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.add-channel__footer .add-channel__fixed-api {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.add-channel__hint {
  flex: 1;
  min-width: 140px;
  text-align: left;
}
</style>
