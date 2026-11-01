# 部署与运维

面向**单机**部署：一台装好 Docker 的 Linux 机器，一个 systemd 用户服务跑 `hub-api`，前面可选一层反向
代理做 TLS；Hub 主机不在公网时，再在前面加一段隧道或云厂商负载均衡（§4.4）。对外端口按需选：标准 **443**，
或者任意非标准端口（例如 `8443`）。示例里的域名一律用 `hub.example.com` / `edge.example.com`、IP 用
`203.0.113.10`（TEST-NET-3，永远不是真实地址），照抄时换成你自己的。

```
用户 ──TLS──▶ 反向代理（nginx / HAProxy / Caddy，二选一）
                ├─ 四层透传（send-proxy）──▶ 127.0.0.1:7443  Hub TLS 网关
                └─ 七层终结（X-Real-IP）  ──▶ 127.0.0.1:7720  Hub 边缘入口（HUB_EDGE_PORT）
                                                   │
                                          127.0.0.1:7700  hub-api（本机明文）
```

两种接法二选一即可：

- **四层透传 + Hub 自己终结 TLS**：代理只转发字节并加 `PROXY v1` 头，Hub 用 `HUB_TLS_PORT=7443` +
  `HUB_PROXY_PROTOCOL=true` 自己握 TLS、自己从 PROXY 头取真实 IP，证书热加载也由 Hub 负责。
- **七层终结 + Hub 边缘入口**：代理自己终结 TLS，把真实 IP 写进 `X-Real-IP`，明文转发到
  `HUB_EDGE_PORT`。Hub 只信这个头，并把 `HUB_EDGE_ORIGIN` 当作对外身份。

## 目录与约定

| 路径 | 说明 |
| --- | --- |
| `~/dsh-hub-prod` | 生产目录（仓库的一个检出或 `git worktree`） |
| `/srv/dsh-hub` | 数据目录 `HUB_DATA_DIR`：`hub.db`、`secrets/`、`users/<slug>/`、镜像构建上下文 |
| `~/.config/dsh-hub/hub.env` | 站点配置（0600，**不进仓库**），样例见 `deploy/hub.env.example` |
| `~/.config/dsh-hub/acme.env` | acme.sh 的 DNS 凭据（0600，**不进仓库**），样例见 `deploy/tls/acme.env.example` |
| `/mnt/backup/dsh-hub` | 备份目标 `HUB_BACKUP_DIR`（**异盘**，别和数据库同盘） |

服务是 **systemd 用户单元**（`systemctl --user`）：Hub 不需要 root，Docker 权限由 docker 组给。
要让用户单元在未登录时也存活，执行一次 `loginctl enable-linger "$USER"`。

## 1. 前置检查

```bash
deploy/prereq.sh          # 只读：Docker、Node、端口、目录、docker 组权限逐项报 OK/缺失
```

缺什么它会打印「应执行」的命令；脚本本身不改系统。

## 2. 出网防火墙（强烈建议）

用户容器跑在独立网络 `dshhub-users` 里，必须限制它们能访问哪里（宿主、内网、云元数据地址都不能碰）：

```bash
sudo deploy/nft/install.sh --print   # 先看要装什么
sudo deploy/nft/install.sh           # 装成系统服务 dshhub-egress.service，开机自动恢复
```

规则在 `deploy/nft/dshhub.nft`：只匹配 `HUB_USERS_SUBNET`（默认 `10.213.0.0/16`），禁止容器访问宿主、
私网段与保留段，只放行「容器 → Hub 中转站内部监听器」这一个口子。改网段要同步改这个文件与
`HUB_USERS_SUBNET`。

## 3. 起服务

```bash
# 1) 生产目录与依赖
git clone <你的仓库> ~/dsh-hub-prod && cd ~/dsh-hub-prod
pnpm install && pnpm -r build

# 2) 站点配置（0600，不进仓库）
mkdir -p ~/.config/dsh-hub && cp deploy/hub.env.example ~/.config/dsh-hub/hub.env
chmod 600 ~/.config/dsh-hub/hub.env && $EDITOR ~/.config/dsh-hub/hub.env

# 3) 数据库与管理员
node apps/api/dist/cli.js migrate
node apps/api/dist/cli.js create-admin --username admin   # 会提示输入密码

# 4) 用户单元
ln -sf ~/dsh-hub-prod/deploy/systemd/dsh-hub.service ~/.config/systemd/user/dsh-hub.service
systemctl --user daemon-reload && systemctl --user enable --now dsh-hub
loginctl enable-linger "$USER"
```

起完先在本机核对：

```bash
curl -s http://127.0.0.1:7700/api/health | jq
# {"ok":true,"version":"…","db":"ok","docker":"ok", …}   docker 在无 Docker 模式下是 "fake"
node apps/api/dist/cli.js doctor      # 逐项自检：配置、数据目录、数据库、Docker、网络、nft、证书
```

`hub.env` 里至少要有 `HUB_DATA_DIR`、`HUB_PUBLIC_ORIGIN`（对外 origin，CSRF 白名单与返回链接都用它），
以及你选的入口那几项（`HUB_TLS_PORT` 或 `HUB_EDGE_PORT`）。全部变量见仓库根 README 的「配置」一节。

## 4. 反向代理与 TLS

### 4.1 四层透传（Hub 自己终结 TLS）

Hub 开 `HUB_TLS_PORT=7443`、`HUB_PROXY_PROTOCOL=true`，代理把 `PROXY v1` 头加上：

```nginx
# nginx.conf（stream 模块）
stream {
  upstream hub_tls { server 127.0.0.1:7443; }
  server {
    listen 443;
    proxy_pass hub_tls;
    proxy_protocol on;          # 关键：加 PROXY v1 头，Hub 从它取真实 IP
    proxy_timeout 1h;
  }
}
```

HAProxy 等价配置：`bind :443`、`mode tcp`、`server hub 127.0.0.1:7443 send-proxy`。

证书由 Hub 自己加载：`HUB_DATA_DIR/secrets/tls/{fullchain,privkey}.pem`。没有证书时 Hub 会生成一张临时
自签证书兜底（浏览器会警告），签好正式证书后不用重启，`systemctl --user kill -s HUP dsh-hub` 即可热换。

### 4.2 七层终结（Hub 边缘入口）

代理终结 TLS，把真实 IP 写进 `X-Real-IP`，明文转发到 `127.0.0.1:7720`（`HUB_EDGE_PORT=7720`）：

```nginx
server {
  listen 443 ssl http2;
  server_name hub.example.com;
  ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

  client_max_body_size 200m;
  proxy_read_timeout 1h;

  location / {
    proxy_pass http://127.0.0.1:7720;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;      # Hub 只信这个头
    proxy_set_header Upgrade $http_upgrade;       # 手机通道与会话都是 WebSocket
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
  }
}
```

对应 `hub.env`：`HUB_EDGE_PORT=7720`、`HUB_EDGE_ORIGIN=https://edge.example.com`（必须是 https；
边缘入口只认自己的 origin，不认 `HUB_PUBLIC_ORIGIN`）。

### 4.3 证书（acme.sh + DNS-01）

```bash
cp deploy/tls/acme.env.example ~/.config/dsh-hub/acme.env && chmod 600 ~/.config/dsh-hub/acme.env
$EDITOR ~/.config/dsh-hub/acme.env            # HUB_HOST / ACME_DNS / DNS 凭据
deploy/tls/issue-cert.sh --staging            # 先 dry-run，看要执行的 acme.sh 命令
deploy/tls/issue-cert.sh --apply              # 正式签发 + 装证书 + 装续期 timer
systemctl --user list-timers dsh-hub-cert.timer
```

DNS-01 不需要 80/443 端口；凭据只经环境变量交给 acme.sh，不落日志。续期由 `dsh-hub-cert.timer` 每天跑
一次 `acme.sh --cron`，续期后自动给 Hub 发 `SIGHUP` 热换证书。

### 4.4 跨机入口：隧道 / 云厂商负载均衡（可选）

Hub 主机不在公网、或不想直接在它上面开端口时，让 Hub 主机主动拨出去就行，公网入口那台机器只搬加密字节：

| 做法 | Hub 主机侧 | 入口侧 |
| --- | --- | --- |
| 反向隧道（frp、`ssh -R` 等，任选） | 跑隧道客户端把 `127.0.0.1:7443` 暴露出去；装成 systemd 用户服务，断线自动重连 | 跑隧道服务端，落地端口只绑 `127.0.0.1`，再由 §4.1 的 nginx/HAProxy 接 443（或所选端口） |
| 云厂商负载均衡 / 专线 | 把 `7443` 注册成后端（要带 PROXY v1 头才走 §4.1，否则用 §4.2 的七层接法） | 监听 443，转发到后端；证书可以在负载均衡上终结，也可以透传 |

要点：入口机器上不留证书私钥、账号与数据（02 T9）；TLS 仍在 Hub 主机终止（或由负载均衡终结后走 §4.2）。
对外端口可以就是 443，也可以是任意端口（记得同步改 `HUB_PUBLIC_ORIGIN`）。验收见
[`../docs/design/10-验收标准.md`](../docs/design/10-验收标准.md) 的 F 组。

## 5. 升级与回滚

```bash
cd ~/dsh-hub-prod
deploy/upgrade.sh            # 拉最新 release → 安装依赖 → 构建 → 迁移 → 重启 → 健康检查
```

健康检查失败会自动回退到升级前的提交并重启旧版本；也可以指定版本：

```bash
HUB_UPGRADE_REF=<tag-or-commit> deploy/upgrade.sh
HUB_SKIP_INSTALL=1 deploy/upgrade.sh      # 依赖没变时跳过 pnpm install
```

回滚点就是 git：`git -C ~/dsh-hub-prod log --oneline`，切回去再跑一次 `deploy/upgrade.sh` 即可（数据库
迁移向前兼容，回滚代码不用回滚库；真要回滚库见下一节）。

## 6. 备份与恢复

```bash
scripts/backup.sh                      # db + secrets + 工作区增量
scripts/backup.sh --dry-run            # 只看要做什么
scripts/restore-db.sh --list           # 列出可用备份
scripts/restore-db.sh --latest --yes   # 停服 → 留档 → 换库 → 起服 → 完整性检查
```

默认由 `deploy/systemd/dsh-hub-backup.timer` 每天 03:30 触发（`dsh-hub-backup.service`）。
`HUB_BACKUP_DIR` 必须指向**另一块盘**；db 用 `VACUUM INTO` 做一致快照，工作区是按 tar 链的增量。
恢复前先看 `scripts/restore-db.sh --help`：它会把现有库改名留档，失败时给你回滚命令。

## 7. 日常自检

| 命令 | 用途 |
| --- | --- |
| `curl -s 127.0.0.1:7700/api/health` | 存活 + 依赖状态（db / docker / listeners） |
| `node apps/api/dist/cli.js doctor` | 配置、目录、库、Docker、网络、nft、证书逐项检查 |
| `node apps/api/dist/cli.js tls:info` | 证书来源、SAN、签发者、到期天数 |
| `node apps/api/dist/cli.js db:backup` | 只做一次数据库快照（备份脚本调它） |
| `node apps/api/dist/cli.js instance:stop-all` | 停掉所有用户容器（维护窗口用） |
| `scripts/security-gate.sh` | 安全闸门：容器隔离、出网规则、权限与密钥的端到端检查（会起临时容器） |
| `systemctl --user status dsh-hub`、`journalctl --user -u dsh-hub -f` | 服务状态与日志 |

## 8. 常见问题

- **`/api/health` 里 `docker` 是 `error`**：当前用户不在 `docker` 组，或 `DOCKER_HOST` 指错。
  没有 Docker 时可以用 `HUB_CONTAINER_DRIVER=fake` 只跑界面与接口（用户容器不会真的启动）。
- **公网登录 403（CSRF）**：`HUB_PUBLIC_ORIGIN` 与实际访问的 origin 不一致（协议、端口都算）；
  边缘入口的请求只认 `HUB_EDGE_ORIGIN`。
- **WebSocket 断**：反向代理要透传 `Upgrade` / `Connection` 并关掉缓冲（见 §4.2）。
- **容器起不来、日志说连不上中转站**：`HUB_RELAY_INTERNAL_PORT`（默认 7710）与 nft 规则里放行的端口
  要一致；用户网络的网关地址由 Docker 决定，Hub 启动时会自己探测。
- **证书没生效**：`tls:info` 看来源；Hub 只在 `secrets/tls/` 下找 `fullchain.pem` + `privkey.pem`。
