# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

**请不要开公开 issue**，也不要在 pull request / 讨论区里贴漏洞细节。

请通过本仓库 Security 页的 **「Report a vulnerability」** 私下提交
（GitHub Private vulnerability reporting）：

> `https://github.com/minghangfeng-maker/dsh-hub/security/advisories/new`

<!-- 发布前把上面的 minghangfeng-maker/dsh-hub 换成真实仓库地址（本仓库地址尚未最终确定）。 -->

请写清：受影响的版本或提交、复现步骤、影响范围，以及你希望的披露时间。
**我们会在 7 天内给出首次回复**；修复发布后通过 GitHub Security Advisory 公开，
并在公告里致谢报告人（除非你要求匿名）。

（本仓库是可自托管的开源项目，没有赏金计划。）

> Please **do not** open a public issue for security problems. Use the repository's
> **Security → Report a vulnerability** page (GitHub Private vulnerability reporting) instead.
> We will reply within **7 days**, and publish a GitHub Security Advisory after the fix ships,
> crediting the reporter unless anonymity is requested. No bug bounty.

## 支持范围 / Supported versions

只对**最新发布的版本**（以及 `main` 上的最新提交）提供安全修复；自己 fork 出来的改动请自行评估。

Only the latest release (and the tip of `main`) receives security fixes.

## 哪些属于安全问题 / What counts as a security issue

- **鉴权与越权**：绕过登录 / CSRF / 角色检查，普通用户拿到管理员能力。
- **跨用户隔离**：访问、修改或窥探别人的实例、文件、会话、用量与计费数据。
- **容器逃逸与宿主风险**：从用户容器逃到宿主、读云元数据、绕过 `deploy/nft` 出网规则、
  拿到 docker.sock。
- **密钥与凭据泄露**：主密钥、cookie 签名密钥、上游渠道 key、用户设备令牌被读出或被打进日志。
- **插件安装链路**：绕过插件的密钥扫描 / 路径校验 / 体积限制，往容器里塞任意代码。
- **反向代理与静态托管**：`/u/*`、`/dsh/*`、`/m/*` 的路径穿越、CSP 绕过、任意文件读取。
- **依赖与供应链**：我们分发的构建产物、容器镜像、npm 包被投毒。

不属于：需要物理接触设备的问题、自托管部署方自己的配置错误（但欢迎在 issue 里讨论加固），
以及未授权测试造成的破坏。

## 部署方的加固清单

DSH Hub 会代表用户跑容器、代理请求、签发 cookie，默认配置已经考虑隔离，但下面这些只有部署方能定：

- **出网防火墙**：务必装 `deploy/nft/install.sh`。没有它，用户容器能访问宿主、内网与云元数据地址。
- **不要以 root 运行 Hub**：systemd 用户单元即可；Docker 权限由 docker 组给，不要用 `sudo` 起 Hub。
- **对外一定要有 TLS**：`HUB_TLS_PORT`（Hub 自己终结）或 `HUB_EDGE_PORT`（前置代理终结），二选一；
  改完确认 cookie 带 `Secure`、HSTS 符合预期。
- **改掉默认标识**：安卓包名 `tech.dshhub.app`、站点名、`@dshhub/*` 作用域在 fork 后应换成你自己的。
- **密钥与配置**：`~/.config/dsh-hub/hub.env`、`acme.env` 权限 0600；`HUB_DATA_DIR` 不要放在仓库里；
  主密钥（`secrets/`）丢了等于所有加密字段失效，备份要跟上（`scripts/backup.sh`）。
- **保持依赖更新**：`pnpm audit`、定期升级 Node 24 小版本与基础镜像。

## 已知的信任边界

- 用户容器里的 DSH 是**半信任**的：它由用户驱动，可以执行命令。容器隔离（只读根、不给
  docker.sock、cap-drop、独立网络、出网防火墙、资源配额）是唯一边界，不要把它当成"用户不能搞事"。
- 管理员可以下发插件、改配置、看审计；管理员账号一律建议开启强密码并在必要时重置。
- AI 助手（座舱）用管理员身份调用 Hub 能力，写操作会出方案卡要二次确认；不要给它开通不需要的能力。
