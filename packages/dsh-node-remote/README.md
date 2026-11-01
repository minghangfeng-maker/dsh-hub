# @dsh-hub/dsh-node-remote

DSH Host 的薄 adapter：把 `dsh-hub-mobile-v1` 帧翻译成 Host 的真实端点。

- **一元调用**：`POST /api/<endpoint>`（`session/list|create|prompt|cancel|page`、`userQuestions/answer`、`$events/result`）
- **流**：`/api/remote.mux`（`session/follow`、`session/control`、`$events`）
- 历史游标：`throughSeq` 取自同一次 `session/follow` 的 `snapshot.cursor`
- 审批：owner `$events` waterfall → `approval` 帧；`answer-approval` → `$events/result`；
  120s 无人应答发 `{kind:'next'}`（绝不自动批准）；断线不是撤销
- 能力探测：只发已知非法载荷（Host 在业务调用前拒绝），并真的打开 `session/follow` 与 `$events`

## 用法（Node ≥ 20）

```ts
import { createNodeRemote } from '@dsh-hub/dsh-node-remote'

const remote = await createNodeRemote({
  origin: 'http://127.0.0.1:3000',
  // 桌面：本机 Host 的合法 cookie（M3 用 ctx.connection.authenticatedUrl()/authorizeIndex 取得）
  headers: async () => ({ cookie, host: '127.0.0.1:3000' }),
  node: { id: 'dv_…', kind: 'desktop', name: '我的 Windows', status: 'host-running' },
})
await remote.dispatch(frame, (out) => channel.send(out))
```

### readiness 探测（无手机时用这个）

```ts
import { probeNodeRemote } from '@dsh-hub/dsh-node-remote'
const { compatible, capabilities, missing } = await probeNodeRemote({ origin, headers, node })
```

`probeNodeRemote` **只**发非法载荷的 unary + 打开一次 `session/follow`；**绝不打开 `$events`**
（那是 answering peer，会让 Host 认为有手机在线）。所以它不会点亮 `hasLiveClient`，也不会收到
无人应答的 waterfall。列表/桌面开关的 readiness 都用它。

`createNodeRemote` 只用它做兼容性判断；`capabilities.approvals` 在创建时恒为 `false`，
只有真实通道 `hello`/订阅后成功打开 `$events` 拿到 `ready` 才置 `true`，并额外推一帧
`{type:'capability', capabilities}` 通知客户端。**不要因为 `approvals:false` 拒绝基本连接。**

## 依赖与许可

- 运行依赖：`ws@^8`（MIT）。
- 本包：MIT，见 `LICENSE`。桌面端打包可 bundle `ws` 或按普通 npm 依赖安装；
  「可移植」不等于「零依赖」，不要依赖偶然的传递依赖。
- 版本随 `package.json`；协议版本是 `dsh-hub-mobile-v1`。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)：0.2.2 相对 0.2.1 增加 `session-state`、`parkInteractions` 暂存模式、
默认工作区建会话与 `session/list` 运行态，均向后兼容。
