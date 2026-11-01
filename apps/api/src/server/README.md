# `src/server/` —— 监听器、TLS 网关与静态托管

阶段一（WP7a）只有明文 HTTP 监听器（127.0.0.1:`HUB_HTTP_PORT`）；
阶段二（WP7b）补上 7443 TLS 网关、PROXY protocol 与「公网 / 本机」分流。

| 文件                | 归属     | 内容                                                                                                                                                                                                                                                       |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static.ts`         | **WP7a** | 托管 `apps/web/dist`；`/assets/*` → `immutable` 一年；其它 GET → SPA `index.html`（`Cache-Control: no-cache`，04 §6）；Hub 自身页面加 nosniff/Referrer-Policy/CSP（`/dsh/*`、`/u/*` 不加）                                                                   |
| `listeners.ts`      | **WP7b** | 明文监听器（只绑 `127.0.0.1`）+ `startTlsGateway()`（7443：PROXY v1 → 真实 IP；首字节 `0x16` → https server；像 HTTP 方法 → 同端口 301；其它断开；WS 升级转给 `app.server`）+ `startRedirect()`（`HUB_REDIRECT_PORT` 已废弃，设了非 0 直接报错，见 08 §3） |
| `tls.ts`            | **WP7b** | 证书加载与热更新：`secrets/tls/{fullchain,privkey}.pem`（acme.sh 装的）→ 没有就用系统 openssl 生成 30 天自签；每 60 秒看 mtime + `SIGHUP` 时 `setSecureContext()` 热换；key/cert 不匹配保留旧证书；剩余 < 14 天每天 warn；TLS 最低 1.2                     |
| `proxy-protocol.ts` | **WP7b** | PROXY v1 解析（`TCP4`/`TCP6`/`UNKNOWN`，最长 107 字节，3 秒超时）；头后面的剩余字节 `unshift` 回流里，交给 TLS                                                                                                                                             |
| `public-request.ts` | **WP7b** | 「公网请求」标记（socket 上的 Symbol）与 `isPublicRequest(req)`、HSTS 头值。只有经 7443 的连接带标记，7700 永远不带                                                                                                                                        |

约定：

- 监听器只绑回环（`127.0.0.1`）；公网入口是「公网入口的四层代理 → frp QUIC 隧道 → 本机 7443」（01 §2）。
- 只有 7443 信任 PROXY v1 头；7700 直接用 socket 地址（`trustProxy: false`，任何 `X-Forwarded-*` 都不信）。
- 公网 / 本机分流（02 §5、04 §0 第 11 条）：CSRF Origin、按 IP 限流的回环豁免、会话 cookie 的 `Secure`、
  HSTS、转给用户 DSH 的 `x-forwarded-proto` 与注入的返回链接，全部看 `isPublicRequest()`。
- TLS 网关用**独立 https server** 复用同一个 Fastify 实例的请求分发（`app.routing`，内部会先
  `await app.ready()`——avvio 在 preReady 之后才准备好路由 context 的生命周期 hook）；
  不能再次 `app.listen()`。
- 静态托管与 SPA 兜底必须让 `/api/*`、`/dsh/*`、`/u/*` 优先走业务路由（04 §6、WP16 改地址）；`/ca.crt` 路由保留但恒 404
  （阶段二用 Let's Encrypt，没有自签根证书要装，`/api/public/site` 的 `caCertUrl` 恒为 null）。
