import type { MyRelayModel, MyRelayModelRoute, RelayDshModel, RelayDshRoute } from '@dsh-hub/shared'
import { pinnedModelName } from '@dsh-hub/shared'

/**
 * 16 §4.2：用户看到的模型是「模型 × 渠道」，一行一个、不按原模型分组。
 *
 * 接口按模型嵌套返回（`models[].routes[]`），这里统一展开成平铺行：工作台「我的模型」与
 * 「可用模型」表共用，免得两处各写一套排序 / 过滤 / 回退（`routes` 缺省时退回 WP19 的按模型显示）。
 */
export interface PinnedModelRow {
  /** 稳定 key：有路由用 `pinnedModel`，回退时用模型名 */
  key: string
  /** 用户请求 / 复制时用的名字：`<模型>@<slug>`（回退时就是模型名） */
  name: string
  displayName: string
  model: MyRelayModel
  /** null = 老后端没给 `routes`，按 WP19 的按模型显示 */
  route: MyRelayModelRoute | null
  /** 渠道倍率（回退时取模型的可选区间最小值） */
  ratePermille: number | null
  channelSlug: string | null
  isDefault: boolean
  inDsh: boolean
}

export interface FlattenMyRelayOptions {
  /** 用户是统一管理（`policy === 'managed'`） */
  managed?: boolean
  /** 老展示方式里的默认模型名（`modelSummary.defaultModel`） */
  defaultModelName?: string | null
}

/** 路由的调用名：优先接口给的 `pinnedModel`，没有就按契约拼一个（兼容 WP20a 上线前的假数据） */
export function pinnedNameOf(model: Pick<MyRelayModel, 'name'>, route: MyRelayModelRoute): string {
  return route.pinnedModel || pinnedModelName(model.name, route.channelSlug)
}

function routeIsDefault(model: MyRelayModel, route: MyRelayModelRoute): boolean {
  if (route.dshDefault !== undefined) return route.dshDefault
  return model.dshDefault === true
}

function modelIsDefault(model: MyRelayModel, defaultModelName: string | null | undefined): boolean {
  if (model.dshDefault !== undefined) return model.dshDefault
  return defaultModelName ? model.name === defaultModelName : false
}

/** 默认排第一；其余按倍率从低到高，再按名字排（16 §4.2） */
function compareRows(left: PinnedModelRow, right: PinnedModelRow): number {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
  const leftRate = left.ratePermille ?? Number.MAX_SAFE_INTEGER
  const rightRate = right.ratePermille ?? Number.MAX_SAFE_INTEGER
  if (leftRate !== rightRate) return leftRate - rightRate
  return left.name.localeCompare(right.name)
}

/**
 * 展开成平铺的独立模型。`routes` 缺省（老后端）时退回按模型一行，价格区间交给调用方用
 * `model.channelRate` 显示；`routes` 存在但为空 = 这个模型没有可用渠道，不出现。
 */
export function flattenMyRelayModels(
  models: MyRelayModel[],
  options: FlattenMyRelayOptions = {},
): PinnedModelRow[] {
  const managed = options.managed === true
  const hasInDsh = models.some(
    (model) => model.inDsh !== undefined || model.routes?.some((route) => route.inDsh !== undefined) === true,
  )
  const onlyInDsh = managed && hasInDsh
  const rows: PinnedModelRow[] = []

  for (const model of models) {
    if (model.routes === undefined) {
      if (onlyInDsh && model.inDsh !== true) continue
      rows.push({
        key: model.name,
        name: model.name,
        displayName: model.displayName,
        model,
        route: null,
        ratePermille: model.channelRate?.minPermille ?? null,
        channelSlug: null,
        isDefault: modelIsDefault(model, options.defaultModelName),
        inDsh: model.inDsh === true,
      })
      continue
    }

    for (const route of model.routes) {
      if (onlyInDsh && route.inDsh !== true) continue
      rows.push({
        key: pinnedNameOf(model, route),
        name: pinnedNameOf(model, route),
        displayName: model.displayName,
        model,
        route,
        ratePermille: route.ratePermille,
        channelSlug: route.channelSlug ?? null,
        isDefault: routeIsDefault(model, route),
        inDsh: route.inDsh,
      })
    }
  }

  return rows.sort(compareRows)
}

/** 「下发到 DSH」页的一行：一个「模型@标识」（16 §6.3） */
export interface DshRouteRow {
  key: number
  name: string
  route: RelayDshRoute
  model: RelayDshModel
  /** 路由级不能下发的原因（后端按四种原因给出） */
  blockedReason: string | null
}

/** 把 `RelayDshModel.routes[]` 平铺成一行一个「模型@标识」 */
export function flattenDshRoutes(models: RelayDshModel[]): DshRouteRow[] {
  const rows: DshRouteRow[] = []
  for (const model of models) {
    for (const route of model.routes ?? []) {
      rows.push({
        key: route.routeId,
        name: pinnedModelName(model.name, route.channelSlug),
        route,
        model,
        blockedReason: route.blockedReason ?? null,
      })
    }
  }
  return rows.sort((left, right) => {
    const byName = left.name.localeCompare(right.name)
    if (byName !== 0) return byName
    return left.route.ratePermille - right.route.ratePermille
  })
}

/** 「默认：deepseek-v4.1-flash@upstream-b」（页头 / 保存条用） */
export function dshDefaultLabel(row: DshRouteRow | null): string {
  return row?.name ?? '未设置'
}
