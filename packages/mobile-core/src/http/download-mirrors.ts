/**
 * 更新包镜像（0.4.11 / WP52）：同一个 APK 的多个下载地址，按**顺序**尝试。
 *
 * Hub 在 `bootstrap.app.downloadMirrors` 里下发全部可用地址（本入口排第一、另一个入口
 * 排第二，Hub 自己去重）；老 Hub 没有这个字段，只有 `downloadUrl`。
 *
 * 这里只做「顺序 + 去重 + 合法性」这一层纯计算，真正的下载与失败回退在 ui 的
 * `lib/update-download.ts`（网络失败 / 空闲超时 / 字节数或 sha256 不符就换下一个）。
 */

export interface DownloadSourceInfo {
  downloadUrl: string | null
  /** 0.4.11：老 Hub 没有这个字段。 */
  downloadMirrors?: string[] | undefined
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value)
}

/**
 * 展开成有序的下载地址列表。
 *
 * `downloadMirrors` 在前（保留 Hub 给的顺序），`downloadUrl` 兜底追加（去重）；
 * 非法地址直接丢掉。全部没有就返回空数组（界面显示「去官网下载」）。
 */
export function resolveDownloadMirrors(app: DownloadSourceInfo | null | undefined): string[] {
  if (!app) return []
  const out: string[] = []
  const push = (raw: string | null | undefined): void => {
    if (typeof raw !== 'string') return
    const url = raw.trim()
    if (!isHttpUrl(url) || out.includes(url)) return
    out.push(url)
  }
  for (const mirror of app.downloadMirrors ?? []) push(mirror)
  push(app.downloadUrl)
  return out
}
