import type { ComputePlan } from '@dsh-hub/shared'
import { ComputePlanIdSchema, computeBlockPriceMicro } from '@dsh-hub/shared'

import { microToPointsInput, pointsToMicro } from '@/utils/points'

/**
 * 管理端「算力租赁 · 规格表」的草稿模型与校验（13 §7）。
 *
 * 抽成纯函数是为了能单独测：价格换算、ID 校验、排序后的 `sort` 规范化都不依赖组件挂载。
 * 价格在表单里按「积分 / 小时」录入，提交时换成微积分；块价格由 shared 的
 * `computeBlockPriceMicro` 算，这里不重复公式。
 */
export interface PlanDraft {
  /** 稳定的行 key（改了 ID 也不丢焦点） */
  key: string
  /** 新建的行 ID 可编辑，已保存的只读 */
  isNew: boolean
  id: string
  name: string
  cpus: number
  memoryMb: number
  /** 「积分 / 小时」的输入文本（0.3 → 300000 微积分） */
  priceText: string
  enabled: boolean
  /** true = 定制规格（`userIds` 非 null） */
  custom: boolean
  userIds: number[]
}

/** 提交时 `sort` 按显示顺序重排为 10 / 20 / 30…（上下移动即可改顺序） */
const SORT_STEP = 10

let draftCounter = 0

/** 新建一行草稿的 key（与 ID 解耦，改 ID 不会让行重新渲染） */
export function nextDraftKey(): string {
  draftCounter += 1
  return `plan-${draftCounter}`
}

export function draftFromPlan(plan: ComputePlan): PlanDraft {
  return {
    key: nextDraftKey(),
    isNew: false,
    id: plan.id,
    name: plan.name,
    cpus: plan.cpus,
    memoryMb: plan.memoryMb,
    priceText: microToPointsInput(plan.pricePerHourMicro),
    enabled: plan.enabled,
    custom: plan.userIds !== null,
    userIds: plan.userIds ?? [],
  }
}

/** 新规格的默认值（2 核 4 GB、0.3 积分/小时） */
export function emptyPlanDraft(): PlanDraft {
  return {
    key: nextDraftKey(),
    isNew: true,
    id: `custom-${draftCounter}`,
    name: '',
    cpus: 2,
    memoryMb: 4096,
    priceText: '0.3',
    enabled: true,
    custom: false,
    userIds: [],
  }
}

/** 输入框里的价格 → 微积分；非法输入返回 null。 */
export function draftPriceMicro(draft: Pick<PlanDraft, 'priceText'>): number | null {
  return pointsToMicro(draft.priceText)
}

/** 输入框里的价格 → 每 10 分钟的价格（微积分）；非法输入返回 null。 */
export function draftBlockPriceMicro(draft: Pick<PlanDraft, 'priceText'>): number | null {
  const price = draftPriceMicro(draft)
  if (price === null) return null
  return computeBlockPriceMicro(price)
}

/** 草稿 → 契约里的规格（`sort` 按数组顺序重排；价格非法时给 -1，校验会先挡住）。 */
export function buildPlanPayload(drafts: PlanDraft[]): ComputePlan[] {
  return drafts.map((draft, index) => ({
    id: draft.id.trim(),
    name: draft.name.trim(),
    cpus: draft.cpus,
    memoryMb: Math.round(draft.memoryMb),
    pricePerHourMicro: draftPriceMicro(draft) ?? -1,
    enabled: draft.enabled,
    userIds: draft.custom ? [...draft.userIds] : null,
    sort: (index + 1) * SORT_STEP,
  }))
}

/**
 * 规格表校验（保存前跑）；返回第一条能直接给用户看的中文错误，没问题返回 null。
 * 逐条给原因而不是笼统「保存失败」，管理员才知道改哪一行。
 */
export function validatePlanDrafts(drafts: PlanDraft[]): string | null {
  if (drafts.length === 0) return '至少保留一个规格'

  const seen = new Set<string>()
  for (const [index, draft] of drafts.entries()) {
    const order = index + 1
    const parsedId = ComputePlanIdSchema.safeParse(draft.id.trim())
    if (!parsedId.success) {
      return `第 ${order} 个规格的 ID 不合法：${parsedId.error.issues[0]?.message ?? '只能用小写字母、数字和 -'}`
    }
    if (seen.has(draft.id.trim())) return `规格 ID 重复：${draft.id.trim()}`
    seen.add(draft.id.trim())

    if (!draft.name.trim()) return `第 ${order} 个规格还没填名称`
    if (draft.name.trim().length > 32) return `「${draft.name}」名称太长了（最多 32 字）`

    const price = draftPriceMicro(draft)
    if (price === null) return `「${draft.name || draft.id}」的价格填得不对：填数字，最多 6 位小数`

    if (!Number.isFinite(draft.cpus) || draft.cpus < 0.5 || draft.cpus > 64) {
      return `「${draft.name}」的核数要在 0.5–64 之间`
    }
    if (!Number.isInteger(draft.memoryMb) || draft.memoryMb < 512 || draft.memoryMb > 262_144) {
      return `「${draft.name}」的内存要在 512–262144 MB 之间`
    }
    if (draft.custom && draft.userIds.length === 0) {
      return `「${draft.name}」是定制规格，至少选一个用户`
    }
  }

  return null
}
