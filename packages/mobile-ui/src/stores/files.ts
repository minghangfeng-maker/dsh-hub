/**
 * 产出文件 / 对话内图片 store（从 `chat.ts` 里拆出来的，WP46 B）。
 *
 * 职责只有一个：**把「某个 fileRef 的字节」变成可渲染的 object URL**，以及它的生命周期：
 *
 *  - 下载闸门：同一时刻只允许**一条** `file-read` 在飞（Hub 的 WS 有 1MiB 慢消费者保护，
 *    两张大图同时预取会把发送缓冲顶爆 → 通道被 1013 断开；真机 2026-10-27 00:15 的
 *    「图片永远转圈」根因）；
 *  - 失败冷却 30s：以前每一帧状态都会重试一次失败的读取，界面永远停在「正在加载图片…」；
 *  - 预取只跟随**输入引用**（工具卡/交付物换了引用或切了会话），流式 delta 帧不再触发；
 *  - 持久缓存（IndexedDB）：下载一次，重开会话/杀 App 再开直接命中，不发 `file-read`；
 *  - object URL 的释放：切会话/换后端/退出登录时 revoke，避免内存泄漏。
 *
 * 依赖方向：`files → chat`（要 controller、当前会话、工具卡/交付物）。
 * `chat` **不**依赖本 store：清理靠 `watch`（会话切换 / 后端切换），不靠调用。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  collectFiles,
  fileNameOfKey,
  fileErrorCodeOf,
  safeFileName,
  type DownloadedFile,
  type MobileFileRef,
} from '@dsh-hub/mobile-core'
import { fileStore } from '@/lib/instance'
import { recordDiag } from '@/lib/diagnostics'
import { saveFile, shareFile } from '@/lib/media'
import { useAuthStore } from './auth'
import { useChatStore } from './chat'
import { useUiStore } from './ui'

/** 已下载的产出文件（object URL 由本 store 管，切会话/切后端时 revoke）。 */
export interface LoadedFile {
  url: string
  name: string
  mimeType: string
  mediaType: 'image' | 'file'
  bytes: number
}

/** 单张图片自动预取上限：超过它的只给「点击加载」，不自动拉（省流量 + 避免顶爆发送缓冲）。 */
const AUTO_PREFETCH_MAX_BYTES = 1024 * 1024

/** 失败后冷却多久才允许自动重试（用户点「重试」不受限）。 */
const FILE_AUTO_RETRY_MS = 30_000

/** 下载闸门的相邻任务间隔：给通道一点喘息时间（真机复测 120ms 足够）。 */
const FILE_GATE_GAP_MS = 120

interface FileGateEntry {
  key: string
  priority: boolean
  task: () => Promise<{ fromCache?: boolean } | void>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** 诊断用的短文本（`recordDiag` 的 detail 上限 80 字符，不写正文）。 */
function shortFileName(name: string | undefined, fallback: string): string {
  const value = (name ?? '').trim() || fallback
  return value.length > 32 ? `${value.slice(0, 31)}…` : value
}

function bytesLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.round(bytes / 1024)}KB`
}

export const useFilesStore = defineStore('files', () => {
  const auth = useAuthStore()
  const chat = useChatStore()
  const ui = useUiStore()

  const fileUrls = ref<Record<string, LoadedFile>>({})
  const fileLoading = ref<Record<string, boolean>>({})
  const fileErrors = ref<Record<string, string>>({})

  const fileRequests = new Map<string, Promise<void>>()
  /**
   * 文件加载失败记录（fileRef / `path:` 键 → 最近一次失败）。
   *
   * 真机反馈「交付物图片一直停在正在加载图片…」的直接原因之一：以前每次状态提交都会对
   * 没加载成功的图片再发一次读取，30s 超时→失败→下一帧又重试。现在失败后冷却 30s 才允许
   * 自动重试，用户点「重试」则强制立即重来。
   */
  const fileFailures = new Map<string, { at: number; message: string }>()
  /** 正文里的云端路径图片：`path:` 键 → 已生成的 object URL（会话内复用，切会话释放）。 */
  const cloudImageUrls = new Map<string, LoadedFile>()
  const cloudImageRequests = new Map<string, Promise<LoadedFile>>()

  // ── 下载闸门（同一时刻只有一条 file-read 在飞）──────────────────────────────
  const fileGateQueue: FileGateEntry[] = []
  const fileGateKeys = new Set<string>()
  let fileGateRunning = false
  let fileGateGapNext = false

  /** 入队执行一次文件读取；`priority` = 用户主动点的（插队到最前）。 */
  function runInFileGate<T extends { fromCache?: boolean } | void>(
    key: string,
    task: () => Promise<T>,
    priority = false,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      fileGateKeys.add(key)
      const entry: FileGateEntry = {
        key,
        priority,
        task: task as () => Promise<{ fromCache?: boolean } | void>,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      if (priority) fileGateQueue.unshift(entry)
      else fileGateQueue.push(entry)
      void drainFileGate()
    })
  }

  function isFileGateQueued(key: string): boolean {
    return fileGateKeys.has(key)
  }

  async function drainFileGate(): Promise<void> {
    if (fileGateRunning) return
    fileGateRunning = true
    try {
      while (fileGateQueue.length > 0) {
        const entry = fileGateQueue.shift()
        if (!entry) break
        fileGateKeys.delete(entry.key)
        if (fileGateGapNext) await new Promise((resolve) => setTimeout(resolve, FILE_GATE_GAP_MS))
        try {
          const result = await entry.task()
          // 缓存命中不占通道，不需要排空间隔；只有真的走网络才隔 120ms。
          fileGateGapNext = !(
            result !== null &&
            typeof result === 'object' &&
            (result as { fromCache?: boolean }).fromCache === true
          )
          entry.resolve(result)
        } catch (error) {
          fileGateGapNext = false
          entry.reject(error)
        }
      }
    } finally {
      fileGateRunning = false
      fileGateGapNext = false
    }
  }

  /** 切会话/退出登录：丢弃排队中的任务（在飞的那条会因断链/切会话自己失败）。 */
  function clearFileGate(): void {
    const pending = fileGateQueue.splice(0)
    fileGateKeys.clear()
    for (const entry of pending) entry.reject(new Error('会话已切换，下载已取消'))
  }

  // ── 诊断 ────────────────────────────────────────────────────────────────
  /**
   * 文件读取诊断（真机「图片为什么没出来」的可核对证据）。
   *
   * 诊断环形缓冲只有 40 条（auth/链路也在用），所以按 `事件:key` 去重：同一文件
   * 成功/失败各只记一次；App 重启后去重表清空，于是「重启后命中缓存（src=cache）」
   * 仍然会被记下来。
   */
  const recordedFileDiag = new Set<string>()

  function recordFileDiag(
    event: 'file:read' | 'file:read-fail',
    input: { key?: string; name?: string; bytes?: number; source?: string; code?: string },
  ): void {
    if (input.key !== undefined) {
      const id = `${event}:${input.key}`
      if (recordedFileDiag.has(id)) return
      recordedFileDiag.add(id)
    }
    const parts: string[] = []
    if (input.name !== undefined && input.name !== '') parts.push(`name=${shortFileName(input.name, 'file')}`)
    if (input.bytes !== undefined) parts.push(`bytes=${bytesLabel(input.bytes)}`)
    if (input.source !== undefined) parts.push(`src=${input.source}`)
    if (input.code !== undefined) parts.push(`code=${input.code}`)
    recordDiag(event, parts.join(' '))
  }

  // ── 失败冷却 ─────────────────────────────────────────────────────────────
  /** 某 key（fileRef 或 `path:<路径>`）最近一次失败是否还在冷却期。 */
  function inFailureCooldown(key: string): { message: string } | null {
    const failure = fileFailures.get(key)
    if (!failure) return null
    if (Date.now() - failure.at >= FILE_AUTO_RETRY_MS) return null
    return { message: failure.message }
  }

  function rememberFailure(key: string, message: string): void {
    fileFailures.set(key, { at: Date.now(), message })
  }

  function loadedFrom(file: DownloadedFile): LoadedFile {
    const url = URL.createObjectURL(
      new Blob([file.bytes as unknown as BlobPart], { type: file.mimeType }),
    )
    return {
      url,
      name: file.name,
      mimeType: file.mimeType,
      mediaType: file.mediaType,
      bytes: file.bytes.byteLength,
    }
  }

  // ── 产出文件（交付物 / 工具卡引用）────────────────────────────────────────

  /**
   * 确保某个 fileRef 的字节已下载并转成 object URL（幂等、可并发）。
   *
   * @param options.force 用户点「重试」时用：忽略冷却与已有错误，立即重新读。
   */
  async function ensureFile(
    fileRef: string,
    meta: {
      name?: string
      mimeType?: string
      mediaType?: 'image' | 'file'
      bytes?: number
    } = {},
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (fileUrls.value[fileRef]) return
    if (fileRequests.has(fileRef)) return fileRequests.get(fileRef)
    const failure = inFailureCooldown(fileRef)
    if (failure && options.force !== true) return
    const instance = chat.controller
    const sessionId = chat.activeId
    if (!instance || !sessionId) {
      fileErrors.value = { ...fileErrors.value, [fileRef]: '会话还没准备好，请稍后重试' }
      return
    }
    if (options.force === true) {
      const { [fileRef]: _gone, ...restErrors } = fileErrors.value
      fileErrors.value = restErrors
    }
    const request = (async () => {
      fileLoading.value = { ...fileLoading.value, [fileRef]: true }
      try {
        // 统一进「同一时刻只有一条 file-read 在飞」的闸门；用户点的插队。
        const file = await runInFileGate(
          fileRef,
          () => instance.readFile(sessionId, { fileRef, ...meta }),
          options.force === true,
        )
        fileUrls.value = { ...fileUrls.value, [fileRef]: loadedFrom(file) }
        fileFailures.delete(fileRef)
        const { [fileRef]: _gone, ...restErrors } = fileErrors.value
        fileErrors.value = restErrors
        recordFileDiag('file:read', {
          key: fileRef,
          name: file.name,
          bytes: file.bytes.byteLength,
          source: file.fromCache === true ? 'cache' : 'network',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '文件下载失败'
        rememberFailure(fileRef, message)
        fileErrors.value = { ...fileErrors.value, [fileRef]: message }
        recordFileDiag('file:read-fail', {
          key: fileRef,
          name: meta.name ?? fileNameOfKey(fileRef),
          ...(meta.bytes === undefined ? {} : { bytes: meta.bytes }),
          code: fileErrorCodeOf(error) ?? 'unknown',
        })
      } finally {
        const { [fileRef]: _loading, ...rest } = fileLoading.value
        fileLoading.value = rest
        fileRequests.delete(fileRef)
      }
    })()
    fileRequests.set(fileRef, request)
    return request
  }

  /**
   * 预取本会话里出现过的图片。
   *
   * 只自动拉 **≤1MiB** 的图；更大的（例如 3.6MB 的 gif）留给用户「点击加载」——
   * 一是省流量，二是大文件一轮发送就会超过 Hub 的 1MiB 发送缓冲（见 fileGateQueue 注释）。
   * 失败过的先别自动重试，等用户点「重试」。
   *
   * 调用时机：工具卡/交付物换了引用、或切了会话（见文件末尾的 watch）。
   */
  function prefetchFiles(): void {
    const sessionId = chat.activeId
    if (!sessionId) return
    const files = collectFiles(chat.toolCards, chat.deliverables)
    for (const file of files) {
      if (file.mediaType !== 'image') continue
      if (fileUrls.value[file.fileRef] || fileRequests.has(file.fileRef)) continue
      if (isFileGateQueued(file.fileRef)) continue
      if (inFailureCooldown(file.fileRef)) continue
      if (file.bytes !== undefined && file.bytes > AUTO_PREFETCH_MAX_BYTES) continue
      void ensureFile(file.fileRef, {
        name: file.name,
        ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
        mediaType: file.mediaType,
        ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
      })
    }
  }

  function fileUrlOf(fileRef: string): string | null {
    return fileUrls.value[fileRef]?.url ?? null
  }

  /**
   * 持久缓存里有没有这个文件（不发起网络、不回到 UI 状态）。
   *
   * 大图（>1MiB）默认不自动下载；但如果**之前下过一次**（持久缓存里有），
   * 重开会话应该立刻渲染，而不是再让用户点一次「加载」。
   */
  async function hasCachedFile(fileRef: string): Promise<boolean> {
    const account = auth.accountKey
    const sessionId = chat.activeId
    if (account === null || sessionId === null) return false
    try {
      return await fileStore.has(account, sessionId, fileRef)
    } catch {
      return false
    }
  }

  /**
   * 把已加载的 object URL 保存到相册/下载目录。
   *
   * - 原生：写 Documents 并拉起系统分享；
   * - **网页版（WP54 / W3）**：浏览器下载（Blob → `<a download>`，落点 = 下载目录）。
   * 这两种落点的差异只在 `lib/media.ts`，这里统一给「已保存到…」的提示。
   */
  async function saveLoaded(loaded: LoadedFile): Promise<void> {
    try {
      // 直接拿 Blob（大文件不要再走 base64 / 一次多余的 arrayBuffer 拷贝）
      const response = await fetch(loaded.url)
      const blob = await response.blob()
      const result = await saveFile({
        name: safeFileName(loaded.name),
        mimeType: loaded.mimeType,
        blob,
      })
      ui.toast(result.ok ? `已保存到${result.where ?? '相册/下载目录'}` : result.message ?? '保存失败', 2600)
    } catch (error) {
      ui.toast(error instanceof Error ? error.message : '保存失败', 2600)
    }
  }

  /**
   * 分享一个已加载的文件（WP54 / W3）。
   *
   * 网页版走 `navigator.share`：`canShare({files})` 为真时带文件，否则只分享文件名；
   * 浏览器没有系统分享时 `shareFile` 会自动退回下载并给提示（见 lib/media.ts）。
   */
  async function shareLoaded(loaded: LoadedFile): Promise<void> {
    try {
      const response = await fetch(loaded.url)
      const blob = await response.blob()
      const result = await shareFile({
        name: safeFileName(loaded.name),
        mimeType: loaded.mimeType,
        blob,
      })
      if (!result.ok) {
        ui.toast(result.message ?? '分享失败', 2600)
        return
      }
      if (result.message) ui.toast(result.message, 2600)
      else if (!result.shared && result.where) ui.toast(`已保存到${result.where}`, 2600)
    } catch (error) {
      ui.toast(error instanceof Error ? error.message : '分享失败', 2600)
    }
  }

  /** 保存一个交付物（已下载的才可保存；没下载先催一下）。 */
  async function saveDownloaded(fileRef: string): Promise<void> {
    const loaded = fileUrls.value[fileRef]
    if (!loaded) {
      void ensureFile(fileRef, {}, { force: true })
      ui.toast('正在下载…')
      return
    }
    await saveLoaded(loaded)
  }

  /** 分享一个交付物（网页版 `navigator.share`；原生 = Documents + 系统分享面板）。 */
  async function shareDownloaded(fileRef: string): Promise<void> {
    const loaded = fileUrls.value[fileRef]
    if (!loaded) {
      void ensureFile(fileRef, {}, { force: true })
      ui.toast('正在下载…')
      return
    }
    await shareLoaded(loaded)
  }

  // ── 正文里的云端路径图片（readFile({path})）───────────────────────────────

  /**
   * 加载正文 Markdown 里引用的云端路径图片（如 `/workspace/.../pelican.png`）。
   *
   * 走 `readFile({path})`：core 先查持久缓存（同一张图第二遍/重开会话不再走通道），
   * 未命中才发 `file-read` 的 `path` 字段；失败按 `FileDownloadError` 分类——
   * 越权/不存在这类**明确拒绝**不重试（约 1 次请求就返回），UI 显示
   * 「云端图片暂不可预览 · 下载」卡片，而不是破图 + 无限转圈。
   */
  async function loadCloudImage(
    path: string,
    meta: { alt?: string; force?: boolean } = {},
  ): Promise<LoadedFile> {
    const key = `path:${path}`
    const cached = cloudImageUrls.get(key)
    if (cached) return cached
    const failure = inFailureCooldown(key)
    if (failure && meta.force !== true) throw new Error(failure.message)
    const inflight = cloudImageRequests.get(key)
    if (inflight) return inflight
    const request = (async () => {
      const instance = chat.controller
      const sessionId = chat.activeId
      if (!instance || !sessionId) throw new Error('会话还没准备好')
      const file = await runInFileGate(
        key,
        () =>
          instance.readFile(sessionId, {
            path,
            ...(meta.alt === undefined || meta.alt === '' ? {} : { name: meta.alt }),
            mediaType: 'image',
          }),
        meta.force === true,
      )
      const loaded: LoadedFile = {
        ...loadedFrom(file),
        name: file.name !== '' ? file.name : fileNameOfKey(key),
        mediaType: 'image',
      }
      cloudImageUrls.set(key, loaded)
      fileFailures.delete(key)
      recordFileDiag('file:read', {
        key,
        name: loaded.name,
        bytes: loaded.bytes,
        source: file.fromCache === true ? 'path-cache' : 'path-network',
      })
      return loaded
    })()
    cloudImageRequests.set(key, request)
    try {
      return await request
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片加载失败'
      rememberFailure(key, message)
      recordFileDiag('file:read-fail', {
        key,
        name: fileNameOfKey(key),
        code: fileErrorCodeOf(error) ?? 'unknown',
      })
      throw error instanceof Error ? error : new Error(message)
    } finally {
      cloudImageRequests.delete(key)
    }
  }

  /** 云端路径图片的「下载」：先把字节读到本地（命中缓存就秒回），再保存到相册/下载目录。 */
  async function saveCloudImage(path: string, meta: { alt?: string } = {}): Promise<void> {
    try {
      const loaded = await loadCloudImage(path, { ...meta, force: true })
      await saveLoaded(loaded)
    } catch (error) {
      ui.toast(error instanceof Error ? error.message : '云端图片暂不可预览', 2600)
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /** 释放全部 object URL（切后端 / 退出登录 / 页面卸载）。 */
  function releaseFileUrls(): void {
    for (const loaded of Object.values(fileUrls.value)) URL.revokeObjectURL(loaded.url)
    for (const loaded of cloudImageUrls.values()) URL.revokeObjectURL(loaded.url)
    cloudImageUrls.clear()
    cloudImageRequests.clear()
    fileUrls.value = {}
    fileLoading.value = {}
    fileErrors.value = {}
  }

  /** 切会话：上一轮的失败冷却/排队任务/路径图片都作废（fileRef 是会话级的）。 */
  function resetForSession(): void {
    fileFailures.clear()
    recordedFileDiag.clear()
    clearFileGate()
    for (const loaded of cloudImageUrls.values()) URL.revokeObjectURL(loaded.url)
    cloudImageUrls.clear()
    cloudImageRequests.clear()
    fileUrls.value = {}
    fileLoading.value = {}
    fileErrors.value = {}
    fileRequests.clear()
  }

  // 预取只跟随「输入引用」与「切会话」：流式 delta 帧不再把 collectFiles 跑一遍。
  watch(
    () => [chat.toolCards, chat.deliverables, chat.activeId] as const,
    () => prefetchFiles(),
  )

  // 切会话：释放上一轮的东西（toolCards/deliverables 也会一起换掉）。
  watch(
    () => chat.activeId,
    () => resetForSession(),
  )

  // 换后端 / 退出登录：控制器被重建，全部作废。
  watch(
    () => chat.backendId,
    () => {
      resetForSession()
      releaseFileUrls()
    },
  )
  watch(
    () => auth.isAuthenticated,
    (ok) => {
      if (ok) return
      resetForSession()
      releaseFileUrls()
    },
  )

  /** 供大图查看用：把当前会话里所有图片按出现顺序列出来。 */
  const sessionImages = computed<MobileFileRef[]>(() => {
    const files = collectFiles(chat.toolCards, chat.deliverables)
    return files.filter((file) => file.mediaType === 'image')
  })

  return {
    // 状态
    fileUrls,
    fileLoading,
    fileErrors,
    sessionImages,
    // 动作
    ensureFile,
    fileUrlOf,
    hasCachedFile,
    saveDownloaded,
    shareDownloaded,
    prefetchFiles,
    loadCloudImage,
    saveCloudImage,
    releaseFileUrls,
    resetForSession,
  }
})
