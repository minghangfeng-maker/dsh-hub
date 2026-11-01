<script setup lang="ts">
import {
  TOOL_CHANNEL_DEFAULT_BASE_URL,
  type TestToolChannelResponse,
  type ToolChannel,
  type ToolChannelKind,
  type ToolKind,
} from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { describeError } from '@/api/errors'
import {
  addToolChannelKeys,
  createToolChannel,
  deleteToolChannelKey,
  testToolChannel,
  updateToolChannel,
  updateToolChannelKey,
} from '@/api/tools'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { formatDateTime } from '@/composables/useFormat'
import { microToPointsInput, pointsToMicro } from '@/utils/points'
import { cooldownReasonText, parsePastedKeys, toolKeyStateTone, TOOL_KEY_STATE_TEXT } from '@/utils/tool-keys'

/**
 * 搜索池渠道的「新建 / 编辑」抽屉（14 §3.2 §7）。
 *
 * - 新建：选类型（切换时自动填该类型的默认地址）、名称、支持的工具、优先级/权重/超时/代理、
 *   两种上游成本估算、备注，可顺手批量粘贴密钥（一行一把）。
 * - 编辑：类型不可改；密钥池换成子表（末 4 位、状态、冷却原因、本月调用、启停、清除冷却、删除），
 *   可批量追加，也可用第一把可用密钥「测试」。
 */
const props = defineProps<{
  show: boolean
  /** null = 新建 */
  channel: ToolChannel | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

const form = ref({
  kind: 'tavily' as ToolChannelKind,
  name: '',
  baseUrl: '',
  tools: ['search', 'fetch'] as ToolKind[],
  priority: 10,
  weight: 1,
  timeoutMs: 30_000,
  proxyUrl: '',
  searchCostText: '0',
  fetchCostText: '0',
  enabled: true,
  note: '',
})

const keysText = ref('')
const keyLabel = ref('')
const saving = ref(false)
const testing = ref(false)
const errorText = ref('')
const testResult = ref<TestToolChannelResponse | null>(null)

const isCreate = computed(() => props.channel === null)
const current = computed(() => props.channel)

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const channel = props.channel
    errorText.value = ''
    testResult.value = null
    keysText.value = ''
    keyLabel.value = ''

    if (channel) {
      form.value = {
        kind: channel.kind,
        name: channel.name,
        baseUrl: channel.baseUrl,
        tools: [...channel.tools],
        priority: channel.priority,
        weight: channel.weight,
        timeoutMs: channel.timeoutMs,
        proxyUrl: channel.proxyUrl ?? '',
        searchCostText: microToPointsInput(channel.searchCostMicro),
        fetchCostText: microToPointsInput(channel.fetchCostMicro),
        enabled: channel.enabled,
        note: channel.note,
      }
    } else {
      form.value = {
        kind: 'tavily',
        name: '',
        baseUrl: TOOL_CHANNEL_DEFAULT_BASE_URL.tavily,
        tools: ['search', 'fetch'],
        priority: 10,
        weight: 1,
        timeoutMs: 30_000,
        proxyUrl: '',
        searchCostText: '0',
        fetchCostText: '0',
        enabled: true,
        note: '',
      }
    }
  },
)

/** 类型切换：只把「还是默认地址」的输入框换成新类型的默认地址，管理员手填过的不动 */
function changeKind(kind: ToolChannelKind): void {
  const defaults = Object.values(TOOL_CHANNEL_DEFAULT_BASE_URL)
  if (!form.value.baseUrl.trim() || defaults.includes(form.value.baseUrl.trim())) {
    form.value.baseUrl = TOOL_CHANNEL_DEFAULT_BASE_URL[kind]
  }
}

function costMicro(text: string): number | null {
  return pointsToMicro(text)
}

async function save(): Promise<void> {
  errorText.value = ''
  const name = form.value.name.trim()
  const baseUrl = form.value.baseUrl.trim()
  if (!name) {
    errorText.value = '渠道名称要填'
    return
  }
  if (!baseUrl) {
    errorText.value = '地址要填'
    return
  }
  if (form.value.tools.length === 0) {
    errorText.value = '至少选一个工具（搜索 / 抓取）'
    return
  }
  const searchCostMicro = costMicro(form.value.searchCostText)
  const fetchCostMicro = costMicro(form.value.fetchCostText)
  if (searchCostMicro === null || fetchCostMicro === null) {
    errorText.value = '成本估算填得不对：填数字，最多 6 位小数'
    return
  }

  saving.value = true
  try {
    if (props.channel) {
      const channel = await updateToolChannel(props.channel.id, {
        name,
        baseUrl,
        tools: form.value.tools,
        priority: form.value.priority,
        weight: form.value.weight,
        timeoutMs: form.value.timeoutMs,
        proxyUrl: form.value.proxyUrl.trim() || null,
        searchCostMicro,
        fetchCostMicro,
        enabled: form.value.enabled,
        note: form.value.note,
      })
      message.success(`已保存渠道 ${channel.name}`)
    } else {
      const parsed = parsePastedKeys(keysText.value)
      const channel = await createToolChannel({
        kind: form.value.kind,
        name,
        baseUrl,
        tools: form.value.tools,
        priority: form.value.priority,
        weight: form.value.weight,
        timeoutMs: form.value.timeoutMs,
        proxyUrl: form.value.proxyUrl.trim() || null,
        searchCostMicro,
        fetchCostMicro,
        enabled: form.value.enabled,
        note: form.value.note,
        keys: parsed.keys.length > 0 ? parsed.keys : undefined,
      })
      message.success(
        parsed.keys.length > 0 ? `已建渠道 ${channel.name}，加入 ${parsed.keys.length} 把密钥` : `已建渠道 ${channel.name}`,
      )
    }
    emit('saved')
    emit('update:show', false)
  } catch (cause) {
    errorText.value = describeError(cause).message
  } finally {
    saving.value = false
  }
}

async function runTest(): Promise<void> {
  const channel = props.channel
  if (!channel) return
  testing.value = true
  try {
    const result = await testToolChannel(channel.id)
    testResult.value = result
    if (result.ok) message.success(`连通，返回 ${result.results ?? 0} 条结果`)
    else message.warning('测试没通过，看看下面的原因')
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    testing.value = false
  }
}

async function addKeys(): Promise<void> {
  const channel = props.channel
  if (!channel) return
  const parsed = parsePastedKeys(keysText.value)
  if (parsed.keys.length === 0) {
    message.warning(parsed.skipped > 0 ? '都是重复的密钥，没有新增' : '一行一把，先把密钥粘进来')
    return
  }
  try {
    const result = await addToolChannelKeys(channel.id, { keys: parsed.keys, label: keyLabel.value })
    keysText.value = ''
    message.success(`新增 ${result.added}、跳过 ${result.skipped}`)
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function setKeyState(keyId: number, state: 'active' | 'disabled'): Promise<void> {
  const channel = props.channel
  if (!channel) return
  try {
    await updateToolChannelKey(channel.id, keyId, { state })
    message.success(state === 'active' ? '已启用（被自动停用的这就是人工恢复）' : '已停用')
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function resetCooldown(keyId: number): Promise<void> {
  const channel = props.channel
  if (!channel) return
  try {
    await updateToolChannelKey(channel.id, keyId, { resetCooldown: true })
    message.success('已清除冷却')
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function removeKey(keyId: number): Promise<void> {
  const channel = props.channel
  if (!channel) return
  try {
    await deleteToolChannelKey(channel.id, keyId)
    message.success('密钥已删除')
    emit('saved')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

function keySubline(key: NonNullable<ToolChannel['keys']>[number]): string {
  if (key.state === 'auto-disabled') return key.lastError || '上游判定密钥无效'
  if (key.cooldownUntil && Date.parse(key.cooldownUntil) > Date.now()) {
    return `${cooldownReasonText(key.cooldownReason)} · 到 ${formatDateTime(key.cooldownUntil)}`
  }
  return key.label || '未命名'
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="700"
    placement="right"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NDrawerContent :title="isCreate ? '新建搜索池渠道' : `编辑渠道 ${current?.name ?? ''}`" closable>
      <NForm label-placement="top" size="small" class="tool-channel__form">
        <NFormItem label="类型" required>
          <NRadioGroup
            :value="form.kind"
            size="small"
            :disabled="!isCreate"
            data-testid="tool-channel-kind"
            @update:value="
              (value: ToolChannelKind) => {
                form.kind = value
                changeKind(value)
              }
            "
          >
            <NRadioButton value="tavily">Tavily</NRadioButton>
            <NRadioButton value="deepseek">DeepSeek</NRadioButton>
          </NRadioGroup>
          <span v-if="!isCreate" class="tool-channel__hint">类型建好之后不能改。</span>
        </NFormItem>

        <NFormItem label="名称" required>
          <NInput v-model:value="form.name" placeholder="Tavily 免费池" data-testid="tool-channel-name" />
        </NFormItem>

        <NFormItem label="地址" required>
          <NInput v-model:value="form.baseUrl" data-testid="tool-channel-url" />
        </NFormItem>

        <NFormItem label="支持的工具" required>
          <NCheckboxGroup v-model:value="form.tools" data-testid="tool-channel-tools">
            <div class="tool-channel__tools">
              <NCheckbox value="search">搜索（search）</NCheckbox>
              <NCheckbox value="fetch">抓取（fetch）</NCheckbox>
            </div>
          </NCheckboxGroup>
        </NFormItem>

        <div class="tool-channel__grid">
          <NFormItem>
            <template #label>
              优先级
              <InfoTip text="大的优先；同级按权重分流。建议 Tavily（免费）高于 DeepSeek（兜底）。" />
            </template>
            <NInputNumber v-model:value="form.priority" size="small" :min="-100" :max="100" :show-button="false" />
          </NFormItem>
          <NFormItem label="权重">
            <NInputNumber v-model:value="form.weight" size="small" :min="1" :max="100" :show-button="false" />
          </NFormItem>
          <NFormItem label="超时（毫秒）">
            <NInputNumber
              v-model:value="form.timeoutMs"
              size="small"
              :min="1000"
              :max="300000"
              :step="1000"
              :show-button="false"
            />
          </NFormItem>
        </div>

        <NFormItem label="代理（可选，给连不上的上游）">
          <NInput v-model:value="form.proxyUrl" placeholder="http://127.0.0.1:7890" />
        </NFormItem>

        <div class="tool-channel__grid">
          <NFormItem>
            <template #label>
              搜索成本（积分 / 次）
              <InfoTip text="只用于统计毛利，不影响向用户收费。Tavily 免费额度填 0。" />
            </template>
            <NInput v-model:value="form.searchCostText" placeholder="0" data-testid="tool-channel-search-cost" />
          </NFormItem>
          <NFormItem label="抓取成本（积分 / 次）">
            <NInput v-model:value="form.fetchCostText" placeholder="0" data-testid="tool-channel-fetch-cost" />
          </NFormItem>
        </div>

        <NFormItem label="备注">
          <NInput v-model:value="form.note" maxlength="500" placeholder="这把池子是谁的、什么时候换密钥" />
        </NFormItem>

        <NFormItem label="启用">
          <NSwitch v-model:value="form.enabled" size="small" />
        </NFormItem>
      </NForm>

      <NAlert v-if="errorText" type="error" :bordered="false" class="tool-channel__alert">{{ errorText }}</NAlert>

      <!-- 新建：顺手粘贴密钥；编辑：密钥池子表 -->
      <template v-if="isCreate">
        <p class="tool-channel__section">密钥（可选，一行一把）</p>
        <NInput
          v-model:value="keysText"
          type="textarea"
          :rows="4"
          placeholder="一行一把，空行忽略、重复的跳过"
          data-testid="tool-channel-new-keys"
        />
      </template>

      <template v-else>
        <div class="tool-channel__section-row">
          <p class="tool-channel__section">密钥池</p>
          <span class="tool-channel__hint">
            可用 {{ (current?.keys ?? []).filter((key) => key.state === 'active').length }} /
            {{ (current?.keys ?? []).length }}
          </span>
          <div class="tool-channel__section-actions">
            <NButton size="tiny" :loading="testing" data-testid="tool-channel-test" @click="runTest">
              <template #icon><span class="i-ph-plugs-connected" aria-hidden="true" /></template>
              测试
            </NButton>
          </div>
        </div>

        <div v-if="testResult" class="tool-channel__test">
          <MiniTag
            :text="testResult.ok ? '连通' : '失败'"
            :tone="testResult.ok ? 'success' : 'danger'"
            size="sm"
          />
          <span class="tool-channel__hint">
            {{ testResult.durationMs }} ms · 结果 {{ testResult.results ?? '—' }} 条
          </span>
          <span v-if="testResult.error" class="tool-channel__key-error">{{ testResult.error }}</span>
        </div>

        <ul class="tool-channel__keys">
          <li v-for="key in current?.keys ?? []" :key="key.id" class="tool-channel__key">
            <span class="tool-channel__key-last4">····{{ key.last4 }}</span>
            <MiniTag :text="TOOL_KEY_STATE_TEXT[key.state]" :tone="toolKeyStateTone(key.state)" size="sm" />
            <span class="tool-channel__key-sub" :title="key.lastError ?? ''">{{ keySubline(key) }}</span>
            <span class="tool-channel__hint">本月 {{ key.monthCalls }} 次</span>
            <span class="tool-channel__key-spacer" />
            <NButton
              v-if="key.state !== 'active'"
              size="tiny"
              quaternary
              @click="setKeyState(key.id, 'active')"
            >
              {{ key.state === 'auto-disabled' ? '恢复' : '启用' }}
            </NButton>
            <NButton v-else size="tiny" quaternary @click="setKeyState(key.id, 'disabled')">停用</NButton>
            <NButton
              v-if="key.cooldownUntil"
              size="tiny"
              quaternary
              @click="resetCooldown(key.id)"
            >
              清除冷却
            </NButton>
            <NPopconfirm @positive-click="removeKey(key.id)">
              <template #trigger>
                <NButton size="tiny" type="error" ghost>删除</NButton>
              </template>
              删掉这把密钥后，用到它的候选会少一个。确定吗？
            </NPopconfirm>
          </li>
          <li v-if="(current?.keys ?? []).length === 0" class="tool-channel__hint">还没有密钥，下面批量加一批。</li>
        </ul>

        <div class="tool-channel__add-keys">
          <NInput
            v-model:value="keysText"
            type="textarea"
            :rows="3"
            placeholder="批量添加：一行一把密钥，空行忽略、重复的跳过"
            data-testid="tool-channel-add-keys"
          />
          <div class="tool-channel__add-keys-row">
            <NInput v-model:value="keyLabel" size="small" placeholder="标签（可选，如「主密钥」）" />
            <NButton size="small" type="primary" data-testid="tool-channel-add-keys-btn" @click="addKeys">
              批量添加
            </NButton>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="tool-channel__footer">
          <NButton size="small" @click="emit('update:show', false)">取消</NButton>
          <NButton size="small" type="primary" :loading="saving" data-testid="tool-channel-save" @click="save">
            保存
          </NButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.tool-channel__form {
  display: grid;
  gap: var(--space-1) var(--space-4);
}

.tool-channel__grid {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.tool-channel__tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tool-channel__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.tool-channel__alert {
  margin-bottom: var(--space-3);
  border-radius: var(--radius-control);
}

.tool-channel__section {
  margin-top: var(--space-3);
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.tool-channel__section-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.tool-channel__section-actions {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}

.tool-channel__test {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--fs-13);
}

.tool-channel__keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.tool-channel__key {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  font-size: var(--fs-13);
}

.tool-channel__key-last4 {
  font-family: var(--font-mono);
}

.tool-channel__key-sub {
  max-width: 220px;
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-channel__key-error {
  max-width: 280px;
  overflow: hidden;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-channel__key-spacer {
  margin-left: auto;
}

.tool-channel__add-keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.tool-channel__add-keys-row {
  display: flex;
  gap: var(--space-2);
}

.tool-channel__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
