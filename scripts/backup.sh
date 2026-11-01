#!/usr/bin/env bash
# 每日备份（08 §8）：hub.db（VACUUM INTO）+ secrets + 用户工作区增量 tar → 异盘。
#
#   scripts/backup.sh                      # 全部（db + secrets + 工作区增量）
#   scripts/backup.sh --only db            # 只备份 db + secrets（08 §8 的 03:30）
#   scripts/backup.sh --only workspace     # 只做工作区增量（08 §8 的 04:00）
#   scripts/backup.sh --dry-run            # 只打印要执行的命令
#   scripts/backup.sh --full               # 强制做一次全量（新建 tar 快照链）
#
# 默认由 systemd 用户 timer（deploy/systemd/dsh-hub-backup.timer，每天 03:30）触发；
# 也可以手动跑。需要 root 的操作这里没有 —— 全都是当前用户自己目录里的读写。
#
# 环境变量（systemd 单元里已设好）：
#   HUB_DATA_DIR      数据根            默认 /srv/dsh-hub
#   HUB_BACKUP_DIR    备份根（异盘）    默认 /mnt/backup/dsh-hub
#   HUB_CLI_CMD       调 db:backup 的命令  默认 node <repo>/apps/api/dist/cli.js
#   HUB_KEEP_DB_DAYS  db 保留天数       默认 14
#   HUB_KEEP_DAILY    工作区日志保留份数 默认 7
#   HUB_KEEP_WEEKLY   周备份保留份数     默认 4
#   HUB_FULL_AFTER_DAYS 多少天后重新全量 默认 7
#
# 恢复：见 deploy/README.md「备份与恢复」；db 用 scripts/restore-db.sh。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${HUB_DATA_DIR:-/srv/dsh-hub}"
# CLI 必须看到同一个数据目录（手工执行时环境里可能没有 HUB_DATA_DIR）
export HUB_DATA_DIR="$DATA_DIR"
DEST="${HUB_BACKUP_DIR:-/mnt/backup/dsh-hub}"
CLI_CMD="${HUB_CLI_CMD:-node $REPO_DIR/apps/api/dist/cli.js}"
KEEP_DB_DAYS="${HUB_KEEP_DB_DAYS:-14}"
KEEP_DAILY="${HUB_KEEP_DAILY:-7}"
KEEP_WEEKLY="${HUB_KEEP_WEEKLY:-4}"
FULL_AFTER_DAYS="${HUB_FULL_AFTER_DAYS:-7}"

ONLY=all
DRY_RUN=0
FORCE_FULL=0

log() { printf '[%s] %s\n' "$(date +%Y-%m-%d\ %H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date +%Y-%m-%d\ %H:%M:%S)" "$*" >&2; }
die() {
  printf '备份失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

run() { # run <命令…>：--dry-run 时只打印
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY  | %s\n' "$*"
    return 0
  fi
  "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)
      shift
      [ $# -gt 0 ] || die '--dest 需要一个目录'
      DEST="$1"
      ;;
    --data-dir)
      shift
      [ $# -gt 0 ] || die '--data-dir 需要一个目录'
      DATA_DIR="$1"
      ;;
    --only)
      shift
      [ $# -gt 0 ] || die '--only 需要 all|db|workspace'
      ONLY="$1"
      case "$ONLY" in all | db | workspace) ;; *) die "--only 只支持 all|db|workspace（收到 $ONLY）" ;; esac
      ;;
    --full) FORCE_FULL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --keep-db-days)
      shift
      KEEP_DB_DAYS="${1:?--keep-db-days 需要数字}"
      ;;
    --keep-daily)
      shift
      KEEP_DAILY="${1:?--keep-daily 需要数字}"
      ;;
    --keep-weekly)
      shift
      KEEP_WEEKLY="${1:?--keep-weekly 需要数字}"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

STAMP="$(date +%Y%m%d-%H%M%S)"
WEEK="$(date +%G-W%V)"
DB_DIR="$DEST/db"
WS_DIR="$DEST/workspace"
WEEKLY_DIR="$WS_DIR/weekly"
SNAPSHOT="$WS_DIR/.snapshot"
ARCHIVE="$WS_DIR/workspace-$STAMP.tar.gz"
LIST_FILE="$(mktemp -t dshhub-backup-list.XXXXXX)"
trap 'rm -f "$LIST_FILE"' EXIT

log "数据目录：$DATA_DIR"
log "备份目录：$DEST"

[ -d "$DATA_DIR" ] || die "数据目录不存在：$DATA_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
  # 备份盘没挂（Windows D 盘）时不要静默写到别处
  [ -d "$DEST" ] || die "备份目录不存在：$DEST（Windows D 盘挂载了吗？可改 HUB_BACKUP_DIR）"
  [ -w "$DEST" ] || die "备份目录不可写：$DEST"
fi

# ── 1. hub.db + secrets（走 CLI 的 VACUUM INTO，08 §8 / 08 §10） ─────────────
backup_db() {
  log '── hub.db（VACUUM INTO）+ secrets ──'
  run mkdir -p "$DB_DIR"
  if [ "$DRY_RUN" -eq 0 ]; then
    # shellcheck disable=SC2086  # CLI_CMD 可能带参数（node <path>）
    $CLI_CMD db:backup --out "$DB_DIR" --keep-days "$KEEP_DB_DAYS"
  else
    run "$CLI_CMD" db:backup --out "$DB_DIR" --keep-days "$KEEP_DB_DAYS"
  fi
  log "db 备份完成 → $DB_DIR"
}

# ── 2. 用户工作区增量 tar（08 §8：users/*/workspace + home/.dsh/sessions） ──
collect_workspace_paths() {
  [ -d "$DATA_DIR/users" ] || return 0
  local slug
  while IFS= read -r slug; do
    [ -n "$slug" ] || continue
    if [ -d "$DATA_DIR/users/$slug/workspace" ]; then printf './%s/workspace\n' "$slug"; fi
    if [ -d "$DATA_DIR/users/$slug/home/.dsh/sessions" ]; then printf './%s/home/.dsh/sessions\n' "$slug"; fi
  done < <(find "$DATA_DIR/users" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)
}

backup_workspace() {
  log '── 用户工作区（增量 tar）──'
  run mkdir -p "$WS_DIR" "$WEEKLY_DIR"
  collect_workspace_paths >"$LIST_FILE"
  if [ ! -s "$LIST_FILE" ]; then
    warn "没有可备份的用户目录（$DATA_DIR/users 为空？），跳过工作区"
    return 0
  fi
  log "本次包含 $(wc -l <"$LIST_FILE") 个目录（users/*/workspace 与 home/.dsh/sessions）"

  need_full=0
  if [ "$FORCE_FULL" -eq 1 ]; then
    need_full=1
  elif [ ! -f "$SNAPSHOT" ]; then
    need_full=1
    log '没有 tar 快照文件 → 本次做全量（level 0）'
  elif [ -n "$(find "$SNAPSHOT" -mtime "+$FULL_AFTER_DAYS" 2>/dev/null || true)" ]; then
    need_full=1
    log "tar 快照超过 $FULL_AFTER_DAYS 天 → 本次重新做全量（level 0）"
  fi
  if [ "$need_full" -eq 1 ]; then
    run rm -f "$SNAPSHOT"
  fi

  # 一次 tar 覆盖所有用户（GNU tar 的 --listed-incremental 是「一个快照文件跟踪全部成员」，
  # 分成多次调用会互相覆盖快照）
  run tar --listed-incremental="$SNAPSHOT" \
    --exclude='node_modules' --exclude='.git' --exclude='*.log' \
    -czf "$ARCHIVE" -C "$DATA_DIR/users" --files-from="$LIST_FILE"

  if [ "$DRY_RUN" -eq 0 ]; then
    log "工作区归档：$ARCHIVE（$(du -h "$ARCHIVE" | cut -f1)）"
    if [ "$need_full" -eq 1 ]; then
      run ln -f "$ARCHIVE" "$WEEKLY_DIR/workspace-$WEEK.tar.gz"
      log "周备份（硬链接）：$WEEKLY_DIR/workspace-$WEEK.tar.gz"
    fi
  fi
}

prune_workspace() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  log "── 清理旧归档（保留 $KEEP_DAILY 份日备 / $KEEP_WEEKLY 份周备）──"
  # 日备：只留最新的 KEEP_DAILY 份（周备是全量起点，删了它会让后面的增量无法恢复）
  local -a dailies=()
  while IFS= read -r f; do dailies+=("$f"); done < <(find "$WS_DIR" -maxdepth 1 -name 'workspace-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  local i
  for ((i = KEEP_DAILY; i < ${#dailies[@]}; i++)); do
    run rm -f "${dailies[$i]}"
  done
  local -a weeklies=()
  while IFS= read -r f; do weeklies+=("$f"); done < <(find "$WEEKLY_DIR" -maxdepth 1 -name 'workspace-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  for ((i = KEEP_WEEKLY; i < ${#weeklies[@]}; i++)); do
    run rm -f "${weeklies[$i]}"
  done
}

case "$ONLY" in
  all)
    backup_db
    backup_workspace
    prune_workspace
    ;;
  db) backup_db ;;
  workspace)
    backup_workspace
    prune_workspace
    ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  log '干跑结束：没有写任何文件'
  exit 0
fi
log '备份完成'
log "看归档： ls -lh $DB_DIR $WS_DIR"
log "恢复演练（10 §G1）： scripts/restore-db.sh --list"
