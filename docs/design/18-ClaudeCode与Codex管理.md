# 18 Claude Code 与 Codex 管理（管理台下发 + 计费）

> 2026-10-20 用户需求：「给 DSH HUB 管理台页面增加 ClaudeCode 和 Codex 管理，管理员可以直接下发配置，并且模型计费上也要能体现出来，
> 管理员可以在这两个界面去配置他们模型的价格以及整体的比例。」（同日上午原话：「相当于我可以在控制台配置账号或者配置 url 和 key，然后可以下发给指定的用户」）
> 任务包 WP23a（后端）/ WP23b（前端），契约 `packages/shared/src/api/agent-modes.ts` + `relay.ts` 的加法字段 + `contract-map.ts`「18」段。

## 0. 背景与决策

用户 DSH 里装的两个插件 `@local/dsh-claude-pilot`（「Claude Code」对话模式）和 `@local/dsh-codex-pilot`（「Codex」对话模式）
已经在生产 Hub 的插件库里（策略「可选」，用户 1、2、4 已装）。它们驱动容器里的 Claude Code / Codex 程序，现在只能用用户自己的账号或 API Key，
Hub 既管不了账号，也计不了费。

| # | 决策 |
| --- | --- |
| D1 | **账号统一走 Hub 中转站**：管理员在「Claude Code」「Codex」两页里配置上游（地址 + 密钥，就是中转站的渠道），用户容器里的 Claude Code / Codex 都指向 Hub 中转站的内部监听器，用 Hub 发的密钥。这样计费、余额、上限、失败切换、用量记录全部复用中转站（12） |
| D2 | **不做订阅账号（Claude Pro/Max 的 OAuth/setup-token、ChatGPT 登录）下发**：中转站计不了订阅账号的费；多人共用个人订阅违反 Anthropic / OpenAI 条款、容易封号（12 §0 同一口径）。上游只接 API Key 类：Anthropic 官方 API、OpenAI 官方 API，以及兼容这两种协议的第三方中转（含 DeepSeek / GLM / Kimi 的 Anthropic 兼容端点） |
| D3 | **三个「作用域」互相隔离**：`dsh`（现有的中转站，DSH 自己的模型）、`claude-code`、`codex`。渠道和对外模型各属一个作用域；「模型」页只管 `dsh`，两个新页面各管自己的。价格在各自页面里定 |
| D4 | **整体倍率**：每个模式一个倍率（千分比，默认 1000 = ×1.0）。费用 = 模型价格 × 渠道倍率 × **模式倍率** × 钱包倍率（12 §6.2 多乘一项）。改倍率即时生效，不用下发 |
| D5 | **每个用户每个模式一把独立的 system 密钥**（作用域 = 模式）。密钥的作用域决定它能调哪些模型、按哪个倍率算、用量记到哪个来源。DSH 内置密钥调不了 Claude Code 模型，反之亦然 |
| D6 | **只有「开通」和「开放给谁」需要下发**（改容器 env）；模型、价格、倍率、默认模型、显示名都由插件运行时向 Hub 拉取（§5），改了下一轮对话就生效 |
| D7 | **计费体现**：用量记录多一个「来源」（DSH / Claude Code / Codex），用户端和管理端都能按来源看花费；用户端「积分与用量」列出自己能用的 Claude Code / Codex 模型和确切价格 |
| D8 | 协议固定：Claude Code 只用 `anthropic-messages`（`/v1/messages`、`/v1/messages/count_tokens`）；Codex 只用 `openai-responses`（`/v1/responses`）。不做协议互转 |

## 1. 事实与约束（编排者已确认）

| # | 事实 | 影响 |
| --- | --- | --- |
| F1 | 两个插件已有「Hub 管理模式」：DSH 进程环境里有 `HUB_CLAUDE_AUTH`+`HUB_CLAUDE_KEY`（Codex：`HUB_CODEX_KEY`）就进入该模式，设置对话框只显示「由 DSH Hub 管理」、用户改不了；插件起子进程时会把 `HUB_*_KEY` 从 DSH 任务的环境里删掉 | Hub 只要往容器 env 注入这几个变量（§4） |
| F2 | Claude Code 用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`（发 `x-api-key`）。它请求 `POST {base}/v1/messages?beta=true` 和 `POST {base}/v1/messages/count_tokens?beta=true`，**带查询串**；后台小任务（标题、摘要）默认用 haiku 系列模型名，插件会用 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 改成 Hub 指定的小模型 | 中转站按路径分类时必须先去掉查询串（现在 `proxy.ts` 用 `path.endsWith('/count_tokens')` 判断，带 `?beta=true` 会把 count_tokens 当成 `/messages` 计费请求，**必须修**）；没设小模型时用默认模型 |
| F3 | Codex 用自定义 provider：`base_url = {base}/v1`、`wire_api = "responses"`、`env_key`，请求 `POST {base}/v1/responses`（流式），可能还会 `GET /v1/models` | 中转站已有这两个接口；真程序实测要记下它实际请求的全部路径（WP23a 真链路验证） |
| F4 | 中转站对外模型名 `relay_models.name` 是**全局唯一**（建表时的列约束，改要重建表，不做） | 三个作用域共用一个名字空间：Claude Code 页里不能再建一个与「模型」页同名的模型（报 `VALIDATION_FAILED fields.name`，文案「这个模型名已被『模型』页使用」）。实际不冲突：`claude-*`、`gpt-*` 现在都不在 `dsh` 作用域里；真要同一个上游模型两边都用，就起不同的对外名（路由的 `upstreamModel` 负责改回上游名字） |
| F5 | 容器 env 变化 → `config_hash` 变 → 运行中的实例要重建（`models.applyForUser` 已有这套判断）；managed patch 变化只需重启 | 新模式的 env 只放「是否开通 + 密钥 + 地址」，一次开通后不再变（D6） |
| F6 | 插件在 Hub 插件库里的包名固定：`@local/dsh-claude-pilot`、`@local/dsh-codex-pilot`。生产已有，版本 0.3.8 / 0.1.8（这两个版本还没有 §5 的拉取逻辑，编排者会发新版：claude 0.4.0、codex 0.2.0） | 管理页按包名找插件；没上传时提示「插件库里还没有这个插件」 |

## 2. 数据模型（迁移 `087_relay_agent_modes.sql`）

```sql
-- 作用域：dsh（原中转站）| claude-code | codex。建好以后不能改（改作用域等于换一个东西，删了重建）。
ALTER TABLE relay_channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE relay_models   ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';

-- system 密钥从「每人一把」变成「每人每作用域一把」；user 密钥（自建）永远是 dsh。
ALTER TABLE relay_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
DROP INDEX relay_keys_one_system;
CREATE UNIQUE INDEX relay_keys_one_system ON relay_keys(user_id, scope) WHERE kind = 'system' AND revoked_at IS NULL;

-- 用量来源与模式倍率快照（dsh 为 NULL）
ALTER TABLE relay_usage ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE relay_usage ADD COLUMN mode_rate_permille INTEGER;
CREATE INDEX relay_usage_scope_time ON relay_usage(scope, created_at);
-- 日汇总：主键不变（模型名全局唯一，同一模型只属于一个作用域），加列方便按来源汇总
ALTER TABLE relay_usage_daily ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
```

取值约束在应用层（契约 `RelayScopeSchema`），不写 CHECK。

**模式设置**存 `settings` 表键 `agent_modes`（契约 `AgentModeSettingsSchema`，两个模式各一份）：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `enabled` | 开通。关着时：不注入 env，该作用域的密钥请求一律 403 | `false` |
| `ratePermille` | 整体倍率（千分比） | `1000` |
| `defaultModelId` | 默认模型（该作用域的对外模型 id） | `null`（= 可用模型里 `sort, name` 第一个） |
| `smallModelId` | 仅 Claude Code：后台小任务用的模型 | `null`（= 默认模型） |
| `label` | 插件里显示的账号名（「由 DSH Hub 管理 · <label>」） | `'DSH Hub'` |
| `targets` | 开放给谁：`{ all: true }` 或 `{ userIds: [...] }`（可以为空数组） | `{ userIds: [] }` |
| `updatedAt` / `targetsUpdatedAt` | 最近一次修改 / 最近一次修改 `enabled` 或 `targets` 的时间 | — |

默认模型 / 小模型被删除、停用、改了作用域（不可能）或没了可用路由：读取时按「默认」规则兜底并在 `warnings` 里提示，不悄悄改库。

## 3. 中转站改动（`modules/relay/**`）

### 3.1 作用域隔离

- 渠道、对外模型的增删改查接口加 `scope`：列表 `GET …/channels?scope=` / `GET …/models?scope=`（缺省 `dsh`，老前端行为不变）；
  新建请求可带 `scope`（缺省 `dsh`）；修改请求**不接受** `scope`（给了也忽略）。
- **路由必须同作用域**：模型的路由指向别的作用域的渠道 → `VALIDATION_FAILED`（`fields.routes`，「渠道和模型不在同一个页面」）。导入（`/models/import`）的目标作用域 = 渠道的作用域。
- 「模型」页现有的一切（概览告警、下发到 DSH、`/api/me/relay` 的 `models`、`/v1/models` 对 DSH 密钥的结果）**只看 `dsh` 作用域**。
  `syncDshPreset()` 的输入只取 `dsh` 作用域，非 `dsh` 的模型/渠道变化不触发它。
- 概览页的告警（`models-unpriced` 等）三个作用域都算，告警文案带上页面名（如「Claude Code：2 个模型还没定价」）。

### 3.2 鉴权与解析

`/v1/*` 认出密钥后取 `key.scope`：

| 作用域 | 允许的接口 | 其它接口 |
| --- | --- | --- |
| `dsh` | 原样（含 `/v1/tools/*`） | — |
| `claude-code` | `POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`、`GET /v1/hub/agent-mode` | 400 `unsupported_endpoint`（「这把密钥只能给 Claude Code 用」） |
| `codex` | `POST /v1/responses`、`GET /v1/models`、`GET /v1/hub/agent-mode` | 400 `unsupported_endpoint`（「这把密钥只能给 Codex 用」） |

- 非 `dsh` 作用域的密钥，进门检查在钱包检查之前多一步：模式 `enabled` 且用户在 `targets` 里，否则 403 `permission_denied`（「Claude Code 没有对你开放，请联系管理员」/ Codex 同理）。
  从 `targets` 里去掉的用户**立刻**调不通，不等下发。设置在内存里缓存，`PUT` 后立即失效。
- 模型解析只在密钥的作用域里找：别的作用域的模型名一律 404 `model_not_found`（不泄露它存在）。`<模型>@<slug>` 同样只认本作用域的渠道。
- `/v1/models` 只列本作用域、启用、对该用户可见、有启用路由的模型；非 `dsh` 作用域**只列本名**（不展开 `@slug`，Claude Code / Codex 只用本名，中转站自动选渠道）。
- **路径分类先去掉查询串**（F2）：`apiForPath`、上游路径（`count_tokens` 判断）都用 pathname。转发给上游时**原样带上**客户端的查询串（`?beta=true` 是 Claude Code 对官方 API 的正常用法）。
  现有 `dsh` 行为不变（DSH 不带查询串）。

### 3.3 计费

```
cost = ceil( base × channelRatePermille × modeRatePermille × walletRatePercent / (1_000_000 × 1000 × 1000 × 100) )
```

- `modeRatePermille`：`dsh` 作用域恒为 1000（不写快照，`mode_rate_permille = NULL`）；其它取**请求开始时**模式设置里的 `ratePermille`，快照进 `relay_usage.mode_rate_permille`。
- `billing.ts` 加参数，BigInt；`dsh` 的结果必须与改动前**逐位相同**（现有计费测试全部不改照过，另加带模式倍率的用例：×0.5、×2.0、×0、与渠道倍率/钱包倍率相乘的进位）。
- `relay_usage.scope`、`relay_usage_daily.scope` = 密钥的作用域。对账不变量 `balance = Σ ledger − Σ usage.cost` 不变（同一个钱包）。

### 3.4 模式配置接口（插件用）

`GET /v1/hub/agent-mode`，只接受非 `dsh` 作用域的密钥（`dsh` 密钥 → 404 `not_found`），未开通 / 不在 targets → 403（同 §3.2）。响应 `AgentModeClientConfigSchema`：

```json
{
  "mode": "claude-code",
  "label": "DSH Hub",
  "defaultModel": "claude-sonnet-5-5",
  "smallModel": "claude-haiku-5-5",
  "models": [
    { "id": "claude-sonnet-5-5", "displayName": "Claude Sonnet 5.5", "contextWindow": 200000, "maxTokens": 64000,
      "reasoningEfforts": ["low", "medium", "high"], "defaultThinking": null }
  ],
  "updatedAt": "2026-10-20T08:00:00.000Z"
}
```

`models` 与 `/v1/models` 同一集合（按 `sort, name`），字段取模型 `info`；`defaultModel` / `smallModel` 按 §2 兜底后给出，一个可用模型都没有时为 `null`、`models: []`。
不带价格（价格在 Hub 的「积分与用量」页看）。插件每 30 秒最多拉一次。

## 4. 下发到容器

### 4.1 env（`containerEnv` 加法）

对模式**开通**且用户**在 targets 里**的用户，在现有 `models.containerEnv(userId)` 的结果上叠加（密钥 = 该用户该作用域的 system 密钥，没有就当场签发并加密存 `key_enc`，和 `systemKeyPlain` 同一套）：

| 模式 | env |
| --- | --- |
| Claude Code | `HUB_CLAUDE_AUTH=apiKey`、`HUB_CLAUDE_KEY=<sk-dsh-…>`、`HUB_CLAUDE_BASE_URL=<内部监听器根地址，不带 /v1>`（如 `http://10.213.0.1:7710`；Anthropic SDK 自己拼 `/v1/messages`，同 12 §7.0 baseURL 一行） |
| Codex | `HUB_CODEX_KEY=<sk-dsh-…>`、`HUB_CODEX_BASE_URL=<内部监听器地址>/v1`、`HUB_CODEX_WIRE_API=responses` |

内部监听器关闭（端口 0）→ 不注入并在模式状态 `warnings` 里提示。模型、显示名**不进 env**（D6，由 §3.4 拉取），所以开通后 env 不再变化。
不在 targets 里的用户不注入；他们的旧密钥不吊销（再次开放时 env 不变、不用重建），请求被 §3.2 挡住。

### 4.2 「下发」

`POST /api/admin/agent-modes/:mode/deliver`（需要二次密码 `requireReauth`），请求 `{ restart: 'now' | 'next-start', installPlugin: boolean }`，返回 `{ jobId }`。
新任务类型 `rollout.agent-mode`（`JobTypeSchema` 加一项），在任务中心里和其它下发一样显示进度和每个用户的日志。处理的用户 = 当前 targets ∪ 「运行中容器的 env 里还有这个模式的变量」的用户（被移出的要去掉 env）：

1. `installPlugin && 在 targets 里 && 没装这个插件 && 插件库里有` → 按插件下发的 install 流程装最新版本（复用 `rollout.plugin` 的单用户执行函数，不另写一套）。插件库里没有 → 该用户这一步记 `skipped`，日志写原因。
2. 应用 env：与 `models.applyForUser` 同样的判断——env 变了且实例在跑：`restart=now` → 重建；`next-start` → 只记日志；实例没跑 → 下次启动生效。env 没变但第 1 步装了插件 → 重启（插件安装本来就要求重启）。
3. 每个用户一条 task，串行或按 `StrategySchema` 默认并发（3），失败只影响该用户。

「待下发」：`pending = enabled 或 targets 改过（targetsUpdatedAt）晚于最近一次 rollout.agent-mode 任务的创建时间`，或存在「在 targets 里、实例在跑、但容器 env 与期望不一致」的用户（`needsRecreate` 口径）。

### 4.3 模式状态接口

`GET /api/admin/agent-modes/:mode` → `AgentModeStateResponseSchema`：设置、插件信息（库里有没有、最新版本、策略）、可选模型（本作用域的模型列表摘要，给「默认模型」下拉用）、
用户表（targets 里的每个用户 + 被移出但 env 里还有的用户：用户名、显示名、插件是否装了 / 版本、实例状态、env 是否已生效、本月该模式花费）、`pending`、最近一次下发任务、`warnings`。
`PUT /api/admin/agent-modes/:mode`（`UpdateAgentModeRequestSchema`，全部可选）。审计 `agent-mode.update`（detail 记改了哪些字段，targets 记增减的用户 id）、`agent-mode.deliver`。

校验：`defaultModelId` / `smallModelId` 必须是本作用域的模型（否则 `VALIDATION_FAILED`）；Codex 给 `smallModelId` → `VALIDATION_FAILED`；`userIds` 里不存在 / 已删除的用户 → `VALIDATION_FAILED`。

## 5. 插件（编排者负责，WP23 不改插件）

Hub 管理模式下插件启动/每轮对话前调 `GET {base}/v1/hub/agent-mode`（Claude 的 base 不带 `/v1`，所以拼 `/v1/hub/agent-mode`；Codex 拼 `/hub/agent-mode`），缓存 30 秒：

- 模型选择器只列 `models`，默认选 `defaultModel`；Claude 另设 `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` = `smallModel`，`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。
- Codex 在自己的 `CODEX_HOME`（`home-hub`）里生成 provider 配置，`model` = 用户选的或 `defaultModel`。
- 403（没开放）→ 输入框上方提示条显示 Hub 返回的中文原因；网络失败 → 用上次缓存，没有缓存就提示「连不上 DSH Hub」。
- 用量条：Hub 管理模式下不查 Anthropic/ChatGPT 额度，只显示本会话 token。

## 6. 管理端界面

侧边栏在「模型」下面加两项：**Claude Code**（`/admin/claude-code`）、**Codex**（`/admin/codex`）。两页同一个视图组件，按模式切换文案和协议。每页四个标签：

| 标签 | 内容 |
| --- | --- |
| **下发** | 顶部：开通开关、整体倍率（`×1.0` 形式录入，存千分比）、默认模型（下拉，本作用域模型）、小模型（仅 Claude Code）、显示名；「开放给」：所有用户 / 指定用户（用户多选，可搜索）。<br>插件状态：插件库里的版本与策略，没有就给「去插件页上传」的链接。<br>用户表：§4.3 的每一行（插件、实例、env 是否生效、本月花费）。<br>「下发」按钮（有 `pending` 时为主按钮并带数量），弹窗选「立即重启 / 下次启动生效」和「没装插件的自动安装」，二次密码确认，完成后跳到任务详情或页内显示进度。保存设置与下发分开：设置改完立即保存（模型/倍率等即时生效），只有开通和开放范围需要下发 |
| **渠道** | 复用 `RelayChannelsTab`（传入作用域）：列表只显示本作用域渠道；新建抽屉里协议**固定**为本模式的协议、不显示协议选择；其它字段（名称、标识、地址、密钥、渠道倍率、并发、超时、代理）照旧。地址占位提示：Claude Code `https://api.anthropic.com/v1`，Codex `https://api.openai.com/v1` |
| **模型与价格** | 复用 `RelayModelsTab`（传入作用域）：从本作用域渠道拉模型列表勾选、定价。价格列旁显示「× 整体倍率后」的实际单价（模型价 × 整体倍率，渠道倍率仍按渠道胶囊显示）。不显示「下发到 DSH」「默认思考档位」相关的列和字段 |
| **用量** | 复用 `RelayUsageTab`（传入作用域）：统计与逐条记录只看本作用域 |

「模型」页（`/admin/models`）不变，只是看不到这两个作用域的渠道和模型；它的「用量记录」标签默认看全部来源，多一个「来源」筛选和「来源」列。

## 7. 用户端

- `/api/me/relay` 加 `agentModes[]`（契约 `MyAgentModeSchema`）：只含**对我开通**的模式，每项给模式、显示名、整体倍率、可用模型（`MyRelayModelSchema`，价格未乘倍率，`channelRate` 为本作用域渠道倍率范围）、默认模型名。
- 「积分与用量」→「可用模型」：现有列表下面，按模式各加一节「Claude Code」「Codex」，每行模型名、显示名、实际单价（模型价 × 渠道倍率 × 整体倍率 × 钱包倍率；渠道倍率有区间时显示区间）、上下文。没开通的模式不显示。
- 用量统计加「按来源」（DSH / Claude Code / Codex）；使用记录加「来源」列和来源筛选。
- 「API 密钥」列表**不显示**非 `dsh` 作用域的 system 密钥（用户不需要管它们）。
- 工作台「我的模型」不变（只是 DSH 的模型）。

## 8. 安全与边界

- 模式密钥只能调本模式的接口和模型（§3.2），泄露出去也只能当 Claude Code / Codex 的模型用，且受同一个钱包、日上限、并发上限约束。
- 上游密钥照旧只在 Hub 里（`relay_channel_keys` 加密存），用户容器里只有 `sk-dsh-…`。
- 请求/响应内容照旧不落库。

## 9. 任务包

| 包 | 内容 | 端口 / 网段 |
| --- | --- | --- |
| WP23a 后端 | 迁移 087、§3 中转站改动、§4 env 与下发任务、§4.3 接口、§7 用户端接口、审计；真 Claude Code / Codex 程序打假上游的链路验证 | API 7931、内部监听 7932、假上游 7933–7939；n=46 |
| WP23b 前端 | §6 两个页面、「模型」页用量的来源筛选、§7 用户端；`?mock=admin` 假数据 | Vite 5224；CDP 9264；n=47 |
| 插件（编排者） | §5：claude-pilot 0.4.0、codex-pilot 0.2.0，上传到 Hub 插件库 | —（只动插件库，不碰实例） |
