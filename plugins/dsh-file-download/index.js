/**
 * Host half of the file-download bundle: one authenticated, streaming,
 * Range-capable download route.
 *
 * Why this exists. The browser used to receive a file through
 * `workspaceFiles.readBytes` and hand the bytes back as a Blob: one whole-file
 * RPC. That is a one-shot transfer — the Host buffers the entire file, the
 * browser download manager cannot show progress or pause/resume it, and a
 * dropped connection restarts from byte zero. This route instead streams the
 * file from `ctx.fs` in bounded chunks with HTTP `Range` support, so the
 * browser's own download manager owns the transfer: progress, pause/resume
 * (断点续传), background continuation, and files far larger than memory all
 * work. The route is registered under `/api`, so Connection's browser-trust
 * fence and the signed browser-session cookie authenticate it exactly like
 * RPC; the Client addresses it document-relative as `api/workspace.download`.
 *
 * The file is read through the composed filesystem provider with the same
 * gates the preview already uses (`workspaceFiles`): the Session header names
 * the workspace root, the final path component must not be a symlink, and the
 * target must be a regular file. Reads are allowed outside the workspace, as
 * they are for preview and `readBytes` — the filesystem backend owns read
 * authority — but the route never lists directories and never mutates.
 */

/** Absolute registration path of the streaming download route. */
const DOWNLOAD_PATH = '/api/workspace.download'

/** Bytes per `fs.readByteRange` window; bounds Host memory, not file size. */
const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Headers every answer carries: never store, never sniff, never render, and
 * never re-encode (`no-transform` keeps the gzip middleware off, so a download
 * always carries its real `Content-Length` and the browser can show progress).
 */
const BASE_HEADERS = {
  'cache-control': 'private, no-store, no-transform',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'content-type': 'application/octet-stream',
}

/**
 * Map one failure to an HTTP status plus a stable machine-readable reason the
 * Client can translate. HEAD answers carry no body, so the reason rides in a
 * header there and in the text body otherwise.
 */
function failure(method, status, reason) {
  return new Response(method === 'HEAD' ? null : reason, {
    status,
    headers: { ...BASE_HEADERS, 'x-file-download-error': reason },
  })
}

/** Translate a filesystem backend refusal by its published code. */
function failureFromError(method, error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const statuses = {
    FS_NOT_FOUND: 404,
    FS_NOT_REGULAR_FILE: 403,
    FS_PERMISSION_DENIED: 403,
    FS_SANDBOX_DENIED: 403,
    FS_TOO_LARGE: 413,
    FS_ABORTED: 499,
  }
  const status = statuses[code]
  if (status !== undefined) return failure(method, status, code)
  return failure(method, 500, 'read-failed')
}

/** 0-based basename of a process path, tolerant of POSIX and Windows separators. */
function fileNameOf(absolutePath) {
  const parts = String(absolutePath ?? '').split(/[\\/]/)
  const name = parts[parts.length - 1] ?? ''
  return name === '' ? 'download' : name
}

/** RFC 6266/5987 attachment header: ASCII fallback plus the exact UTF-8 name. */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Etag from the backend's opaque version token, sans characters forbidden in a header. */
function etagOf(version) {
  return `"${String(version ?? '').replace(/["\\\r\n]/g, '')}"`
}

/**
 * Parse one `bytes=` range against a known file size.
 * @returns `undefined` when the header must be ignored (malformed, multi-range,
 *   or unknown unit — RFC 9110 allows serving the full representation),
 *   `{ unsatisfiable: true }` when no byte exists at the requested offset, or
 *   the inclusive `{ start, end }` byte window.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return undefined
  if (size <= 0) return { unsatisfiable: true }
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start)) return undefined
  if (start >= size) return { unsatisfiable: true }
  if (endText === '') return { start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || start > end) return undefined
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Resolve the Session's workspace root exactly as `workspaceFiles` does: the
 * live Session header when the Session is active, else the persisted header of
 * a cold Session, else fail (the Client must name a Session it can prove).
 * @returns the workspace root, or `undefined` when the Session is unknown.
 */
async function workspaceRootOf(ctx, sessionId, signal) {
  const sessions = ctx.get('sessions')
  const live = sessions?.get(sessionId)?.header
  const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
  const header = live ?? stored?.header
  if (header === undefined || header === null) return undefined
  return header.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot
}

/**
 * All file gates for the download, mirroring `workspaceFiles.readBytes`: reject
 * an absent path, a non-regular entry, and a final symlink (via `lstat`), then
 * resolve the target and re-check its kind with one `stat`.
 * @returns `{ target, info }` or `{ status, reason }` for the refusal.
 */
async function locateFile(fs, workspaceRoot, path, signal) {
  const entry = await fs.lstat(path, { cwd: workspaceRoot }, signal)
  if (entry === undefined) return { status: 404, reason: 'not-found' }
  if (entry.type !== 'file') return { status: 403, reason: 'not-regular-file' }
  const target = await fs.resolve(path, { cwd: workspaceRoot, signal })
  const info = await fs.stat(target, signal)
  if (info === undefined) return { status: 404, reason: 'not-found' }
  if (info.type !== 'file') return { status: 403, reason: 'not-regular-file' }
  return { target, info }
}

/**
 * One backpressured byte stream over `fs.readByteRange`: each pull reads one
 * bounded window, so Host memory stays at one chunk regardless of file size.
 * Cancellation (browser close, pause past the retry window) reaches the
 * filesystem through the request signal and ends the stream quietly.
 */
function streamFile(fs, target, start, length, signal) {
  const end = length === undefined ? Number.MAX_SAFE_INTEGER : start + length
  let offset = start
  return new ReadableStream({
    async pull(controller) {
      try {
        if (signal?.aborted === true || offset >= end) {
          controller.close()
          return
        }
        const want = Math.min(CHUNK_BYTES, end - offset)
        const bytes = await fs.readByteRange(target, { offset, length: want }, signal)
        if (bytes.byteLength === 0) {
          controller.close()
          return
        }
        offset += bytes.byteLength
        controller.enqueue(bytes)
      } catch (error) {
        if (signal?.aborted === true) controller.close()
        else controller.error(error)
      }
    },
  })
}

/**
 * Serve one download request: validate the addressing parameters, resolve the
 * Session and file, then answer a full (200) or ranged (206) streaming
 * response. The handler owns ranges, validators, and error statuses; the
 * shared `/api` bridge owns authentication and socket backpressure.
 */
async function handleDownload(ctx, request) {
  const method = request.method
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (sessionId === '' || path === '') return failure(method, 400, 'missing-parameters')
  if (path.includes('\0')) return failure(method, 400, 'invalid-path')

  const fs = ctx.get('fs')
  if (fs === undefined) return failure(method, 503, 'filesystem-unavailable')

  let workspaceRoot
  try {
    workspaceRoot = await workspaceRootOf(ctx, sessionId, request.signal)
  } catch (error) {
    return failureFromError(method, error)
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return failure(method, 404, 'session-not-found')
  }

  let located
  try {
    located = await locateFile(fs, workspaceRoot, path, request.signal)
  } catch (error) {
    return failureFromError(method, error)
  }
  if (located.status !== undefined) return failure(method, located.status, located.reason)

  const { target, info } = located
  const name = fileNameOf(fs.processPath(target))
  const etag = etagOf(info.version)
  const headers = {
    ...BASE_HEADERS,
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(name),
    etag,
  }

  /** The browser's resumed download sends If-Range; a stale validator forces a fresh 200. */
  const ifRange = request.headers.get('if-range')
  const rangeHeader = request.headers.get('range')
  const rangeAllowed = info.size !== undefined && rangeHeader !== null && (ifRange === null || ifRange === etag)
  const range = rangeAllowed ? parseRange(rangeHeader, info.size) : undefined
  if (range !== undefined && range.unsatisfiable === true) {
    return new Response(method === 'HEAD' ? null : 'range not satisfiable', {
      status: 416,
      headers: { ...BASE_HEADERS, 'content-range': `bytes */${String(info.size)}` },
    })
  }

  if (range !== undefined) {
    const length = range.end - range.start + 1
    headers['content-range'] = `bytes ${String(range.start)}-${String(range.end)}/${String(info.size)}`
    headers['content-length'] = String(length)
    return new Response(method === 'HEAD' ? null : streamFile(fs, target, range.start, length, request.signal), { status: 206, headers })
  }

  if (info.size !== undefined) headers['content-length'] = String(info.size)
  return new Response(method === 'HEAD' ? null : streamFile(fs, target, 0, info.size, request.signal), { status: 200, headers })
}

/**
 * Register the download route beside Connection's authenticated `/api`
 * transport. `inject` waits for Connection instead of failing composition in a
 * profile that has no browser transport (headless), where the plugin is inert.
 */
export const name = 'file-download'

export const inject = ['fs']

/**
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: DOWNLOAD_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => handleDownload(scope, request),
    })
  })
}
