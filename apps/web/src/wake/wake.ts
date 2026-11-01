/**
 * 唤醒页逻辑（07 §8）：`POST /api/me/instance/start` + 订阅 `/api/me/instance/events`，
 * `ready` 后 `location.reload()`。
 *
 * 之所以单独一个文件、且不 import 任何业务模块：唤醒页有 **15KB gzip** 的体积预算，
 * 它由代理在实例未运行时直接返回，必须极轻；这里只依赖浏览器自带的 fetch/EventSource。
 */

/** 非 GET 请求的 CSRF 头（04 §0；上传以外的 JSON 请求用它） */
export const CSRF_HEADER = 'X-Hub-Csrf'

export const WAKE_START_URL = '/api/me/instance/start'
export const WAKE_EVENTS_URL = '/api/me/instance/events'

/** 启动阶段 → 中文文案（04 §3.1 的 phase 枚举） */
export const WAKE_PHASE_TEXT: Record<string, string> = {
  pulling: '正在准备镜像…',
  creating: '正在创建容器…',
  booting: '正在启动 DSH 服务…',
  bootstrapping: '正在安装插件…',
  ready: '马上就好…',
}

/** 错误码 → 唤醒页文案（04 §0.2 的子集，剩下的用服务端 message） */
export const WAKE_ERROR_TEXT: Record<string, string> = {
  UNAUTHENTICATED: '登录状态过期了，请回到 Hub 重新登录。',
  FORBIDDEN: '这个 DSH 不属于当前账号。',
  ACCOUNT_DISABLED: '账号已被停用，请联系管理员。',
  CAPACITY_FULL: '现在用的人有点多，稍后再试一次吧。',
  INSUFFICIENT_POINTS: '积分不足，去工作台充值后再启动。',
  INSTANCE_BUSY: '你的 DSH 正在忙别的任务，稍等一会儿。',
  INSTANCE_START_FAILED: '容器没能启动起来，再试一次，或者回 Hub 看看。',
  RUNTIME_NOT_READY: 'DSH 版本还在准备中，稍后再试。',
  NOT_FOUND: '没有找到这个 DSH。',
  INTERNAL: '出了点小问题，稍后再试一次。',
}

/**
 * 从代理透传的路径里取用户名：`/dsh/xiaotao/` → `xiaotao`；不是这个形状或不是合法用户名返回 null。
 * 用户名规则见 02 §5（`^[a-z][a-z0-9_-]{2,31}$`），这里内联一份，唤醒页不引业务模块。
 */
export function parseUsername(pathname: string): string | null {
  const match = /^\/dsh\/([a-z][a-z0-9_-]{2,31})(?:\/|$)/.exec(pathname)
  return match?.[1] ?? null
}

export function phaseTextOf(phase: string | null | undefined): string {
  if (!phase) return '正在准备…'
  return WAKE_PHASE_TEXT[phase] ?? '正在准备…'
}

/** 唤醒页需要的最小 EventSource 形状（测试注入假实现） */
export interface WakeEventSource {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
  onerror?: ((event: Event) => void) | null
}

export interface WakeOptions {
  /** 规范地址里的用户名（只用于展示/校验；start 是会话级的，不看用户名） */
  username?: string | null
  fetchImpl?: typeof fetch
  createEventSource?: (url: string) => WakeEventSource
  /** 就绪后的动作，默认 `location.reload()` */
  reload?: () => void
  onPhase?: (text: string, phase: string | null) => void
  onFailed?: (message: string, code: string | null) => void
  /** 超时（默认 120s；10 §C1 要求 60 秒内首次可用，这里多留一倍余量） */
  timeoutMs?: number
}

export type WakeResult = 'ready' | 'failed'

interface ErrorBody {
  error?: { code?: string; message?: string }
}

/** 解析错误响应（04 §0 的错误体），拿不到就按状态码兜底。 */
async function readError(response: Response): Promise<{ code: string | null; message: string }> {
  try {
    const body = (await response.json()) as ErrorBody
    const code = body.error?.code ?? null
    const message = body.error?.message || (code ? WAKE_ERROR_TEXT[code] : undefined)
    return { code, message: message ?? '唤醒失败，请稍后再试。' }
  } catch {
    if (response.status === 401)
      return { code: 'UNAUTHENTICATED', message: WAKE_ERROR_TEXT.UNAUTHENTICATED ?? '' }
    return { code: null, message: `唤醒失败（HTTP ${response.status}）` }
  }
}

/**
 * 跑完一次唤醒流程。返回 `ready` 表示已经触发 `reload`。
 * 幂等：内部用 `finished` 保证 onReady/onFailed 只回调一次。
 */
export async function runWake(options: WakeOptions = {}): Promise<WakeResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url, { withCredentials: true }) as WakeEventSource)
  const reload = options.reload ?? (() => window.location.reload())

  let source: WakeEventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let finished = false

  return await new Promise<WakeResult>((resolve) => {
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      source?.close()
      source = null
    }

    const fail = (message: string, code: string | null = null): void => {
      if (finished) return
      finished = true
      cleanup()
      options.onFailed?.(message, code)
      resolve('failed')
    }

    const succeed = (): void => {
      if (finished) return
      finished = true
      cleanup()
      reload()
      resolve('ready')
    }

    // 先订阅再 start：避免「订阅前就已经 ready」而漏掉事件
    try {
      source = createEventSource(WAKE_EVENTS_URL)
      source.addEventListener('status', (event: MessageEvent) => {
        let payload: {
          instance?: { status?: string; error?: string | null }
          phase?: string
          message?: string
        } = {}
        try {
          payload = typeof event.data === 'string' ? JSON.parse(event.data) : {}
        } catch {
          return
        }

        const status = payload.instance?.status
        if (status === 'running') {
          options.onPhase?.('已经就绪，正在打开…', 'ready')
          succeed()
          return
        }
        if (status === 'error') {
          fail(payload.instance?.error || WAKE_ERROR_TEXT.INSTANCE_START_FAILED || '启动失败')
          return
        }
        options.onPhase?.(payload.message || phaseTextOf(payload.phase), payload.phase ?? null)
      })
    } catch {
      // 浏览器不支持 EventSource：仍然尝试 start，靠超时兜底
      source = null
    }

    timer = setTimeout(() => {
      fail('唤醒时间有点久，点「再试一次」，或者回 Hub 看看。', null)
    }, options.timeoutMs ?? 120_000)

    void (async () => {
      // 先给一句通用文案；SSE 的 `status` 事件到了会覆盖它（阶段文字以 SSE 为准）
      options.onPhase?.('正在唤醒…', null)

      try {
        const response = await fetchImpl(WAKE_START_URL, {
          method: 'POST',
          headers: { Accept: 'application/json', [CSRF_HEADER]: '1' },
          credentials: 'same-origin',
        })

        if (!response.ok) {
          const { code, message } = await readError(response)
          fail(message, code)
          return
        }

        const body = (await response.json().catch(() => ({}))) as { instance?: { status?: string } }
        // 04 §3.1：已在运行直接 200 —— 那就别等了
        if (response.status === 200 && body.instance?.status === 'running') {
          options.onPhase?.('已经就绪，正在打开…', 'ready')
          succeed()
        }
      } catch {
        fail('连接不上服务器，请检查网络后重试。', 'INTERNAL')
      }
    })()
  })
}
