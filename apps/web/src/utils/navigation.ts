/**
 * 整页跳转（不是 SPA 路由跳转）。
 *
 * 只有需要离开 SPA 时用它：桌面授权页点「允许 / 拒绝」后回到桌面端的本机回环地址，
 * 以及 `router/index.ts` 里 `/dsh/<用户名>/` 这类由服务端处理的路径。
 *
 * 单独抽一个函数是为了可测：jsdom 没有导航能力，测试里 `vi.mock('@/utils/navigation')`
 * 就能断言「跳到了哪个地址」而不用碰 `window.location`（它的方法不可 writable）。
 */
export function replaceLocation(url: string): void {
  window.location.replace(url)
}
