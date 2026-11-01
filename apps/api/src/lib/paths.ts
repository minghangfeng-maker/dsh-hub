import { mkdirSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { SLUG_REGEX } from '@dsh-hub/shared'
import { HubError } from './errors.js'

/**
 * `HUB_DATA_DIR` 下的目录布局（03 §2）。所有路径都从这里算，避免各处拼字符串。
 */
export interface HubPaths {
  root: string
  dbFile: string
  secretsDir: string
  masterKeyFile: string
  tlsDir: string
  avatarsDir: string
  usersDir: string
  pluginStoreDir: string
  /** 桌面整包（WP25b，裁决 #16）：`desktop-plugin-store/<包名>-<版本>.tgz` */
  desktopPluginStoreDir: string
  /** 桌面安装包与 blockmap（WP25b，裁决 #13）：`desktop-releases/bin/<target>/<file>` */
  desktopReleaseDir: string
  /** 安卓 APK 发布文件（WP40r）：`mobile-app/bin/<file>` */
  mobileAppDir: string
  runtimeBuildDir: string
  exportsDir: string
  trashDir: string
  logsDir: string
  /** `users/<slug>` */
  userDir(slug: string): string
  /** `users/<slug>/home` → 容器 /home/dsh */
  userHome(slug: string): string
  /** `users/<slug>/workspace` → 容器 /workspace */
  userWorkspace(slug: string): string
  /** `users/<slug>/managed` → 容器 /opt/hub/managed（只读） */
  userManaged(slug: string): string
  /** `users/<slug>/home/.dsh` */
  userDshHome(slug: string): string
  /** `users/<slug>/home/.dsh/profiles/web` */
  userProfileDir(slug: string): string
  /** `exports/<slug>` */
  userExportsDir(slug: string): string
  /** `exports/<slug>/<fileName>` */
  userExportFile(slug: string, fileName: string): string
  /** `trash/<slug>-<时间戳>` */
  trashTarget(slug: string, stamp: string): string
  /** `runtime-build/<version>` */
  runtimeBuildDirFor(version: string): string
  /** 建好基础目录（启动时调用一次） */
  ensureBaseDirs(): void
}

/**
 * 系统账号的 slug 白名单（WP56b / docs/24 §5）。
 *
 * 座舱 DSH 的容器名是 `dshhub-ops`（文档写死的名字），而容器名 = 前缀 + slug，
 * 所以这个账号的 slug 必须是 `ops` —— 它不满足 `SLUG_REGEX`（`u` + 7 位）。
 * 与其放宽正则（那会把 URL/代理的边界一起放宽），不如在这里给它一条**显式**的例外：
 * 只有这一个固定值，`../x` 之类的穿越仍然过不去。
 */
export const SYSTEM_ACCOUNT_SLUGS: ReadonlySet<string> = new Set(['ops'])

/** slug 进路径前必须校验：容器名/目录名都由它派生（决策 D4） */
function assertSlug(slug: string): string {
  if (SYSTEM_ACCOUNT_SLUGS.has(slug)) return slug
  if (!SLUG_REGEX.test(slug)) throw new HubError('VALIDATION_FAILED', `slug 不合法：${slug}`)
  return slug
}

/** 版本号/文件名进路径前的消毒：只允许字母数字点横线下划线 */
function assertSafeSegment(segment: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
    throw new HubError('VALIDATION_FAILED', `${what}不合法：${segment}`)
  }
  return segment
}

export function createPaths(root: string): HubPaths {
  const absRoot = resolve(root)
  const userDir = (slug: string) => join(absRoot, 'users', assertSlug(slug))
  return {
    root: absRoot,
    dbFile: join(absRoot, 'hub.db'),
    secretsDir: join(absRoot, 'secrets'),
    masterKeyFile: join(absRoot, 'secrets', 'master.key'),
    tlsDir: join(absRoot, 'secrets', 'tls'),
    avatarsDir: join(absRoot, 'avatars'),
    usersDir: join(absRoot, 'users'),
    pluginStoreDir: join(absRoot, 'plugin-store'),
    desktopPluginStoreDir: join(absRoot, 'desktop-plugin-store'),
    desktopReleaseDir: join(absRoot, 'desktop-releases'),
    mobileAppDir: join(absRoot, 'mobile-app'),
    runtimeBuildDir: join(absRoot, 'runtime-build'),
    exportsDir: join(absRoot, 'exports'),
    trashDir: join(absRoot, 'trash'),
    logsDir: join(absRoot, 'logs'),
    userDir,
    userHome: (slug) => join(userDir(slug), 'home'),
    userWorkspace: (slug) => join(userDir(slug), 'workspace'),
    userManaged: (slug) => join(userDir(slug), 'managed'),
    userDshHome: (slug) => join(userDir(slug), 'home', '.dsh'),
    userProfileDir: (slug) => join(userDir(slug), 'home', '.dsh', 'profiles', 'web'),
    userExportsDir: (slug) => join(absRoot, 'exports', assertSlug(slug)),
    userExportFile: (slug, fileName) =>
      resolveInside(join(absRoot, 'exports', assertSlug(slug)), assertSafeSegment(fileName, '导出文件名')),
    trashTarget: (slug, stamp) =>
      join(absRoot, 'trash', `${assertSlug(slug)}-${assertSafeSegment(stamp, '时间戳')}`),
    runtimeBuildDirFor: (version) => join(absRoot, 'runtime-build', assertSafeSegment(version, '版本号')),
    ensureBaseDirs() {
      for (const dir of [
        absRoot,
        this.secretsDir,
        this.avatarsDir,
        this.usersDir,
        this.pluginStoreDir,
        this.desktopPluginStoreDir,
        join(this.desktopReleaseDir, 'bin'),
        join(this.mobileAppDir, 'bin'),
        this.runtimeBuildDir,
        this.exportsDir,
        this.trashDir,
        this.logsDir,
      ]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
    },
  }
}

/**
 * 建好 `users/<slug>` 下的四个目录（用户根目录、home、workspace、managed）。
 * 必须在起容器之前调用：目录不存在时 Docker 会以 root 建 bind mount 目录，容器里的 uid 1000
 * 就写不了 `/home/dsh/.dsh`。已存在的目录一律不动（不 chown/chmod），所以可以反复调用。
 */
export function ensureUserDirs(paths: HubPaths, slug: string): void {
  for (const dir of [
    paths.userDir(slug),
    paths.userHome(slug),
    paths.userWorkspace(slug),
    paths.userManaged(slug),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

/**
 * 防路径穿越：把 `rel` 解析到 `root` 之下，拒绝绝对路径、`..` 逃逸、空字节。
 * 返回绝对路径（纯字符串判断，不跟随符号链接；需要时由调用方 `lstat`，见 06 §6）。
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new HubError('VALIDATION_FAILED', '路径不能为空')
  }
  if (rel.includes('\0')) throw new HubError('VALIDATION_FAILED', '路径包含非法字符')
  if (isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
    throw new HubError('VALIDATION_FAILED', '只允许相对路径')
  }
  const absRoot = resolve(root)
  const target = resolve(absRoot, normalize(rel))
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    throw new HubError('VALIDATION_FAILED', '路径越界')
  }
  return target
}

/** `target` 是否在 `root` 之内（符号链接检查之后的兜底） */
export function isInside(root: string, target: string): boolean {
  const absRoot = resolve(root)
  const absTarget = resolve(target)
  return absTarget === absRoot || absTarget.startsWith(absRoot + sep)
}
