#!/usr/bin/env bash
# 从备份恢复 hub.db（10 §G1「删除 hub.db 后从备份恢复」）。**危险操作**，会覆盖线上库。
#
#   scripts/restore-db.sh --list                 # 列出可用备份
#   scripts/restore-db.sh --latest --yes         # 恢复最新一份（停服→留档→放回→起服→健康检查）
#   scripts/restore-db.sh --from <file> --yes    # 指定文件
#   scripts/restore-db.sh --from <file> --no-service   # 只换文件，不动 systemd
#   scripts/restore-db.sh --latest --secrets latest --yes   # 连 secrets/ 一起恢复
#
# 设计取舍：
# - 默认**停服再换**（SQLite 有 WAL，热替换会拿到不一致的库）；
# - 现有库不删，改名成 hub.db.before-restore-<时间戳> 留档，回滚就是把它改回来；
# - 换完做完整性检查（PRAGMA integrity_check）与健康检查，失败了给出回滚命令。
set -euo pipefail

DATA_DIR="${HUB_DATA_DIR:-/srv/dsh-hub}"
BACKUP_DIR="${HUB_BACKUP_DIR:-/mnt/backup/dsh-hub}"
SERVICE="${HUB_SERVICE:-dsh-hub}"
HEALTH_URL="${HUB_HEALTH_URL:-http://127.0.0.1:7700/api/health}"
IFS=' ' read -r -a SYSTEMCTL <<<"${HUB_SYSTEMCTL:-systemctl --user}"

FROM=""
LATEST=0
LIST_ONLY=0
ASSUME_YES=0
NO_SERVICE=0
SECRETS=""

DB_DIR="$BACKUP_DIR/db"
DB_FILE="$DATA_DIR/hub.db"

log() { printf '[%s] %s\n' "$(date +%Y-%m-%d\ %H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date +%Y-%m-%d\ %H:%M:%S)" "$*" >&2; }
die() {
  printf '恢复失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

list_backups() {
  printf '备份目录：%s\n\n' "$DB_DIR"
  if [ ! -d "$DB_DIR" ]; then
    printf '（目录不存在 —— 还没跑过 scripts/backup.sh？）\n'
    return 0
  fi
  local found=0 f size when secrets
  while IFS= read -r f; do
    found=1
    size="$(du -h "$f" | cut -f1)"
    when="$(date -r "$f" '+%Y-%m-%d %H:%M:%S')"
    local stamp
    stamp="$(basename "$f" .db)"
    stamp="${stamp#hub-}"
    if [ -f "$DB_DIR/secrets-$stamp.tar.gz" ]; then
      secrets="$DB_DIR/secrets-$stamp.tar.gz"
    else
      secrets='—'
    fi
    printf '  %s  %s  %s\n      secrets: %s\n' "$when" "$size" "$f" "$secrets"
  done < <(find "$DB_DIR" -maxdepth 1 -name 'hub-*.db' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  [ "$found" -eq 1 ] || printf '（没有 hub-*.db）\n'
}

sqlite_meta() { # sqlite_meta <file> <sql>：用 node:sqlite 读一行
  local file="$1" sql="$2"
  node -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1], { readOnly: true })
    try {
      const row = db.prepare(process.argv[2]).get()
      console.log(Object.values(row).join(" "))
    } finally {
      db.close()
    }
  ' "$file" "$sql" 2>/dev/null
}

verify_db() { # 返回 0 = 像一份能用的 hub 库
  local file="$1" magic result users
  [ -f "$file" ] || die "文件不存在：$file"
  magic="$(head -c 16 "$file" | tr -d '\0')"
  [ "$magic" = "SQLite format 3" ] || die "不是 SQLite 文件（头 16 字节：$magic）"
  if ! command -v node >/dev/null 2>&1; then
    warn '没有 node，跳过 PRAGMA integrity_check 与表检查'
    return 0
  fi
  result="$(sqlite_meta "$file" 'PRAGMA integrity_check')"
  [ "$result" = "ok" ] || die "integrity_check 不通过：${result:-（读不出来）}"
  log "integrity_check: ok"
  users="$(sqlite_meta "$file" 'SELECT count(*) AS n FROM users')"
  if [ -z "$users" ]; then
    die '读不到 users 表 —— 这不像 DSH Hub 的库'
  fi
  log "库里有 $users 个用户"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      shift
      [ $# -gt 0 ] || die '--from 需要一个文件'
      FROM="$1"
      ;;
    --latest) LATEST=1 ;;
    --list) LIST_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --data-dir)
      shift
      DATA_DIR="${1:?--data-dir 需要目录}"
      DB_FILE="$DATA_DIR/hub.db"
      ;;
    --backup-dir)
      shift
      BACKUP_DIR="${1:?--backup-dir 需要目录}"
      DB_DIR="$BACKUP_DIR/db"
      ;;
    --secrets)
      shift
      [ $# -gt 0 ] || die '--secrets 需要 latest 或一个 .tar.gz'
      SECRETS="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

if [ "$LIST_ONLY" -eq 1 ]; then
  list_backups
  exit 0
fi

# ── 选源 ────────────────────────────────────────────────────────────────────
if [ -z "$FROM" ] && [ "$LATEST" -eq 1 ]; then
  FROM="$(find "$DB_DIR" -maxdepth 1 -name 'hub-*.db' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk 'NR==1{print $2}')"
  [ -n "$FROM" ] || die "在 $DB_DIR 找不到 hub-*.db（先跑 scripts/backup.sh）"
fi
[ -n "$FROM" ] || die '需要 --from <file> 或 --latest（--list 看有哪些）'

if [ "$SECRETS" = "latest" ]; then
  SECRETS="$(find "$DB_DIR" -maxdepth 1 -name 'secrets-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk 'NR==1{print $2}')"
  [ -n "$SECRETS" ] || die "在 $DB_DIR 找不到 secrets-*.tar.gz"
fi

log "数据目录：$DATA_DIR"
log "恢复来源：$FROM"
[ -n "$SECRETS" ] && log "secrets 来源：$SECRETS"
[ -f "$DB_FILE" ] && log "当前库：$DB_FILE（$(du -h "$DB_FILE" | cut -f1)，$(date -r "$DB_FILE" '+%Y-%m-%d %H:%M:%S')）" || warn "当前没有 $DB_FILE"

verify_db "$FROM"
if [ -n "$SECRETS" ]; then
  [ -f "$SECRETS" ] || die "secrets 文件不存在：$SECRETS"
  tar -tzf "$SECRETS" >/dev/null 2>&1 || die "secrets 不是合法的 tar.gz：$SECRETS"
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n将执行：\n'
  if [ "$NO_SERVICE" -eq 0 ]; then printf '  1) %s stop %s\n' "${SYSTEMCTL[*]}" "$SERVICE"; fi
  printf '  2) 把现有 %s 改名为 hub.db.before-restore-<时间戳>（不删）并清掉 -wal/-shm\n' "$DB_FILE"
  printf '  3) 复制 %s → %s\n' "$FROM" "$DB_FILE"
  [ -n "$SECRETS" ] && printf '  4) 把现有 secrets/ 改名留档，再解开 %s\n' "$SECRETS"
  if [ "$NO_SERVICE" -eq 0 ]; then printf '  5) %s start %s 并做健康检查\n' "${SYSTEMCTL[*]}" "$SERVICE"; fi
  printf '\n确认请输入 yes：'
  read -r answer
  [ "$answer" = "yes" ] || die '已取消'
fi

# ── 执行 ────────────────────────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
service_running=0
if [ "$NO_SERVICE" -eq 0 ]; then
  if "${SYSTEMCTL[@]}" is-active --quiet "$SERVICE"; then
    service_running=1
    log "停服：${SYSTEMCTL[*]} stop $SERVICE"
    "${SYSTEMCTL[@]}" stop "$SERVICE"
  else
    warn "$SERVICE 当前不是 active，跳过 stop"
  fi
fi

if [ -f "$DB_FILE" ]; then
  mv "$DB_FILE" "$DB_FILE.before-restore-$STAMP"
  log "原库留档：$DB_FILE.before-restore-$STAMP"
fi
rm -f "$DB_FILE-wal" "$DB_FILE-shm"
cp -- "$FROM" "$DB_FILE"
chmod 600 "$DB_FILE"
log "已放回：$DB_FILE"

if [ -n "$SECRETS" ]; then
  if [ -d "$DATA_DIR/secrets" ]; then
    mv "$DATA_DIR/secrets" "$DATA_DIR/secrets.before-restore-$STAMP"
    log "原 secrets 留档：$DATA_DIR/secrets.before-restore-$STAMP"
  fi
  mkdir -p "$DATA_DIR/secrets"
  tar -xzf "$SECRETS" -C "$DATA_DIR/secrets"
  chmod 700 "$DATA_DIR/secrets"
  find "$DATA_DIR/secrets" -type f -exec chmod 600 {} +
  log "secrets 已恢复（0600）"
fi

if [ "$NO_SERVICE" -eq 0 ]; then
  "${SYSTEMCTL[@]}" start "$SERVICE"
  ok=1
  for _ in $(seq 1 20); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
      ok=0
      break
    fi
    sleep 1
  done
  if [ "$ok" -eq 0 ]; then
    log "服务已启动，健康检查通过：$HEALTH_URL"
  else
    warn "服务起来了但健康检查没过：journalctl --user -u $SERVICE -n 200"
  fi
elif [ "$service_running" -eq 1 ]; then
  warn '--no-service：服务还是停着的，别忘了 systemctl --user start dsh-hub'
fi

log '恢复流程结束'
printf '\n回滚（把留档换回来）：\n  %s stop %s\n  mv %s.before-restore-%s %s\n  rm -f %s-wal %s-shm\n  %s start %s\n' \
  "${SYSTEMCTL[*]}" "$SERVICE" "$DB_FILE" "$STAMP" "$DB_FILE" "$DB_FILE" "$DB_FILE" "${SYSTEMCTL[*]}" "$SERVICE"
