import { installMockFetch } from './fetch'
import { installMockEventSource } from './eventsource'
import { MOCK_SCENARIOS, MOCK_SLUG, type MockScenario } from './state'

/**
 * 开发/截图用的假数据开关（任务书「完成定义」：`?mock=1`，代码放 `src/mocks/`，不进生产构建）。
 *
 * 用法（**仅 `pnpm dev` 时有效**）：
 * - `http://127.0.0.1:5176/home?mock=1` → 运行中场景；
 * - `?mock=stopped` / `starting` / `stopping` / `absent` / `error` / `capacity` / `exporting` / `plugins` / `empty`
 *   直接选场景（WP5b 截图走查用的就是这些）；
 * - `?mock=admin` / `?mock=admin-empty`：**管理端**场景（WP6）——当前用户变成管理员，
 *   `/api/admin/**` 由 `mocks/admin.ts` 提供假数据（04 §4 全量读取接口 + 常用写接口）；
 * - `?mock=0` 关掉。选择记在 `localStorage['hub.mock']`，SPA 内跳转不会掉。
 * - 算力租赁（WP17b，`mocks/compute.ts`）：`compute-off`（计费关闭）/ `compute-stopped` /
 *   `compute-running` / `compute-grace`（宽限中）/ `compute-low`（余额不足）/ `compute-exempt`（管理员免租）/
 *   `compute-custom`（有定制规格）。
 * - AI 助手桌面化（WP58，`mocks/cockpit.ts`）：`cockpit-boot`（点启动后 idle → starting → booting →
 *   connecting → ready，占位面板按脚本报 cockpit.status）/ `cockpit-fail`（第一次启动失败，演示 failed 与重试）/
 *   `cockpit-legacy`（老 App：cockpit.ready 不带 caps、不报 status）。
 * - Claude Code / Codex 管理（WP23b，`mocks/agent-modes.ts`）：`agent-modes`（在 `admin` 之上带两个模式的数据；
 *   用户端场景里两个模式都开通，`/usage` 能看到模式小节与按来源用量）。
 * - 搜索池（WP18b，`mocks/tools.ts`）：`admin-tools-off`（管理端看到搜索池关掉）/
 *   `tools-exhausted`（用户免费额度用完）。默认场景下搜索池开着。
 *
 * 生产构建里 `main.ts` 的 `if (import.meta.env.DEV)` 是死分支，Rollup 会把整个目录摇掉
 * （`apps/web/test/mocks.test.ts` 有一条构建产物检查兜底）。
 */
const STORAGE_KEY = 'hub.mock'

export function isMockScenario(value: string | null): value is MockScenario {
  return value !== null && (MOCK_SCENARIOS as readonly string[]).includes(value)
}

/** 从查询串/本地存储解析出要用的场景；`null` = 不启用假数据。 */
export function resolveMockScenario(search: string, stored: string | null): MockScenario | null {
  const params = new URLSearchParams(search)
  const flag = params.get('mock')

  if (flag === '0') return null
  if (flag !== null) {
    if (flag === '1' || flag === '')
      return isMockScenario(params.get('scenario')) ? (params.get('scenario') as MockScenario) : 'running'
    return isMockScenario(flag) ? flag : null
  }

  return isMockScenario(stored) ? stored : null
}

/**
 * 启用假数据（幂等）。返回选中的场景。
 * 调用方必须自己保证「只在开发环境调用」——本文件不允许被打进生产包。
 */
export function setupMocks(): MockScenario | null {
  if (typeof window === 'undefined') return null

  const scenario = resolveMockScenario(window.location.search, window.localStorage.getItem(STORAGE_KEY))
  if (!scenario) {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }

  window.localStorage.setItem(STORAGE_KEY, scenario)
  installMockFetch(scenario)
  installMockEventSource()
  // 走查时能一眼看出当前是假数据；不打印任何真实信息
  console.info(`[DSH Hub] mock 已启用：${scenario}（用户 ${MOCK_SLUG}）`)
  return scenario
}

/** `main.ts` 的入口：开发环境才可能启用。 */
export async function setupMocksIfEnabled(): Promise<MockScenario | null> {
  if (!import.meta.env.DEV) return null
  return setupMocks()
}
