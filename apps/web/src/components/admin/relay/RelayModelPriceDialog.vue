<script setup lang="ts">
import type { ModelInfo, RelayChannel, RelayModel, RelayRouteInput, ThinkingLevel } from '@dsh-hub/shared'
import { effectiveDshThinking } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { matchModels } from '@/api/admin-models'
import { updateRelayModel } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import ModelParamsFields from '@/components/admin/ModelParamsFields.vue'
import RelayPriceFields from '@/components/admin/relay/RelayPriceFields.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import type { PriceForm } from '@/components/admin/relay/price-form'
import { fillMissing } from '@/components/admin/model-info'
import {
  defaultThinkingOptions,
  THINKING_NONE,
  usableThinkingLevels,
} from '@/components/admin/thinking-levels'
import { applyRate, formatRate } from '@/utils/rate'
import { formatPrice, pointsToMicro } from '@/utils/points'

/**
 * 「定价」弹窗（12 §10 · 模型与价格）：
 * 显示名、启用、价格五项（输入 / 输出 / 缓存读 / 缓存写 / 每次请求）、**默认思考档位**（WP13，价格下面、
 * 不折叠；候选跟着「模型参数」里勾的档位实时变），下面「实际价格」小表按渠道逐行显示
 * `渠道名 ×倍率 → 输入 / 输出 / 缓存读 / 每次`，随输入实时变化。
 *
 * 「更多设置」折叠里有模型参数（模型信息库补全）、可见性、compat JSON 与路由子表（高级用法）。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    model: RelayModel | null
    channels: RelayChannel[]
    /** 18 §6：对话模式没有「下发到 DSH / 默认思考档位」，隐藏这个字段 */
    showThinking?: boolean
    /** 18 §6：整体倍率（千分比），「实际价格」表里乘上它 */
    modeRatePermille?: number
  }>(),
  { showThinking: true, modeRatePermille: undefined },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

interface RouteRow {
  channelId: number | null
  upstreamModel: string
  priority: number | null
  weight: number | null
  enabled: boolean
}

const EMPTY_PRICE: PriceForm = { input: '0', output: '0', cacheRead: '', cacheWrite: '', perRequest: '0' }

const form = ref({
  displayName: '',
  enabled: true,
  visibility: 'all' as RelayModel['visibility'],
  compatText: '',
})
const price = ref<PriceForm>({ ...EMPTY_PRICE })
const info = ref<ModelInfo>({})
const routes = ref<RouteRow[]>([])
const saving = ref(false)
const filling = ref(false)
const errorText = ref('')

// ── 默认思考档位（WP13，12 §7.0 §10） ──
/** 表单里选着的档位；null = 不指定 */
const defaultThinking = ref<ThinkingLevel | null>(null)
/** 模型库里原来的值：只有真的变了才随 PATCH 发（省略 = 不改） */
const initialThinking = ref<ThinkingLevel | null>(null)
/** 一行提示（取消勾选了正选着的档位 / 原来的值已经不生效） */
const thinkingHint = ref('')
/** 服务端 `fields.defaultThinking` 的报错，显示在该字段下 */
const thinkingError = ref('')
/** 「更多设置」折叠的展开项：一个档位都没勾时旁注上的按钮要点开它 */
const moreNames = ref<string[]>([])

/** 当前在「模型参数」里勾选的、能当默认档位的档位（实时跟随） */
const thinkingLevels = computed(() => usableThinkingLevels(info.value.reasoningEfforts))
const thinkingSelectValue = computed(() => defaultThinking.value ?? THINKING_NONE)
const thinkingOptions = computed(() => defaultThinkingOptions(thinkingLevels.value))

// 取消勾选了正选着的档位（或改了 info 把它去掉）→ 回到「不指定」并提示一行（12 §10）
watch(thinkingLevels, (levels) => {
  if (defaultThinking.value === null || levels.includes(defaultThinking.value)) return
  thinkingHint.value = `「${defaultThinking.value}」已经不在模型声明的档位里，默认档位已改回「不指定」`
  defaultThinking.value = null
})

function onThinkingChange(value: string): void {
  thinkingError.value = ''
  thinkingHint.value = ''
  defaultThinking.value = value === THINKING_NONE ? null : (value as ThinkingLevel)
}

const channelOptions = computed(() =>
  props.channels.map((channel) => ({
    label: `${channel.name}${channel.enabled ? '' : '（已停用）'}`,
    value: channel.id,
  })),
)

function microToText(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return ''
  const points = micro / 1_000_000
  return points === 0 ? '0' : String(Number(points.toFixed(6)))
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const model = props.model
    errorText.value = ''
    form.value = {
      displayName: model?.displayName ?? '',
      enabled: model?.enabled ?? true,
      visibility: model?.visibility ?? 'all',
      compatText: model?.compat ? JSON.stringify(model.compat, null, 2) : '',
    }
    price.value = model
      ? {
          input: microToText(model.price.inputMicro),
          output: microToText(model.price.outputMicro),
          cacheRead: microToText(model.price.cacheReadMicro),
          cacheWrite: microToText(model.price.cacheWriteMicro),
          perRequest: microToText(model.price.perRequestMicro),
        }
      : { ...EMPTY_PRICE }
    info.value = model ? { ...model.info } : {}
    // 库里存着、但按 effectiveDshThinking 不生效的值：界面按「不指定」显示，保存后会清掉（12 §7.0）
    const storedThinking = model?.defaultThinking ?? null
    initialThinking.value = storedThinking
    defaultThinking.value = model ? effectiveDshThinking(model.info, storedThinking) : null
    thinkingError.value = ''
    thinkingHint.value =
      storedThinking !== null && defaultThinking.value === null
        ? `原来设的「${storedThinking}」现在不在它声明的档位里（没生效），保存后会清成「不指定」`
        : ''
    moreNames.value = []
    routes.value = (model?.routes ?? []).map((route) => ({
      channelId: route.channelId,
      upstreamModel: route.upstreamModel,
      priority: route.priority,
      weight: route.weight,
      enabled: route.enabled,
    }))
  },
)

/** 弹窗里正在填的价格（微积分）；非法输入按 0 预览，不挡输入 */
function liveMicro(text: string, fallback = 0): number {
  const value = pointsToMicro(text.trim())
  return value === null ? fallback : value
}

/** 「实际价格」小表：按渠道去重（同一渠道多条路由倍率相同） */
const actualRows = computed(() => {
  const model = props.model
  if (!model) return []
  const seen = new Set<number>()
  const rows: { channelId: number; channelLabel: string; ratePermille: number }[] = []
  for (const route of model.routes) {
    if (seen.has(route.channelId)) continue
    seen.add(route.channelId)
    rows.push({
      channelId: route.channelId,
      // 16 §5：对管理员展示用户实际看到的「标识 ×倍率」，没有标识时退回渠道名
      channelLabel: route.channelSlug ?? route.channelName,
      ratePermille: route.channelRatePermille,
    })
  }
  return rows.map((row) => {
    const input = liveMicro(price.value.input)
    const output = liveMicro(price.value.output)
    const cacheRead = price.value.cacheRead.trim() ? liveMicro(price.value.cacheRead) : input
    const perRequest = price.value.perRequest.trim() ? liveMicro(price.value.perRequest) : 0
    // 18 §6：对话模式的实际价格再乘模式整体倍率（两次取整与表格里的口径一致）
    const modeRate = props.modeRatePermille ?? 1000
    const effective = (micro: number): number => applyRate(applyRate(micro, row.ratePermille), modeRate)
    return {
      ...row,
      input: formatPrice(effective(input)),
      output: formatPrice(effective(output)),
      cacheRead: formatPrice(effective(cacheRead)),
      perRequest: formatPrice(effective(perRequest)),
    }
  })
})

function patchInfo(patch: Partial<ModelInfo>): void {
  info.value = { ...info.value, ...patch }
}

/** 按模型名查模型信息库，只补还空着的参数 */
async function fillFromCatalog(): Promise<void> {
  const id = props.model?.name ?? ''
  if (!id) return
  filling.value = true
  try {
    const { matches } = await matchModels([id])
    const hit = matches[0]
    if (!hit) {
      message.info('模型库里没有这个模型：手填参数后可以到「模型信息库」里存一条')
      return
    }
    const { id: _id, source: _source, matchedId: _matchedId, ...catalogInfo } = hit
    const merged = fillMissing({ id, name: form.value.displayName || id, ...info.value }, catalogInfo)
    info.value = {
      name: merged.name,
      contextWindow: merged.contextWindow,
      maxTokens: merged.maxTokens,
      input: merged.input,
      reasoningEfforts: merged.reasoningEfforts,
    }
    message.success('已按模型库补全还空着的参数')
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    filling.value = false
  }
}

function addRoute(): void {
  routes.value = [
    ...routes.value,
    {
      channelId: props.channels[0]?.id ?? null,
      upstreamModel: '',
      priority: null,
      weight: null,
      enabled: true,
    },
  ]
}

function patchRoute(index: number, patch: Partial<RouteRow>): void {
  routes.value = routes.value.map((route, itemIndex) =>
    itemIndex === index ? { ...route, ...patch } : route,
  )
}

function removeRoute(index: number): void {
  routes.value = routes.value.filter((_, itemIndex) => itemIndex !== index)
}

function parsePrice(): {
  inputMicro: number
  outputMicro: number
  cacheReadMicro: number | null
  cacheWriteMicro: number | null
  perRequestMicro: number
} | null {
  const input = pointsToMicro(price.value.input)
  const output = pointsToMicro(price.value.output)
  const perRequest = price.value.perRequest.trim() ? pointsToMicro(price.value.perRequest) : 0
  const cacheRead = price.value.cacheRead.trim() ? pointsToMicro(price.value.cacheRead) : null
  const cacheWrite = price.value.cacheWrite.trim() ? pointsToMicro(price.value.cacheWrite) : null

  if (input === null || output === null || perRequest === null) return null
  if (cacheRead === null && price.value.cacheRead.trim()) return null
  if (cacheWrite === null && price.value.cacheWrite.trim()) return null
  return {
    inputMicro: input,
    outputMicro: output,
    cacheReadMicro: cacheRead,
    cacheWriteMicro: cacheWrite,
    perRequestMicro: perRequest,
  }
}

async function save(): Promise<void> {
  const model = props.model
  if (!model) return
  errorText.value = ''
  thinkingError.value = ''
  const parsed = parsePrice()
  if (!parsed) {
    errorText.value = '价格填得不对：填数字，最多 6 位小数'
    return
  }

  let compat: Record<string, unknown> | null = null
  if (form.value.compatText.trim()) {
    try {
      const parsedCompat: unknown = JSON.parse(form.value.compatText)
      if (!parsedCompat || typeof parsedCompat !== 'object' || Array.isArray(parsedCompat)) {
        throw new Error('必须是 JSON 对象')
      }
      compat = parsedCompat as Record<string, unknown>
    } catch (cause) {
      errorText.value = `compat 不是合法的 JSON 对象：${cause instanceof Error ? cause.message : ''}`
      return
    }
  }

  const routeInputs: RelayRouteInput[] = routes.value
    .filter((route) => route.channelId !== null)
    .map((route) => ({
      channelId: route.channelId as number,
      upstreamModel: route.upstreamModel.trim() || model.name,
      priority: route.priority,
      weight: route.weight,
      enabled: route.enabled,
    }))

  saving.value = true
  try {
    await updateRelayModel(model.id, {
      displayName: form.value.displayName.trim() || model.name,
      enabled: form.value.enabled,
      visibility: form.value.visibility,
      price: parsed,
      info: info.value,
      compat,
      routes: routeInputs,
      // 没变就不发（省略 = 不改）；变过或者是「原来那个已经不生效」的清理由，就带上（12 §7.0）
      ...(!props.showThinking || defaultThinking.value === initialThinking.value
        ? {}
        : { defaultThinking: defaultThinking.value }),
    })
    message.success(`已保存模型 ${model.name}`)
    emit('saved')
    emit('update:show', false)
  } catch (cause) {
    const description = describeError(cause)
    const fieldError = description.fieldErrors['defaultThinking']
    if (fieldError) thinkingError.value = fieldError
    errorText.value = description.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="`定价 · ${model?.name ?? ''}`"
    :style="{ width: 'calc(100vw - 24px)', maxWidth: '900px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NForm label-placement="top" size="small">
      <div class="price-dialog__head">
        <NFormItem label="显示名">
          <NInput
            v-model:value="form.displayName"
            placeholder="DeepSeek V4.1 Flash"
            data-testid="price-display-name"
          />
        </NFormItem>
        <NFormItem label="启用">
          <NSwitch v-model:value="form.enabled" size="small" />
        </NFormItem>
      </div>

      <NFormItem label="价格（积分 / 百万 token，1 积分 = 1 元）">
        <RelayPriceFields :price="price" @update:price="(next: PriceForm) => (price = next)" />
      </NFormItem>

      <!-- 默认思考档位（WP13，12 §10）：价格下面、不折叠；候选跟着「模型参数」的勾选实时变 -->
      <NFormItem v-if="showThinking">
        <template #label>
          默认思考档位
          <InfoTip text="用户在 DSH 里选这个模型时默认用它，用户仍可自己改。" />
        </template>
        <div class="price-dialog__thinking">
          <NSelect
            :value="thinkingSelectValue"
            :options="thinkingOptions"
            :disabled="thinkingLevels.length === 0"
            :status="thinkingError ? 'error' : undefined"
            size="small"
            data-testid="price-default-thinking"
            @update:value="onThinkingChange"
          />
          <p v-if="thinkingLevels.length === 0" class="price-dialog__hint" data-testid="price-thinking-empty">
            这个模型还没声明思考档位，到「更多设置 → 模型参数」里勾选
            <NButton size="tiny" quaternary data-testid="price-thinking-more" @click="moreNames = ['more']">
              更多设置
            </NButton>
          </p>
          <p v-if="thinkingHint" class="price-dialog__thinking-hint" data-testid="price-thinking-hint">
            {{ thinkingHint }}
          </p>
          <p v-if="thinkingError" class="price-dialog__thinking-error" data-testid="price-thinking-error">
            {{ thinkingError }}
          </p>
        </div>
      </NFormItem>

      <section class="price-dialog__actual" data-testid="price-actual">
        <p class="price-dialog__section">
          实际价格（价格 × 渠道倍率{{
            modeRatePermille === undefined ? '' : ' × 整体倍率'
          }}，用户实际扣的积分）
        </p>
        <div v-if="actualRows.length > 0" class="price-dialog__table-wrap">
          <table class="price-dialog__table">
            <thead>
              <tr>
                <th>渠道</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>每次</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in actualRows" :key="row.channelId">
                <td>
                  {{ row.channelLabel }}
                  <span
                    class="price-dialog__rate"
                    :class="{ 'price-dialog__rate--up': row.ratePermille !== 1000 }"
                  >
                    {{ formatRate(row.ratePermille) }}
                  </span>
                </td>
                <td class="price-dialog__num">{{ row.input }}</td>
                <td class="price-dialog__num">{{ row.output }}</td>
                <td class="price-dialog__num">{{ row.cacheRead }}</td>
                <td class="price-dialog__num">{{ row.perRequest }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="price-dialog__hint">
          这个模型还没有渠道（无渠道）：先到「渠道」里用「选择模型」把它挂上去。
        </p>
      </section>

      <NCollapse v-model:expanded-names="moreNames">
        <NCollapseItem title="更多设置（模型参数、可见性、compat、路由）" name="more">
          <div class="price-dialog__params-head">
            <span class="price-dialog__section">模型参数（渲染进用户的 DSH）</span>
            <NButton size="tiny" quaternary :loading="filling" @click="fillFromCatalog">
              <template #icon><span class="i-ph-magic-wand" aria-hidden="true" /></template>
              按模型库补全
            </NButton>
          </div>
          <ModelParamsFields :model="info" @patch="patchInfo" />

          <div class="price-dialog__head">
            <NFormItem label="可见性">
              <NSelect
                v-model:value="form.visibility"
                :options="[
                  { label: '所有用户可见', value: 'all' },
                  { label: '仅管理员（不渲染给用户）', value: 'admin' },
                ]"
              />
            </NFormItem>
          </div>

          <NFormItem label="compat（JSON，可留空）">
            <NInput
              v-model:value="form.compatText"
              type="textarea"
              :rows="2"
              placeholder='{ "supportsReasoning": true }'
            />
          </NFormItem>

          <div class="price-dialog__params-head">
            <span class="price-dialog__section">路由（可以挂到多个渠道）</span>
            <NButton size="tiny" quaternary @click="addRoute">加一条路由</NButton>
          </div>

          <ul class="price-dialog__routes">
            <li v-for="(route, index) in routes" :key="index" class="price-dialog__route">
              <NSelect
                :value="route.channelId"
                size="small"
                :options="channelOptions"
                placeholder="选渠道"
                @update:value="(value: number) => patchRoute(index, { channelId: value })"
              />
              <NInput
                :value="route.upstreamModel"
                size="small"
                :placeholder="`上游模型名（默认 ${model?.name ?? ''}）`"
                @update:value="(value: string) => patchRoute(index, { upstreamModel: value })"
              />
              <NInputNumber
                :value="route.priority"
                size="small"
                :show-button="false"
                placeholder="优先级（留空 = 用渠道值）"
                @update:value="(value: number | null) => patchRoute(index, { priority: value })"
              />
              <NInputNumber
                :value="route.weight"
                size="small"
                :show-button="false"
                :min="1"
                placeholder="权重（留空 = 用渠道值）"
                @update:value="(value: number | null) => patchRoute(index, { weight: value })"
              />
              <NCheckbox
                :checked="route.enabled"
                @update:checked="(value: boolean) => patchRoute(index, { enabled: value })"
              >
                启用
              </NCheckbox>
              <NButton size="tiny" quaternary aria-label="删除这条路由" @click="removeRoute(index)">
                <span class="i-ph-trash" aria-hidden="true" />
              </NButton>
            </li>
            <li v-if="routes.length === 0" class="price-dialog__hint">
              还没有路由：去「渠道」里用「选择模型」把它挂到某个渠道上。
            </li>
          </ul>
        </NCollapseItem>
      </NCollapse>
    </NForm>

    <NAlert v-if="errorText" type="error" :bordered="false" class="price-dialog__alert">{{
      errorText
    }}</NAlert>

    <template #footer>
      <div class="price-dialog__footer">
        <NButton size="small" @click="emit('update:show', false)">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" data-testid="price-save" @click="save"
          >保存</NButton
        >
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.price-dialog__head {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
}

.price-dialog__section {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.price-dialog__actual {
  margin-bottom: var(--space-3);
}

.price-dialog__table-wrap {
  overflow-x: auto;
}

.price-dialog__table {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: var(--fs-12);
}

.price-dialog__table th {
  /* 07 §2.8：列标题 / 渠道胶囊 / 数字单行；390 下整表在卡片里横向滚动 */
  white-space: nowrap;
  color: var(--c-text-3);
  font-weight: var(--fw-normal);
  text-align: left;
}

.price-dialog__table td {
  white-space: nowrap;
}

.price-dialog__table th,
.price-dialog__table td {
  padding: 4px var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
}

.price-dialog__num {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.price-dialog__rate {
  margin-left: 4px;
  color: var(--c-text-3);
}

.price-dialog__rate--up {
  color: var(--c-butter-ink);
  font-weight: var(--fw-semibold);
}

.price-dialog__thinking {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.price-dialog__thinking-hint {
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.price-dialog__thinking-error {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.price-dialog__params-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.price-dialog__routes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.price-dialog__route {
  display: grid;
  align-items: center;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.3fr) 96px 80px auto 32px;
}

.price-dialog__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.price-dialog__alert {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
}

.price-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
