/**
 * App 内下载更新包（0.3.1）：在 WebView 里 `fetch` 流式读取 → 分块 base64 写进 Cache。
 *
 * 为什么必须走 WebView 的 fetch（而不是 CapacitorHttp / OkHttp / DownloadManager / Chrome）：
 * 安装包地址由 Hub 下发（`bootstrap.app.downloadMirrors`，可能是独立域名的静态托管/镜像），
 * 这条链路上可能横着中间层（未备案域名拦截、企业网关、TLS 中间设备）：它们常常直接 reset
 * 「ClientHello 很小」的 TLS 连接 —— curl、OkHttp、HttpURLConnection、Android DownloadManager
 * 全部中招，只有浏览器内核（含 Android WebView）能通过。
 *
 * 更早的版本把 APK 地址交给 Chrome 下载（Custom Tab）：真机上永远卡在
 * 「正在下载… 已下载 8.52 MB，共 8.52 MB」收不了尾（Chrome 的 APK 安全扫描要连 Google，
 * 国内不通）。所以 0.3.1 起改成 App 自己下、自己校验、自己调系统安装器。
 *
 * 这个文件只放与平台无关的部分：读流、算进度、校验字节数、按块回调 `sink` 写入。
 * Filesystem / 安装器的接线在 lib/app-update-native.ts；单测用假 sink（test/update-download）。
 */

import { bytesToBase64, sha256Hex } from '@dsh-hub/mobile-core'

/** 下载目录（相对 `Directory.Cache`）：每次写前整目录清掉，别把旧版本安装包攒在手机上。 */
export const UPDATE_APK_DIR = 'updates'
/** 每次交给原生写入的字节数：8.5MB 的包分 ~17 块，避免一次性构造巨大的 base64 字符串。 */
export const UPDATE_CHUNK_BYTES = 512 * 1024
/** 空闲超时：这么久没有新字节就判失败（弱网/被中断时不要永远转圈）。 */
export const UPDATE_IDLE_TIMEOUT_MS = 30_000

/** 一次下载的进度快照（total 来自 `Content-Length`，服务器没给就是 null）。 */
export interface UpdateProgress {
  received: number
  total: number | null
  /** 0..100 的整数；total 未知时为 null（界面只显示已下载字节）。 */
  percent: number | null
}

/** 写文件的两个动作：先清旧包，再按块追加（真实实现见 lib/app-update-native.ts）。 */
export interface UpdateFileSink {
  reset(): Promise<void>
  /** 追加一块（base64、不带 `data:` 前缀；Filesystem 不传 encoding 时按二进制解码）。 */
  append(base64: string): Promise<void>
}

export type DownloadFailureReason =
  | 'canceled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'content'
  | 'stream'
  | 'empty'
  | 'incomplete'
  | 'checksum'
  | 'no-url'
  | 'write'

export interface DownloadFailure {
  ok: false
  reason: DownloadFailureReason
  message: string
  status?: number
}

export interface DownloadSuccess {
  ok: true
  bytes: number
  total: number | null
}

export type DownloadResult = DownloadSuccess | DownloadFailure

/** fetch 的最小形状（单测注入假实现；正式代码用全局 fetch）。 */
export interface FetchLikeResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; cache?: string },
) => Promise<FetchLikeResponse>

export interface DownloadUpdateOptions {
  url: string
  sink: UpdateFileSink
  /**
   * 期望的 sha256（0.4.11 / WP52，可选）：Hub 目前不下发，发了就校验。
   * 对不上返回 `checksum` 失败，镜像回退会换下一个地址（防止某个镜像同步了别的包）。
   */
  expectedSha256?: string
  fetchImpl?: FetchLike
  /** 用户点「取消下载」时 abort。 */
  signal?: AbortSignal
  onProgress?: (progress: UpdateProgress) => void
  onEvent?: (name: string, detail: string) => void
  /** 空闲超时（毫秒），默认 UPDATE_IDLE_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 攒到多少字节写一次，默认 UPDATE_CHUNK_BYTES。 */
  chunkBytes?: number
}

/** 写入失败用独立错误类型区分，别把「存不下」误报成「网络断了」。 */
class SinkWriteError extends Error {}

function failure(
  reason: DownloadFailureReason,
  message: string,
  status?: number,
): DownloadFailure {
  const result: DownloadFailure = { ok: false, reason, message }
  if (status !== undefined) result.status = status
  return result
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * 下载 APK 到 `sink` 并校验字节数。
 *
 * 成功条件：HTTP 2xx、Content-Type 不是网页、收到的字节数等于 `Content-Length`（有的话）；
 * 失败时返回中文原因，由界面显示「重试 / 用浏览器下载」。取消与超时都返回 `ok: false`。
 */
export async function downloadUpdate(options: DownloadUpdateOptions): Promise<DownloadResult> {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit))
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? UPDATE_CHUNK_BYTES))
  const timeoutMs = Math.max(0, options.timeoutMs ?? UPDATE_IDLE_TIMEOUT_MS)

  const controller = new AbortController()
  let timedOut = false
  let canceled = options.signal?.aborted === true
  let timer: ReturnType<typeof setTimeout> | null = null
  // 调用方传进来就已经取消了：直接让内部 controller 也是 abort 状态，
  // 这样 fetch/read 立刻失败并按 canceled 收场（不会白等一次网络）。
  if (canceled) controller.abort()

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  /** 每收到一块数据就重置计时：只要还在动就不算超时。 */
  const arm = (): void => {
    disarm()
    if (timeoutMs <= 0) return
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }
  const onExternalAbort = (): void => {
    canceled = true
    controller.abort()
  }
  options.signal?.addEventListener('abort', onExternalAbort)

  let received = 0
  let total: number | null = null

  const progress = (): UpdateProgress => ({
    received,
    total,
    percent: total === null || total <= 0 ? null : Math.min(100, Math.floor((received * 100) / total)),
  })

  try {
    // 先清旧包：上次中断留下的半截文件不能被 append 上去。
    await options.sink.reset()

    arm()
    let response: FetchLikeResponse
    try {
      response = await fetchImpl(options.url, { signal: controller.signal, cache: 'no-store' })
    } catch (error) {
      disarm()
      if (canceled) return failure('canceled', '已取消下载')
      if (timedOut) return failure('timeout', '下载超时，请重试')
      options.onEvent?.('update:download-error', messageOf(error))
      return failure('network', '下载失败：网络连接中断，请重试')
    }

    if (!response.ok) {
      disarm()
      return failure('http', `下载失败：服务器返回 ${response.status}`, response.status)
    }

    const lengthHeader = response.headers.get('content-length')
    const declared = lengthHeader === null ? Number.NaN : Number(lengthHeader)
    total = Number.isFinite(declared) && declared > 0 ? declared : null

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/html')) {
      // 网关的错误页 / 登录页也常常是 200，别把它当安装包写下去。
      disarm()
      return failure('content', '下载失败：服务器返回的不是安装包')
    }

    const reader = response.body?.getReader()
    if (!reader) {
      disarm()
      return failure('stream', '下载失败：读不到数据流，请重试')
    }

    const pending: Uint8Array[] = []
    let pendingBytes = 0
    // 只在明确要求校验时才留整包副本（8.5MB 级别；不要求就一块都不留）。
    const hashChunks: Uint8Array[] = []
    let hashBytes = 0
    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) return
      const merged = pending.length === 1 ? pending[0]! : concatBytes(pending, pendingBytes)
      pending.length = 0
      pendingBytes = 0
      try {
        await options.sink.append(bytesToBase64(merged))
      } catch (error) {
        options.onEvent?.('update:write-error', messageOf(error))
        throw new SinkWriteError('保存安装包失败')
      }
    }

    options.onProgress?.(progress())

    for (;;) {
      let read: { done: boolean; value?: Uint8Array }
      try {
        read = await reader.read()
      } catch (error) {
        disarm()
        if (canceled) return failure('canceled', '已取消下载')
        if (timedOut) return failure('timeout', '下载超时，请重试')
        options.onEvent?.('update:read-error', messageOf(error))
        return failure('network', '下载中断：网络连接失败，请重试')
      }
      if (read.done) break
      const value = read.value
      if (!value || value.byteLength === 0) continue
      if (options.expectedSha256 !== undefined) {
        hashChunks.push(value.slice())
        hashBytes += value.byteLength
      }
      pending.push(value)
      pendingBytes += value.byteLength
      received += value.byteLength
      if (pendingBytes >= chunkBytes) await flush()
      arm()
      options.onProgress?.(progress())
    }

    // 收尾那一块（不足 chunkBytes 的余量）。
    try {
      await flush()
    } catch (error) {
      if (error instanceof SinkWriteError) {
        return failure('write', '保存安装包失败，请检查手机存储空间后重试')
      }
      throw error
    }
    disarm()

    if (received === 0) return failure('empty', '下载失败：服务器没有返回数据，请重试')
    if (total !== null && received !== total) {
      options.onEvent?.('update:size-mismatch', `${received}/${total}`)
      return failure(
        'incomplete',
        `下载不完整（${received}/${total} 字节），请重试`,
      )
    }
    if (options.expectedSha256 !== undefined) {
      const expected = options.expectedSha256.trim().toLowerCase()
      const actual = await sha256Hex(concatBytes(hashChunks, hashBytes))
      if (actual !== expected) {
        options.onEvent?.('update:checksum-mismatch', actual.slice(0, 12))
        return failure('checksum', '下载的安装包校验不通过，请重试')
      }
      hashChunks.length = 0
    }

    options.onEvent?.('update:download', `${received}/${total ?? 'unknown'}`)
    return { ok: true, bytes: received, total }
  } catch (error) {
    disarm()
    if (error instanceof SinkWriteError) {
      return failure('write', '保存安装包失败，请检查手机存储空间后重试')
    }
    if (canceled) return failure('canceled', '已取消下载')
    if (timedOut) return failure('timeout', '下载超时，请重试')
    options.onEvent?.('update:download-error', messageOf(error))
    return failure('network', '下载失败：网络连接中断，请重试')
  } finally {
    disarm()
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 错误对象转成短字符串（只进诊断，不弹给用户）。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 80)
  return String(error).slice(0, 80)
}

/** 安装包在 Cache 里的相对路径：`updates/dsh-hub-app-<版本>.apk`。 */
export function updateApkPath(version: string | null | undefined): string {
  const label = (version ?? '').trim().replace(/[^0-9A-Za-z._-]/g, '')
  return `${UPDATE_APK_DIR}/dsh-hub-app-${label.length > 0 ? label : 'latest'}.apk`
}

/**
 * 原生 Filesystem 的最小形状（`writeFile` / `appendFile` / `rmdir`）。
 *
 * 只声明用到的三个方法：单测传假实现，正式代码传 `@capacitor/filesystem` 的 `Filesystem`。
 * `directory` 交给调用方参数化，免得把这个文件绑死到 Capacitor 的 `Directory` 枚举。
 */
export interface UpdateCacheFs<D> {
  writeFile(options: {
    path: string
    data: string
    directory: D
    recursive?: boolean
  }): Promise<unknown>
  appendFile(options: { path: string; data: string; directory: D }): Promise<unknown>
  rmdir(options: { path: string; directory: D; recursive?: boolean }): Promise<unknown>
}

/**
 * 把 Filesystem 包成 sink：第一块 `writeFile`（顺带建目录），之后 `appendFile`。
 *
 * `reset()` 把整个 `updates/` 目录递归删掉（旧版本安装包 + 上次中断的半截文件一起清），
 * 删不掉（首次下载时目录不存在）就忽略 —— 紧接着的 `writeFile` 会把文件重写一遍。
 */
export function createCacheFileSink<D>(
  fs: UpdateCacheFs<D>,
  options: { path: string; dir: string; directory: D },
): UpdateFileSink {
  let started = false
  return {
    async reset(): Promise<void> {
      started = false
      try {
        await fs.rmdir({ path: options.dir, directory: options.directory, recursive: true })
      } catch {
        /* 目录本来就不存在（首次下载）：忽略 */
      }
    },
    async append(base64: string): Promise<void> {
      if (!started) {
        await fs.writeFile({
          path: options.path,
          data: base64,
          directory: options.directory,
          recursive: true,
        })
        started = true
        return
      }
      await fs.appendFile({ path: options.path, data: base64, directory: options.directory })
    },
  }
}


// ── 多镜像（0.4.11 / WP52）──────────────────────────────────────────────────

export interface DownloadMirrorsOptions extends Omit<DownloadUpdateOptions, 'url'> {
  /** 有序下载地址（`bootstrap.app.downloadMirrors`，首选入口的在前）。 */
  urls: readonly string[]
  /** 每次换地址前回调（界面记诊断/复位进度）。 */
  onAttempt?: (attempt: { url: string; index: number; total: number }) => void
}

export interface MirrorDownloadSuccess extends DownloadSuccess {
  ok: true
  /** 真正下载成功的地址。 */
  url: string
  /** 试过几个地址（第一个就成功 = 1）。 */
  attempts: number
}

export interface MirrorDownloadFailure extends DownloadFailure {
  ok: false
  /** 最后一次尝试的地址（没有地址时为 null）。 */
  url: string | null
  attempts: number
}

export type MirrorDownloadResult = MirrorDownloadSuccess | MirrorDownloadFailure

/**
 * 按顺序尝试多个下载地址（0.4.11 / WP52）。
 *
 * 什么时候换下一个：网络失败、空闲超时、HTTP 非 2xx、返回的不是安装包、字节数不符、
 * sha256 不符、写文件失败……**任何一次失败都换**；只有用户点「取消下载」立刻停。
 * 每个地址都会从头写文件（`sink.reset()` 在 `downloadUpdate` 里），不会把半截包拼起来。
 */
export async function downloadUpdateMirrors(
  options: DownloadMirrorsOptions,
): Promise<MirrorDownloadResult> {
  const { urls: rawUrls, onAttempt, ...base } = options
  const urls = rawUrls.filter((url) => typeof url === 'string' && url.trim().length > 0)
  if (urls.length === 0) {
    return {
      ok: false,
      reason: 'no-url',
      message: '没有可用的下载地址，请稍后重试',
      url: null,
      attempts: 0,
    }
  }
  let last: DownloadFailure = {
    ok: false,
    reason: 'network',
    message: '下载失败：网络连接中断，请重试',
  }
  let lastUrl: string | null = null
  for (let index = 0; index < urls.length; index += 1) {
    // 用户已经点了取消：连下一个地址都不必发起（别让界面看起来还在下载）。
    if (base.signal?.aborted === true) {
      return { ok: false, reason: 'canceled', message: '已取消下载', url: lastUrl, attempts: index }
    }
    const url = urls[index]!
    lastUrl = url
    onAttempt?.({ url, index, total: urls.length })
    // 镜像必须按顺序试：同一时间只下一个，失败才换下一个。
    const result = await downloadUpdate({ ...base, url })
    if (result.ok) return { ...result, url, attempts: index + 1 }
    if (result.reason === 'canceled') {
      return { ...result, url, attempts: index + 1 }
    }
    last = result
    options.onEvent?.('update:mirror-fail', `${index + 1}/${urls.length}:${result.reason}`)
  }
  const tried = urls.length > 1 ? `（已试过 ${urls.length} 个下载地址）` : ''
  return {
    ...last,
    ok: false,
    message: `${last.message}${tried}`,
    url: lastUrl,
    attempts: urls.length,
  }
}
