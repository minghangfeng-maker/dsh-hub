import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import {
  CreateExportRequestSchema,
  CreateExportResponseSchema,
  ExportEstimateResponseSchema,
  ExportListResponseSchema,
  ExportEstimateQuerySchema,
  NumericIdParamSchema,
  parseExportParts,
  type CreateExportRequest,
  type CreateExportResponse,
  type ExportEstimateResponse,
  type ExportItem,
  type ExportListResponse,
  type ExportFormat,
  type ExportPart,
  type ExportProgress,
} from '@dsh-hub/shared'
import { requestMeta, requireUser } from '../../app.js'
import { HUB_VERSION } from '../../config.js'
import type { AppDeps, BaseDeps } from '../../context.js'
import { isoPlusHours, isExpired } from '../../lib/clock.js'
import { HubError } from '../../lib/errors.js'
import { openSse } from '../../lib/sse.js'
import type { JobService } from '../jobs/types.js'
import { createExportJobHandler } from './job.js'
import {
  archiveRootName,
  buildManifest,
  buildPluginsJson,
  buildReadme,
  contentDisposition,
  dependenciesOf,
  exportFileName,
  mimeTypeFor,
  parseRange,
  readProfilePackage,
  scanExport,
  storageNameFor,
  writeArchive,
  type ExtraFile,
  type PartSource,
  type PartStats,
  type ScanResult,
} from './pack.js'
import {
  countActive,
  countCreatedSince,
  deleteExport,
  getExportRow,
  getUser,
  insertExport,
  listExpiredRows,
  listExportRows,
  requireUser as requireExportUser,
  toExportItem,
  updateExport,
} from './repo.js'
import type { ExportFileRef, ExportJobParams, ExportRunResult, ExportService } from './types.js'

export * from './types.js'
export { createExportJobHandler } from './job.js'

/** 估算缓存 60s（04 §3.3） */
const ESTIMATE_TTL_MS = 60_000
/** 过期清理定时器：每小时（06 §6） */
const CLEANUP_INTERVAL_MS = 3_600_000
/** 导出 job 的策略：单任务、无金丝雀、失败即结束（不按失败率暂停） */
const EXPORT_STRATEGY = { concurrency: 1, canary: 0, maxFailureRatio: 1, restart: 'now' as const }

export function createExportService(deps: BaseDeps): ExportService {
  const progressByExport = new Map<number, ExportProgress>()
  const estimateCache = new Map<string, { at: number; stats: PartStats }>()
  let jobService: JobService | null = null

  function sourcesFor(slug: string, parts: ExportPart[]): Partial<Record<ExportPart, PartSource[]>> {
    const dshHome = deps.paths.userDshHome(slug)
    const profileDir = deps.paths.userProfileDir(slug)
    const sources: Partial<Record<ExportPart, PartSource[]>> = {}
    if (parts.includes('workspace')) {
      sources.workspace = [{ path: deps.paths.userWorkspace(slug), archivePrefix: 'workspace', kind: 'dir' }]
    }
    if (parts.includes('sessions')) {
      sources.sessions = [
        { path: join(dshHome, 'sessions'), archivePrefix: 'dsh/sessions', kind: 'dir' },
        { path: join(dshHome, 'attachments'), archivePrefix: 'dsh/attachments', kind: 'dir' },
      ]
    }
    if (parts.includes('settings')) {
      sources.settings = [
        { path: join(profileDir, 'package.json'), archivePrefix: 'dsh/settings/profile', kind: 'file' },
        {
          path: join(profileDir, 'cordis.patch.yml'),
          archivePrefix: 'dsh/settings/profile',
          kind: 'file',
        },
        { path: join(dshHome, 'storages'), archivePrefix: 'dsh/settings/storages', kind: 'dir' },
      ]
    }
    if (parts.includes('profile-plugins') && !parts.includes('settings')) {
      // settings 已含 profile/package.json，避免同一条目在归档里出现两次
      sources['profile-plugins'] = [
        { path: join(profileDir, 'package.json'), archivePrefix: 'dsh/settings/profile', kind: 'file' },
      ]
    }
    return sources
  }

  function scanFor(slug: string, parts: ExportPart[], maxBytes: number): ScanResult {
    return scanExport({
      userRoot: deps.paths.userDir(slug),
      sources: sourcesFor(slug, parts),
      maxBytes,
    })
  }

  function itemOf(exportId: number): ExportItem {
    const row = getExportRow(deps.db, exportId)
    if (!row) throw new HubError('NOT_FOUND', '导出记录不存在')
    return toExportItem(row, progressByExport.get(exportId) ?? null)
  }

  return {
    bindJobs(jobs) {
      jobService = jobs
    },

    progressOf(exportId) {
      return progressByExport.get(exportId) ?? null
    },

    async estimate(userId, parts) {
      const user = requireExportUser(deps.db, userId)
      const requested = parts.length > 0 ? parts : (['workspace', 'sessions'] as ExportPart[])
      const nowMs = deps.clock.now().getTime()
      const result: Record<string, PartStats> = {}
      let totalBytes = 0
      for (const part of requested) {
        const key = `${user.slug}:${part}`
        const cached = estimateCache.get(key)
        if (cached && nowMs - cached.at < ESTIMATE_TTL_MS) {
          result[part] = cached.stats
          totalBytes += cached.stats.bytes
          continue
        }
        // 估算不受 maxBytes 限制：先让用户看到真实体积，再由 create 拒绝
        const scan = scanFor(user.slug, [part], Number.POSITIVE_INFINITY)
        const stats = scan.partStats[part] ?? { bytes: 0, files: 0 }
        if (estimateCache.size > 500) estimateCache.clear()
        estimateCache.set(key, { at: nowMs, stats })
        result[part] = stats
        totalBytes += stats.bytes
      }
      return { parts: result, totalBytes }
    },

    async create(userId, input: CreateExportRequest, meta): Promise<CreateExportResponse> {
      if (!jobService) throw new HubError('INTERNAL', '导出执行器尚未接入任务引擎')
      const user = requireExportUser(deps.db, userId)
      const settings = deps.settings.get('exports')
      const nowIso = deps.clock.nowIso()
      const used = countCreatedSince(deps.db, userId, `${nowIso.slice(0, 10)}T00:00:00.000Z`)
      if (used >= settings.dailyLimit) {
        throw new HubError('EXPORT_LIMIT', `今日导出次数已达上限（${settings.dailyLimit} 次）`, {
          limit: settings.dailyLimit,
          used,
        })
      }
      if (countActive(deps.db, userId) > 0) {
        throw new HubError('CONFLICT', '已有导出任务在进行中，请等它完成')
      }
      const parts = [...new Set(input.parts)]
      const format = input.format
      const fileName = exportFileName(user.username, nowIso, format)
      const exportId = insertExport(deps.db, {
        userId,
        parts,
        format,
        status: 'queued',
        fileName,
        createdAt: nowIso,
        expiresAt: isoPlusHours(nowIso, settings.ttlHours),
      })
      const params: ExportJobParams = {
        exportId,
        userId,
        slug: user.slug,
        fileName,
        root: archiveRootName(user.username, nowIso),
        parts,
        format,
        dshVersion: null,
      }
      try {
        const job = await jobService.create<ExportJobParams>({
          type: 'export',
          title: `导出数据 · ${user.username}`,
          params,
          strategy: EXPORT_STRATEGY,
          createdBy: userId,
        })
        updateExport(deps.db, exportId, { jobId: job.id })
      } catch (error) {
        updateExport(deps.db, exportId, {
          status: 'failed',
          error: error instanceof Error ? error.message : '创建导出任务失败',
        })
        throw error
      }
      deps.audit.log({
        actorId: userId,
        actorIp: meta?.ip ?? null,
        action: 'export.create',
        targetType: 'export',
        targetId: exportId,
        detail: { parts, format },
      })
      return { export: itemOf(exportId) }
    },

    async list(userId): Promise<ExportListResponse> {
      requireExportUser(deps.db, userId)
      return {
        items: listExportRows(deps.db, userId).map((row) =>
          toExportItem(row, progressByExport.get(row.id) ?? null),
        ),
      }
    },

    async get(userId, exportId) {
      const row = getExportRow(deps.db, exportId)
      if (!row || row.user_id !== userId) return null
      return toExportItem(row, progressByExport.get(row.id) ?? null)
    },

    async fileFor(userId, exportId, meta): Promise<ExportFileRef | null> {
      const row = getExportRow(deps.db, exportId)
      if (!row || row.user_id !== userId) return null
      if (row.status !== 'ready' || !row.file_name) return null
      const user = getUser(deps.db, userId)
      if (!user) return null
      const path = exportPathFor(deps, user.slug, row.id, row.format)
      if (!existsSync(path)) {
        updateExport(deps.db, exportId, { status: 'expired', error: '文件已被清理' })
        return null
      }
      if (isExpired(row.expires_at, deps.clock.nowIso())) {
        rmSync(path, { force: true })
        updateExport(deps.db, exportId, { status: 'expired', error: '导出已过期' })
        return null
      }
      updateExport(deps.db, exportId, { downloaded: 1 })
      deps.audit.log({
        actorId: userId,
        actorIp: meta?.ip ?? null,
        action: 'export.download',
        targetType: 'export',
        targetId: exportId,
        detail: { fileName: row.file_name },
      })
      return {
        path,
        fileName: row.file_name,
        sizeBytes: statSync(path).size,
        mimeType: mimeTypeFor(row.format),
        sha256: row.sha256,
      }
    },

    async remove(userId, exportId) {
      const row = getExportRow(deps.db, exportId)
      if (!row || row.user_id !== userId) throw new HubError('NOT_FOUND', '导出记录不存在')
      if (row.status === 'queued' || row.status === 'running') {
        throw new HubError('CONFLICT', '导出正在进行中，请先等它结束')
      }
      const user = getUser(deps.db, userId)
      if (user) rmSync(exportPathFor(deps, user.slug, row.id, row.format), { force: true })
      deleteExport(deps.db, exportId)
      progressByExport.delete(exportId)
    },

    async cleanupExpired() {
      const rows = listExpiredRows(deps.db, deps.clock.nowIso())
      let cleaned = 0
      for (const row of rows) {
        const user = getUser(deps.db, row.user_id)
        if (user) {
          rmSync(exportPathFor(deps, user.slug, row.id, row.format), { force: true })
        }
        updateExport(deps.db, row.id, { status: 'expired' })
        progressByExport.delete(row.id)
        cleaned += 1
      }
      cleaned += cleanupPartFiles(deps)
      return cleaned
    },

    async run(params, ctx): Promise<ExportRunResult> {
      const user = requireExportUser(deps.db, params.userId)
      const settings = deps.settings.get('exports')
      const profileDir = deps.paths.userProfileDir(user.slug)
      const root = params.root || archiveRootName(user.username, deps.clock.nowIso())
      progressByExport.set(params.exportId, { bytesWritten: 0, filesDone: 0, filesTotal: 0 })
      updateExport(deps.db, params.exportId, { status: 'running', error: null })

      try {
        const scan = scanFor(user.slug, params.parts, settings.maxBytes)
        ctx.log(`遍历完成：${scan.files} 个文件、${scan.bytes} 字节（分区：${params.parts.join('、')}）`)
        if (scan.skipped.length > 0) {
          ctx.log(`跳过 ${scan.skipped.length} 项（符号链接越界/特殊文件），详见 manifest.json`)
        }
        if (ctx.signal.aborted) throw new HubError('CONFLICT', '导出已取消')

        const profilePackage = readProfilePackage(profileDir)
        const manifestInput = {
          hubVersion: HUB_VERSION,
          username: user.username,
          displayName: user.display_name,
          parts: params.parts,
          format: params.format,
          exportedAt: deps.clock.nowIso(),
          dshVersion: params.dshVersion ?? null,
          root,
          files: scan.files,
          bytes: scan.bytes,
          skipped: scan.skipped,
        }
        const extras: ExtraFile[] = [
          { name: `${root}/README.txt`, content: buildReadme(manifestInput) },
          { name: `${root}/manifest.json`, content: buildManifest(manifestInput) },
        ]
        if (params.parts.includes('profile-plugins')) {
          extras.push({
            name: `${root}/plugins.json`,
            content: buildPluginsJson({
              exportedAt: manifestInput.exportedAt,
              profilePackage,
              dependencies: dependenciesOf(profilePackage),
            }),
          })
        }

        const targetPath = exportPathFor(deps, user.slug, params.exportId, params.format)
        const result = await writeArchive({
          format: params.format,
          targetPath,
          // 06 §6：包内所有内容都放在同一个顶层目录 dsh-<username>-<时间>/ 下（WP8a 缺陷 D2）；
          // 符号链接的目标是相对路径，整体移入同一目录后仍然成立
          entries: scan.entries.map((entry) => ({ ...entry, archivePath: `${root}/${entry.archivePath}` })),
          extras,
          onProgress: (progress) => {
            progressByExport.set(params.exportId, progress)
            deps.events.emit('export.progress', {
              userId: params.userId,
              exportId: params.exportId,
              progress,
            })
            ctx.progress({ done: progress.filesDone, total: progress.filesTotal })
          },
        })

        const finishedAt = deps.clock.nowIso()
        progressByExport.delete(params.exportId)
        updateExport(deps.db, params.exportId, {
          status: 'ready',
          fileSizeBytes: result.sizeBytes,
          sha256: result.sha256,
          expiresAt: isoPlusHours(finishedAt, settings.ttlHours),
          error: null,
        })
        const item = itemOf(params.exportId)
        deps.events.emit('export.done', { userId: params.userId, exportId: params.exportId, item })
        ctx.log(
          `导出完成：${params.fileName}（${result.sizeBytes} 字节，sha256 ${result.sha256.slice(0, 12)}…）`,
        )
        return {
          exportId: params.exportId,
          fileName: params.fileName,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
        }
      } catch (error) {
        progressByExport.delete(params.exportId)
        const message = HubError.is(error) ? error.message : '导出失败，请稍后重试'
        const code = HubError.is(error) ? error.code : 'INTERNAL'
        updateExport(deps.db, params.exportId, { status: 'failed', error: message })
        deps.events.emit('export.failed', {
          userId: params.userId,
          exportId: params.exportId,
          error: { code, message },
        })
        if (!HubError.is(error)) {
          ctx.log(`打包失败：${error instanceof Error ? error.message : String(error)}`)
        }
        throw error
      }
    },
  }
}

/** 导出包在宿主上的绝对路径（`exports/<slug>/<exportId>.<ext>`，03 §2） */
function exportPathFor(deps: BaseDeps, slug: string, exportId: number, format: ExportFormat): string {
  return deps.paths.userExportFile(slug, storageNameFor(exportId, format))
}

/** 清理上次崩溃留下的 `.part` 临时文件（超过 1 小时的） */
function cleanupPartFiles(deps: BaseDeps): number {
  let removed = 0
  const cutoff = Date.now() - 3_600_000
  let dirs: string[]
  try {
    dirs = readdirSync(deps.paths.exportsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => join(deps.paths.exportsDir, dirent.name))
  } catch {
    return 0
  }
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.part')) continue
      const path = join(dir, file)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch {
        // 忽略：并发删除/权限问题不影响清理
      }
    }
  }
  return removed
}

/**
 * exports 模块（04 §3.3；WP4 实现）。前缀 `/api/me/exports`：
 * `GET /estimate`、`POST /`、`GET /`、`GET /:id/events`(SSE)、`GET /:id/download`、`DELETE /:id`。
 * 这里同时把 `export` 类型处理器注册进 jobs 引擎，并起过期清理定时器（每小时）。
 */
export function exportsPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const exportsService = deps.services.exports
    exportsService.bindJobs(deps.services.jobs)
    deps.services.jobs.registerHandler(createExportJobHandler(deps))

    const cleanup = (): void => {
      void exportsService
        .cleanupExpired()
        .then((count) => {
          if (count > 0) app.log.info({ count }, '已清理过期的导出文件')
        })
        .catch((error: unknown) => app.log.warn({ err: error }, '导出过期清理失败'))
    }
    const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS)
    timer.unref?.()
    cleanup()
    app.addHook('onClose', () => {
      clearInterval(timer)
    })

    app.get('/estimate', { preHandler: requireUser }, async (req): Promise<ExportEstimateResponse> => {
      const query = ExportEstimateQuerySchema.parse(req.query)
      const parts = parseExportParts(query.parts)
      if (parts.length === 0) throw new HubError('VALIDATION_FAILED', '请至少选择一项导出内容')
      return ExportEstimateResponseSchema.parse(await exportsService.estimate(req.user!.id, parts))
    })

    app.post('/', { preHandler: requireUser }, async (req, reply) => {
      const input = CreateExportRequestSchema.parse(req.body ?? {})
      const result = await exportsService.create(req.user!.id, input, requestMeta(req))
      return reply.code(202).send(CreateExportResponseSchema.parse(result))
    })

    app.get('/', { preHandler: requireUser }, async (req): Promise<ExportListResponse> => {
      return ExportListResponseSchema.parse(await exportsService.list(req.user!.id))
    })

    app.delete('/:id', { preHandler: requireUser }, async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params)
      await exportsService.remove(req.user!.id, id)
      return reply.code(204).send()
    })

    app.get('/:id/events', { preHandler: requireUser }, async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params)
      const userId = req.user!.id
      const item = await exportsService.get(userId, id)
      if (!item) throw new HubError('NOT_FOUND', '导出记录不存在')

      const stream = openSse(reply)
      if (item.status === 'ready') {
        stream.send('done', { export: item })
        stream.close()
        return reply
      }
      if (item.status === 'failed') {
        stream.send('failed', { error: { code: 'EXPORT_FAILED', message: item.error ?? '导出失败' } })
        stream.close()
        return reply
      }
      if (item.progress) stream.send('progress', item.progress)

      const offs = [
        deps.events.on('export.progress', (payload) => {
          if (payload.exportId === id && payload.userId === userId) stream.send('progress', payload.progress)
        }),
        deps.events.on('export.done', (payload) => {
          if (payload.exportId !== id || payload.userId !== userId) return
          stream.send('done', { export: payload.item })
          stream.close()
        }),
        deps.events.on('export.failed', (payload) => {
          if (payload.exportId !== id || payload.userId !== userId) return
          stream.send('failed', { error: payload.error })
          stream.close()
        }),
      ]
      const cleanupListeners = (): void => {
        for (const off of offs) off()
      }
      reply.raw.once('close', cleanupListeners)
      reply.raw.once('error', cleanupListeners)
      return reply
    })

    app.get('/:id/download', { preHandler: requireUser }, async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params)
      const ref = await exportsService.fileFor(req.user!.id, id, requestMeta(req))
      if (!ref) throw new HubError('NOT_FOUND', '导出文件不存在或已过期')

      reply.header('Accept-Ranges', 'bytes')
      reply.header('Content-Type', ref.mimeType)
      reply.header('Content-Disposition', contentDisposition(ref.fileName))
      if (ref.sha256) reply.header('X-Hub-Sha256', ref.sha256)

      const range = parseRange(req.headers.range, ref.sizeBytes)
      if (range === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${ref.sizeBytes}`).send()
      }
      if (range) {
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${ref.sizeBytes}`)
        reply.header('Content-Length', String(range.end - range.start + 1))
        return reply.code(206).send(createReadStream(ref.path, { start: range.start, end: range.end }))
      }
      reply.header('Content-Length', String(ref.sizeBytes))
      return reply.send(createReadStream(ref.path))
    })
  }
}
