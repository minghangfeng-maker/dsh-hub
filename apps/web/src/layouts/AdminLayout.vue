<script setup lang="ts">
import { useMediaQuery, useStorage } from '@vueuse/core'
import { NDropdown, NInput, useMessage, type DropdownOption } from 'naive-ui'
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { listUsers } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AvatarImg from '@/components/base/AvatarImg.vue'
import BrandMark from '@/components/base/BrandMark.vue'
import WaterBackdrop from '@/components/base/WaterBackdrop.vue'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'
import { ADMIN_NAV_GROUPS } from './admin-nav'

/**
 * 管理端外壳（07 §4）：左侧 232px 侧边栏（可折叠为 64px 图标栏，状态存 localStorage），
 * 顶栏含面包屑、全局搜索用户（回车跳详情）、“返回我的工作台”与头像；手机端侧边栏变抽屉。
 * 导航条目在 `admin-nav.ts`（共享文件，任务包只在末尾追加）。
 */
type AdminNavItem = (typeof ADMIN_NAV_GROUPS)[number]['items'][number]

const auth = useAuthStore()
const site = useSiteStore()
const route = useRoute()
const router = useRouter()
const message = useMessage()

/** 折叠状态存 localStorage（07 §4：可折叠为 64px 图标栏） */
const collapsed = useStorage('hub.admin.sidebar-collapsed', false)
const isMobile = useMediaQuery('(max-width: 900px)')
const drawerOpen = ref(false)

const keyword = ref('')
const searching = ref(false)

onMounted(() => {
  void site.load()
  void auth.ensureLoaded()
})

// 手机上点了导航就收起抽屉
watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false
  },
)

/** 精确匹配或子路径高亮（这样详情页也能点亮父项；`/admin/users-x` 不会误点亮「用户」）。 */
function isActive(item: AdminNavItem): boolean {
  return route.path === item.to || route.path.startsWith(`${item.to}/`)
}

const breadcrumbs = computed(() =>
  route.matched
    .filter((record) => typeof record.meta.title === 'string' && record.meta.title.length > 0)
    .map((record) => record.meta.title as string),
)

/** 下拉菜单图标用渲染函数（Naive 的 MenuOption.icon 只接受 VNode） */
const iconOf = (className: string) => () => h('span', { class: className })

const accountOptions: DropdownOption[] = [
  { key: 'home', label: '返回我的工作台', icon: iconOf('i-ph-house-line') },
  { key: 'me', label: '个人中心', icon: iconOf('i-ph-user') },
  { key: 'logout', label: '退出登录', icon: iconOf('i-ph-sign-out') },
]

async function onAccountSelect(key: string): Promise<void> {
  if (key === 'home') await router.push('/home')
  else if (key === 'me') await router.push('/me')
  else if (key === 'logout') {
    await auth.logout()
    await router.push('/login')
  }
}

/** 全局搜索用户：唯一命中直接进详情，否则带关键词去列表（07 §4）。 */
async function searchUser(): Promise<void> {
  const q = keyword.value.trim()
  if (!q || searching.value) return

  searching.value = true
  try {
    const result = await listUsers({ q, pageSize: 1 })
    const only = result.total === 1 ? result.items[0] : undefined
    if (only) await router.push(`/admin/users/${only.id}`)
    else await router.push({ path: '/admin/users', query: { q } })
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <div class="admin-layout">
    <WaterBackdrop variant="calm" />

    <div
      v-if="isMobile && drawerOpen"
      class="admin-layout__scrim"
      aria-hidden="true"
      @click="drawerOpen = false"
    />

    <aside
      class="admin-aside"
      :class="{ 'admin-aside--collapsed': collapsed && !isMobile, 'admin-aside--open': drawerOpen }"
      :aria-label="'管理后台导航'"
    >
      <div class="admin-aside__head">
        <RouterLink to="/home" class="admin-aside__logo">
          <BrandMark :size="26" />
          <span v-if="!collapsed || isMobile" class="admin-aside__logo-text">{{ site.site.name }}</span>
        </RouterLink>
      </div>

      <nav class="admin-aside__nav">
        <div v-for="group in ADMIN_NAV_GROUPS" :key="group.title || 'overview'" class="admin-aside__group">
          <p v-if="group.title && (!collapsed || isMobile)" class="admin-aside__group-title">
            {{ group.title }}
          </p>
          <ul>
            <li v-for="item in group.items" :key="item.to">
              <RouterLink
                :to="item.to"
                class="admin-nav-item"
                :class="{ 'admin-nav-item--active': isActive(item) }"
                :title="item.label"
              >
                <span :class="item.icon" class="admin-nav-item__icon" aria-hidden="true" />
                <span v-if="!collapsed || isMobile" class="admin-nav-item__label">{{ item.label }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </nav>

      <div class="admin-aside__foot">
        <button
          v-if="!isMobile"
          type="button"
          class="admin-aside__collapse press"
          :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="collapsed = !collapsed"
        >
          <span
            :class="collapsed ? 'i-ph-caret-double-right' : 'i-ph-caret-double-left'"
            aria-hidden="true"
          />
          <span v-if="!collapsed">收起</span>
        </button>
      </div>
    </aside>

    <div class="admin-layout__main">
      <header class="admin-header">
        <div class="admin-header__row">
          <button
            v-if="isMobile"
            type="button"
            class="admin-header__icon-btn press"
            aria-label="打开导航"
            @click="drawerOpen = true"
          >
            <span class="i-ph-list" aria-hidden="true" />
          </button>

          <nav class="admin-header__crumbs" aria-label="面包屑">
            <span class="admin-header__crumb admin-header__crumb--root">管理后台</span>
            <template v-for="crumb in breadcrumbs" :key="crumb">
              <span class="i-ph-caret-right admin-header__crumb-sep" aria-hidden="true" />
              <span class="admin-header__crumb">{{ crumb }}</span>
            </template>
          </nav>

          <div class="admin-header__search">
            <NInput
              v-model:value="keyword"
              size="small"
              placeholder="搜索用户名 / 昵称，回车跳转"
              clearable
              :loading="searching"
              :input-props="{ 'aria-label': '搜索用户' }"
              @keyup.enter="searchUser"
            >
              <template #prefix>
                <span class="i-ph-magnifying-glass text-3" aria-hidden="true" />
              </template>
            </NInput>
          </div>

          <RouterLink to="/home" class="admin-header__back hub-link hidden md:inline-flex">
            <span class="i-ph-house-line" aria-hidden="true" />
            返回我的工作台
          </RouterLink>

          <NDropdown :options="accountOptions" trigger="click" @select="onAccountSelect">
            <button type="button" class="admin-header__account press" aria-label="账号菜单">
              <AvatarImg
                :src="auth.avatarUrl"
                :name="auth.displayName"
                :seed="auth.user?.slug"
                :size="30"
                bordered
              />
            </button>
          </NDropdown>
        </div>
      </header>

      <main class="admin-layout__scroll">
        <div class="hub-container--admin">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  background: var(--c-bg);
}

/* ── 侧边栏 ── */

.admin-aside {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  width: 232px;
  height: 100vh;
  flex: none;
  flex-direction: column;
  overflow-y: auto;
  border-right: var(--border-width) solid var(--c-border);
  background: var(--c-surface);
  transition: width var(--duration-base) var(--ease-out-soft);
}

.admin-aside--collapsed {
  width: 64px;
}

.admin-aside__head {
  display: flex;
  height: 64px;
  flex: none;
  align-items: center;
  padding-inline: var(--space-4);
}

.admin-aside__logo {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.admin-aside__nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-4);
  padding: 0 var(--space-2) var(--space-4);
}

.admin-aside__group-title {
  padding: var(--space-1) var(--space-3);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.admin-nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-radius: 10px;
  padding: var(--space-2) var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  transition: background-color var(--duration-base) var(--ease-out-soft);
  white-space: nowrap;
}

.admin-aside--collapsed .admin-nav-item {
  justify-content: center;
  padding-inline: 0;
}

.admin-nav-item:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.admin-nav-item--active {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.admin-nav-item__icon {
  font-size: 18px;
}

.admin-aside__foot {
  flex: none;
  padding: var(--space-2);
  border-top: var(--border-width) solid var(--c-border);
}

.admin-aside__collapse {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: var(--fs-12);
}

.admin-aside__collapse:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

/* ── 顶栏 ── */

.admin-header {
  position: sticky;
  top: 0;
  z-index: 20;
  border-bottom: var(--border-width) solid var(--c-border);
  background: var(--c-surface-glass);
  backdrop-filter: var(--blur-glass);
  -webkit-backdrop-filter: var(--blur-glass);
}

.admin-header__row {
  display: flex;
  height: 64px;
  align-items: center;
  gap: var(--space-3);
  padding-inline: var(--space-4);
}

.admin-header__crumbs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.admin-header__crumb--root {
  color: var(--c-text-3);
}

.admin-header__crumb {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-header__crumb-sep {
  color: var(--c-text-3);
}

.admin-header__search {
  display: none;
  width: 240px;
  margin-left: auto;
}

@media (min-width: 900px) {
  .admin-header__search {
    display: block;
  }
}

.admin-header__back {
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.admin-header__icon-btn,
.admin-header__account {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: 18px;
}

.admin-header__icon-btn {
  width: 32px;
  height: 32px;
}

.admin-header__account {
  margin-left: auto;
  padding: 2px;
  border-radius: 50%;
}

.admin-header__icon-btn:hover,
.admin-header__account:hover {
  background: var(--c-primary-soft);
}

/* ── 内容区 ── */

.admin-layout__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

/* 管理端内容区自适应，表格页最小 960px：横向滚动限制在内容区内，避免整页横滚（07 §2.2 / §9） */
.admin-layout__scroll {
  position: relative;
  z-index: 1;
  flex: 1;
  overflow-x: auto;
}

/* ── 抽屉（≤900px） ── */

.admin-layout__scrim {
  position: fixed;
  z-index: 35;
  inset: 0;
  background: var(--c-scrim);
}

@media (max-width: 900px) {
  .admin-aside {
    position: fixed;
    inset: 0 auto 0 0;
    width: 232px;
    transform: translateX(-100%);
    transition: transform var(--duration-route) var(--ease-out-soft);
    box-shadow: none;
  }

  .admin-aside--open {
    transform: none;
    box-shadow: var(--shadow-hover);
  }
}

/* 减少动态效果：抽屉瞬时开合 */
@media (prefers-reduced-motion: reduce) {
  .admin-aside {
    transition: none;
  }
}
</style>
