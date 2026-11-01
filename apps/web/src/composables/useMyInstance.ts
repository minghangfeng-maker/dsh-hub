import type { InstancePhase, InstanceStats, InstanceSummary, ModelPolicy, Quota } from '@dsh-hub/shared'
import { useIntervalFn } from '@vueuse/core'
import { computed, onMounted, ref, shallowRef } from 'vue'

import {
  fetchMyInstance,
  restartInstance,
  startInstance,
  stopInstance,
  MY_INSTANCE_EVENTS_URL,
} from '@/api/instance'
import { describeError, isHubApiError } from '@/api/errors'
import { useSse, type SseSourceFactory } from '@/composables/useSse'

/** 04 §3.1 `GET /api/me/instance` 的模型摘要（`policy` 由契约保证，这里可选以兼容老夹具） */
export interface ModelSummary {
  policy?: ModelPolicy
  preset: string
  defaultModel: string
  providers: string[]
}

export type InstanceAction = 'start' | 'stop' | 'restart'

/** 「打开 DSH」需要的最小浏览器能力（测试注入假实现）。 */
export interface OpenTab {
  location: { href: string }
  document?: { write(html: string): void; close(): void } | null
  closed?: boolean
}

export interface UseMyInstanceDeps {
  /** 接口实现（默认走 `api/instance.ts`；测试注入假实现） */
  fetchInstance?: typeof fetchMyInstance
  start?: typeof startInstance
  stop?: typeof stopInstance
  restart?: typeof restartInstance
  openWindow?: (url: string) => OpenTab | null
  /** SSE 工厂（测试注入） */
  sseFactory?: SseSourceFactory
  /** 启动轮询间隔，默认 300ms */
  pollIntervalMs?: number
  /** 启动超时，默认 90s（10 §C1 要求 ≤60s） */
  startupTimeoutMs?: number
  /** 资源条刷新间隔，默认 10s（07 §6.1） */
  statsIntervalMs?: number
  /** 立即拉一次数据，默认 true */
  immediate?: boolean
  /**
   * 启动时带上的算力规格（13 §6）。返回 null = 不带请求体（计费关闭时的现状）。
   * 用函数而不是值：规格是用户在页面上选的，启动那一刻才确定。
   */
  planId?: () => string | null
}

/**
 * 「打开 DSH」的结果。
 * `busy` = 上一次点击的打开流程还没结束（连点被吞掉，不会再发一个 start）。
 */
export type OpenDshResult = 'opened' | 'blocked' | 'error' | 'busy'

/**
 * 我的 DSH（07 §6.1 / 04 §3.1）：
 * 实例摘要 + 资源 + 启动阶段（SSE）+ 打开/停止/重启。
 *
 * 「打开 DSH」的关键点：未运行时先**同步**开一个空白标签页占位，等容器就绪后再改它的
 * `location.href` —— 否则 `window.open` 发生在 await 之后会被浏览器当成弹窗拦截。
 */
export function useMyInstance(deps: UseMyInstanceDeps = {}) {
  const api = {
    fetchInstance: deps.fetchInstance ?? fetchMyInstance,
    start: deps.start ?? startInstance,
    stop: deps.stop ?? stopInstance,
    restart: deps.restart ?? restartInstance,
  }
  const openWindow = deps.openWindow ?? ((url: string) => window.open(url, '_blank') as OpenTab | null)
  const planId = deps.planId ?? (() => null)

  const instance = shallowRef<InstanceSummary | null>(null)
  const quota = shallowRef<Quota | null>(null)
  const stats = shallowRef<InstanceStats | null>(null)
  const modelSummary = shallowRef<ModelSummary | null>(null)
  const phase = ref<InstancePhase | null>(null)
  const phaseMessage = ref<string | null>(null)
  const loading = ref(false)
  const action = ref<InstanceAction | null>(null)
  const errorText = ref<string | null>(null)
  /** `CAPACITY_FULL` 的详情（`running/max`），供界面拼友好提示 */
  const errorCode = ref<string | null>(null)
  const errorDetails = ref<Record<string, unknown>>({})
  const opening = ref(false)

  const status = computed(() => instance.value?.status ?? 'absent')
  const isRunning = computed(() => status.value === 'running')
  const isBusy = computed(() => status.value === 'starting' || status.value === 'stopping')
  const needsRecreate = computed(() => instance.value?.needsRecreate === true)

  /** 运行中才需要 10 秒刷新的资源条 */
  async function refreshStats(): Promise<void> {
    if (!isRunning.value && !isBusy.value) return
    try {
      const response = await api.fetchInstance()
      instance.value = response.instance
      stats.value = response.stats
      quota.value = response.quota
      modelSummary.value = response.modelSummary
      if (response.instance.status === 'running') {
        phase.value = null
        phaseMessage.value = null
      }
    } catch {
      // 资源条刷新失败不打扰用户：保留上一次的数据
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const response = await api.fetchInstance()
      instance.value = response.instance
      quota.value = response.quota
      stats.value = response.stats
      modelSummary.value = response.modelSummary
      errorText.value = null
      errorCode.value = null
    } catch (error) {
      const described = describeError(error)
      errorText.value = described.message
      errorCode.value = isHubApiError(error) ? error.code : null
    } finally {
      loading.value = false
    }
  }

  function clearError(): void {
    errorText.value = null
    errorCode.value = null
    errorDetails.value = {}
  }

  function captureError(error: unknown): void {
    const described = describeError(error)
    errorText.value = described.message
    errorCode.value = isHubApiError(error) ? error.code : null
    errorDetails.value = isHubApiError(error) ? error.details : {}
  }

  async function run(nextAction: InstanceAction): Promise<boolean> {
    // 单飞：连点「重试 / 启动」只认第一次。上一次请求还没回来就再发一个，服务端虽然有
    // inFlight 去重，但前端没必要多打一个 POST（线上日志里就出现过两个并发的 start）。
    if (action.value !== null) return false
    action.value = nextAction
    clearError()
    try {
      const response =
        nextAction === 'start'
          ? await api.start(planId())
          : nextAction === 'stop'
            ? await api.stop()
            : await api.restart()
      instance.value = response.instance
      if (nextAction !== 'stop') {
        phase.value = 'pulling'
        phaseMessage.value = '正在准备'
      }
      return true
    } catch (error) {
      captureError(error)
      return false
    } finally {
      action.value = null
    }
  }

  /**
   * 轮询等待运行就绪（SSE 负责文字阶段，这里只负责「什么时候可以打开」）。
   *
   * 进循环前先看当前状态：`POST /api/me/instance/start` 在服务端会一直阻塞到容器就绪才返回
   * （返回体里的 `instance.status` 已经是 running），拿到结果后再睡一个轮询间隔纯属白等。
   * 只有服务端确实回了 202 + starting（异步启动）时才需要轮询。
   */
  async function waitUntilRunning(timeoutMs = deps.startupTimeoutMs ?? 90_000): Promise<boolean> {
    if (instance.value?.status === 'running') {
      phase.value = null
      phaseMessage.value = null
      return true
    }

    // 轮询 300ms：就绪后立刻能跳，又不至于让启动期把 /api/me/instance 打得太密
    const interval = deps.pollIntervalMs ?? 300
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      try {
        const response = await api.fetchInstance()
        instance.value = response.instance
        stats.value = response.stats
        quota.value = response.quota
        modelSummary.value = response.modelSummary

        if (response.instance.status === 'running') {
          phase.value = null
          phaseMessage.value = null
          return true
        }
        if (response.instance.status === 'error') {
          errorText.value = response.instance.error ?? '容器启动失败，请稍后重试'
          errorCode.value = 'INSTANCE_START_FAILED'
          return false
        }
      } catch (error) {
        captureError(error)
        return false
      }
    }

    errorText.value = '启动时间有点久，稍后回来看看？'
    return false
  }

  /**
   * 「打开 DSH」：运行中直接开新标签；未运行则先占位再启动，就绪后跳转。
   * 返回 `blocked` 表示浏览器拦了弹窗（界面提示用户手动点链接），
   * `busy` 表示上一次点击的流程还在跑（连点被吞掉，界面不用再提示）。
   */
  async function openDsh(): Promise<OpenDshResult> {
    // 连点/双击：第一次点击在下面同步把 `opening` 置位，第二条链路到这里直接返回。
    // 不挡的话两次点击会各发一个 POST /api/me/instance/start，还会多开一个占位标签页。
    if (opening.value) return 'busy'

    if (isRunning.value && instance.value) {
      const tab = openWindow(instance.value.openUrl)
      return tab ? 'opened' : 'blocked'
    }

    const tab = openWindow('about:blank')
    if (tab?.document) {
      try {
        tab.document.write(
          '<!doctype html><meta charset="utf-8"><title>正在唤醒你的 DSH…</title>' +
            '<body style="font-family:system-ui;display:flex;height:100vh;align-items:center;' +
            'justify-content:center">正在唤醒你的 DSH，请稍候…</body>',
        )
        tab.document.close()
      } catch {
        // 跨域 about:blank 写不了就算了，不影响主流程
      }
    }

    opening.value = true
    try {
      const started = await run('start')
      if (!started) return 'error'

      // start 的 POST 在服务端已经等到容器就绪，返回体里的 status 就是 running：
      // 直接用它的 openUrl 跳过去，不再轮询、也不再拉一次 /api/me/instance。
      // 只有服务端确实回了 202 + starting（异步启动）时才退回轮询。
      if (instance.value?.status === 'running') {
        phase.value = null
        phaseMessage.value = null
      } else if (!(await waitUntilRunning())) {
        return 'error'
      }

      const target = instance.value?.openUrl ?? '/home'
      if (tab) {
        tab.location.href = target
        return 'opened'
      }
      // 占位标签被拦/被关：再试一次同步打开（此时可能被拦，交给界面提示）
      const retry = openWindow(target)
      return retry ? 'opened' : 'blocked'
    } finally {
      opening.value = false
    }
  }

  useSse(MY_INSTANCE_EVENTS_URL, {
    events: {
      status: (payload) => {
        const data = payload as { instance?: InstanceSummary; phase?: InstancePhase; message?: string }
        if (data.instance) instance.value = data.instance
        phase.value = data.phase ?? null
        phaseMessage.value = data.message ?? null
        if (data.instance?.status === 'running') {
          phase.value = null
          phaseMessage.value = null
          void refreshStats()
        }
      },
    },
    ...(deps.sseFactory ? { factory: deps.sseFactory } : {}),
  })

  // 资源条每 10 秒刷新一次，只在运行/切换状态时（07 §6.1）
  useIntervalFn(() => void refreshStats(), deps.statsIntervalMs ?? 10_000)

  if (deps.immediate !== false) onMounted(() => void refresh())

  return {
    instance,
    quota,
    stats,
    modelSummary,
    phase,
    phaseMessage,
    status,
    isRunning,
    isBusy,
    needsRecreate,
    loading,
    action,
    opening,
    errorText,
    errorCode,
    errorDetails,
    refresh,
    refreshStats,
    run,
    start: () => run('start'),
    stop: () => run('stop'),
    restart: () => run('restart'),
    openDsh,
    waitUntilRunning,
    clearError,
  }
}
