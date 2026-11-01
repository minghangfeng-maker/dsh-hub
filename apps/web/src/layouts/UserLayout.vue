<script setup lang="ts">
import { useWindowScroll } from '@vueuse/core'
import { NButton, NDropdown, NPopover, type DropdownOption } from 'naive-ui'
import { computed, h, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import AvatarImg from '@/components/base/AvatarImg.vue'
import BrandMark from '@/components/base/BrandMark.vue'
import MobileWebBar from '@/components/base/MobileWebBar.vue'
import WaterBackdrop from '@/components/base/WaterBackdrop.vue'
import { useRelayStatus } from '@/composables/useRelayStatus'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 用户端外壳（07 §4）：底部固定的淡水波背景 + 顶部玻璃导航条（高 64，滚动后出现细阴影）、
 * 右侧公告铃铛 + 头像下拉（个人中心 / 管理后台[管理员] / 退出）、1120px 居中内容区、极简页脚。
 *
 * 「积分与用量」（12 §10）只有中转站开通时才出现。
 */
const auth = useAuthStore()
const site = useSiteStore()
const router = useRouter()
const { relayEnabled, loadRelayStatus } = useRelayStatus()

const { y } = useWindowScroll()
const scrolled = computed(() => y.value > 4)

onMounted(() => {
  void site.load()
  void auth.ensureLoaded()
  void loadRelayStatus()
})

const navItems = computed(() => {
  const items = [
    { label: '我的工作台', to: '/home', icon: 'i-ph-house' },
    { label: '个人中心', to: '/me', icon: 'i-ph-user' },
  ]
  if (relayEnabled.value) {
    items.splice(1, 0, { label: '积分与用量', to: '/usage', icon: 'i-ph-arrows-left-right' })
  }
  return items
})

/** 下拉菜单图标用渲染函数（Naive 的 MenuOption.icon 只接受 VNode） */
const iconOf = (className: string) => () => h('span', { class: className })

const accountOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [{ key: 'me', label: '个人中心', icon: iconOf('i-ph-user') }]
  if (auth.isAdmin) options.push({ key: 'admin', label: '管理后台', icon: iconOf('i-ph-shield-star') })
  options.push({ key: 'logout', label: '退出登录', icon: iconOf('i-ph-sign-out') })
  return options
})

/** 公告配色随 `announcementLevel`（04 §1）。 */
const announcementStyle = computed(() => {
  switch (site.site.announcementLevel) {
    case 'success':
      return { borderColor: 'var(--c-success)', background: 'var(--c-success-soft)' }
    case 'warning':
      return { borderColor: 'var(--c-warning)', background: 'var(--c-butter-soft)' }
    case 'error':
      return { borderColor: 'var(--c-danger)', background: 'var(--c-danger-soft)' }
    default:
      return { borderColor: 'var(--c-sky)', background: 'var(--c-sky-soft)' }
  }
})

async function onAccountSelect(key: string): Promise<void> {
  if (key === 'me') await router.push('/me')
  else if (key === 'admin') await router.push('/admin/overview')
  else if (key === 'logout') {
    await auth.logout()
    await router.push('/login')
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <WaterBackdrop variant="calm" />

    <!-- WP54c：手机 UA 停在电脑版（`hub_view=desktop`）时，顶部给一条回手机网页版的路 -->
    <MobileWebBar kind="switch" />

    <header class="user-header" :class="{ 'user-header--scrolled': scrolled }">
      <div class="hub-container flex h-16 items-center gap-3 md:gap-6">
        <RouterLink to="/home" class="user-header__logo">
          <BrandMark :size="26" />
          <span class="user-header__logo-text">{{ site.site.name }}</span>
        </RouterLink>

        <nav class="flex items-center gap-1" aria-label="主导航">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="hub-nav-item"
            active-class="hub-nav-item-active"
            :aria-label="item.label"
            :title="item.label"
          >
            <span :class="item.icon" class="user-header__nav-icon" aria-hidden="true" />
            <span class="user-header__nav-label">{{ item.label }}</span>
          </RouterLink>
        </nav>

        <div class="ml-auto flex items-center gap-2">
          <NPopover v-if="site.announcementVisible" trigger="click" placement="bottom-end" :width="300">
            <template #trigger>
              <NButton quaternary circle aria-label="查看公告">
                <template #icon>
                  <span class="i-ph-bell relative" aria-hidden="true">
                    <span class="user-header__bell-dot" />
                  </span>
                </template>
              </NButton>
            </template>

            <div class="user-header__announcement" :style="announcementStyle">
              <p class="font-semibold">站点公告</p>
              <p class="mt-1 whitespace-pre-wrap">{{ site.site.announcement }}</p>
              <NButton size="tiny" quaternary class="mt-2" @click="site.dismissAnnouncement()">
                知道了，不再提示
              </NButton>
            </div>
          </NPopover>

          <NDropdown :options="accountOptions" trigger="click" @select="onAccountSelect">
            <button
              type="button"
              class="user-header__account press"
              :aria-label="`账号菜单：${auth.displayName}`"
            >
              <AvatarImg
                :src="auth.avatarUrl"
                :name="auth.displayName"
                :seed="auth.user?.slug"
                :size="32"
                bordered
              />
              <span class="user-header__account-name" :title="auth.displayName">{{ auth.displayName || '未登录' }}</span>
              <span class="i-ph-caret-down text-[12px] text-3" aria-hidden="true" />
            </button>
          </NDropdown>
        </div>
      </div>
    </header>

    <main class="hub-container relative z-1 flex-1 py-6 md:py-8">
      <slot />
    </main>

    <footer class="hub-container relative z-1 pb-8 text-center text-[12px] text-3">
      {{ site.site.name }} · 数据留在自己的机器上
    </footer>
  </div>
</template>

<style scoped>
.user-header {
  position: sticky;
  top: 0;
  z-index: 20;
  border-bottom: var(--border-width) solid transparent;
  background: var(--c-surface-glass);
  backdrop-filter: var(--blur-glass);
  -webkit-backdrop-filter: var(--blur-glass);
  transition:
    box-shadow var(--duration-base) var(--ease-out-soft),
    border-color var(--duration-base) var(--ease-out-soft);
}

/* 滚动后出现细阴影（07 §4） */
.user-header--scrolled {
  border-bottom-color: var(--c-border);
  box-shadow: var(--shadow-header);
}

.user-header__logo {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

/* 手机宽度只有图标（390px 放不下三个中文标签），宽屏才带文字 */
.user-header__nav-icon {
  font-size: 17px;
}

.user-header__nav-label {
  display: none;
}

.user-header__logo-text {
  display: none;
}

@media (min-width: 640px) {
  .user-header__nav-icon {
    margin-right: 4px;
    font-size: 15px;
  }

  .user-header__nav-label {
    display: inline;
  }

  .user-header__logo-text {
    display: inline;
  }
}

.user-header__bell-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--c-surface);
  border-radius: 50%;
  background: var(--c-sakura);
}

.user-header__announcement {
  padding: var(--space-3);
  border-left: 3px solid var(--c-sky);
  border-radius: var(--radius-control);
  color: var(--c-text);
  font-size: var(--fs-13);
}

.user-header__account {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  cursor: pointer;
}

.user-header__account:hover {
  background: var(--c-primary-soft);
}

.user-header__account-name {
  display: none;
  max-width: 120px;
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (min-width: 640px) {
  .user-header__account-name {
    display: inline;
  }
}
</style>
