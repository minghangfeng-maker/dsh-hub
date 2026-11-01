# @local/dsh-claude-pilot —— DSH 里的「Claude Code」对话模式

> ⚠️ **安全默认值，先读这一段**：本插件默认 `permissionMode: bypassPermissions`，即 **Claude Code 完全权限**
> —— Claude 执行命令、改文件都不再询问。
> **为什么这样默认**：它是为**隔离容器里的一次性实例**设计的（云端 DSH 跑在容器里，越权由容器边界兜底）。
> **在本机 / 开发机 / 桌面端直接跑时这很危险**：Claude 可以不经确认执行任何命令、读写你能读写的任何文件。
> **怎么收窄**（改 `cordis.patch.yml` 里那一行的 `config`，然后重启 DSH）：
> `permissionMode: default`（每次动手前询问）或 `permissionMode: plan`（只规划不动手）；
> 只允许改文件不执行命令可用 `acceptEdits`。

> 📦 **依赖 Anthropic 专有 SDK**：本插件依赖 `@anthropic-ai/claude-agent-sdk`（npm 包，**不是开源许可** ——
> 其 `LICENSE.md` 只有 "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…"）。
> **本仓库不分发它的代码**（不含 `node_modules`、不 vendored），安装时由 npm 从公共 registry 拉取；
> 用户需自行安装并遵守 Anthropic 的条款；使用 Claude Code 还需要用户自己的 Anthropic 账号或 API Key。

新建对话时在预设选择器里选 **Claude Code**：主对话用 DSH 自己的界面，背后是本机 Claude Code
（Claude Agent SDK），Claude 还能派 DSH 子任务。

- **主对话**背后是 Claude Agent SDK 驱动的 Claude Code，支持逐字输出、思考块、原生工具卡、
  多轮续接（resume）、附件互通、文件交付卡和停止按钮。
- **派任务**：Claude 手里有 `mcp__dsh__task_*` 工具。它派出的每个任务都是这个对话下的真 DSH 子会话，
  由 DSH 当前默认模型执行，并**自动在右侧栏打开**、实时可见。任务结束时 DSH 的通知会叫醒 Claude
  去核对结果、向你汇报。
- **界面细节**：切到 Claude Code 预设时，模型芯片立即变成「跟随 Claude Code 默认」，切回其他预设时
  恢复成原来的默认模型。发过一次消息后就不能再切换预设（DSH 原生规则）。
- **登录 / 配置在 DSH 设置页**：打开「设置 → Claude Code」，分区打开时自动检测当前方式、可用性，
  以及这台机器上已有的 Claude Code 配置（`~/.claude` 的登录凭据、`settings.json` 的 `ANTHROPIC_*`、
  进程环境变量；只报有没有，不显示 key）。两种方式用页签切换：**账号登录**（自动跑
  `claude setup-token`，也能手动粘贴 token）、**第三方 API**（Base URL + API Key + x-api-key/Bearer，
  可接任意中转站），另有「测试连接」和「清除凭据」。
  由 Hub 下发凭据时多一个只读的「Hub 下发」页签（默认选中）；改选账号登录 / 第三方 API 并保存后即
  改用自己的配置，可随时「改回 Hub 下发」。
- **命令**：Claude Code 的斜杠命令（`/compact` `/context` `/usage` `/clear` `/effort` `/code-review`
  `/init`，以及本机的 skills）在这个模式的对话里直接可用，只对本模式生效。切换模型用输入框里的模型芯片
  （`/model` 和 DSH 自带的命令撞名，没有注册）。

## 安装

1. 打成一个 npm 包：

   ```bash
   npm pack . --pack-destination dist --ignore-scripts
   ```

2. 装进 DSH profile（三选一）：
   - **Hub 管理台**：插件库 → 添加插件 → 上传上一步的 `.tgz`，再下发给用户；
   - **命令行**：`dsh plugin --profile <profile> add ./dist/local-dsh-claude-pilot-0.6.0.tgz`；
   - **本地开发**：profile 的 `package.json` 里加
     `"@local/dsh-claude-pilot": "link:/path/to/dsh-claude-pilot"`，并把包名加进
     `dsh.profile.bundles`，然后重启 DSH。

3. 在 **设置 → Claude Code** 里配置登录方式（或由 Hub 下发凭据）。

> 包名保持 `@local/dsh-claude-pilot`：Hub 插件库与桌面随包清单按包名识别插件，改名会断升级路径。

运行环境：不用另装 Claude Code（Agent SDK 自带对应平台的程序），但运行 DSH 的用户要有
Claude 登录（`~/.claude`）或 `ANTHROPIC_API_KEY`。`claudePath: bundled` 可以强制使用 SDK 自带的程序。

## 配置项（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `claudePath` | 空 | Claude Code 程序。留空 = `$CLAUDE_CODE_BIN` → `~/.local/bin/claude` → PATH；写 `bundled` 强制用 SDK 自带的 |
| `fallbackCwd` | 空 | 会话没有工作目录时用哪个目录；留空 = 运行 DSH 的用户的 home |
| `permissionMode` | `bypassPermissions` | Claude Code 权限模式：`bypassPermissions`（完全权限）/ `acceptEdits` / `default`（逐次询问）/ `plan`（只规划） |
| `defaultModel` | 空 | 默认模型（UI 里选过就以 UI 为准）；留空 = Claude Code 默认 |
| `defaultEffort` | 空 | 默认思考档位 |
| `taskModel` | 空 | 派出的 DSH 任务用哪个模型；不写 = DSH 当前默认模型。DSH 默认模型是 `claude-code` 时必须写，例如 `{ provider: deepseek, model: deepseek-chat, reasoningEffort: high }` |
| `taskPreset` | `standard` | 派出的 DSH 任务用哪个预设（决定它有哪些工具） |
| `maxToolResultChars` | `30000` | 单个工具结果回传给 Claude 的字符上限 |
| `verbose` | `false` | 打印诊断日志 |

## 文件

| 文件 | 作用 |
|---|---|
| `releases/index.r1.js` | Host 薄壳：pre-step 接管、`/claude-pilot` 路由、热加载 runtime |
| `releases/commands.r1.js` | 挂在预设里的命令插件（只对 Claude Code 对话注册） |
| `runtime/bridge.js` | 每轮跑 Claude、模型芯片、默认模型保护、命令、诊断端点 |
| `runtime/translate.js` | SDK 消息 → DSH 会话事件 + 逐字直播帧 |
| `runtime/tasks.js` | 派 DSH 任务的 MCP 工具（task_start / wait / send / list / stop） |
| `runtime/setup.js` | 初始化：选哪份 claude 程序、注入哪种凭据、`claude auth status`、测试连接、订阅登录、Hub 凭据来源 |
| `runtime/files.js` | 附件落盘到 `.dsh-inbox/`，Write/Edit 过的文件 → 交付卡 |
| `runtime/platform.js` | 跨平台适配：Windows 的 PATH 大小写、PATHEXT 查找、`.cmd` 壳经 cmd.exe、Git Bash 探测、路径归一化、进程树终止 |
| `hub-agent-modes.d.ts` | 桌面端 `hubAgentModes` 服务的接口声明（给 hub-connector 实现用） |
| `client.js` | 浏览器端：派出任务时在右侧栏打开子会话 |
| `cordis.patch.yml` | 预设 + 插件配置（权限模式、任务模型等） |
| `tools/*.mjs` | 回归脚本（见下「测试」） |

只改 `runtime/*.js` 时存盘即生效；改 `releases/*`、`cordis.patch.yml` 或 `client.js` 后需要重启 DSH。

## 关键机制

- **接管一轮**：`agent/pre-step` 里把认领的消息写成 `user/message`，跑一轮 Claude，把事件写进同一个
  turn，然后返回 `{kind:'enter', messages:[]}`。loop 以 completed 收尾，DSH 自己的模型完全不会被调用。
- **派任务**：`ctx.subagents.startActivation({provider:'spawn', request:{parent, prompt, agentPreset, agentOptions}, delivery:'parent'})`。
  派任务工具在主对话里映射成原生 `subagent` 卡片。
- **任务通知**：子会话的 `send_message` 和结算通知会唤醒父会话；桥把它们包成「[DSH 任务通知]」交给 Claude。
- **逐字输出**：自己发 `agent/assistant-stream` 帧（start / chunk / end），帧编号按 agent 连续递增。
- **默认模型保护**：DSH 的 `sessionController.selectModel` 会把选择顺手存成全局默认；插件会立即把
  默认恢复成正常模型，避免普通对话被带偏。
- 装了 `@local/dsh-memory` 时，桥会额外把记忆工具与索引接进来，与 DSH/Codex 共用同一记忆库。

## Hub 下发（容器）与桌面端（服务）

容器里的 Hub 配置来自 `HUB_CLAUDE_*` 环境变量；桌面端没有这些变量，改由 hub-connector 注册的 Cordis
服务 `hubAgentModes` 提供（接口见 `hub-agent-modes.d.ts`）：

```js
ctx.inject(['hubAgentModes'], (hubCtx) => { … })   // 可选依赖：容器里没有这个服务就完全不执行
service.credentials('claude-code') → { auth, key, baseUrl, model?, label? } | null
service.available('claude-code')   → 布尔
service.onChange('claude-code', fn) → 取消订阅
```

服务存在 → 用它给的 baseUrl + 模式密钥；服务不存在 / 返回不合法凭据 / 抛异常 → 退回 `HUB_CLAUDE_*`
环境变量（容器行为不变）；配置变化时清缓存，下一轮按新配置走，不用重启。

## Windows

`runtime/platform.js` 负责 Windows 适配（POSIX 行为完全不变）：`Path` 大小写、按 `PATHEXT` 找
`claude.exe`/`claude.cmd`、`.cmd` 壳经 `cmd.exe`（引号按 `/s` 规则）、Git Bash 探测排除 WSL 的
`bash.exe`、`/c/…` `/mnt/c/…` `/cygdrive/c/…` 归一化、进程树终止。

Windows 上还没做的：`claude setup-token` 的自动登录要 ConPTY（目前提示手动粘贴）；凭据在 Windows
凭据管理器时「本机凭据文件」与「订阅额度」读不到；`lab-token` 的 `0o600` 在 Windows 上无效（靠目录 ACL）。
这些都不影响 Hub 模式与正常对话。

## 诊断

```bash
curl -s http://127.0.0.1:<port>/claude-pilot | jq .        # 状态、最近派出的任务、默认模型
T=$(cat ~/.dsh/claude-pilot/lab-token)                     # POST 必须带这个本地令牌（插件路由不经过 DSH 登录）
curl -s -X POST http://127.0.0.1:<port>/claude-pilot -H "x-pilot-token: $T" \
  -H 'content-type: application/json' -d '{"prompt":"…","cwd":"/tmp","waitTasks":true}' | jq '.tasks, .frames'
```

会话记录：`~/.dsh/claude-pilot/sessions.json`（DSH 会话 → Claude 会话 id 与用量）。

## 测试

```bash
node tools/test-platform.mjs      # 平台适配（PATHEXT、Path 大小写、.cmd 引号、Git Bash 排除、win32 路径、进程终止）
node tools/test-hub-provider.mjs  # hubAgentModes 优先 / env 回退 / 模型列表 / onChange 清缓存
npm test                          # 上面两个一起跑
```

两个脚本只用 Node 内置模块；`test-hub-provider` 会 import `runtime/setup.js`，所以要先
`npm install` 装好 `@anthropic-ai/claude-agent-sdk` 等依赖。

## 安全设计

- 设置接口挂在 **connection 的受保护路由** `/api/claude-pilot.setup` 上，浏览器必须先登录 DSH，
  否则返回 401。插件自己的 `/claude-pilot` 路由不经过 DSH 登录，所以只返回布尔值 `setupReady`，
  绝不在那里收发密钥。
- 密钥存在 DSH 凭据库（`CLAUDE_PILOT_API_KEY`、`CLAUDE_PILOT_OAUTH_TOKEN`）。接口从不返回明文，
  只用 `describe` 报告是否已设置。Base URL 和当前方式存在 `$DSH_HOME/claude-pilot/auth.json`。
- 每轮跑 Claude 时按所选方式注入 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` /
  `CLAUDE_CODE_OAUTH_TOKEN`，其余同类变量会被清掉，避免互相抢。
- 订阅登录依赖 util-linux 的 `script` 提供伪终端（setup-token 是 TUI）。没有 `script` 时界面会改为
  提示手动运行 `claude setup-token` 再粘贴 token。

## 边界

- 权限默认最大（见顶部安全说明）：DSH 侧还没有审批卡。改成更保守的模式后，需要审批的操作按
  Claude Code 自己的交互走（没有终端时会拒绝）。
- `/model`、`/login`、`/config` 这类需要全屏交互的命令不可用。
- 每轮起一个 Claude 进程，用 resume 续接，没有常驻进程。

## 前端注意

- 前端插件激活时只要抛错，DSH **整个网页都起不来**。所以 `client.js` 的每块功能都用 `guarded()` 包住，
  服务一律用 `ctx.inject([...])` 动态注入，不要直接读 `ctx.xxx`。
- 运行状态的改写只改 React 文本节点的 `nodeValue` 和 `data-shimmer-text` 属性，不替换节点。

## 许可

本插件代码 Apache-2.0。**依赖**：`@anthropic-ai/claude-agent-sdk`（Anthropic 专有许可，本仓库不分发）、
`@anthropic-ai/sdk`（MIT）、`@modelcontextprotocol/sdk`（MIT）、`zod`（MIT）。
