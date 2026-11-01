import { z } from 'zod'
import { IsoDateTimeSchema, PageQuerySchema, pagedOf } from '../common.js'

/**
 * 算力租赁（13）：用户自选规格启动自己的 DSH，按「10 分钟一块」从积分钱包（与中转站共用，12 §6）预扣。
 *
 * 金额一律整数微积分（`*Micro`，1 积分 = 1 元 = 1_000_000 微积分）。
 * 计费总开关 `billingEnabled` 关闭时本模块不做任何事，实例照旧按 `Quota` 免费运行。
 */

/** 计费粒度：每块 10 分钟，不足 10 分钟按 10 分钟算（13 §3） */
export const COMPUTE_BLOCK_MINUTES = 10

/** 每块价格 = ceil(每小时价格 × 10 / 60) */
export function computeBlockPriceMicro(pricePerHourMicro: number): number {
  return Math.ceil((pricePerHourMicro * COMPUTE_BLOCK_MINUTES) / 60)
}

const MicroSchema = z.number().int().nonnegative()
const SignedMicroSchema = z.number().int()

// ── 规格 ────────────────────────────────────────────────────────────────────

export const ComputePlanIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, '规格 ID 只能用小写字母、数字和 -，最长 32 位')

export const ComputePlanSchema = z.object({
  /** 稳定 ID（租约里快照规格，改名改价不影响已开始的租约） */
  id: ComputePlanIdSchema,
  name: z.string().trim().min(1).max(32),
  cpus: z.number().min(0.5).max(64),
  memoryMb: z.number().int().min(512).max(262_144),
  pricePerHourMicro: MicroSchema,
  enabled: z.boolean(),
  /** null = 所有人可选；数组 = 定制规格，只有这些用户看得到 */
  userIds: z.array(z.number().int().positive()).max(200).nullable(),
  sort: z.number().int(),
})
export type ComputePlan = z.infer<typeof ComputePlanSchema>

/** 用户端看到的规格（已按可见性过滤、只含启用的；附每块价格） */
export const MyComputePlanSchema = ComputePlanSchema.pick({
  id: true,
  name: true,
  cpus: true,
  memoryMb: true,
  pricePerHourMicro: true,
}).extend({
  blockPriceMicro: MicroSchema,
  /** 定制规格（userIds 非 null） */
  custom: z.boolean(),
})
export type MyComputePlan = z.infer<typeof MyComputePlanSchema>

// ── 设置（settings 表键 `compute`，由本模块自己读写，不进 SettingsSchema）──────

export const ComputeSettingsSchema = z
  .object({
    /** 计费总开关；关 = 现状（免费、按 Quota） */
    billingEnabled: z.boolean(),
    /** 管理员自己的实例是否也计费 */
    billAdmins: z.boolean(),
    /** 余额 ≤ 0 后继续运行多久再停（不计费） */
    graceMinutes: z.number().int().min(0).max(60),
    /** 计费实例内存准入上限（MB）：运行中实例内存之和 + 新实例 ≤ 它；0 = 不检查（仍受 capacity.maxRunning 约束） */
    capacityMemoryMb: z.number().int().min(0).max(4_194_304),
    /** 规格卡片下方的提示（如「需要更高配置请联系管理员」） */
    contactText: z.string().trim().max(200),
    /**
     * 新用户（以及从没选过规格的用户）默认用的规格（15 §3.1）。
     * null 或指向已停用 / 已删除 / 对该用户不可见的规格时，退回「第一个可选规格」；不做强校验，免得删规格时被它卡住。
     */
    defaultPlanId: ComputePlanIdSchema.nullable(),
    plans: z.array(ComputePlanSchema).max(50),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.plans.forEach((plan, index) => {
      if (seen.has(plan.id)) {
        ctx.addIssue({ code: 'custom', path: ['plans', index, 'id'], message: '规格 ID 重复' })
      }
      seen.add(plan.id)
    })
  })
export type ComputeSettings = z.infer<typeof ComputeSettingsSchema>

export const DEFAULT_COMPUTE_SETTINGS: ComputeSettings = {
  billingEnabled: false,
  billAdmins: false,
  graceMinutes: 10,
  capacityMemoryMb: 0,
  contactText: '需要更高配置？请联系管理员定制。',
  defaultPlanId: 'c2m4',
  plans: [
    { id: 'c2m4', name: '2 核 4 GB', cpus: 2, memoryMb: 4096, pricePerHourMicro: 300_000, enabled: true, userIds: null, sort: 10 },
    { id: 'c4m8', name: '4 核 8 GB', cpus: 4, memoryMb: 8192, pricePerHourMicro: 500_000, enabled: true, userIds: null, sort: 20 },
    { id: 'c8m16', name: '8 核 16 GB', cpus: 8, memoryMb: 16_384, pricePerHourMicro: 1_000_000, enabled: true, userIds: null, sort: 30 },
  ],
}

export const ComputeSettingsResponseSchema = z.object({
  settings: ComputeSettingsSchema,
  host: z.object({
    /** /proc/meminfo MemTotal（MB） */
    memTotalMb: z.number().int().nonnegative(),
    /** 当前运行/启动中实例占用的内存之和（MB；有租约用租约规格，否则用 Quota） */
    committedMemoryMb: z.number().int().nonnegative(),
  }),
})
export type ComputeSettingsResponse = z.infer<typeof ComputeSettingsResponseSchema>

/** PATCH：只改给出的字段；`plans` 给出时整体替换 */
export const UpdateComputeSettingsRequestSchema = z.object({
  billingEnabled: z.boolean().optional(),
  billAdmins: z.boolean().optional(),
  graceMinutes: z.number().int().min(0).max(60).optional(),
  capacityMemoryMb: z.number().int().min(0).max(4_194_304).optional(),
  contactText: z.string().trim().max(200).optional(),
  defaultPlanId: ComputePlanIdSchema.nullable().optional(),
  plans: z.array(ComputePlanSchema).max(50).optional(),
})
export type UpdateComputeSettingsRequest = z.infer<typeof UpdateComputeSettingsRequestSchema>

// ── 租约 ────────────────────────────────────────────────────────────────────

/**
 * 租约结束原因：user 用户停止 / admin 管理员停止 / idle 空闲回收 / insufficient 余额不足宽限到期 /
 * crash 容器异常或启动失败 / plan-change 切换规格 / billing-off 计费总开关被关 / system 对账发现实例已不在运行
 */
export const ComputeLeaseEndReasonSchema = z.enum([
  'user',
  'admin',
  'idle',
  'insufficient',
  'crash',
  'plan-change',
  'billing-off',
  'system',
])
export type ComputeLeaseEndReason = z.infer<typeof ComputeLeaseEndReasonSchema>

export const ComputeLeaseSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  planId: z.string(),
  /** 以下四项是开租时的规格快照 */
  planName: z.string(),
  cpus: z.number(),
  memoryMb: z.number().int(),
  pricePerHourMicro: MicroSchema,
  blockPriceMicro: MicroSchema,
  /** false = 免费租约（管理员本人且 billAdmins=false，或管理员代为启动） */
  billed: z.boolean(),
  startedAt: IsoDateTimeSchema,
  /** 已付费到何时（下一次扣费时刻）；免费租约为 null */
  paidUntil: IsoDateTimeSchema.nullable(),
  /** 余额不足进入宽限：到这个时刻还没充值就停机；不在宽限中为 null */
  graceUntil: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  endReason: ComputeLeaseEndReasonSchema.nullable(),
  /** 已扣块数与金额 */
  blocks: z.number().int().nonnegative(),
  chargedMicro: MicroSchema,
})
export type ComputeLease = z.infer<typeof ComputeLeaseSchema>

export const ComputeLeaseRowSchema = ComputeLeaseSchema.extend({ username: z.string() })
export type ComputeLeaseRow = z.infer<typeof ComputeLeaseRowSchema>

// ── 用户端 ──────────────────────────────────────────────────────────────────

export const MyComputeResponseSchema = z.object({
  billingEnabled: z.boolean(),
  /** 本人不计费（管理员且 billAdmins=false） */
  exempt: z.boolean(),
  plans: z.array(MyComputePlanSchema),
  /** 下次启动默认用的规格（上次选的；没选过 = settings.defaultPlanId（可选时）→ 第一个可选规格；没有可选规格 = null） */
  selectedPlanId: z.string().nullable(),
  /** 当前租约（实例没在跑或计费关闭时为 null） */
  lease: ComputeLeaseSchema.nullable(),
  balanceMicro: SignedMicroSchema,
  /** 余额中「今日赠送」还没用掉的部分（不累计，次日首次登录时作废并重新发放） */
  dailyBonusLeftMicro: MicroSchema,
  /** 每日赠送额度（0 = 未开启） */
  dailyBonusMicro: MicroSchema,
  blockMinutes: z.literal(COMPUTE_BLOCK_MINUTES),
  graceMinutes: z.number().int(),
  contactText: z.string(),
})
export type MyComputeResponse = z.infer<typeof MyComputeResponseSchema>

/** 选规格：实例停止时只记住；运行中则结束旧租约、按新规格重建并开新租约（先扣一块） */
export const SelectComputePlanRequestSchema = z.object({ planId: ComputePlanIdSchema })
export type SelectComputePlanRequest = z.infer<typeof SelectComputePlanRequestSchema>

export const SelectComputePlanResponseSchema = z.object({
  compute: MyComputeResponseSchema,
  /** 是否因此重启了实例 */
  restarted: z.boolean(),
})
export type SelectComputePlanResponse = z.infer<typeof SelectComputePlanResponseSchema>

/** `POST /api/me/instance/start` 的可选请求体（无请求体 = 用 selectedPlanId；唤醒页就是这样调） */
export const InstanceStartRequestSchema = z.object({ planId: ComputePlanIdSchema.optional() })
export type InstanceStartRequest = z.infer<typeof InstanceStartRequestSchema>

export const ComputeLeaseQuerySchema = PageQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  /** true = 只看进行中的 */
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})
export type ComputeLeaseQuery = z.infer<typeof ComputeLeaseQuerySchema>

export const ComputeLeaseListResponseSchema = pagedOf(ComputeLeaseRowSchema)
export type ComputeLeaseListResponse = z.infer<typeof ComputeLeaseListResponseSchema>
