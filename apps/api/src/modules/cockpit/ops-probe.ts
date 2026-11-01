import type { OpsStatus } from '@dsh-hub/shared'

/**
 * 座舱容器探针（WP56b 实现真实现，WP56a 只定义接口 + 提供测试用的假实现）。
 *
 * 为什么是一个接口而不是直接调 `instances` 服务：座舱是**系统账号 hub-ops 的普通实例**，
 * 容器生命周期（确保存在、令牌轮换、IP 记录）归 WP56b；座舱模块只需要问这几个问题，
 * 这样 WP56a 的全部测试都能在不起容器的情况下跑（`FakeOpsInstanceProbe`）。
 */
export interface OpsInstanceProbe {
  /** 顶栏胶囊与 `GET /state` 用。`autoExecuteR1` 由座舱模块用 settings 覆盖后再返回 */
  status(): Promise<OpsStatus>
  /** `/ops/*` 鉴权：令牌与来源 IP 都必须匹配**当前**座舱容器（两者不符 → 401） */
  verify(token: string, remoteIp: string): boolean
  /** `GET /state` 发现未运行时调用（幂等，不等待就绪） */
  ensureStarted(): Promise<void>
  /** `POST /api/admin/cockpit/ops-instance/restart` */
  restart(): Promise<void>
  /** hub-ops 系统账号 id（审计 actor 用）；未建好时 null */
  systemUserId(): number | null
}

/** 默认探针：座舱容器还没有（WP56b 未装配时的安全默认，`/ops/*` 一律 401） */
export function createUnavailableOpsProbe(reason = '座舱容器尚未装配（等待 WP56b）'): OpsInstanceProbe {
  let status: OpsStatus = { instance: 'missing', model: null, reason, autoExecuteR1: false }
  return {
    async status() {
      return status
    },
    verify() {
      return false
    },
    async ensureStarted() {
      // 没有真实现时什么都不做：`/state` 依旧可用（I6：顶栏胶囊显示原因）
    },
    async restart() {
      status = { ...status, instance: 'missing' }
    },
    systemUserId() {
      return null
    },
  }
}

export interface FakeOpsInstanceProbeOptions {
  /** 座舱令牌（`/ops/*` 的 Bearer）；null = 没有令牌，一律 401 */
  token?: string | null
  /** 座舱容器 IP（来源 IP 校验）；null = 不来者不拒 */
  ip?: string | null
  systemUserId?: number | null
  instance?: OpsStatus['instance']
  model?: string | null
  reason?: string
}

/**
 * 测试/冒烟用的假探针：状态可以随时改，`ensureStarted()`/`restart()` 只是把状态翻成 running。
 * 令牌与 IP 都能在用例里换（测「旧令牌 / 伪造 IP → 401」）。
 */
export class FakeOpsInstanceProbe implements OpsInstanceProbe {
  token: string | null
  ip: string | null
  opsUserId: number | null
  instance: OpsStatus['instance']
  model: string | null
  reason: string | undefined
  /** ensureStarted / restart 被调用的次数（断言「打开 /admin 会自动拉起」用） */
  startCalls = 0
  restartCalls = 0

  constructor(options: FakeOpsInstanceProbeOptions = {}) {
    this.token = options.token ?? null
    this.ip = options.ip ?? null
    this.opsUserId = options.systemUserId ?? null
    this.instance = options.instance ?? 'missing'
    this.model = options.model ?? null
    this.reason = options.reason
  }

  async status(): Promise<OpsStatus> {
    return {
      instance: this.instance,
      model: this.model,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      // 真实值由座舱模块用 settings 覆盖；这里给 false，忘记覆盖时也不会误开自动执行
      autoExecuteR1: false,
    }
  }

  verify(token: string, remoteIp: string): boolean {
    if (this.token === null || this.ip === null) return false
    return token === this.token && remoteIp === this.ip
  }

  async ensureStarted(): Promise<void> {
    this.startCalls += 1
    if (this.instance === 'missing' || this.instance === 'stopped' || this.instance === 'error') {
      this.instance = 'running'
    }
  }

  async restart(): Promise<void> {
    this.restartCalls += 1
    this.instance = 'running'
  }

  systemUserId(): number | null {
    return this.opsUserId
  }
}
