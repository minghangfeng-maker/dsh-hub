/**
 * "Download to this machine" for the workspace file open in the document
 * preview.
 *
 * Why this plugin exists: DSH can preview workspace files but never hand them
 * to the browser as a download. This plugin adds the button; the actual
 * transfer is owned by the Host's streaming route (`api/workspace.download`,
 * registered by this bundle's Host half), so the browser's own download
 * manager takes over: a real progress bar, pause/resume (Range / 断点续传),
 * continuation in the background, and files larger than the Host process
 * memory. The Client only preflights the route with one HEAD (so a missing
 * file or expired login becomes a readable message instead of a failed
 * download) and then hands the URL to the browser.
 *
 * A Host that predates the streaming route (or a composition without the
 * `/api` transport) answers 404 for the route; the button then falls back to
 * the original whole-file `workspaceFiles.readBytes` + Blob save, which keeps
 * working without a restart.
 *
 * Slot: `sidebar.right.tab.document.actions`, whose cells receive
 * `{ absolutePath }` (the file's Host path) plus the framework's standard
 * `sessionId`; `readBytes(sessionId, path, ...)` needs exactly those two.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-file-download',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, IconDownloadOutlineMedium } = primitives

    /**
     * Document-relative form of the Host route. Relative on purpose: it
     * resolves against the page's own mount, exactly like the built-in session
     * log download route, so deployments under a path prefix keep working.
     */
    const DOWNLOAD_ROUTE = 'api/workspace.download'

    /** Only the legacy fallback path is bounded by the Host's whole-file cap (default 32 MiB). */
    const TOO_LARGE_HINT = '文件超过网页端整份读取上限（默认 32 MB）。请刷新页面重试；若仍失败，说明 Host 还是旧版本，需要重启/升级后才能流式下载大文件'

    /** The RPC types the payload as `Uint8Array`; tolerate a base64 string wire form. */
    function toBytes(data) {
      if (typeof data === 'string') return Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      return data
    }

    function fileNameOf(path) {
      const parts = String(path).split(/[\\/]/)
      return parts[parts.length - 1] || 'download'
    }

    /** One request with a hard deadline, so a stalled route cannot hang the button. */
    async function requestWithTimeout(url, init = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        return await fetch(url, { ...init, signal: controller.signal, credentials: 'same-origin' })
      } finally {
        clearTimeout(timer)
      }
    }

    /** Map one failed preflight to a sentence the user can act on. */
    function problemOf(response) {
      const reason = response.headers.get('x-file-download-error') ?? ''
      if (reason === 'session-not-found') return '找不到这个会话（可能已被清理），请刷新页面后重试'
      if (reason === 'not-found') return '文件已不存在，可能已被移动或删除'
      if (reason === 'not-regular-file') return '这个路径不是普通文件（可能是目录或符号链接），无法下载'
      if (reason === 'invalid-path') return '文件路径不合法，无法下载'
      if (reason === 'filesystem-unavailable') return '文件系统暂时不可用，请稍后重试'
      if (response.status === 401) return '网页登录已过期，请刷新页面后重试'
      if (response.status === 403) return '没有权限读取这个文件'
      if (response.status === 404) return '文件已不存在，或所在会话已失效'
      if (response.status === 413) return '文件太大，服务端拒绝传输'
      if (response.status === 416) return '文件在下载准备期间发生了变化，请重试'
      if (response.status === 499) return '下载被取消'
      return response.status === 0 ? '无法连接宿主服务' : `下载失败（HTTP ${String(response.status)}）`
    }

    /** Hand one same-origin URL to the browser download manager. */
    function startBrowserDownload(url, name) {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    /**
     * Primary path: preflight, then let the browser stream the file itself.
     *
     * The preflight doubles as the capability check. A Host that predates the
     * streaming route answers 404 from the shared `/api` bridge with no
     * `x-file-download-error` header; our own failures always carry it, so the
     * two 404s stay distinguishable without a second probe request.
     * @returns `{ ok: true }` after the browser download starts, else a message
     *   or `{ unavailable: true }` when the Host has no streaming route.
     */
    async function downloadStreaming(path, sessionId) {
      const query = new URLSearchParams({ sessionId, path }).toString()
      const url = `${DOWNLOAD_ROUTE}?${query}`
      let response
      try {
        response = await requestWithTimeout(url, { method: 'HEAD', cache: 'no-store' })
      } catch {
        return { ok: false, message: '无法连接宿主服务，请稍后重试' }
      }
      if (response.ok) {
        startBrowserDownload(url, fileNameOf(path))
        return { ok: true }
      }
      if (response.status === 404 && !response.headers.has('x-file-download-error')) {
        return { ok: false, unavailable: true }
      }
      return { ok: false, message: problemOf(response) }
    }

    /** Legacy path: whole-file RPC, then a Blob save (works on a Host without the route). */
    async function downloadInMemory(ctx, path, sessionId) {
      const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {})
      if (result?.ok !== true) {
        const code = result?.error?.code
        if (code === 'workspace-file/too-large') return { ok: false, message: TOO_LARGE_HINT }
        return { ok: false, message: result?.error?.message ?? '读取文件失败' }
      }
      const bytes = toBytes(result.value.data)
      const name = fileNameOf(result.value.absolutePath ?? path)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return { ok: true }
    }

    function DownloadAction(props) {
      const [state, setState] = React.useState('idle')
      const [problem, setProblem] = React.useState('')
      const busy = state === 'busy'

      const onClick = async () => {
        if (busy) return
        setState('busy')
        setProblem('')
        try {
          const outcome = await props.downloadFile(props.absolutePath, props.sessionId)
          if (outcome.ok) {
            setState('done')
            setTimeout(() => setState('idle'), 1800)
            return
          }
          setState('error')
          setProblem(outcome.message)
        } catch (error) {
          setState('error')
          setProblem(error instanceof Error ? error.message : String(error))
        }
      }

      const label = state === 'busy' ? '准备中' : state === 'done' ? '已开始' : state === 'error' ? '下载失败' : '下载'
      return h(
        Button,
        {
          size: 'sm',
          onClick,
          disabled: busy,
          title: problem || '用浏览器下载保存这个文件（大文件、暂停/续传、后台继续都支持）',
          'aria-label': '下载到本地',
          'data-file-download': state,
        },
        h(IconDownloadOutlineMedium, null),
        label,
      )
    }

    return {
      // `remote.workspaceFiles` must be injected at namespace granularity: the
      // remotes service guards property access, so `ctx.remote.workspaceFiles`
      // throws "cannot get property … without inject" unless it is declared.
      inject: ['slots', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const downloadFile = async (path, sessionId) => {
          if (typeof path !== 'string' || path === '') {
            return { ok: false, message: '这个文件没有可用的主机路径' }
          }
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { ok: false, message: '无法确定所属会话，请刷新页面重试' }
          }
          const outcome = await downloadStreaming(path, sessionId)
          if (outcome.ok === true || outcome.unavailable !== true) return outcome
          return downloadInMemory(ctx, path, sessionId)
        }

        // One seat only. The preview toolbar renders for every file — including
        // one with no renderer, whose body falls back to the empty state — so
        // also registering in `…document.unpreviewable` would put two identical
        // 下载 buttons in the same panel.
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'download-file',
              order: 40,
              label: '下载',
              inject: () => ({ downloadFile }),
            },
            DownloadAction,
          ),
        )
      },
    }
  },
})
