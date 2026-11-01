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
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import {
  addRelayChannelKeys,
  deleteRelayChannelKey,
  testRelayChannel,
  updateRelayChannel,
  updateRelayChannelKey,
} from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { formatDateTime } from '@/composables/useFormat'
import { CHANNEL_SLUG_HINT, channelSlugFromName, isValidChannelSlug } from '@/utils/channel-slug'
import { permilleToRateInput, rateToPermille } from '@/utils/rate'
import { isAgentModeScope } from '@/utils/relay-scope'

/**
 * 渠道编辑抽屉（12 §10）：表单（名称、地址、协议、**倍率**、优先级/权重/并发/超时/代理/请求头/
 * 备注）+ 密钥池子表（批量添加一行一把、启停、删除、`auto-disabled` 显示原因与「恢复」）+「测试」。
 *
 * 「添加渠道」走两步弹窗（`AddChannelDialog`），选择模型走模型选择器 —— 这里只管编辑。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    channel: RelayChannel | null
    /** 18 §6：对话模式的渠道协议固定，编辑时也不显示协议选择 */
    scope?: RelayScope
  }>(),
  { scope: 'dsh' },
)

/** 固定的协议（对话模式才有）；null = DSH 的渠道可以改协议 */
const fixedApi = computed<ModelApi | null>(() =>
  isAgentModeScope(props.scope) ? AGENT_MODE_API[props.scope] : null,
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

const API_OPTIONS = [
  { label: 'openai-completions（/chat/completions）', value: 'openai-completions' },
  { label: 'openai-responses（/responses）', value: 'openai-responses' },
  { label: 'anthropic-messages（/messages）', value: 'anthropic-messages' },
]

const form = ref({
  name: '',
  slug: '',
  baseUrl: '',
  apis: ['openai-completions'] as ModelApi[],
  rate: '1',
  priority: 0,
  weight: 1,
  maxConcurrency: 0,
  timeoutMs: 600_000,
  proxyUrl: '',
  headersText: '',
  streamUsage: true,
  enabled: true,
  note: '',
})

const saving = ref(false)
const testing = ref(false)
const errorText = ref('')
const slugError = ref('')
const keysText = ref('')
const keyLabel = ref('')

const testResults = ref<
  {
    keyId: number
    last4: string
    ok: boolean
    latencyMs: number
    httpStatus: number | null
    error?: string
  }[]
>([])

/** 表单里的渠道始终跟着 props 里的最新数据（密钥池改完 `current` 也更新） */
const current = computed(() => props.channel)

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const channel = props.channel
    errorText.value = ''
    testResults.value = []
    keysText.value = ''
    keyLabel.value = ''
    slugError.value = ''
    form.value = {
      name: channel?.name ?? '',
      slug: channel?.slug ?? channelSlugFromName(channel?.name ?? ''),
      baseUrl: channel?.baseUrl ?? '',
      apis: channel?.apis ?? ['openai-completions'],
      rate: permilleToRateInput(channel?.ratePermille ?? 1000),
      priority: channel?.priority ?? 0,
      weight: channel?.weight ?? 1,
      maxConcurrency: channel?.maxConcurrency ?? 0,
      timeoutMs: channel?.timeoutMs ?? 600_000,
      proxyUrl: channel?.proxyUrl ?? '',
      headersText: channel?.headers ? JSON.stringify(channel.headers, null, 2) : '',
      streamUsage: channel?.streamUsage ?? true,
      enabled: channel?.enabled ?? true,
      note: channel?.note ?? '',
    }
  },
)

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

async function save(): Promise<void> {
  const channel = props.channel
  if (!channel) return
  errorText.value = ''
  if (!form.value.name.trim() || !form.value.baseUrl.trim()) {
    errorText.value = '名称与地址都要填'
    return
  }
  if (form.value.apis.length === 0) {
    errorText.value = '至少选一个协议'
    return
  }
  const permille = rateToPermille(form.value.rate)
  if (permille === null) {
    errorText.value = '倍率填 0–100 的数字，最多 3 位小数'
    return
  }
  slugError.value = ''
  const slug = form.value.slug.trim() || channelSlugFromName(form.value.name)
  if (slug && !isValidChannelSlug(slug)) {
    slugError.value = '标识只能用小写字母、数字和 -，以字母或数字开头，最长 24 位'
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
    await updateRelayChannel(channel.id, {
      name: form.value.name.trim(),
      ...(slug ? { slug } : {}),
      baseUrl: form.value.baseUrl.trim(),
      apis: form.value.apis,
      ratePermille: permille,
      priority: form.value.priority,
      weight: form.value.weight,
      maxConcurrency: form.value.maxConcurrency,
      timeoutMs: form.value.timeoutMs,
      proxyUrl: form.value.proxyUrl.trim() || null,
      headers,
      streamUsage: form.value.streamUsage,
      enabled: form.value.enabled,
      note: form.value.note,
    })
    message.success(`已保存渠道 ${form.value.name.trim()}`)
    emit('saved')
    emit('update:show', false)
  } catch (cause) {
    const description = describeError(cause)
    if (description.fieldErrors['slug']) slugError.value = description.fieldErrors['slug']
    else errorText.value = description.message
  } finally {
    saving.value = false
  }
}

async function runTest(): Promise<void> {
  const channel = props.channel
  if (!channel) return
  testing.value = true
  try {
    const result = await testRelayChannel(channel.id)
    testResults.value = result.results
    if (!result.ok) message.warning('有密钥没通过测试，看看下面每一行的原因')
    else message.success('所有密钥都能连上')
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    testing.value = false
  }
}

async function addKeys(): Promise<void> {
  const channel = props.channel
  if (!channel) return
  const list = keysText.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (list.length === 0) {
    message.warning('一行一把，先把密钥粘进来')
    return
  }
  try {
    const result = await addRelayChannelKeys(channel.id, { keys: list, label: keyLabel.value })
    keysText.value = ''
    message.success(`加了 ${result.added} 把${result.skipped > 0 ? `，跳过重复的 ${result.skipped} 把` : ''}`)
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function setKeyState(keyId: number, state: 'active' | 'disabled'): Promise<void> {
  const channel = props.channel
  if (!channel) return
  try {
    await updateRelayChannelKey(channel.id, keyId, { state })
    message.success(state === 'active' ? '已启用（如果是被自动停用的，这就是人工恢复）' : '已停用')
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function removeKey(keyId: number): Promise<void> {
  const channel = props.channel
  if (!channel) return
  try {
    await deleteRelayChannelKey(channel.id, keyId)
    message.success('密钥已删除')
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="680"
    placement="right"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NDrawerContent :title="`编辑渠道 ${channel?.name ?? ''}`" closable>
      <NForm label-placement="top" size="small" class="channel__form">
        <NFormItem label="名称" required>
          <NInput v-model:value="form.name" placeholder="上游渠道 C" data-testid="channel-name" />
        </NFormItem>

        <NFormItem>
          <template #label>
            标识
            <InfoTip :text="CHANNEL_SLUG_HINT" label="渠道标识说明" />
          </template>
          <NInput
            v-model:value="form.slug"
            placeholder="留空按名称生成"
            data-testid="channel-slug"
            :status="slugError ? 'error' : undefined"
            @update:value="slugError = ''"
          />
          <span v-if="slugError" class="channel__field-error" role="alert" data-testid="channel-slug-error">
            {{ slugError }}
          </span>
        </NFormItem>

        <NAlert
          v-if="channel && form.slug.trim() && form.slug.trim() !== channel.slug"
          type="warning"
          :bordered="false"
          class="channel__slug-warning"
          data-testid="channel-slug-warning"
        >
          改了以后，用户 DSH 里的模型名会变，要重新下发；外部工具里写的「模型@旧标识」会失效。
        </NAlert>

        <NFormItem required>
          <template #label>
            地址
            <InfoTip text="填到 `/chat/completions`、`/messages` 之前的那一段，末尾不要带 `/`。" />
          </template>
          <NInput
            v-model:value="form.baseUrl"
            placeholder="https://api.example.com/v1"
            data-testid="channel-url"
          />
        </NFormItem>

        <NFormItem v-if="!fixedApi" label="支持的协议" required>
          <NCheckboxGroup v-model:value="form.apis">
            <div class="channel__apis">
              <NCheckbox v-for="option in API_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </NCheckbox>
            </div>
          </NCheckboxGroup>
        </NFormItem>
        <NFormItem v-else label="协议">
          <span class="channel__fixed-api" data-testid="channel-fixed-api">
            {{ API_OPTIONS.find((option) => option.value === fixedApi)?.label ?? fixedApi }}
          </span>
        </NFormItem>

        <NFormItem required>
          <template #label>
            倍率
            <InfoTip text="这条渠道上的费用 = 模型价格 × 倍率；倍率在 0–100 之间，最多 3 位小数。" />
          </template>
          <NInput
            v-model:value="form.rate"
            placeholder="1"
            data-testid="channel-rate"
            :style="{ maxWidth: '140px' }"
          />
        </NFormItem>

        <NCollapse>
          <NCollapseItem title="更多设置（优先级、并发、代理、请求头…）" name="more">
            <div class="channel__grid">
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
              <div class="channel__switch">
                <NSwitch v-model:value="form.streamUsage" size="small" />
              </div>
            </NFormItem>

            <NFormItem label="备注">
              <NInput
                v-model:value="form.note"
                maxlength="500"
                placeholder="这把池子是谁的、什么时候换密钥"
              />
            </NFormItem>

            <NFormItem label="启用">
              <NSwitch v-model:value="form.enabled" size="small" />
            </NFormItem>
          </NCollapseItem>
        </NCollapse>
      </NForm>

      <NAlert v-if="errorText" type="error" :bordered="false" class="channel__alert">{{ errorText }}</NAlert>

      <div class="channel__section-row">
        <p class="channel__section">密钥池</p>
        <span class="channel__hint">
          可用 {{ (current?.keys ?? []).filter((key) => key.state === 'active').length }} /
          {{ (current?.keys ?? []).length }}
        </span>
        <div class="channel__section-actions">
          <NButton size="tiny" :loading="testing" @click="runTest">
            <template #icon><span class="i-ph-plugs-connected" aria-hidden="true" /></template>
            测试
          </NButton>
        </div>
      </div>

      <ul class="channel__keys">
        <li v-for="key in current?.keys ?? []" :key="key.id" class="channel__key">
          <span class="channel__key-last4">····{{ key.last4 }}</span>
          <span class="channel__key-label">{{ key.label || '未命名' }}</span>
          <MiniTag
            :text="key.state === 'active' ? '可用' : key.state === 'disabled' ? '已停用' : '自动停用'"
            :tone="key.state === 'active' ? 'success' : key.state === 'disabled' ? 'neutral' : 'danger'"
            size="sm"
          />
          <span v-if="key.state === 'auto-disabled'" class="channel__key-error" :title="key.lastError ?? ''">
            {{ key.lastError || '上游拒绝了这把密钥' }}
          </span>
          <span v-else-if="key.cooldownUntil" class="channel__key-error">
            冷却到 {{ formatDateTime(key.cooldownUntil) }}
          </span>
          <span class="channel__key-spacer" />
          <NButton
            v-if="key.state !== 'active'"
            size="tiny"
            quaternary
            @click="setKeyState(key.id, 'active')"
          >
            {{ key.state === 'auto-disabled' ? '恢复' : '启用' }}
          </NButton>
          <NButton v-else size="tiny" quaternary @click="setKeyState(key.id, 'disabled')">停用</NButton>
          <NPopconfirm @positive-click="removeKey(key.id)">
            <template #trigger>
              <NButton size="tiny" type="error" ghost>删除</NButton>
            </template>
            删掉这把密钥后，用到它的路由会少一个候选。确定吗？
          </NPopconfirm>
        </li>
        <li v-if="(current?.keys ?? []).length === 0" class="channel__hint">还没有密钥，下面批量加一批。</li>
      </ul>

      <div class="channel__add-keys">
        <NInput v-model:value="keysText" type="textarea" :rows="3" placeholder="批量添加：一行一把密钥" />
        <div class="channel__add-keys-row">
          <NInput v-model:value="keyLabel" size="small" placeholder="标签（可选，如「主密钥」）" />
          <NButton size="small" type="primary" @click="addKeys">批量添加</NButton>
        </div>
      </div>

      <template #footer>
        <div class="channel__footer">
          <NButton size="small" @click="emit('update:show', false)">取消</NButton>
          <NButton size="small" type="primary" :loading="saving" data-testid="channel-save" @click="save">
            保存
          </NButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>

  <!-- 测试结果：每把密钥一行 -->
  <NModal
    :show="testResults.length > 0"
    preset="card"
    title="渠道测试结果"
    :style="{ width: 'calc(100vw - 24px)', maxWidth: '560px' }"
    @update:show="(value: boolean) => (testResults = value ? testResults : [])"
  >
    <ul class="channel__test-list">
      <li v-for="row in testResults" :key="row.keyId" class="channel__test-row">
        <span class="channel__key-last4">····{{ row.last4 }}</span>
        <MiniTag :text="row.ok ? '连通' : '失败'" :tone="row.ok ? 'success' : 'danger'" size="sm" />
        <span class="channel__hint">{{ row.latencyMs }} ms · HTTP {{ row.httpStatus ?? '—' }}</span>
        <span v-if="row.error" class="channel__key-error">{{ row.error }}</span>
      </li>
    </ul>
    <p v-if="testResults.length === 0" class="channel__hint">没有可测试的密钥。</p>
  </NModal>
</template>

<style scoped>
.channel__form {
  display: grid;
  gap: var(--space-1) var(--space-4);
}

.channel__grid {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.channel__fixed-api {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.channel__apis {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.channel__rate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.channel__switch {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.channel__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.channel__alert {
  border-radius: var(--radius-control);
  margin-bottom: var(--space-3);
}

.channel__field-error {
  margin-top: 2px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.channel__slug-warning {
  border-radius: var(--radius-control);
}

.channel__section {
  margin-top: var(--space-3);
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.channel__section-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.channel__section-actions {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}

.channel__keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.channel__key {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  font-size: var(--fs-13);
}

.channel__key-last4 {
  font-family: var(--font-mono);
}

.channel__key-label {
  color: var(--c-text-2);
}

.channel__key-error {
  max-width: 260px;
  overflow: hidden;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel__key-spacer {
  margin-left: auto;
}

.channel__add-keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.channel__add-keys-row {
  display: flex;
  gap: var(--space-2);
}

.channel__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.channel__test-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.channel__test-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
}
</style>
