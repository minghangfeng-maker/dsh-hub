<script setup lang="ts">
/**
 * 重命名会话（0.4.0 §1.2 第 2 条）：居中对话框 = 输入框 + 取消 / 保存。
 *
 * 保存走 `chat.renameSession`（乐观更新 + 失败回滚 + toast 都在 store 里），
 * 这里只负责：预填服务端原始标题、空标题禁用保存、成功关框、Enter/Esc 快捷键。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppDialog from './AppDialog.vue'
import { useSessionActions } from '@/composables/use-session-actions'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import { hapticTap } from '@/lib/platform'

const ui = useUiStore()
const chat = useChatStore()
const actions = useSessionActions()

const draft = ref('')
const saving = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

const open = computed(() => ui.renameDialogOpen)
const canSave = computed(() => !saving.value && draft.value.trim().length > 0)

function cancel(): void {
  if (saving.value) return
  ui.closeRenameDialog()
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  const ok = await actions.rename(draft.value)
  saving.value = false
  if (ok) void hapticTap()
}

watch(
  open,
  (next) => {
    saving.value = false
    if (!next) {
      draft.value = ''
      return
    }
    // 编辑用服务端原始标题：空标题就该是空输入（保存按钮禁用），不要预填「新会话」。
    draft.value = chat.activeSession?.title ?? ''
    void nextTick(() => {
      inputEl.value?.focus()
      inputEl.value?.select()
    })
  },
  { immediate: true },
)
</script>

<template>
  <AppDialog :open="open" label="重命名" @close="cancel">
    <p class="dialog__title">重命名会话</p>
    <input
      ref="inputEl"
      v-model="draft"
      class="dialog__input"
      type="text"
      maxlength="200"
      placeholder="会话标题"
      aria-label="会话标题"
      enterkeyhint="done"
      @keyup.enter="save"
      @keyup.esc="cancel"
    />
    <div class="dialog__actions">
      <button class="dialog__btn dialog__btn--ghost" type="button" @click="cancel">取消</button>
      <button
        class="dialog__btn dialog__btn--primary"
        type="button"
        :disabled="!canSave"
        @click="save"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
  </AppDialog>
</template>

<style scoped>
.dialog__title {
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.dialog__input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 15px;
}
.dialog__input:focus {
  border-color: var(--accent);
  background: var(--surface);
}
.dialog__actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.dialog__btn {
  flex: 1;
  height: 42px;
  border-radius: 12px;
  font-size: 14.5px;
  font-weight: 600;
  transition: background-color 0.14s ease, opacity 0.14s ease;
}
.dialog__btn--ghost {
  background: var(--surface-2);
  color: var(--text-2);
}
.dialog__btn--ghost:active {
  background: var(--surface-3);
}
.dialog__btn--primary {
  background: var(--btn);
  color: var(--btn-ink);
}
.dialog__btn--primary[disabled] {
  opacity: 0.4;
}
</style>
