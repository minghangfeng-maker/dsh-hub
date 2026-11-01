#!/usr/bin/env bash
# 生产升级（08 §2.1）：把 ~/dsh-hub-prod 前移到 release，重建并重启，健康检查不过就回退。
#
#   deploy/upgrade.sh          # 由你在普通终端执行（不需要 sudo）
#
# 环境变量（都有默认值，测试与特殊部署才需要改）：
#   HUB_PROD_DIR        生产目录         默认 ~/dsh-hub-prod
#   HUB_RELEASE_BRANCH  升级目标分支     默认 release
#   HUB_SERVICE         用户服务名       默认 dsh-hub
#   HUB_HEALTH_URL      健康检查地址     默认 http://127.0.0.1:7700/api/health
#   HUB_HEALTH_TIMEOUT  健康检查总时长s  默认 30
#   HUB_HEALTH_INTERVAL 轮询间隔s        默认 1
#   HUB_HEALTH_EXPECT   期望的响应片段   默认 "ok":true
#   HUB_TOOLS_DIR       pnpm 入口所在目录 默认 ~/.local/share/dsh-hub/bin（见下「工具链」）
#   HUB_PNPM / HUB_SYSTEMCTL / HUB_CURL 命令覆盖（测试用假命令；设了 HUB_PNPM 就不再自动准备 pnpm）
#
# 工具链（在普通终端直接跑就能用，不需要先装 pnpm、也不需要先清 NODE_ENV）：
#   - install / build 一律在「没有 NODE_ENV」下跑：shell 里常见 NODE_ENV=production，pnpm install 会因此跳过
#     devDependencies，随后 build 找不到 vue-tsc / vite 失败。
#   - pnpm 不在 PATH 里是常态（nvm 的 Node 自带 corepack，不带 pnpm）：用 corepack 在 HUB_TOOLS_DIR 生成 pnpm 入口
#     并放到 PATH 最前（根 build 脚本里还会再调 pnpm，所以必须是 PATH 上的真命令）。这个目录同时写在 systemd 单元的
#     PATH 里，服务端「本地目录入库」的 `pnpm pack` 靠它找到 pnpm。版本由仓库 package.json 的 packageManager 决定。
#
# 语义：任一步失败 → `git reset --hard <升级前的提交>` → 重新 install/build/restart → 退出码 1。
# 工作区必须干净（生产目录只放代码，用户数据在 /srv/dsh-hub）。
set -euo pipefail

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
  printf '[%s] 失败: %s\n' "$(date +%H:%M:%S)" "$*" >&2
  exit 1
}

PROD_DIR="${HUB_PROD_DIR:-$HOME/dsh-hub-prod}"
BRANCH="${HUB_RELEASE_BRANCH:-release}"
SERVICE="${HUB_SERVICE:-dsh-hub}"
HEALTH_URL="${HUB_HEALTH_URL:-http://127.0.0.1:7700/api/health}"
HEALTH_TIMEOUT="${HUB_HEALTH_TIMEOUT:-30}"
HEALTH_INTERVAL="${HUB_HEALTH_INTERVAL:-1}"
HEALTH_EXPECT="${HUB_HEALTH_EXPECT:-\"ok\":true}"

# 允许 "cmd --flag" 这种带参数的覆盖值（HUB_SYSTEMCTL 默认就是两个词）
TOOLS_DIR="${HUB_TOOLS_DIR:-$HOME/.local/share/dsh-hub/bin}"

IFS=' ' read -r -a PNPM <<<"${HUB_PNPM:-pnpm}"
IFS=' ' read -r -a SYSTEMCTL <<<"${HUB_SYSTEMCTL:-systemctl --user}"
IFS=' ' read -r -a CURL <<<"${HUB_CURL:-curl}"

log "生产目录：$PROD_DIR"
git -C "$PROD_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "$PROD_DIR 不是 git 工作区（08 §2.1：把仓库 clone 到该目录，或用 git worktree add --detach 建一个）"
cd "$PROD_DIR"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >&2
  die "生产目录有未提交改动，先处理干净再升级"
fi

# ── 工具链：先于任何改动检查，缺工具时不会留下半个升级 ───────────────────────
ensure_pnpm() {
  if [ -n "${HUB_PNPM:-}" ]; then
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    # 非交互：不要让 corepack 在首次下载 pnpm 时停下来问问题
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    mkdir -p "$TOOLS_DIR" || die "无法创建 $TOOLS_DIR"
    corepack enable --install-directory "$TOOLS_DIR" pnpm || die "corepack 生成 pnpm 入口失败（$TOOLS_DIR）"
    PATH="$TOOLS_DIR:$PATH"
    export PATH
    log "pnpm 入口：$TOOLS_DIR/pnpm（corepack，版本以仓库 packageManager 为准）"
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1; then
    warn "没有 corepack，沿用 PATH 里的 pnpm；服务端的 pnpm pack 要靠 systemd 单元 PATH 找到它"
    return 0
  fi
  die "找不到 pnpm，也找不到 corepack（nvm 装的 Node 自带 corepack：先 nvm use 24，或 npm i -g corepack）"
}
ensure_pnpm

PREV_REV="$(git rev-parse HEAD)"
PREV_DESC="$(git log -1 --pretty='%h %s')"
log "升级前：$PREV_REV（$PREV_DESC）"

# ── 取最新 release：只接受 fast-forward，合不上就停下让人处理 ────────────────
if git remote get-url origin >/dev/null 2>&1; then
  log "git fetch origin --prune"
  git fetch origin --prune || warn "git fetch 失败（离线？）—— 用本地 $BRANCH 继续"
fi
if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  TARGET="refs/remotes/origin/$BRANCH"
else
  TARGET="$BRANCH"
fi
log "git merge --ff-only $TARGET"
git merge --ff-only "$TARGET" || die "无法 fast-forward 到 $TARGET（历史分叉，需要人工处理；未做任何改动）"
NEW_REV="$(git rev-parse HEAD)"
log "升级到：$NEW_REV（$(git log -1 --pretty='%h %s')）"

# ── 健康检查与回退 ──────────────────────────────────────────────────────────
health_check() {
  local deadline body
  deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while :; do
    if body="$("${CURL[@]}" -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
      case "$body" in
        *"$HEALTH_EXPECT"*) return 0 ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

# 单元文件是指向生产副本的软链接，升级/回退都可能改了它：先 daemon-reload 再重启，改动才会生效
restart_service() {
  "${SYSTEMCTL[@]}" daemon-reload || warn "systemctl daemon-reload 失败（单元文件的改动可能没生效）"
  "${SYSTEMCTL[@]}" restart "$SERVICE"
}

rollback() {
  local reason="$1"
  warn "升级失败：$reason"
  warn "回退到 $PREV_REV（$PREV_DESC）"
  git reset --hard "$PREV_REV" || warn "git reset --hard 失败，请人工处理"
  env -u NODE_ENV "${PNPM[@]}" install --frozen-lockfile || warn "回退时 install 失败"
  env -u NODE_ENV "${PNPM[@]}" build || warn "回退时 build 失败"
  restart_service || warn "回退时重启失败"
  if health_check; then
    warn "已回退到 $PREV_REV 并重启，健康检查通过（线上跑的是旧版本）"
  else
    warn "已回退到 $PREV_REV 并重启，但健康检查仍不通过 —— 人工排查：journalctl --user -u $SERVICE -n 200"
  fi
  exit 1
}

# 升级期间的任何一步失败都要回退，所以用一个显式包装而不是 trap ERR（回退本身也会跑命令）
run_step() {
  local desc="$1"
  shift
  log "$desc"
  if ! "$@"; then
    rollback "步骤失败：$desc"
  fi
}

run_step "${PNPM[*]} install --frozen-lockfile" env -u NODE_ENV "${PNPM[@]}" install --frozen-lockfile
run_step "${PNPM[*]} build" env -u NODE_ENV "${PNPM[@]}" build
run_step "${SYSTEMCTL[*]} restart $SERVICE" restart_service
if ! health_check; then
  rollback "健康检查失败（${HEALTH_TIMEOUT}s 内 $HEALTH_URL 没有出现 $HEALTH_EXPECT）"
fi

log "升级完成：$PREV_REV → $NEW_REV，服务已重启并通过健康检查"
log "看日志： journalctl --user -u $SERVICE -f"
