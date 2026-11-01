# 云端 DSH 插件（plugins-staging）

这里的每个目录是一个可以直接装进 DSH profile 的**bundle 插件**（`package.json` +
`cordis.patch.yml` + 可选的 Client 半边）。合并进公开单仓后它们位于 `plugins/`。

- 全部为 **Apache-2.0**（`package.json` 的 `license` 字段），版权人 **`DSH Hub contributors`**；
  每个插件目录自带一份 `LICENSE`（Apache-2.0 全文，副本见单仓根 `LICENSE`），打包时随整包发出。
- **包名保持 `@local/...` 原样**：Hub 插件库、桌面随包清单（`apps/desktop/hub/bundled-plugins.json`）
  和接口契约（`packages/shared` 里的 agent-modes 等）都按包名识别插件，**改名会断升级路径**。
- 插件里**不含任何凭据**：需要密钥的插件一律留空 `apiKey`/`apiKeyEnv`，用环境变量或 Hub 的插件配置注入。

## 一、插件索引

| 目录 / 包名 | 用途（一句话） | 版本 | 云端（Hub 插件库） | 桌面（随包清单） |
|---|---|---|---|---|
| `dsh-claude-pilot`<br>`@local/dsh-claude-pilot` | 「Claude Code」对话模式：主对话由本机 Claude Code（Agent SDK）驱动，Claude 可派 DSH 子任务 | **0.6.0** | 可下发（按「可选」策略上架过） | 随包，`default` |
| `dsh-codex-pilot`<br>`@local/dsh-codex-pilot` | 「Codex」对话模式：主对话由本机 Codex（`codex app-server`）驱动，可派 DSH 子任务 | **0.4.1** | 可下发（按「可选」策略上架过） | 随包，`default` |
| `dsh-memory`<br>`@local/dsh-memory` | 记忆插件：全局/工作区记忆条目、标签索引、冷热分层、定时整理、设置页与记忆图谱 | 0.1.3 | 可下发（座舱/运维也用它记经验） | 随包，`default` |
| `dsh-file-download`<br>`@local/dsh-file-download` | 预览中的工作区文件「下载到本地」：Host 流式路由 + 浏览器原生下载（进度、断点续传） | 1.2.0 | 可下发 | 不随包 |
| `dsh-linear-mcp`<br>`@local/dsh-linear-mcp` | Linear 官方 MCP 接入：设置页填 API key，模型拿到 `mcp__linear__*` 工具 | 1.0.0 | 可下发 | 不随包 |
| `dsh-session-id`<br>`@xdedmi/dsh-session-id` | 给每个会话一个稳定 ID，并作为请求头注入每一次模型请求（上游会话亲和；零依赖、不访问外部服务） | 1.0.0 | 可下发 | 随包，`default` |

> 桌面「随包」指整包会进桌面安装包的 `resources/hub-plugins/`，首次启动即装（不需要登录）。
> 云端「可下发」指管理员把 `.tgz` 上传到 Hub 插件库后，可以按策略（必装 / 默认 / 可选）下发。

**版本来源**：`dsh-claude-pilot` 0.6.0 与 `dsh-codex-pilot` 0.4.1 以桌面随包清单（`bundled-plugins.json`）
的整包为准重建（旧源目录停在 0.5.2 / 0.3.1）；`dsh-memory` 0.1.3 的目录内容与随包整包逐文件一致。
每个插件目录都自带 `LICENSE`（Apache-2.0，版权人 `DSH Hub contributors`），`dsh-codex-pilot` 另有
`NOTICE`（开头是它自己的版权行，下面保留 OpenAI Codex 的 NOTICE 作为第三方归属声明）。
`dsh-session-id` 的随包整包与 `wp30/dsh-session-id` 源码逐字节一致（补回了整包不带的 `test/`）。

> `dsh-file-download` 用的是**源目录的 1.2.0 流式版**（Host 路由 `/api/workspace.download` + `Range` 断点续传）。
> 另有一份 `1.3.0` 整包是**桌面补丁包**：`index.js` 是空壳、客户端走 `workspaceFiles.readBytes` 整份读回，
> 靠把 `maxFileBytes` 提到 1 GB 兜大文件（桌面没有 `/api` 传输时才有意义）。开源版与云端**不采用** 1.3.0。

### 两个插件的安全默认值

`dsh-claude-pilot` 默认 `permissionMode: bypassPermissions`，`dsh-codex-pilot` 默认
`sandbox: danger-full-access` + `approvalPolicy: never`：这是为**隔离容器里的一次性实例**设计的。
在**本机 / 桌面端**直接跑时，Claude / Codex 可以不确认就执行任意命令（详见各插件 README 顶部的安全说明，
那里也写了改成保守模式的配置）。

### 专有依赖声明

`dsh-claude-pilot` 依赖 **`@anthropic-ai/claude-agent-sdk`（Anthropic 专有许可，不是开源）**：
本仓库**不分发**它的代码（不含 `node_modules`、不 vendored），安装时由 npm 从公共 registry 拉取，
用户需自行安装并遵守 Anthropic 的条款；使用 Claude Code 还需要用户自己的账号或 API Key。
其余插件的依赖都是开源许可（`@openai/codex` Apache-2.0、`@anthropic-ai/sdk` / `@modelcontextprotocol/sdk` MIT、
`zod` MIT、ssh-hosts 运行时零依赖）。

## 二、怎么通过 Hub 管理台上传与下发

### 1. 打包

```bash
cd plugins/<插件目录>
npm pack . --pack-destination dist --ignore-scripts
# → dist/local-<包名去 scope>-<版本>.tgz
sha256sum dist/*.tgz
```

`package.json` 的 `files` 已经只列运行时文件，测试与文档不会进包。

### 2. 上传到插件库

管理台 → **插件库** → 添加插件：

| 方式 | 填什么 |
|---|---|
| `upload` | 直接传上一步的 `.tgz`（Hub 会校验是合法 npm 包、`name` 与插件一致，并扫疑似密钥） |
| `local` | 填 Host 上的插件目录（Hub 在临时目录里 `pnpm pack`，不改原目录） |
| `npm` / `tarball` | 已经发到 npm 或有一个 tar.gz URL 时用 |

同一步里设置：显示名、描述、图标、**策略**（`required` 必装 / `default` 默认装 / `optional` 可选 /
`hidden` 下线）、`configYaml`（插件配置，**密钥放这里时用环境变量引用**）、是否需要重启。
云端与桌面是**两套独立的插件库/版本**：桌面侧要另外上传整包并选目标。

### 3. 下发给用户

管理台 → **下发向导**：

1. 第 1 步：平台选**实例**（云端容器）或**桌面端**（或两者），内容选插件（可多选）、模型/API 配置；
2. 第 2 步：动作（安装 / 升级 / 卸载）与目标（全部 / 指定用户 / 角色 / **已安装用户**，可勾「只选版本较旧的」）；
3. 第 3 步：策略（仅实例侧）；
4. 第 4 步：预览 + 二次密码确认，然后执行。

实例侧会按「期望状态 → 对账」逐个用户执行（`dsh plugin add` → 必要时重启 DSH → 健康检查 → 失败回滚）；
桌面侧只写期望的清单版本，设备下次心跳时拉取。插件库页也支持勾选多个插件批量下发。

### 4. 桌面随包（可选）

要让插件跟着桌面安装包一起发：把整包放进桌面仓库的 hub 插件目录，写进
`apps/desktop/hub/bundled-plugins.json`（`package` / `version` / `file` / `sha256` / `level`），
构建时校验 sha256，不符即构建失败。整包自带 `LICENSE`（npm 打包时总会带上同目录的 `LICENSE`）；
`dsh-codex-pilot` 另带 `NOTICE`。

## 三、不用 Hub 时怎么装

```bash
# 命令行（装进某个 profile）
dsh plugin --profile <profile> add ./dist/local-dsh-xxx-<版本>.tgz

# 本地开发（软链，改代码即时生效；改 cordis.patch.yml / client.js 后要重启）
# 在 profile 的 package.json 里：
#   "dependencies": { "@local/dsh-xxx": "link:/path/to/dsh-xxx" }
# 并把包名加进 dsh.profile.bundles
```

每个插件目录里的 `README.md` 写了它的配置项、权限与安全说明、测试怎么跑。

## 四、测试

```bash
export NODE_ENV=development
cd dsh-memory        && node --test                       # 103 项
cd dsh-file-download && node test/route.test.mjs          # 47 项
cd dsh-linear-mcp    && node --test test/impl.test.mjs    # 5 项
cd dsh-session-id    && node test/session-id.test.mjs && node test/e2e-apply.test.mjs   # 12 项 + e2e
cd dsh-claude-pilot  && npm install && node tools/test-platform.mjs && node tools/test-hub-provider.mjs
cd dsh-codex-pilot   && npm install && npm test
```

`dsh-claude-pilot` / `dsh-codex-pilot` 的 `tools/*.mjs` 是回归脚本：平台适配（Windows 的 PATH/PATHEXT/进程树）、
Hub 凭据来源、app-server 通知翻译。`dsh-codex-pilot/tools/test-models.mjs` 是**可选脚本**（不在 `npm test` 里）：
它需要**已登录的 codex**，没有登录时会有 2 项失败（只拿到 `cli-default`），属环境缺失而非代码回归。

## 五、没有纳入的插件

| 插件 | 为什么不纳入 |
|---|---|
| `dsh-image-gen` | **用户决定不开源** |
| `dsh-ssh-hosts` | **用户决定不开源** |
| `dsh-effort-router` | 分档调度依赖某个非官方模型池渠道的档位映射，且它复制的是一份内置预设的快照，公开后会随 DSH 版本漂移 |
| `dsh-wsl-terminal` | WSL 专用（Windows 桌面），云端容器里没有意义；且宿主入口写死绝对路径 |
| `dsh-mobile` | 手机布局 + PWA 已被 Hub 内置的手机通道（`packages/dsh-node-remote` + 手机网页版 `/m/`）取代；其图标资源取自上游 logo |

详见 `reports/T3-plugins.md`。
