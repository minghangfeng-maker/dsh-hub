<script setup lang="ts">
import { NButton, NTabs, NTabPane, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { approveUser, deleteUser, getUser, updateUser } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import AuditTimeline from '@/components/admin/AuditTimeline.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import { roleText, roleTone } from '@/components/admin/role'
import UserEnvironmentTab from '@/components/admin/UserEnvironmentTab.vue'
import UserOverviewTab from '@/components/admin/UserOverviewTab.vue'
import UserPluginsTab from '@/components/admin/UserPluginsTab.vue'
import UserSecurityTab from '@/components/admin/UserSecurityTab.vue'
import AvatarImg from '@/components/base/AvatarImg.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 用户详情（07 §7.3）：头部信息 + 5 个 Tab（概况 / 环境 / 插件 / 安全 / 审计）。
 * Tab 选择同步到 `?tab=`，便于把某个用户的环境页直接发给同事。
 */
const route = useRoute()
const router = useRouter()
const message = useMessage()

const userId = computed(() => Number(route.params['id']))

// 04 §10.2：UserPluginRow 自带 packageName/displayName，不必再拉全量插件列表做 join
const { data, loading, error, reload } = useAsyncData(() => getUser(userId.value))

const user = computed(() => data.value?.user ?? null)
const busy = ref(false)

const TABS = ['overview', 'environment', 'plugins', 'security', 'audit'] as const
type TabName = (typeof TABS)[number]

const activeTab = ref<TabName>(normalizeTab(route.query['tab']))

function normalizeTab(value: unknown): TabName {
  const raw = Array.isArray(value) ? value[0] : value
  return TABS.includes(raw as TabName) ? (raw as TabName) : 'overview'
}

watch(
  () => route.query['tab'],
  (value) => {
    const next = normalizeTab(value)
    if (next !== activeTab.value) activeTab.value = next
  },
)

watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } })
})

watch(userId, () => {
  void reload()
})

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    busy.value = false
  }
}

function toggleStatus(): void {
  const current = user.value
  if (!current) return
  void run(async () => {
    const next = current.status === 'disabled' ? 'active' : 'disabled'
    await updateUser(current.id, { status: next })
    message.success(next === 'active' ? '已启用账号' : '已停用账号')
    await reload()
  })
}

function approve(): void {
  const current = user.value
  if (!current) return
  void run(async () => {
    await approveUser(current.id)
    message.success('已通过审批')
    await reload()
  })
}

function removeUser(): void {
  const current = user.value
  if (!current) return
  void run(async () => {
    await sensitive(() => deleteUser(current.id, { purge: false }), {
      title: `删除用户 ${current.username}`,
      description: '会停止并删除容器，数据移入 trash/ 保留 7 天。确定要删除吗？',
      confirmText: '删除',
      type: 'error',
    })
    message.success('已删除，数据保留 7 天')
    await router.push('/admin/users')
  })
}

function rollout(kind: 'plugin' | 'models' | 'runtime'): void {
  if (!user.value) return
  void router.push({ path: '/admin/rollouts/new', query: { kind, userIds: String(user.value.id) } })
}

/** 审计 Tab 的「更多」链接跳到审计页并按该用户过滤（actorId）。 */
function auditMoreHref(): string {
  return `/admin/audit?actorId=${userId.value}`
}
</script>

<template>
  <AdminPage
    :title="user ? user.displayName || user.username : '用户详情'"
    :subtitle="user ? `@${user.username} · #${user.id}` : undefined"
    back-to="/admin/users"
    back-text="返回用户列表"
  >
    <template #actions>
      <NButton v-if="user?.status === 'pending'" size="small" type="primary" :loading="busy" @click="approve">
        通过审批
      </NButton>
      <NButton size="small" :loading="busy" @click="toggleStatus">
        {{ user?.status === 'disabled' ? '启用账号' : '停用账号' }}
      </NButton>
      <NButton size="small" @click="rollout('plugin')">下发插件</NButton>
      <NButton size="small" @click="rollout('models')">下发模型配置</NButton>
      <NButton size="small" type="error" ghost :loading="busy" @click="removeUser">删除</NButton>
    </template>

    <AdminErrorNotice :error="error" title="用户详情加载失败" @retry="reload" />

    <SoftCard v-if="!data && loading">
      <p class="text-2">正在加载用户…</p>
    </SoftCard>

    <template v-else-if="data && user">
      <SoftCard compact>
        <div class="detail__head">
          <AvatarImg
            :src="user.avatarUrl"
            :name="user.displayName || user.username"
            :seed="user.slug"
            :size="56"
            bordered
          />
          <div class="detail__head-body">
            <p class="detail__head-name">{{ user.displayName || user.username }}</p>
            <p class="detail__head-sub">{{ user.slug }} · 注册于 {{ user.createdAt.slice(0, 10) }}</p>
          </div>
          <div class="detail__head-tags">
            <MiniTag :text="roleText(user)" :tone="roleTone(user)" />
            <MiniTag
              :text="user.status === 'active' ? '正常' : user.status === 'pending' ? '待审批' : '已停用'"
              :tone="user.status === 'active' ? 'success' : user.status === 'pending' ? 'butter' : 'neutral'"
            />
            <MiniTag
              :text="user.instance.status === 'running' ? '实例运行中' : '实例未运行'"
              :tone="user.instance.status === 'running' ? 'success' : 'neutral'"
            />
          </div>
        </div>
      </SoftCard>

      <NTabs v-model:value="activeTab" type="line" animated>
        <NTabPane name="overview" tab="概况">
          <UserOverviewTab
            :user="user"
            :sessions="data.sessions"
            :recent-audit="data.recentAudit"
            @changed="reload"
          />
        </NTabPane>

        <NTabPane name="environment" tab="环境">
          <UserEnvironmentTab :user="user" @changed="reload" />
        </NTabPane>

        <NTabPane name="plugins" tab="插件">
          <UserPluginsTab
            :user-id="user.id"
            :username="user.username"
            :rows="data.plugins"
            @changed="reload"
          />
        </NTabPane>

        <NTabPane name="security" tab="安全">
          <UserSecurityTab :user="user" :sessions="data.sessions" @changed="reload" />
        </NTabPane>

        <NTabPane name="audit" tab="审计">
          <SoftCard title="与该用户相关的审计">
            <template #extra>
              <RouterLink :to="auditMoreHref()" class="hub-link text-[13px]">在审计页筛选更多</RouterLink>
            </template>
            <AuditTimeline :items="data.recentAudit" empty-text="暂无相关审计记录" />
          </SoftCard>
        </NTabPane>
      </NTabs>
    </template>
  </AdminPage>
</template>

<style scoped>
.detail__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.detail__head-body {
  min-width: 0;
}

.detail__head-name {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.detail__head-sub {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.detail__head-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-left: auto;
}
</style>
