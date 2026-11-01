import type {
  DeliveryPreviewResponse,
  DeliveryPreviewRow,
  DeliveryRequest,
  DeliverySkippedItem,
} from '@dsh-hub/shared'
import {
  buildPlan,
  resolveDesktopSide,
  resolveInstanceSide,
  type InstanceResolutionDeps,
} from './resolve.js'

/** 预览最多返回多少行（交付物 2；超出 `truncated=true`，执行仍按完整清单） */
export const DELIVERY_PREVIEW_MAX_ROWS = 2000

/** 预览与提交的依赖：BaseDeps + services + rollouts 的 preview（执行侧同一套过滤） */
export type PreviewDeps = InstanceResolutionDeps

/**
 * `POST /api/admin/deliveries/preview`（交付物 2）。**只读**：这里不写库、不建任务、不产生 revision。
 *
 * 行 = 内容项 × 目标（实例按用户；桌面一台设备一行）。`skipReason !== null` 的行就是提交时
 * 不会执行的行（解析与提交共用 `resolve.ts`）。
 */
export async function buildPreview(
  deps: PreviewDeps,
  request: DeliveryRequest,
  opts: { maxRows?: number } = {},
): Promise<DeliveryPreviewResponse> {
  const plan = await buildPlan(deps, request)
  const warnings = [...plan.warnings]
  // 与 `executeDelivery` 同一口径的「整项跳过」：预览就能看到提交时会出现哪些跳过
  const skippedItems: DeliverySkippedItem[] = []
  const skip = (itemLabel: string, platform: DeliverySkippedItem['platform'], reason: string): void => {
    if (skippedItems.some((row) => row.itemLabel === itemLabel && row.platform === platform)) return
    skippedItems.push({ itemLabel, platform, reason })
  }
  const instanceRows: (DeliveryPreviewRow & { _unparsable?: boolean })[] = []
  const desktopRows: (DeliveryPreviewRow & { _unparsable?: boolean })[] = []

  for (const entry of plan.items) {
    if (plan.platforms.instance) {
      const side = await resolveInstanceSide(deps, plan, entry)
      if (side.blocked !== null) {
        warnings.push(`实例端跳过「${entry.label}」：${side.blocked}`)
        skip(entry.label, 'instance', side.blocked)
      } else {
        if (side.rows.length === 0) {
          warnings.push(`实例端「${entry.label}」没有解析到任何用户（检查目标模式与内容项）`)
        }
        const incompatible = side.rows.filter(
          (row) => row.skipReason !== null && row.skipReason.startsWith('DSH 版本不兼容'),
        ).length
        if (incompatible > 0) {
          warnings.push(
            `「${entry.label}」有 ${String(incompatible)} 个实例用户的 DSH 版本低于插件要求，已跳过（版本不兼容）`,
          )
        }
        const unparsable = side.rows.filter((row) => row.versionUnparsable === true).length
        if (unparsable > 0) {
          warnings.push(`「${entry.label}」有 ${String(unparsable)} 个目标解析不出版本号，已按「较旧」处理`)
        }
        if (side.userIds.length === 0) {
          skip(
            entry.label,
            'instance',
            side.rows.length === 0 ? '目标解析为 0 人（没有匹配的用户）' : '解析到的目标全部被跳过',
          )
        }
        for (const row of side.rows) {
          instanceRows.push({
            platform: 'instance',
            userId: row.target.userId,
            username: row.target.username,
            deviceId: null,
            deviceName: null,
            itemLabel: entry.label,
            current: row.current,
            after: row.after,
            needsRestart: row.needsRestart,
            skipReason: row.skipReason,
            ...(row.versionUnparsable === true ? { _unparsable: true } : {}),
          })
        }
      }
    }

    if (plan.platforms.desktop) {
      const side = resolveDesktopSide(deps.db, plan, entry)
      if (side.blocked !== null) {
        warnings.push(`桌面端跳过「${entry.desktopLabel}」：${side.blocked}`)
        skip(entry.desktopLabel, 'desktop', side.blocked)
      } else {
        if (side.rows.length === 0) {
          warnings.push(`桌面端「${entry.desktopLabel}」没有解析到任何设备（检查目标模式与内容项）`)
        }
        const unparsable = side.rows.filter((row) => row.versionUnparsable === true).length
        if (unparsable > 0) {
          warnings.push(
            `「${entry.desktopLabel}」有 ${String(unparsable)} 台设备上报的版本号解析不出来，已按「较旧」处理`,
          )
        }
        if (side.scopes.length === 0) {
          skip(
            entry.desktopLabel,
            'desktop',
            side.rows.length === 0 ? '目标解析为 0 台设备' : '解析到的目标全部被跳过',
          )
        }
        for (const row of side.rows) {
          desktopRows.push({
            platform: 'desktop',
            userId: row.target.userId,
            username: row.target.username,
            deviceId: row.target.deviceId,
            deviceName: row.target.deviceName,
            // 桌面侧可能用另一个版本号（同名版本号允许两平台各有一条）
            itemLabel: entry.desktopLabel,
            current: row.current,
            after: row.after,
            needsRestart: row.needsRestart,
            skipReason: row.skipReason,
            ...(row.versionUnparsable === true ? { _unparsable: true } : {}),
          })
        }
      }
    }
  }

  const sortRows = (left: DeliveryPreviewRow, right: DeliveryPreviewRow): number => {
    if (left.itemLabel !== right.itemLabel) return left.itemLabel < right.itemLabel ? -1 : 1
    if (left.userId !== right.userId) return left.userId - right.userId
    return (left.deviceId ?? '') < (right.deviceId ?? '') ? -1 : (left.deviceId ?? '') > (right.deviceId ?? '') ? 1 : 0
  }
  instanceRows.sort(sortRows)
  desktopRows.sort(sortRows)
  const allRows = [...instanceRows, ...desktopRows]
  const limit = opts.maxRows ?? DELIVERY_PREVIEW_MAX_ROWS
  const truncated = allRows.length > limit
  const rows = (truncated ? allRows.slice(0, limit) : allRows).map(stripInternal)

  return {
    rows,
    summary: {
      instance: summarizeInstance(instanceRows),
      desktop: summarizeDesktop(desktopRows),
    },
    warnings: dedupe(warnings),
    truncated,
    skippedItems,
  }
}

function stripInternal(row: DeliveryPreviewRow & { _unparsable?: boolean }): DeliveryPreviewRow {
  const { _unparsable: _ignored, ...rest } = row
  return rest
}

function summarizeInstance(rows: DeliveryPreviewRow[]): {
  willRun: number
  skipped: number
  users: number
} {
  return {
    willRun: rows.filter((row) => row.skipReason === null).length,
    skipped: rows.filter((row) => row.skipReason !== null).length,
    users: new Set(rows.map((row) => row.userId)).size,
  }
}

function summarizeDesktop(rows: DeliveryPreviewRow[]): {
  willRun: number
  skipped: number
  users: number
  devices: number
} {
  return {
    willRun: rows.filter((row) => row.skipReason === null).length,
    skipped: rows.filter((row) => row.skipReason !== null).length,
    users: new Set(rows.map((row) => row.userId)).size,
    devices: new Set(rows.map((row) => row.deviceId ?? '').filter((id) => id.length > 0)).size,
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}
