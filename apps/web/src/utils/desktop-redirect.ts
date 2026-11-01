/**
 * 桌面端回环回调地址的白名单（防开放重定向，D2 §3.5）。
 *
 * 授权页点「允许 / 拒绝」后要整页跳到**后端返回**的地址（`http://127.0.0.1:<port>/oauth/hub/callback?code=…`）。
 * 后端正常只会拼回环地址（契约 `LoopbackRedirectUriSchema` 校验过 `redirect_uri`），
 * 但前端不能把「跳去哪」完全交给响应体：一旦后端被改坏 / 被中间人改写，就是一个开放重定向，
 * 用户在授权页刚点过「允许」的账号上下文会被带去别的站点。所以这里再判一次：
 *
 * - 协议只认 `http:`（回环明文，桌面端在本机监听）；
 * - 主机只认 `127.0.0.1` / `localhost` / `[::1]`；
 * - **必须显式带端口**（1–65535）：桌面端用的是随机高位端口，`http://127.0.0.1/…` 是 80，不是它。
 *
 * 注意与契约里的 `LoopbackRedirectUriSchema` 的区别：那个校验的是**请求里的 redirect_uri**
 * （不允许查询串），这里校验的是**响应里的 redirectUrl**（带 `?code=&state=`）。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function isLoopbackRedirectUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'http:') return false
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false
  // `URL` 会把 `http://127.0.0.1:0/` 的端口归一成 '0'，把省略端口归一成 ''：两种都不合法
  if (url.port === '') return false

  const port = Number(url.port)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}
