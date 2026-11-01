<script setup lang="ts">
import type { AuditItem, RelayWalletRow, UserAdminView, UserStatus } from '@dsh-hub/shared'
import { NButton, NInput, NSelect, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { getRelayWallet } from '@/api/admin-relay'
import { listRoleLabels, updateUser } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import RoleChoiceField from '@/components/admin/RoleChoiceField.vue'
import WalletAdjustDialog from '@/components/admin/relay/WalletAdjustDialog.vue'
import { parseRoleChoice, roleText, roleTone } from '@/components/admin/role'
import type { AdminTone } from '@/components/admin/tone'
import AvatarImg from '@/components/base/AvatarImg.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 用户详情 · 概况（07 §7.3）：资料（可编辑）、注册信息、邀请码来源。
 * 邀请码来源从审计的 `auth.register` 记录里取（04 §7）。
 */
const props = defineProps<{
  user: UserAdminView
  sessions: number
  recentAudit: AuditItem[]
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const saving = ref(false)

/** 角色下拉的值是显示文字（管理员 / 普通用户 / 自定义标签），保存时再拆回 role + roleLabel */
const formOf = (user: UserAdminView) => ({
  displayName: user.displayName,
  roleChoice: roleText(user),
  status: user.status as UserStatus,
})
const form = ref(formOf(props.user))

watch(
  () => props.user,
  (user) => {
    form.value = formOf(user)
  },
)

const { data: roleLabelData } = useAsyncData(() => listRoleLabels())

// ── 积分小卡（12 §10）：余额、本月消耗、「加/扣积分」 ──

const wallet = ref<RelayWalletRow | null>(null)
const walletError = ref('')
const showAdjust = ref(false)

async function loadWallet(): Promise<void> {
  try {
    wallet.value = await getRelayWallet(props.user.id)
    walletError.value = ''
  } catch (cause) {
    wallet.value = null
    walletError.value = describeError(cause).message
  }
}

watch(() => props.user.id, () => void loadWallet(), { immediate: true })

const walletHref = computed(() => `/admin/models?tab=wallets&userId=${props.user.id}`)
const balanceTone = computed(() => ((wallet.value?.balanceMicro ?? 0) < 0 ? 'user-overview__minus' : ''))
/** 角色控件：空名时提交要拦下来（「请输入角色名」） */
const roleField = ref<InstanceType<typeof RoleChoiceField> | null>(null)

const dirty = computed(
  () =>
    form.value.displayName !== props.user.displayName ||
    form.value.roleChoice !== roleText(props.user) ||
    form.value.status !== props.user.status,
)

// 模板里避免嵌套三元（vue-tsc 对多行属性 + 嵌套三元的解析有坑），一律在脚本里算好
const roleTagText = computed(() => roleText(props.user))
const roleTagTone = computed<AdminTone>(() => roleTone(props.user))
const statusText = computed(() => {
  if (props.user.status === 'active') return '正常'
  return props.user.status === 'pending' ? '待审批' : '已停用'
})
const statusTone = computed<AdminTone>(() => {
  if (props.user.status === 'active') return 'success'
  return props.user.status === 'pending' ? 'butter' : 'neutral'
})
const quotaText = computed(() =>
  props.user.quotaIsDefault
    ? `全局默认 · ${props.user.quota.cpus} 核 / ${props.user.quota.memoryMb} MB / ${props.user.quota.diskGb} GB`
    : `自定义 · ${props.user.quota.cpus} 核 / ${props.user.quota.memoryMb} MB / ${props.user.quota.diskGb} GB`,
)
const modelPolicyText = computed(() => (props.user.modelPolicy === 'managed' ? '管理员统一配置' : '用户自助'))
const runtimeText = computed(() => (props.user.runtimeId ? `钉选 #${props.user.runtimeId}` : '跟随默认版本'))

const inviteSource = computed(() => {
  const register = props.recentAudit.find((item) => item.action === 'auth.register')
  const code = register?.detail?.['inviteCode']
  if (typeof code === 'string' && code) return code
  if (register) return '开放注册'
  return '未知'
})

async function save(): Promise<void> {
  if (!roleField.value?.validate()) return
  saving.value = true
  try {
    await updateUser(props.user.id, {
      displayName: form.value.displayName,
      ...parseRoleChoice(form.value.roleChoice),
      status: form.value.status,
    })
    message.success('好的，已保存')
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="user-overview">
    <SoftCard title="资料">
      <div class="user-overview__identity">
        <AvatarImg
          :src="user.avatarUrl"
          :name="user.displayName || user.username"
          :seed="user.slug"
          :size="72"
          bordered
        />
        <div class="user-overview__names">
          <p class="user-overview__name">{{ user.displayName || user.username }}</p>
          <p class="user-overview__sub">用户名 {{ user.username }} · {{ user.slug }}</p>
          <div class="user-overview__tags">
            <MiniTag :text="roleTagText" :tone="roleTagTone" />
            <MiniTag :text="statusText" :tone="statusTone" />
            <MiniTag v-if="user.mustChangePassword" text="待改密" tone="butter" icon="i-ph-key" />
            <MiniTag v-if="user.deletedAt" text="已删除（保留中）" tone="danger" icon="i-ph-trash" />
          </div>
        </div>
      </div>

      <p v-if="user.bio" class="user-overview__bio">{{ user.bio }}</p>

      <div class="user-overview__form">
        <label class="user-overview__field">
          <span>昵称</span>
          <NInput v-model:value="form.displayName" size="small" maxlength="32" />
        </label>
        <div class="user-overview__field user-overview__field--role">
          <span>角色</span>
          <RoleChoiceField
            ref="roleField"
            v-model:value="form.roleChoice"
            :labels="roleLabelData?.items ?? []"
            size="small"
          />
        </div>
        <label class="user-overview__field">
          <span>状态</span>
          <NSelect
            v-model:value="form.status"
            size="small"
            :options="[
              { label: '正常', value: 'active' },
              { label: '待审批', value: 'pending' },
              { label: '已停用', value: 'disabled' },
            ]"
          />
        </label>
        <NButton
          size="small"
          type="primary"
          class="user-overview__save"
          :disabled="!dirty"
          :loading="saving"
          @click="save"
        >
          保存
        </NButton>
      </div>
    </SoftCard>

    <div class="user-overview__columns">
      <SoftCard title="注册信息">
        <dl class="user-overview__meta">
          <div>
            <dt>用户 ID</dt>
            <dd>#{{ user.id }}</dd>
          </div>
          <div>
            <dt>注册时间</dt>
            <dd :title="`${formatDateTime(user.createdAt)}（${fromNow(user.createdAt)}）`">
              {{ formatDateTime(user.createdAt) }}（{{ fromNow(user.createdAt) }}）
            </dd>
          </div>
          <div>
            <dt>最近登录</dt>
            <dd>{{ user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '从未登录' }}</dd>
          </div>
          <div>
            <dt>最近登录 IP</dt>
            <dd>{{ user.lastLoginIp ?? '—' }}</dd>
          </div>
          <div>
            <dt>在线会话</dt>
            <dd>{{ sessions }} 个</dd>
          </div>
        </dl>
      </SoftCard>

      <SoftCard title="积分">
        <template #extra>
          <RouterLink :to="walletHref" class="hub-link text-[12px]">在积分页查看</RouterLink>
        </template>
        <dl class="user-overview__meta">
          <div>
            <dt>余额</dt>
            <dd :class="['font-mono', balanceTone]">{{ formatPoints(wallet?.balanceMicro ?? 0) }} 积分</dd>
          </div>
          <div>
            <dt>本月消耗</dt>
            <dd :title="`${formatPoints(wallet?.monthCostMicro ?? 0)} 积分（${wallet?.monthRequests ?? 0} 次请求）`">
              {{ formatPoints(wallet?.monthCostMicro ?? 0) }} 积分（{{ wallet?.monthRequests ?? 0 }} 次请求）
            </dd>
          </div>
          <div>
            <dt>倍率 / 并发</dt>
            <dd>
              {{ wallet?.ratePercent ?? 100 }}% ·{{
                wallet?.maxConcurrency === null || wallet?.maxConcurrency === undefined
                  ? '默认并发'
                  : `并发 ${wallet.maxConcurrency}`
              }}
              · {{ wallet?.enabled === false ? '已停用' : '已启用' }}
            </dd>
          </div>
        </dl>
        <p v-if="walletError" class="user-overview__wallet-error">积分接口暂时读不到：{{ walletError }}</p>
        <NButton
          size="small"
          type="primary"
          ghost
          class="user-overview__wallet-action"
          :disabled="Boolean(walletError)"
          @click="showAdjust = true"
        >
          加 / 扣积分
        </NButton>
      </SoftCard>

      <SoftCard title="来源与配额">
        <dl class="user-overview__meta">
          <div>
            <dt>邀请码</dt>
            <dd class="font-mono" :title="inviteSource">{{ inviteSource }}</dd>
          </div>
          <div>
            <dt>配额</dt>
            <dd :title="quotaText">{{ quotaText }}</dd>
          </div>
          <div>
            <dt>模型策略</dt>
            <dd>{{ modelPolicyText }}</dd>
          </div>
          <div>
            <dt>DSH 版本</dt>
            <dd>{{ runtimeText }}</dd>
          </div>
        </dl>
      </SoftCard>
    </div>
  </div>

  <WalletAdjustDialog v-model:show="showAdjust" :wallet="wallet" @saved="loadWallet" />
</template>

<style scoped>
.user-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.user-overview__identity {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.user-overview__names {
  min-width: 0;
}

.user-overview__name {
  color: var(--c-text);
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
}

.user-overview__sub {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.user-overview__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.user-overview__bio {
  margin-top: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.user-overview__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}

.user-overview__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.user-overview__field:nth-child(1) {
  width: 200px;
}

.user-overview__field:nth-child(3) {
  width: 140px;
}

/* 角色控件要放下拉 + 「＋ 新建角色…」的输入框 + 说明，窄了会挤成竖排 */
.user-overview__field--role {
  width: 240px;
  min-width: 0;
}

@media (max-width: 640px) {
  .user-overview__field:nth-child(1),
  .user-overview__field:nth-child(3),
  .user-overview__field--role {
    width: 100%;
  }
}

.user-overview__columns {
  display: grid;
  gap: var(--space-4);
  /* 三列在 1280 下会把「标签 + 值」挤断行（07 §2.8）：宁可两列 */
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
}

.user-overview__minus {
  color: var(--c-danger-ink);
  font-weight: var(--fw-semibold);
}

.user-overview__wallet-error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.user-overview__wallet-action {
  margin-top: var(--space-3);
}

.user-overview__meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.user-overview__meta > div {
  display: flex;
  gap: var(--space-2);
}

.user-overview__meta dt {
  width: 88px;
  flex: none;
  color: var(--c-text-3);
}

.user-overview__meta dd {
  /* 07 §2.8：值单行显示；真的放不下就省略，完整内容在 title 里 */
  overflow: hidden;
  min-width: 0;
  color: var(--c-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
