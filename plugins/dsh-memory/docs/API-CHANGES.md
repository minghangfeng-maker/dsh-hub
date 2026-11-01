# `/memory/api` 契约（实现说明与偏离记录）

> 这份文件是**后端实现与 DESIGN.md §9/§11.1 的对照表**。§9 只规定了「方法与路径」，
> 没有规定返回字段；为了让并行开发设置页/图谱的任务能直接对接，这里把每个端点的
> 请求与返回**逐字固定下来**。没有改动 §9 的任何路径或参数；新增了一个列表端点
> 并在下面标出。

- 基础路径：`/memory/api`（文档相对路径 `memory/api/...`）
- 请求体：JSON 对象，上限 256 KB
- 成功响应：HTTP 200，JSON 对象，**一律带 `ok: true`**
- 失败响应：`{ "error": { "code": "...", "message": "..." } }` + 合适状态码
- 时间：ISO 8601 字符串（UTC，如 `2026-10-20T13:51:23.296Z`）；日期是 `YYYY-MM-DD`
- 写请求（POST）要求同源：拒绝 `Sec-Fetch-Site: cross-site`，以及 Origin 与 Host 不一致的请求（403）。GET 不要求。

## 端点总表

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/overview` | 概览 |
| GET | `/items` | 条目列表（不含正文） |
| GET | `/item` | 单条完整数据 |
| POST | `/item` | 用户保存 |
| POST | `/archive` | 归档 |
| POST | `/restore` | 从归档恢复 |
| GET | `/journal` | 日志 |
| POST | `/undo` | 撤销单条/整次运行 |
| GET | `/inbox` | 收件箱 |
| POST | `/inbox/:id` | 批准/拒绝 |
| GET | `/settings` | 整理设置 |
| POST | `/settings` | 保存设置 |
| POST | `/run` | 立即运行（light/deep） |
| GET | `/run/:id` | 运行进度 |
| GET | `/runs` | **新增**：最近运行列表 |
| GET | `/graph` | 图谱数据（§11.1） |
| GET | `/sessions` | 会话记忆（只读） |

---

## GET `/overview`

```json
{
  "ok": true,
  "home": "/home/u/.dsh/memory",
  "scopes": [
    {
      "scope": "global", "label": "全局",
      "total": 4, "hot": 3, "cold": 1, "archived": 2, "stale": 1, "pinned": 1,
      "usedChars": 233, "budgetChars": 6000, "budgetRatio": 0.039,
      "topics": 3
    },
    { "scope": "workspaces/--home-u-ds-work--", "label": "--home-u-ds-work--", "...": "同上" }
  ],
  "totals": { "items": 7, "hot": 5, "cold": 2, "archived": 2, "stale": 1, "pinned": 1, "tags": 5 },
  "budget": { "usedChars": 400, "budgetChars": 12000 },
  "schedule": {
    "enabled": true, "deepFrequency": "daily", "deepTime": "03:30", "idleMinutes": 30,
    "model": null, "maxLlmCalls": 30,
    "lastRun": { "runId": "run-…", "mode": "light", "startedAt": "…", "finishedAt": "…", "reason": "manual", "scopes": [], "archivedSessions": [], "totalItems": 4, "broken": 0 },
    "lastLight": "…", "lastDeep": "…",
    "nextRun": "2026-10-21T03:30:00.000Z"
  },
  "inbox": { "count": 2 },
  "warnings": [
    { "code": "pinned-over-budget", "scope": "global", "message": "…" },
    { "code": "empty-scope", "scope": "workspaces/…", "message": "…" },
    { "code": "broken-item", "scope": "global", "message": "…" },
    { "code": "last-error", "message": "…" }
  ],
  "errors": [ { "at": "…", "message": "注入失败的原因" } ],
  "generatedAt": "…"
}
```

`label` 只用于显示：全局是「全局」，工作区是去掉 `workspaces/` 前缀后的 key。`budgetRatio` 是 0–1。

## GET `/items`

查询参数（全部可选）：`scope`（`global` / `workspaces/<key>`）、`tier`（`hot` / `cold` / `archived` / `all`，缺省=全部活动条目）、`type`、`tag`、`q`（在 name/description/tags 里做子串匹配）。

```json
{
  "ok": true,
  "items": [
    {
      "scope": "global", "name": "relay-no-proxy",
      "description": "访问 relay 必须设 NO_PROXY", "type": "feedback",
      "tags": ["dsh", "网络"], "links": ["dsh-headless-model"],
      "pinned": false, "stale": false, "tier": "hot",
      "heat": 2, "hits": 3, "lastUsed": "2026-10-19T10:00:00Z",
      "created": "2026-10-01", "updated": "2026-10-20", "verified_at": "2026-10-19",
      "source": "session-…", "bytes": 332
    }
  ],
  "total": 1
}
```

归档条目的 `tier` 是 `archived`、额外带 `"archived": true`，`heat` 恒为 0（归档条目不计热度）。
**列表永远不返回 `body` / `raw`**（设置页列表只用摘要；正文用 `GET /item`）。

## GET `/item?scope=&name=`

两个参数都必填。返回：

```json
{
  "ok": true,
  "item": {
    "scope": "global", "name": "relay-no-proxy",
    "raw": "---\nname: …\n---\n\n正文",
    "meta": { "name": "…", "description": "…", "type": "feedback", "tags": ["dsh"], "links": [], "pinned": false, "created": "…", "updated": "…", "verified_at": "…", "source": "…", "stale": false },
    "body": "正文\n",
    "path": "/home/u/.dsh/memory/global/relay-no-proxy.md",
    "tier": "hot",
    "stats": { "heat": 2, "hits": 3, "lastUsed": "…", "readSessions": ["session-…"] },
    "links": [ { "scope": "global", "name": "dsh-headless-model", "description": "…" } ],
    "sameTag": [ { "scope": "global", "name": "…", "description": "…", "tag": "dsh" } ]
  }
}
```

`links` 是解析后的关联条目（只含仍然存在的），`sameTag` 是同作用域共享标签的条目（去重）。
`path` 只用于显示；客户端的写操作永远只用 `scope` + `name`。

## POST `/item`

请求 `{ scope, name, text }`。`text` 是**完整文件文本**（含 frontmatter），也可以只有正文 ——
后者只在条目已存在时允许（沿用原字段）。返回 `{ ok, created, changed, item }`，`item` 形状同 `GET /item`。

校验与 `memory_write` 一致：name 白名单、正文 ≤8 KB、密钥模式拒绝（422 `secret-detected`）、
frontmatter 的 `name` 必须与参数一致、`description` 非空、tags 1–3 个。actor 记 `user`，
不受 feedback/pinned 保护规则限制。

## POST `/archive`、POST `/restore`

`{ scope, name }` → `{ ok: true, archived: true, scope, name }` / `{ ok: true, restored: true, scope, name }`。
条目不存在（归档区没有）返回 404 `not-found`。归档是「移到 `archive/<scope>/`」，永不删除。

## GET `/journal?limit=&runId=`

`limit` 默认 50、最大 500；`runId` 可选。返回 `{ ok, entries, total }`：

```json
{
  "ok": true,
  "entries": [
    {
      "id": "j-…", "at": "…", "actor": "model|user|consolidate",
      "op": "create|update|archive|restore|merge|retag|undo",
      "scope": "global", "name": "relay-no-proxy",
      "before": "完整文件文本或 null", "after": "完整文件文本或 null",
      "reason": "…", "runId": "run-…"
    }
  ],
  "total": 1
}
```

`total` 是**本次返回的条数**（不是全库总数），方便前端直接渲染。

## POST `/undo`

请求 `{ journalId }` 或 `{ runId }`（二选一）→ `{ ok: true, undone: ["j-…", …], skipped: 0 }`。

- 单条：把该条 `before` 写回；
- 整次运行：取所有带该 `runId` 的 create/update/archive/restore/merge/retag，**倒序**回放；
- 撤销一次 create 的动作是「归档」，不是删除文件；撤销会追加新的 `op: "undo"` 日志。
- 目标不存在 / 没有可撤销的写入：404 `journal-not-found`。

## GET `/inbox`

```json
{
  "ok": true,
  "items": [
    {
      "id": "p-…", "at": "…", "kind": "create|update|merge|archive",
      "scope": "global", "name": "relay-no-proxy",
      "before": "原文本或 null", "after": "新文本或 null",
      "reason": "为什么提议", "proposedBy": "model|consolidate",
      "runId": "run-…",
      "archive": [ { "scope": "global", "name": "被合并掉的条目" } ]
    }
  ],
  "total": 1
}
```

`archive` 只在合并提议里出现；批准时后端会一并归档这些条目。

## POST `/inbox/:id`

请求 `{ decision: "approve" | "reject" }` → `{ ok: true, applied: true|false, id: "p-…" }`。
`approve` 会把 `after` 落盘（`kind: "archive"` 时归档），并写 actor=user 的日志；
`reject` 只删除提议。非法 decision → 400；提议不存在 → 404。

## GET `/settings`

```json
{
  "ok": true,
  "settings": {
    "enabled": true, "deepFrequency": "daily", "deepTime": "03:30", "idleMinutes": 30,
    "model": null, "maxLlmCalls": 30, "sessionIdleHours": 6,
    "inboxReview": "ai", "inboxReviewMinConfidence": 0.7, "inboxReviewMax": 20,
    "lastLight": "…", "lastDeep": "…", "lastRun": { "…": "运行摘要" }, "lastError": null
  },
  "nextRun": "2026-10-21T03:30:00.000Z"
}
```

## POST `/settings`

请求可以是 `{ "settings": { … } }` 或直接扁平对象。**只接受**：
`enabled`、`deepFrequency`（`daily|weekly|off`）、`deepTime`（`HH:MM`）、`idleMinutes`、
`model`（`{provider, model}` 或 null）、`maxLlmCalls`（每次续跑尝试的上限）、`sessionIdleHours`、
`inboxReview`（`ai|user`）、`inboxReviewMinConfidence`（0.5–1）、`inboxReviewMax`（1–100）。
`lastRun`/`lastLight`/`lastDeep`/`lastError` 由后端维护，客户端传了也会被忽略。
返回同 GET。

## POST `/run`

请求 `{ mode: "light" | "deep" }`。

- `light`：同步跑完再返回 `{ ok, runId, mode: "light", run: {…status:"done"…} }`。
- `deep`：**立刻**返回 `{ ok, runId, mode: "deep", run: {…status:"running"…} }`；用 `GET /run/:id` 轮询。

运行记录（`run`）形状：

```json
{
  "id": "run-…", "mode": "light|deep",
  "status": "running|paused|done|error|canceled",
  "reason": "manual|scheduled|resume|deep:initial|…",
  "startedAt": "…", "finishedAt": "…|null",
  "error": "…|null",
  "phase": "light|merge|retag|stale|promote|final-light",
  "cursor": { "processedPairs": ["scope|a|b"], "lastPairIndex": 0 },
  "progress": { "total": 7, "done": 3, "llmCalls": 2, "merged": 1, "retagged": 0, "stale": 0, "promoted": 2, "proposals": 2 },
  "scopes": [ { "scope": "global", "total": 4, "hot": 3, "cold": 1, "topics": 2, "usedChars": 233, "budgetChars": 6000, "pinnedOverBudget": false } ],
  "log": [ { "at": "…", "phase": "merge", "message": "已合并 …" } ],
  "llmUnavailable": "…（只有模型不可用时才出现）"
}
```

- `paused` 表示被「有会话在跑」或「LLM 调用达到上限」抢占；空闲/下一次调度会用**同一个 runId 续跑**。
- `error` 也可能出现在 `paused` 之外的失败（锁冲突、写盘失败等）。

## GET `/run/:id`

`{ ok, run }`；不存在 404。

## GET `/runs`（**§9 之外新增**）

`{ ok, runs: [run…], total }`，按 `startedAt` 倒序，最多 20 条。设置页「最近 10 次运行记录」用它，
避免为每条 id 单独请求。DESIGN.md §9 没有这个端点，但 §10.4 的界面需要它；没有改动既有契约。

## GET `/graph?scope=`

完全按 §11.1 的节点/边字段返回，**额外**带 `hiddenCold`（>300 节点时默认隐藏的冷条目数）、
`totalNodes`、`generatedAt`：

```json
{
  "ok": true,
  "nodes": [
    { "id": "global/relay-no-proxy", "kind": "item", "label": "访问 relay 必须设 NO_PROXY",
      "name": "relay-no-proxy", "type": "feedback", "scope": "global", "tier": "hot",
      "heat": 7, "pinned": true, "stale": false,
      "description": "访问 relay 必须设 NO_PROXY", "tags": ["dsh"] },
    { "id": "tag:dsh", "kind": "tag", "label": "dsh", "count": 14 }
  ],
  "edges": [
    { "source": "global/relay-no-proxy", "target": "tag:dsh", "kind": "tag" },
    { "source": "global/a", "target": "global/b", "kind": "link" },
    { "source": "global/a", "target": "global/b", "kind": "coread", "weight": 3 }
  ],
  "hiddenCold": 0,
  "totalNodes": 16,
  "generatedAt": "…"
}
```

节点 id 规则：条目 `scope/name`，标签 `tag:<tag>`。`label` 对条目取 description（空则 name），
对标签取标签原文。`coread` 边要求两条记忆在 ≥2 个相同会话里都被读过，`weight` = 共同会话数，
每个节点最多 5 条。

## GET `/sessions`

```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "session-…", "workspace": "--home-u-ds-work--",
      "notes": [ { "id": "n1", "text": "不要动 prod", "kind": "constraint", "at": "…" } ],
      "promoted": ["n1"],
      "mtime": 1792503962608.21
    }
  ],
  "total": 1
}
```

只读。`kind` 是 `constraint` / `decision` / `fact` / `todo`。

---

## 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid-name` / `invalid-scope` / `invalid-session-id` / `invalid-id` / `invalid-path` / `invalid-type` / `invalid-tags` / `invalid-description` / `invalid-links` / `invalid-item` / `invalid-query` / `invalid-kind` / `invalid-note` / `bad-request` | 参数不合法 |
| 403 | `forbidden` | POST 非同源 |
| 404 | `not-found` / `journal-not-found` / `note-not-found` | 目标不存在 |
| 405 | —（带 `Allow` 头） | 方法不允许 |
| 409 | `locked` / `notes-full` | 整理锁被占；会话笔记超过 4000 字符 |
| 413 | `payload-too-large` | 请求体超过 256 KB |
| 422 | `secret-detected` / `body-too-large` | 命中密钥模式 / 正文超过 8 KB |
| 500 | `internal` | 其它异常 |

## 与 DESIGN.md 的差异/补充（逐条）

1. **新增 `GET /runs`**（理由见上）。§9 原有端点路径/参数/语义未改。
2. **成功响应统一带 `ok: true`**。§9 只说了错误形状；带 `ok` 是为了和既有插件的面板习惯一致。
3. **`GET /items` 的 `tier=archived`**：§9 的 `tier` 过滤需要能列出归档区（设置页要恢复），
   归档行用 `tier: "archived"` 表示。
4. **`POST /run` 的 light 同步、deep 异步**：深整理可能调 LLM 几十秒，不能阻塞 HTTP 请求。
5. **`GET /journal` 的 `total` 是返回条数**（全库总数会随日志无限增长，意义不大）。
6. **`nextRun`** 是「下一次计划时间」（未来）；`GET /overview` 的 `schedule.nextRun` 同一个值。
7. **会话笔记晋升的 `source`** 写成 `session-<sessionId>`（如果 sessionId 已带 `session-` 前缀会重复一次，
   仅影响条目 frontmatter 的来源字段，不影响功能）。
8. **GET 端点不做同源校验**（和既有插件的面板端点一致）；写端点做同源校验。
   服务只监听回环地址；如果部署把 DSH 暴露到网络，请在反向代理层限制 `/memory/api`。
9. 额外的磁盘文件：`runs.json`（运行记录）、`.lock`（整理锁）。§3.1 的目录清单没有列它们。
10. **路径安全**：`scope` 里的工作区 key 排除 `.` / `..`；`name` 走条目名白名单；`inbox/:id`
    走 id 白名单；底层路径函数还会断言 `path.relative(home, 结果)` 不越界。任何
    `workspaces/..`、`workspaces/../../etc`、`workspaces/a/b`、URL 编码形式
    (`workspaces/%2e%2e`) 都返回 400（`invalid-scope` / `invalid-id` / `bad-request`），
    不会读/写 home 之外的文件。
