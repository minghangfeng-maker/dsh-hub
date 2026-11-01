# @xdedmi/dsh-session-id

给每个 DSH 会话生成一个**稳定的会话 ID**，并让**每一次模型请求**都带着它 —— 不区分模型与上游
（不做任何 provider / host / baseURL 匹配）。用于上游网关的「会话亲和」：同一个对话的多轮请求
落到同一个后端会话上。

零第三方依赖（只用 Node 内置模块），不访问任何外部服务，只在出站模型请求上加请求头。

## 安装

1. 打成一个 npm 包：

   ```bash
   npm pack . --pack-destination dist --ignore-scripts
   ```

2. 装进 DSH profile（三选一）：
   - **Hub 管理台**：插件库 → 添加插件 → 上传上一步的 `.tgz`，再下发给用户；
   - **命令行**：`dsh plugin --profile <profile> add ./dist/xdedmi-dsh-session-id-1.0.0.tgz`；
   - **本地开发**：profile 的 `package.json` 里加
     `"@xdedmi/dsh-session-id": "link:/path/to/dsh-session-id"`，并把包名加进 `dsh.profile.bundles`。

3. 重启 DSH 生效（插件用 `llm/stream` 瀑布监听 + 包装 `globalThis.fetch`，属于挂载期生效的东西）。

> 包名保持 `@xdedmi/dsh-session-id`：Hub 插件库与桌面随包清单按包名识别插件，改名会断升级路径。

## 它是怎么工作的

1. **`llm/stream` 瀑布监听**（DSH 官方提供的 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage`
   绑定到它的会话 id。没有 `sessionId` 的请求（手工构造的一次性调用）直接放行，不做任何模型/上游猜测。
2. **包装 `globalThis.fetch`**：会话作用域内的每次 fetch（适配器 HTTP 请求、重定向、重试）都注入会话头。
   包装器不读不写请求体，不改 URL / method / signal；卸载时恢复原来的 fetch（若期间有别的包装器接管，
   则不去覆盖它）。
3. **无上游判定**：只要请求发生在某个会话的模型调用期间，就带头部；否则原样通过。

默认注入 4 个头（与 opencode 自身发射的一组一致，多出的几个对常见网关无害）：

```
x-opencode-session / x-session-affinity / x-client-request-id / x-session-id
```

## wire 值格式

令牌是 opencode 风格（固定前缀 + nanoid 随机段），但这里的随机段是**确定性**的：把 DSH 的会话 uuid
做 SHA-256，按 62 字符字母表走 6-bit 分组取 21 个字符，加 `ses_` 前缀。

```
session-e820d21d-1667-4f46-874f-11fd7f10abbe
  → ses_gQ7kKRrGZK1foF4Ibwmts
```

确定性意味着同一会话跨请求、跨进程重启、跨 compaction 拿到同一个令牌 —— 这正是上游会话亲和需要的性质。
想直接发原始 DSH 会话 id（不做哈希）就把 `rawSessionId` 打开。

## 配置（全部可选；默认值见下）

> 用户层补丁会**整体替换** `config` 块（非深合并），自定义时把用到的键写全。

```yaml
- id: dsh-session-id
  name: '@xdedmi/dsh-session-id'
  config:
    headers: [x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]
    prefix: ses_            # wire 令牌的固定前缀；"" 则不带
    length: 21              # nanoid 段长度（4–64）
    alphabet: alphanumeric  # 或 urlsafe（nanoid 的 64 字符表，含 - _）
    rawSessionId: false     # true 则直接发原始 DSH 会话 id，不做哈希
    extraHeaders: {}        # 额外静态头，例如 { x-opencode-client: native }
    verbose: false          # 调试日志：每次作用域绑定与注入
```

## 注意

- **隐私**：令牌会随每次模型请求发给上游（这是它的用途）。它是对会话 uuid 的确定性哈希，不含对话内容，
  但同一会话在上游侧是可关联的；不想被关联就别装它，或把 `headers` 收窄到只留一个。
- **全局 fetch 包装**：插件挂载期间所有会话作用域内的 fetch 都会被加头（包括重定向与重试）；
  不在任何会话作用域内的请求不受影响。卸载时恢复原 fetch。
- 只加请求头，不改请求体、URL、method、signal 或响应。

## 测试

```bash
node --check index.js
node test/session-id.test.mjs    # 12 项：令牌衍生格式、归一化、注入、清理
node test/e2e-apply.test.mjs     # 端到端：两个并发会话各自带自己的头
```

两个脚本都用假的 ctx / 假 fetch，不需要 DSH 运行、不联网。

## 许可

Apache-2.0。
