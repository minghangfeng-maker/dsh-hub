<script setup lang="ts">
/**
 * ⋮ 会话菜单（0.4.0 §1.2）：锚定在右上角、从上向下展开的小卡片。
 *
 * 菜单项从上到下：标题（灰字、单行省略、不可点）→ 重命名 / Token 用量 / 连接诊断 / 归档。
 * 点遮罩、按返回键（`ui.consumeOverlay`）、选中任一项后关闭。
 * 归档走二次确认（居中对话框），成功后回首页并 toast「已归档」（store 里发）。
 *
 * 判断逻辑全在 `lib/session-menu.ts` 与 `lib/session-actions.ts`（可单测），
 * 这里只做渲染与把点击接到 store。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from './AppDialog.vue'
import AppIcon from './AppIcon.vue'
import RenameDialog from './RenameDialog.vue'
import { buildSessionMenuItems, archiveConfirmText, sessionMenuTitle, sessionMenuHint } from '@/lib/session-menu'
import type { SessionMenuItem } from '@/lib/session-menu'
import { useSessionActions } from '@/composables/use-session-actions'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { hapticTap } from '@/lib/platform'

const ui = useUiStore()
const chat = useChatStore()
const models = useModelsStore()
const actions = useSessionActions()

const archiving = ref(false)

const open = computed(() => ui.sessionMenuOpen)
const items = computed<SessionMenuItem[]>(() =>
  buildSessionMenuItems({
    hasSession: chat.activeId !== null,
    title: chat.activeSession?.title ?? null,
    canRename: models.features.includes('rename'),
    canArchive: models.features.includes('archive'),
  }),
)
const title = computed(() => sessionMenuTitle(chat.activeSession?.title ?? null))
const hint = computed(() =>
  sessionMenuHint({
    hasSession: chat.activeId !== null,
    title: chat.activeSession?.title ?? null,
    canRename: models.features.includes('rename'),
    canArchive: models.features.includes('archive'),
  }),
)

function close(): void {
  ui.closeSessionMenu()
}

function onItem(item: SessionMenuItem): void {
  if (item.disabled) return
  void hapticTap()
  switch (item.id) {
    case 'rename':
      ui.openRenameDialog()
      return
    case 'usage':
      actions.openUsage()
      return
    case 'diagnostics':
      actions.openDiagnostics()
      return
    case 'archive':
      ui.openArchiveConfirm()
      return
  }
}

async function confirmArchive(): Promise<void> {
  if (archiving.value) return
  archiving.value = true
  await actions.archive()
  archiving.value = false
}

watch(
  () => ui.archiveConfirmOpen,
  (next) => {
    if (!next) archiving.value = false
  },
)
</script>

<template>
  <!-- 透明遮罩：点页面任意处关菜单（不压暗当前对话，参照 Claude）。 -->
  <Transition name="menu-fade">
    <div v-if="open" class="session-menu__mask" @click="close" />
  </Transition>
  <Transition name="menu-pop">
    <div v-if="open" class="session-menu" role="menu" aria-label="会话菜单">
      <p class="session-menu__title">{{ title }}</p>
      <button
        v-for="item in items"
        :key="item.id"
        class="session-menu__item"
        :class="{ 'is-danger': item.danger }"
        type="button"
        role="menuitem"
        :data-action="item.id"
        :disabled="item.disabled"
        @click="onItem(item)"
      >
        <!-- 每项左侧 20px 线性图标（§1.2 打磨）；红色项图标跟随文字一起变红 -->
        <AppIcon class="session-menu__icon" :name="item.icon" :size="20" />
        <span class="session-menu__label">{{ item.label }}</span>
      </button>
      <p v-if="hint" class="session-menu__hint">{{ hint }}</p>
    </div>
  </Transition>

  <!-- 归档二次确认：居中对话框，「归档」用红色（破坏性动作） -->
  <AppDialog :open="ui.archiveConfirmOpen" label="归档会话" @close="ui.closeArchiveConfirm()">
    <p class="confirm__title">归档这个会话？</p>
    <p class="confirm__text">{{ archiveConfirmText(chat.activeSession?.title ?? null) }}</p>
    <div class="confirm__actions">
      <button class="confirm__btn confirm__btn--ghost" type="button" @click="ui.closeArchiveConfirm()">
        取消
      </button>
      <button
        class="confirm__btn confirm__btn--danger"
        type="button"
        :disabled="archiving"
        @click="confirmArchive"
      >
        <AppIcon v-if="!archiving" name="archive" :size="16" />
        {{ archiving ? '归档中…' : '归档' }}
      </button>
    </div>
  </AppDialog>

  <RenameDialog />
</template>

<style scoped>
.session-menu__mask {
  position: fixed;
  inset: 0;
  z-index: 54;
  background: transparent;
}
.session-menu {
  position: fixed;
  top: calc(var(--safe-top) + 52px);
  right: 8px;
  z-index: 55;
  width: 220px;
  padding: 6px;
  border-radius: 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-float);
  transform-origin: top right;
}
/* 160ms：scale 0.92 → 1 + 淡入（§1.2，锚点在右上角） */
.menu-pop-enter-active,
.menu-pop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s cubic-bezier(0.32, 0.72, 0, 1);
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.16s ease;
}
.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
}

.session-menu__title {
  margin: 0;
  padding: 9px 12px 7px;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-menu__item {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  /* 52px 行高 + 20px 图标 + 16px 图标与文字的间距（§1.2 打磨，参照 Claude 菜单） */
  height: 52px;
  padding: 0 14px;
  border-radius: 12px;
  font-size: 15.5px;
  color: var(--text);
  text-align: left;
  transition: background-color 0.12s ease, opacity 0.12s ease;
}
.session-menu__icon {
  flex: 0 0 auto;
  color: var(--text-2);
}
.session-menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-menu__item:active {
  background: var(--surface-2);
}
/* 归档：图标与文字同为红色（`currentColor` 同时驱动 stroke 与文字颜色） */
.session-menu__item.is-danger,
.session-menu__item.is-danger .session-menu__icon {
  color: var(--danger);
}
.session-menu__item[disabled] {
  color: var(--text-3);
  opacity: 0.55;
}
.session-menu__item[disabled] .session-menu__icon {
  color: var(--text-3);
}
.session-menu__item[disabled]:active {
  background: none;
}
.session-menu__hint {
  margin: 2px 0 0;
  padding: 4px 12px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
}

.confirm__title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.confirm__text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-2);
}
.confirm__actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.confirm__btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  border-radius: 12px;
  font-size: 14.5px;
  font-weight: 600;
  transition: background-color 0.14s ease, opacity 0.14s ease;
}
.confirm__btn--ghost {
  background: var(--surface-2);
  color: var(--text-2);
}
.confirm__btn--ghost:active {
  background: var(--surface-3);
}
.confirm__btn--danger {
  background: var(--danger);
  color: #fff;
}
.confirm__btn--danger[disabled] {
  opacity: 0.5;
}
</style>
