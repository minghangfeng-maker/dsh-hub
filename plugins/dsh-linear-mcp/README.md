# @local/dsh-linear-mcp —— Linear 官方 MCP 接入

在 DSH 的「设置」里加一页 **Linear**：填一个 Linear API key。配好之后，本插件用这份凭据把随
DSH 安装的 `@deepseek-ai/dsh-mcp-client` 挂起来，于是模型直接拿到 `mcp__linear__*` 工具，
可以查/建/改 issue、project、comment。

官方端点：`https://mcp.linear.app/mcp`（只读：`https://mcp.linear.app/mcp/readonly`），
Streamable HTTP；Linear 文档明确支持 `Authorization: Bearer <API key>`。

## 安装

1. 打成一个 npm 包：

   ```bash
   npm pack . --pack-destination dist --ignore-scripts
   ```

2. 装进 DSH profile（三选一）：
   - **Hub 管理台**：插件库 → 添加插件 → 上传上一步的 `.tgz`，再下发给用户；
   - **命令行**：`dsh plugin --profile <profile> add ./dist/local-dsh-linear-mcp-1.0.0.tgz`；
   - **本地开发**：profile 的 `package.json` 里加
     `"@local/dsh-linear-mcp": "link:/path/to/dsh-linear-mcp"`，并把包名加进
     `dsh.profile.bundles`，然后重启 DSH。

3. 打开 **设置 → Linear**，粘贴 API key → 保存，状态应变成「已连接 · N 个工具」。

> 包名保持 `@local/dsh-linear-mcp`：Hub 插件库与桌面随包清单按包名识别插件，改名会断升级路径。

## 配置

config 在 `cordis.patch.yml` 里（用户补丁层同 id 的行会整块替换）：

```yaml
- id: linear-mcp
  config:
    serverName: linear       # 工具名 mcp__linear__*
    endpoint: https://mcp.linear.app/mcp
    readonly: false          # true → 用 /mcp/readonly（只有读工具）
    credentialRef: LINEAR_API_KEY   # API key 的凭据引用名（同名环境变量亦可）
    toolCallTimeoutMs: 60000
    requestTimeoutMs: 20000
```

## 凭据

设置页写入 `ctx.credentials.set(credentialRef, key)`（`credentialRef` 默认 `LINEAR_API_KEY`）。
每次操作都会重新 `resolve`，所以**保存后立刻生效，不需要重启**。同名环境变量会被优先解析，
此时凭据库里的写入会被拒绝（只读来源遮蔽），设置页会如实报错。清除按钮走 `unset`。

key 在 Linear 里打开 **Settings → Security & access → Personal API keys** 创建
（[linear.app/settings/account/security](https://linear.app/settings/account/security)；
只读用途只勾 Read，或者把插件 config 的 `readonly` 打开走 `/mcp/readonly`）。

设置页还有：连接状态（凭据来源 / 已挂上的工具数）、工具列表、「测试连接」（直接对 MCP 端点做
initialize + tools/list，能区分「凭据被拒」与「网络不通」）、「重新连接」。

## 安全边界

- 设置页的所有写操作（保存/清除 key、测试、重连）都是**用户动作**，只暴露给设置页，
  不注册成 Agent 工具 —— 模型不该能自己给自己发凭据。模型侧的入口就是挂上来的
  `mcp__linear__*` 工具本身。
- `/_dsh/linear-mcp/state` 与 `/_dsh/linear-mcp/action` 过 `ctx.connection.requestRejection`
  （Host/Origin 栅栏 + 浏览器会话 Cookie）。
- 凭据只经 `ctx.credentials`（引用空间），不写进 `cordis.patch.yml`，也不落任何插件自建文件。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Loader 行指向的**稳定装载壳**：每次挂载都重新 `import('./impl.js?v=…')`，改完实现不用发新版本 |
| `impl.js` | Host 半：凭据解析（API key）、挂载 MCP client、`/_dsh/linear-mcp/*` 路由 |
| `client.js` | Client 半：`settings.section` 里的 Linear 设置页（同源 fetch，样式只用主题 token） |
| `cordis.patch.yml` | 插入 `linear-mcp` 这一行（config 默认值见文件内注释） |
| `locale/{zh,en}.json` | 插件卡片文案 |
| `icon.svg` | 插件卡片图标 |

## 开发

改完 `impl.js` 后让这一行重新挂载即可（壳子会把新实现 import 进来）：

```sh
curl -sS -X POST http://127.0.0.1:<port>/_dsh/linear-mcp/dev-reload -H 'content-type: application/json' -d '{}'
```

注意两点：这条路只重跑 `apply`，**不会**重新读 `index.js` 的 `inject` / 导出（那要行被重建：
在「设置 → 插件」里把本 bundle 关掉再打开，或者重启 DSH）；`client.js` 改完刷新页面即可。

排查用：`curl -sS http://127.0.0.1:<port>/_dsh/linear-mcp/state`（需要浏览器会话 Cookie，
浏览器里打开同一地址即可）。

## 自检

```sh
node --test test/impl.test.mjs        # 纯函数：配置归一化、只读端点、回环 Host 判定、路由前缀
node test/mock-mcp-server.mjs 4610    # 离线假 MCP server（echo / whoami 两个工具）
```

用离线 mock 做端到端验收：

1. 起 mock：`node test/mock-mcp-server.mjs 4610`；
2. 在 profile 补丁层临时把本行 `endpoint` 指到 `http://127.0.0.1:4610/mcp`；
3. 设置页保存任意 key → 状态应变成「已连接 · 2 个工具」，工具名 `mcp__linear__echo` /
   `mcp__linear__whoami`；
4. 让模型调用 `mcp__linear__whoami`，返回里能看到你填的 `Authorization` 头；
5. 删掉临时补丁块、清掉 key。

## 已知边界

- 只有一个凭据位（`credentialRef`）：要同时接多个 Linear workspace 得再加一行 mcp-client
  配置（不同 `serverName` 与 `credentialRef`）。
- API key 以 `Authorization: Bearer` 发出，权限完全由 key 本身决定（含只读 key）。
- 没有做 OAuth 账号登录：Linear 的注册端点只接受 https 或回环地址作回调，DSH 通常挂在反向代理
  后面的明文 http 上，走不通；用 API key 是最稳的方式。

## 许可

Apache-2.0。
