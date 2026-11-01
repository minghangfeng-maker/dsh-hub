# @local/dsh-codex-pilot —— DSH 里的「Codex」对话模式

> ⚠️ **安全默认值，先读这一段**：本插件默认 `sandbox: danger-full-access` + `approvalPolicy: never`，
> 即 **Codex 完全权限、不向你确认**。
> **为什么这样默认**：它是为**隔离容器里的一次性实例**设计的（云端 DSH 跑在容器里，越权由容器边界兜底）。
> **在本机 / 开发机 / 桌面端直接跑时这很危险**：Codex 可以不经确认执行任何命令、读写你能读写的任何文件。
> **怎么收窄**（改 `cordis.patch.yml` 里那一行的 `config`，然后重启 DSH）：
> `sandbox: workspace-write`（只能写工作区）或 `read-only`（只读）；
> 审批策略改成 `on-request` 或 `untrusted` —— 但 DSH 侧还没接审批卡，需要审批的操作会被直接拒绝，
> 所以更稳的组合是「`workspace-write` + `never`」。

`dsh-claude-pilot` 的 Codex 版。新建对话时在预设选择器里选 **Codex**：主对话用 DSH 自己的界面，
背后是本机 Codex（`codex app-server`），Codex 还能派 DSH 子任务。

- **主对话**背后是本机 Codex（`codex app-server`，整个 DSH 进程常驻一个，所有 Codex 对话复用），
  支持逐字输出、思考摘要、原生工具卡（命令 → bash 卡，改文件 → write/edit 卡，计划 → todo 卡）、
  多轮续接、附件互通（图片同时作为 localImage 交给 Codex）、文件交付卡和停止按钮。
- **派任务**：Codex 手里有 `task_start / task_wait / task_send / task_list / task_stop` 五个动态工具
  （app-server 的 dynamicTools，thread 续接后仍在）。派出的每个任务都是这个对话下的真 DSH 子会话，
  由 DSH 自己的模型执行，**自动在右侧栏打开**；任务结束时 DSH 的通知会叫醒 Codex 核对结果。
- **界面细节**：切到 Codex 预设时模型芯片变成「跟随 Codex 默认」（模型目录来自 app-server 的
  `model/list`），切回其他预设时恢复成原来的默认模型。适配器的 `listModels` 会自己把 `model/list`
  拉一次并广播 `llm/adapters-updated`，所以芯片里能直接选具体模型与思考档位。
  发过消息后不能再换预设（DSH 原生规则）。
- **登录与配置**：都在 **设置 → Codex** 分区，对话里不做登录。分区打开时自动检测当前状态，
  并列出本机已有配置（`~/.codex/auth.json` 的登录类型、`config.toml` 的 provider / base_url、
  `OPENAI_API_KEY`），只显示路径和名字，不显示任何密钥。配置方式用分段切换：
  - **本机 Codex**：用 `~/.codex` 的登录与 `config.toml`（默认）。
  - **ChatGPT 账号**：设备码登录（给出链接和一次性代码，在任意浏览器完成，适合远程访问 DSH）。
    登录保存在插件自己的 `CODEX_HOME`，不动 `~/.codex`。
  - **第三方 API**：可填 Base URL、API Key、默认模型、Responses / Chat Completions 接口；
    API Key 留空表示只改 URL 不换 key。
  - **Hub 下发**：容器里有 `HUB_CODEX_*`（或桌面端有 `hubAgentModes` 服务）时用这一项，用户也可以切到
    自己的配置，随时「改回 Hub 下发」。
  另有「测试连接」（临时 thread 跑一个极小回合）和「清除插件保存的凭据」。
- **命令**（只对本模式生效）：`/compact`、`/review [要求]`、`/status`、`/clear`、`/effort`、
  `/init`（生成 AGENTS.md）、`/mcp`。

## 安装

1. 打成一个 npm 包：

   ```bash
   npm pack . --pack-destination dist --ignore-scripts
   ```

2. 装进 DSH profile（三选一）：
   - **Hub 管理台**：插件库 → 添加插件 → 上传上一步的 `.tgz`，再下发给用户；
   - **命令行**：`dsh plugin --profile <profile> add ./dist/local-dsh-codex-pilot-0.4.1.tgz`；
   - **本地开发**：profile 的 `package.json` 里加
     `"@local/dsh-codex-pilot": "link:/path/to/dsh-codex-pilot"`，并把包名加进
     `dsh.profile.bundles`，然后重启 DSH。

3. 在 **设置 → Codex** 里配置登录方式（或由 Hub 下发凭据）。

> 包名保持 `@local/dsh-codex-pilot`：Hub 插件库与桌面随包清单按包名识别插件，改名会断升级路径。

运行环境：依赖 `@openai/codex`（Apache-2.0，按平台拉原生程序），目标机器不用另装 Codex；PATH 里有
`codex` 时优先用它，`codexPath: bundled` 强制用自带的。目标机器的用户需要自己的 ChatGPT 账号或 API Key。

## 配置项（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `codexPath` | 空 | Codex 程序。留空 = `$CODEX_BIN` → PATH 里的 `codex` → 插件自带的 `@openai/codex`；写 `bundled` 强制用自带的 |
| `fallbackCwd` | 空 | 会话没有工作目录时用哪个目录；留空 = 运行 DSH 的用户的 home |
| `sandbox` | `danger-full-access` | Codex 沙箱：`danger-full-access`（完全权限）/ `workspace-write` / `read-only` |
| `approvalPolicy` | `never` | `never` / `on-request` / `untrusted`。DSH 还没接审批卡：需要审批时完全权限下自动同意，否则拒绝 |
| `defaultModel` | 空 | 默认模型（UI 里选过就以 UI 为准） |
| `defaultEffort` | 空 | 默认思考档位 |
| `taskModel` | 空 | 派出的 DSH 任务用哪个模型；不写 = DSH 当前默认模型 |
| `taskPreset` | `standard` | 派出的 DSH 任务用哪个预设 |
| `maxToolResultChars` | `30000` | 单个工具结果回传给 Codex 的字符上限 |
| `verbose` | `false` | 打印诊断日志 |

## 文件

| 文件 | 作用 |
|---|---|
| `releases/index.r1.js` | Host 薄壳：pre-step 接管、`/codex-pilot` 路由、受保护的设置路由、热加载 runtime、关闭时停 app-server |
| `releases/commands.r1.js` | 挂在预设里的命令插件 |
| `runtime/appserver.js` | `codex app-server` 的 JSON-RPC 客户端：常驻进程、按 threadId 分发通知与服务端请求、退出后自动重启 |
| `runtime/bridge.js` | 每轮跑 Codex、模型芯片、默认模型保护、命令、诊断端点 |
| `runtime/translate.js` | app-server 通知 → DSH 会话事件 + 逐字直播帧 |
| `runtime/tasks.js` | 派 DSH 任务的动态工具 |
| `runtime/setup.js` | 选哪份 codex、三种凭据方式、设备码登录、测试连接、本机配置检测、Hub 凭据来源 |
| `runtime/files.js` | 附件落盘到 `.dsh-inbox/`，改过的文件 → 交付卡 |
| `runtime/platform.js` | 跨平台适配：PATH 大小写、PATHEXT 查找、`.cmd` 壳经 cmd.exe、`taskkill /T` 杀进程树、路径归一化 |
| `hub-agent-modes.d.ts` | 桌面端 `hubAgentModes` 服务的接口声明（给 hub-connector 实现用，与 dsh-claude-pilot 里那份一致） |
| `client.js` | 浏览器端：右侧栏、侧栏图标、状态行、设置 → Codex 分区、用量条 |
| `cordis.patch.yml` | 预设 + 插件配置（沙箱、审批策略、任务模型等） |
| `tools/*.mjs` | 回归脚本（见下「测试」） |
| `LICENSE` / `NOTICE` | Apache-2.0 全文与第三方声明（含 OpenAI Codex 的 NOTICE） |

只改 `runtime/*.js` 时存盘即生效（app-server 进程不重启）；改 `releases/*`、`cordis.patch.yml`
或 `client.js` 后要重启 DSH。

## 关键机制

- **接管一轮**：同 Claude Code 模式 —— `agent/pre-step` 里写 `user/message`，跑一轮 Codex，
  返回 `{kind:'enter', messages:[]}`。
- **thread 续接**：`sessions.json` 记 DSH 会话 → Codex threadId。本进程已加载的直接用；否则
  `thread/resume`；续接失败（换了凭据方式 / 历史被删）就开新的。
- **停止**：`turn/interrupt` 之后，Codex 会把正在跑的命令留成后台终端；桥会用
  `thread/backgroundTerminals/list + terminate` 结束这一轮还没跑完的命令。
- **权限**：默认最大（见顶部安全说明）。DSH 还没接审批卡，需要审批时一律拒绝。
- **和 Claude Code 模式并存**：两个插件互不认对方的会话；`codex` 和 `claude-code` 都被当作
  占位提供者，默认模型被带成任何一个都会被对应的插件恢复。
- 装了 `@local/dsh-memory` 时，新建 Codex 对话会自动注册记忆工具并接收记忆索引。

## Hub 下发（容器）与桌面端（服务）

容器里的 Hub 配置来自 `HUB_CODEX_*` 环境变量；桌面端没有这些变量，改由 hub-connector 注册的 Cordis
服务 `hubAgentModes` 提供（接口见 `hub-agent-modes.d.ts`）：

```js
ctx.inject(['hubAgentModes'], (hubCtx) => { … })   // 可选依赖：容器里没有这个服务就完全不执行
service.credentials('codex') → { key, baseUrl, wireApi?, model?, label? } | null
service.available('codex')   → 布尔
service.onChange('codex', fn) → 取消订阅
```

服务存在 → 用它给的 baseUrl + 模式密钥；服务不存在 / 返回不合法凭据 / 抛异常 → 退回 `HUB_CODEX_*`
环境变量（容器行为不变）；配置变化时清缓存（`secretDigest` 变了 app-server 下一轮自行重启）。

## Windows

`runtime/platform.js` 负责 Windows 适配（POSIX 行为完全不变）：

| 问题（Windows 上会坏） | 处理 |
|---|---|
| `env.PATH = …` 顶掉真正的 `Path`（Node 只传字典序第一个大小写匹配的键） | `envGet/envSet/envDelete/addToPath` 大小写不敏感，`baseChildEnv()` 沿用原键名 |
| `codex` 在 Windows 上是 `codex.exe` / `codex.cmd` | 按 `PATHEXT` 查找，`.cmd` 壳经 `cmd.exe`（引号按 `/s` 规则） |
| 常驻 app-server 会带出一个黑窗口 | `spawn`/`spawnSync` 全部 `windowsHide` |
| 停止 app-server 用 `SIGTERM → SIGKILL`（Windows 上都是 TerminateProcess，且不处理 `.cmd` 壳） | `terminateTree()`：先关 stdin，3 秒没走就 `taskkill /pid <pid> /t /f`；POSIX 仍是 SIGTERM → 3s → SIGKILL |
| 交付物用 `/` 判相对路径、`/c/Users/...` 这类 Git Bash 路径 | 正则两套分隔符；`relativeInside()` 用 win32 语义；`/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 归一化 |
| 工具卡里显示整条 `cmd.exe /d /s /c "…"` 命令行 | `translate.js` 的 `unwrapShell()` 增加 cmd / PowerShell 的 unwrap |

`tools/install.sh` 是 bash + `python3` + `ln -s`，**Windows 上别照着跑**：那边用插件管理器装 tgz，
或 `dsh plugin add <tgz>`。

## 测试

```bash
node tools/test-platform.mjs      # Windows 适配的判断（PATHEXT、Path 大小写、.cmd 引号、win32 路径、进程终止）
node tools/test-translate.mjs     # app-server 通知 → 会话事件的不变式（含 200 轮 fuzz）
node tools/test-hub-provider.mjs  # hubAgentModes 优先 / env 回退 / 模型列表 / onChange 清缓存
node tools/test-models.mjs        # ⚠️ 可选：模型芯片回归，需要**已登录的 codex**（无登录时会有 2 项失败），不在 npm test 里
npm test                          # 前三个（不需要网络与登录）
```

## 诊断

```bash
curl -s http://127.0.0.1:<port>/codex-pilot | jq .           # 状态、app-server 进程、最近派出的任务、模型目录
T=$(cat ~/.dsh/codex-pilot/lab-token)                        # POST 必须带这个本地令牌
curl -s -X POST http://127.0.0.1:<port>/codex-pilot -H "x-pilot-token: $T" \
  -H 'content-type: application/json' -d '{"prompt":"…","cwd":"/tmp","waitTasks":true}' | jq '.tasks, .frames'
```

## 边界

- 权限默认最大（见顶部安全说明）；改成更小的沙箱后，Codex 发来的审批请求一律被拒绝。
- 模型目录依赖 app-server 的 `model/list`：没登录或 app-server 起不来时，芯片里只有「跟随 Codex 默认」。
- 附件里的大图会同时作为 localImage 交给 Codex，注意上下文占用。

## 许可

本插件代码 Apache-2.0（见 `LICENSE` / `NOTICE`）。依赖 `@openai/codex`（Apache-2.0，运行时按平台安装）；
使用 Codex 需要用户自己的 ChatGPT 账号或 API Key。
