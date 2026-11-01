/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 单入口覆盖：`mock`（进程内假 Hub）或一个 http(s) 地址。
   * 开发 / e2e / 联调用；正式包不要设它（要内置地址请用 `VITE_HUB_ORIGINS`）。
   */
  readonly VITE_HUB_ORIGIN?: string
  /**
   * 内置入口列表（逗号分隔，第一个是首选）：`https://hub.example.com,https://backup.example.com`。
   * 不设 = 这个包没有内置入口，登录页要求用户填服务器地址。
   */
  readonly VITE_HUB_ORIGINS?: string
  /** 入口标签（`<origin>=<标签>`，逗号分隔）：网络检测页显示用；不配就显示主机名。 */
  readonly VITE_HUB_ORIGIN_LABELS?: string
  /** `web` = 构建手机网页版（Hub 同源托管在 `/m/`）；不设 = APK。 */
  readonly VITE_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
