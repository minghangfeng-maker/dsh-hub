<script setup lang="ts">
/**
 * 大图查看（点开内联图片）：左右切换、保存到相册/下载目录。
 *
 * 只渲染 `files.sessionImages` 里已下载的图片；切换时按需补下载。
 *
 * 网页版（WP54 / W3）：保存 = 浏览器下载（Blob + `<a download>`），分享 = `navigator.share`
 * （支持 files 时带图片，否则只分享文件名，再不行退回下载）。
 */
import { computed, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { useFilesStore } from '@/stores/files'
import { useUiStore } from '@/stores/ui'
import { hasSystemShare, isBrowserRuntime } from '@/lib/media'

const files = useFilesStore()
const ui = useUiStore()

const list = computed(() => files.sessionImages)
const index = computed(() => {
  const ref = ui.imageViewerRef
  if (!ref) return -1
  return list.value.findIndex((file) => file.fileRef === ref)
})
const current = computed(() => (index.value >= 0 ? list.value[index.value] : null))
const loaded = computed(() => (current.value ? files.fileUrls[current.value.fileRef] ?? null : null))
const loading = computed(() => (current.value ? files.fileLoading[current.value.fileRef] === true : false))
const error = computed(() => (current.value ? files.fileErrors[current.value.fileRef] ?? null : null))

function ensure(file: { fileRef: string; name: string; mimeType?: string; mediaType: 'image' | 'file'; bytes?: number }, force = false): void {
  void files.ensureFile(
    file.fileRef,
    {
      name: file.name,
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      mediaType: file.mediaType,
      ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
    },
    { force },
  )
}

watch(
  () => ui.imageViewerRef,
  (ref) => {
    if (!ref) return
    const file = list.value.find((item) => item.fileRef === ref)
    // 打开大图是用户主动动作：插队 + 忽略失败冷却（force）。
    if (file) ensure(file, true)
  },
)

function step(delta: number): void {
  if (list.value.length === 0) return
  const next = (index.value + delta + list.value.length) % list.value.length
  const file = list.value[next]
  if (file) ui.openImageViewer(file.fileRef)
}

function close(): void {
  ui.closeImageViewer()
}

async function save(): Promise<void> {
  if (!current.value) return
  await files.saveDownloaded(current.value.fileRef)
}

async function share(): Promise<void> {
  if (!current.value) return
  await files.shareDownloaded(current.value.fileRef)
}

/** 网页版没有系统分享时不画「分享」（原生仍走保存时的系统分享面板，与 0.4.11 一致）。 */
const canShare = computed(() => isBrowserRuntime() && hasSystemShare())
/** 落点文案：网页版是下载目录。 */
const saveLabel = computed(() => (isBrowserRuntime() ? '下载图片' : '保存到相册/下载'))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="ui.imageViewerRef" class="viewer" @click.self="close">
        <header class="viewer__bar">
          <span class="viewer__name">{{ current?.name ?? '' }}</span>
          <button class="viewer__btn" type="button" aria-label="关闭" @click="close">
            <AppIcon name="close" :size="19" />
          </button>
        </header>
        <div class="viewer__stage">
          <button
            v-if="list.length > 1"
            class="viewer__nav viewer__nav--left"
            type="button"
            aria-label="上一张"
            @click="step(-1)"
          >
            <AppIcon name="arrowLeft" :size="20" />
          </button>
          <img v-if="loaded" :src="loaded.url" :alt="current?.name ?? '图片'" />
          <div v-else class="viewer__hint">
            <p v-if="error">图片加载失败：{{ error }}</p>
            <p v-else-if="loading">正在加载…</p>
            <p v-else>图片还没下载</p>
            <button v-if="error || !loading" class="viewer__retry" type="button" @click="current && ensure(current, true)">
              {{ error ? '重试' : '加载图片' }}
            </button>
          </div>
          <button
            v-if="list.length > 1"
            class="viewer__nav viewer__nav--right"
            type="button"
            aria-label="下一张"
            @click="step(1)"
          >
            <AppIcon name="chevronRight" :size="20" />
          </button>
        </div>
        <footer class="viewer__foot">
          <span class="viewer__count">
            {{ index >= 0 ? index + 1 : 0 }} / {{ list.length }}
          </span>
          <span class="viewer__actions">
            <button v-if="canShare" class="viewer__save" type="button" data-image-share @click="share">
              <AppIcon name="share" :size="16" />
              分享
            </button>
            <button class="viewer__save" type="button" data-image-save @click="save">
              <AppIcon name="download" :size="16" />
              {{ saveLabel }}
            </button>
          </span>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: rgba(10, 10, 12, 0.96);
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}
.viewer__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.86);
  font-size: 13px;
}
.viewer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer__btn {
  display: inline-flex;
  padding: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.viewer__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
}
.viewer__stage img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.viewer__hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
  text-align: center;
}
.viewer__retry {
  padding: 7px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 13px;
}
.viewer__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  padding: 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
}
.viewer__nav--left {
  left: 10px;
}
.viewer__nav--right {
  right: 10px;
}
.viewer__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px calc(10px + var(--safe-bottom));
  color: rgba(255, 255, 255, 0.7);
  font-size: 12.5px;
}
.viewer__save {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 13px;
}
/* WP54 / W3：分享 + 下载两个按钮并排（网页版），与计数同一行 */
.viewer__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
