<script setup lang="ts">
import type {
  DiscoveredModel,
  ModelApi,
  ModelKeyMode,
  ModelProvider,
  ModelProviderKind,
  ModelSpec,
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
  NModal,
  NSelect,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import type { z } from 'zod'

import { CreateProviderRequestSchema } from '@dsh-hub/shared'

import {
  createProvider,
  discoverModels,
  matchModels,
  saveCatalog,
  testProvider,
  updateProvider,
} from '@/api/admin-models'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import MiniTag from '@/components/admin/MiniTag.vue'
import ModelParamsFields from '@/components/admin/ModelParamsFields.vue'
import { fillMissing, hasModelInfo, modelInfoSummary, toCatalogInput } from '@/components/admin/model-info'
import { thinkingLevelsProblem } from '@/components/admin/thinking-levels'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'

/**
 * 提供方编辑抽屉（07 §7.7）：类型 / 路由名 / 显示名 / 协议 / Base URL / 密钥模式 / 密钥（遮罩，
 * 只回显末 4 位）/ 模型列表编辑器 / 兼容项与高级 JSON，以及「测试连接」（延迟 + 模型数）。
 *
 * 模型列表里每个模型可填：上下文、最大输出、输入类型（文字 / 图片）、思考档位。从端点发现模型时，
 * 服务端会按模型名查「模型信息库」把这些参数自动填好；手填的模型可以「按模型库补全」，
 * 填好的参数也可以「存入模型库」，以后同名模型自动带出。
 */
const props = defineProps<{
  show: boolean
  provider: ModelProvider | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

const form = ref({
  routeKey: '',
  displayName: '',
  kind: 'pi-ai' as ModelProviderKind,
  api: 'openai-completions' as ModelApi,
  baseUrl: '',
  keyMode: 'shared' as ModelKeyMode,
  apiKey: '',
  compat: '',
  extra: '',
})

const models = ref<ModelSpec[]>([])
const saving = ref(false)
const testing = ref(false)
const testResult = ref('')
const errorText = ref('')

const isEdit = computed(() => props.provider !== null)
const isPiAi = computed(() => form.value.kind === 'pi-ai')
/** Hub 中转站（12 §7）：baseUrl / models / 密钥由 Hub 决定，管理员只选路由名、显示名与协议 */
const isRelayKind = computed(() => form.value.kind === 'hub-relay')
/** 需要选协议的类型（pi-ai 与 hub-relay 都要） */
const needsApi = computed(() => isPiAi.value || isRelayKind.value)

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const provider = props.provider
    errorText.value = ''
    testResult.value = ''
    form.value = {
      routeKey: provider?.routeKey ?? '',
      displayName: provider?.displayName ?? '',
      kind: provider?.kind ?? 'pi-ai',
      api: provider?.api ?? 'openai-completions',
      baseUrl: provider?.baseUrl ?? '',
      keyMode: provider?.keyMode ?? 'shared',
      apiKey: '',
      compat: provider?.compat ? JSON.stringify(provider.compat, null, 2) : '',
      extra: provider?.extra ? JSON.stringify(provider.extra, null, 2) : '',
    }
    models.value = provider?.models.map((item) => ({ ...item })) ?? []
  },
)

function parseJsonField(text: string, label: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (cause) {
    throw new Error(`${label} 不是合法的 JSON 对象：${cause instanceof Error ? cause.message : ''}`)
  }
}

async function save(): Promise<void> {
  errorText.value = ''
  if (!form.value.routeKey.trim() || !form.value.displayName.trim()) {
    errorText.value = '路由名与显示名都要填'
    return
  }
  if (isPiAi.value && !form.value.baseUrl.trim()) {
    errorText.value = 'pi-ai 提供方需要 Base URL'
    return
  }
  const levelsProblem = isPiAi.value ? thinkingLevelsProblem(models.value) : null
  if (levelsProblem) {
    errorText.value = levelsProblem
    return
  }

  saving.value = true
  try {
    const compat = parseJsonField(form.value.compat, '兼容项')
    const extra = parseJsonField(form.value.extra, '高级 JSON')

    // hub-relay：只发类型 / 路由名 / 显示名 / 协议 / compat / extra
    // （baseUrl、models、apiKey 由 Hub 生成，不发；keyMode 在契约 schema 里是必填，
    //   这版按 12 §7「请求里给了也忽略」发一个 per-user，服务端仍以自己为准）
    const payload: z.input<typeof CreateProviderRequestSchema> = isRelayKind.value
      ? {
          routeKey: form.value.routeKey.trim(),
          displayName: form.value.displayName.trim(),
          kind: 'hub-relay',
          api: form.value.api,
          keyMode: 'per-user',
          compat,
          extra,
        }
      : {
          routeKey: form.value.routeKey.trim(),
          displayName: form.value.displayName.trim(),
          kind: form.value.kind,
          api: isPiAi.value ? form.value.api : undefined,
          baseUrl: isPiAi.value ? form.value.baseUrl.trim() : undefined,
          models: isPiAi.value ? models.value : [],
          keyMode: form.value.keyMode,
          apiKey: form.value.apiKey.trim() || undefined,
          compat,
          extra,
        }

    const saved = await withReauth(
      () =>
        props.provider ? updateProvider(props.provider.id, payload) : createProvider(payload),
      {
        title: form.value.apiKey ? '保存模型密钥' : '保存提供方',
        description: form.value.apiKey ? '密钥会加密存储，用户 agent 读取不到明文。' : '确认保存这次修改。',
        confirmText: '保存',
      },
    )

    message.success(`已保存提供方 ${saved.displayName}`)
    emit('saved')
    emit('update:show', false)
  } catch (cause) {
    if (!isReauthCanceled(cause)) errorText.value = describeError(cause).message
  } finally {
    saving.value = false
  }
}

// ── 测试连接 ──

async function test(): Promise<void> {
  const provider = props.provider
  if (!provider) {
    message.info('先保存提供方，再测试连接（需要用到已存储的密钥）')
    return
  }

  testing.value = true
  testResult.value = ''
  try {
    const result = await testProvider(provider.id)
    testResult.value = result.ok
      ? `连接正常：${result.latencyMs} ms${result.models ? ` · 发现 ${result.models.length} 个模型` : ''}`
      : `连接失败：${result.error ?? '未知原因'}`
    if (!result.ok) message.warning(testResult.value)
  } catch (cause) {
    testResult.value = describeError(cause).message
  } finally {
    testing.value = false
  }
}

// ── 从端点发现模型 ──

const showDiscover = ref(false)
const discovering = ref(false)
const discovered = ref<DiscoveredModel[]>([])
const picked = ref<string[]>([])

/** 已经在模型列表里的 id：发现结果里置灰，不参与全选和导入计数 */
const existingIds = computed(() => new Set(models.value.map((item) => item.id)))
const importableIds = computed(() =>
  discovered.value.map((item) => item.id).filter((id) => !existingIds.value.has(id)),
)
const matchedCount = computed(() => discovered.value.filter((item) => item.infoSource).length)

/** 发现结果里参数的来源标签 */
function sourceTag(model: DiscoveredModel): { text: string; tone: 'primary' | 'butter' | 'sky' | 'neutral' } {
  switch (model.infoSource) {
    case 'builtin':
      return { text: '模型库', tone: 'primary' }
    case 'custom':
      return { text: '自定义', tone: 'butter' }
    case 'upstream':
      return { text: '端点返回', tone: 'sky' }
    default:
      return { text: '未匹配', tone: 'neutral' }
  }
}

function pickAll(): void {
  picked.value = [...importableIds.value]
}

function pickNone(): void {
  picked.value = []
}

async function discover(): Promise<void> {
  if (!form.value.baseUrl.trim()) {
    message.warning('先填 Base URL')
    return
  }

  discovering.value = true
  try {
    const result = await discoverModels({
      api: form.value.api,
      baseUrl: form.value.baseUrl.trim(),
      apiKey: form.value.apiKey.trim() || undefined,
    })
    discovered.value = result.models
    pickAll()
    showDiscover.value = true
    if (result.models.length === 0) message.warning('端点没有返回任何模型')
  } catch (cause) {
    const description = describeError(cause)
    // 手工填的密钥还没落库时，提示更具体一点
    message.error(
      isHubApiError(cause) && cause.code === 'UPSTREAM_ERROR'
        ? `端点没有响应：${description.message}`
        : description.message,
    )
  } finally {
    discovering.value = false
  }
}

function importPicked(): void {
  // infoSource / matchedId 只是发现结果的说明，不进模型条目
  const additions: ModelSpec[] = discovered.value
    .filter((item) => picked.value.includes(item.id) && !existingIds.value.has(item.id))
    .map(({ infoSource: _infoSource, matchedId: _matchedId, ...spec }) => spec)
  models.value = [...models.value, ...additions]
  showDiscover.value = false
  message.success(`导入了 ${additions.length} 个模型`)
}

function addModel(): void {
  models.value = [...models.value, { id: '', name: '' }]
}

function removeModel(index: number): void {
  models.value = models.value.filter((_, itemIndex) => itemIndex !== index)
}

function patchModel(index: number, patch: Partial<ModelSpec>): void {
  models.value = models.value.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
}

// ── 模型信息库：补全 / 存入 ──

const filling = ref(false)
const savingCatalog = ref(false)

/**
 * 按模型名查库，把命中的参数补进列表里**空着的字段**（手填过的不动）。
 * 按 id 而不是下标应用：请求期间用户删行 / 改行也不会错位。
 */
async function fillFromCatalog(ids: string[], options: { quiet?: boolean } = {}): Promise<void> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))]
  if (wanted.length === 0) {
    if (!options.quiet) message.info('先填模型 id')
    return
  }
  filling.value = true
  try {
    const { matches } = await matchModels(wanted)
    const hits = new Map(matches.map((match) => [match.id, match]))
    let filled = 0
    models.value = models.value.map((model) => {
      const hit = hits.get(model.id.trim())
      if (!hit) return model
      const next = fillMissing(model, hit)
      if (next !== model) filled += 1
      return next
    })
    if (options.quiet) {
      if (filled > 0) message.info(`已按模型库补全 ${wanted[0] ?? ''}`)
    } else if (filled > 0) {
      message.success(`按模型库补全了 ${filled} 个模型的参数`)
    } else if (matches.length > 0) {
      message.info('这些模型的参数都已经填好，没有需要补的')
    } else {
      message.info('模型库里没有找到这些模型：手填参数后可以「存入模型库」')
    }
  } catch (cause) {
    if (!options.quiet) message.error(describeError(cause).message)
  } finally {
    filling.value = false
  }
}

/** 手动添加的模型：id 填完离开输入框时，如果这一行还没有任何参数，自动按库补全 */
function autoFillOnBlur(index: number): void {
  const model = models.value[index]
  if (!model || !model.id.trim() || hasModelInfo(model)) return
  void fillFromCatalog([model.id], { quiet: true })
}

async function saveToCatalog(): Promise<void> {
  const problem = thinkingLevelsProblem(models.value)
  if (problem) {
    message.warning(problem)
    return
  }
  const entries = models.value
    .filter((model) => model.id.trim() && hasModelInfo(model))
    .map((model) => toCatalogInput(model))
  if (entries.length === 0) {
    message.warning('还没有填任何参数：先填上下文 / 最大输出等，再存入模型库')
    return
  }
  savingCatalog.value = true
  try {
    await saveCatalog(entries)
    message.success(`已把 ${entries.length} 个模型的参数存入模型库，以后发现同名模型会自动填好`)
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    savingCatalog.value = false
  }
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="620"
    placement="right"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NDrawerContent :title="isEdit ? `编辑提供方 ${provider?.displayName}` : '添加模型提供方'" closable>
      <NForm label-placement="top" size="small" class="provider__form">
        <NFormItem label="类型" required>
          <NSelect
            v-model:value="form.kind"
            :options="[
              { label: 'pi-ai（渲染进 llm-pi-ai 的 providers）', value: 'pi-ai' },
              { label: 'deepseek-official（DSH 内置直连）', value: 'deepseek-official' },
              { label: 'Hub 中转站（地址与模型由 Hub 自动生成）', value: 'hub-relay' },
            ]"
          />
        </NFormItem>

        <NFormItem label="路由名（routeKey）" required>
          <NInput
            v-model:value="form.routeKey"
            placeholder="hub-relay（小写字母、数字、-）"
            :disabled="isEdit"
          />
        </NFormItem>

        <NFormItem label="显示名" required>
          <NInput v-model:value="form.displayName" placeholder="小站中转" />
        </NFormItem>

        <NFormItem v-if="needsApi" label="协议">
          <NSelect
            v-model:value="form.api"
            :options="[
              { label: 'openai-completions', value: 'openai-completions' },
              { label: 'openai-responses', value: 'openai-responses' },
              { label: 'anthropic-messages', value: 'anthropic-messages' },
            ]"
          />
        </NFormItem>
        <NFormItem v-if="isPiAi" label="Base URL" required>
          <NInput v-model:value="form.baseUrl" placeholder="https://api.example.com/v1" />
        </NFormItem>

        <template v-if="isRelayKind">
          <NAlert type="info" :bordered="false" class="provider__alert">
            Hub 中转站：用户请求走 Hub 自己的 <span class="font-mono">/v1</span>，地址、密钥和模型列表都由
            Hub 决定；你只需要选协议与路由名。要换模型 / 价格请去「模型 → 模型与价格」。
          </NAlert>

          <div class="provider__relay">
            <div class="provider__relay-block">
              <p class="provider__section">将渲染的模型（只读）</p>
              <ul v-if="(provider?.models ?? []).length > 0" class="provider__relay-models">
                <li v-for="model in provider?.models ?? []" :key="model.id" class="provider__relay-model">
                  <span class="font-mono">{{ model.id }}</span>
                  <span class="provider__relay-name">{{ model.name }}</span>
                </li>
              </ul>
              <p v-else class="provider__empty">还没有对外模型：去「中转站 → 模型与价格」建几个，再回来保存。</p>
            </div>

            <div class="provider__relay-block">
              <p class="provider__section">内部地址（只读）</p>
              <code class="provider__relay-url">{{ provider?.baseUrl ?? '保存后由 Hub 生成（内部监听器地址）' }}</code>
              <p class="provider__relay-name">密钥模式固定 per-user：容器启动时注入该用户的 system 密钥。</p>
            </div>
          </div>
        </template>

        <NFormItem v-if="!isRelayKind" label="密钥模式">
          <NSelect
            v-model:value="form.keyMode"
            :options="[
              { label: 'shared · 全体共用一把（用户 agent 能读到）', value: 'shared' },
              { label: 'per-user · 每人单独填（推荐）', value: 'per-user' },
              { label: 'none · 无需密钥的内网端点', value: 'none' },
            ]"
          />
        </NFormItem>

        <NFormItem v-if="!isRelayKind" label="密钥（API Key）">
          <NInput
            v-model:value="form.apiKey"
            type="password"
            show-password-on="click"
            :placeholder="
              provider?.apiKey.set
                ? `已设置（末 4 位 ${provider.apiKey.last4 ?? '????'}），留空表示不改`
                : '粘贴密钥，保存后只回显末 4 位'
            "
          />
        </NFormItem>
      </NForm>

      <NAlert v-if="!isRelayKind && form.keyMode === 'shared'" type="warning" :bordered="false" class="provider__alert">
        shared 模式下同一把密钥会注入所有用户的 DSH 配置，用户 agent 能读到它——生产环境建议用 per-user。
      </NAlert>

      <template v-if="isPiAi">
        <div class="provider__models-head">
          <span class="provider__section">模型列表</span>
          <div class="provider__models-actions">
            <NButton size="tiny" :loading="discovering" @click="discover">
              <template #icon><span class="i-ph-radar" aria-hidden="true" /></template>
              从端点发现
            </NButton>
            <NButton size="tiny" quaternary @click="addModel">手动添加</NButton>
          </div>
        </div>
        <div v-if="models.length > 0" class="provider__catalog-bar">
          <NButton
            size="tiny"
            quaternary
            :loading="filling"
            title="按模型名查模型库，只填还空着的参数，不覆盖你手填的"
            @click="fillFromCatalog(models.map((item) => item.id))"
          >
            <template #icon><span class="i-ph-magic-wand" aria-hidden="true" /></template>
            按模型库补全
          </NButton>
          <NButton
            size="tiny"
            quaternary
            :loading="savingCatalog"
            title="把列表里填了参数的模型存进模型库，以后同名模型自动带出"
            @click="saveToCatalog"
          >
            <template #icon><span class="i-ph-floppy-disk" aria-hidden="true" /></template>
            存入模型库
          </NButton>
        </div>

        <ul class="provider__models">
          <li v-for="(model, index) in models" :key="index" class="provider__model">
            <div class="provider__model-main">
              <NInput
                :value="model.id"
                size="small"
                placeholder="模型 id，如 deepseek-chat"
                @update:value="(value: string) => patchModel(index, { id: value })"
                @blur="autoFillOnBlur(index)"
              />
              <NInput
                :value="model.name"
                size="small"
                placeholder="显示名"
                @update:value="(value: string) => patchModel(index, { name: value })"
              />
              <NButton size="tiny" quaternary aria-label="删除这个模型" @click="removeModel(index)">
                <span class="i-ph-trash" aria-hidden="true" />
              </NButton>
            </div>
            <ModelParamsFields :model="model" @patch="(patch) => patchModel(index, patch)" />
          </li>
        </ul>
        <p v-if="models.length === 0" class="provider__empty">还没有模型：可以「从端点发现」或手动添加。</p>
      </template>

      <div class="provider__advanced">
        <NFormItem label="兼容项 compat（JSON，可留空）">
          <NInput
            v-model:value="form.compat"
            type="textarea"
            :rows="2"
            placeholder='{ "supportsVision": true }'
          />
        </NFormItem>
        <NFormItem label="高级 extra（JSON 透传，可留空）">
          <NInput v-model:value="form.extra" type="textarea" :rows="2" placeholder='{ "timeoutMs": 60000 }' />
        </NFormItem>
      </div>

      <div class="provider__test">
        <NButton size="small" :loading="testing" @click="test">
          <template #icon><span class="i-ph-plugs-connected" aria-hidden="true" /></template>
          测试连接
        </NButton>
        <MiniTag
          v-if="testResult"
          :text="testResult"
          :tone="testResult.startsWith('连接正常') ? 'success' : 'danger'"
          size="sm"
        />
      </div>

      <NAlert v-if="errorText" type="error" :bordered="false" class="provider__alert">{{ errorText }}</NAlert>

      <template #footer>
        <div class="provider__footer">
          <NButton size="small" @click="emit('update:show', false)">取消</NButton>
          <NButton size="small" type="primary" :loading="saving" @click="save">保存</NButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>

  <!-- 发现结果 -->
  <NModal v-model:show="showDiscover" preset="card" title="从端点发现的模型" :style="{ maxWidth: '640px' }">
    <div class="provider__discover-bar">
      <span class="provider__discover-hint">
        勾选要导入的模型 · 已选 {{ picked.length }} / {{ importableIds.length }}
        <template v-if="discovered.length > 0">
          · {{ matchedCount }} 个已自动带出参数，{{ discovered.length - matchedCount }} 个需要手填
        </template>
      </span>
      <NButton size="tiny" quaternary :disabled="importableIds.length === 0" @click="pickAll">全选</NButton>
      <NButton size="tiny" quaternary :disabled="picked.length === 0" @click="pickNone">全不选</NButton>
    </div>
    <NCheckboxGroup v-model:value="picked">
      <ul class="provider__discover">
        <li v-for="model in discovered" :key="model.id" class="provider__discover-item">
          <NCheckbox :value="model.id" :disabled="existingIds.has(model.id)">
            <span class="provider__discover-id">{{ model.id }}</span>
            <span v-if="model.name && model.name !== model.id" class="provider__discover-name">{{
              model.name
            }}</span>
            <span v-if="existingIds.has(model.id)" class="provider__discover-name">已在列表</span>
          </NCheckbox>
          <div class="provider__discover-info">
            <MiniTag :text="sourceTag(model).text" :tone="sourceTag(model).tone" size="sm" />
            <span class="provider__discover-name">{{
              modelInfoSummary(model) || '没有参数，导入后请手填'
            }}</span>
            <span
              v-if="model.matchedId && model.matchedId !== model.id"
              class="provider__discover-name"
              :title="`按 ${model.matchedId} 的参数补全`"
              >← {{ model.matchedId }}</span
            >
          </div>
        </li>
      </ul>
    </NCheckboxGroup>
    <template #footer>
      <div class="provider__footer">
        <NButton size="small" @click="showDiscover = false">取消</NButton>
        <NButton size="small" type="primary" :disabled="picked.length === 0" @click="importPicked">
          导入 {{ picked.length }} 个
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.provider__form {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.provider__alert {
  border-radius: var(--radius-control);
  margin-bottom: var(--space-3);
}

.provider__models-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.provider__section {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.provider__models-actions {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}

.provider__models {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.provider__model {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.provider__catalog-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.provider__model-main {
  display: grid;
  align-items: center;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 32px;
}

.provider__empty {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.provider__advanced {
  margin-top: var(--space-3);
}

.provider__test {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.provider__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.provider__discover-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.provider__discover-hint {
  margin-right: auto;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.provider__discover {
  display: flex;
  max-height: 380px;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
}

.provider__discover-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.provider__discover-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-left: 24px;
}

.provider__discover-id {
  font-family: var(--font-mono);
}

.provider__discover-name {
  margin-left: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.provider__relay {
  display: grid;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.provider__relay-block {
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.provider__relay-models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-2);
}

.provider__relay-model {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--fs-12);
}

.provider__relay-name {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.provider__relay-url {
  display: block;
  margin-top: var(--space-2);
  padding: 2px var(--space-2);
  border-radius: 8px;
  background: var(--c-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}
</style>
