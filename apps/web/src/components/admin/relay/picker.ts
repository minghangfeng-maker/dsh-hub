import type {
  DiscoverRelayChannelResponse,
  ImportRelayModelsRequest,
  RelayModel,
  RelayRouteInput,
} from '@dsh-hub/shared'

/**
 * 模型选择器（12 §10）的纯逻辑：渠道 Tab 的「选择模型」与模型 Tab 的「添加模型」共用。
 *
 * 选择器只有两个动作：勾上 = `import`（**不带价格**，新模型是「未定价」）；取消勾选已有的 =
 * PATCH 该模型的 `routes` 去掉本渠道（模型与价格保留，可能变成「无渠道」）。
 */

/** 选择器里的一行：上游模型 + 模型信息库补全的参数 + 同名的对外模型 id（null = 会新建） */
export type PickerModel = DiscoverRelayChannelResponse['models'][number]

/** 本渠道已有的路由（upstreamModel → 属于哪个对外模型） */
export interface ChannelRoute {
  model: RelayModel
  upstreamModel: string
}

/** 找出所有挂在本渠道上的路由 */
export function channelRoutes(models: RelayModel[], channelId: number | null): ChannelRoute[] {
  if (channelId === null) return []
  return models.flatMap((model) =>
    model.routes
      .filter((route) => route.channelId === channelId)
      .map((route) => ({ model, upstreamModel: route.upstreamModel })),
  )
}

/**
 * 把发现结果与本渠道已有的路由合成选择器的行：上游没返回（或 discover 失败）但已经挂在本渠道的
 * 模型也要出现，否则用户没法取消勾选。
 */
export function pickerRows(discovered: PickerModel[], routes: ChannelRoute[], models: RelayModel[]): PickerModel[] {
  const known = new Set(discovered.map((model) => model.id))
  const extraNames = [...new Set(routes.map((route) => route.upstreamModel))].filter((name) => !known.has(name))
  const extras: PickerModel[] = extraNames.map((name) => ({
    id: name,
    name: models.find((model) => model.routes.some((route) => route.upstreamModel === name))?.displayName ?? name,
    existingModelId: routes.find((route) => route.upstreamModel === name)?.model.id ?? null,
  }))
  return [...discovered, ...extras]
}

/** 勾选的模型 → `import` 的 models（不带价格；已在本渠道的不重复发） */
export function toImportEntries(
  rows: PickerModel[],
  checked: string[],
  existing: string[],
): ImportRelayModelsRequest['models'] {
  const already = new Set(existing)
  return rows
    .filter((row) => checked.includes(row.id) && !already.has(row.id))
    .map((row) => ({
      upstreamModel: row.id,
      name: row.id,
      displayName: row.name && row.name !== row.id ? row.name : undefined,
      info: {
        ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
        ...(row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens }),
        ...(row.input && row.input.length > 0 ? { input: [...row.input] } : {}),
        ...(row.reasoningEfforts && row.reasoningEfforts.length > 0
          ? { reasoningEfforts: [...row.reasoningEfforts] }
          : {}),
      },
    }))
}

/** 从模型的路由里去掉「本渠道的某条上游模型」，返回整体替换用的 `routes` 入参 */
export function routesWithoutChannel(
  model: RelayModel,
  channelId: number,
  upstreamModel: string,
): RelayRouteInput[] {
  return model.routes
    .filter((route) => !(route.channelId === channelId && route.upstreamModel === upstreamModel))
    .map((route) => ({
      channelId: route.channelId,
      upstreamModel: route.upstreamModel,
      priority: route.priority,
      weight: route.weight,
      enabled: route.enabled,
    }))
}
