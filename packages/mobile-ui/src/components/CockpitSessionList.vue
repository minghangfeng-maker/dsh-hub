<script setup lang="ts">
/**
 * 座舱的会话列表（WP58 / docs/26 §3.3）：`docked`（常驻左栏）与 `menu`（航行日志下拉）**同一份行**。
 *
 * 两种形态的差别只有外面那层壳（常驻栏 / 下拉面板），行本身的规则一样：
 *  - 标题 / 发起人 / 相对时间（今天只显示时分，其它天显示月-日，等宽数字）；
 *  - 鼠标悬停（或键盘聚焦）时右侧出「⋯」菜单：**重命名 / 删除**，替代手机上的长按；
 *  - 重命名是行内输入框（Enter 保存、Esc 取消）；删除要二次确认。
 *
 * 说明：DSH 没有「删除会话」接口，删除 = 归档（`chat.archiveSession(id, true)`），
 * 与 App 既有的 ⋮ 菜单同一个动作，toast 也说「已归档」——这里只是把入口放在会话行上。
 */
import { computed, nextTick, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useCockpitStore } from '@/stores/cockpit'
import { useModelsStore } from '@/stores/models'

const props = withDefaults(
  defineProps<{
    /** `rail` = 常驻左栏，`menu` = 下拉面板（只影响排版） */
    variant?: 'rail' | 'menu'
  }>(),
  { variant: 'menu' },
)

const chat = useChatStore()
const cockpit = useCockpitStore()
const models = useModelsStore()

const rows = computed(() => chat.sessions.filter((session) => session.archived !== true))
const canRename = computed(() => models.features.includes('rename'))
const canDelete = computed(() => models.features.includes('archive'))

/** 打开着「⋯」菜单的会话 id（一次只开一个）。 */
const menuFor = ref<string | null>(null)
/** 正在重命名的会话 id 与草稿。 */
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const renameInputEl = ref<HTMLInputElement | null>(null)
/** 行内输入框是 `v-for` 里的 ref：用函数 ref 拿单个元素（ref 字符串在 v-for 里是数组）。 */
function bindRenameInput(el: unknown): void {
  renameInputEl.value = (el as HTMLInputElement | null) ?? null
}
/** 等着确认删除的会话 id。 */
const confirming = ref<string | null>(null)
const busy = ref(false)

function updatedText(value: unknown): string {
  const at = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  const now = new Date()
  const pad = (input: number): string => String(input).padStart(2, '0')
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameHead = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? sameHead : `${String(date.getFullYear())}-${sameHead}`
}

function pick(sessionId: string): void {
  if (renaming.value !== null || confirming.value !== null) return
  menuFor.value = null
  if (props.variant === 'rail') void cockpit.focusSession(sessionId)
  else void cockpit.openSessionFromLog(sessionId)
}

function toggleMenu(sessionId: string, event: MouseEvent): void {
  event.stopPropagation()
  confirming.value = null
  menuFor.value = menuFor.value === sessionId ? null : sessionId
}

function startRename(sessionId: string, title: string): void {
  if (!canRename.value) return
  menuFor.value = null
  confirming.value = null
  renaming.value = sessionId
  renameDraft.value = title
  void nextTick(() => {
    renameInputEl.value?.focus()
    renameInputEl.value?.select()
  })
}

function cancelRename(): void {
  renaming.value = null
  renameDraft.value = ''
}

async function saveRename(): Promise<void> {
  const sessionId = renaming.value
  if (sessionId === null || busy.value) return
  const title = renameDraft.value.trim()
  if (title === '') {
    cancelRename()
    return
  }
  busy.value = true
  try {
    // 失败会 toast（store 里），输入框留着让用户改
    const ok = await chat.renameSession(sessionId, title)
    if (ok) cancelRename()
  } finally {
    busy.value = false
  }
}

function askDelete(sessionId: string): void {
  if (!canDelete.value) return
  menuFor.value = null
  renaming.value = null
  confirming.value = confirming.value === sessionId ? null : sessionId
}

function cancelDelete(): void {
  confirming.value = null
}

async function doDelete(sessionId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await chat.archiveSession(sessionId, true)
    confirming.value = null
    // 归档的是当前会话时 store 会自己开一个新会话；这里只需把路由留在座舱里
    if (chat.activeId === null) void cockpit.newSessionFromLog()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="session-list" :class="`session-list--${variant}`" data-testid="cockpit-session-list">
    <div
      v-for="session in rows"
      :key="session.sessionId"
      class="session-row"
      :class="{ 'is-current': session.sessionId === chat.activeId, 'is-editing': renaming === session.sessionId }"
      data-session-row
    >
      <!-- 重命名：行内输入框（Enter 保存 / Esc 取消） -->
      <form
        v-if="renaming === session.sessionId"
        class="session-row__edit"
        @submit.prevent="saveRename()"
      >
        <input
          :ref="bindRenameInput"
          v-model="renameDraft"
          class="session-row__input"
          type="text"
          :aria-label="`重命名会话 ${session.title || '新会话'}`"
          autocomplete="off"
          @keydown.esc.prevent="cancelRename()"
        />
        <button class="session-row__ok" type="submit" :disabled="busy" aria-label="保存">
          <AppIcon name="check" :size="14" />
        </button>
        <button class="session-row__ok" type="button" aria-label="取消" @click="cancelRename()">
          <AppIcon name="close" :size="13" />
        </button>
      </form>

      <!-- 删除：二次确认（DSH 没有删除接口，实际是归档） -->
      <div v-else-if="confirming === session.sessionId" class="session-row__confirm">
        <span class="session-row__confirm-text">删除「{{ session.title || '新会话' }}」？</span>
        <button class="session-row__danger" type="button" :disabled="busy" @click="doDelete(session.sessionId)">
          删除
        </button>
        <button class="session-row__ok" type="button" @click="cancelDelete()">取消</button>
      </div>

      <template v-else>
        <button
          class="session-row__main"
          type="button"
          :data-session-id="session.sessionId"
          :aria-label="session.title || '新会话'"
          :aria-current="session.sessionId === chat.activeId ? 'true' : undefined"
          @click="pick(session.sessionId)"
        >
          <span class="session-row__title">{{ session.title || '新会话' }}</span>
          <span class="session-row__sub">
            <span v-if="cockpit.initiatorOf(session)" class="session-row__who">
              {{ cockpit.initiatorOf(session) }}
            </span>
            <span v-if="(session.pendingInteractions ?? 0) > 0" class="conv-badge">待回答</span>
            <span class="session-row__time">{{ updatedText(session.updatedAt) }}</span>
          </span>
        </button>
        <button
          class="session-row__more"
          type="button"
          :aria-label="`${session.title || '新会话'}：更多操作`"
          :aria-expanded="menuFor === session.sessionId"
          data-session-more
          @click="toggleMenu(session.sessionId, $event)"
        >
          <AppIcon name="more" :size="16" />
        </button>
        <div v-if="menuFor === session.sessionId" class="session-row__menu" role="menu">
          <button
            class="session-row__item"
            type="button"
            role="menuitem"
            :disabled="!canRename"
            :title="canRename ? undefined : '当前 Hub 不支持重命名'"
            data-session-action="rename"
            @click="startRename(session.sessionId, session.title ?? '')"
          >
            重命名
          </button>
          <button
            class="session-row__item session-row__item--danger"
            type="button"
            role="menuitem"
            :disabled="!canDelete"
            :title="canDelete ? undefined : '当前 Hub 不支持删除'"
            data-session-action="delete"
            @click="askDelete(session.sessionId)"
          >
            删除
          </button>
        </div>
      </template>
    </div>
    <p v-if="rows.length === 0" class="session-list__empty">
      {{ chat.sessionsLoading ? '正在加载…' : '还没有会话' }}
    </p>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
}
.session-row {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 8px;
  min-width: 0;
}
.session-row:hover {
  background: var(--surface-2);
}
.session-row.is-current {
  background: var(--surface-3);
}
.session-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  text-align: left;
  color: var(--text);
}
.session-row__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  line-height: 1.4;
}
.session-row.is-current .session-row__title {
  font-weight: 600;
}
.session-row__sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-3);
  font-size: 11px;
}
.session-row__who {
  max-width: 96px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.session-row__time {
  margin-left: auto;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
/* 「⋯」：悬停 / 键盘聚焦时才出现（替代长按） */
.session-row__more {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-right: 2px;
  border-radius: 6px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.12s ease, background-color 0.12s ease;
}
.session-row:hover .session-row__more,
.session-row__more:focus-visible,
.session-row__more[aria-expanded='true'] {
  opacity: 1;
}
.session-row__more:hover {
  background: var(--surface-3);
  color: var(--text);
}
.session-row__menu {
  position: absolute;
  z-index: 25;
  right: 4px;
  top: calc(100% - 2px);
  min-width: 112px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: #ffffff;
  box-shadow: var(--shadow-float);
}
.session-row__item {
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
}
.session-row__item:hover:not(:disabled) {
  background: var(--surface-2);
}
.session-row__item:disabled {
  color: var(--text-3);
  opacity: 0.55;
  cursor: not-allowed;
}
.session-row__item--danger {
  color: var(--danger);
}
/* 行内重命名 / 删除确认 */
.session-row__edit,
.session-row__confirm {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 6px;
}
.session-row__input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: #ffffff;
  color: var(--text);
  font-size: 13px;
}
.session-row__confirm-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-2);
  font-size: 12px;
}
.session-row__ok,
.session-row__danger {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  min-width: 24px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
}
.session-row__danger {
  background: rgba(214, 81, 58, 0.12);
  color: var(--danger);
  font-weight: 600;
}
.session-list__empty {
  padding: 8px;
  color: var(--text-3);
  font-size: 12.5px;
}
</style>
