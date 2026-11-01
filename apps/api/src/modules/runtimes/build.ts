import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTAINER_LABEL_MANAGED, type RuntimeStatus } from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobHandler, TaskContext } from '../jobs/types.js'
import { imageForVersion } from '../instances/index.js'
import { LABEL_ENV } from '../instances/spec.js'
import type { ContainerSpec } from '../instances/types.js'
import { getRuntimeRow, updateRuntimeRow, type RuntimeRow } from './repo.js'

/**
 * `runtime.build` 任务（06 §3）：打包 `runtime/` 上下文 → `driver.buildImage` →
 * 冒烟测试 `dsh --version` 必须等于目标版本 → `status=ready`。
 * 构建日志逐行进 task 日志（用户能实时看到）。
 */

/** 仓库里的 `runtime/` 上下文目录；可用 `HUB_RUNTIME_DIR` 覆盖（部署到别处时用） */
export function runtimeContextDir(): string {
  const fromEnv = process.env.HUB_RUNTIME_DIR
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return fileURLToPath(new URL('../../../../../runtime/', import.meta.url))
}

export interface RuntimeBuildParams {
  runtimeId: number
  dshVersion: string
}

export const RUNTIME_BUILD_TYPE = 'runtime.build'

/** 冒烟测试需要的配置（只用到 npm 源与本环境标识，好让 CLI 也能复用同一个规格） */
export interface SmokeSpecConfig {
  npmRegistry: string
  envId?: string
}

/**
 * 冒烟测试一次性容器的规格（HOME 指到 tmpfs，只读根下也能跑）。
 * **网络是 `none`**：`dsh --version` 不需要网络，而用户网络在全新安装时还不存在
 * （WP8b B1：曾因 `network dshhub-users not found` 让构建任务失败）。
 */
export function smokeSpec(config: SmokeSpecConfig, tag: string, version: string): ContainerSpec {
  return {
    name: `dshhub-smoke-${version.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 40)}`,
    image: tag,
    env: {
      HOME: '/tmp',
      DSH_HOME: '/tmp/.dsh',
      DSH_TELEMETRY_DISABLED: '1',
      npm_config_registry: config.npmRegistry,
    },
    labels: {
      [CONTAINER_LABEL_MANAGED]: '1',
      'dshhub.smoke': '1',
      ...(config.envId ? { [LABEL_ENV]: config.envId } : {}),
    },
    mounts: [],
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    network: 'none',
    readOnlyRootfs: true,
    tmpfs: { '/tmp': 'rw,size=256m,nosuid,nodev' },
    publishPort: false,
  }
}

/** 从 `dsh --version` 的输出里取版本号（前缀可能带噪声） */
export function parseDshVersion(output: string): string | null {
  const matched = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output)
  return matched?.[1] ?? null
}

export function createRuntimeBuildHandler(deps: AppDeps): JobHandler<RuntimeBuildParams> {
  return {
    type: RUNTIME_BUILD_TYPE,

    async plan(params) {
      return {
        title: `构建 DSH 版本 ${params.dshVersion}`,
        tasks: [{ userId: null, payload: { runtimeId: params.runtimeId, dshVersion: params.dshVersion } }],
      }
    },

    async runTask(ctx, _task, params) {
      const row = getRuntimeRow(deps.db, params.runtimeId)
      if (!row) throw new HubError('NOT_FOUND', '运行时版本记录不存在')
      const tag = row.image || imageForVersion(params.dshVersion)
      const contextDir = runtimeContextDir()
      ctx.log(`构建上下文：${contextDir}`)
      ctx.log(`目标镜像：${tag}`)
      updateRuntimeRow(deps.db, row.id, { status: 'building' as RuntimeStatus })

      // B2（WP8b）：`building` 是一个**必须有人收尾**的中间态——写进去之后任何一条失败路径
      // （构建上下文不存在、`runOnce` 冒烟测试抛错……）都要回写成 `failed`，
      // 否则版本会永远卡在 building：既不能删（409）也不能重新构建。
      try {
        if (!existsSync(contextDir)) {
          throw new HubError('INTERNAL', `运行时构建上下文不存在：${contextDir}`, { contextDir })
        }
        const result = await buildAndSmoke(deps, ctx, contextDir, tag, params)
        updateRuntimeRow(deps.db, row.id, {
          status: 'ready',
          imageId: result.imageId,
          sizeBytes: result.sizeBytes,
          notes: '',
        })
        return { runtimeId: row.id, image: tag, imageId: result.imageId, dshVersion: params.dshVersion }
      } catch (error) {
        updateRuntimeRow(deps.db, row.id, {
          status: 'failed',
          notes: failureNote(error).slice(0, 500),
        })
        throw error
      }
    },
  }
}

/** 构建 + 冒烟测试（任一失败都抛错，由 runTask 统一回写 failed） */
async function buildAndSmoke(
  deps: AppDeps,
  ctx: TaskContext,
  contextDir: string,
  tag: string,
  params: RuntimeBuildParams,
): Promise<{ imageId: string; sizeBytes: number }> {
  const result = await deps.driver.buildImage(
    contextDir,
    tag,
    { DSH_VERSION: params.dshVersion, NPM_REGISTRY: deps.config.npmRegistry },
    (line) => ctx.log(line),
  )
  ctx.log(`镜像构建完成：${result.imageId}（${String(Math.round(result.sizeBytes / 1024 / 1024))}MB）`)

  // 冒烟测试：dsh --version 必须等于目标版本（06 §3）。网络用 none（用户网络在全新安装时还不存在）
  const smoke = await deps.driver.runOnce(
    smokeSpec(deps.config, tag, params.dshVersion),
    ['dsh', '--version'],
    {
      timeoutMs: 120_000,
      onOutput: (chunk) => ctx.log(chunk.trimEnd()),
    },
  )
  ctx.log(`冒烟测试 exit=${String(smoke.exitCode)} output=${smoke.output.trim()}`)
  if (smoke.exitCode !== 0) {
    throw new HubError('UPSTREAM_ERROR', `镜像冒烟测试失败：dsh --version 退出码 ${String(smoke.exitCode)}`)
  }
  const actual = parseDshVersion(smoke.output)
  if (actual && actual !== params.dshVersion) {
    throw new HubError('UPSTREAM_ERROR', `镜像版本不匹配：期望 ${params.dshVersion}，实际 ${actual}`)
  }
  if (!actual) ctx.log('警告：无法从 dsh --version 输出解析版本号，按成功处理')
  return result
}

export function isBuilding(row: RuntimeRow): boolean {
  return row.status === 'building'
}

/** 失败原因写进 `runtimes.notes`（截断前统一加前缀，便于管理端一眼看出是构建失败） */
function failureNote(error: unknown): string {
  return `构建失败：${errorText(error)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
