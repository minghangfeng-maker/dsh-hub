# 手机端（APK + 手机网页版）

同一套界面（Vue 3 + Pinia + TypeScript，`packages/mobile-ui`）有两个产物：

- **APK**：`apps/mobile` 里的 Capacitor 8 安卓壳，Web 资源来自 `packages/mobile-ui/dist`；
- **手机网页版**：`packages/mobile-ui/dist-web`，由 hub-api 同源托管在 `/m/`。

核心逻辑（Hub api-client、手机通道、会话缓存、入口切换）在 `packages/mobile-core`，
不依赖 Vue 与 Capacitor，单测覆盖得最全。

```
apps/mobile/            Capacitor 壳：capacitor.config.ts + android/（Gradle 工程）
apps/mock-hub/          本地假 Hub（Node + ws）：登录、bootstrap、唤醒、ticket、通道 v1 帧
packages/mobile-core/   框架无关的核心（含契约对拍 fixtures：test/fixtures/）
packages/mobile-ui/     界面层；public/ 是 PWA 的 manifest 与图标
scripts/                build-apk / build-web / gen-brand-assets / verify-no-mock / e2e-run + e2e-*
```

## 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | 24.x（仓库根 `.nvmrc`） |
| pnpm | 10.33.2（`packageManager` 已固定） |
| JDK | 21（出 APK 用；`JAVA_HOME`） |
| Android SDK | platform 36 / build-tools 36；`ANDROID_HOME` 指向 SDK 根 |

依赖在**仓库根**装一次即可：`pnpm install`。

## 跑起来（不必连真 Hub）

```bash
pnpm mock:hub                  # 终端 1：本地假 Hub（默认 5245，端口限定 5242–5250）
pnpm dev:mobile                # 终端 2：vite dev server（5242）

# 让 dev server 指向假 Hub（默认没有内置入口，会要求手填地址）
VITE_HUB_ORIGIN=http://127.0.0.1:5245 pnpm dev:mobile
```

假 Hub 的测试账号是 `demo` / `demo1234`（`VITE_HUB_ORIGIN=mock` 的构建里会预填）。
浏览器打开 `http://127.0.0.1:5242/` 即可看到登录页。

## 配置入口（Hub 地址）

**仓库里不写死任何 Hub 地址。** 入口由构建参数决定（见 `packages/mobile-core/src/config.ts`）：

| 变量 | 作用 |
| --- | --- |
| `VITE_HUB_ORIGINS` | 内置入口列表，逗号分隔、第一个是首选：`https://hub.example.com,https://backup.example.com` |
| `VITE_HUB_ORIGIN_LABELS` | 网络检测页的入口短标签：`https://hub.example.com=主站,https://backup.example.com=备用`；不配就显示主机名 |
| `VITE_HUB_ORIGIN` | 单入口覆盖（开发 / 联调 / e2e 用）；`mock` = 进程内假 Hub，不联网 |

优先级：`VITE_HUB_ORIGIN` 覆盖 > 用户手填并持久化的地址 > `VITE_HUB_ORIGINS` 列表。

- **一个都没配**：APK 首次启动时登录页会显示「服务器地址（必填）」输入框，用户填自己的 Hub
  地址（可省略 `https://`，也可填局域网 `http://192.168.1.10:7700`），存进 `localStorage`
  的 `dsh-hub:server-address`，之后每次启动直接用它。内置了地址的包把这个输入框收在登录页
  底部的「服务器地址」按钮里，用来换服务器或修正地址。
- **多入口**：列表里第二个及以后的入口是备用入口。主入口网络层失败（TLS 失败 / 超时 / 被拦截页）
  时，App 会探测备用入口的 `GET /api/health`，通了就切过去并重放这次请求；Hub 返回的 JSON
  业务错误（401/403/429/5xx）**不会**触发切换。切过一次会记住，回前台静默探回首选。
- **手机网页版**不看这些变量：它由 Hub 同源托管在 `/m/`，入口永远是页面自己的 origin
  （`VITE_HUB_ORIGIN` 只在联调时覆盖）。

## 构建 APK

```bash
export JAVA_HOME=/path/to/jdk21
export ANDROID_HOME=/path/to/android-sdk

# 1) 无内置入口（登录页手填）—— 默认
pnpm apk

# 2) 内置入口
VITE_HUB_ORIGINS=https://hub.example.com pnpm apk

# 3) 自包含开发版：进程内假 Hub，不联网
bash scripts/build-apk.sh mock
```

产物：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`，同时复制一份到
`scripts/release/out/`（`APK_OUT_DIR` 可改，设为空串则不复制）。

手动分工（其实 `build-apk.sh` 就是这三步）：

```bash
pnpm build:mobile                                   # packages/mobile-ui/dist
(cd apps/mobile && ./node_modules/.bin/cap sync android)
(cd apps/mobile/android && ./gradlew :app:assembleDebug --max-workers=2)
```

**正式签名包**：`scripts/release/gen-keystore.sh` 生成 keystore（只生成，自己备份），
`scripts/release/build-release.sh` 打 release 包。口令与 keystore 路径**只从环境变量读**
（`DSH_HUB_APP_KEYSTORE` / `DSH_HUB_APP_KEYSTORE_PASSWORD` / `DSH_HUB_APP_KEY_PASSWORD`），
不写进仓库、不进命令行。发布后可用 `scripts/release/verify-apk.sh` 核对
「发布记录 → 归档 → 公网下载」三处 sha256（要配 `HUB_ADMIN_BASE` 等变量，见脚本头部）。

版本号在 `apps/mobile/android/app/build.gradle`（`versionCode` / `versionName`）；
界面里显示的版本在 `packages/mobile-ui/src/lib/app-info.ts`（`APP_VERSION` /
`APP_VERSION_CODE`），两处要一起改。

## 构建手机网页版（`/m/`）

```bash
pnpm build:mobile-web          # = bash scripts/build-web.sh，产出 packages/mobile-ui/dist-web
```

脚本会做三项自检：产物里**没有** MockHub、`version.json` 合法且与 `index.html` 同目录、
网页专属代码确实在（`VITE_TARGET=web` 生效）。Hub 默认就从
`packages/mobile-ui/dist-web` 托管 `/m/`（`HUB_MOBILE_WEB_DIR` 可覆盖），手机 UA 打开首页会
自动 302 到 `/m/`，`/?view=desktop` 记住「要看电脑版」。

- 页面用 hash 路由，`base: './'`，所以挂在哪个子路径都能跑；
- 不加 service worker：更新检查靠 `/m/version.json`（`version` + git 短 sha），回前台/每 30 分钟
  拉一次；
- 图标 / 启动图全部由一份脚本铺出来：`node scripts/gen-brand-assets.mjs`
  （源图在 `scripts/assets/brand/`，品牌定稿素材「星座鲸」；PWA 四张、安卓三套密度图与 11 张
  启动图、管理台的 favicon 都在这一条命令里生成。用 Chrome 按精确视口截图，不引入图像库；
  `CHROME_BIN` 可指定浏览器，`--only pwa|android|web` 只跑一部分）。

## 测试

```bash
# 单测（core 必须显式 NODE_ENV=development；package.json 里已经用 cross-env 设好了）
pnpm --filter @dsh-hub/mobile-core test
pnpm --filter @dsh-hub/mobile-ui test

# 类型检查（.ts；.vue 单文件组件暂未接 vue-tsc）
pnpm --filter @dsh-hub/mobile-core typecheck
pnpm --filter @dsh-hub/mobile-ui typecheck

# 正式产物里不能有 MockHub（先构建 dist）
bash scripts/verify-no-mock.sh              # 反向：mock 构建用 --expect-mock
```

契约 fixtures 在 `packages/mobile-core/test/fixtures/`（通道 v1 的客户端/服务端帧 + v2 的
模型目录），测试**逐字节**对拍：任何一侧改了帧形状，这里立刻红。

## 端到端（e2e）

统一用运行器，**不要**自己起 mock hub / vite / Chrome（它会挑空闲端口、校验 vite 确实是本仓库
起的、跑完按 PID 收干净）：

```bash
bash scripts/e2e-run.sh --list          # 看有哪些
bash scripts/e2e-run.sh a1 a2           # 登录 + 首页基础流程
bash scripts/e2e-run.sh origin conn     # 多入口切换 / 连接与重连
bash scripts/e2e-run.sh web-smoke       # 手机网页版冒烟（自己 build-web + 起托管 /m/ 的假 Hub）
bash scripts/e2e-run.sh -j 3 all        # 全量回归（3 并行）
```

每个名字对应 `scripts/e2e-<名字>.mjs`；输出在 `.e2e-runs/<时间戳>/`（不入库）。
需要 Chrome；默认找 `google-chrome`/`chromium`，也可以 `CHROME=/path/to/chrome` 指定。

## fork 之后要改的

1. **包名**：`apps/mobile/android/app/build.gradle` 的 `namespace` / `applicationId`、
   `capacitor.config.ts` 的 `appId`、`app/src/main/res/values/strings.xml` 的
   `package_name` / `custom_url_scheme`，以及 Java 源码目录 `tech/dshhub/app/` 的包路径。
   不改会与官方包抢同一个 applicationId。
2. **内置入口**：`VITE_HUB_ORIGINS`（见上）。
3. **图标 / 启动图**：`packages/mobile-ui/public/*.png`、`apps/mobile/android/app/src/main/res/`
   下的 `mipmap-*` 与 `drawable-*` 启动图。把它们换成你自己的图，或者替换
   `scripts/assets/brand/` 里的源图后重跑 `node scripts/gen-brand-assets.mjs`。
   注意 PWA 的四个文件名（`icon-192.png` / `icon-512.png` / `icon-maskable-512.png` /
   `apple-touch-icon-180.png`）被 `index.html`、manifest 与 e2e 断言引用，改名要一起改。
