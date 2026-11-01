<script setup lang="ts">
import {
  ROLE_TEXT_USER,
  type DeletedUserItem,
  type InstanceAction,
  type UserAdminView,
  type UserSort,
} from '@dsh-hub/shared'
import { useDebounceFn } from '@vueuse/core'
import {
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSwitch,
  useMessage,
  type DataTableColumns,
  type DataTableSortState,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { instanceAction } from '@/api/admin-instances'
import {
  approveUser,
  createUser,
  deleteUser,
  listDeletedUsers,
  listRoleLabels,
  listUsers,
  purgeUser,
  resetUserPassword,
  restoreUser,
  updateUser,
} from '@/api/admin-users'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import BatchActionBar from '@/components/admin/BatchActionBar.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import RoleChoiceField from '@/components/admin/RoleChoiceField.vue'
import {
  parseRoleChoice,
  roleFilterOptions,
  roleFilterQuery,
  roleText,
  roleTone,
} from '@/components/admin/role'
import UserCell from '@/components/admin/UserCell.vue'
import UserMoreMenu from '@/components/admin/UserMoreMenu.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { useTableQuery } from '@/composables/table-query'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 用户列表（07 §7.2）：服务端分页/筛选/排序，筛选条件与 URL 同步；
 * 批量选择 → 批量操作条；行内「更多」菜单；敏感操作走二次密码确认。
 *
 * WP22 起「状态」筛选多了「已删除」：选中时切到回收站接口与删除态列，
 * 就地「恢复 / 彻底删除」（不做独立的回收站页面）。
 */
const router = useRouter()
const message = useMessage()

const DEFAULTS = {
  q: '',
  status: '',
  role: '',
  instance: '',
  sort: 'createdAt:desc',
  page: 1,
  pageSize: 20,
}
type UsersQuery = typeof DEFAULTS

const { state, update, reset } = useTableQuery<UsersQuery>(DEFAULTS)

/** 搜索框独立于 URL 状态：输入 300ms 防抖后才写进地址栏并请求。 */
const searchInput = ref(state.value.q)
watch(
  () => state.value.q,
  (value) => {
    if (value !== searchInput.value) searchInput.value = value
  },
)

const applySearch = useDebounceFn((value: string) => update({ q: value }), 300)
watch(searchInput, (value) => {
  if (value !== state.value.q) applySearch(value)
})

/** 「状态」筛选里的「已删除」：列表切到回收站（04 §4.2），数据来自另一个接口。 */
const isDeletedMode = computed(() => state.value.status === 'deleted')

const usersQuery = useAsyncData(
  () =>
    listUsers({
      q: state.value.q || undefined,
      status: (state.value.status || undefined) as never,
      ...roleFilterQuery(state.value.role),
      instance: (state.value.instance || undefined) as never,
      sort: (state.value.sort || undefined) as UserSort | undefined,
      page: state.value.page,
      pageSize: state.value.pageSize,
    }),
  { immediate: false },
)
const deletedQuery = useAsyncData(
  () =>
    listDeletedUsers({
      q: state.value.q || undefined,
      page: state.value.page,
      pageSize: state.value.pageSize,
    }),
  { immediate: false },
)

const loading = computed(() => (isDeletedMode.value ? deletedQuery.loading.value : usersQuery.loading.value))
const error = computed(() => (isDeletedMode.value ? deletedQuery.error.value : usersQuery.error.value))
const errorTitle = computed(() => (isDeletedMode.value ? '回收站加载失败' : '用户列表加载失败'))

async function reload(): Promise<void> {
  await (isDeletedMode.value ? deletedQuery.reload() : usersQuery.reload())
}

watch(
  () => ({ ...state.value }),
  () => void reload(),
  { immediate: true },
)

const rows = computed<UserAdminView[]>(() => usersQuery.data.value?.items ?? [])
const deletedRows = computed<DeletedUserItem[]>(() => deletedQuery.data.value?.items ?? [])
const total = computed(() =>
  isDeletedMode.value ? (deletedQuery.data.value?.total ?? 0) : (usersQuery.data.value?.total ?? 0),
)
const checkedKeys = ref<number[]>([])
/** 切到回收站时清掉批量选择：那边只有单行「恢复 / 彻底删除」，没有批量操作 */
watch(isDeletedMode, (deleted) => {
  if (deleted) checkedKeys.value = []
})

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '待审批', value: 'pending' },
  { label: '正常', value: 'active' },
  { label: '已停用', value: 'disabled' },
  // 07 §7.2 定稿：不做独立回收站页，筛选到「已删除」就列出回收站用户，就地恢复/彻底删除
  { label: '已删除', value: 'deleted' },
]
/** 在用的自定义角色标签：筛选下拉与新建用户的候选项共用 */
const { data: roleLabelData, reload: reloadRoleLabels } = useAsyncData(() => listRoleLabels())
const roleLabels = computed(() => roleLabelData.value?.items ?? [])
const roleOptions = computed(() => roleFilterOptions(roleLabels.value))

const onlyRunning = computed({
  get: () => state.value.instance === 'running',
  set: (value: boolean) => update({ instance: value ? 'running' : '' }),
})

// ── 表格 ──

const SORT_MAP: Record<string, { ascend: UserSort; descend: UserSort }> = {
  createdAt: { ascend: 'createdAt:asc', descend: 'createdAt:desc' },
  username: { ascend: 'username:asc', descend: 'username:desc' },
  lastLoginAt: { ascend: 'lastLoginAt:desc', descend: 'lastLoginAt:desc' },
}

function sortOrderOf(key: string): 'ascend' | 'descend' | false {
  const current = state.value.sort
  if (current.startsWith(`${key}:`)) return current.endsWith(':asc') ? 'ascend' : 'descend'
  return false
}

function onSorterChange(sorter: DataTableSortState | DataTableSortState[] | null): void {
  const single = Array.isArray(sorter) ? sorter[0] : sorter
  const key = typeof single?.columnKey === 'string' ? single.columnKey : ''
  const order = single?.order ?? false
  if (!key || !order) {
    update({ sort: DEFAULTS.sort })
    return
  }
  update({ sort: SORT_MAP[key]?.[order] ?? DEFAULTS.sort })
}

function tagCell(
  text: string,
  tone: 'primary' | 'sky' | 'butter' | 'danger' | 'success' | 'neutral' | 'sakura',
) {
  return h(MiniTag, { text, tone, size: 'sm' })
}

const columns = computed<DataTableColumns<UserAdminView>>(() => [
  {
    type: 'selection',
    width: 40,
    fixed: 'left',
  },
  {
    title: '用户',
    key: 'username',
    width: 200,
    fixed: 'left',
    sorter: true,
    sortOrder: sortOrderOf('username'),
    render: (row) => h(UserCell, { user: row, to: `/admin/users/${row.id}` }),
  },
  {
    title: '角色',
    key: 'role',
    width: 110,
    render: (row) => tagCell(roleText(row), roleTone(row)),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) =>
      tagCell(
        row.status === 'active' ? '正常' : row.status === 'pending' ? '待审批' : '已停用',
        row.status === 'active' ? 'success' : row.status === 'pending' ? 'butter' : 'neutral',
      ),
  },
  {
    title: '实例',
    key: 'instance',
    width: 110,
    render: (row) => h(StatusPill, { status: row.instance.status, size: 'sm' }),
  },
  {
    title: 'DSH 版本',
    key: 'runtime',
    width: 110,
    render: (row) => row.instance.runtimeVersion ?? (row.runtimeId ? `#${row.runtimeId}` : '默认'),
  },
  {
    title: '模型',
    key: 'model',
    width: 110,
    render: (row) =>
      row.modelPolicy === 'managed'
        ? tagCell(row.modelPresetId ? `预设 #${row.modelPresetId}` : '托管', 'sky')
        : tagCell('自助', 'neutral'),
  },
  {
    title: '最近登录',
    key: 'lastLoginAt',
    width: 110,
    sorter: true,
    sortOrder: sortOrderOf('lastLoginAt'),
    render: (row) => (row.lastLoginAt ? fromNow(row.lastLoginAt) : '从未登录'),
  },
  {
    title: '注册时间',
    key: 'createdAt',
    width: 150,
    sorter: true,
    sortOrder: sortOrderOf('createdAt'),
    render: (row) => formatDateTime(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 64,
    fixed: 'right',
    render: (row) =>
      h(UserMoreMenu, {
        user: row,
        onInstance: (action: InstanceAction) => void runInstanceAction(row, action),
        onApprove: () => void runApprove(row),
        'onReset-password': () => void runResetPassword(row),
        onToggleStatus: () => void runToggleStatus(row),
        onDelete: () => void runDelete(row),
      }),
  },
])

/**
 * 回收站列（07 §7.2）：已删除用户点不进详情（`GET /users/:id` 对已删除返回 404），
 * 所以用户列不给链接；操作直接用「恢复 / 彻底删除」两个按钮，不挂「更多」菜单。
 */
const deletedColumns = computed<DataTableColumns<DeletedUserItem>>(() => [
  {
    title: '用户',
    key: 'username',
    width: 200,
    fixed: 'left',
    render: (row) => h(UserCell, { user: row }),
  },
  {
    title: '角色',
    key: 'role',
    width: 110,
    render: (row) => tagCell(roleText(row), roleTone(row)),
  },
  {
    title: '删除时间',
    key: 'deletedAt',
    width: 150,
    render: (row) => formatDateTime(row.deletedAt),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: () => tagCell('已删除', 'danger'),
  },
  {
    title: '剩余可恢复',
    key: 'daysLeft',
    width: 120,
    render: (row) =>
      row.daysLeft > 0 ? tagCell(`剩 ${row.daysLeft} 天`, 'butter') : tagCell('已过期', 'danger'),
  },
  {
    title: '数据',
    key: 'dataInTrash',
    width: 90,
    render: (row) => tagCell(row.dataInTrash ? '已保留' : '无数据', row.dataInTrash ? 'success' : 'neutral'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'users__row-actions' }, [
        h(
          NButton,
          {
            size: 'tiny',
            type: 'primary',
            quaternary: true,
            disabled: row.daysLeft <= 0,
            'data-testid': 'user-restore',
            onClick: () => openRestore(row),
          },
          { default: () => '恢复' },
        ),
        h(
          NButton,
          {
            size: 'tiny',
            type: 'error',
            quaternary: true,
            'data-testid': 'user-purge',
            onClick: () => void runPurge(row),
          },
          { default: () => '彻底删除' },
        ),
      ]),
  },
])

/** 普通列表列多（含批量选择列），回收站列少 */
const tableScrollX = computed(() => (isDeletedMode.value ? 900 : 1090))

// ── 行操作 ──

async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    message.error(describeError(cause).message)
  }
}

async function runInstanceAction(row: UserAdminView, action: InstanceAction): Promise<void> {
  await guard(async () => {
    await instanceAction(row.id, action)
    message.success(
      `已${action === 'start' ? '启动' : action === 'stop' ? '停止' : action === 'restart' ? '重启' : '重建'} ${row.username} 的实例`,
    )
    await reload()
  })
}

async function runApprove(row: UserAdminView): Promise<void> {
  await guard(async () => {
    await approveUser(row.id)
    message.success(`已通过 ${row.username} 的注册审批`)
    await reload()
  })
}

async function runResetPassword(row: UserAdminView): Promise<void> {
  await guard(async () => {
    const result = await sensitive(() => resetUserPassword(row.id), {
      title: '重置密码',
      description: `将为 ${row.username} 生成一个新的临时密码，用户下次登录后需要改密。`,
      confirmText: '重置',
    })
    tempPassword.value = result.tempPassword
    tempPasswordUser.value = row.username
    showTempPassword.value = true
  })
}

async function runToggleStatus(row: UserAdminView): Promise<void> {
  await guard(async () => {
    const next = row.status === 'disabled' ? 'active' : 'disabled'
    await updateUser(row.id, { status: next })
    message.success(next === 'active' ? `已启用 ${row.username}` : `已停用 ${row.username}`)
    await reload()
  })
}

async function runDelete(row: UserAdminView): Promise<void> {
  await guard(async () => {
    await sensitive(() => deleteUser(row.id, { purge: false }), {
      title: `删除用户 ${row.username}`,
      description: '会停止并删除容器，数据移入 trash/ 保留 7 天。确定要删除吗？',
      confirmText: '删除',
      type: 'error',
    })
    message.success(`已删除 ${row.username}`)
    checkedKeys.value = checkedKeys.value.filter((id) => id !== row.id)
    await reload()
  })
}

// ── 回收站（已删除用户） ──

const showRestore = ref(false)
const restoring = ref(false)
/** 正在恢复的那一行：`username` 是删除时的原名（回收站里恢复时的默认值） */
const restoreTarget = ref<DeletedUserItem | null>(null)
const restoreUsername = ref('')
const restoreError = ref('')

function openRestore(row: DeletedUserItem): void {
  restoreTarget.value = row
  restoreUsername.value = row.username
  restoreError.value = ''
  showRestore.value = true
}

async function submitRestore(): Promise<void> {
  const target = restoreTarget.value
  if (!target) return

  restoreError.value = ''
  restoring.value = true
  try {
    const username = restoreUsername.value.trim()
    const result = await sensitive(
      // 不改名就不传 username：服务端直接用删除时的原名
      () => restoreUser(target.id, username && username !== target.username ? { username } : {}),
      {
        title: `恢复用户 ${target.username}`,
        description: '恢复后账号回到删除前的状态，trash/ 里的数据目录也会搬回来。',
        confirmText: '恢复',
      },
    )
    showRestore.value = false
    message.success(`已恢复 ${result.user.username}`)
    void reloadRoleLabels()
    await reload()
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    // 409 USERNAME_TAKEN / 400 VALIDATION_FAILED 的文案留在弹窗里，方便直接换个名字重试
    restoreError.value = describeError(cause).message
  } finally {
    restoring.value = false
  }
}

async function runPurge(row: DeletedUserItem): Promise<void> {
  await guard(async () => {
    await sensitive(() => purgeUser(row.id), {
      title: `彻底删除 ${row.username}`,
      description: '会连同 trash/ 里的数据一起删掉，账号和数据都无法恢复。确定吗？',
      confirmText: '彻底删除',
      type: 'error',
    })
    message.success(`已彻底删除 ${row.username}`)
    await reload()
  })
}

/** 普通列表搜不到时：一键切到回收站（保留搜索词，清掉对已删除用户无效的筛选） */
function viewDeleted(): void {
  void update({ status: 'deleted', role: '', instance: '' })
}

// ── 批量操作 ──

async function batchSetStatus(status: 'active' | 'disabled'): Promise<void> {
  const ids = [...checkedKeys.value]
  await guard(async () => {
    await Promise.all(ids.map((id) => updateUser(id, { status })))
    message.success(`已${status === 'active' ? '启用' : '停用'} ${ids.length} 位用户`)
    checkedKeys.value = []
    await reload()
  })
}

function batchRollout(kind: 'plugin' | 'runtime'): void {
  const userIds = checkedKeys.value.join(',')
  void router.push({ path: '/admin/rollouts/new', query: { kind, userIds } })
}

// ── 新建用户 ──

const showCreate = ref(false)
const creating = ref(false)
const emptyCreateForm = () => ({ username: '', password: '', displayName: '', roleChoice: ROLE_TEXT_USER })
const createForm = ref(emptyCreateForm())
const createError = ref('')
/** 角色控件：选「＋ 新建角色…」后输入的名字就是角色值；提交前先 validate() */
const createRoleField = ref<InstanceType<typeof RoleChoiceField> | null>(null)

const showTempPassword = ref(false)
const tempPassword = ref('')
const tempPasswordUser = ref('')

async function submitCreate(): Promise<void> {
  createError.value = ''
  if (!createRoleField.value?.validate()) return
  creating.value = true
  try {
    const result = await createUser({
      username: createForm.value.username.trim(),
      password: createForm.value.password || undefined,
      displayName: createForm.value.displayName.trim() || undefined,
      ...parseRoleChoice(createForm.value.roleChoice),
    })
    showCreate.value = false
    createForm.value = emptyCreateForm()
    void reloadRoleLabels()
    if (result.tempPassword) {
      tempPassword.value = result.tempPassword
      tempPasswordUser.value = result.user.username
      showTempPassword.value = true
    } else {
      message.success(`已创建用户 ${result.user.username}`)
    }
    await reload()
  } catch (cause) {
    createError.value = isHubApiError(cause) ? describeError(cause).message : '创建失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <AdminPage title="用户" wide>
    <template #actions>
      <NButton size="small" type="primary" @click="showCreate = true">
        <template #icon><span class="i-ph-user-plus" aria-hidden="true" /></template>
        新建用户
      </NButton>
      <NButton size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <AdminErrorNotice :error="error" :title="errorTitle" @retry="reload" />

    <SoftCard :padded="false">
      <div class="users__toolbar">
        <NInput
          v-model:value="searchInput"
          class="users__search"
          size="small"
          placeholder="搜索用户名 / 昵称"
          clearable
        >
          <template #prefix><span class="i-ph-magnifying-glass text-3" aria-hidden="true" /></template>
        </NInput>

        <NSelect
          v-model:value="state.status"
          class="users__select"
          size="small"
          :options="statusOptions"
          aria-label="按状态筛选"
        />
        <NSelect
          v-if="!isDeletedMode"
          v-model:value="state.role"
          class="users__select"
          size="small"
          :options="roleOptions"
          aria-label="按角色筛选"
        />

        <label v-if="!isDeletedMode" class="users__switch">
          <NSwitch v-model:value="onlyRunning" size="small" />
          <span>仅运行中</span>
        </label>

        <NButton size="small" quaternary :disabled="loading" @click="reset">清空筛选</NButton>

        <span class="users__count">{{ isDeletedMode ? `回收站 ${total} 位` : `共 ${total} 位` }}</span>
      </div>

      <NDataTable
        v-model:checked-row-keys="checkedKeys"
        class="users__table"
        :columns="isDeletedMode ? deletedColumns : columns"
        :data="isDeletedMode ? deletedRows : rows"
        :loading="loading"
        :row-key="(row: UserAdminView | DeletedUserItem) => row.id"
        :scroll-x="tableScrollX"
        remote
        size="small"
        :pagination="{
          page: state.page,
          pageSize: state.pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [20, 50, 100],
          prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
          onUpdatePage: (page: number) => update({ page }),
          onUpdatePageSize: (pageSize: number) => update({ pageSize, page: 1 }),
        }"
        :sorter="{
          multiple: false,
          compare: () => 0,
        }"
        @update:sorter="onSorterChange"
      >
        <template #empty>
          <div class="users__empty">
            {{ isDeletedMode ? '回收站里还没有已删除的用户' : state.q ? '没有匹配的用户' : '还没有用户' }}
          </div>
        </template>
      </NDataTable>

      <!-- 普通列表搜不到时：提醒「已删除」筛选（07 §7.2 / 任务书 §1.5） -->
      <div v-if="!isDeletedMode && !loading && !error && state.q && rows.length === 0" class="users__hint">
        <span class="i-ph-trash" aria-hidden="true" />
        <span>没找到？如果该用户已被删除，去回收站看看。</span>
        <NButton size="tiny" text type="primary" @click="viewDeleted">查看已删除</NButton>
      </div>
    </SoftCard>

    <BatchActionBar v-if="!isDeletedMode" :count="checkedKeys.length" unit="位用户" @clear="checkedKeys = []">
      <NButton size="small" @click="batchSetStatus('active')">启用</NButton>
      <NButton size="small" @click="batchSetStatus('disabled')">停用</NButton>
      <NButton size="small" type="primary" @click="batchRollout('plugin')">下发插件</NButton>
      <NButton size="small" @click="batchRollout('runtime')">升级 DSH</NButton>
    </BatchActionBar>

    <!-- 新建用户 -->
    <NModal v-model:show="showCreate" preset="card" title="新建用户" :style="{ maxWidth: '460px' }">
      <NForm label-placement="top" size="small">
        <NFormItem label="用户名" required>
          <NInput v-model:value="createForm.username" placeholder="小写字母、数字、- 和 _" />
        </NFormItem>
        <NFormItem label="昵称">
          <NInput v-model:value="createForm.displayName" placeholder="可留空，默认与用户名相同" />
        </NFormItem>
        <NFormItem label="初始密码">
          <NInput
            v-model:value="createForm.password"
            type="password"
            show-password-on="click"
            placeholder="留空则自动生成一次性临时密码"
          />
        </NFormItem>
        <NFormItem label="角色" :show-feedback="false">
          <RoleChoiceField ref="createRoleField" v-model:value="createForm.roleChoice" :labels="roleLabels" />
        </NFormItem>
      </NForm>
      <p v-if="createError" class="users__error" role="alert">{{ createError }}</p>
      <template #footer>
        <div class="users__footer">
          <NButton size="small" @click="showCreate = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </div>
      </template>
    </NModal>

    <!-- 临时密码：只显示一次 -->
    <NModal
      v-model:show="showTempPassword"
      preset="card"
      title="请把临时密码交给用户"
      :style="{ maxWidth: '420px' }"
    >
      <p class="users__temp-user">用户：{{ tempPasswordUser }}</p>
      <p class="users__temp-code">{{ tempPassword }}</p>
      <p class="users__temp-hint">关闭后将无法再次查看；用户首次登录会被要求修改密码。</p>
      <template #footer>
        <div class="users__footer">
          <NButton size="small" type="primary" @click="showTempPassword = false">我已记下</NButton>
        </div>
      </template>
    </NModal>

    <!-- 恢复已删除用户：用户名默认删除时的原名，被新用户占用时可在这里改 -->
    <NModal v-model:show="showRestore" preset="card" title="恢复用户" :style="{ maxWidth: '440px' }">
      <NForm label-placement="top" size="small">
        <NFormItem label="用户名" required>
          <NInput
            v-model:value="restoreUsername"
            data-testid="restore-username"
            placeholder="小写字母、数字、- 和 _"
          />
        </NFormItem>
      </NForm>
      <p v-if="restoreTarget" class="users__hint-line">
        删除时的用户名是「{{ restoreTarget.username }}」，如果它已被新用户占用，改一个再提交。
      </p>
      <p v-if="restoreError" class="users__error" role="alert" aria-live="polite">{{ restoreError }}</p>
      <template #footer>
        <div class="users__footer">
          <NButton size="small" :disabled="restoring" @click="showRestore = false">取消</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="restoring"
            data-testid="restore-submit"
            @click="submitRestore"
          >
            恢复
          </NButton>
        </div>
      </template>
    </NModal>
  </AdminPage>
</template>

<style scoped>
.users__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--c-border);
}

.users__search {
  width: 220px;
}

.users__select {
  width: 132px;
}

.users__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.users__count {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.users__table {
  padding: 0 var(--space-2) var(--space-2);
}

/* 渲染函数里的节点在 NDataTable 内部，用 :deep 才能命中 scoped 样式 */
:deep(.users__row-actions) {
  display: flex;
  gap: var(--space-1);
}

.users__empty {
  padding: var(--space-4) 0;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.users__hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.users__hint-line {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.users__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.users__error {
  margin-top: var(--space-2);
  color: var(--c-danger);
  font-size: var(--fs-13);
}

.users__temp-user {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.users__temp-code {
  margin-block: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-family: var(--font-mono);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  letter-spacing: 1px;
  text-align: center;
  word-break: break-all;
}

.users__temp-hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
