import type { z } from 'zod'
import type {
  CapabilityDescriptor,
  CapabilityRisk,
  CockpitArea,
  ProposalPreview,
  ProposalStatus,
  ProposalView,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../../context.js'

/** 执行者身份（审计 actor 用）。R0/R1 自动执行 = hub-ops；方案执行 = 批准的管理员 */
export interface CapabilityActor {
  id: number
  username: string
}

/** 能力从哪里被调用（只影响审计 detail 与「能不能自动执行」的判断，能力自己不用管） */
export type CapabilityVia = 'ops' | 'proposal' | 'admin'

/**
 * 能力拿得到的座舱自身能力（只有座舱自用的能力需要，如「待处理方案」卡的 dataSource）。
 * 单独抽出来是为了避免 `capabilities/*.ts` 反过来 import `service.ts`（循环依赖）。
 */
export interface CapabilityHost {
  listProposals(query: { status?: ProposalStatus; limit?: number }): ProposalView[]
}

export interface CapabilityContext {
  deps: AppDeps
  actor: CapabilityActor | null
  meta: RequestMeta
  via: CapabilityVia
  /** DSH 会话 id（方案执行与画布卡用） */
  sessionId?: string
  /** 正在执行哪个方案（`via='proposal'` 时有） */
  proposalId?: number
  /** 座舱自身（能力里要读方案列表时用） */
  host: CapabilityHost
}

/** 能力定义（docs/24 §4 的形状；`input` 是 zod，`/ops/catalog` 里换成 JSON Schema） */
export interface CapabilityDefinition {
  id: string
  area: CockpitArea
  title: string
  description: string
  risk: CapabilityRisk
  /** 参数 schema（运行时校验 + 生成 JSON Schema） */
  input: z.ZodType
  /** 这些参数只接受 secretRef（§3.4） */
  secretFields?: string[]
  /** 可作为画布数据源（只能是 R0） */
  dataSource?: boolean
  /** 经典页面对应地址 */
  classicPath?: string
  /** 写类能力必须给：影响面由 Hub 算（I3） */
  preview?: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<ProposalPreview>
  /** 真正干活。返回值会过 `redact()` + 64 KB 截断（I4） */
  run: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<unknown>
}

export interface CapabilitySpec<I> {
  id: string
  area: CockpitArea
  title: string
  description: string
  risk: CapabilityRisk
  input: z.ZodType<I>
  secretFields?: string[]
  dataSource?: boolean
  classicPath?: string
  preview?: (ctx: CapabilityContext, args: I) => Promise<ProposalPreview>
  run: (ctx: CapabilityContext, args: I) => Promise<unknown>
}

export interface CapabilityRegistry {
  get(id: string): CapabilityDefinition | undefined
  list(): CapabilityDefinition[]
  /** `/ops/catalog` 的目录项（input 是 JSON Schema） */
  descriptors(): CapabilityDescriptor[]
  /** 关键词检索（id / title / description 子串，逗号/空格分隔的多个词取「都要命中」） */
  catalog(query?: { q?: string; area?: CockpitArea }): { items: CapabilityDescriptor[]; total: number }
}
