#!/usr/bin/env bash
# 用 acme.sh + DNS-01 签发/安装 Hub 的 Let's Encrypt 证书（08 §3）——在 Hub 主机上执行，**默认 dry-run**。
#
#   cp deploy/tls/acme.env.example ~/.config/dsh-hub/acme.env && chmod 600 ~/.config/dsh-hub/acme.env
#   # 填 HUB_HOST / ACME_DNS / 对应凭据
#   deploy/tls/issue-cert.sh --staging              # 先看 dry-run（不联网、不改任何东西）
#   deploy/tls/issue-cert.sh --staging --apply      # 真去 Let's Encrypt staging 签一张试试
#   deploy/tls/issue-cert.sh --apply                # staging 通了再正式签
#
# 做四件事：
#   1. 检查 acme.sh（没有就打印安装命令，含 gitee 镜像）；
#   2. `acme.sh --issue --server letsencrypt --keylength ec-256 --dns $ACME_DNS -d $HUB_HOST`
#      （acme.sh 默认 CA 是 ZeroSSL，必须显式 `--server letsencrypt`）；
#   3. `--install-cert` 装到 $HUB_DATA_DIR/secrets/tls/{fullchain,privkey}.pem，
#       reloadcmd 是 `systemctl --user kill -s HUP dsh-hub.service`（Hub 热换证书，不重启）；
#   4. 安装并 enable dsh-hub-cert.timer（每天跑一次 `acme.sh --cron`，续期后自动 reload）。
#
# 为什么 DNS-01：HTTP-01 要 :80、TLS-ALPN-01 要 :443，而这两个端口通常已被前台的反向代理
# 占用（有的机房还会按域名备案拦 80/443）；DNS-01 只要 DNS 权限（08 §3）。证书与私钥全程只落在
# Hub 主机（02 T9）。
#
# 本脚本不打印任何凭据；走 acme.sh 时凭据只通过环境变量传递，且默认清掉代理变量。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

ACME_ENV="${HUB_ACME_ENV:-$HOME/.config/dsh-hub/acme.env}"
ACME_SH="${ACME_SH:-$HOME/.acme.sh/acme.sh}"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
SYSTEMD_DIR="${HUB_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
SYSTEMCTL="${HUB_SYSTEMCTL:-systemctl --user}"
RELOAD_CMD="${HUB_RELOAD_CMD:-systemctl --user kill -s HUP dsh-hub.service}"

APPLY=0
STAGING=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --staging) STAGING=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf '未知参数：%s（支持 --apply / --dry-run / --staging / --force）\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[issue-cert] %s\n' "$*"; }
die() {
  printf '[issue-cert] 失败：%s\n' "$*" >&2
  exit 1
}

# ── 0. 生产 Hub 必须已经认 SIGHUP ───────────────────────────────────────────
# `--install-cert` 会立刻执行一次 reloadcmd（给 dsh-hub 发 SIGHUP）。不带 TLS 网关的旧版 Hub 没有
# SIGHUP 处理器：Node 收到 SIGHUP 直接退出，而 systemd 把「被 SIGHUP 杀掉」算作正常退出，
# Restart=on-failure 不会拉起，Hub 就停在那里了。所以必须先 deploy/upgrade.sh 升到带 TLS 网关的版本，
# 再签证书（顺序见 deploy/README.md §4.3）。
HUB_PROD_DIR="${HUB_PROD_DIR:-$HOME/dsh-hub-prod}"
if [ ! -f "$HUB_PROD_DIR/apps/api/dist/server/tls.js" ]; then
  die "生产副本 $HUB_PROD_DIR 还是不带 TLS 网关的旧版 Hub（没有 apps/api/dist/server/tls.js）：它收到证书安装时的 SIGHUP 会退出且不会被 systemd 拉起。先 deploy/upgrade.sh 升级，再签证书"
fi

# ── 1. acme.sh ──────────────────────────────────────────────────────────────
if [ ! -x "$ACME_SH" ]; then
  cat >&2 <<'EOF'
[issue-cert] 找不到 acme.sh。安装（--nocron：用 systemd timer 而不是 crond，在 WSL 上部署时同样适用）：
  git clone https://gitee.com/neilpang/acme.sh.git && cd acme.sh && ./acme.sh --install --nocron
国内直连 GitHub 慢，用上面的 gitee 镜像；装完确认 ~/.acme.sh/acme.sh 存在。
EOF
  exit 1
fi

# ── 2. 读 acme.env（只校验键是否齐全，不打印值） ─────────────────────────────
[ -f "$ACME_ENV" ] || die "找不到 $ACME_ENV（从 deploy/tls/acme.env.example 复制并填好）"
# 路径由环境变量给
set -a
# shellcheck source=/dev/null
. "$ACME_ENV"
set +a

HUB_HOST="${HUB_HOST:-}"
ACME_DNS="${ACME_DNS:-}"
DATA_DIR="${HUB_DATA_DIR:-/srv/dsh-hub}"
[ -n "$HUB_HOST" ] || die "$ACME_ENV 里缺 HUB_HOST"
[ -n "$ACME_DNS" ] || die "$ACME_ENV 里缺 ACME_DNS（如 dns_ali / dns_cf / dns_dp / dns_tencent）"

missing=""
require_env() { # require_env <变量名…>
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing="$missing $name"
  done
}
case "$ACME_DNS" in
  dns_ali) require_env Ali_Key Ali_Secret ;;
  dns_cf) require_env CF_Token ;;
  dns_dp) require_env DP_Id DP_Key ;;
  dns_tencent) require_env TencentCloud_SecretId TencentCloud_SecretKey ;;
  *) log "警告：未知的 ACME_DNS=$ACME_DNS，跳过凭据预检（acme.sh 自己会报错）" ;;
esac
[ -z "$missing" ] || die "$ACME_ENV 里缺少 $ACME_DNS 需要的变量：$missing（用只有该域名 DNS 权限的子账号/令牌）"

TLS_DIR="$DATA_DIR/secrets/tls"

log "域名        $HUB_HOST"
log "DNS 插件    $ACME_DNS（凭据来自 $ACME_ENV，不显示）"
log "证书目录    $TLS_DIR/{fullchain,privkey}.pem（私钥 0600）"
log "acme.sh     $ACME_SH（home=$ACME_HOME）"
log "CA          Let's Encrypt$([ "$STAGING" -eq 1 ] && echo '（staging，签出来的证书浏览器不认，仅用于试通）')"
log "reloadcmd   $RELOAD_CMD"

# 清掉代理：acme.sh 默认走直连（不继承 shell 里的全局代理变量）
NO_PROXY_ENV=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy -u NODE_USE_ENV_PROXY)
# acme.env 设了 ACME_PROXY（如 http://proxy.example.com:3128）就只让 acme.sh 走它——
# 国内直连 Let's Encrypt API 时断时续（超时、签发卡在 new-order 报 curl 35）。
ACME_ENV_CMD=("${NO_PROXY_ENV[@]}")
if [ -n "${ACME_PROXY:-}" ]; then ACME_ENV_CMD+=("https_proxy=$ACME_PROXY" "http_proxy=$ACME_PROXY"); fi

# staging 必须换 server：acme.sh 里 `--server letsencrypt` 会盖掉 `--staging`（10-15 实测「staging」跑到了正式 CA）
ACME_SERVER=letsencrypt
if [ "$STAGING" -eq 1 ]; then ACME_SERVER=letsencrypt_test; fi
issue_args=(--issue --server "$ACME_SERVER" --keylength ec-256 --dns "$ACME_DNS" -d "$HUB_HOST" --home "$ACME_HOME")
if [ "$FORCE" -eq 1 ]; then issue_args+=(--force); fi

install_args=(
  --install-cert -d "$HUB_HOST" --ecc --home "$ACME_HOME"
  --key-file "$TLS_DIR/privkey.pem"
  --fullchain-file "$TLS_DIR/fullchain.pem"
  --reloadcmd "$RELOAD_CMD"
)

if [ "$APPLY" -eq 0 ]; then
  printf 'DRY  | %s %s %s\n' "${ACME_ENV_CMD[*]}" "$ACME_SH" "${issue_args[*]}"
  printf 'DRY  | %s %s %s\n' "${ACME_ENV_CMD[*]}" "$ACME_SH" "${install_args[*]}"
  printf 'DRY  | mkdir -p %s && install -m 600 /dev/null %s/privkey.pem\n' "$TLS_DIR" "$TLS_DIR"
  printf 'DRY  | ln -sfn %s %s/dsh-hub-cert.service\n' "$REPO_DIR/deploy/systemd/dsh-hub-cert.service" "$SYSTEMD_DIR"
  printf 'DRY  | ln -sfn %s %s/dsh-hub-cert.timer\n' "$REPO_DIR/deploy/systemd/dsh-hub-cert.timer" "$SYSTEMD_DIR"
  printf 'DRY  | %s daemon-reload && %s enable --now dsh-hub-cert.timer\n' "$SYSTEMCTL" "$SYSTEMCTL"
  exit 0
fi

# ── 3. 签发 + 安装 ──────────────────────────────────────────────────────────
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"
# 先建好 0600 的空文件再装，保证 acme.sh 写进去的私钥权限（私钥必须 0600）
install -m 600 /dev/null "$TLS_DIR/privkey.pem"
install -m 644 /dev/null "$TLS_DIR/fullchain.pem"

log '签发中（DNS-01，acme.sh 会自己加/删 TXT 记录）…'
"${ACME_ENV_CMD[@]}" "$ACME_SH" "${issue_args[@]}"
log '安装到 Hub 的数据目录…'
"${ACME_ENV_CMD[@]}" "$ACME_SH" "${install_args[@]}"
chmod 600 "$TLS_DIR/privkey.pem"
chmod 644 "$TLS_DIR/fullchain.pem"

# ── 4. 续期定时器 ───────────────────────────────────────────────────────────
mkdir -p "$SYSTEMD_DIR"
ln -sfn "$REPO_DIR/deploy/systemd/dsh-hub-cert.service" "$SYSTEMD_DIR/dsh-hub-cert.service"
ln -sfn "$REPO_DIR/deploy/systemd/dsh-hub-cert.timer" "$SYSTEMD_DIR/dsh-hub-cert.timer"
# shellcheck disable=SC2086  # $SYSTEMCTL 故意不加引号：默认值是「systemctl --user」两个词
"${NO_PROXY_ENV[@]}" $SYSTEMCTL daemon-reload
# shellcheck disable=SC2086
"${NO_PROXY_ENV[@]}" $SYSTEMCTL enable --now dsh-hub-cert.timer

log "完成。查看证书：deploy/hubctl tls:info"
log "定时器：$SYSTEMCTL list-timers dsh-hub-cert.timer"
