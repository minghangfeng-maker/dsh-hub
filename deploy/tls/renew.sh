#!/usr/bin/env bash
# 证书续期检查（08 §3）——由 dsh-hub-cert.timer 每天触发一次，也可以手动跑：
#
#   deploy/tls/renew.sh --dry-run     # 只打印要执行的命令
#   deploy/tls/renew.sh               # 真的跑 `acme.sh --cron`（默认行为：定时器里就该干活）
#
# acme.sh 自己判断哪张证书快到 30 天该续了；续期成功后会执行签发时登记的 reloadcmd
# （`systemctl --user kill -s HUP dsh-hub.service`），Hub 热换证书、不重启、不断已有连接。
# 不依赖 crond：一个 systemd 用户 timer 就够（Persistent=true 补上错过的运行；在 WSL 上部署时也适用）。
set -euo pipefail

ACME_ENV="${HUB_ACME_ENV:-$HOME/.config/dsh-hub/acme.env}"
ACME_SH="${ACME_SH:-$HOME/.acme.sh/acme.sh}"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf '未知参数：%s（支持 --dry-run）\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[renew] %s\n' "$*"; }
die() {
  printf '[renew] 失败：%s\n' "$*" >&2
  exit 1
}

[ -x "$ACME_SH" ] || die "找不到 acme.sh（$ACME_SH）；先跑 deploy/tls/issue-cert.sh"

# 加载 acme.env：DNS 凭据只在这个进程里（acme.sh --cron 需要它们来加 TXT 记录）
if [ -f "$ACME_ENV" ]; then
  # 路径由环境变量给
  set -a
  # shellcheck source=/dev/null
  . "$ACME_ENV"
  set +a
else
  log "警告：$ACME_ENV 不存在，凭据可能要另想办法提供（acme.sh 的 account.conf）"
fi

NO_PROXY_ENV=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy -u NODE_USE_ENV_PROXY)
# acme.sh 默认直连；acme.env 设了 ACME_PROXY（如 http://proxy.example.com:3128）就只让 acme.sh 走它——
# 国内直连 Let's Encrypt API 时断时续（超时、签发卡在 new-order 报 curl 35）。
ACME_ENV_CMD=("${NO_PROXY_ENV[@]}")
if [ -n "${ACME_PROXY:-}" ]; then ACME_ENV_CMD+=("https_proxy=$ACME_PROXY" "http_proxy=$ACME_PROXY"); fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY  | %s %s --cron --home %s\n' "${ACME_ENV_CMD[*]}" "$ACME_SH" "$ACME_HOME"
  exit 0
fi

log "跑 acme.sh --cron（该续的自然会续，不需要续就什么都不做）"
"${ACME_ENV_CMD[@]}" "$ACME_SH" --cron --home "$ACME_HOME"
log '完成；证书状态：deploy/hubctl tls:info'
