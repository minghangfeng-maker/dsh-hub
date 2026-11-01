/**
 * App 的「启动脚本」：在 <head> 里同步执行，早于首屏渲染、也早于 App 主包（module 脚本）。
 *
 * 为什么是**独立文件**而不是 index.html 里的内联 `<script>`（WP54 / W5 手机网页版）：
 * 网页版由 Hub 同源托管在 `/m/`，下发的 CSP 是 `script-src 'self'`（WP54b 的
 * MOBILE_WEB_CONTENT_SECURITY_POLICY），内联脚本会被整段拦掉 —— 表现是暗色用户首屏
 * 闪一下浅色 + 控制台一条 CSP 违规。同一份文件由同一套构建（public/ → 产物根）拷进去，
 * APK 与网页版共用，用 `<script src="./theme-boot.js">` 引，相对路径（挂在 /m/ 下也对）。
 *
 * 这里做两件事，都必须抢在 App 主包求值之前：关掉 zod 的 JIT 探测、定首屏主题。
 */

/**
 * 1) 按掉一条 CSP 噪音：zod v4 的 `allowsEval` 会拿 `Function('')` 探一下能不能用它的
 * JIT 校验器；网页版的 CSP（`script-src 'self'`，没有 'unsafe-eval'）会拦下这次探测 ——
 * 异常被 zod 吞掉、校验结果完全正常，但控制台会留一条 `securitypolicyviolation`。
 * zod 官方为此留了 `config.jitless`（源码注释原文：Skip the probe under `jitless`）。
 *
 * 对 APK 的影响：APK 里 zod 因此走解释执行而不是 JIT。实测（zod 4.6.7，一次 WS 帧规模的
 * 对象校验）：JIT 0.199 µs/次、jitless 0.218 µs/次，差 0.02 µs，校验结果与错误信息相同。
 */
;(function () {
  try {
    var zodConfig = globalThis.__zod_globalConfig || (globalThis.__zod_globalConfig = {})
    zodConfig.jitless = true
  } catch (e) {
    /* ignore：老环境没有 globalThis 就算了，最多多一条 CSP 警告 */
  }
})()

/**
 * 2) 首屏之前定主题，避免浅色闪一下（开发文档 §6.3 第 6 条：冷启动不等网络）。
 *
 * 键要与 stores/settings.ts 一致：`dsh-hub:ui:v1`（0.2 起）；旧键 `dsh-hub:s0:settings`
 * 只做兼容读取。两个键要一致：只读旧键的话，选了暗色重启后又变回浅色（0.4.0 截图验收时发现）。
 */
;(function () {
  try {
    var raw = localStorage.getItem('dsh-hub:ui:v1') || localStorage.getItem('dsh-hub:s0:settings')
    var saved = JSON.parse(raw || '{}')
    var theme = saved.theme || 'system'
    var dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.background = dark ? '#17171A' : '#F9F8F6'
  } catch (e) {
    document.documentElement.dataset.theme = 'light'
  }
})()

/**
 * 3) 嵌入座舱（WP56d）：把入口的 search / hash **原文**留一份。
 *
 * 为什么（2026-10-29 踩到）：vue-router 的 hash 历史在创建时会对「不是以 `#/` 开头」的 hash
 * 调 `ensureSlash()`，把它改写成 `#/`。父页面把交接码塞在 `#code=…` 里，而 router 的创建
 * （模块求值）早于 main.ts 的正文 —— 到 `initCockpitEmbed()` 读地址栏时码已经被抹成 `#/` 了。
 * 这个脚本在 <head> 里同步执行、早于所有 module 脚本，所以这里留一份原文最稳
 * （不依赖打包器的 import 顺序）。
 */
;(function () {
  try {
    var entry = { search: location.search, hash: location.hash }
    window.__dshCockpitEntry = entry
    // 舰桥主题（`?embed=cockpit&theme=bridge`）：首屏之前就要定下来，否则浅色用户会先看到
    // 一块白底（上一段刚把 inline background 写成 #F9F8F6）。这里只做「深色 + 透明」，
    // 具体的色值在 styles/cockpit-bridge.css 里（作用域 html.cockpit-bridge）。
    if (!/[?&]embed=cockpit(&|$)/.test(entry.search)) return
    var root = document.documentElement
    // 控制台主题（WP58 / `?embed=cockpit&theme=console`）：强制浅色 + 透明底。
    // 同样的理由——上一段刚按用户设置写过 inline background（深色用户是 #17171A），
    // 不在这里覆盖掉，首屏会先黑一下才被主包改成浅色。具体样式在
    // styles/cockpit-console.css（作用域 html.cockpit-console）。
    if (/[?&]theme=console(&|$)/.test(entry.search)) {
      root.classList.add('cockpit-console')
      root.dataset.theme = 'light'
      root.style.background = 'transparent'
      return
    }
    if (!/[?&]theme=bridge(&|$)/.test(entry.search)) return
    root.classList.add('cockpit-bridge')
    root.dataset.theme = 'dark'
    root.style.background = 'transparent'
  } catch (e) {
    /* ignore */
  }
})()
