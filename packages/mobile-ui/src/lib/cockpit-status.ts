/**
 * `cockpit.status`（WP58 / docs/26 §4.1、§5）：把 App 内部的连接状态合成为「给 Hub 看的阶段」。
 *
 * Hub 只会因为这一步的汇报，才知道「点启动之后到底卡在哪」：容器起来了、App 还没连上、
 * 通道断了要重连……所以这里的判据是**面向父页面**的一层，不是 App 自己的状态机（那个在
 * `stores/chat.ts` / `stores/backend.ts`）。
 *
 * 三个阶段函数都是纯的：
 *  - `cockpitStatusOf(snapshot, hadReady)`：快照 → 阶段（`null` = 还说不清，先不报）；
 *  - `cockpitStatusText(phase)`：阶段 → 一句给人看的中文（不含令牌等敏感信息）；
 *  - `CockpitStatusTracker`：去重（同一 phase 不重复发）+ 「ready 之后才可能 offline」的记忆。
 *
 * 顺序（docs/26 §6 的验收）：冷启动 `auth → waking → connecting → ready`；
 * 断了再连 `ready → offline → ready`。去重靠 `last`，`offline → ready` 能再发是因为 phase 变了。
 */

import type { CockpitStatusPhase } from './cockpit'

/** 合成阶段用的最小快照（全部来自 store，测试里直接给字面量）。 */
export interface CockpitStatusSnapshot {
  /** `auth.isAuthenticated` */
  authenticated: boolean
  /** `backend.wakeState`：'idle' | 'waking' | 'ready' | 'blocked' */
  wakeState: string
  /** 座舱节点可连接（`backend.canUseCloud`） */
  connectable: boolean
  /** `chat.link`：'idle' | 'connecting' | 'connected' | 'closed' | 'failed' … */
  link: string
  /** 模型列表到手（通道 hello 之后 features + catalog 都齐）——差分「连接中」与「能发消息」 */
  modelsReady: boolean
  /** 有明确失败原因（`auth.issue.message`）：容器开不起来 / 容量满 / 开通失败 */
  blockedReason: string | null
}

/** 一条要发给父页面的状态（`message` 可选，phase 一定在）。 */
export interface CockpitStatusUpdate {
  phase: CockpitStatusPhase
  message?: string
}

/**
 * 快照 → 阶段。
 *
 * 判据顺序（先排除、后确认，与 docs/26 §4.1 的表格一一对应）：
 *  1. 没登录（含等父页面交接）→ `auth`；
 *  2. 有明确失败原因 → `blocked`（Hub 显示「启动失败 + 原因」）；
 *  3. 已经 ready 过、现在通道或节点不可用 → `offline`（Hub 认为是「重连中」）；
 *  4. 节点不可连接 → `waking`（座舱容器还在冷启动；App 侧表现是 `wakeState=blocked` 但
 *     **没有** `blockedReason`，所以不能报 blocked）；
 *  5. 通道没连上 → `connecting`；
 *  6. 通道连上但模型列表还没到 → 仍是 `connecting`（此时发消息会被排队的语义）；
 *  7. 全都齐了 → `ready`（能发消息了）。
 */
export function cockpitStatusOf(
  snapshot: CockpitStatusSnapshot,
  hadReady: boolean,
): CockpitStatusPhase | null {
  if (!snapshot.authenticated) return 'auth'
  if (snapshot.blockedReason !== null && snapshot.blockedReason.trim() !== '') return 'blocked'
  if (hadReady && (!snapshot.connectable || snapshot.link !== 'connected')) return 'offline'
  if (!snapshot.connectable) return 'waking'
  if (snapshot.link !== 'connected') return 'connecting'
  if (!snapshot.modelsReady) return 'connecting'
  return 'ready'
}

/** 阶段对应的一句中文（Hub 的加载卡直接用；不含任何敏感信息）。 */
export function cockpitStatusText(phase: CockpitStatusPhase, blockedReason?: string | null): string {
  switch (phase) {
    case 'auth':
      return '正在登录管理座舱…'
    case 'waking':
      return '正在准备 AI 助手容器…'
    case 'connecting':
      return '正在连接对话…'
    case 'ready':
      return '已就绪'
    case 'offline':
      return '连接断开，正在重连…'
    case 'blocked':
      return blockedReason && blockedReason.trim() !== '' ? blockedReason : '助手暂时不可用'
  }
}

/**
 * 状态去重器（有状态，但只记两个字段，单测直接喂快照）。
 *
 * 用法：
 * ```ts
 * const update = tracker.take(snapshot)   // null = 这一拍不用发
 * if (update) post({ type: 'cockpit.status', ...update })
 * ```
 */
export class CockpitStatusTracker {
  private last: CockpitStatusPhase | null = null
  private ready = false

  /** 已经发过的最后一个阶段（诊断 / 单测看）。 */
  get current(): CockpitStatusPhase | null {
    return this.last
  }

  /** 复位（重新挂桥 / 换令牌后从头报一遍）。 */
  reset(): void {
    this.last = null
    this.ready = false
  }

  /**
   * 算这一拍要不要发。**同一 phase 不重复发**；phase 变了就发（`ready → offline → ready` 因此成立）。
   *
   * `message` 只在有内容时附上（`ready` 之类不需要解释的阶段不带）。
   */
  take(snapshot: CockpitStatusSnapshot): CockpitStatusUpdate | null {
    const phase = cockpitStatusOf(snapshot, this.ready)
    if (phase === null) return null
    if (phase === 'ready') this.ready = true
    if (phase === this.last) return null
    this.last = phase
    const reason = phase === 'blocked' ? snapshot.blockedReason : null
    const message = cockpitStatusText(phase, reason)
    return { phase, message }
  }
}
