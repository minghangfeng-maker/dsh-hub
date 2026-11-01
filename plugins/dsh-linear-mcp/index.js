/**
 * linear-mcp —— 稳定的装载壳（Loader 行指向的就是这个文件）。
 *
 * 为什么要有这一层：Loader 重挂载一行时会重新 import 该行的模块 URL，但同一个
 * URL 命中 Node 的 ESM 缓存，于是改动代码不会被加载（本 profile 里 image-gen /
 * tavily 用「releases/index.rN.js + 改补丁 name」绕开这件事）。这里换一种更省事的
 * 办法：壳子本身稳定不变（缓存无所谓），真正的实现在 impl.js，由 apply() 在**每次
 * 挂载时**用带 cache-busting query 的 file URL 重新 import —— 所以只要让这一行重
 * 新挂载（POST /_dsh/linear-mcp/dev-reload，或改本 bundle 的 patch 后重装/重启），
 * 新代码就会生效，不必发布 releases 代次。
 *
 * @module @local/dsh-linear-mcp
 */

import { pathToFileURL } from 'node:url'

/** Cordis 插件名（Loader 行 id 之外，Cordis 记录的插件标识）。 */
export const name = 'linear-mcp'

/** 依赖的 Host 服务：浏览器 HTTP 载体（设置页与 OAuth 回调都走它）+ 工具表（读已挂上的 mcp__linear__* 工具）。 */
export const inject = ['webServer', 'tools']

/**
 * 载入当前实现并交给它挂载。
 *
 * @param ctx - 插件 Context。
 * @param config - Loader 行 config（本插件不导出 Config schema，原样透传）。
 * @returns 实现的 apply 结果（挂载完成后 resolve）。
 */
export async function apply(ctx, config) {
  const url = new URL('./impl.js', import.meta.url)
  // 唯一化 query：同一份 impl.js 每次挂载都拿到新的模块实例，改完代码即生效。
  url.searchParams.set('v', String(Date.now()))
  const impl = await import(url.href)
  return await impl.apply(ctx, config)
}

export default { name, inject, apply }
