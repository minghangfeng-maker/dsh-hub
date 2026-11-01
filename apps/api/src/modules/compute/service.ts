import { readFileSync } from 'node:fs'
import {
  COMPUTE_BLOCK_MINUTES,
  computeBlockPriceMicro,
  type ComputeLease,
  type ComputeLeaseEndReason,
  type ComputeLeaseListResponse,
  type ComputeLeaseQuery,
  type ComputeLeaseRow,
  type ComputePlan,
  type ComputeSettings,
  type ComputeSettingsResponse,
  type MyComputePlan,
  type MyComputeResponse,
  type SelectComputePlanResponse,
  type UpdateComputeSettingsRequest,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { InternalInstanceService } from '../instances/service.js'
import type { ComputeSpec, StartReason } from '../instances/types.js'
import type { RelayService } from '../relay/types.js'
import {
  endComputeLease,
  findActiveLease,
  findLatestEndedLease,
  getComputePref,
  insertComputeLease,
  isBillingExempt,
  listActiveLeases,
  listComputeLeaseRows,
  toComputeLease,
  upsertComputePref,
  updateComputeLease,
  type ComputeLeaseDbRow,
} from './repo.js'
import { createComputeSettingsStore } from './settings-store.js'
import type { ComputeService } from './types.js'

/** 结算间隔（13 §3：每 30 秒一轮；`testing` 下不自动跑） */
export const COMPUTE_TICK_INTERVAL_MS = 30_000
/** 一块 10 分钟的毫秒数 */
const BLOCK_MS = COMPUTE_BLOCK_MINUTES * 60_000

/**
 * 算力租赁服务（13）：规格解析、启动准入、开/结束租约、30 秒结算、用户端与管理端查询，
 * 以及 instances 模块晚绑定调用的 `ComputeHooks`。
 *
 * 注意：`beforeStart` / `onRunning` / `onStopped` / `currentSpec` **在用户的实例锁内被调用**，
 * 这里绝不能调 `instances.stop` / `ensureRunning` / `withUserLock`（会死锁）；只有 `tick`
 * 在锁外调 `instances.stop`。
 */
export function createComputeService(deps: BaseDeps): ComputeService {
  const db = deps.db
  const clock = deps.clock

  const settingsStore = createComputeSettingsStore(db, {
    onWarn: (message, detail) => deps.logger.warn({ detail }, message),
  })
  /** 串行化 tick：上一轮没跑完就复用同一个 Promise（13 §3） */
  let tickPromise: Promise<void> | null = null
  let timer: NodeJS.Timeout | null = null

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function relay(): RelayService {
    const service = services().relay
    if (!service) throw new HubError('INTERNAL', 'relay 服务未装配')
    return service
  }

  function instances(): InternalInstanceService {
    const service = services().instances as InternalInstanceService | undefined
    if (!service) throw new HubError('INTERNAL', 'instances 服务未装配')
    return service
  }

  function nowIso(): string {
    return clock.nowIso()
  }

  // ── 规格解析（13 §6.2）────────────────────────────────────────────────────

  function visiblePlans(userId: number): ComputePlan[] {
    return settingsStore
      .get()
      .plans.filter((plan) => plan.enabled && (plan.userIds === null || plan.userIds.includes(userId)))
      .sort((a, b) => a.sort - b.sort)
  }

  function toMyPlan(plan: ComputePlan): MyComputePlan {
    return {
      id: plan.id,
      name: plan.name,
      cpus: plan.cpus,
      memoryMb: plan.memoryMb,
      pricePerHourMicro: plan.pricePerHourMicro,
      blockPriceMicro: computeBlockPriceMicro(plan.pricePerHourMicro),
      custom: plan.userIds !== null,
    }
  }

  /**
   * 下次启动用的规格（15 §3.1）：自己选过且仍可选 → 它；否则 settings.defaultPlanId
   * 对该用户可选 → 它；否则第一个可选；一个都没有 = null。
   * `defaultPlanId` 不做存在性强校验（可能指向已停用/删除/别人的定制规格），所以这里兜底。
   */
  function preferredPlanId(userId: number, plans = visiblePlans(userId)): string | null {
    const saved = getComputePref(db, userId)
    if (saved !== null && plans.some((plan) => plan.id === saved)) return saved
    const defaultPlanId = settingsStore.get().defaultPlanId
    if (defaultPlanId !== null && plans.some((plan) => plan.id === defaultPlanId)) return defaultPlanId
    return plans[0]?.id ?? null
  }

  function requireSelectablePlan(userId: number, planId: string): ComputePlan {
    const plan = visiblePlans(userId).find((item) => item.id === planId)
    if (!plan) {
      throw new HubError('VALIDATION_FAILED', '所选规格不可用', { fields: { planId: '该规格不可选' } })
    }
    return plan
  }

  /** 启动时要用的规格：请求的规格（校验过）或已选规格；计费开启却一个可选规格都没有 → 409 */
  function resolveStartPlan(userId: number, planId?: string): ComputePlan {
    if (planId !== undefined) return requireSelectablePlan(userId, planId)
    const plans = visiblePlans(userId)
    const id = preferredPlanId(userId, plans)
    const plan = id === null ? undefined : plans.find((item) => item.id === id)
    if (!plan) throw new HubError('CONFLICT', '暂无可用规格，请联系管理员')
    return plan
  }

  function exempt(userId: number, settings = settingsStore.get()): boolean {
    return isBillingExempt(db, userId, settings.billAdmins)
  }

  // ── 租约与容量 ────────────────────────────────────────────────────────────

  function activeLeaseRow(userId: number): ComputeLeaseDbRow | undefined {
    return findActiveLease(db, userId)
  }

  function activeLeaseOf(userId: number): ComputeLease | null {
    const row = activeLeaseRow(userId)
    return row ? toComputeLease(row) : null
  }

  function activeLeaseMap(): Map<number, ComputeLease> {
    const map = new Map<number, ComputeLease>()
    for (const row of listActiveLeases(db)) map.set(row.user_id, toComputeLease(row))
    return map
  }

  /** 运行中/启动中实例的内存之和（有租约用租约，否则用 Quota；可排除某个用户） */
  async function committedMemoryMb(excludeUserId?: number): Promise<number> {
    const leases = activeLeaseMap()
    let total = 0
    for (const row of await instances().listForAdmin()) {
      if (row.user.id === excludeUserId) continue
      if (row.status !== 'running' && row.status !== 'starting') continue
      total += leases.get(row.user.id)?.memoryMb ?? row.quota.memoryMb
    }
    return total
  }

  /** 内存准入（13 §4）：Σ（别人的运行中/启动中内存）+ 本次规格 ≤ capacityMemoryMb */
  async function assertCapacity(userId: number, requestMb: number): Promise<void> {
    const capacityMb = settingsStore.get().capacityMemoryMb
    if (capacityMb <= 0) return
    const committedMb = await committedMemoryMb(userId)
    if (committedMb + requestMb > capacityMb) {
      throw new HubError('CAPACITY_FULL', '内存容量不足，暂时无法启动', {
        committedMb,
        requestMb,
        capacityMb,
      })
    }
  }

  function audit(userId: number, action: string, targetId: number, detail: Record<string, unknown>): void {
    deps.audit.log({
      actorId: userId,
      action,
      targetType: 'compute.lease',
      targetId,
      detail,
    })
  }

  function endLease(lease: ComputeLeaseDbRow, reason: ComputeLeaseEndReason): void {
    const at = nowIso()
    endComputeLease(db, lease.id, reason, at)
    audit(lease.user_id, 'compute.lease.end', lease.id, {
      planId: lease.plan_id,
      billed: lease.billed === 1,
      reason,
      blocks: lease.blocks,
      charged: lease.charged,
    })
  }

  // ── 设置（13 §6）──────────────────────────────────────────────────────────

  function memTotalMb(): number {
    try {
      const text = readFileSync('/proc/meminfo', 'utf8')
      const matched = /^MemTotal:\s+(\d+)\s+kB$/mu.exec(text)
      return matched ? Math.round(Number(matched[1]) / 1024) : 0
    } catch {
      return 0
    }
  }

  async function settingsResponse(): Promise<ComputeSettingsResponse> {
    return {
      settings: settingsStore.get(),
      host: {
        memTotalMb: memTotalMb(),
        committedMemoryMb: await committedMemoryMb(),
      },
    }
  }

  /** 校验并记住规格（`POST start` 带 planId 时先走它：即使实例已在运行也返回 400 而不是静默忽略） */
  function rememberPlan(userId: number, planId: string): void {
    const plan = requireSelectablePlan(userId, planId)
    upsertComputePref(db, userId, plan.id, nowIso())
  }

  // ── ComputeHooks（13 §4）──────────────────────────────────────────────────

  function currentSpec(userId: number): ComputeSpec | null {
    const lease = activeLeaseRow(userId)
    if (lease) return { cpus: lease.cpus, memoryMb: lease.memory_mb }
    const settings = settingsStore.get()
    if (!settings.billingEnabled) return null
    const plans = visiblePlans(userId)
    const id = preferredPlanId(userId, plans)
    const plan = id === null ? undefined : plans.find((item) => item.id === id)
    return plan ? { cpus: plan.cpus, memoryMb: plan.memoryMb } : null
  }

  async function beforeStart(userId: number, ctx: { reason: StartReason; planId?: string }): Promise<void> {
    const settings = settingsStore.get()
    if (!settings.billingEnabled) {
      // 计费关闭：一切照旧；只记住用户给的规格（13 §6 PUT 的「停止中只记住」同理）
      if (ctx.planId !== undefined) {
        const plan = requireSelectablePlan(userId, ctx.planId)
        upsertComputePref(db, userId, plan.id, nowIso())
      }
      return
    }
    // 已有进行中租约（restart/recreate 重建容器）沿用旧租约：不重复收钱、不查余额/容量，
    // 也不要求规格现在仍然可选（管理员可能已经停用了该规格，13 §4）
    if (activeLeaseRow(userId)) {
      relay().grantDailyBonus(userId)
      return
    }
    // 先校验请求的规格，避免无效请求带来赠送副作用
    const requested = ctx.planId === undefined ? null : requireSelectablePlan(userId, ctx.planId)
    if (requested === null && visiblePlans(userId).length === 0) {
      throw new HubError('CONFLICT', '暂无可用规格，请联系管理员')
    }
    relay().grantDailyBonus(userId)
    const plan = requested ?? resolveStartPlan(userId)
    upsertComputePref(db, userId, plan.id, nowIso())
    // 管理员代启动 / rollout 启动原本停止的实例 = 免费租约（13 §4），不查用户余额
    const freeStart =
      ctx.reason === 'admin' ||
      ctx.reason === 'rollout' ||
      ctx.reason === 'idle' ||
      ctx.reason === 'insufficient'
    if (!freeStart && !exempt(userId, settings)) {
      const blockPriceMicro = computeBlockPriceMicro(plan.pricePerHourMicro)
      const balanceMicro = relay().getBalance(userId)
      if (balanceMicro < blockPriceMicro) {
        throw new HubError('INSUFFICIENT_POINTS', undefined, { balanceMicro, blockPriceMicro })
      }
    }
    await assertCapacity(userId, plan.memoryMb)
  }

  function onRunning(userId: number, ctx: { reason: StartReason }): void {
    if (!settingsStore.get().billingEnabled) return
    if (activeLeaseRow(userId)) return
    const plans = visiblePlans(userId)
    const id = preferredPlanId(userId, plans)
    const plan = id === null ? undefined : plans.find((item) => item.id === id)
    if (!plan) {
      // 正常路径在 beforeStart 已经 409；只有异常恢复才会走到这里
      deps.logger.warn({ userId }, '实例进入 running 但没有可用规格，未开算力租约')
      return
    }
    // 管理员代启动 / rollout 启动原本停止的实例：免费租约（13 §4）；管理员本人且 billAdmins=false 也免费
    const billed =
      ctx.reason === 'admin' ||
      ctx.reason === 'rollout' ||
      ctx.reason === 'idle' ||
      ctx.reason === 'insufficient'
        ? false
        : !exempt(userId)
    const at = nowIso()
    const nowMs = clock.now().getTime()
    const blockPriceMicro = computeBlockPriceMicro(plan.pricePerHourMicro)
    db.tx(() => {
      let paidUntil: string | null = null
      let blocks = 0
      let charged = 0
      if (billed) {
        const previous = findLatestEndedLease(db, userId)
        const previousPaidUntil = previous?.paid_until ? Date.parse(previous.paid_until) : Number.NaN
        // 续接：停了马上再开、规格相同且上一块还没到期 → 继承 paid_until，不重复收钱（13 §3）
        if (
          previous &&
          previous.plan_id === plan.id &&
          Number.isFinite(previousPaidUntil) &&
          previousPaidUntil > nowMs
        ) {
          paidUntil = previous.paid_until
        } else {
          relay().chargeCompute(userId, blockPriceMicro, `${plan.name} ${COMPUTE_BLOCK_MINUTES} 分钟`)
          paidUntil = new Date(nowMs + BLOCK_MS).toISOString()
          blocks = 1
          charged = blockPriceMicro
        }
      }
      const leaseId = insertComputeLease(db, {
        userId,
        planId: plan.id,
        planName: plan.name,
        cpus: plan.cpus,
        memoryMb: plan.memoryMb,
        pricePerHourMicro: plan.pricePerHourMicro,
        blockPriceMicro,
        billed,
        startReason: ctx.reason,
        startedAt: at,
        paidUntil,
        blocks,
        charged,
        at,
      })
      audit(userId, 'compute.lease.start', leaseId, {
        planId: plan.id,
        billed,
        reason: ctx.reason,
        blocks,
        charged,
      })
    })
  }

  function onStopped(userId: number, reason: ComputeLeaseEndReason): void {
    const row = activeLeaseRow(userId)
    if (row) endLease(row, reason)
  }

  // ── 结算 tick（13 §3）─────────────────────────────────────────────────────

  async function processLease(lease: ComputeLease, nowMs: number): Promise<void> {
    const settings = settingsStore.get()
    const status = instances().currentStatus(lease.userId)
    // 实例已不在 running/starting（对账之外的外部变化）→ 结束 system
    if (status !== 'running' && status !== 'starting') {
      const row = activeLeaseRow(lease.userId)
      if (row && row.id === lease.id) endLease(row, 'system')
      return
    }
    if (!settings.billingEnabled) {
      // 总开关从开到关：结束所有**计费**租约，实例不停（13 §3）
      const row = activeLeaseRow(lease.userId)
      if (row && row.id === lease.id && row.billed === 1) endLease(row, 'billing-off')
      return
    }
    if (!lease.billed) return

    let paidUntilMs = lease.paidUntil === null ? Number.NaN : Date.parse(lease.paidUntil)
    if (!Number.isFinite(paidUntilMs)) paidUntilMs = nowMs
    let graceUntil = lease.graceUntil
    let blocks = lease.blocks
    let charged = lease.chargedMicro
    const at = nowIso()

    while (nowMs >= paidUntilMs) {
      const balance = relay().getBalance(lease.userId)
      if (balance <= 0) {
        if (graceUntil === null) {
          graceUntil = new Date(nowMs + settings.graceMinutes * 60_000).toISOString()
          updateComputeLease(db, lease.id, { graceUntil }, at)
          deps.logger.info(
            { userId: lease.userId, leaseId: lease.id, graceUntil },
            '算力余额不足，进入宽限期',
          )
        }
        const graceMs = graceUntil === null ? Number.NaN : Date.parse(graceUntil)
        if (Number.isFinite(graceMs) && nowMs >= graceMs) {
          // 宽限到期：在锁外调 instances.stop（它会拿用户锁；13 §4/§3）
          await instances().stop(lease.userId, { reason: 'insufficient' })
          // onStopped 正常已经结束租约；若实例本来就不在 running（onStopped 没触发）这里兜底
          const row = activeLeaseRow(lease.userId)
          if (row && row.id === lease.id) endLease(row, 'insufficient')
        }
        return
      }
      // 余额 > 0：扣一块。宽限中充值 → paid_until 从**现在**起算（宽限期免费）
      paidUntilMs = graceUntil === null ? paidUntilMs + BLOCK_MS : nowMs + BLOCK_MS
      graceUntil = null
      blocks += 1
      charged += lease.blockPriceMicro
      // 扣费与推进 paid_until 必须同一事务：中途崩溃不能留下「扣了钱但没推进」导致下一轮重复扣
      db.tx(() => {
        relay().chargeCompute(
          lease.userId,
          lease.blockPriceMicro,
          `${lease.planName} ${COMPUTE_BLOCK_MINUTES} 分钟`,
        )
        updateComputeLease(
          db,
          lease.id,
          { paidUntil: new Date(paidUntilMs).toISOString(), graceUntil: null, blocks, charged },
          at,
        )
      })
      deps.logger.debug(
        { userId: lease.userId, leaseId: lease.id, blocks, balanceAfter: relay().getBalance(lease.userId) },
        '算力扣费一块',
      )
    }
  }

  async function runTick(): Promise<void> {
    const nowMs = clock.now().getTime()
    // 复制一份：本轮里租约可能被 onStopped 结束，不能影响快照
    const leases = listActiveLeases(db).map(toComputeLease)
    for (const lease of leases) {
      try {
        await processLease(lease, nowMs)
      } catch (error) {
        // 单个用户扣费/停机失败（例如钱包停用、锁超时）不能中断整轮（任务书 §注意）
        deps.logger.warn({ err: error, userId: lease.userId, leaseId: lease.id }, '算力结算失败，跳过该用户')
      }
    }
  }

  function tick(): Promise<void> {
    if (tickPromise) return tickPromise
    tickPromise = runTick().finally(() => {
      tickPromise = null
    })
    return tickPromise
  }

  // ── 用户端 / 管理端 ───────────────────────────────────────────────────────

  function myCompute(userId: number): MyComputeResponse {
    const settings = settingsStore.get()
    const plans = visiblePlans(userId)
    const status = instances().currentStatus(userId)
    const leaseRow =
      settings.billingEnabled && (status === 'running' || status === 'starting')
        ? activeLeaseRow(userId)
        : undefined
    const wallet = relay().getWalletRow(userId)
    return {
      billingEnabled: settings.billingEnabled,
      exempt: exempt(userId, settings),
      plans: plans.map(toMyPlan),
      selectedPlanId: preferredPlanId(userId, plans),
      lease: leaseRow ? toComputeLease(leaseRow) : null,
      balanceMicro: wallet.balanceMicro,
      dailyBonusLeftMicro: wallet.dailyBonusLeftMicro ?? 0,
      dailyBonusMicro: relay().getSettings().dailyBonusMicro,
      blockMinutes: COMPUTE_BLOCK_MINUTES,
      graceMinutes: settings.graceMinutes,
      contactText: settings.contactText,
    }
  }

  function toLeaseRow(row: ComputeLeaseDbRow & { username: string }): ComputeLeaseRow {
    return { ...toComputeLease(row), username: row.username }
  }

  function listMyLeases(userId: number, query: ComputeLeaseQuery): ComputeLeaseListResponse {
    const { rows, total } = listComputeLeaseRows(db, {
      userId,
      ...(query.active === undefined ? {} : { active: query.active }),
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return { items: rows.map(toLeaseRow), total, page: query.page, pageSize: query.pageSize }
  }

  function listAdminLeases(query: ComputeLeaseQuery): ComputeLeaseListResponse {
    const { rows, total } = listComputeLeaseRows(db, {
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.active === undefined ? {} : { active: query.active }),
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return { items: rows.map(toLeaseRow), total, page: query.page, pageSize: query.pageSize }
  }

  /**
   * 换规格（13 §4、§6）：停止中/计费关闭 → 只记住；运行中且规格真的变了 →
   * 准入（余额 + 内存）→ 结束旧租约 plan-change → recreate → 新租约（扣第一块）。
   */
  async function selectPlan(userId: number, planId: string): Promise<SelectComputePlanResponse> {
    const settings = settingsStore.get()
    const plan = requireSelectablePlan(userId, planId)
    const previousSelected = preferredPlanId(userId)
    if (!settings.billingEnabled || instances().currentStatus(userId) !== 'running') {
      // 停止中 / 计费关闭：只记住（13 §6）
      upsertComputePref(db, userId, plan.id, nowIso())
      return { compute: myCompute(userId), restarted: false }
    }
    const lease = activeLeaseRow(userId)
    const changed = lease ? lease.plan_id !== plan.id : previousSelected !== plan.id
    if (!changed) return { compute: myCompute(userId), restarted: false }

    // 先做准入（余额按新规格的块价、内存按新规格减去自己当前占用）；失败时不动旧租约
    if (!exempt(userId, settings)) {
      const blockPriceMicro = computeBlockPriceMicro(plan.pricePerHourMicro)
      const balanceMicro = relay().getBalance(userId)
      if (balanceMicro < blockPriceMicro) {
        throw new HubError('INSUFFICIENT_POINTS', undefined, { balanceMicro, blockPriceMicro })
      }
    }
    await assertCapacity(userId, plan.memoryMb)
    // recreate 的 beforeStart 会重新解析规格，所以先把新规格写进偏好
    upsertComputePref(db, userId, plan.id, nowIso())
    if (lease) endLease(lease, 'plan-change')
    // recreate 会在内部再走 beforeStart（重新校验余额/容量，并发放每日赠送）与 onRunning（开新租约）
    await instances().recreate(userId, { reason: 'user' })
    return { compute: myCompute(userId), restarted: true }
  }

  // ── 定时器与返回 ─────────────────────────────────────────────────────────

  function startScheduler(): void {
    if (timer) return
    timer = setInterval(() => {
      void tick().catch((error: unknown) => {
        deps.logger.warn({ err: error }, '算力结算 tick 失败')
      })
    }, COMPUTE_TICK_INTERVAL_MS)
    timer.unref?.()
  }

  function stopScheduler(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    getSettings(): ComputeSettings {
      return settingsStore.get()
    },
    settingsResponse,
    async updateSettings(
      patch: UpdateComputeSettingsRequest,
      actorId: number,
      meta: RequestMeta,
    ): Promise<ComputeSettingsResponse> {
      const before = settingsStore.get()
      const next = settingsStore.update(patch, clock.nowIso())
      const defaultPlanChanged =
        patch.defaultPlanId !== undefined && before.defaultPlanId !== next.defaultPlanId
      deps.audit.log({
        actorId,
        actorIp: meta.ip,
        action: 'compute.settings.update',
        targetType: 'compute.settings',
        targetId: null,
        detail: {
          fields: Object.keys(patch),
          billingEnabled:
            patch.billingEnabled === undefined
              ? undefined
              : { from: before.billingEnabled, to: next.billingEnabled },
          // 只有真的改了才带，免得同一份 PATCH 重复提交时审计里看不出差异（15 §3.1）
          ...(defaultPlanChanged
            ? { defaultPlanId: { from: before.defaultPlanId, to: next.defaultPlanId } }
            : {}),
          plansReplaced: patch.plans !== undefined,
        },
      })
      return {
        settings: next,
        host: {
          memTotalMb: memTotalMb(),
          committedMemoryMb: await committedMemoryMb(),
        },
      }
    },
    myCompute,
    grantDailyBonus(userId: number): number {
      return relay().grantDailyBonus(userId)
    },
    listMyLeases,
    listAdminLeases,
    selectPlan,
    rememberPlan,
    activeLeaseOf,
    activeLeaseMap,
    currentSpec,
    beforeStart,
    onRunning,
    onStopped,
    tick,
    startScheduler,
    stopScheduler,
  }
}
