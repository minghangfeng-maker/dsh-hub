import { describe, expect, it, vi } from 'vitest'

import { parseUsername, phaseTextOf, runWake, WAKE_ERROR_TEXT, type WakeEventSource } from '@/wake/wake'

/**
 * 唤醒页逻辑（07 §8 / 04 §3.1）：用户名解析（/dsh/<username>/）、start + SSE、ready 后 reload、失败态文案。
 * DOM 接线在 `src/wake/main.ts`（走查截图覆盖），这里测可注入的纯逻辑。
 */

class FakeSource implements WakeEventSource {
  onerror: ((event: Event) => void) | null = null
  closed = false

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function json(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function harness(
  options: {
    response?: Response | (() => Promise<Response>)
    timeoutMs?: number
  } = {},
) {
  const sources: FakeSource[] = []
  const reload = vi.fn()
  const phases: string[] = []
  const failures: string[] = []

  const promise = runWake({
    fetchImpl: vi.fn(async () => {
      const result = options.response ?? json({ instance: { status: 'starting' } })
      return typeof result === 'function' ? await result() : result
    }) as unknown as typeof fetch,
    createEventSource: (url: string) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    reload,
    onPhase: (text) => phases.push(text),
    onFailed: (message) => failures.push(message),
    timeoutMs: options.timeoutMs ?? 5_000,
  })

  return { promise, sources, reload, phases, failures }
}

describe('唤醒页（07 §8）', () => {
  it('从 /dsh/<username>/ 解析用户名，其它路径返回 null', () => {
    expect(parseUsername('/dsh/littletao/')).toBe('littletao')
    expect(parseUsername('/dsh/littletao')).toBe('littletao')
    expect(parseUsername('/dsh/littletao/some/path')).toBe('littletao')
    expect(parseUsername('/dsh/a_b-c/')).toBe('a_b-c')
    expect(parseUsername('/wake.html')).toBeNull()
    expect(parseUsername('/dsh/x/')).toBeNull()
    // 大写与旧地址都不是规范用户名（任务书 §4：大写直接 404，不做跳转）
    expect(parseUsername('/dsh/Littletao/')).toBeNull()
    expect(parseUsername('/u/u7k2m9xr/')).toBeNull()
    expect(parseUsername('/home')).toBeNull()
  })

  it('阶段文字映射（未知阶段给「正在准备…」）', () => {
    expect(phaseTextOf('pulling')).toContain('镜像')
    expect(phaseTextOf('booting')).toContain('启动')
    expect(phaseTextOf('bootstrapping')).toContain('插件')
    expect(phaseTextOf(null)).toBe('正在准备…')
    expect(phaseTextOf('something-new')).toBe('正在准备…')
  })

  it('start 成功后订阅 events，ready 时 reload 一次', async () => {
    const { promise, sources, reload, phases } = harness()

    expect(await waitForSource(sources)).toBe(true)
    expect(sources[0]?.url).toBe('/api/me/instance/events')

    sources[0]!.emit('status', {
      instance: { status: 'starting' },
      phase: 'bootstrapping',
      message: '正在安装插件…',
    })
    expect(phases).toContain('正在安装插件…')

    sources[0]!.emit('status', { instance: { status: 'running' }, phase: 'ready' })
    expect(await promise).toBe('ready')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sources[0]?.closed).toBe(true)
  })

  it('已在运行（200 + running）：不再等待，直接 reload', async () => {
    const { promise, reload } = harness({ response: json({ instance: { status: 'running' } }, 200) })

    expect(await promise).toBe('ready')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('CAPACITY_FULL：显示友好文案，不 reload', async () => {
    const { promise, reload, failures } = harness({
      response: json({ error: { code: 'CAPACITY_FULL', message: '同时在用的人有点多，稍后再试试' } }, 503),
    })

    expect(await promise).toBe('failed')
    expect(reload).not.toHaveBeenCalled()
    expect(failures[0]).toContain('同时在用的人有点多')
  })

  it('401：给出登录过期文案（界面会把按钮换成「去登录」）', async () => {
    const { promise, failures } = harness({
      response: new Response('nope', { status: 401 }),
    })

    expect(await promise).toBe('failed')
    expect(failures[0]).toBe(WAKE_ERROR_TEXT.UNAUTHENTICATED)
  })

  it('连不上服务器：网络错误文案', async () => {
    const { promise, failures } = harness({
      response: () => Promise.reject(new Error('offline')),
    })

    expect(await promise).toBe('failed')
    expect(failures[0]).toContain('连接不上服务器')
  })

  it('超时：提示稍后再试，且不再监听', async () => {
    const { promise, sources, failures } = harness({ timeoutMs: 20 })

    expect(await promise).toBe('failed')
    expect(failures[0]).toContain('唤醒时间有点久')
    await waitForSource(sources)
    expect(sources[0]?.closed).toBe(true)
  })

  it('实例 status=error 时立即失败并带上服务端错误', async () => {
    const { promise, sources, failures } = harness()

    await waitForSource(sources)
    sources[0]!.emit('status', { instance: { status: 'error', error: '端口 3000 被占用' } })

    expect(await promise).toBe('failed')
    expect(failures[0]).toBe('端口 3000 被占用')
  })
})

/** 等假 EventSource 被创建（start 与订阅是并发的） */
async function waitForSource(sources: FakeSource[], timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (sources.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return sources.length > 0
}
