<script setup lang="ts">
import { ROLE_TEXT_USER, type InviteRow } from '@dsh-hub/shared'
import {
  NButton,
  NDataTable,
  NDatePicker,
  NDropdown,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSwitch,
  useMessage,
  type DataTableColumns,
  type DropdownOption,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import { createInvites, deleteInvite, listInvites, listRoleLabels, updateInvite } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import RoleChoiceField from '@/components/admin/RoleChoiceField.vue'
import { parseRoleChoice, roleText, roleTone } from '@/components/admin/role'
import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { useTableQuery } from '@/composables/table-query'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 邀请码（07 §7.10）：生成（数量 / 可用次数 / 过期时间 / 备注 / **角色**）→ 生成后**一次性展示**
 * 并支持一键复制注册链接；列表显示使用情况与角色，可停用、改角色（只影响之后注册的人）与删除。
 *
 * 角色控件与新建用户同一个（`components/admin/RoleChoiceField.vue`），但**没有「管理员」选项**——
 * 邀请码永远只发普通用户；「管理员」由服务端兜底拒绝。
 */
const message = useMessage()

const DEFAULTS = { page: 1, pageSize: 20 }
type InviteQuery = typeof DEFAULTS
const { state, update } = useTableQuery<InviteQuery>(DEFAULTS)

const { data, loading, error, reload } = useAsyncData(() =>
  listInvites({ page: state.value.page, pageSize: state.value.pageSize }),
)
watch(
  () => ({ ...state.value }),
  () => void reload(),
)

// 候选 = 用户在用的标签 ∪ 邀请码上的标签（04 §4.2）；生成/改角色后重新拉，新名字立刻可选
const { data: roleLabelData, reload: reloadRoleLabels } = useAsyncData(() => listRoleLabels())

const rows = computed<InviteRow[]>(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

const registerBase = computed(() => (typeof window === 'undefined' ? '' : window.location.origin))
const linkOf = (code: string): string => `${registerBase.value}/register?code=${code}`

/** 邀请码只带角色名：界面上按「普通用户权限 + 自定义名」渲染（与用户列表同一套色调） */
const holderOf = (row: { roleLabel: string }) => ({ role: 'user' as const, roleLabel: row.roleLabel })

// ── 生成 ──

const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')
const created = ref<InviteRow[]>([])
const showCreated = ref(false)

const form = ref({
  count: 5,
  maxUses: 1,
  note: '',
  expiresAt: null as number | null,
  roleChoice: ROLE_TEXT_USER,
})

const createdRoleText = computed(() => roleText(holderOf(created.value[0] ?? { roleLabel: '' })))
/** 角色控件（「＋ 新建角色…」的新名字）；邀请码不能发管理员 → allowAdmin=false */
const createRoleField = ref<InstanceType<typeof RoleChoiceField> | null>(null)

async function submitCreate(): Promise<void> {
  createError.value = ''
  if (!createRoleField.value?.validate()) return
  creating.value = true
  try {
    const result = await createInvites({
      count: form.value.count,
      maxUses: form.value.maxUses,
      note: form.value.note,
      expiresAt: form.value.expiresAt ? new Date(form.value.expiresAt).toISOString() : null,
      // 只发角色名；「管理员」在服务端被拒（这里也选不到）
      roleLabel: parseRoleChoice(form.value.roleChoice).roleLabel,
    })
    created.value = result.items
    showCreate.value = false
    showCreated.value = true
    await Promise.all([reload(), reloadRoleLabels()])
  } catch (cause) {
    createError.value = describeError(cause).message
  } finally {
    creating.value = false
  }
}

const allLinks = computed(() => created.value.map((invite) => linkOf(invite.code)).join('\n'))

// ── 修改角色 ──

const showRole = ref(false)
const editing = ref<InviteRow | null>(null)
const roleChoice = ref(ROLE_TEXT_USER)
const savingRole = ref(false)
const roleError = ref('')
const editRoleField = ref<InstanceType<typeof RoleChoiceField> | null>(null)

function openRoleDialog(invite: InviteRow): void {
  editing.value = invite
  roleChoice.value = roleText(holderOf(invite))
  roleError.value = ''
  showRole.value = true
}

async function submitRole(): Promise<void> {
  const invite = editing.value
  if (!invite) return
  roleError.value = ''
  if (!editRoleField.value?.validate()) return
  savingRole.value = true
  try {
    await updateInvite(invite.id, { roleLabel: parseRoleChoice(roleChoice.value).roleLabel })
    message.success('角色已更新，只影响之后用此码注册的人')
    showRole.value = false
    await Promise.all([reload(), reloadRoleLabels()])
  } catch (cause) {
    roleError.value = describeError(cause).message
  } finally {
    savingRole.value = false
  }
}

// ── 行操作 ──

async function toggleDisabled(invite: InviteRow, disabled: boolean): Promise<void> {
  try {
    await updateInvite(invite.id, { disabled })
    message.success(disabled ? '已停用这个邀请码' : '已重新启用')
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function remove(invite: InviteRow): Promise<void> {
  try {
    await sensitive(() => deleteInvite(invite.id), {
      title: '删除邀请码',
      description: '只有从未被使用过的邀请码可以删除。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('邀请码已删除')
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

const actionOptions = (row: InviteRow): DropdownOption[] => [
  { key: 'role', label: '修改角色', icon: () => h('span', { class: 'i-ph-user-switch' }) },
  { type: 'divider', key: 'd1' },
  {
    key: 'delete',
    label: '删除邀请码',
    icon: () => h('span', { class: 'i-ph-trash' }),
    disabled: row.usedCount > 0,
    props: { class: 'dropdown-danger' },
  },
]

function onAction(row: InviteRow, key: string): void {
  if (key === 'role') openRoleDialog(row)
  else if (key === 'delete') void remove(row)
}

const columns = computed<DataTableColumns<InviteRow>>(() => [
  {
    title: '邀请码',
    key: 'code',
    width: 190,
    render: (row) => h(CopyText, { text: row.code, size: 'sm' }),
  },
  {
    title: '角色',
    key: 'roleLabel',
    width: 96,
    render: (row) =>
      h(MiniTag, {
        text: roleText(holderOf(row)),
        tone: roleTone(holderOf(row)),
        size: 'sm',
      }),
  },
  {
    title: '状态',
    key: 'status',
    width: 96,
    render: (row) => {
      if (row.disabled) return h(MiniTag, { text: '已停用', tone: 'neutral', size: 'sm' })
      if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
        return h(MiniTag, { text: '已过期', tone: 'butter', size: 'sm' })
      }
      if (row.usedCount >= row.maxUses) return h(MiniTag, { text: '已用尽', tone: 'neutral', size: 'sm' })
      return h(MiniTag, { text: '可用', tone: 'primary', size: 'sm' })
    },
  },
  {
    title: '使用情况',
    key: 'uses',
    width: 106,
    render: (row) =>
      h('div', { class: 'invites__uses' }, [
        h('span', null, `${row.usedCount} / ${row.maxUses}`),
        row.uses.length > 0
          ? h('span', { class: 'invites__users' }, row.uses.map((use) => use.username).join('、'))
          : null,
      ]),
  },
  {
    title: '备注',
    key: 'note',
    minWidth: 170,
    render: (row) => row.note || '—',
  },
  {
    title: '过期时间',
    key: 'expiresAt',
    width: 140,
    render: (row) => (row.expiresAt ? formatDateTime(row.expiresAt) : '永不过期'),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 104,
    render: (row) => fromNow(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 250,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'invites__actions' }, [
        // 注册链接很长：给固定宽度 + 省略号，否则会把一行挤成竖排（WP6 遗留的排版问题）；
        // 完整链接在「生成成功」的一次性弹窗里可以整批复制
        h('div', { class: 'invites__link' }, [
          h(CopyText, { text: linkOf(row.code), truncate: true, size: 'sm' }),
        ]),
        h(NSwitch, {
          value: !row.disabled,
          size: 'small',
          'aria-label': '启用 / 停用',
          'onUpdate:value': (value: boolean) => void toggleDisabled(row, !value),
        }),
        h(
          NDropdown,
          {
            options: actionOptions(row),
            trigger: 'click',
            placement: 'bottom-end',
            onSelect: (key: string) => onAction(row, key),
          },
          {
            default: () =>
              h(
                NButton,
                { size: 'tiny', quaternary: true, 'aria-label': `${row.code} 的更多操作` },
                { icon: () => h('span', { class: 'i-ph-dots-three-vertical', 'aria-hidden': 'true' }) },
              ),
          },
        ),
      ]),
  },
])
</script>

<template>
  <AdminPage title="邀请码" wide>
    <template #actions>
      <NButton size="small" type="primary" @click="showCreate = true">
        <template #icon><span class="i-ph-ticket" aria-hidden="true" /></template>
        生成邀请码
      </NButton>
      <NButton size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="邀请码加载失败" @retry="reload" />

    <EmptyState
      v-if="rows.length === 0 && !loading"
      title="还没有邀请码"
      description="生成后可以复制注册链接发出去；码只在生成时显示一次，请及时保存。"
      action-text="生成邀请码"
      @action="showCreate = true"
    />

    <SoftCard v-else :padded="false">
      <NDataTable
        class="invites__table"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(row: InviteRow) => row.id"
        :scroll-x="1180"
        remote
        size="small"
        :pagination="{
          page: state.page,
          pageSize: state.pageSize,
          itemCount: total,
          onUpdatePage: (page: number) => update({ page }),
        }"
      />
    </SoftCard>

    <!-- 生成 -->
    <NModal v-model:show="showCreate" preset="card" title="生成邀请码" :style="{ maxWidth: '440px' }">
      <NForm label-placement="top" size="small">
        <NFormItem label="数量">
          <NInputNumber v-model:value="form.count" :min="1" :max="50" />
        </NFormItem>
        <NFormItem label="每个码可用次数">
          <NInputNumber v-model:value="form.maxUses" :min="1" :max="1000" />
        </NFormItem>
        <NFormItem label="角色">
          <div class="invites__role-field">
            <RoleChoiceField
              ref="createRoleField"
              v-model:value="form.roleChoice"
              :labels="roleLabelData?.items ?? []"
              :allow-admin="false"
            />
          </div>
        </NFormItem>
        <NFormItem label="过期时间">
          <NDatePicker
            v-model:value="form.expiresAt"
            type="datetime"
            clearable
            class="w-full"
            placeholder="留空 = 永不过期"
          />
        </NFormItem>
        <NFormItem label="备注">
          <NInput v-model:value="form.note" placeholder="例如：给产品群的三位同学" />
        </NFormItem>
      </NForm>
      <p v-if="createError" class="invites__error" role="alert">{{ createError }}</p>
      <template #footer>
        <div class="invites__footer">
          <NButton size="small" @click="showCreate = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creating" @click="submitCreate">生成</NButton>
        </div>
      </template>
    </NModal>

    <!-- 修改角色 -->
    <NModal v-model:show="showRole" preset="card" title="修改角色" :style="{ maxWidth: '440px' }">
      <NForm label-placement="top" size="small">
        <NFormItem>
          <template #label>
            角色
            <InfoTip text="只影响之后用此码注册的人，已经注册过的用户不会被改写。" />
          </template>
          <div class="invites__role-field">
            <RoleChoiceField
              ref="editRoleField"
              v-model:value="roleChoice"
              :labels="roleLabelData?.items ?? []"
              :allow-admin="false"
            />
          </div>
        </NFormItem>
      </NForm>
      <p v-if="roleError" class="invites__error" role="alert">{{ roleError }}</p>
      <template #footer>
        <div class="invites__footer">
          <NButton size="small" @click="showRole = false">取消</NButton>
          <NButton size="small" type="primary" :loading="savingRole" @click="submitRole">保存</NButton>
        </div>
      </template>
    </NModal>

    <!-- 一次性展示 -->
    <NModal
      v-model:show="showCreated"
      preset="card"
      title="邀请码已生成（只显示这一次）"
      :style="{ maxWidth: '520px' }"
    >
      <ul class="invites__created">
        <li v-for="invite in created" :key="invite.id">
          <CopyText :text="invite.code" size="sm" />
        </li>
      </ul>

      <p class="invites__hint">角色：{{ createdRoleText }}</p>
      <p class="invites__hint">注册链接</p>
      <CopyText :text="allLinks" size="sm" />
      <template #footer>
        <div class="invites__footer">
          <NButton size="small" type="primary" @click="showCreated = false">我已保存</NButton>
        </div>
      </template>
    </NModal>
  </AdminPage>
</template>

<style scoped>
.invites__table {
  padding: var(--space-2) var(--space-3);
}

.invites__error {
  margin-top: var(--space-2);
  color: var(--c-danger);
  font-size: var(--fs-13);
}

.invites__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.invites__created {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.invites__hint {
  margin-top: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.invites__role-field {
  display: flex;
  flex-direction: column;
  width: 100%;
}

:deep(.invites__uses) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.invites__users) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

:deep(.invites__actions) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* 注册链接固定宽度，里面的 URL 用省略号截断（复制仍是全文） */
:deep(.invites__link) {
  width: 160px;
  flex: none;
  min-width: 0;
}
</style>
