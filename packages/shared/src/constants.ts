/**
 * 全局常量（02 §5、03 §1.5 §1.6、04）。
 * 这里只放**纯数据**，不放 zod schema —— schema 在 common.ts / api/*.ts，避免循环依赖。
 */

// ── 用户名 / slug ────────────────────────────────────────────────────────────

/** 用户名：小写字母开头，3–32 位小写字母/数字/`-`/`_`（02 §5） */
export const USERNAME_REGEX = /^[a-z][a-z0-9_-]{2,31}$/

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 32
/** 用户名修改冷却期：30 天（04 §0.2 USERNAME_CHANGE_TOO_SOON） */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 30

/**
 * 用户回收站保留天数（03 §2 `trash/`、10 §G2）：删除用户后可在 7 天内恢复；
 * 超过 7 天的回收站条目由后台清理任务彻底删除。删除时用户名**立即释放**
 * （改名为 `<原名>#del<id>`），因此 7 天内同名新用户可能与待恢复用户并存，
 * 恢复时原名被占用就要另选用户名。
 */
export const USER_TRASH_RETENTION_DAYS = 7
/** 删除后给用户名加的墓碑后缀前缀（不满足 USERNAME_REGEX，永远无法被注册/登录） */
export const DELETED_USERNAME_SUFFIX = '#del'

/** 保留用户名（02 §5；一律小写比较） */
export const RESERVED_USERNAMES = [
  'admin',
  'administrator',
  'root',
  'system',
  'api',
  'u',
  'assets',
  'static',
  'me',
  'setup',
  'hub',
  'dsh',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'health',
  'public',
  'www',
  'support',
  'help',
  'null',
  'undefined',
  'test',
] as const

export function isReservedUsername(username: string): boolean {
  return (RESERVED_USERNAMES as readonly string[]).includes(username.trim().toLowerCase())
}

/** 用户 URL/slug：`u` + 7 位 `[a-z0-9]`（决策 D4） */
export const SLUG_REGEX = /^u[a-z0-9]{7}$/
export const SLUG_RANDOM_LENGTH = 7

// ── 角色标签 ────────────────────────────────────────────────────────────────

/**
 * 普通用户的自定义角色标签（如「家人」「朋友」）：只是显示名，权限仍只看 `role`。
 * 空串 = 「普通用户」；管理员恒为空串、统一显示「管理员」。
 */
export const ROLE_LABEL_MAX_LENGTH = 16
export const ROLE_TEXT_ADMIN = '管理员'
export const ROLE_TEXT_USER = '普通用户'

// ── 密码 ────────────────────────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 200
/** 至少包含「字母/数字/符号」中的两类（02 §5） */
export const PASSWORD_MIN_CLASSES = 2

/** 弱口令黑名单（内置 Top-N 的常用部分；WP1 可扩充到 Top-1000，规则不变） */
export const WEAK_PASSWORDS = [
  'password',
  'password1',
  'password123',
  'passw0rd',
  '1234567890',
  '123456789',
  '12345678',
  'qwertyuiop',
  'qwerty123',
  '1qaz2wsx3edc',
  'iloveyou',
  'admin12345',
  'administrator',
  'letmein123',
  'welcome123',
  'abc123456',
  'abcd1234',
  'a123456789',
  '1111111111',
  '0000000000',
  'asdfghjkl',
  'zxcvbnm123',
  'p@ssw0rd',
  'deepseek123',
  'dshhub123',
] as const

// ── 邀请码 ──────────────────────────────────────────────────────────────────

/**
 * 12 位大写字母数字，去掉易混字符（`0 O 1 I L`，WP1 任务书；03 §1.1 invites.code）。
 * `L` 与 `1`/`I` 在手写体里最容易混，所以一并排除。
 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 12
export const INVITE_CODE_REGEX = /^[A-HJKMNP-Z2-9]{12}$/
export const INVITE_MAX_COUNT_PER_REQUEST = 50

// ── 配额（03 §1.5 / 00 Q5） ──────────────────────────────────────────────────

export const QUOTA_LIMITS = {
  cpus: { min: 0.5, max: 8 },
  memoryMb: { min: 512, max: 8192 },
  pidsLimit: { min: 64, max: 8192 },
  diskGb: { min: 1, max: 200 },
  idleStopMinutes: { min: 0, max: 10080 },
  idleNoClientMinutes: { min: 0, max: 10080 },
} as const

export const DEFAULT_QUOTA = {
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 1024,
  diskGb: 20,
  idleStopMinutes: 120,
  /** 无人在看（没有打开的 WS）时的休眠阈值（docs/22 §6.2）；0 = 沿用 idleStopMinutes */
  idleNoClientMinutes: 30,
  allowUserPlugins: true,
}

// ── settings 默认值（03 §1.6） ───────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  site: {
    name: 'DSH Hub',
    tagline: '探索未至之境',
    announcement: '',
    announcementLevel: 'info',
  },
  registration: {
    mode: 'invite',
    requireApproval: false,
    maxUsers: 50,
  },
  default_quota: DEFAULT_QUOTA,
  capacity: {
    maxRunning: 12,
    maxConcurrentExports: 2,
    /** 连续「进行中」超过这么多分钟才按空闲规则处理（docs/22 §6.2）；0 = 不限 */
    busyMaxMinutes: 720,
  },
  exports: {
    ttlHours: 24,
    maxBytes: 21474836480,
    dailyLimit: 5,
  },
  security: {
    adminSessionHours: 12,
    reauthMinutes: 10,
  },
  /** 桌面端设备台账（D6 §5.5；WP25a） */
  desktop: {
    maxDevicesPerUser: 5,
    reportIntervalSec: 60,
    minReportIntervalSec: 10,
    offlineAfterSec: 180,
    diagnosticsAllowed: false,
  },
  /**
   * 手机 App（WP40a）：版本地板默认「1 / 1 / 没有下载地址」——
   * 也就是**不拦任何版本**，管理端配了才有实际效果（v2 §4.5）。
   */
  mobile: {
    app: {
      minVersionCode: 1,
      latestVersionCode: 1,
      downloadUrl: null,
    },
  },
  /** 容器设置（WP40d）：手机 App 默认在容器内完全放行；容器就是隔离边界 */
  container: {
    permissionPreset: 'danger-full-access',
    chatPreset: false,
  },
  /** 管理座舱（WP56a / docs/24 §3.2）：R1 默认自动执行；模型默认 deepseek-v4.1-flash */
  cockpit: {
    model: 'deepseek-v4.1-flash',
    autoExecuteR1: true,
  },
}

/** settings 表的全部键（03 §1.6） */
export const SETTINGS_KEYS = [
  'site',
  'registration',
  'default_quota',
  'capacity',
  'exports',
  'security',
  'desktop',
  'mobile',
  'container',
  'cockpit',
] as const

// ── 会话 / 安全 ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'hub_sid'
/** 普通会话 30 天滑动过期（02 §5） */
export const SESSION_TTL_DAYS = 30
/** 管理员会话 12 小时绝对过期（02 §5，可被 settings.security 覆盖） */
export const ADMIN_SESSION_HOURS = 12
/** 敏感操作二次验证窗口（分钟） */
export const REAUTH_WINDOW_MINUTES = 10
/** CSRF 上传请求要求的头（04 §0） */
export const CSRF_HEADER = 'x-hub-csrf'

// ── 实例 / 代理 ─────────────────────────────────────────────────────────────

export const CONTAINER_NAME_PREFIX = 'dshhub-'
export const CONTAINER_LABEL_MANAGED = 'dshhub.managed'
export const CONTAINER_PORT = 3000
export const INSTANCE_READY_TIMEOUT_MS = 90_000
/** 代理活跃度落库节流（05 §5） */
export const INSTANCE_ACTIVITY_FLUSH_MS = 30_000
/** SSE 心跳间隔（04 §0） */
export const SSE_PING_INTERVAL_MS = 20_000
/** 单用户 WS 连接上限（02 §7） */
export const MAX_WS_PER_USER = 20

// ── 上传 ────────────────────────────────────────────────────────────────────

export const AVATAR_MAX_BYTES = 1024 * 1024
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const AVATAR_SIZE = 512
/** JSON 请求体上限（04 §0.2 PAYLOAD_TOO_LARGE） */
export const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024
/** 插件包上传上限（04 §10.7：统一 50MB，文档与实现一致） */
export const PLUGIN_UPLOAD_MAX_BYTES = 50 * 1024 * 1024

// ── 导出 ────────────────────────────────────────────────────────────────────

export const EXPORT_PARTS = ['workspace', 'sessions', 'settings', 'profile-plugins'] as const
export const EXPORT_FORMATS = ['zip', 'tar.gz'] as const
/** 导出列表一次最多返回条数（04 §3.3） */
export const EXPORT_LIST_LIMIT = 20

// ── 审计动作（04 §7，逐条展开） ─────────────────────────────────────────────

export const AUDIT_ACTIONS = [
  'auth.register',
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.password.change',
  'user.create',
  'user.update',
  'user.username.change',
  'user.avatar.change',
  'user.approve',
  'user.disable',
  'user.enable',
  'user.role.change',
  'user.quota.change',
  'user.password.reset',
  'user.delete',
  'user.restore',
  'user.purge',
  'user.sessions.revoke',
  'instance.start',
  'instance.stop',
  'instance.restart',
  'instance.recreate',
  'instance.error',
  'instance.admin.open',
  'invite.create',
  'invite.update',
  'invite.delete',
  'settings.update',
  'plugin.create',
  'plugin.update',
  'plugin.delete',
  'plugin.version.add',
  'plugin.version.delete',
  'runtime.build',
  'runtime.default',
  'runtime.retire',
  'runtime.delete',
  'model.provider.create',
  'model.provider.update',
  'model.provider.delete',
  'model.provider.key.change',
  'model.catalog.change',
  'model.preset.create',
  'model.preset.update',
  'model.preset.delete',
  'rollout.create',
  'job.cancel',
  'job.retry',
  'export.create',
  'export.download',
  // 桌面端（WP25a / D6 §7.4）：心跳不上审计（每天几万条噪音），只记登录/吊销/换模式密钥
  'desktop.login',
  'desktop.revoke',
  'desktop.admin-revoke',
  'desktop.agent-mode-key',
] as const

/** 审计保留天数（02 §5） */
export const AUDIT_RETENTION_DAYS = 180

// ── 路由 key（模型提供方） ──────────────────────────────────────────────────

export const ROUTE_KEY_REGEX = /^[a-z][a-z0-9-]{1,31}$/
/** 提供方密钥注入容器的环境变量前缀：`HUB_MK_<ROUTE_KEY 大写下划线>`（05 §4） */
export const PROVIDER_KEY_ENV_PREFIX = 'HUB_MK_'

/** pi-ai 支持的思考档位，按强度递增（真容器 `dsh-llm-pi-ai` 的 THINKING_LEVELS） */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
