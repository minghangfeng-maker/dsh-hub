/**
 * 安装标识（installId）：App 首次启动随机生成、持久化在 localStorage。
 *
 * 用途（0.2.9）：登录时带给 Hub，Hub 用 `sha256(userId:installId)` 当 `install_key`，
 * 同一台手机反复登录/被顶掉后重登都复用同一条设备记录——以前每次登录都新建一条，
 * Hub 网页「桌面设备」里会堆出一串同名「Android · 7SUN」，还会把 10 台设备上限顶满。
 *
 * 它不是密钥（只是不透明随机串）：不需要进 SecureStorage；清 App 数据/重装后重新生成，
 * 对应「新安装 = 新设备」，符合预期。
 *
 * 手机网页版（WP54 / 契约 C10、C11）：同样存 localStorage，键名换成 `dshm.web.` 前缀
 * （网页版与 Hub 网页同源、共用一份 Storage，前缀划出 App 自己的命名空间，退出时更好清）。
 * 换一个浏览器 / 清站点数据 = 新的 installId = Hub 里一条新设备记录，符合「新安装」语义。
 */
import { IS_WEB_BUILD } from './app-info'
import { WEB_STORAGE_PREFIX } from './storage'

/**
 * 存储键：APK 保持 0.2.9 以来的历史键（换了键 = Hub 里多一条设备记录，升级后会翻倍）；
 * 手机网页版用 `dshm.web.` 前缀。
 */
const STORAGE_KEY = IS_WEB_BUILD ? `${WEB_STORAGE_PREFIX}install-id` : 'dsh-hub.install-id'
const PATTERN = /^[A-Za-z0-9_-]{8,64}$/

function randomInstallId(): string {
  const cryptoObj = globalThis.crypto
  const raw =
    cryptoObj?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  const id = raw.replace(/-/g, '')
  return id.length >= 8 ? id.slice(0, 64) : `${id}${Date.now().toString(36)}`.slice(0, 64)
}

let cached: string | null = null

/** 读取（或首次生成并保存）安装标识。localStorage 不可用时退化为进程内单例。 */
export function getInstallId(): string {
  if (cached !== null) return cached
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (saved !== null && saved !== undefined && PATTERN.test(saved)) {
      cached = saved
      return saved
    }
  } catch {
    /* 隐私模式/配额满：忽略，退化为内存值 */
  }
  const id = randomInstallId()
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
  cached = id
  return id
}
