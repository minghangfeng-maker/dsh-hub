# @dsh-hub/e2e —— 端到端测试（WP8a）

用**真 Docker + 构建产物 + 真浏览器**跑阶段一的用户旅程（J1–J10），产出截图与 `result.json`。
设计约定见 `docs/design/10-验收标准.md`。

## 跑

```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NODE_USE_ENV_PROXY
pnpm -r build                 # 首次或改了源码后；缺产物时运行器也会自动构建
pnpm e2e                      # 全量（约 35s），结束自动停 Hub、删容器与网络、保留数据目录

pnpm e2e -- --list            # 列出旅程与依赖
pnpm e2e -- --only J3,J7      # 只跑指定旅程（复用最近一次的数据目录；J1/J2 需要干净库，会自动新建）
pnpm e2e -- --only J3 --keep-containers   # 排障：跑完不删容器（记得自己清理）
```

结果：`e2e/.data/<run-id>/result.json`（每条断言、耗时、截图、失败产物、容器名单与清理结果），
Hub 日志在同目录 `hub.log`，失败现场在 `artifacts/<Jx>/`（页面 HTML、console、Hub 日志尾巴、截图）。
关键步骤截图写在 `e2e/.data/shots/`（1440 宽，不进仓库）。

## 隔离（CONTRIBUTING.md 的工程约定 §3）

| 项 | 值 |
| --- | --- |
| 端口 | 7790（明文，`HUB_TLS_PORT=0`；`E2E_HTTP_PORT` 可覆盖） |
| 数据目录 | `e2e/.data/<run-id>/`（.gitignore 的 `.data/` 规则内） |
| 容器网络 | `dshhub-test-e2e-net` / `10.219.19.0/24`（`E2E_USERS_NETWORK`/`E2E_USERS_SUBNET` 可覆盖） |
| 容器名/环境标签 | `dshhub-test-e2e-<slug>` + `dshhub.env=e2e`（`E2E_ENV_ID` 可覆盖） |
| 运行时镜像 | `dshhub/runtime:0.2.0-rc.2`（只读使用，不重建；用 `cli runtime:adopt` 登记为默认版本） |
| 浏览器 | `playwright-core` + `~/.local/bin/google-chrome`，headless，1440×900 |

清理判据：**只删挂在 `dshhub-test-e2e-net` 上且带 `dshhub.managed=1` 标签的容器**（逐个 inspect 复核），
再删该网络；禁止任何 `prune`。容器名带 `HUB_CONTAINER_PREFIX`（WP2 第二轮支持），
环境标签 `HUB_ENV_ID` 让对账/回收/stop-all 也只处理本环境。

## 目录

```
e2e/
├── src/harness.ts   起停 Hub、CLI、docker 清理、隔离环境变量
├── src/browser.ts   playwright-core 封装、console 收集、失败截图
├── src/context.ts   World（跨旅程会话/状态）与 JourneyContext（断言记录）
├── src/api.ts       带会话的 HTTP 客户端（浏览器上下文的 cookie）
├── src/ui.ts        界面操作片段（登录、注册、状态行等待、欢迎引导）
├── src/zip.ts       极简 ZIP 读取器（J6 解压校验，不引依赖）
├── src/run.ts       运行器（顺序执行、汇总 result.json、自动清理）
├── tools/           WP8b 的真实构建回归脚本（runtime-build-regression.mjs）
└── tests/J*.ts      每条旅程一个文件（J1–J10）
```

## 真实构建回归（WP8b）

```bash
pnpm -r build
node e2e/tools/runtime-build-regression.mjs      # 隔离环境经管理接口构建 0.2.1-alpha.2 → ready → 删除
```

它验证的是「全新安装第一次构建 DSH 版本」这条路：**不预先创建用户网络**、构建走 `runtime.build`
任务、冒烟 `dsh --version`、版本 ready、经接口删除后镜像被移除；结束清理自己的容器/网络/镜像，
不碰 `dshhub/runtime:0.2.0-rc.2`。版本用 `HUB_REGRESSION_VERSION` 覆盖，registry 用 `HUB_NPM_REGISTRY`。
