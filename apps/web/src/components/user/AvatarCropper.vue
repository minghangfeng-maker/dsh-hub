<script setup lang="ts">
import { NButton, NModal, NSlider } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import {
  AVATAR_DEFAULT_QUALITY,
  AVATAR_MAX_BYTES,
  AVATAR_OUTPUT_SIZE,
  IDENTITY_TRANSFORM,
  avatarFileName,
  nextQuality,
  normalizeTransform,
  outputSize,
  shouldRetryQuality,
  sourceRect,
  validateAvatarFile,
  zoomBy,
  type CropTransform,
  type Size,
} from '@/utils/avatar-crop'

/**
 * 头像裁剪器（07 §6.2，自写不用第三方）：
 * canvas 绘制 + 拖拽平移 + 滚轮/滑块缩放 + 圆形遮罩预览，输出 512×512 webp、质量 .9；
 * 结果超过 1MB（04 §3 的上限）时按 {@link AVATAR_QUALITY_LADDER} 自动降质量重试。
 *
 * 像素逻辑全部走 `utils/avatar-crop.ts` 的纯函数（那边有测试）；这里只负责交互与 canvas 调用。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    file: File | null
    /** 裁剪框显示边长（px） */
    frame?: number
    /** 输出边长（04 §3 要求 512） */
    output?: number
    username?: string
  }>(),
  { frame: 288, output: AVATAR_OUTPUT_SIZE, username: 'avatar' },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  cropped: [blob: Blob, filename: string]
  error: [message: string]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const imageSize = ref<Size | null>(null)
const transform = ref<CropTransform>({ ...IDENTITY_TRANSFORM })
const errorText = ref('')
const processing = ref(false)
const dragging = ref(false)

let objectUrl: string | null = null
let dragStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 }

const ready = computed(() => image.value !== null && imageSize.value !== null)
const zoomPercent = computed(() => Math.round(transform.value.scale * 100))

function release(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  image.value = null
  imageSize.value = null
  transform.value = { ...IDENTITY_TRANSFORM }
  errorText.value = ''
  processing.value = false
  dragging.value = false
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) release()
  },
)

watch(
  () => props.file,
  (file) => {
    release()
    if (!file) return

    const invalid = validateAvatarFile(file)
    if (invalid) {
      errorText.value = invalid
      emit('error', invalid)
      return
    }

    objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      image.value = img
      imageSize.value = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }
      transform.value = { ...IDENTITY_TRANSFORM }
      draw()
    }
    img.onerror = () => {
      errorText.value = '这张图片读不出来，换一张试试'
      emit('error', errorText.value)
    }
    img.src = objectUrl
  },
  { immediate: true },
)

/**
 * canvas 只认具体色值，不认 CSS 变量，所以运行时从令牌上读一次
 * （这样组件里依然没有写死的颜色，CONTRIBUTING.md 的工程约定）。
 */
function token(name: string, fallback = 'transparent'): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 把当前变换画到目标 canvas 上（`mask` 为预览的圆形遮罩）。 */
function paint(target: HTMLCanvasElement, size: number, mask: boolean): void {
  const img = image.value
  const source = imageSize.value
  const context = target.getContext('2d')
  if (!img || !source || !context) return

  const rect = sourceRect(source, transform.value, props.frame)
  context.clearRect(0, 0, size, size)
  context.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, size, size)

  if (!mask) return

  // 圆形遮罩：外面压一层浅色，边缘描一圈主色
  const factor = size / props.frame
  context.save()
  context.fillStyle = token('--c-scrim')
  context.beginPath()
  context.rect(0, 0, size, size)
  context.arc(size / 2, size / 2, size / 2 - factor, 0, Math.PI * 2, true)
  context.fill()
  context.restore()
  context.beginPath()
  context.arc(size / 2, size / 2, size / 2 - factor, 0, Math.PI * 2)
  context.strokeStyle = token('--c-primary', 'currentColor')
  context.lineWidth = 2 * factor
  context.stroke()
}

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const size = Math.round(props.frame * ratio)
  if (canvas.width !== size) canvas.width = size
  if (canvas.height !== size) canvas.height = size
  paint(canvas, size, true)
}

watch(transform, () => draw(), { deep: true })

function onPointerDown(event: PointerEvent): void {
  if (!ready.value) return
  dragging.value = true
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    offsetX: transform.value.offsetX,
    offsetY: transform.value.offsetY,
  }
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || !imageSize.value) return
  const next: CropTransform = {
    scale: transform.value.scale,
    offsetX: dragStart.offsetX + (event.clientX - dragStart.x),
    offsetY: dragStart.offsetY + (event.clientY - dragStart.y),
  }
  transform.value = normalizeTransform(imageSize.value, next, props.frame)
}

function onPointerUp(): void {
  dragging.value = false
}

function onWheel(event: WheelEvent): void {
  if (!ready.value) return
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.08 : 0.08
  setScale(zoomBy(transform.value.scale, delta))
}

function setScale(scale: number): void {
  if (!imageSize.value) return
  transform.value = normalizeTransform(imageSize.value, { ...transform.value, scale }, props.frame)
}

function resetTransform(): void {
  if (!imageSize.value) return
  transform.value = normalizeTransform(imageSize.value, { ...IDENTITY_TRANSFORM }, props.frame)
}

/** 按质量档位编码；超 1MB 就降到下一档，全部试完仍超则报错。 */
async function encode(quality: number): Promise<{ blob: Blob; quality: number } | null> {
  const output = props.output
  const offscreen = document.createElement('canvas')
  const size = outputSize(output)
  offscreen.width = size.width
  offscreen.height = size.height
  paint(offscreen, output, false)

  const toBlob = (q: number): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (typeof offscreen.toBlob !== 'function') {
        resolve(null)
        return
      }
      offscreen.toBlob((blob) => resolve(blob), 'image/webp', q)
    })

  let blob = await toBlob(quality)
  let current = quality
  while (blob && shouldRetryQuality(blob.size, AVATAR_MAX_BYTES)) {
    const lower = nextQuality(current)
    if (lower === null) break
    current = lower
    blob = await toBlob(current)
  }

  if (!blob) {
    // 浏览器不支持 toBlob（或 webp 编码）：退回 dataURL → Blob
    const dataUrl = offscreen.toDataURL('image/webp', quality)
    const response = await fetch(dataUrl)
    blob = await response.blob()
  }

  if (shouldRetryQuality(blob.size, AVATAR_MAX_BYTES)) {
    errorText.value = '图片压不到 1MB 以内，换一张更简单的试试'
    emit('error', errorText.value)
    return null
  }

  return { blob, quality: current }
}

async function confirm(): Promise<void> {
  if (!ready.value) return
  processing.value = true
  try {
    const result = await encode(AVATAR_DEFAULT_QUALITY)
    if (!result) return
    emit('cropped', result.blob, avatarFileName(props.username, result.blob.type))
    emit('update:show', false)
  } finally {
    processing.value = false
  }
}

onBeforeUnmount(release)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="调整头像"
    class="avatar-cropper"
    :style="{ maxWidth: '420px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="avatar-cropper__stage">
      <canvas
        ref="canvasRef"
        class="avatar-cropper__canvas"
        :style="{ width: `${frame}px`, height: `${frame}px` }"
        :width="frame"
        :height="frame"
        data-testid="avatar-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel="onWheel"
      />
    </div>

    <div class="avatar-cropper__zoom">
      <NButton size="small" quaternary aria-label="缩小" @click="setScale(zoomBy(transform.scale, -0.12))">
        <template #icon><span class="i-ph-minus" aria-hidden="true" /></template>
      </NButton>
      <NSlider
        class="avatar-cropper__slider"
        :value="transform.scale"
        :min="1"
        :max="4"
        :step="0.01"
        :tooltip="false"
        aria-label="缩放"
        @update:value="setScale"
      />
      <NButton size="small" quaternary aria-label="放大" @click="setScale(zoomBy(transform.scale, 0.12))">
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
      </NButton>
      <span class="avatar-cropper__zoom-text">{{ zoomPercent }}%</span>
    </div>

    <p v-if="errorText" class="avatar-cropper__error" role="alert">{{ errorText }}</p>

    <template #footer>
      <div class="avatar-cropper__footer">
        <span class="text-[12px] text-3">{{ output }}×{{ output }} WebP · 不超过 1MB</span>
        <div class="flex gap-2">
          <NButton size="small" quaternary @click="resetTransform">复位</NButton>
          <NButton size="small" @click="emit('update:show', false)">取消</NButton>
          <NButton size="small" type="primary" :loading="processing" :disabled="!ready" @click="confirm">
            就用这张
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.avatar-cropper__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.avatar-cropper__canvas {
  border-radius: var(--radius-control);
  background: var(--c-bg);
  cursor: grab;
  touch-action: none;
}

.avatar-cropper__canvas:active {
  cursor: grabbing;
}

.avatar-cropper__zoom {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.avatar-cropper__slider {
  flex: 1;
}

.avatar-cropper__zoom-text {
  width: 46px;
  color: var(--c-text-2);
  font-size: var(--fs-12);
  text-align: right;
}

.avatar-cropper__error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.avatar-cropper__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
</style>
