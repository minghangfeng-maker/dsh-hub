<script setup lang="ts">
/** 全部会话：只列当前后端的会话（§1.4 第 3 条）。删除/重命名属于通道 v2，A2 再接。 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { longPress } from '@/lib/long-press'
import { hapticStrong } from '@/lib/platform'

const router = useRouter()
const chat = useChatStore()
const models = useModelsStore()
const ui = useUiStore()

const archivedEnabled = computed(() => models.features.includes('archive'))
const list = computed(() =>
  chat.sessions.filter((s) =>
    chat.showArchived ? s.archived === true : s.archived !== true,
  ),
)

function switchView(archived: boolean): void {
  if (archived === chat.showArchived) return
  chat.setShowArchived(archived)
}

function open(id: string): void {
  void chat.openSession(id)
  void router.push(`/c/${id}`)
}

/** 长按：重命名 / 归档（没有删除，DSH 没有这个接口）。 */
function openActions(conv: { sessionId: string; title: string | null }): void {
  void hapticStrong()
  ui.openSessionActions(conv.sessionId, conv.title ?? '')
}

function when(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__side">
      <button class="icon-btn" type="button" aria-label="返回" @click="router.back()">
        <AppIcon name="arrowLeft" />
      </button>
    </div>
    <div class="app-header__title">全部会话</div>
    <div class="app-header__side" />
  </header>

  <div class="page">
    <div v-if="archivedEnabled" class="page__seg session-tabs">
      <button :class="{ 'is-on': !chat.showArchived }" @click="switchView(false)">全部</button>
      <button :class="{ 'is-on': chat.showArchived }" @click="switchView(true)">已归档</button>
    </div>
    <p v-if="list.length === 0" class="empty">
      {{
        chat.sessionsLoading
          ? '正在加载会话…'
          : chat.showArchived
            ? '没有已归档的会话'
            : '还没有会话'
      }}
    </p>
    <div v-else class="page__group">
      <button
        v-for="conv in list"
        :key="conv.sessionId"
        class="conv-row"
        type="button"
        v-on="longPress(() => openActions(conv))"
        @click="open(conv.sessionId)"
      >
        <div class="conv-row__main">
          <div class="conv-row__title">
            {{ conv.title || '新会话' }}
            <!-- WP46：Hub 暂存的未决提问/审批数 -->
            <span v-if="(conv.pendingInteractions ?? 0) > 0" class="conv-row__badge">待回答</span>
          </div>
          <div class="conv-row__sub">
            {{ conv.blank ? '空白会话' : conv.running ? '正在运行' : '已结束' }} · {{ when(conv.updatedAt) }}
          </div>
        </div>
        <AppIcon name="chevronRight" :size="16" />
      </button>
    </div>
  </div>
</template>
