import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * e2e 的常量与路径（本仓库的端口与网段约定）。
 *
 * 所有隔离手段都靠环境变量 + 独立数据目录 + 专属容器网络；**绝不碰生产对象**
 * （`dshhub-u*` / `dshhub-users` / `dshhub/runtime:*` 只读使用）。
 */

/** 仓库根（`e2e/src/` 往上两层） */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const E2E_DIR = join(REPO_ROOT, 'e2e')
export const DATA_ROOT = join(E2E_DIR, '.data')
/** 截图目录（可用 `E2E_SHOTS_DIR` 覆盖：换包/换里程碑跑时写到自己的目录） */
export const SHOTS_DIR = process.env['E2E_SHOTS_DIR'] ?? join(REPO_ROOT, 'docs', 'progress', 'WP8a-shots')

export const API_ENTRY = join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js')
export const CLI_ENTRY = join(REPO_ROOT, 'apps', 'api', 'dist', 'cli.js')
export const WEB_DIST_INDEX = join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html')
export const WEB_DIST_WAKE = join(REPO_ROOT, 'apps', 'web', 'dist', 'wake.html')

/**
 * 隔离参数（本仓库的端口约定（见 README） 按包分配端口与网段；环境变量可覆盖，方便别的包/别的机器复用同一套 harness）。
 * 默认用 e2e 专属的分配（11 §3 的 WP8a 行）：7790 明文、CDP 9230、网段 n=19、环境 `e2e`；
 * 其它包复用这套 harness 时用 `E2E_*` 环境变量换成自己的端口/网段。
 */
export const HTTP_PORT = Number(process.env['E2E_HTTP_PORT'] ?? 7790)
export const CDP_PORT = Number(process.env['E2E_CDP_PORT'] ?? 9230)
export const PUBLIC_ORIGIN = `http://127.0.0.1:${String(HTTP_PORT)}`

export const USERS_NETWORK = process.env['E2E_USERS_NETWORK'] ?? 'dshhub-test-e2e-net'
export const USERS_SUBNET = process.env['E2E_USERS_SUBNET'] ?? '10.219.19.0/24'
/** 环境标识与前缀：对账/清理只碰本环境的容器（WP2 第二轮的 `HUB_ENV_ID`/`HUB_CONTAINER_PREFIX`） */
export const ENV_ID = process.env['E2E_ENV_ID'] ?? 'e2e'
export const CONTAINER_PREFIX = `dshhub-test-${ENV_ID}-`

/**
 * 运行时镜像：已存在，只读使用（任务书要求不要重新构建；用 `cli runtime:adopt` 登记）。
 * 本机镜像版本会随 Hub 升级变化，所以允许用环境变量钉住（默认仍是 WP8a 那一版）。
 */
export const DSH_VERSION = process.env['E2E_DSH_VERSION'] ?? '0.2.0-rc.2'
export const RUNTIME_IMAGE = process.env['E2E_RUNTIME_IMAGE'] ?? `dshhub/runtime:${DSH_VERSION}`

/** 浏览器：playwright-core + 系统 Chrome（不下载浏览器） */
export const CHROME_PATH =
  process.env['E2E_CHROME_PATH'] ?? join(homedir(), '.local', 'bin', 'google-chrome')

/** 页面宽度：交付物要求截图 1440 宽；H1 走查也用这个基准 */
export const VIEWPORT = { width: 1440, height: 900 }

/** 测试账号（全部是假数据，密码只为过强度校验） */
export const ADMIN_USERNAME = 'hubadmin'
export const ADMIN_PASSWORD = 'E2e-Hubadmin-2026'

export const USER_A = { username: 'e2euser', password: 'E2e-Usera-20261', displayName: '小叶子' }
export const USER_B = { username: 'e2euserb', password: 'E2e-Userb-20262', displayName: '小云朵' }

/** 工作区里放的文件名（J5 写、J6 校验） */
export const PROOF_FILE = 'e2e-proof.txt'
export const PROOF_CONTENT = 'hello from WP8a e2e\n'

/** 单条旅程的兜底超时（毫秒）——真容器冷启动 + 导出打包都在里面 */
export const JOURNEY_TIMEOUT_MS = 8 * 60 * 1000

/** 首次「打开 DSH」的目标预算（10 §C1 要求 ≤ 60s） */
export const OPEN_DSH_BUDGET_MS = 60_000
