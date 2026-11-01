<script setup lang="ts">
/**
 * 控制台主题的「回形针」（WP58 / docs/26 §3.2）：「+」换成回形针图标，点开**小菜单**
 * （上传文件 / 上传图片），不再弹手机的底部抽屉（PlusSheet）。
 *
 * 拖文件进输入框的入口在 Composer（`drop` 落在整张输入卡上），两条路都汇到
 * `chat.addAttachment` —— 与 PlusSheet / APK 产出的附件结构完全一致（`lib/media.ts`）。
 *
 * 两个 `<input type=file>` **常驻 DOM**（菜单是 v-if，选文件前菜单已经关了），
 * e2e 用 `data-console-pick="file|image"` 定位。
 */
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { PICK_INPUT_ATTRS, pickFromInputElement } from '@/lib/media'

const ui = useUiStore()
const chat = useChatStore()

const open = ref(false)
const busy = ref(false)
const imageInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

async function run(kind: 'image' | 'file'): Promise<void> {
  if (busy.value) return
  close()
  const input = kind === 'image' ? imageInput.value : fileInput.value
  if (!input) return
  try {
    input.value = ''
  } catch {
    /* ignore */
  }
  input.click()
}

async function onPicked(kind: 'image' | 'file', event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  busy.value = true
  try {
    const picked = await pickFromInputElement(input, kind === 'image' ? 'gallery' : 'file')
    for (const item of picked) {
      const ok = chat.addAttachment(item)
      if (!ok && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ui.toast(`没能读取这个文件：${message}`, 2600)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="attach" data-testid="console-attach">
    <button
      class="attach__btn"
      type="button"
      aria-label="添加附件"
      :aria-expanded="open"
      @click="toggle"
    >
      <AppIcon name="paperclip" :size="17" />
    </button>
    <div v-if="open" class="attach__mask" @click="close" />
    <div v-if="open" class="attach__menu" role="menu" aria-label="添加附件">
      <button class="attach__item" type="button" role="menuitem" @click="run('file')">
        <AppIcon name="file" :size="15" />
        上传文件
      </button>
      <button class="attach__item" type="button" role="menuitem" @click="run('image')">
        <AppIcon name="image" :size="15" />
        上传图片
      </button>
    </div>
    <!-- 隐藏选择器：常驻 DOM（选文件时菜单已经关闭） -->
    <input
      ref="imageInput"
      class="attach__input"
      type="file"
      data-console-pick="image"
      :accept="PICK_INPUT_ATTRS.gallery.accept"
      :multiple="PICK_INPUT_ATTRS.gallery.multiple"
      @change="onPicked('image', $event)"
    />
    <input
      ref="fileInput"
      class="attach__input"
      type="file"
      data-console-pick="file"
      :accept="PICK_INPUT_ATTRS.file.accept"
      :multiple="PICK_INPUT_ATTRS.file.multiple"
      @change="onPicked('file', $event)"
    />
  </div>
</template>

<style scoped>
.attach {
  position: relative;
  flex: 0 0 auto;
}
.attach__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--text-2);
  transition: background-color 0.12s ease, color 0.12s ease;
}
.attach__btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
/* 遮罩只吃点击（透明）：菜单外的任何地方点一下都关 */
.attach__mask {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: transparent;
}
.attach__menu {
  position: absolute;
  z-index: 21;
  left: 0;
  bottom: calc(100% + 8px);
  min-width: 148px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: #ffffff;
  box-shadow: var(--shadow-float);
}
.attach__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
}
.attach__item:hover {
  background: var(--surface-2);
}
.attach__input {
  display: none;
}
</style>
