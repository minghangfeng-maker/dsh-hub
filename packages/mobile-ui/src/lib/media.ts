/**
 * 附件选择、图片压缩、保存/分享到本机（相机 / 相册 / 文件 / 下载目录 / 系统分享）。
 *
 * 依据（开发文档 §1.4 第 6 条 + M5 §17「附件是否进首版：进」）：
 * - 图片在 **App 端**压缩到长边 ≤ 2048px 且 ≤ 5MiB，再上传；
 * - Hub 硬限：云节点图片 5MiB、文件 20MiB；桌面节点 1MiB（中继帧限制）；
 * - 选择器：相机走 `@capacitor/camera`，相册/文件走 `<input type=file>`（WebView 里能拉起
 *   系统选择器，不额外引第三方插件）。
 *
 * 网页版（WP54 / W3，`!isNative()`）的差异只有「能力从哪来」，数据结构完全一样：
 * - 选择：三个隐藏 `<input type=file>`（相机 `capture=environment`、相册 `multiple`）；
 * - 保存：浏览器下载（Blob + `<a download>`，落点 = 下载目录）；
 * - 分享：`navigator.share`（`canShare({files})` 为真时带文件，否则只分享文字，再不行退回下载）。
 */

import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { Capacitor } from '@capacitor/core'

export type AttachmentKind = 'image' | 'file'

export interface PickedFile {
  kind: AttachmentKind
  name: string
  mimeType: string
  bytes: number
  /** 不含 `data:` 前缀的 base64（直接用于 upload-chunk）。 */
  base64: string
  /** 本地预览（object URL；发送成功或移除时 revoke）。 */
  previewUrl: string | null
  width?: number
  height?: number
  /** 压缩前的大小（用于「已压缩」提示与超限判断）。 */
  originalBytes?: number
}

export interface PickOptions {
  /** 云 / 桌面：桌面节点单附件 1MiB（§17 D4）。 */
  backendKind?: 'cloud' | 'desktop'
}

export const IMAGE_MAX_EDGE = 2048
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const CLOUD_FILE_MAX_BYTES = 20 * 1024 * 1024
export const DESKTOP_MAX_BYTES = 1 * 1024 * 1024

const isNative = (): boolean => Capacitor.isNativePlatform()

// ── base64 / 字节 ──────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

export function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

// ── 图片压缩 ────────────────────────────────────────────────────────────────

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
  mimeType: string
}

/**
 * 压缩到长边 ≤ 2048px、体积 ≤ 5MiB。
 *
 * 先按长边缩放；若 JPEG 仍然超限，按 0.85 → 0.7 → 0.55 逐档降质量；
 * 还超就继续缩边（最多三轮）。PNG 带透明时也转 JPEG（手机端视觉输入不需要 alpha）。
 */
export async function compressImage(blob: Blob): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(blob)
  try {
    let edge = Math.min(IMAGE_MAX_EDGE, Math.max(bitmap.width, bitmap.height))
    let quality = 0.88
    let compressed: CompressedImage | null = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = edge / Math.max(bitmap.width, bitmap.height)
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布')
      ctx.drawImage(bitmap, 0, 0, width, height)
      const out = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((value) => resolve(value), 'image/jpeg', quality),
      )
      if (!out) throw new Error('图片压缩失败')
      compressed = { blob: out, width, height, mimeType: 'image/jpeg' }
      if (out.size <= IMAGE_MAX_BYTES) return compressed
      if (quality > 0.55) quality -= 0.15
      else edge = Math.round(edge * 0.8)
    }
    return compressed!
  } finally {
    bitmap.close()
  }
}

// ── 选择器（相机 / 相册 / 文件）─────────────────────────────────────────────

/**
 * 三个入口的 `<input type=file>` 属性（WP54 / W3：网页版就是这三个隐藏输入框）。
 *
 * - 相机：`accept="image/*" capture="environment"` —— 手机浏览器直接调后置摄像头；
 * - 相册：`accept="image/*" multiple` —— 可以一次选多张（逐张压缩后进托盘）；
 * - 文件：不限类型。
 */
export type PickKind = 'camera' | 'gallery' | 'file'

export interface PickInputAttrs {
  accept: string
  /** 只在「相机」上有值（`environment` = 后置）。 */
  capture: string | null
  multiple: boolean
}

export const PICK_INPUT_ATTRS: Record<PickKind, PickInputAttrs> = {
  camera: { accept: 'image/*', capture: 'environment', multiple: false },
  gallery: { accept: 'image/*', capture: null, multiple: true },
  file: { accept: '*/*', capture: null, multiple: false },
}

/** 一次选择最多收几个（防止用户一次选 200 张把内存顶爆）。 */
export const PICK_MAX_FILES = 9

/**
 * 把一次选择里的文件转成附件（图片先压缩，其余直接 base64）。
 *
 * 串行处理：`compressImage` 每个都要建 canvas + bitmap，并发会把手机内存顶爆。
 * 单个文件失败（比如 HEIC 解不开）只跳过它，不影响同批其它文件。
 */
export async function pickedFromFiles(
  files: Iterable<File> | ArrayLike<File> | null | undefined,
  kind: PickKind,
): Promise<PickedFile[]> {
  const list = files === null || files === undefined ? [] : Array.from(files as ArrayLike<File>)
  const out: PickedFile[] = []
  for (const file of list.slice(0, PICK_MAX_FILES)) {
    const asImage = kind === 'camera' || kind === 'gallery' || file.type.startsWith('image/')
    try {
      out.push(await fileToPicked(file, asImage ? 'image' : 'file'))
    } catch {
      /* 单个文件读不出来就跳过 */
    }
  }
  return out
}

/**
 * 读一个**已经在 DOM 里**的 `<input type=file>`：用户选完后的 `files` → 附件。
 *
 * 网页版（WP54 / W3）用 PlusSheet 里三个隐藏输入框：`change` 事件触发时调用这里，
 * 读完把 `input.value` 清空 —— 否则再选同一张照片不会触发 `change`。
 */
export async function pickFromInputElement(
  input: HTMLInputElement,
  kind: PickKind,
): Promise<PickedFile[]> {
  const picked = await pickedFromFiles(input.files, kind)
  // 清空（不是重置整个表单）。iOS Safari 会对正在使用的 File 做延迟释放，这里不影响已读出的字节。
  try {
    input.value = ''
  } catch {
    /* 某些壳里不允许清空：忽略 */
  }
  return picked
}

async function fileToPicked(file: File, kind: AttachmentKind): Promise<PickedFile> {
  const isImage = kind === 'image' || file.type.startsWith('image/')
  if (isImage) {
    const compressed = await compressImage(file)
    const base64 = await blobToBase64(compressed.blob)
    const previewUrl = URL.createObjectURL(compressed.blob)
    return {
      kind: 'image',
      name: renameToJpg(file.name || 'image.jpg'),
      mimeType: compressed.mimeType,
      bytes: compressed.blob.size,
      base64,
      previewUrl,
      width: compressed.width,
      height: compressed.height,
      originalBytes: file.size,
    }
  }
  const base64 = await blobToBase64(file)
  return {
    kind: 'file',
    name: file.name || 'file',
    mimeType: file.type || 'application/octet-stream',
    bytes: file.size,
    base64,
    previewUrl: null,
    originalBytes: file.size,
  }
}

function renameToJpg(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base}.jpg`
}

/**
 * 相机（**只在原生壳里用**）：`@capacitor/camera` 拉起系统相机。
 *
 * 网页版（WP54 / W3）不调这里 —— PlusSheet 直接用带 `capture="environment"` 的隐藏
 * `<input type=file>`（浏览器会开摄像头），见 `PICK_INPUT_ATTRS` / `pickFromInputElement`。
 */
export async function pickFromCamera(): Promise<PickedFile | null> {
  const photo = await Camera.getPhoto({
    quality: 92,
    allowEditing: false,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    saveToGallery: false,
  })
  if (!photo.webPath) return null
  const blob = await (await fetch(photo.webPath)).blob()
  const name = `photo-${Date.now()}.${photo.format || 'jpeg'}`
  const file = new File([blob], name, { type: blob.type || 'image/jpeg' })
  return fileToPicked(file, 'image')
}

// ── 上限检查 ────────────────────────────────────────────────────────────────

export interface LimitCheck {
  ok: boolean
  message?: string
}

/** 按后端类型检查单附件上限（云：图 5MiB / 文件 20MiB；桌面：1MiB）。 */
export function checkAttachmentLimit(file: PickOptions & { kind: AttachmentKind; bytes: number }): LimitCheck {
  if ((file.backendKind ?? 'cloud') === 'desktop') {
    if (file.bytes > DESKTOP_MAX_BYTES) {
      return { ok: false, message: '电脑后端的单个附件不能超过 1MB，请压缩或改用云服务器' }
    }
    return { ok: true }
  }
  const max = file.kind === 'image' ? IMAGE_MAX_BYTES : CLOUD_FILE_MAX_BYTES
  if (file.bytes > max) {
    return {
      ok: false,
      message:
        file.kind === 'image'
          ? '图片压缩后仍然超过 5MB，请换一张'
          : '文件不能超过 20MB，请拆分或压缩后再发',
    }
  }
  return { ok: true }
}

// ── 保存 / 分享到本机（原生 = Documents + 系统分享；网页 = 下载 + navigator.share）──

export interface SaveResult {
  ok: boolean
  /** 给用户看的落点（原生是相对 Documents 的路径；浏览器是下载目录）。 */
  where?: string
  message?: string
}

/** 分享结果：`shared=false` 表示退回了下载（或用户取消）。 */
export interface ShareResult extends SaveResult {
  /** 真的走了系统分享面板。 */
  shared?: boolean
  /** 浏览器没有系统分享，已改成下载。 */
  fallback?: boolean
}

/** 输入：字节与 Blob 二选一（调用方手里已经是 Blob 时不要再转一遍）。 */
export interface MediaPayload {
  name: string
  mimeType: string
  bytes?: Uint8Array
  blob?: Blob
  /** 分享时附带的说明文字（网页版 `navigator.share({text})`）。 */
  text?: string
  /** 分享时附带的链接（网页版 `navigator.share({url})`）。 */
  url?: string
}

/** 浏览器运行时（网页版构建或 dev 预览）：没有原生插件，一切走浏览器能力。 */
export const isBrowserRuntime = (): boolean => !isNative()

interface ShareNavigator {
  share?: (data: {
    title?: string
    text?: string
    url?: string
    files?: File[]
  }) => Promise<void>
  canShare?: (data?: { title?: string; text?: string; url?: string; files?: File[] }) => boolean
}

function shareNavigator(): ShareNavigator | null {
  const nav = (globalThis as { navigator?: ShareNavigator }).navigator
  return nav ?? null
}

/** 这个浏览器有没有系统分享（`navigator.share`；桌面 Firefox / 部分 WebView 没有）。 */
export function hasSystemShare(): boolean {
  return typeof shareNavigator()?.share === 'function'
}

/** 这个浏览器能不能**带文件**分享（`navigator.canShare({files})`）。 */
export function canShareFiles(file: File): boolean {
  const nav = shareNavigator()
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    return nav.canShare({ files: [file] }) === true
  } catch {
    return false
  }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError'
}

/** 把输入统一成 Blob（有 blob 就直接用，避免大文件在内存里多拷一份）。 */
async function asBlob(payload: MediaPayload): Promise<Blob> {
  if (payload.blob) return payload.blob
  const bytes = payload.bytes ?? new Uint8Array(0)
  return new Blob([bytes as unknown as BlobPart], { type: payload.mimeType })
}

/** 浏览器下载：Blob → object URL → `<a download>`，点完延迟释放 URL。 */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = sanitizeName(name)
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 下载已经由浏览器接手：10 秒后释放 object URL（立刻 revoke 会让部分 Safari 版本取消下载）
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 保存一个产出文件。
 *
 * - 原生：写到 `Directory.Documents/dsh-hub/`（Android 上是公共 Documents，文件管理器可见），
 *   再拉起系统分享（图片可在分享面板里选「保存到相册」——Android 没有第三方插件时不能直接
 *   写媒体库，这一步交给系统）；
 * - **网页版（WP54 / W3）**：直接触发浏览器下载（`<a download>` + Blob），落点是浏览器下载目录，
 *   不碰文件系统、不用 base64（大文件直接走 Blob）。
 */
export async function saveFile(input: MediaPayload & { share?: boolean }): Promise<SaveResult> {
  const name = sanitizeName(input.name)
  if (!isNative()) {
    try {
      downloadBlob(name, await asBlob(input))
      return { ok: true, where: '浏览器下载目录' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const bytes = input.bytes ?? new Uint8Array(await (await asBlob(input)).arrayBuffer())
    const base64 = bytesToBase64(bytes)
    const path = `dsh-hub/${name}`
    await Filesystem.writeFile({
      path,
      data: base64,
      directory: Directory.Documents,
      recursive: true,
    })
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Documents })
    if (input.share !== false && Capacitor.isPluginAvailable('Share')) {
      try {
        await Share.share({ title: name, url: uri })
      } catch {
        /* 用户取消分享不算失败：文件已经写好了 */
      }
    }
    return { ok: true, where: `Documents/${path}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 分享一个产出文件（WP54 / W3）。
 *
 * - **网页版**：`navigator.share`；`navigator.canShare({files})` 为真时带文件，
 *   否则只分享文字（文件名/说明）；完全没有系统分享或分享失败（不是用户取消）→ 退回下载并提示；
 * - **原生**：与 0.4.11 一致 —— 先写 Documents，再拉起系统分享面板（`saveFile({share:true})`）。
 */
export async function shareFile(input: MediaPayload): Promise<ShareResult> {
  const name = sanitizeName(input.name)
  if (isNative()) {
    const result = await saveFile({ ...input, name, share: true })
    return { ...result, shared: result.ok }
  }
  const blob = await asBlob(input)
  let file: File | null = null
  try {
    file = new File([blob], name, { type: input.mimeType })
  } catch {
    file = null // 老浏览器没有 File 构造器：只分享文字
  }
  const nav = shareNavigator()
  if (nav && typeof nav.share === 'function') {
    const withFiles = file !== null && canShareFiles(file)
    try {
      await nav.share(
        withFiles
          ? {
              files: [file as File],
              title: name,
              ...(input.text === undefined || input.text === '' ? {} : { text: input.text }),
            }
          : {
              title: name,
              ...(input.text === undefined || input.text === '' ? {} : { text: input.text }),
              ...(input.url === undefined || input.url === '' ? {} : { url: input.url }),
            },
      )
      return {
        ok: true,
        shared: true,
        ...(withFiles ? {} : { message: '这个浏览器不能分享文件，只分享了文件名' }),
      }
    } catch (error) {
      if (isAbortError(error)) return { ok: true, shared: false, message: '已取消分享' }
      /* 其它错误（权限/系统面板起不来）：退回下载 */
    }
  }
  const result = await saveFile({ name, mimeType: input.mimeType, bytes: input.bytes, blob })
  return {
    ...result,
    shared: false,
    fallback: true,
    ...(result.ok ? { message: '这个浏览器不支持系统分享，已改为下载' } : {}),
  }
}


function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}
