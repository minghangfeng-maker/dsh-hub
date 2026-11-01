# dsh-memory 开发文档 v1

> 给 DeepSeek Harness（DSH）做的记忆插件：全局记忆 + 会话记忆、标签索引、冷热分层、定时整理、设置页管理、记忆图谱。
> 包名 `@local/dsh-memory`，源码目录 `plugins/dsh-memory/`。
> 设计原则：**大道至简**。模型自己判断相关性，插件只负责"索引小而清楚、路径短、定期打扫"。

---

## 0. 背景与目标

DSH 现有的 `AGENTS.md`（`dsh-agent-instructions`）只能放人写的静态规则，模型没法跨会话沉淀经验；会话内的压缩（`dsh-compaction-basic`）是有损摘要，用户的约束经过多次压缩会被磨掉。

本插件要做到：

1. **全局记忆**：跨会话持久的记忆条目，每条一个 markdown 文件，由模型通过工具读写，用户在设置页查看和编辑。
2. **会话记忆**：本会话钉住的笔记，在上下文压缩后逐字恢复，不交给摘要模型改写。
3. **冷热分层**：热条目直接写在常驻索引里；冷条目不进索引，但一定能经"索引 → 主题页 → 条目"最多 2 跳找到。
4. **定时整理**：轻整理（不调 LLM）负责重算冷热、重建索引；深整理（调 LLM）负责合并重复、归一标签、标记过期。
5. **设置页**：查看和编辑记忆文件、配置定时整理、查看整理日志并撤销、审批收件箱。
6. **记忆图谱**：点击按钮弹出交互式图谱，展示条目、标签和关联。

不在本期范围：多用户隔离、向量检索。

---

## 1. 必读参照（先读再写代码）

| 参照 | 路径 | 学什么 |
|---|---|---|
| 既有设置页插件 | 本仓 `plugins/` 下任一含 `dsh.client` 的插件（`package.json`、`runtime/index.js`、`client.js`、`cordis.patch.yml`） | 插件包结构；`dsh.bundle.patch` 和 `dsh.client` 声明；用 `ctx.inject(['webServer'], …)` 注册同源 HTTP 端点；客户端用 `window.__ModuleLoader__.load` 注册、只 `require('react')`、`ctx.slots.register({ name: 'settings.section', … })` 挂设置页、locale 字典、error boundary、`--dsw-alias-*` 主题 token |
| 既有工具型插件 | 本仓 `plugins/` 下任一注册工具的插件（`runtime/index.js`） | `ctx.tools.register` 注册工具；用插件自己的 `node:fs` 写盘（绕开会话沙箱审批）；路径白名单；原子写 |
| 时间上下文 | `$N/dsh-time-context/lib/index.js` | `ctx.on('agent/pre-step', …, { prepend: true })` 往请求里追加一条 user 消息；`ctx.sessionProjections.register` 记录会话级状态（是否已注入等） |
| 工作区指令加载 | `$N/dsh-agent-instructions/lib/index.js` | baseline 注入、增量 reconcile、`workingDirectory` 服务、system-reminder 风格的文本 |
| 压缩 | `$N/dsh-compaction-basic/lib/index.js` | 压缩 checkpoint 事件长什么样（用来检测"刚压缩过"）；`summarizeWithLlm` 里 `ctx.llm.stream()` 的调用方式（深整理调 LLM 照抄这个） |
| 会话落盘 | `$N/dsh-session-persistence-jsonl/` | 会话目录命名规则（例如 `~/.dsh/sessions/--home-alice-project--/session-<uuid>/`），工作区 key 要和它一致 |
| 调度 | `$N/dsh-schedule/` | 可选参考；v1 允许插件内部自带分钟级定时器 |

`$N` = `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai`（即 DSH 自带的插件目录）。

凡是本文写"具体 API 以源码为准"的地方，都必须去上面的源码里确认，不能猜。

---

## 2. 包结构

```
dsh-memory/
├─ package.json            # name @local/dsh-memory, type module, dsh.bundle.patch + dsh.client
├─ cordis.patch.yml        # insert: { id: memory, name: '@local/dsh-memory', config: {...} }
├─ runtime/
│  ├─ index.js             # apply(ctx, config)：组装下面各模块
│  ├─ paths.js             # 数据目录、工作区 key、名字校验
│  ├─ store.js             # 条目读写、frontmatter 解析、原子写、归档、日志
│  ├─ stats.js             # 使用计数（sidecar）、热度计算
│  ├─ indexer.js           # 生成 MEMORY.md 和主题页（纯函数）
│  ├─ inject.js            # agent/pre-step 注入 baseline 和增量
│  ├─ tools.js             # 模型可用的工具
│  ├─ notes.js             # 会话记忆（钉住的笔记）
│  ├─ consolidate.js       # 轻整理 / 深整理
│  ├─ scheduler.js         # 定时器、空闲检测、抢占
│  ├─ graph.js             # 图谱数据
│  └─ api.js               # /memory/api HTTP 端点
├─ client.js               # 设置页 + 图谱弹窗（单文件，只依赖 react）
├─ test/                   # node:test 单元测试
├─ tools/smoke.mjs         # 端到端冒烟脚本
└─ README.md
```

只用 Node 标准库和 DSH 已经提供的包，不引入新的 npm 依赖。frontmatter 只用简单 YAML 子集（标量、字符串数组），自己写解析器。

---

## 3. 数据模型

### 3.1 目录（默认 `~/.dsh/memory/`，可由 config.home 覆盖）

```
~/.dsh/memory/
├─ global/                         # 全局作用域
│  ├─ <name>.md                    # 条目
│  ├─ MEMORY.md                    # 生成物：热索引（不要手改）
│  └─ _topics/<tag>.md             # 生成物：主题页
├─ workspaces/<ws-key>/            # 工作区作用域，结构同 global
├─ sessions/<session-id>.json      # 会话记忆（钉住的笔记）
├─ archive/<scope>/<name>.md       # 归档（不删除，只归档）
├─ inbox/<id>.json                 # 待用户审批的修改提议
├─ inbox/decided/<id>.json         # 批准/拒绝的决定留档（含 AI 理由和完整提议，最多 1000 条）
├─ inbox/decisions.jsonl           # append-only 决定元信息（不裁剪、不含正文）
├─ stats.json                      # 使用计数 sidecar
├─ tags.json                       # 标签词表 + 同义词
├─ journal.jsonl                   # 所有写操作日志（含改前改后，支持撤销）
└─ settings.json                   # 设置页保存的整理配置
```

- `ws-key` 与 DSH 会话目录名的规则一致（例如 cwd `/home/alice/project` → `--home-alice-project--`）。具体规则查 `dsh-session-persistence-jsonl`。
- 所有文件权限 0600，目录 0700；所有写入都用"临时文件 + rename"原子写。

### 3.2 条目文件

```markdown
---
name: relay-needs-no-proxy
description: 访问 relay 必须设 NO_PROXY，否则 Clash 返回 502
type: feedback
tags: [dsh, 网络]
links: [dsh-headless-model]
pinned: false
created: 2026-10-20
updated: 2026-10-20
verified_at: 2026-10-20
source: session-19c49d54-35e3-49e0-af2a-ea2c1cdfecc5
---

正文：事实本身；feedback/project 类附 **Why:** 和 **How to apply:**。
```

| 字段 | 规则 |
|---|---|
| `name` | 身份键，`^[a-z0-9][a-z0-9-]{0,63}$`，在作用域内唯一，也是文件名。**写同名即更新**，不追加新条目 |
| `description` | 一行，≤120 字符，用于索引行 |
| `type` | `user`（用户是谁、偏好）/ `feedback`（纠正与确认过的做法）/ `project`（进行中的工作）/ `reference`（外部资源指针） |
| `tags` | 1～3 个，先经 `tags.json` 同义词归一 |
| `links` | 相关条目的 name，可跨作用域写 `global:<name>` |
| `pinned` | 为 true 时永远在热层 |
| `verified_at` | 最近一次被确认为真的日期 |
| `source` | 写入时所在的会话 id |

正文上限 8 KB。使用计数（hits、last_used）**不写进 frontmatter**，放在 `stats.json`，避免每次读都改文件。

### 3.3 stats.json

```json
{
  "version": 1,
  "scopes": {
    "global": { "sessions": ["<最近的会话 id，按时间，最多 200>"] },
    "workspaces/--home-alice-project--": { "sessions": [] }
  },
  "items": {
    "global/relay-needs-no-proxy": {
      "readSessions": ["<读过它的会话 id，最多保留 50>"],
      "lastUsed": "2026-10-20T13:00:00Z",
      "hits": 7
    }
  }
}
```

### 3.4 tags.json

```json
{ "tags": { "dsh": { "label": "DSH" }, "网络": {} }, "synonyms": { "proxy": "网络", "DeepSeek Harness": "dsh" } }
```

未知标签允许写入（自动加进词表），深整理时再归一。

### 3.5 sessions/<session-id>.json（会话记忆）

```json
{ "sessionId": "...", "workspace": "--home-alice-project--", "notes": [ { "id": "n1", "text": "不要动 prod", "kind": "constraint", "at": "..." } ], "promoted": [] }
```

`kind`：`constraint` / `decision` / `fact` / `todo`。总长上限 4000 字符，满了工具返回错误，要求模型先合并。

### 3.6 journal.jsonl

每行一条：`{ id, at, actor: "model"|"user"|"consolidate", op: "create"|"update"|"archive"|"restore"|"merge"|"retag", scope, name, before, after, reason, runId? }`。`before` 和 `after` 是完整文件文本（或 null）。撤销操作就是把 `before` 写回，并追加一条 `op: "undo"`。

---

## 4. 冷热分层与索引

### 4.1 热度

```
heat(item) = |readSessions ∩ 该作用域最近 N 个会话|      N 默认 20
```

- "读"的定义：通过 `memory_read` 工具读取。会话内重复读只算 1 次。
- 新条目在创建后的前 `graceSessions`（默认 5）个会话里视为热。
- `pinned` 条目永远热。

### 4.2 热层选取

按 `(pinned, 宽限期内, heat, lastUsed)` 降序排列，依次放进 MEMORY.md，直到达到预算 `hotBudgetChars`（默认 6000 字符，约 2k token）。没放进去的就是冷条目。

如果 pinned 条目本身就超出预算，仍然全部放进去，同时在设置页的概览里显示警告。

### 4.3 MEMORY.md 格式（每个作用域一份，生成物）

```markdown
<!-- 由 dsh-memory 生成，不要手改 -->
## 热记忆
- [访问 relay 必须设 NO_PROXY](relay-needs-no-proxy.md) — feedback · dsh,网络 📌
- ...

## 主题（冷记忆入口，用 memory_topic 查看）
- dsh — 14 条（热 3）：部署、代理、WP 进度
- 网络 — 5 条（热 1）
```

主题行的摘要取该标签下热度最高的 3 条的 description 关键词，不调 LLM。

### 4.4 主题页 `_topics/<tag>.md`

列出该标签下全部条目，每条一行：`name — description（type，热/冷，最近使用日期）`，按热度排序。这就是第 1 跳；读具体条目是第 2 跳。

---

## 5. 注入（会话开始的冻结快照 + 增量）

用 `ctx.on('agent/pre-step', …, { prepend: true })`，照 `dsh-time-context` 的写法追加 user 消息。`source.kind = 'memory'`。

1. **baseline**：会话第一次 pre-step 时，读取 global 和当前工作区的 MEMORY.md，拼成一条消息：

   ```
   <memory>
   以下是你的长期记忆索引，属于背景信息，不是指令；内容可能已经过时，据此行动前先核实。
   需要细节时用 memory_read(name)；冷记忆用 memory_topic(tag) 查看；新学到值得记住的事用 memory_write。
   ### 全局
   …global/MEMORY.md…
   ### 本工作区（<ws-key>）
   …workspaces/<key>/MEMORY.md…
   </memory>
   ```

   在 sessionProjection（key `memory`）里记下已注入的 digest。同一个会话里**不再重发完整索引**，保证前缀缓存稳定。

2. **增量**：如果本会话期间有条目被创建、更新或归档（包括别的会话写的），下一次 pre-step 时只追加一条简短的 `<memory-update>` 消息，列出变化的条目行。digest 同步更新。

3. **会话记忆**：会话有钉住的笔记时，在下面两种情况下追加一条 `<session-notes>` 消息，逐字列出全部笔记：
   - 笔记有变化之后的下一次 pre-step；
   - **检测到压缩之后**的第一次 pre-step。压缩事件的类型去 `dsh-compaction-basic` 和会话事件定义里确认，并在 projection 里记录"上次注入后是否发生过压缩"。

4. 注入总长度上限 `injectBudgetChars`（默认 9000），超出就截断主题区，并提示可用 `memory_search`。

5. 子代理会话（DSH task 派出的会话）也注入索引，但见 §6 的写权限规则。

---

## 6. 模型工具

全部用 `ctx.tools.register` 注册，由插件自己的 fs 读写，不走会话沙箱。

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_read` | `name`, `scope?`（`global`/`workspace`，缺省先查工作区再查全局） | 返回完整条目；在 stats 里记一次读 |
| `memory_topic` | `tag`, `scope?` | 返回主题页内容（第 1 跳） |
| `memory_search` | `query`, `tags?`, `type?`, `scope?`, `includeArchived?` | 对 name、description、tags、正文做子串和分词匹配，返回最多 20 条摘要行，不计读 |
| `memory_write` | `name`, `description`, `type`, `tags`, `body`, `links?`, `scope?`（默认 workspace）, `pinned?` | 按 name 创建或整体更新；写 journal；更新 `updated` 和 `source`。校验见下 |
| `memory_archive` | `name`, `reason`, `scope?` | 移入 `archive/`，写 journal |
| `memory_verify` | `name`, `scope?` | 把 `verified_at` 更新为今天（模型实际核实过之后调用） |
| `memory_note` | `action: add/update/remove/list`, `id?`, `text?`, `kind?` | 会话记忆操作 |

校验与安全：

- name 只能取白名单格式，**任何参数都不能是路径**。
- 写入内容如果匹配常见密钥模式（`sk-[A-Za-z0-9]{20,}`、`ghp_`、`AKIA[0-9A-Z]{16}`、`-----BEGIN .*PRIVATE KEY-----`、长度 ≥32 的 hex/base64 token 等），直接拒绝，并提示"不要把密钥写进记忆"。
- `type=feedback` 或 `pinned=true` 的条目，如果已经存在且 `actor` 不是用户：模型的 `memory_write` 不直接覆盖，而是生成一份 inbox 提议，返回"已提交待用户审批"。
- 子代理会话：`memory_write` 和 `memory_archive` 一律转成 inbox 提议（config `subagentWrites: 'inbox' | 'deny' | 'allow'`，默认 `inbox`），提议带 `origin: subagent` 和 `sessionId`。这些提议会在深整理时由 AI 审阅（见 §8.2 第 0 步）；受保护条目、全局作用域和归档提议仍然只由用户决定。
- 工具描述里写清楚：**读记忆要用 `memory_read`，不要用 cat/read 直接读文件**（否则使用计数会失真）。

### 写入准则（写进 memory_write 的工具描述）

- 只记"下一个会话不知道就会做错或多走弯路"的事。
- 不记能从代码、git、配置推导出来的东西。
- 记结论，不记流水账；同一件事更新原条目，不新建。
- 相对日期换成绝对日期。

---

## 7. 会话记忆的晋升

会话里的笔记在两个时机被考虑晋升为长期记忆：

1. 模型主动调用 `memory_write`。
2. 深整理时扫描 `sessions/*.json`（只看已经超过 `sessionIdleHours`，默认 6 小时无活动的会话）：`constraint` 和 `decision` 类笔记交给 LLM 判断是否具有跨会话价值，有价值的生成 inbox 提议（不直接写入）。处理过的写进 `promoted`，不重复处理。

超过 30 天的 `sessions/*.json` 在轻整理时移到 `archive/sessions/`。

---

## 8. 整理

### 8.1 轻整理（不调 LLM）

1. 重算所有条目的热度，按 §4 重新生成每个作用域的 MEMORY.md 和 `_topics/*.md`。
2. 清理 stats 里已经不存在的条目，裁剪过长的会话列表。
3. 归档过期的会话记忆文件。
4. 统计概览数据，写进 `settings.json` 的 `lastRun` 字段。

触发时机：每次 `memory_write` 或 `memory_archive` 之后（防抖 5 秒）、每次深整理开头、手动"立即运行"。

### 8.2 深整理（调 LLM）

按顺序处理，每处理完一条就写 journal，整个过程可以被抢占和续跑：

0. **审阅收件箱（AI 决策子代理提议）**：把 `origin: subagent` 的待审提议交给 LLM，逐条输出 `approve / reject / defer` 和置信度。只有置信度 ≥ `inboxReviewMinConfidence`（默认 0.7）的批准/拒绝才执行，且以下情况**一律 defer 留给用户**：`kind=archive/merge`、带 `archive` 列表、`scope=global`、目标是 `feedback`/`pinned` 条目、提议新建/改成 `feedback` 类型或新建 `pinned` 条目、正文超过 3000 字符（否则 AI 看不到的后半段会被自动写入）、`originScope` 与 `scope` 不一致（跨作用域）、提议创建后目标已被用户手改（`before` 与当前 raw 不一致）、没有可写内容、LLM 拿不准。硬护栏在受 `inboxReviewMax` 限制**之前**先算，所以永久 defer 的提议不会占名额饿死后面的提议。每批 6 条一次 LLM 调用（计入 `maxLlmCalls`），连续两批失败即停止本轮；每批开始、每条落盘前都检查取消/暂停。批准写入的 journal 记 `actor=consolidate` 并带上本次 `runId`（可整次撤销）；决定写 `inbox/decided/<id>.json`（最多 1000 条）并追加 `inbox/decisions.jsonl`（不裁剪）。同一提议的并发决定有进程内互斥（用户批准 vs AI 审阅）。设置项 `inboxReview=user` 时整个阶段跳过。这一阶段排在合并之前，所以新批准的条目能在同一次运行里参与去重。
1. **合并重复**：在同一作用域、同一标签下，用 name 和 description 的字符 bigram Jaccard 相似度（≥0.5）找候选对，交给 LLM 判断是否重复；重复就合并成一条，旧条目归档，并在新条目的 `links` 里保留被合并者的 name。
2. **标签归一**：把只用过 1 次、而且和现有标签同义的标签，交给 LLM 提议映射，写进 `tags.json` 的 synonyms，再重新给条目打标签。
3. **标记过期**：`type=project` 且 `verified_at` 超过 `staleDays`（默认 30 天）的条目，在 frontmatter 里加 `stale: true`，索引行后面加 ⚠️。不归档。
4. **会话记忆晋升**：见 §7。
5. 最后跑一次轻整理。

LLM 调用照抄 `dsh-compaction-basic` 里 `ctx.llm.stream()` 的用法。模型由设置项决定（默认用 DSH 当前默认模型）。每次**续跑尝试**设上限：`maxLlmCalls`（默认 30），超了就停，下次续跑重新计数（累计进度保留），保证预算耗尽不会变成"续跑即暂停"的死循环。

### 8.3 防失真校验（合并必须通过）

- **关键信息守恒**：源条目里的路径、URL、IP、数字、反引号代码片段、命令，用正则提取出来，必须全部出现在合并结果里；缺任何一个就作废这次合并，转成 inbox 提议。
- **受保护条目**：`pinned` 或 `feedback` 类条目参与合并时，结果一律进 inbox，不直接生效。

### 8.4 安全规则

- **永不删除文件**，只归档；归档区可以在设置页一键恢复。
- 每次运行有 `runId`，设置页可以"撤销整次运行"（按 journal 倒序回放 `before`）。AI 审阅批准/拒绝的写入同样挂在这个 `runId` 下。
- AI 审阅只对 `origin: subagent` 的提议生效，并且有硬性护栏：全局作用域、归档/合并提议、feedback/pinned 目标、新建或改成 feedback/pinned、超长正文、跨作用域、用户手改冲突、低置信度一律不自动执行；批准/拒绝都必须过和用户手动批准相同的校验（scope/name、正文大小、密钥模式）。取消（cancel）后审阅立即停止，不会继续落盘。
- 每个决定连同理由留档在 `inbox/decided/`，同时追加到 `inbox/decisions.jsonl`；同一条提议的并发决定用进程内互斥挡住（第二条报 `busy`）。AI 批准前会核对 `proposal.before` 与磁盘当前内容，目标被用户改过就 defer。

### 8.5 调度

设置项（保存在 `settings.json`，设置页可改）：

| 设置 | 默认 |
|---|---|
| 启用定时整理 | 开 |
| 深整理频率 | 每天 |
| 深整理时间 | 03:30 |
| 空闲触发：无活跃会话持续 X 分钟后补跑当天没跑的深整理 | 30 分钟 |
| 深整理使用的模型 | DSH 默认模型 |
| 每次续跑尝试的 LLM 调用上限 | 30（`maxLlmCalls`） |
| 收件箱审阅 | AI 自动决策（`inboxReview=ai`；`user` = 全部手动审批；非法值保守回落到 `user`） |
| AI 审阅的置信度阈值 | 0.7（`inboxReviewMinConfidence`，低于阈值的提议继续留在收件箱） |
| 每次深整理最多审阅多少条提议 | 20（`inboxReviewMax`） |

- 插件内部用一个每分钟 tick 的定时器（`ctx.effect` 里创建，插件卸载时清除）。
- **抢占**：运行中每处理一条前，检查是否有会话正在运行 turn（通过 agents 注册表，具体 API 以源码为准）；有就暂停，记下进度，空闲后续跑。
- 同一时刻只允许一个整理任务运行（文件锁 `~/.dsh/memory/.lock`，带 pid 和过期时间）。

---

## 9. HTTP API（同源，`/memory/api`）

照本仓其它插件的 `registerPanelRoute` 写法注册。客户端永远只传 `scope` + `name`，不传路径。

| 方法与路径 | 作用 |
|---|---|
| `GET  /memory/api/overview` | 各作用域的条目数（热/冷/归档/过期）、热层预算使用率、上次整理和下次整理时间、inbox 数量、警告 |
| `GET  /memory/api/items?scope=&tier=&type=&tag=&q=` | 条目列表（不含正文） |
| `GET  /memory/api/item?scope=&name=` | 单条完整文本 + 解析后的字段 + stats |
| `POST /memory/api/item` `{scope, name, text}` | 用户保存（actor=user），做同样的校验 |
| `POST /memory/api/archive` / `restore` `{scope, name}` | 归档 / 恢复 |
| `GET  /memory/api/journal?limit=&runId=` | 日志 |
| `POST /memory/api/undo` `{journalId}` 或 `{runId}` | 撤销 |
| `GET  /memory/api/inbox`，`POST /memory/api/inbox/:id` `{decision: approve/reject}` | 收件箱 |
| `GET/POST /memory/api/settings` | 整理设置 |
| `POST /memory/api/run` `{mode: light/deep}` | 立即运行，返回 runId |
| `GET  /memory/api/run/:id` | 运行进度 |
| `GET  /memory/api/graph?scope=` | 图谱数据（见 §11） |
| `GET  /memory/api/sessions` | 会话记忆列表（只读） |

所有返回都是 JSON；出错时返回 `{ error: { code, message } }` 和合适的状态码。

---

## 10. 设置页（client.js）

在「设置」里加一个 section「记忆」（`settings.section`，id `memory`，order 选一个不和现有冲突的数）。约定全部照本仓其它设置页插件的 `client.js`：只 `require('react')`；URL 先用文档相对路径 `memory/api/...`，失败再退回 `/memory/api/...`；文案走 locale（zh/en）；样式只用 `--dsw-alias-*` token，class 前缀 `dsh-memory-`；error boundary 的两个分支都要渲染 `<style>`；阅读区最大宽度 760px（列表和图谱可以更宽）；加载、空、错误、未保存四种状态都要有明确呈现。

页签：

1. **概览**：各作用域的统计卡片；热层预算使用条；上次和下次整理时间；警告列表；**「查看记忆图谱」按钮**。
2. **记忆文件**：
   - 左侧是列表，可以按作用域、热/冷/归档、type、tag 筛选，并支持搜索；每行显示 name、description、type、标签、热度、最近使用时间、📌、⚠️。
   - 右侧是详情：显示 frontmatter 字段和正文，可以编辑并保存，可以切换 pinned、归档或恢复；还有一个"关联"区，列出 links 和同标签条目，点击就跳过去。
3. **会话记忆**：按会话列出钉住的笔记，只读。
4. **整理**：定时设置表单；「立即轻整理」和「立即深整理」按钮及运行进度；最近 10 次运行记录，每次可以展开查看日志、撤销单条或撤销整次。
5. **收件箱**：待审批的提议，以 diff 形式展示改前和改后，提供批准和拒绝按钮。

---

## 11. 记忆图谱

### 11.1 数据（`GET /memory/api/graph`）

```json
{
  "nodes": [
    { "id": "global/relay-needs-no-proxy", "kind": "item", "label": "...", "type": "feedback", "scope": "global", "tier": "hot", "heat": 7, "pinned": true, "stale": false },
    { "id": "tag:dsh", "kind": "tag", "label": "dsh", "count": 14 }
  ],
  "edges": [
    { "source": "global/relay-needs-no-proxy", "target": "tag:dsh", "kind": "tag" },
    { "source": "global/relay-needs-no-proxy", "target": "global/dsh-headless-model", "kind": "link" },
    { "source": "...", "target": "...", "kind": "coread", "weight": 3 }
  ]
}
```

`coread` 边：两条记忆在 ≥2 个相同会话里都被读过，权重等于共同会话数。每个节点最多保留 5 条 coread 边。

### 11.2 交互（点击「查看记忆图谱」弹出全屏模态框）

- 用 SVG 渲染，**自己实现**一个简单的力导向布局（斥力 + 弹簧 + 向心力，固定迭代次数，不引入任何库）。
- 节点：条目节点的大小与热度相关，颜色按 type 区分，热条目加外圈，📌 条目加图钉标记，过期条目用虚线描边；标签节点是小号的胶囊形状。
- 边：tag 边是浅色细线，link 边是实线，coread 边是虚线，粗细与权重相关。
- 操作：滚轮缩放、拖动画布、拖动节点；悬停显示 description；点击条目节点就关闭弹窗并在"记忆文件"页签里打开该条目；顶部有筛选（作用域、只看热、显示/隐藏 tag 节点、显示/隐藏 coread 边）；右上角是关闭按钮，Esc 也能关闭。
- 节点超过 300 个时，默认隐藏冷条目，并给出提示。
- 深色和浅色主题下都要清晰可读，颜色取自主题 token 或者一组在两种主题下对比度都合格的固定色板。

---

## 12. 配置（cordis.patch.yml 的 config）

```yaml
- insert:
    - id: memory
      name: '@local/dsh-memory'
      config:
        home: ~/.dsh/memory
        hotBudgetChars: 6000
        injectBudgetChars: 9000
        recentSessions: 20
        graceSessions: 5
        staleDays: 30
        subagentWrites: inbox
```

定时整理的设置在设置页里改，保存在 `settings.json`，不放进 config。

---

## 13. 测试与验收

### 13.1 单元测试（`node --test test/`）

至少覆盖：

- frontmatter 解析和序列化往返；name 校验；路径穿越被拒（`../`、绝对路径、`%2e%2e`）。
- 密钥模式被拒。
- 热度计算、宽限期、pinned、预算截断；MEMORY.md 和主题页渲染（快照测试）。
- journal 写入和撤销（单条、整次运行）。
- 合并校验：缺少路径或数字时作废。
- 深整理用一个**假 LLM**（固定返回）跑完整流程，验证抢占后可以续跑。
- 注入：baseline 只发一次；条目变化后发增量；压缩后重发会话笔记。

### 13.2 冒烟测试（`tools/smoke.mjs`）

用临时 HOME 目录（`DSH_MEMORY_HOME` 环境变量或 config.home 指向 `/tmp/...`）启动插件的 runtime 模块，模拟：写 3 条记忆 → 读 → 轻整理 → 检查 MEMORY.md → 通过 HTTP API 读列表和图谱。

### 13.3 隔离与安装

- **不要修改** `~/.dsh/profiles/web/` 下的任何文件，**不要重启**用户正在运行的 `dsh web`。集成到用户正式环境由用户（或主会话）在验收后完成。
- 如果需要真实启动 DSH 来测试，使用独立的测试 profile 和独立端口（参照 `~/.dsh/profiles/pilot-dev`，复制一份新的再改，不要改原有的），测试数据目录指向 `/tmp`。
- README 里写清楚安装步骤：profile `package.json` 加 `"@local/dsh-memory": "link:/home/alice/project/dsh-memory"`，把它加进 `dsh.profile.bundles`，然后 `pnpm install`，重启 `dsh web`。

### 13.4 验收标准

- [ ] `node --test` 全部通过。
- [ ] `node tools/smoke.mjs` 通过。
- [ ] 在测试 profile 里真实启动 DSH：新会话能看到 `<memory>` 注入；模型调用 `memory_write` 和 `memory_read` 后，文件、stats、journal 都正确。
- [ ] 设置页 5 个页签都能正常显示和操作；图谱弹窗可以打开、缩放、点击跳转；浅色和深色主题下都检查过（附截图，存到 `docs/screenshots/`）。
- [ ] 深整理用真实 LLM 在测试数据上跑一次，日志正确，可以撤销。

---

## 14. 里程碑

| 里程碑 | 内容 |
|---|---|
| M1 | paths / store / stats / indexer / tools / 注入 / 轻整理 + 单元测试 |
| M2 | 会话记忆（memory_note + 压缩后重发） |
| M3 | HTTP API + 设置页（概览、记忆文件、会话记忆） |
| M4 | 深整理 + 调度 + 整理页 + 收件箱 |
| M5 | 图谱 API + 图谱弹窗 |

每个里程碑结束都要跑全部测试，并记录：做了什么、遇到的问题、偏离本文的地方和理由。
