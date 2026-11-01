/**
 * 后端（节点）store：后端列表的**选择**、离线自动回退、云实例唤醒。
 *
 * 从 `auth.ts` 里拆出来（WP46 C）。依赖方向单向：**本 store → auth**，auth 不反过来认识它：
 *  - 后端列表与实例状态来自 auth 的 bootstrap 快照（`auth.backends` / `auth.instance`）；
 *  - 每次 bootstrap 刷新完（作者会换一个新数组）本 store 用 `watch` 自动校正选择 ——
 *    记住的后端不可连接时回退到可连接的，别一开 App 就卡在「后端暂时不可用」；
 *  - 退出登录由 `watch(auth.isAuthenticated)` 自己清空，不需要 auth 反过来调 `reset()`。
 *
 * 唤醒（§4.2）：打开 App 即唤醒；每 1 秒轮询一次 bootstrap，最多 30 秒。
 * 容量满 / 积分不足 / 未开通各有明确提示（`auth.issue` 承载文案）。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  COCKPIT_NODE_ID,
  errorMessage,
  type Backend,
  type BootstrapInstance,
} from '@dsh-hub/mobile-core'
import { issueFromError, type UiIssue } from '@/lib/issue'
import { isCockpitEmbed } from '@/lib/cockpit-embed'
import { gateway, prefs, selectionStore } from '@/lib/instance'
import { clearLastSession } from '@/lib/last-session'
import { recordDiag } from '@/lib/diagnostics'
import { useAuthStore } from './auth'

export type WakeState = 'idle' | 'waking' | 'ready' | 'blocked'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 唤醒轮询窗口：Hub 的云容器冷启动约 11s，30s 足够（超时给可重试提示）。 */
const WAKE_POLL_MS = 1_000
const WAKE_TIMEOUT_MS = 30_000

export const useBackendStore = defineStore('backend', () => {
  const auth = useAuthStore()

  /** 当前选中的后端（持久化在 ordinary preferences，按账号记住）。 */
  const selectedBackendId = ref<string | null>(null)
  const wakeState = ref<WakeState>('idle')
  let wakeInflight: Promise<void> | null = null
  let selecting: Promise<void> | null = null

  const backends = computed<Backend[]>(() => auth.backends)
  const instance = computed<BootstrapInstance | null>(() => auth.instance)
  const selectedBackend = computed<Backend | null>(
    () => backends.value.find((b) => b.id === selectedBackendId.value) ?? null,
  )
  /**
   * 「云后端」这一项：普通形态是 `cloud:self`（用户自己的实例）；
   * 嵌入座舱（WP56d）是固定的 `cloud:ops`（系统账号 hub-ops 的容器，多个管理员共用）。
   */
  const cloudBackend = computed<Backend | null>(
    () =>
      backends.value.find((b) => b.id === (isCockpitEmbed() ? COCKPIT_NODE_ID : 'cloud:self')) ??
      null,
  )
  const desktopBackends = computed(() => backends.value.filter((b) => b.kind === 'desktop'))
  const canUseCloud = computed(() => {
    // 座舱节点没有「用户自己的实例」这一层：connectable 就是全部判据（docs/24 §5：
    // 座舱容器不参与空闲回收，Hub 侧保证它在）。
    if (isCockpitEmbed()) return cloudBackend.value?.connectable === true
    return !!cloudBackend.value?.connectable && instance.value?.status === 'running'
  })
  const isWaking = computed(() => wakeState.value === 'waking')
  const wakeHint = computed(() => {
    if (wakeState.value === 'waking') return '正在唤醒你的助手…'
    if (wakeState.value === 'blocked') return auth.issue?.message ?? '助手暂时不可用'
    if (instance.value?.status === 'starting') return '正在唤醒你的助手…'
    if (instance.value && instance.value.status === 'absent') {
      return '你的助手还没有开通，请联系管理员'
    }
    return ''
  })

  // ── 选择 ────────────────────────────────────────────────────────────────

  /**
   * 校正选择（bootstrap 之后跑）：
   *  - 没选过 / 选的后端已经不在列表里 → 用记住的 → 可连接的 → 云实例 → 第一个；
   *  - 记住的后端现在不可连接 → 回退到可连接的（用户下次可手动选回去）。
   */
  async function ensureSelection(): Promise<void> {
    if (selecting) return selecting
    selecting = doEnsureSelection().finally(() => {
      selecting = null
    })
    return selecting
  }

  async function doEnsureSelection(): Promise<void> {
    if (backends.value.length === 0) return
    const acc = auth.accountKey
    let next = selectedBackendId.value
    if (!next || !backends.value.some((b) => b.id === next)) {
      const remembered = acc ? await selectionStore.getLastBackend(acc) : null
      const rememberedBackend = backends.value.find((b) => b.id === remembered)
      next =
        rememberedBackend?.id ??
        backends.value.find((b) => b.connectable)?.id ??
        cloudBackend.value?.id ??
        backends.value[0]!.id
    }
    const current = backends.value.find((backend) => backend.id === next)
    if (current !== undefined && !current.connectable) {
      const fallback =
        cloudBackend.value?.connectable === true
          ? cloudBackend.value
          : backends.value.find((backend) => backend.connectable)
      if (fallback !== undefined && fallback.id !== current.id) {
        recordDiag('backend:fallback', `${current.id}→${fallback.id}`)
        next = fallback.id
      }
    }
    // 选中的后端变了：模型选择由 models store 自己 watch selectedBackendId 重载。
    if (next !== selectedBackendId.value) selectedBackendId.value = next
  }

  /** 用户主动切换后端（不可连接时只提示，不切）。 */
  async function selectBackend(backendId: string): Promise<void> {
    const backend = backends.value.find((b) => b.id === backendId)
    if (!backend) return
    if (!backend.connectable) {
      auth.setIssue({
        code: 'node-not-connectable',
        message: '这个后端现在不可连接',
        retryable: false,
      })
      return
    }
    if (backendId === selectedBackendId.value) return
    selectedBackendId.value = backendId
    const acc = auth.accountKey
    if (acc) await selectionStore.setLastBackend(acc, backendId)
    // 用户主动换了后端：上次会话属于旧后端，清掉记录（App 冷启动不再尝试恢复）。
    // 注意：ensureSelection 里的「离线自动回退」不走这里，记录会保留。
    void clearLastSession(prefs)
    auth.clearIssue()
    if (backend.kind === 'cloud' && instance.value?.status !== 'running') void ensureAwake()
  }

  // ── 唤醒 ────────────────────────────────────────────────────────────────

  /**
   * 自动唤醒：打开 App 即唤醒。每 1 秒轮询一次 bootstrap，最多 30 秒；
   * 容量满 / 积分不足 / 未开通各有明确提示。同一时刻只跑一份。
   */
  async function ensureAwake(): Promise<void> {
    if (auth.phase !== 'authenticated') return
    if (wakeInflight) return wakeInflight
    wakeInflight = doEnsureAwake().finally(() => {
      wakeInflight = null
    })
    return wakeInflight
  }

  /**
   * 嵌入座舱的「等座舱起来」轮询（WP56e2）。
   *
   * 座舱容器是 `/admin` 打开时才由 Hub 拉起的，冷启动要 60–90 秒；在这之前 `cloud:ops` 的
   * `connectable` 是 false。App 原来只读一次 bootstrap 就定生死（`wakeState=blocked`），
   * 之后既不重试也不刷新 —— 表现就是「输入框能打字、发出去永远在排队」
   * （J11 端到端实测：App store 里 `backends=[{cloud:ops, connectable:false}]` 一直不变）。
   *
   * 这里每 2.5 秒刷一次 bootstrap（最多 5 分钟），`connectable` 一变成 true 就停 —— 之后
   * 选择/通道由既有逻辑接管（`selectedBackendId=cloud:ops` 已在前一步定好）。
   */
  let cockpitPoll: ReturnType<typeof setInterval> | null = null
  const COCKPIT_POLL_MS = 2_500
  const COCKPIT_POLL_MAX_MS = 5 * 60_000

  /**
   * 座舱节点变成可连接：把 `wakeState` 推到 `ready`（WP56e3）。
   *
   * 为什么要动 `wakeState` 而不只是「停止轮询」：App.vue 是靠 `watch(backend.wakeState)`
   * 在 ready 时去 `ensureConnected()` 建通道的。轮询原来只 `stopCockpitPoll()` 就走了，
   * 状态停在 `blocked`，于是容器起来之后**没有任何人去连通道** —— 真链路 e2e 里
   * 「bootstrap 已经是 connectable:true、Hub 却一次 ticket 都没收到」就是这个：
   * 第一次 bootstrap 时容器还在冷启动（connectable:false），之后再也没人重试。
   */
  function markCockpitReady(): void {
    if (!isCockpitEmbed()) return
    if (wakeState.value === 'ready') return
    recordDiag('cockpit:ready', 'connectable')
    wakeState.value = 'ready'
  }

  function stopCockpitPoll(): void {
    if (cockpitPoll !== null) {
      clearInterval(cockpitPoll)
      cockpitPoll = null
    }
  }

  function startCockpitPoll(): void {
    if (!isCockpitEmbed() || cockpitPoll !== null) return
    const startedAt = Date.now()
    cockpitPoll = setInterval(() => {
      if (Date.now() - startedAt > COCKPIT_POLL_MAX_MS) {
        stopCockpitPoll()
        return
      }
      if (!auth.isAuthenticated) {
        stopCockpitPoll()
        return
      }
      if (cloudBackend.value?.connectable === true) {
        markCockpitReady()
        stopCockpitPoll()
        return
      }
      void auth.refreshBootstrap()
    }, COCKPIT_POLL_MS)
  }

  async function doEnsureAwake(): Promise<void> {
    // 嵌入座舱（WP56d）：座舱容器由 Hub 管理（不参与空闲回收，`/admin` 打开时自己拉起），
    // App 这边没有唤醒接口可用（`scope=cockpit` 的令牌调 wake 会被 403）。
    // WP56e2：拿到的 connectable=false 只代表「容器还在起」，要轮询等它（见 startCockpitPoll）。
    if (isCockpitEmbed()) {
      if (cloudBackend.value?.connectable === true) {
        markCockpitReady()
      } else {
        wakeState.value = 'blocked'
        startCockpitPoll()
      }
      return
    }
    // bootstrap 还没回来（后端列表为空）：什么都不做，等它到了再唤醒。
    // 冷启动时 App 会在登录态变化的那一刻就调用这里，此时列表通常还是空的。
    if (backends.value.length === 0) return
    const cloud = cloudBackend.value
    if (!cloud) {
      // 连 `cloud:self` 这一项都没有：不是「没开通」，是账号/契约异常。
      setWakeBlocked({
        code: 'INSTANCE_ABSENT',
        message: errorMessage('INSTANCE_ABSENT'),
        retryable: true,
      })
      return
    }
    if (cloud.connectable && instance.value?.status === 'running') {
      wakeState.value = 'ready'
      return
    }
    // 上线决定 ①：没有实例不再是死路 —— Hub 会在第一次 wake 时自动开通
    // （管理员新建的用户、没有实例的老用户都靠这条；开通中回 202 starting，下面照常轮询）。
    // 所以这里**不再** early-return，而是把状态先置成 waking，交给下面的 wake()。
    wakeState.value = 'waking'
    auth.clearIssue()
    try {
      await gateway.wake()
    } catch (error) {
      setWakeBlocked(issueFromError(error))
      return
    }
    const started = Date.now()
    while (Date.now() - started < WAKE_TIMEOUT_MS) {
      await sleep(WAKE_POLL_MS)
      if (auth.phase !== 'authenticated') return
      await auth.refreshBootstrap()
      if (cloudBackend.value?.connectable && instance.value?.status === 'running') {
        wakeState.value = 'ready'
        return
      }
      if (instanceStatus() === 'absent') {
        // wake 之后还是 absent：Hub 没把实例建起来（开通失败 / 配额 / 竞态）。
        // 用可重试的文案，别把用户钉死在「请联系管理员」。
        setWakeBlocked({
          code: 'INSTANCE_PROVISION_FAILED',
          message: errorMessage('INSTANCE_PROVISION_FAILED'),
          retryable: true,
        })
        return
      }
      if (currentIssue()?.code === 'CAPACITY_FULL') {
        wakeState.value = 'blocked'
        return
      }
    }
    setWakeBlocked({
      code: 'wake-timeout',
      message: errorMessage('wake-timeout'),
      retryable: true,
    })
  }

  /** 唤醒失败：状态 blocked + 把原因交给全局问题条（auth.issue）。 */
  function setWakeBlocked(issue: UiIssue): void {
    wakeState.value = 'blocked'
    auth.setIssue(issue)
  }

  /**
   * 两个读取器：绕过 TS 的**跨 await 收窄**。
   *
   * `instance.value?.status` / `issue` 在函数里被前面某个 `if (... === 'absent') return`
   * 收窄后，TS 会在 `await` 之后仍然保留这个收窄（运行时会变，静态分析不会），于是
   * `status === 'absent'` 被报成「两个类型没有重叠」。用函数调用打断收窄，比到处 `as` 干净。
   */
  const instanceStatus = (): BootstrapInstance['status'] | undefined => instance.value?.status
  const currentIssue = (): UiIssue | null => auth.issue

  /** 唤醒失败后的「重试」：清状态 → 重新拉 bootstrap → 再唤醒一次。 */
  async function retryWake(): Promise<void> {
    wakeState.value = 'idle'
    auth.clearIssue()
    await auth.refreshBootstrap()
    await ensureAwake()
  }

  function reset(): void {
    selectedBackendId.value = null
    wakeState.value = 'idle'
  }

  // ── 上游变化 ────────────────────────────────────────────────────────────

  // bootstrap 刷新（作者每次都给新数组）：校正选择。首次登录/换账号也走这里。
  watch(
    () => auth.backends,
    () => {
      if (!auth.isAuthenticated) return
      void ensureSelection()
    },
  )

  // 退出登录 / 令牌失效：清掉选择与唤醒状态。
  watch(
    () => auth.isAuthenticated,
    (ok) => {
      if (ok) return
      reset()
    },
  )

  /**
   * bootstrap 回来（后端列表就绪）就自动唤醒一次 —— 这是 0.2.x 里
   * `auth.afterAuthenticated → refreshBootstrap → ensureAwake` 的等价接线，
   * 现在靠上游数据的变化驱动，不需要 auth 反过来认识本 store。
   *
   * 只在 `idle` 时自动跑：失败（blocked）等用户点「重试」，不要自己无限重试。
   */
  watch(
    () => auth.backends,
    () => {
      if (!auth.isAuthenticated) return
      // 「云后端可用」用与 `canUseCloud` 完全一致的口径（普通形态 = connectable + 实例 running；
      // 嵌入座舱只看 connectable）。WP56e3 之前这里自己算 `instance.status === 'running'`，
      // 座舱 bootstrap 的 instance 字段与节点可连接性并不总是一致：刚被推成 ready 的状态会被
      // 这里的 `wake:stale` 又打回 idle，而座舱没有唤醒接口 → 通道永远建不起来。
      const cloudUp = canUseCloud.value
      if (isCockpitEmbed() && cloudUp) {
        // 容器冷启动结束：无论之前是 idle 还是 blocked，都算就绪 —— 交给 App.vue
        // 的 `watch(backend.wakeState)` 主动建通道（WP56e3 的 (b) 冷启动路径）。
        markCockpitReady()
        return
      }
      // 唤醒过（ready）之后云实例又不可用了 —— 典型是切后台期间 Hub 把空闲容器休眠了，
      // 回前台刷新 bootstrap 才看到。`ready` 已经过期：退回 idle 重新唤醒，
      // 否则这里永远不再唤醒、通道也一直连不上，只能杀掉 App 重开。
      if (wakeState.value === 'ready' && !cloudUp) {
        recordDiag('wake:stale', instance.value?.status ?? 'unknown')
        wakeState.value = 'idle'
      }
      if (wakeState.value !== 'idle') return
      if (cloudUp) return
      void ensureAwake()
    },
    // 第一个人（登录）也看得到：immediate 会在 store 第一次创建时跑一次（此时多半还没有列表）。
    { immediate: true },
  )

  return {
    // 状态
    selectedBackendId,
    wakeState,
    // 派生
    backends,
    instance,
    selectedBackend,
    cloudBackend,
    desktopBackends,
    canUseCloud,
    wakeHint,
    isWaking,
    // 动作
    ensureSelection,
    selectBackend,
    ensureAwake,
    retryWake,
    reset,
  }
})
