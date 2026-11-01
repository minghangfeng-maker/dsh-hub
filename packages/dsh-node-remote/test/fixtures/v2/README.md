# fixtures-v2 —— 从真实 DSH Host 录下的帧样本（WP40c）

> 本目录是回放用的帧样本，`packages/dsh-node-remote/test/v2.test.ts` 直接读它。
> 更新方式：对着一个真实的 DSH Host 重新录一遍，再按下面的脱敏规则处理。

- 来源：`dshhub/runtime:0.2.1-rc.2` 一次性测试容器（独立测试网络），假模型上游是一个本地 OpenAI 兼容桩。
- 采集时间：2026-10-25 19:17–19:31（Asia/Shanghai）。
- 用途：WP40c-2 实现 `M5-mobile-v2.draft.ts` 的投影时**对拍**；App 端做渲染回归时的输入。
- 采集方式：脚本只读 Host（`workspaceFiles/*`、`session/page`、`session/modelCatalog` 等），不改容器。

## 文件

| 文件 | 对应契约 | 内容 |
|---|---|---|
| `models-catalog.json` | §4.1 a | `session/modelCatalog` 的**原始返回值**（2 个模型、各 4 档 effort、`default`/`routableProviders`/`failures`） |
| `projections.json` | §4.2 a、§12.3 j | `session/projections{sessionId}`：`asOfSeq` + 20 个投影键（含 `modelSelection`、`permissions`、`imageLimits`、`sessionListMetadata`） |
| `follow-tool-turn.ndjson` | §7.1 d | 一次 bash 回合的**完整 follow 流**：`snapshot` → `turn/start` → `step/start` → `assistant-stream{start,chunk×6,end}` → `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end` |
| `follow-reasoning.ndjson` | §7.4 e | 带思考的回合：`reasoning-delta` 增量 + `assistant/message` 里的 `reasoning` 块 |
| `follow-deliverable.ndjson` | §8.1 f | `present` 工具回合：`tool/call` → **`deliverables/presented`** → `tool/result` |
| `tool-result-large.json` | §7.1 d 截断 | `seq 1 20000` 的 `tool/call`/`tool/result`；`textChars` 是原文长度（含 DSH spill 的省略提示） |
| `tool-result-search-error.json` | §7.1 d | `web_search` 因假上游 401 失败：`isError:true` + `error{name,code}` |
| `history-page.json` | §8.1 f、§7.3 d | `session/page{throughSeq:snapshot.cursor}` 的 148 条记录（含 `deliverables/presented`、`tool/call`、`tool/result`、`request/header`） |
| `workspace-follow.json` | §10 h | `workspace/follow` 的 `baseline` 与两次 `archived` 帧（归档 → 取消） |
| `file-list.json` / `file-stat.json` | §8.3 f | `workspaceFiles/list{path:'.'}` 与 `stat` |
| `readbytes-multipart.txt` | §8.3 f | `workspaceFiles/readBytes` 的 **multipart/form-data** 响应（字节在 `bytes-0` 部分，`value.data` 是 null） |
| `errors.json` | §5.2 b、§10 h、§13 | 9 个真实错误响应：档位不支持、未知模型、未知 preset、坏图、未引用附件、`list '/'`、`list ''`、会话搜索被禁、未知 workspace |

## 脱敏规则（可复算）

写入本目录时只做这五件事：

1. `system/message` 的正文替换成 `<system prompt omitted>`（是 DSH 的完整系统提示与工具说明，与契约无关，且很长）。
2. `request/header` 的 `tools` 数组替换成 `<N tool schemas omitted>`。
3. `session/title-llm-request` 的 `system` 替换成占位符。
4. `assistant/message` 的 `stream`（compact 记录）替换成 `<N compact stream records omitted>`；`tool-call` 的 `arguments` 截到 600 字符。
5. `tool/result` 的正文截到 400 字符并追加 `…[clipped N chars]`；`assistant-stream` 的 `tool-call-delta` 截到 200 字符。

**没有**做过任何「内容改写」：所有字段名、字段层级、类型、seq/time 都是真实值。
**不含凭据**：容器是自己建的测试实例（`DEEPSEEK_API_KEY=mock-key` 是假 key），cookie 与 `browser-session` 密钥从未写进这些文件；容器已在收尾时删除。
**唯一的主机路径**：`tool-result-large.json` 里 DSH spill 的 `/tmp/dsh-spill-…` 是容器内临时路径（容器已删）。

## 与 v1 fixture 的关系

`packages/shared/test/fixtures/mobile-v1/` 是**手机帧**（Hub ↔ 手机）；本目录是**DSH Host 帧**（Hub ↔ Host）。
两套都要：v1 fixture 测协议，本目录测投影前的真实输入。不要混用。

## 校验

`M5-mobile-v2.draft.ts` 已用本目录的真实数据跑过 zod 解析（16 项全绿，含「客户端帧拒绝未知字段」「DSH 原始错误码被白名单拒绝」「老桌面端只报 v1 能力位」三处否定用例）。复跑：

```bash
pnpm --filter @dsh-hub/dsh-node-remote test
pnpm --filter @dsh-hub/shared test
```
