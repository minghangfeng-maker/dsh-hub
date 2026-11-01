<script setup lang="ts">
/**
 * 「+」弹层：相机 / 相册 / 文件（§1.4 第 6 条）。
 *
 * 三个入口都真能用：
 *  - 相机：原生走 `@capacitor/camera`；**网页版（WP54 / W3）**用隐藏
 *    `<input type=file accept="image/*" capture="environment">`（手机浏览器直接开后置摄像头）；
 *  - 相册 / 文件：`<input type=file>`（WebView 里能拉起系统选择器）；
 *    网页版相册带 `multiple`，一次可以选多张；
 *  - 图片在 App 端压到长边 ≤2048px、≤5MiB 再上传；超限会直接提示（见 lib/media.ts）。
 *
 * 三个 `<input>` 必须**常驻 DOM**（弹层是 `v-if`，选完文件前弹层已经关了）：
 * 点按钮只是 `input.click()`，真正的文件在 `change` 事件里读（`pickFromInputElement`）。
 * 同时它们也是 e2e 的落点（`data-pick-input="camera|gallery|file"`）。
 */
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import {
  PICK_INPUT_ATTRS,
  isBrowserRuntime,
  pickFromCamera,
  pickFromInputElement,
  type PickKind,
} from '@/lib/media'

const ui = useUiStore()
const chat = useChatStore()
const busy = ref<'' | PickKind>('')

const cameraInput = ref<HTMLInputElement | null>(null)
const galleryInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

/** 三个隐藏输入框（模板里用 attrs 渲染，见下方 PICK_INPUT_ATTRS）。 */
const inputRefs: Record<PickKind, typeof cameraInput> = {
  camera: cameraInput,
  gallery: galleryInput,
  file: fileInput,
}

/** 原生相机：`@capacitor/camera`（网页版永远走隐藏 input）。 */
async function pickNativeCamera(): Promise<void> {
  try {
    const picked = await pickFromCamera()
    if (picked) addOne(picked)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 用户取消选择器时插件会抛 "User cancelled photos app" 之类的错误：不打扰。
    if (!/cancel|cancelled|取消/i.test(message)) ui.toast(`没能读取这个文件：${message}`, 2600)
  }
}

/** 把选到的附件逐个加进托盘（超限/被拒绝的把预览 URL 释放掉）。 */
function addOne(picked: Parameters<typeof chat.addAttachment>[0]): void {
  const ok = chat.addAttachment(picked)
  if (!ok && picked.previewUrl) URL.revokeObjectURL(picked.previewUrl)
}

async function run(kind: PickKind): Promise<void> {
  if (busy.value) return
  ui.closePlusSheet()
  if (kind === 'camera' && !isBrowserRuntime()) {
    busy.value = kind
    try {
      await pickNativeCamera()
    } finally {
      busy.value = ''
    }
    return
  }
  const input = inputRefs[kind].value
  if (!input) return
  // 清空 value：同一张照片选第二次也要触发 change
  try {
    input.value = ''
  } catch {
    /* ignore */
  }
  input.click()
}

/** `change`：读文件 → 压缩 → 进附件链（与 APK 产出的数据结构完全一致）。 */
async function onPicked(kind: PickKind, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  if (!input) return
  busy.value = kind
  try {
    const picked = await pickFromInputElement(input, kind)
    for (const item of picked) addOne(item)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ui.toast(`没能读取这个文件：${message}`, 2600)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="ui.plusSheetOpen" class="sheet-mask" @click="ui.closePlusSheet()" />
  </Transition>
  <Transition name="slide">
    <div v-if="ui.plusSheetOpen" class="sheet" role="dialog" aria-label="添加附件">
      <div class="sheet__grip" />
      <p class="sheet__title">添加</p>
      <button class="sheet__item" type="button" data-plus="camera" @click="run('camera')">
        <AppIcon name="camera" :size="19" /><span>相机</span>
      </button>
      <button class="sheet__item" type="button" data-plus="gallery" @click="run('gallery')">
        <AppIcon name="image" :size="19" /><span>相册</span>
      </button>
      <button class="sheet__item" type="button" data-plus="file" @click="run('file')">
        <AppIcon name="file" :size="19" /><span>文件</span>
      </button>
    </div>
  </Transition>
  <!-- 隐藏选择器：常驻 DOM（选文件时弹层已经关闭），e2e 用 data-pick-input 定位 -->
  <div class="pickers" aria-hidden="true">
    <input
      ref="cameraInput"
      type="file"
      :accept="PICK_INPUT_ATTRS.camera.accept"
      :capture="PICK_INPUT_ATTRS.camera.capture ?? undefined"
      :multiple="PICK_INPUT_ATTRS.camera.multiple"
      data-pick-input="camera"
      tabindex="-1"
      @change="onPicked('camera', $event)"
    />
    <input
      ref="galleryInput"
      type="file"
      :accept="PICK_INPUT_ATTRS.gallery.accept"
      :multiple="PICK_INPUT_ATTRS.gallery.multiple"
      data-pick-input="gallery"
      tabindex="-1"
      @change="onPicked('gallery', $event)"
    />
    <input
      ref="fileInput"
      type="file"
      :accept="PICK_INPUT_ATTRS.file.accept"
      :multiple="PICK_INPUT_ATTRS.file.multiple"
      data-pick-input="file"
      tabindex="-1"
      @change="onPicked('file', $event)"
    />
  </div>
</template>

<style scoped>
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
/* 隐藏但仍可被 click()/CDP 触达：不用 display:none（部分浏览器对不可见 input 的 click 无效） */
.pickers {
  position: fixed;
  left: -9999px;
  top: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
</style>
