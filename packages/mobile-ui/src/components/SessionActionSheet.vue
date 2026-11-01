<script setup lang="ts">
/**
 * 会话长按菜单：重命名 / 归档（§1.4 / M5 §10）。
 *
 * **没有删除**：DSH 没有会话删除接口，契约明确要求「隐藏，不伪造」（M5 §10 / §17 D5）。
 * 归档只是从列表里隐藏，会话仍在容器里；归档运行中的会话会回 `agent-busy`，原样提示。
 */
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'

const ui = useUiStore()
const chat = useChatStore()
const models = useModelsStore()

const mode = ref<'menu' | 'rename'>('menu')
const draft = ref('')
const busy = ref(false)
const canRename = computed(() => models.features.includes('rename'))
const canArchive = computed(() => models.features.includes('archive'))
const target = computed(() => ui.sessionAction)
const archived = computed(() =>
  target.value ? chat.sessions.find((s) => s.sessionId === target.value?.sessionId)?.archived === true : false,
)

watch(
  () => ui.sessionAction,
  (next) => {
    mode.value = 'menu'
    draft.value = next?.title ?? ''
    busy.value = false
  },
)

function close(): void {
  ui.closeSessionActions()
}

async function rename(): Promise<void> {
  const current = target.value
  if (!current || busy.value) return
  const title = draft.value.trim()
  if (!title) return
  busy.value = true
  const ok = await chat.renameSession(current.sessionId, title)
  busy.value = false
  if (ok) close()
}

async function archive(): Promise<void> {
  const current = target.value
  if (!current || busy.value) return
  busy.value = true
  const ok = await chat.archiveSession(current.sessionId, !archived.value)
  busy.value = false
  if (ok) close()
}
</script>

<template>
  <Transition name="fade">
    <div v-if="target" class="sheet-mask" @click="close" />
  </Transition>
  <Transition name="slide">
    <div v-if="target" class="sheet" role="dialog" aria-label="会话操作">
      <div class="sheet__grip" />
      <template v-if="mode === 'menu'">
        <p class="sheet__title">{{ target.title || '新会话' }}</p>
        <button v-if="canRename" class="sheet__item" type="button" @click="mode = 'rename'">
          <AppIcon name="pencil" :size="18" /><span>重命名</span>
          <AppIcon name="chevronRight" :size="16" />
        </button>
        <button v-if="canArchive" class="sheet__item" type="button" :disabled="busy" @click="archive">
          <AppIcon name="archive" :size="18" />
          <span>{{ archived ? '取消归档' : '归档' }}</span>
        </button>
        <p v-if="!canRename && !canArchive" class="sheet__empty">
          当前后端不支持重命名与归档
        </p>
      </template>

      <template v-else>
        <p class="sheet__title">重命名会话</p>
        <input
          v-model="draft"
          class="sheet__input"
          type="text"
          maxlength="200"
          placeholder="会话标题"
          @keyup.enter="rename"
        />
        <div class="sheet__actions">
          <button class="sheet__cancel" type="button" @click="mode = 'menu'">返回</button>
          <button class="sheet__confirm" type="button" :disabled="busy || !draft.trim()" @click="rename">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.sheet__empty {
  font-size: 12.5px;
  color: var(--text-3);
  padding: 2px 10px 6px;
}
.sheet__input {
  width: calc(100% - 20px);
  margin: 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
}
.sheet__actions {
  display: flex;
  gap: 8px;
  padding: 10px;
}
.sheet__cancel,
.sheet__confirm {
  flex: 1;
  padding: 10px;
  border-radius: 10px;
  font-size: 13.5px;
  font-weight: 600;
}
.sheet__cancel {
  background: var(--surface-2);
  color: var(--text-2);
}
.sheet__confirm {
  background: var(--text);
  color: var(--bg);
}
.sheet__confirm[disabled] {
  opacity: 0.4;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1);
}
.slide-enter-from,
.slide-leave-to {
  transform: translateY(100%);
}
</style>
