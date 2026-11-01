# @dshhub/ops —— 座舱 DSH 的管理插件

Hub 的「管理座舱」（`docs/24`）中间那半条：管理员在 `/admin` 里跟 DSH 说话，DSH 通过本插件
查 Hub 的能力、提方案、出画布、要密钥。

本包**随 Hub 版本发布**（仓库 `runtime/plugins/dshhub-ops/`），只装在座舱容器（`dshhub-ops`，
系统账号 `hub-ops`）里：

- **不进插件库**：`plugins` 表里没有它，普通用户在「插件库/我的插件」里看不到、也下发不到；
- **由 Hub 在启动座舱容器前同步 + 安装**（`apps/api/src/modules/cockpit/ops-instance.ts`）：
  同步到容器内 `/home/dsh/ops-plugin`，再跑官方命令
  `dsh plugin --profile web add file:/home/dsh/ops-plugin`，版本变了就重装一次。

## 工具（`docs/24` §5）

| 工具                                                                       | 作用                                                    | 风险                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| `ops_find(query, area?)`                                                   | 检索能力目录（id / 风险 / 中文说明 / 参数 JSON Schema） | 只读                 |
| `ops_call({capability,args,title?,rationale?} \| {steps,title,rationale})` | 调能力：R0 直接给数据，R1/R2/R3 出方案卡                | 由能力的 `risk` 决定 |
| `ops_wait(proposalId, waitSec≤60)`                                         | 长轮询方案结果                                          | 只读                 |
| `canvas_show({title,spec})`                                                | 在右侧画布出一张卡                                      | 只读                 |
| `canvas_update(id,{title?,spec?})`                                         | 改本会话里 DSH 出的卡                                   | 只读                 |
| `secret_request({purpose,capability,field})`                               | 发一张密钥输入卡（值不经过对话）                        | 只读                 |

**`sessionId` 由插件自己取**，不让模型填：`exec.agent.session.id`
（DSH 源码 `packages/core/tools/src/index.ts:340` → `packages/core/agent/src/runtime-types.ts:168`
→ `packages/core/session/src/index.ts:546`）。模型参数里出现 `sessionId` 会被丢弃，见
`test/tools.test.js`。

## 守则注入（`guard.js`）

每个**回合**（`agent/pre-step` 的 `step === 0`）注入一条 ≤ 1500 字的「座舱守则」，
并带上 `/ops/context` 的一行摘要（Hub 版本、今天、R1 自动执行策略、各域数量）。
`/ops/context` 拿不到时只注入规则，不挡对话。

## 配置

| 项             | 来源               | 说明                                                                  |
| -------------- | ------------------ | --------------------------------------------------------------------- |
| `url`          | `DSHHUB_OPS_URL`   | Hub 内部监听器的 `/ops` 基地址，Hub 注入 `http://10.213.0.1:7710/ops` |
| `token`        | `DSHHUB_OPS_TOKEN` | 座舱令牌，**每次启动座舱容器重新生成**，旧令牌立即作废                |
| `timeoutMs`    | `cordis.patch.yml` | 单次 `/ops` 请求超时，默认 20 s                                       |
| `contextTtlMs` | `cordis.patch.yml` | `/ops/context` 缓存，默认 30 s                                        |

**令牌不写进任何 profile 文件**：只在容器环境变量里。容器里没有别的 Hub 机密；
令牌只够读（已脱敏）和提方案，执行永远发生在管理员浏览器会话里（`docs/24` §0/§7）。

## 开发

```bash
cd runtime/plugins/dshhub-ops
node --test --test-concurrency=1 test/*.test.js   # 或 pnpm test（在仓库根 pnpm -r test 里也会跑）
```

工具单测会起一个假的 `/ops` 服务（`127.0.0.1:8274`，WP56b 分配端口），断言路径、Bearer、
`sessionId` 来源与「方案卡不等于已完成」的措辞。
