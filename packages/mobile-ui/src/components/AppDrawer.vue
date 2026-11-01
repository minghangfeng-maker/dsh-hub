<script setup lang="ts">
/**
 * 抽屉（§6.2）：搜索、最近会话、查看全部、头像（设置）、新建会话。
 * 会话列表跟随**当前后端**（§1.4 第 3 条），标题由 Hub 的 state(title) 投影更新。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { useBackendStore } from '@/stores/backend'
import { useCockpitStore } from '@/stores/cockpit'
import { longPress } from '@/lib/long-press'
import { hapticStrong } from '@/lib/platform'

const router = useRouter()
const ui = useUiStore()
const chat = useChatStore()
const auth = useAuthStore()
const backend = useBackendStore()
const cockpit = useCockpitStore()
const query = ref('')

const recent = computed(() => {
  const q = query.value.trim()
  const list = chat.sessions.filter(
    (s) => s.archived !== true && (!q || (s.title ?? '').includes(q)),
  )
  return list.slice(0, 8)
})

const backendName = computed(() => backend.selectedBackend?.name ?? '')

const avatarLetter = computed(() => {
  const name = auth.user?.displayName ?? auth.user?.username ?? 'D'
  return name.slice(0, 1).toUpperCase()
})

function go(path: string): void {
  ui.closeDrawer()
  void router.push(path)
}

function openConv(id: string): void {
  ui.closeDrawer()
  void chat.openSession(id)
  void router.push(`/c/${id}`)
}

/** 长按会话：重命名 / 归档（抽屉里就能操作，不用进「全部会话」）。 */
function openActions(conv: { sessionId: string; title: string | null }): void {
  void hapticStrong()
  ui.openSessionActions(conv.sessionId, conv.title ?? '')
}

function newChat(): void {
  ui.closeDrawer()
  chat.newSession()
  void router.push('/')
}
</script>

<template>
  <Transition name="fade">
    <div v-if="ui.drawerOpen" class="drawer-mask" @click="ui.closeDrawer()" />
  </Transition>
  <aside class="drawer" :class="{ 'is-open': ui.drawerOpen }" :aria-hidden="!ui.drawerOpen">
    <div class="drawer__search">
      <AppIcon name="search" :size="17" />
      <input v-model="query" type="search" placeholder="搜索会话" enterkeyhint="search" />
    </div>

    <div class="drawer__section-title">
      最近会话
      <span v-if="backendName" class="drawer__backend">{{ backendName }}</span>
    </div>
    <div class="drawer__recent">
      <button
        v-for="conv in recent"
        :key="conv.sessionId"
        class="drawer__conv"
        :class="{ 'is-current': conv.sessionId === chat.activeId }"
        type="button"
        v-on="longPress(() => openActions(conv))"
        @click="openConv(conv.sessionId)"
      >
        <span class="drawer__conv-line">
          <span class="drawer__conv-title">{{ conv.title || '新会话' }}</span>
          <!-- WP56d：座舱会话的发起人（接口给了才显示） -->
          <span v-if="cockpit.initiatorOf(conv)" class="drawer__who">{{
            cockpit.initiatorOf(conv)
          }}</span>
          <!-- WP46：Hub 暂存的未决提问/审批数（别的会话在等你回答） -->
          <span v-if="(conv.pendingInteractions ?? 0) > 0" class="conv-badge">待回答</span>
        </span>
      </button>
      <p v-if="recent.length === 0" class="drawer__empty">
        {{ query ? '没有匹配的会话' : chat.sessionsLoading ? '正在加载…' : '还没有历史会话' }}
      </p>
      <button class="drawer__conv" type="button" @click="go('/all')">
        <span class="drawer__conv-title" style="color: var(--text-2)">查看全部 ›</span>
      </button>
    </div>

    <div class="drawer__foot">
      <!-- 嵌入座舱（WP56d）：账号与设置页在座舱里不存在，两个入口一起隐藏 -->
      <template v-if="!cockpit.embed">
        <button class="drawer__avatar" type="button" aria-label="设置" @click="go('/settings')">
          {{ avatarLetter }}
        </button>
        <button
          class="icon-btn icon-btn--ghost"
          type="button"
          aria-label="设置"
          @click="go('/settings')"
        >
          <AppIcon name="gear" :size="19" />
        </button>
      </template>
      <button class="drawer__new" type="button" @click="newChat">
        <AppIcon name="plus" :size="15" />
        新建会话
      </button>
    </div>
  </aside>
</template>

<style scoped>
.drawer__who {
  flex: 0 0 auto;
  max-width: 92px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-3);
  font-size: 11px;
}
.drawer__backend {
  float: right;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
