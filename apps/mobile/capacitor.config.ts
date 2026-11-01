import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 壳配置（Android）。
 *
 * appId 是本项目的标识（`tech.dshhub.app`）：**fork 之后请改成你自己的包名**
 * （同时改 `android/app/build.gradle` 的 `namespace` / `applicationId`、
 * `app/src/main/res/values/strings.xml` 与 Java 源码的包路径），否则你的包会和官方包
 * 抢同一个 applicationId，装不上也发不了。
 *
 * webDir 指到 packages/mobile-ui/dist：`vite build` 之后直接 `cap sync`，不再多拷一份。
 * Hub 入口**不在这个文件里**：它由构建参数决定（`VITE_HUB_ORIGINS` 有序入口列表，
 * `VITE_HUB_ORIGIN` 单入口覆盖，`mock` 走进程内假 Hub）；一个都没配时，App 首次启动会
 * 让用户在登录页填服务器地址。多入口的自动切换见 packages/mobile-core/src/http/origin-manager.ts。
 * 明文 http 只在 debug 构建放行（app/src/debug/AndroidManifest.xml），release 保持禁止明文。
 */
const config: CapacitorConfig = {
  appId: 'tech.dshhub.app',
  appName: 'DSH Hub',
  webDir: '../../packages/mobile-ui/dist',
  android: {
    // 页面本身是 https://localhost。开发版可能连本机 http mock（e2e / mock 构建），
    // 仅 debug 壳 + cleartext 放行；正式版连 https，用不到这一项。
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  plugins: {
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
}

export default config
