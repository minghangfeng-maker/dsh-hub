<script setup lang="ts">
/**
 * 产出文件 / 交付物（M5 §8 / §17 D4）。
 *
 * - 图片：内联显示（点击看大图），按会话缓存（core 的 FileCache + sha256 校验）；
 * - 其他文件：下载卡（文件名、大小、下载/保存按钮）。
 *
 * 下载是按需的：
 * - **≤1MiB 的图片**：卡片出现就自动加载（files store 的预取也会串行排队）；
 * - **更大的图片**（例如 3.6MB gif）：不自动拉，卡片显示「点击加载」——一是省流量，
 *   二是大文件一轮 chunk 就会超过 Hub 的 WS 发送缓冲上限（真机「图片一直转圈」的根因之一）；
 * - 文档类文件等用户点「保存」再下载。
 *
 * 「保存」与「分享」（WP54 / W3 手机网页版）：
 * - 保存：原生写 Documents + 系统分享面板；网页版 = 浏览器下载（Blob + `<a download>`）；
 * - 分享：网页版 `navigator.share`（支持 files 时带文件，否则只分享文件名，再不行退回下载）。
 *   浏览器完全没有系统分享、原生壳里没有 Share 插件时，分享按钮不出现。
 */
import { computed, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
import { formatBytes } from '@dsh-hub/mobile-core'
import type { MobileFileRef } from '@dsh-hub/mobile-core'
import { useChatStore } from '@/stores/chat'
import { useFilesStore } from '@/stores/files'
import { useUiStore } from '@/stores/ui'
import { hasSystemShare, isBrowserRuntime } from '@/lib/media'

const props = withDefaults(
  defineProps<{ file: MobileFileRef; compact?: boolean }>(),
  { compact: false },
)
const emit = defineEmits<{ preview: [fileRef: string] }>()

const chat = useChatStore()
const files = useFilesStore()
const ui = useUiStore()

const loaded = computed(() => files.fileUrls[props.file.fileRef] ?? null)
const loading = computed(() => files.fileLoading[props.file.fileRef] === true)
const error = computed(() => files.fileErrors[props.file.fileRef] ?? null)
const isImage = computed(() => props.file.mediaType === 'image')
/** 自动加载上限 1MiB：超过它的图片只给「点击加载」，避免把通道发送缓冲顶爆（见上）。 */
const AUTO_LOAD_MAX_BYTES = 1024 * 1024
const autoLoadable = computed(
  () => props.file.bytes === undefined || props.file.bytes <= AUTO_LOAD_MAX_BYTES,
)
const sizeText = computed(() =>
  props.file.bytes === undefined ? '' : formatBytes(loaded.value?.bytes ?? props.file.bytes),
)
// Hub 只有在双方都协商了 `files` 时才会发 file 帧；没协商就不画保存按钮。
const canSave = computed(() => chat.features.includes('files'))
/** 网页版有 `navigator.share` 才画「分享」；原生走保存时的系统分享面板（与 0.4.11 一致）。 */
const canShare = computed(() => chat.features.includes('files') && isBrowserRuntime() && hasSystemShare())
/** 保存按钮/提示的落点文案：网页版是下载目录，原生是 Documents / 相册。 */
const saveLabel = computed(() => (isBrowserRuntime() ? '下载' : '保存'))

/**
 * 触发下载（force = 用户主动重试：忽略 30s 失败冷却，立刻重新发 file-read）。
 *
 * 加载顺序由 core 决定：内存缓存 → 持久缓存（IndexedDB，重开会话/重启 App 直接命中）
 * → 通道下载。失败会显示明确文案 + 「重试」按钮，不会一直停在「正在加载图片…」。
 */
function ensure(force = false): void {
  void files.ensureFile(
    props.file.fileRef,
    {
      name: props.file.name,
      ...(props.file.mimeType === undefined ? {} : { mimeType: props.file.mimeType }),
      mediaType: props.file.mediaType,
      ...(props.file.bytes === undefined ? {} : { bytes: props.file.bytes }),
    },
    { force },
  )
}

onMounted(() => {
  if (!isImage.value) return
  if (autoLoadable.value) {
    ensure()
    return
  }
  // 大图不自动下载；但持久缓存里已有（之前下载过/点过）就立刻渲染，重开会话秒开。
  void files.hasCachedFile(props.file.fileRef).then((cached) => {
    if (cached && !loaded.value) ensure()
  })
})

function open(): void {
  if (!isImage.value) return
  if (loaded.value) emit('preview', props.file.fileRef)
  else ensure(true)
}

async function save(): Promise<void> {
  if (!loaded.value) {
    ensure(true)
    ui.toast('正在下载…')
    return
  }
  await files.saveDownloaded(props.file.fileRef)
}

async function share(): Promise<void> {
  if (!loaded.value) {
    ensure(true)
    ui.toast('正在下载…')
    return
  }
  await files.shareDownloaded(props.file.fileRef)
}
</script>

<template>
  <div v-if="isImage" class="image-file" :class="{ 'image-file--compact': compact }">
    <button class="image-file__frame" type="button" @click="open">
      <img v-if="loaded" :src="loaded.url" :alt="file.name" loading="lazy" decoding="async" />
      <span v-else-if="loading" class="image-file__placeholder">正在加载图片…</span>
      <span v-else-if="error" class="image-file__placeholder image-file__placeholder--error">
        图片加载失败：{{ error }}
      </span>
      <span v-else-if="!autoLoadable" class="image-file__placeholder">
        图片较大（{{ sizeText || formatBytes(file.bytes ?? 0) }}）· 点击加载
      </span>
      <span v-else class="image-file__placeholder">图片还没下载</span>
    </button>
    <div class="image-file__bar">
      <span class="image-file__name">{{ file.name }}</span>
      <span class="image-file__size">{{ sizeText }}</span>
      <button v-if="error" class="image-file__btn" type="button" @click="ensure(true)">重试</button>
      <button v-if="canShare" class="image-file__btn" type="button" aria-label="分享" @click="share">
        分享
      </button>
      <button
        v-if="canSave"
        class="image-file__btn"
        type="button"
        :aria-label="saveLabel"
        @click="save"
      >
        {{ saveLabel }}
      </button>
    </div>
  </div>

  <div v-else class="file-card">
    <span class="file-card__icon"><AppIcon name="file" :size="18" /></span>
    <span class="file-card__main">
      <span class="file-card__name">{{ file.name }}</span>
      <span class="file-card__sub">
        {{ sizeText }}<template v-if="error"> · {{ error }}</template>
      </span>
    </span>
    <button
      v-if="canShare"
      class="file-card__btn file-card__btn--icon"
      type="button"
      aria-label="分享"
      data-file-share
      @click="share"
    >
      <AppIcon name="share" :size="15" />
    </button>
    <button
      v-if="canSave"
      class="file-card__btn"
      type="button"
      :disabled="loading"
      :aria-label="saveLabel"
      data-file-save
      @click="save"
    >
      <AppIcon name="download" :size="15" />
      <span>{{ loading ? '下载中' : error ? '重试' : saveLabel }}</span>
    </button>
  </div>
</template>

<style scoped>
.image-file {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: min(100%, 320px);
}
.image-file--compact {
  max-width: 180px;
}
.image-file__frame {
  display: block;
  width: 100%;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
  line-height: 0;
}
.image-file__frame img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 320px;
  object-fit: contain;
  background: var(--surface-2);
}
.image-file__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  padding: 14px 10px;
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.4;
  text-align: center;
}
.image-file__placeholder--error {
  color: var(--danger);
}
.image-file__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
}
.image-file__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.image-file__size {
  flex: 0 0 auto;
}
.image-file__btn {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11.5px;
}

.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(100%, 360px);
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.file-card__icon {
  display: inline-flex;
  color: var(--text-3);
  flex: 0 0 auto;
}
.file-card__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.file-card__name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-card__sub {
  font-size: 11.5px;
  color: var(--text-3);
}
.file-card__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
}
/* 只有图标的分享按钮（网页版）：与「下载」并排时更紧凑 */
.file-card__btn--icon {
  padding: 6px;
}
</style>
