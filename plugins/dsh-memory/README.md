# @local/dsh-memory

DeepSeek Harness（DSH）的**记忆插件**：全局/工作区记忆条目、标签索引、冷热分层、定时整理、
会话记忆（压缩后逐字重发）、设置页与记忆图谱。

- 每条记忆一个 markdown 文件，模型通过工具读写，用户可以在设置页查看/编辑；
- 索引（`MEMORY.md`）小而清楚：热记忆直接列在索引里，冷记忆经「索引 → 主题页 → 条目」最多 2 跳找到；
- 轻整理（不调 LLM）每次写入后防抖 5 秒重建索引；深整理（调 LLM）每天空闲时审阅子代理提交的
  收件箱提议、合并重复、归一标签、标记过期、晋升会话笔记；
- 所有写入进 `journal.jsonl`（带改前/改后全文），可以在设置页撤销单条或整次运行；
- 永不删除记忆文件，只归档，可一键恢复。

设计文档：`docs/DESIGN.md`。HTTP 契约：`docs/API-CHANGES.md`。
**装到别的 DSH**：见 `INSTALL.md`（`node tools/export.mjs` 生成 `dist/` 里的 tgz）。

---

## 安装

插件装进一个 DSH **profile**（下面的例子是 `web`）。不要改 DSH 安装目录本身。

- **本地开发**（改代码即时生效）：下面的 link 安装。
- **装到别的 DSH**（另一台机器/另一个 profile，用打进 tarball 的版本）：
  `node tools/export.mjs` 生成 `dist/`，再按 `dist/INSTALL.md` 操作（一条命令：
  `./install.sh <profile>`，或者复制 tgz 到目标机后用 Web 插件页 / `dsh plugin add`）。

本地（link）安装步骤：

1. 在 profile 的 `package.json` 里加 link 依赖：

   ```json
   {
     "dependencies": {
       "@local/dsh-memory": "link:/home/alice/project/dsh-memory"
     }
   }
   ```

2. 把包名加进 `dsh.profile.bundles`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@local/dsh-memory"
         ]
       }
     }
   }
   ```

   > ⚠️ 加到 `bundles` 之后，**不要再在 profile 的 `cordis.patch.yml` 里 `insert` 同一个包**：
   > 包自带的 `cordis.patch.yml` 已经插入了一行 `id: memory`，重复 insert 会让同一插件挂两次。
   > 要改配置，用 `- id: memory` + `config:` 覆盖（patch 会替换整个 config，所以每个键都要重述）。

3. 安装并重启：

   ```bash
   cd ~/.dsh/profiles/web
   pnpm install          # 或者 dsh plugin --profile web install
   # 重启 dsh web（在跑的实例不会热加载新的 node_modules）
   ```

4. 打开设置 →「记忆」。第一次运行会在 `~/.dsh/memory/` 建目录和空索引。

### 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: memory
      name: '@local/dsh-memory'
      config:
        home: ~/.dsh/memory       # 数据目录；也支持环境变量 DSH_MEMORY_HOME（config.home 优先）
        hotBudgetChars: 6000      # 热层预算（字符，约 2k token）
        injectBudgetChars: 9000   # 单条注入消息上限
        recentSessions: 20        # 热度观察窗口：最近 N 个会话
        graceSessions: 5          # 新建条目在创建后的前 N 个会话里视为热
        staleDays: 30             # type=project 超过 N 天没 verify → 标 ⚠️（只标记，不归档）
        subagentWrites: inbox     # 子代理写记忆：inbox（默认）/ deny / allow
```

定时整理的设置**不在 config 里**：在设置页改，存到 `<home>/settings.json`（`enabled`、`deepFrequency`、
`deepTime`、`idleMinutes`、`model`、`maxLlmCalls`、`sessionIdleHours`、`inboxReview`、
`inboxReviewMinConfidence`、`inboxReviewMax`）。

### 导出可安装包（分发到别的 DSH）

```bash
node tools/export.mjs        # 要求工作区干净（先 commit），会先跑单测+冒烟再打包
```

产物在 `dist/`：

| 文件 | 说明 |
|---|---|
| `dsh-memory-<version>.tgz` | 装到别的 DSH 的 npm tarball（`dsh plugin add <tgz>` 或 Web 插件页） |
| `dsh-memory-<version>-source.tar.gz` | 对应源码快照 |
| `INSTALL.md` | 安装/验证/迁移/卸载说明（版本号已替换） |
| `install.sh` | 命令行一键安装 |
| `SHA256SUMS` | 校验和 |

导出脚本只打包 **git HEAD 里已提交**的内容（不会把 `.bak` 之类的临时文件带出去），
并在打包前后各验一遍：staging 单测 + 冒烟、tarball 文件清单核对。

---

## 模型工具

### Claude Code / Codex 对话模式

记忆插件提供可选的 `memoryPilot` 宿主服务，供本机两个 pilot 桥共用。
Claude 通过 `mcp__dsh__memory_*` 使用七个记忆工具，Codex 通过同名的
`memory_*` 动态工具使用。它们复用正在运行的记忆服务与数据目录，因此与原生
DSH 会话共享条目、热度、日志、收件箱和设置页；工作区与会话笔记仍按 DSH
会话的身份隔离。

首次发送记忆索引，后续只发送变化；会话笔记变化或检测到压缩后重发。
内容由 pilot 桥送入外部模型，不往 DSH 的空 `enter` 返回值中追加消息。
发送失败时不推进注入游标，下一轮重试。

Claude 已有会话在下一轮即可获取工具。Codex 的动态工具由 `thread/start`
注册，已有旧 thread 无法补注册，需要新建对话，或 `/clear` 后再发消息
（`/clear` 会重开 Codex 上下文）。`GET /claude-pilot` 与
`GET /codex-pilot` 的 `memoryTools: 7` 表示宿主桥接已就绪。

插件未安装时，两个模式仍可正常对话。

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_read` | `name`, `scope?` | 读完整条目；不传 scope 时先工作区再全局；记一次「读过」（热度） |
| `memory_topic` | `tag`, `scope?` | 读主题页（第 1 跳） |
| `memory_search` | `query`, `tags?`, `type?`, `scope?`, `includeArchived?` | 子串/分词搜索，最多 20 条摘要，不计热度 |
| `memory_write` | `name`, `description`, `type`, `tags`, `body`, `links?`, `scope?`, `pinned?` | 同名即更新；校验名字/标签/正文/密钥 |
| `memory_archive` | `name`, `reason`, `scope?` | 移入 `archive/`，不删除 |
| `memory_verify` | `name`, `scope?` | 把 `verified_at` 更新为今天并清掉 ⚠️ |
| `memory_note` | `action`, `id?`, `text?`, `kind?` | 会话钉住的笔记：add/update/remove/list；总长 4000 字符 |

写入准则写在 `memory_write` 的描述里：只记「下一个会话不知道就会做错」的事；不记能从代码/git/配置
推导的东西；记结论；相对日期换绝对日期；**不要把密钥写进记忆**（插件会拒绝常见密钥模式）。

### 安全规则

- 条目名只能是 `^[a-z0-9][a-z0-9-]{0,63}$`；所有参数都不会被当作路径拼接。
- 作用域 key 排除 `.` / `..`（`workspaces/..`、`workspaces/../../etc` 等一律拒绝）；底层每个
  拼路径的函数（条目/索引/主题页/归档/会话笔记/收件箱）自己也校验，并在 `path.join` 之后
  用 `path.relative` 断言结果仍在 `<home>` 内（纵深防御，见 `test/security.test.js`）。
- 正文 ≤8 KB；命中 `sk-…`、`ghp_…`、AWS key、私钥、长 hex/base64 token 直接拒绝。
- 已存在的 `feedback` 或 `pinned` 条目，模型改写不直接生效，而是进**收件箱**等用户批准。
- 子代理会话（`session.header.origin === 'subagent'` 或 `delegationDepth > 0`）默认也转收件箱；
  可以用 `subagentWrites: deny | allow` 改。收件箱里带 `origin: subagent` 的提议会在深整理时
  交给 AI 审阅（见「整理」），AI 拿不准的仍然等你批准。

---

## 数据布局

```
<home>/
├─ global/                     # 全局作用域
│  ├─ <name>.md                # 条目（frontmatter + 正文）
│  ├─ MEMORY.md                # 生成物：热索引
│  └─ _topics/<tag>.md         # 生成物：主题页
├─ workspaces/<ws-key>/        # 工作区作用域（key 与 DSH 会话目录一致，如 --home-u-ds-work--）
├─ sessions/<session-id>.json  # 会话记忆（钉住的笔记）
├─ archive/<scope>/<name>.md   # 归档（永不删除，可恢复）
├─ inbox/<id>.json             # 待用户审批的提议
├─ inbox/decided/<id>.json     # 批准/拒绝的决定留档（含理由和完整提议，最多保留 1000 条）
├─ inbox/decisions.jsonl       # append-only 决定元信息（谁、何时、哪条、为什么，不裁剪）
├─ stats.json                  # 使用计数（不写进 frontmatter）
├─ tags.json                   # 标签词表 + 同义词
├─ journal.jsonl               # 所有写操作日志（改前/改后全文）
├─ settings.json               # 定时整理设置
├─ runs.json                   # 运行记录（深整理进度，可续跑）
└─ .lock                       # 整理锁（pid + 过期时间）
```

文件和目录权限分别是 0600 / 0700；所有写入都是「临时文件 + rename」。

### 冷热

`heat = |readSessions ∩ 该作用域最近 N 个会话|`。新建条目在创建后的前 `graceSessions` 个会话里视为热；
`pinned` 永远热。按 `(pinned, 宽限期, heat, lastUsed)` 排序填进 `MEMORY.md`，直到 `hotBudgetChars`；
pinned 超预算也全部保留，并在设置页概览里给出警告。

> 说明：用户从设置页新建的条目没有来源会话，宽限期退化为「创建后 7 天内视为热」。

---

## 注入

- 会话第一次 pre-step 发一条 `<memory>`（global + 本工作区的索引），之后**不再重发完整索引**；
- 之后有条目变化（包括别的会话/后台整理写的）只发 `<memory-update>`，列出变化行 ——
  变化来源是 `journal.jsonl`，所以跨进程也能看到；
- 会话笔记有变化、或**检测到压缩之后**（`compaction/end` / `compaction/summary`），
  发 `<session-notes>` 逐字重发全部笔记；
- 注入状态放在 session projection（key `memory`），从注入消息自己的 `source` 折叠出来，resume 后不丢；
- 单条消息受 `injectBudgetChars` 限制，超出时截断主题区并提示用 `memory_search`。

## 整理

- **轻整理**：重建索引、清理 stats、归档 30 天前的会话笔记、更新概览。写入后防抖 5 秒自动跑；
  也可以设置页「立即轻整理」。
- **深整理**：审阅收件箱（子代理提交的提议由 AI 决定批准/拒绝）→ 合并重复（bigram Jaccard ≥ 0.5
  的候选对交给 LLM）→ 标签归一 → 标记过期 → 会话笔记晋升 → 收尾轻整理。每次运行有 `runId`，
  进度写 `runs.json`；被抢占、取消或达到 `maxLlmCalls` 后暂停，空闲/下次调度用同一个 `runId`
  续跑（**预算按每次续跑尝试重新计数**，所以不会卡在"一续跑就再撞上限"的死循环里）。
  合并结果必须保留源条目的路径/URL/IP/数字/代码片段，否则作废并转收件箱；pinned/feedback 参与
  合并时一律进收件箱。
- **收件箱审阅（AI 决策）**：深整理的第一个阶段把 `origin: subagent` 的待审提议交给 LLM，逐条给
  `approve / reject / defer` + 置信度。只有置信度 ≥ `inboxReviewMinConfidence`（默认 0.7）的
  批准/拒绝才执行；以下情况一律 `defer` 留给用户：全局作用域、`kind: archive/merge`、目标是
  feedback/pinned 条目、新建或改成 feedback（受保护类型）、新建 pinned 条目、正文超出审阅窗口
  （3000 字符，防止 AI 看不到的后半段被自动写入）、写入作用域不是提出提议的会话作用域、
  提议创建后目标条目被用户手改过、没有可写内容、拿不准。同一批里"永远 defer"的提议不占
  `inboxReviewMax`（默认 20）的名额，避免把后面的正常提议饿死；每批 6 条一次 LLM 调用
  （计入 `maxLlmCalls`），连续两批调用失败就停止本轮。设置页可把 `inboxReview` 切回 `user`
  （全部手动审批）；置信度阈值和每次上限在 `settings.json`/API 里调。AI 写过的条目挂在这次运行
  的 `runId` 下，设置页可以撤销整次运行；每个决定（含拒绝的理由）留档在
  `<home>/inbox/decided/<id>.json`，元信息另写 append-only 的
  `<home>/inbox/decisions.jsonl`。取消深整理会立刻停止审阅，不再批准或拒绝任何提议。

## HTTP API

同源 `/memory/api`，完整契约见 [`docs/API-CHANGES.md`](docs/API-CHANGES.md)。设置页和图谱
（`client.js`）只通过它访问数据。

## 测试

```bash
node --test            # 单元测试（自动发现 test/*.test.js）
node tools/smoke.mjs   # 端到端冒烟：真实 runtime 入口 + 假上下文 + 真 HTTP 路由
```

冒烟脚本用 `DSH_MEMORY_HOME` 指向临时目录，结束自动清理；不连模型、不碰 `~/.dsh/memory`。
深整理的 LLM 测试用注入的假 LLM（`test/consolidate.test.js`）。

## 已知限制

- `journal.jsonl` 只追加、没有轮转；长期使用后文件会变大（读取有进程内缓存和增量解析）。
- `stats.json` 是读-改-写；多个会话同时写可能丢一次 session id 更新（journal 是追加写，不受影响）。
- 整理锁的 TTL 是 2 小时且不续期；一次超长运行（>2h）可能被第二个实例抢锁。
- 会话笔记超过 30 天会被移到 `archive/sessions/`（不删除）。
- 图谱的力导向布局在客户端实现；后端只提供数据（节点超过 300 时用 `hiddenCold` 提示）。
- `client.js`（设置页与图谱）的后端 API 调用层有测试覆盖；浏览器端的视觉验收不在单测范围内。
- AI 审阅器和被审的子代理内容用的是同一个模型/路由：同模型更容易被措辞带偏。护栏只对
  明确风险（作用域、受保护类型、超长正文、手改冲突、置信度）硬拦截；高风险内容建议把
  `inboxReview` 切回 `user`。
- `inbox/decided/` 没有设置页 UI，要复核 AI 的决定请直接看 `inbox/decided/*.json` 和
  `inbox/decisions.jsonl`，或看整理页的运行日志/收件箱计数。
  `package.json` 已按其它插件的写法声明了 `dsh.client`。
