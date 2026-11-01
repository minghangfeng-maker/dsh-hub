import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { withUserLock } from '../../lib/locks.js'
import { imageForVersion } from '../instances/index.js'
import { getRuntimeRow, getRuntimeRowByVersion, getUserRuntimeRow, setUserRuntime } from './repo.js'
import type { UpgradeUserResult } from './types.js'

/**
 * 统一更新执行器（06 §3）：对单个用户 `recreate` 到新镜像 → 用新镜像重装 profile 依赖 → 就绪检查；
 * 失败 → 用**旧镜像** recreate 回滚。
 *
 * 顺序说明：06 §3 写的是「recreate → pnpm install → 就绪检查」。实例服务的 `recreate` 一次做完
 * 「建容器 + 启动 + 等就绪」，没有插 `pnpm install` 的位置，所以这里实现为
 * 「stop → 用新镜像的一次性容器 `pnpm install` → recreate（含就绪检查）」——依赖先装好再启动，
 * 语义等价且避免「起来又因为原生模块不匹配挂掉再重启一次」。
 */
export const UPGRADE_PNPM_TIMEOUT_MS = 5 * 60_000

export async function upgradeUser(
  deps: BaseDeps,
  userId: number,
  runtimeId: number,
  opts: { onLog?: (line: string) => void } = {},
): Promise<UpgradeUserResult> {
  const log = (line: string): void => opts.onLog?.(line)
  return withUserLock(
    userId,
    async () => {
      const user = getUserRuntimeRow(deps.db, userId)
      if (!user) throw new HubError('NOT_FOUND', '用户不存在')
      const runtime = getRuntimeRow(deps.db, runtimeId)
      if (!runtime) throw new HubError('NOT_FOUND', 'DSH 版本不存在')
      if (runtime.status !== 'ready') {
        throw new HubError('RUNTIME_NOT_READY', `版本 ${runtime.dsh_version} 的镜像还没就绪`)
      }
      if (user.runtime_id !== null && user.runtime_id !== runtimeId) {
        return {
          ok: true,
          rolledBack: false,
          skipped: true,
          error: `用户已钉在其它版本（#${String(user.runtime_id)}），本次跳过`,
        }
      }

      const services = (deps as Partial<AppDeps>).services
      const instances = services?.instances
      if (!instances) throw new HubError('INTERNAL', '实例服务未装配')

      const before = await instances.getSummary(userId)
      const previousRuntimeId = user.runtime_id
      const previousVersion = before.runtimeVersion
      log(
        `升级 ${user.username}：${previousVersion ?? '未知'} → ${runtime.dsh_version}（镜像 ${runtime.image}）`,
      )

      // 06 §5.1：disabled 用户「也执行，但不启动其实例」；没在跑的用户同理——只写期望状态，
      // 下次 start 时实例服务会因为 config_hash/image 变化自动用新镜像重建（05 §6）。
      if (user.status === 'disabled') {
        setUserRuntime(deps.db, userId, runtimeId, deps.clock.nowIso())
        log('用户已停用：只写期望版本，不启动容器')
        return { ok: true, rolledBack: false, skipped: true, error: '用户已停用，只写期望版本' }
      }
      const wasRunning = instances.currentStatus(userId) === 'running'
      if (!wasRunning) {
        setUserRuntime(deps.db, userId, runtimeId, deps.clock.nowIso())
        log('实例未在运行：只写期望版本，下次启动会用新镜像重建')
        return { ok: true, rolledBack: false, skipped: true, error: '实例未在运行，只写期望版本' }
      }

      try {
        setUserRuntime(deps.db, userId, runtimeId, deps.clock.nowIso())
        log('先停止当前容器，避免在新镜像上装依赖时旧进程还在跑')
        await instances.stop(userId, { reason: 'rollout' })
        await installProfileDeps(deps, userId, user.slug, log)
        await instances.recreate(userId, { reason: 'rollout' })
        log('升级完成，容器已就绪')
        return { ok: true, rolledBack: false }
      } catch (error) {
        const message = errorText(error)
        log(`升级失败：${message}`)
        try {
          const rollbackRuntimeId =
            previousRuntimeId ??
            (previousVersion ? (getRuntimeRowByVersion(deps.db, previousVersion)?.id ?? null) : null)
          log(
            rollbackRuntimeId === null
              ? '回滚：用默认镜像重建容器'
              : `回滚：用旧版本 #${String(rollbackRuntimeId)} 重建容器`,
          )
          setUserRuntime(deps.db, userId, rollbackRuntimeId, deps.clock.nowIso())
          await instances.recreate(userId, { reason: 'rollout' })
          // 容器已经在旧镜像上跑起来了，把「期望状态」恢复成升级前的样子（例如「未钉版本」）
          setUserRuntime(deps.db, userId, previousRuntimeId, deps.clock.nowIso())
          log('已回滚到旧镜像，用户可继续使用')
          return { ok: false, rolledBack: true, error: message }
        } catch (rollbackError) {
          const rollbackMessage = errorText(rollbackError)
          log(`回滚失败：${rollbackMessage}`)
          return { ok: false, rolledBack: false, error: `${message}；回滚也失败：${rollbackMessage}` }
        }
      }
    },
    { timeoutMs: 30 * 60_000 },
  )
}

/** 用**新镜像**的一次性容器重装 profile 依赖（原生模块可能跟 DSH 版本绑定） */
async function installProfileDeps(
  deps: BaseDeps,
  userId: number,
  slug: string,
  log: (line: string) => void,
): Promise<void> {
  if (!existsSync(join(deps.paths.userProfileDir(slug), 'package.json'))) {
    log('profile 还没有创建，跳过依赖重装（首次启动会自动生成）')
    return
  }
  const instances = (deps as Partial<AppDeps>).services?.instances
  if (!instances) throw new HubError('INTERNAL', '实例服务未装配')
  const spec = await instances.buildSpec(userId)
  log('用新镜像重装 profile 依赖：pnpm install')
  const result = await deps.driver.runOnce(
    spec,
    ['pnpm', 'install', '--dir', '/home/dsh/.dsh/profiles/web'],
    { timeoutMs: UPGRADE_PNPM_TIMEOUT_MS, onOutput: (chunk) => log(chunk.trimEnd()) },
  )
  if (result.exitCode !== 0) {
    // 装依赖失败不直接判死：DSH 自己的依赖在镜像里，profile 依赖装不上时启动仍可能成功，
    // 真正的判据是 recreate 后能否就绪（失败会被上层 catch 并回滚）。
    log(`pnpm install 退出码 ${String(result.exitCode)}（继续尝试启动）`)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { imageForVersion }
