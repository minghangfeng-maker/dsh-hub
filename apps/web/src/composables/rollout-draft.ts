import type {
  RolloutAction,
  RolloutKind,
  RolloutPreviewRequest,
  RolloutRequest,
  Strategy,
  Targets,
  UserStatus,
} from '@dsh-hub/shared'

/**
 * 下发向导的草稿与请求体组装（07 §7.8、04 §4.8）。
 *
 * 纯逻辑放这里（步骤校验 + `Targets` / `Strategy` / 请求体组装），页面只负责渲染与调用，
 * 这样「步骤校验与请求体组装」可以直接单测。
 *
 * WP12：模型下发的选中集合改由「模型 → 下发到 DSH」维护，向导里不再选预设，
 * 请求体里也不带 `presetId`（12 §7.0）。
 */
export type TargetMode = 'all' | 'users' | 'filter'

export interface RolloutFilter {
  status?: UserStatus
  runtimeId?: number
  presetId?: number
  pluginId?: number
}

export interface RolloutDraft {
  kind: RolloutKind
  /** 仅 kind=plugin 时有意义 */
  action: RolloutAction
  pluginId: number | null
  versionId: number | null
  runtimeId: number | null
  targetMode: TargetMode
  userIds: number[]
  filter: RolloutFilter
  strategy: Strategy
}

export const DEFAULT_STRATEGY: Strategy = {
  concurrency: 3,
  canary: 1,
  maxFailureRatio: 0.2,
  restart: 'now',
}

export function createDraft(partial: Partial<RolloutDraft> = {}): RolloutDraft {
  const draft: RolloutDraft = {
    kind: 'plugin',
    action: 'install',
    pluginId: null,
    versionId: null,
    runtimeId: null,
    targetMode: 'all',
    userIds: [],
    filter: {},
    strategy: { ...DEFAULT_STRATEGY },
    ...partial,
  }

  return draft
}

/** 步骤编号（与 `NSteps` 一致）：0 动作 / 1 目标 / 2 策略 / 3 预览。 */
export type WizardStep = 0 | 1 | 2 | 3

/** 某一步的校验错误（空数组 = 可以进入下一步）。 */
export function validateStep(step: WizardStep, draft: RolloutDraft): string[] {
  const errors: string[] = []

  if (step === 0) {
    if (draft.kind === 'plugin') {
      if (draft.pluginId === null) {
        errors.push('请选择要下发的插件')
      } else if ((draft.action === 'install' || draft.action === 'upgrade') && draft.versionId === null) {
        // 版本列表依赖插件，未选插件时不重复报错
        errors.push('安装 / 升级需要指定版本')
      }
    }
    if (draft.kind === 'runtime' && draft.runtimeId === null) errors.push('请选择要升级到的 DSH 版本')
    // kind=models 不需要选项：勾选与默认模型都在「模型 → 下发到 DSH」里（12 §7.0）
  }

  if (step === 1) {
    if (draft.targetMode === 'users' && draft.userIds.length === 0) errors.push('至少勾选一位用户')
    if (draft.targetMode === 'filter') {
      const filter = draft.filter
      const empty =
        filter.status === undefined &&
        filter.runtimeId === undefined &&
        filter.presetId === undefined &&
        filter.pluginId === undefined
      if (empty) errors.push('条件筛选至少设置一个条件')
    }
  }

  if (step === 2) {
    if (draft.strategy.concurrency < 1 || draft.strategy.concurrency > 8) errors.push('并发数需要在 1–8 之间')
    if (draft.strategy.canary < 0 || draft.strategy.canary > 5) errors.push('金丝雀数量需要在 0–5 之间')
    if (draft.strategy.maxFailureRatio < 0 || draft.strategy.maxFailureRatio > 1) {
      errors.push('失败阈值需要在 0–1 之间')
    }
  }

  return errors
}

/** 草稿 → `Targets`（04 §4.8）。 */
export function buildTargets(draft: RolloutDraft): Targets {
  if (draft.targetMode === 'all') return { all: true }
  if (draft.targetMode === 'users') return { userIds: [...draft.userIds] }

  const filter: RolloutFilter = {}
  if (draft.filter.status) filter.status = draft.filter.status
  if (draft.filter.runtimeId !== undefined) filter.runtimeId = draft.filter.runtimeId
  if (draft.filter.presetId !== undefined) filter.presetId = draft.filter.presetId
  if (draft.filter.pluginId !== undefined) filter.pluginId = draft.filter.pluginId
  return { filter }
}

/** 草稿 → 请求体（`POST /api/admin/rollouts` 与 `/preview` 同体）。 */
export function buildRolloutRequest(draft: RolloutDraft): RolloutRequest {
  const targets = buildTargets(draft)
  const strategy: Strategy = { ...draft.strategy }

  if (draft.kind === 'runtime') {
    return { kind: 'runtime', runtimeId: draft.runtimeId ?? 0, targets, strategy }
  }

  if (draft.kind === 'models') {
    // 12 §7.0：模型选中集合与默认模型由「下发到 DSH」维护，请求体里**不带 presetId**
    return { kind: 'models', targets, strategy }
  }

  return {
    kind: 'plugin',
    action: draft.action,
    pluginId: draft.pluginId ?? 0,
    ...(draft.versionId === null ? {} : { versionId: draft.versionId }),
    targets,
    strategy,
  }
}

/** 预览请求与创建请求同体；这里保留一个别名，方便页面表达意图。 */
export function buildPreviewRequest(draft: RolloutDraft): RolloutPreviewRequest {
  return buildRolloutRequest(draft)
}

/** 目标的中文摘要（预览页与确认文案用）。 */
export function describeTargets(draft: RolloutDraft, userName: (id: number) => string): string {
  if (draft.targetMode === 'all') return '全部用户'
  if (draft.targetMode === 'users') {
    const names = draft.userIds.map(userName)
    if (names.length <= 3) return names.join('、')
    return `${names.slice(0, 3).join('、')} 等 ${names.length} 位用户`
  }

  const parts: string[] = []
  if (draft.filter.status) parts.push(`状态=${draft.filter.status}`)
  if (draft.filter.runtimeId !== undefined) parts.push(`版本=#${draft.filter.runtimeId}`)
  if (draft.filter.presetId !== undefined) parts.push(`预设=#${draft.filter.presetId}`)
  if (draft.filter.pluginId !== undefined) parts.push(`已装插件=#${draft.filter.pluginId}`)
  return parts.length > 0 ? `条件：${parts.join('，')}` : '条件：未设置'
}

/** URL 预填（`?kind=&pluginId=&runtimeId=&userIds=1,2`）。 */
export function draftFromQuery(query: Record<string, unknown>): RolloutDraft {
  const readNumber = (value: unknown): number | null => {
    const raw = Array.isArray(value) ? value[0] : value
    if (raw === undefined || raw === null || raw === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const readString = (value: unknown): string => {
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' ? raw : ''
  }

  const kindRaw = readString(query['kind'])
  const kind: RolloutKind = kindRaw === 'runtime' || kindRaw === 'models' ? kindRaw : 'plugin'
  const userIdsRaw = readString(query['userIds'])
  const userIds = userIdsRaw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)

  const draft = createDraft({ kind })
  draft.pluginId = readNumber(query['pluginId'])
  draft.runtimeId = readNumber(query['runtimeId'])
  // 旧的 `?presetId=` 不再有意义（12 §7.0），忽略即可
  if (userIds.length > 0) {
    draft.targetMode = 'users'
    draft.userIds = userIds
  }

  return draft
}
