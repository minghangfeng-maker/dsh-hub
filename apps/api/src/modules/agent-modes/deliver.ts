import { LABEL_CONFIG_HASH, computeConfigHash, containerNameFor } from '../instances/index.js'
import type { AppDeps } from '../../context.js'

/**
 * 18 §4.2：把「该用户当前容器规格」与「按当前设置算出的期望规格」比一比。
 *
 * 模式 env 已经通过 `models.containerEnv` 的晚绑定桥进了规格，所以 `config_hash` 天然覆盖
 * 「开通 / 移出 targets / 密钥轮换」三种变化。这里不重写 models.applyForUser，只复用它的判断口径
 * （env 变了且实例在跑 → now 重建 / next-start 只落盘；没跑 → 下次启动生效）。
 */
export async function containerEnvApplied(
  deps: AppDeps,
  user: { id: number; slug: string },
): Promise<boolean | null> {
  const instances = deps.services.instances
  if (!instances) return null
  if (instances.currentStatus(user.id) !== 'running') return null
  try {
    const spec = await instances.buildSpec(user.id)
    const expected = computeConfigHash(spec)
    const info = await deps.driver.inspect(containerNameFor(user.slug, deps.config.containerPrefix))
    if (!info) return false
    return info.labels[LABEL_CONFIG_HASH] === expected
  } catch (error) {
    deps.logger.warn({ err: error, userId: user.id }, '读取容器 env 是否生效失败')
    return false
  }
}

export interface ApplyEnvResult {
  /** true = 已生效 / 已重建；false = 规格不一致但按 next-start 留到下次；null = 实例没在跑 */
  applied: boolean | null
  recreated: boolean
  restarted: boolean
}

/**
 * 应用模式 env（18 §4.2 第 2 步）。`forceRestart` = 本次装了插件（插件安装本来就要求重启）。
 * 调用方负责在用户锁内执行（jobs 引擎已经按用户串行）。
 */
export async function applyAgentModeEnv(
  deps: AppDeps,
  userId: number,
  opts: { onLog: (line: string) => void; restart: 'now' | 'next-start'; forceRestart?: boolean },
): Promise<ApplyEnvResult> {
  const instances = deps.services.instances
  if (!instances) return { applied: null, recreated: false, restarted: false }
  const user = deps.db.get<{ id: number; slug: string }>(
    'SELECT id, slug FROM users WHERE id = ? AND deleted_at IS NULL',
    userId,
  )
  if (!user) throw new Error(`用户 ${String(userId)} 不存在`)
  const status = instances.currentStatus(userId)
  if (status !== 'running') {
    opts.onLog('实例没在运行：配置将在下次启动时生效')
    return { applied: null, recreated: false, restarted: false }
  }
  const applied = await containerEnvApplied(deps, user)
  if (applied === true) {
    if (opts.forceRestart === true) {
      opts.onLog('容器 env 已是最新，但本次装了插件，重启 DSH')
      await instances.restart(userId, { reason: 'rollout' })
      return { applied: true, recreated: false, restarted: true }
    }
    opts.onLog('容器 env 已是最新，无需重启')
    return { applied: true, recreated: false, restarted: false }
  }
  if (opts.restart === 'next-start') {
    opts.onLog('按 restart=next-start：容器 env 变化将在下次启动 DSH 时生效')
    return { applied: false, recreated: false, restarted: false }
  }
  opts.onLog('模式 env 有变化，重建容器')
  await instances.recreate(userId, { reason: 'rollout' })
  opts.onLog('容器已重建并就绪')
  return { applied: true, recreated: true, restarted: false }
}
