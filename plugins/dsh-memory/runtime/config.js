/**
 * 配置归一。
 *
 * config 来自 cordis.patch.yml（部署级），设置页的定时整理设置另存
 * `settings.json`（见 store.js）。这里只处理注入预算这类部署级参数，
 * 并给每个字段兜底，避免行里少写一个键就让整个插件崩掉。
 *
 * @module @local/dsh-memory/config
 */

/** DESIGN.md §12 的默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  home: undefined,
  hotBudgetChars: 6000,
  injectBudgetChars: 9000,
  recentSessions: 20,
  graceSessions: 5,
  staleDays: 30,
  subagentWrites: 'inbox',
})

/** 把未知值收敛成整数。 */
function int(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

/**
 * 归一插件配置。
 * @param {object} [config] - cordis 行 config。
 * @returns {object} 完整配置。
 */
export function resolveConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const subagentWrites = ['inbox', 'deny', 'allow'].includes(source.subagentWrites)
    ? source.subagentWrites
    : DEFAULT_CONFIG.subagentWrites
  return {
    home: typeof source.home === 'string' && source.home.trim() ? source.home.trim() : undefined,
    hotBudgetChars: int(source.hotBudgetChars, DEFAULT_CONFIG.hotBudgetChars, 500, 200_000),
    injectBudgetChars: int(source.injectBudgetChars, DEFAULT_CONFIG.injectBudgetChars, 1000, 200_000),
    recentSessions: int(source.recentSessions, DEFAULT_CONFIG.recentSessions, 1, 500),
    graceSessions: int(source.graceSessions, DEFAULT_CONFIG.graceSessions, 0, 500),
    staleDays: int(source.staleDays, DEFAULT_CONFIG.staleDays, 1, 3650),
    subagentWrites,
  }
}
