<script setup lang="ts">
import type { ComputeSettingsResponse, UpdateComputeSettingsRequest } from '@dsh-hub/shared'
import { ComputeSettingsSchema } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { listUsers } from '@/api/admin-users'
import { getAdminComputeSettings, updateAdminComputeSettings } from '@/api/compute'
import { describeError } from '@/api/errors'
import {
  buildPlanPayload,
  draftBlockPriceMicro,
  draftFromPlan,
  draftPriceMicro,
  emptyPlanDraft,
  validatePlanDrafts,
  type PlanDraft,
} from '@/components/admin/compute/plan-draft'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatPoints } from '@/utils/points'

/**
 * 系统设置 · 算力租赁（13 §7 管理端）：总开关、管理员计费、宽限、内存准入、联系文案、规格表。
 *
 * 规格价格按「积分/小时」录入，旁边实时显示每 10 分钟的价格（使用 shared 的块价格公式）；
 * 改价只影响之后开始的租约（开租时快照），所以有价格改动时才出现那条提醒。
 * 规格 ID 新建时可编辑、保存后只读；定制规格用远程搜索多选用户。
 *
 * WP19b（15 §3.1）：「新用户默认规格」下拉 = 启用中且对所有人可见的规格 + 「第一个可选规格」（null）；
 * 当前值被停用 / 删除时在下拉框旁给警告，但不禁用表单（管理员可以继续改别的字段）。
 */
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => getAdminComputeSettings())

interface SettingsDraft {
  billingEnabled: boolean
  billAdmins: boolean
  graceMinutes: number
  capacityMemoryMb: number
  contactText: string
  /** 默认规格（15 §3.1；选择框由 WP19b 加，这里先原样带着，保证保存时契约校验通过） */
  defaultPlanId: string | null
}

const form = ref<SettingsDraft | null>(null)
const plans = ref<PlanDraft[]>([])
const saving = ref(false)
const saveError = ref('')

const host = computed(() => data.value?.host ?? null)
const memTotalMb = computed(() => host.value?.memTotalMb ?? 0)
const committedMemoryMb = computed(() => host.value?.committedMemoryMb ?? 0)

/** 把接口数据装进表单草稿（保存成功后也走这里，避免未保存的改动被覆盖） */
function applyData(response: ComputeSettingsResponse): void {
  const settings = response.settings
  form.value = {
    billingEnabled: settings.billingEnabled,
    billAdmins: settings.billAdmins,
    graceMinutes: settings.graceMinutes,
    capacityMemoryMb: settings.capacityMemoryMb,
    contactText: settings.contactText,
    defaultPlanId: settings.defaultPlanId,
  }
  plans.value = [...settings.plans].sort((a, b) => a.sort - b.sort).map(draftFromPlan)
}

watch(
  data,
  (value) => {
    if (value) applyData(value)
  },
  { immediate: true },
)

/**
 * 原始值（接口读到的设置，`sort` 也规范成 10/20/30），用来判断有没有改动。
 * 只比字段不比对象：接口返回的计划顺序不一定按 `sort` 排。
 */
const originalBody = computed(() => {
  if (!data.value) return null
  const settings = data.value.settings
  return JSON.stringify({
    billingEnabled: settings.billingEnabled,
    billAdmins: settings.billAdmins,
    graceMinutes: settings.graceMinutes,
    capacityMemoryMb: settings.capacityMemoryMb,
    contactText: settings.contactText,
    defaultPlanId: settings.defaultPlanId,
    plans: [...settings.plans]
      .sort((a, b) => a.sort - b.sort)
      .map((plan, index) => ({ ...plan, sort: (index + 1) * 10 })),
  })
})

function buildBody(): UpdateComputeSettingsRequest {
  const current = form.value
  return {
    billingEnabled: current?.billingEnabled ?? false,
    billAdmins: current?.billAdmins ?? false,
    graceMinutes: current?.graceMinutes ?? 10,
    capacityMemoryMb: current?.capacityMemoryMb ?? 0,
    contactText: current?.contactText ?? '',
    defaultPlanId: current?.defaultPlanId ?? null,
    plans: buildPlanPayload(plans.value),
  }
}

const currentBody = computed(() => JSON.stringify(buildBody()))
const dirty = computed(() => originalBody.value !== null && currentBody.value !== originalBody.value)

/** 「第一个可选规格」在下拉里的哨兵值（提交时换成 null，契约要求 null） */
const FIRST_AVAILABLE = '__first__'

/** 新用户默认规格的候选：启用中、对所有人可见（userIds === null）的规格 */
const defaultPlanOptions = computed(() => [
  { label: '第一个可选规格', value: FIRST_AVAILABLE },
  ...plans.value
    .filter((draft) => draft.enabled && !draft.custom)
    .map((draft) => ({ label: draft.name || draft.id, value: draft.id })),
])

const defaultPlanValue = computed<string>({
  get: () => form.value?.defaultPlanId ?? FIRST_AVAILABLE,
  set: (value: string) => {
    if (form.value) form.value.defaultPlanId = value === FIRST_AVAILABLE ? null : value
  },
})

/** 当前默认规格已不可用（被停用 / 删除 / 变成定制）→ 保存后后端会退回第一个可选规格，提前警告 */
const defaultPlanUnavailable = computed(() => {
  const id = form.value?.defaultPlanId
  if (!id) return false
  return !defaultPlanOptions.value.some((option) => option.value === id)
})

/** 改价提示：只在已有规格的价格真的变了时出现（13 §3：租约开租时快照价格） */
const priceChanged = computed(() => {
  if (!data.value) return false
  const original = new Map<string, number>(
    data.value.settings.plans.map((plan) => [plan.id, plan.pricePerHourMicro]),
  )
  return plans.value.some((draft) => {
    const price = draftPriceMicro(draft)
    return original.has(draft.id) && original.get(draft.id) !== price
  })
})

function addPlan(): void {
  plans.value = [...plans.value, emptyPlanDraft()]
}

function removePlan(index: number): void {
  plans.value = plans.value.filter((_, current) => current !== index)
}

/** 上移 / 下移（`sort` 在提交时按数组顺序重排，不需要手动改数字） */
function movePlan(index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= plans.value.length) return
  const next = [...plans.value]
  const [item] = next.splice(index, 1)
  if (!item) return
  next.splice(target, 0, item)
  plans.value = next
}

function fillCapacity(): void {
  if (!form.value) return
  form.value.capacityMemoryMb = Math.max(0, memTotalMb.value - 3 * 1024)
}

/** 保存前整体再过一遍契约 schema（字段范围、联系文案长度这类由它兜底） */
function validateSettings(): string | null {
  const parsed = ComputeSettingsSchema.safeParse(buildBody())
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  if (!issue) return '设置有几项不合要求'
  return issue.path.length > 0 ? `${issue.path.join('.')}：${issue.message}` : issue.message
}

async function save(): Promise<void> {
  saveError.value = ''
  const problem = validatePlanDrafts(plans.value) ?? validateSettings()
  if (problem) {
    saveError.value = problem
    return
  }

  saving.value = true
  try {
    const result = await updateAdminComputeSettings(buildBody())
    data.value = result
    applyData(result)
    message.success('设置已保存')
  } catch (cause) {
    saveError.value = describeError(cause).message
  } finally {
    saving.value = false
  }
}

// ── 定制规格的用户选择（远程搜索） ──────────────────────────────────────────

const userMap = ref<Record<number, string>>({})
const usersLoading = ref(false)
let usersSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

const userOptions = computed(() =>
  Object.entries(userMap.value).map(([value, label]) => ({ value: Number(value), label })),
)

function labelOfUser(user: { username: string; displayName: string }): string {
  return user.displayName ? `${user.username}（${user.displayName}）` : user.username
}

async function loadUsers(query: string): Promise<void> {
  usersLoading.value = true
  const seq = ++usersSeq
  try {
    const result = await listUsers({ q: query || undefined, page: 1, pageSize: 50 })
    if (seq !== usersSeq) return
    const next = { ...userMap.value }
    for (const user of result.items) next[user.id] = labelOfUser(user)
    userMap.value = next
  } catch {
    // 用户列表是选填辅助：读不到时已选的 ID 仍能保存
  } finally {
    if (seq === usersSeq) usersLoading.value = false
  }
}

function searchUsers(query: string): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadUsers(query), 250)
}

function ensureUsers(): void {
  if (Object.keys(userMap.value).length === 0) void loadUsers('')
}

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// 打开页面就备好用户名单：已有定制规格要显示名字，而不是裸 ID
ensureUsers()

/** 每 10 分钟价格（非法价格显示 —） */
function blockPriceText(draft: PlanDraft): string {
  const price = draftBlockPriceMicro(draft)
  return price === null ? '—' : formatPoints(price)
}
</script>

<template>
  <SoftCard title="算力租赁">
    <template #extra>
      <div class="compute-settings__actions">
        <NButton size="tiny" quaternary :loading="loading" @click="reload">刷新</NButton>
        <NButton
          size="tiny"
          type="primary"
          :disabled="!dirty"
          :loading="saving"
          data-testid="compute-settings-save"
          @click="save"
        >
          保存
        </NButton>
      </div>
    </template>

    <AdminErrorNotice :error="error" title="算力租赁设置加载失败" @retry="reload" />

    <p v-if="!form && loading" class="compute-settings__hint">正在读取设置…</p>

    <template v-else-if="form">
      <NAlert
        v-if="saveError"
        type="error"
        :bordered="false"
        class="compute-settings__alert"
        data-testid="compute-settings-error"
      >
        {{ saveError }}
      </NAlert>

      <NAlert
        v-if="priceChanged"
        type="warning"
        :bordered="false"
        class="compute-settings__alert"
        data-testid="compute-price-hint"
      >
        改价只影响之后开始的租约
      </NAlert>

      <NForm label-placement="left" label-width="200" size="small" class="compute-settings__form">
        <NFormItem label="启用算力计费">
          <NSwitch v-model:value="form.billingEnabled" size="small" data-testid="compute-billing-enabled" />
        </NFormItem>

        <NFormItem>
          <template #label>
            管理员自己的实例也计费
            <InfoTip text="关掉时管理员账号的租约标「免费」，不扣积分。" />
          </template>
          <NSwitch v-model:value="form.billAdmins" size="small" data-testid="compute-bill-admins" />
        </NFormItem>

        <NFormItem label="余额不足宽限（分钟）">
          <NInputNumber
            v-model:value="form.graceMinutes"
            size="small"
            :min="0"
            :max="60"
            :show-button="false"
            class="compute-settings__number"
          />
        </NFormItem>

        <NFormItem>
          <template #label>
            内存准入上限（MB）
            <InfoTip text="运行中实例的内存之和 + 新实例不超过它；0 = 不检查（仍受同时运行实例上限约束）。" />
          </template>
          <div class="compute-settings__capacity">
            <NInputNumber
              v-model:value="form.capacityMemoryMb"
              size="small"
              :min="0"
              :max="4194304"
              :step="512"
              :show-button="false"
              class="compute-settings__number"
              data-testid="compute-capacity"
            />
            <NButton size="tiny" secondary data-testid="compute-capacity-fill" @click="fillCapacity">
              设为总内存 − 3 GB
            </NButton>
            <span class="compute-settings__hint" data-testid="compute-host-memory">
              宿主总内存 {{ memTotalMb }} MB，已占用 {{ committedMemoryMb }} MB
            </span>
          </div>
        </NFormItem>

        <NFormItem label="新用户默认规格">
          <div class="compute-settings__default-plan">
            <NSelect
              v-model:value="defaultPlanValue"
              size="small"
              :options="defaultPlanOptions"
              class="compute-settings__default-plan-select"
              data-testid="compute-default-plan"
            />
            <span
              v-if="defaultPlanUnavailable"
              class="compute-settings__default-plan-warning"
              role="alert"
              data-testid="compute-default-plan-warning"
            >
              该规格已不可用，将退回第一个可选规格
            </span>
          </div>
        </NFormItem>

        <NFormItem label="联系文案" class="compute-settings__wide">
          <NInput v-model:value="form.contactText" maxlength="200" show-count />
        </NFormItem>
      </NForm>

      <div class="compute-plans">
        <div class="compute-plans__head">
          <h4 class="compute-plans__title">规格</h4>
          <NButton size="tiny" secondary data-testid="compute-plan-add" @click="addPlan">添加规格</NButton>
        </div>

        <div class="compute-plans__scroll">
          <div class="compute-plans__row compute-plans__row--head" aria-hidden="true">
            <span>ID</span>
            <span>名称</span>
            <span>核数</span>
            <span>内存（MB）</span>
            <span>价格（积分/小时）</span>
            <span>每 10 分钟（积分）</span>
            <span>定制</span>
            <span>启用</span>
            <span>排序</span>
            <span>操作</span>
          </div>

          <template v-for="(draft, index) in plans" :key="draft.key">
            <div class="compute-plans__row" :data-testid="`compute-plan-row-${index}`">
              <div>
                <NInput
                  v-if="draft.isNew"
                  v-model:value="draft.id"
                  size="small"
                  maxlength="32"
                  :data-testid="`compute-plan-id-${index}`"
                />
                <span v-else class="compute-plans__id">{{ draft.id }}</span>
              </div>
              <NInput
                v-model:value="draft.name"
                size="small"
                maxlength="32"
                placeholder="名称"
                :data-testid="`compute-plan-name-${index}`"
              />
              <NInputNumber
                v-model:value="draft.cpus"
                size="small"
                :min="0.5"
                :max="64"
                :step="0.5"
                :show-button="false"
              />
              <NInputNumber
                v-model:value="draft.memoryMb"
                size="small"
                :min="512"
                :max="262144"
                :step="512"
                :show-button="false"
              />
              <NInput
                v-model:value="draft.priceText"
                size="small"
                :data-testid="`compute-plan-price-${index}`"
              />
              <span class="compute-plans__block" :data-testid="`compute-plan-block-${index}`">
                {{ blockPriceText(draft) }}
              </span>
              <NSwitch
                v-model:value="draft.custom"
                size="small"
                :data-testid="`compute-plan-custom-${index}`"
              />
              <NSwitch
                v-model:value="draft.enabled"
                size="small"
                :data-testid="`compute-plan-enabled-${index}`"
              />
              <div class="compute-plans__sort">
                <NButton
                  size="tiny"
                  quaternary
                  :disabled="index === 0"
                  aria-label="上移"
                  :data-testid="`compute-plan-up-${index}`"
                  @click="movePlan(index, -1)"
                >
                  <template #icon><span class="i-ph-arrow-up" aria-hidden="true" /></template>
                </NButton>
                <NButton
                  size="tiny"
                  quaternary
                  :disabled="index === plans.length - 1"
                  aria-label="下移"
                  :data-testid="`compute-plan-down-${index}`"
                  @click="movePlan(index, 1)"
                >
                  <template #icon><span class="i-ph-arrow-down" aria-hidden="true" /></template>
                </NButton>
              </div>
              <NButton
                size="tiny"
                quaternary
                type="error"
                :data-testid="`compute-plan-remove-${index}`"
                @click="removePlan(index)"
              >
                删除
              </NButton>
            </div>

            <div v-if="draft.custom" class="compute-plans__custom">
              <NSelect
                v-model:value="draft.userIds"
                multiple
                filterable
                remote
                :options="userOptions"
                :loading="usersLoading"
                :max-tag-count="3"
                placeholder="选择可用用户"
                :data-testid="`compute-plan-users-${index}`"
                @search="searchUsers"
                @focus="ensureUsers"
              />
            </div>
          </template>
        </div>
      </div>
    </template>
  </SoftCard>
</template>

<style scoped>
.compute-settings__actions {
  display: flex;
  gap: var(--space-2);
}

.compute-settings__form {
  max-width: 760px;
}

.compute-settings__wide {
  grid-column: 1 / -1;
}

.compute-settings__number {
  width: 150px;
}

.compute-settings__default-plan {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.compute-settings__default-plan-select {
  width: 240px;
}

.compute-settings__default-plan-warning {
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.compute-settings__capacity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.compute-settings__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.compute-settings__alert {
  margin-bottom: var(--space-3);
  border-radius: var(--radius-control);
}

.compute-plans {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}

.compute-plans__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.compute-plans__title {
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.compute-plans__head > :last-child {
  margin-left: auto;
}

.compute-plans__scroll {
  overflow-x: auto;
}

.compute-plans__row {
  display: grid;
  min-width: 1110px;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-bottom: var(--border-width) solid var(--c-border);
  grid-template-columns: 110px minmax(140px, 1fr) 82px 100px 120px 140px 60px 60px 86px 64px;
}

.compute-plans__row--head {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  border-bottom: var(--border-width) solid var(--c-border);
}

/* 07 §2.8：列标题不从中间断行 */
.compute-plans__row--head > span {
  white-space: nowrap;
}

.compute-plans__custom {
  min-width: 1110px;
  padding: var(--space-2) 0 var(--space-2) 110px;
}

.compute-plans__id {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.compute-plans__block {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.compute-plans__sort {
  display: flex;
  gap: 2px;
}
</style>
