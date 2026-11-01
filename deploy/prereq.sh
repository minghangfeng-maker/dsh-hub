#!/usr/bin/env bash
# 前置条件只读检查（08 §1）：逐项输出 OK/缺失/警告，并给出**应执行的命令**。
# 这个脚本**不改任何东西**（不 mkdir、不 chown、不装包、不动 nft、不碰 systemd），
# 需要 root 的操作只打印出来，由你自己在普通终端执行（脚本不执行 sudo）。
#
#   deploy/prereq.sh
#
# 退出码：0 = 必需项都满足（警告不算失败）；1 = 有「缺失」项。
set -euo pipefail

USER_NAME="$(id -un)"
USER_GROUP="$(id -gn)"
DATA_DIR="${HUB_DATA_DIR:-/srv/dsh-hub}"
BACKUP_DIR="${HUB_BACKUP_DIR:-/mnt/backup/dsh-hub}"
PROD_DIR="${HUB_PROD_DIR:-$HOME/dsh-hub-prod}"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

PASS_N=0
MISS_N=0
WARN_N=0

ok() {
  printf '  [OK]   %s\n' "$*"
  PASS_N=$((PASS_N + 1))
}
miss() {
  printf '  [缺失] %s\n' "$*"
  MISS_N=$((MISS_N + 1))
}
warn() {
  printf '  [警告] %s\n' "$*"
  WARN_N=$((WARN_N + 1))
}
todo() { printf '         应执行: %s\n' "$*"; }

section() { printf '\n%s\n' "$*"; }

printf 'DSH Hub 前置条件检查（08 §1，只读）\n'
printf '  仓库: %s\n  数据目录: %s\n  生产目录: %s\n  备份目标: %s\n' "$REPO_DIR" "$DATA_DIR" "$PROD_DIR" "$BACKUP_DIR"

# ── 1. Node 24 / pnpm 10 ────────────────────────────────────────────────────
section '1) Node 24.x 与 pnpm 10.x'
NODE_VER="$(node -v 2>/dev/null || true)"
case "$NODE_VER" in
  v24.*) ok "node $NODE_VER" ;;
  '')
    miss '找不到 node'
    todo '安装 Node 24（nvm install 24），并同步 dsh-hub.service 的 ExecStart 路径'
    ;;
  *)
    miss "node $NODE_VER（要求 24.x）"
    todo 'nvm install 24 && nvm use 24'
    ;;
esac
PNPM_VER="$(pnpm -v 2>/dev/null || true)"
case "$PNPM_VER" in
  10.*) ok "pnpm $PNPM_VER" ;;
  '')
    miss '找不到 pnpm'
    todo 'corepack enable && corepack prepare pnpm@10 --activate'
    ;;
  *)
    miss "pnpm $PNPM_VER（要求 10.x）"
    todo 'corepack prepare pnpm@10 --activate'
    ;;
esac

# ── 2. docker 组与 Docker 可达（08 §1 第 1 条） ─────────────────────────────
section '2) Docker'
if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "当前用户 $USER_NAME 在 docker 组"
else
  miss "当前用户 $USER_NAME 不在 docker 组"
  todo "sudo usermod -aG docker $USER_NAME   # 之后要重新登录/开新终端才生效"
fi
DOCKER_VER="$(docker info --format '{{.ServerVersion}}' 2>/dev/null || true)"
if [ -n "$DOCKER_VER" ]; then
  ok "Docker 可达（server $DOCKER_VER，socket /var/run/docker.sock）"
else
  miss 'docker 命令连不上 Docker Engine'
  todo 'sudo systemctl start docker && docker info   # 若提示权限不足，见上一条 docker 组'
fi

# ── 3. 数据目录属主与权限（08 §1 第 2 条） ─────────────────────────────────
section "3) 数据目录 $DATA_DIR"
if [ -d "$DATA_DIR" ]; then
  OWNER="$(stat -c '%U:%G' "$DATA_DIR")"
  MODE="$(stat -c '%a' "$DATA_DIR")"
  if [ "$OWNER" = "$USER_NAME:$USER_GROUP" ]; then
    ok "属主 $OWNER"
  else
    miss "属主是 $OWNER，应为 $USER_NAME:$USER_GROUP"
    todo "sudo chown $USER_NAME:$USER_GROUP $DATA_DIR"
  fi
  if [ "$MODE" = "750" ]; then
    ok "权限 $MODE"
  else
    warn "权限是 $MODE（08 §1 建议 750）"
    todo "chmod 750 $DATA_DIR"
  fi
  if [ -w "$DATA_DIR" ]; then
    ok '当前用户可写'
  else
    miss '当前用户不可写'
    todo "sudo chown $USER_NAME:$USER_GROUP $DATA_DIR && chmod 750 $DATA_DIR"
  fi
else
  miss "$DATA_DIR 不存在"
  todo "sudo mkdir -p $DATA_DIR && sudo chown $USER_NAME:$USER_GROUP $DATA_DIR && chmod 750 $DATA_DIR"
fi

# ── 4. 出网规则是否已加载（08 §1 第 3 条、02 §4） ──────────────────────────
section '4) 出网规则（nft table inet dshhub）'
NFT_OUT="$(nft list table inet dshhub 2>&1 || true)"
if printf '%s' "$NFT_OUT" | grep -q 'table inet dshhub'; then
  ok 'table inet dshhub 已加载'
  if printf '%s' "$NFT_OUT" | grep -q 'chain fwd4'; then
    ok 'forward 链存在（fwd4）'
  else
    warn '看不到 fwd4 链，规则可能不是 02 §4 的版本'
    todo 'sudo deploy/nft/install.sh'
  fi
  if printf '%s' "$NFT_OUT" | grep -q 'blocked4'; then
    ok 'blocked4 集合存在'
  else
    warn '看不到 blocked4 集合'
    todo 'sudo deploy/nft/install.sh'
  fi
elif printf '%s' "$NFT_OUT" | grep -qi 'not permitted\|permission denied'; then
  warn '当前用户无权查看 nft 规则，无法确认是否已加载'
  todo 'sudo nft list table inet dshhub    # 看不到就 sudo deploy/nft/install.sh'
elif [ -z "$(command -v nft || true)" ]; then
  miss '没有安装 nftables'
  todo 'sudo apt install nftables && sudo deploy/nft/install.sh'
else
  miss 'table inet dshhub 未加载'
  todo 'sudo deploy/nft/install.sh        # 装成 dshhub-egress.service 开机自动恢复'
fi

# ── 5. 用户级服务开机自启（08 §2.2 的 Linger=yes） ─────────────────────────
section '5) systemd 用户服务'
LINGER="$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)"
if [ "$LINGER" = "yes" ]; then
  ok 'Linger=yes（无需登录即可自启用户服务）'
elif [ -z "$LINGER" ]; then
  warn '查不到 Linger 状态（loginctl 不可用？）'
  todo "sudo loginctl enable-linger $USER_NAME"
else
  warn "Linger=$LINGER —— 重新登录前用户服务不会自启"
  todo "sudo loginctl enable-linger $USER_NAME"
fi

# ── 6. 生产目录与端口占用 ──────────────────────────────────────────────────
section '6) 生产目录与端口'
if git -C "$PROD_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "$PROD_DIR 是 git 工作区（HEAD $(git -C "$PROD_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')）"
else
  warn "$PROD_DIR 还不是 git 工作区"
  todo "git -C $REPO_DIR worktree add --detach $PROD_DIR release   # 先在主仓库确认 release 分支已更新；--detach 见 deploy/README.md §1"
fi
for port in 7700 7443 7080; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    warn "端口 $port 已被占用"
    todo "ss -ltnp 'sport = :$port'   # 确认不是残留的 hub-api 进程"
  fi
done
ok '7700/7443/7080 端口检查完成（占用会以警告列出）'

# ── 7. 备份目标（08 §5） ───────────────────────────────────────────────────
section '7) 备份目标（异盘）'
if [ -d "$BACKUP_DIR" ]; then
  if [ -w "$BACKUP_DIR" ]; then
    ok "$BACKUP_DIR 存在且可写"
  else
    warn "$BACKUP_DIR 存在但不可写"
    todo "检查异盘挂载（部署在 WSL 上时看 Windows 盘：ls /mnt/d）或改 HUB_BACKUP_DIR"
  fi
else
  warn "$BACKUP_DIR 不存在（异盘没挂载？在 WSL 上是 Windows 盘没挂上？）"
  todo "mkdir -p $BACKUP_DIR   # 或把 HUB_BACKUP_DIR 指到别的异盘目录"
fi

# ── 汇总 ───────────────────────────────────────────────────────────────────
printf '\n汇总：OK %d / 缺失 %d / 警告 %d\n' "$PASS_N" "$MISS_N" "$WARN_N"
if [ "$MISS_N" -gt 0 ]; then
  printf '还有「缺失」项，按上面的「应执行」处理后再跑一次；然后看 deploy/README.md 部署 Hub。\n'
  exit 1
fi
printf '前置条件满足，继续 deploy/README.md 的部署步骤。\n'
