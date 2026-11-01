#!/usr/bin/env bash
# ============================================================================
# 核对一个「已发布」的 APK 是否真的可下载（只读：不登录、不改任何东西）
#
#   bash scripts/release/verify-apk.sh [APK]
#
# 不给 APK 时取 scripts/release/out/ 里最新的 *-release.apk。
#
# 为什么必须单独核对：APK 文件常常不在 Hub 自己的静态目录里（Hub 只负责发布记录与归档，
# 实际下载走 CDN / 独立域名 / 反向代理）。直接拿 Hub 的 SPA 回退页去比字节，会误报
# 「不一致」。所以这里按「发布记录 → 归档 → 公网下载」三处分别核对。
#
# 每一项都是**可选**的，没配就跳过（脚本不猜任何域名/IP/本机路径）：
#
#   HUB_ADMIN_BASE           Hub 的地址（如 http://127.0.0.1:7700）；不设 → 跳过发布记录核对
#   HUB_APP_BIN_DIR          Hub 本机归档目录；不设 → 跳过归档核对
#   HUB_DOWNLOAD_PUBLIC_BASE 公网下载根（如 https://cdn.example.com）；不设 → 跳过公网核对
#   HUB_DOWNLOAD_PUBLIC_PATH 公网路径前缀（默认 /downloads/mobile-app）
#   HUB_VERIFY_INSECURE      设为 1 时 curl 不校验 TLS（自签证书的测试环境）
#
# 四项都能配齐时，这就是发布后的一次完整核对；退出码非 0 表示至少一项不一致。
# ============================================================================
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/scripts/release/out"
BASE="${HUB_ADMIN_BASE:-}"
APP_BIN_DIR="${HUB_APP_BIN_DIR:-}"
PUBLIC_BASE="${HUB_DOWNLOAD_PUBLIC_BASE:-}"
PUBLIC_PATH="${HUB_DOWNLOAD_PUBLIC_PATH:-/downloads/mobile-app}"
CURL_TLS=()
[ "${HUB_VERIFY_INSECURE:-}" = "1" ] && CURL_TLS=(-k)

APK="${1:-}"
if [ -z "$APK" ]; then
  APK="$(ls -1t "$OUT_DIR"/dsh-hub-app-*-release.apk 2>/dev/null | head -1 || true)"
fi
[ -n "$APK" ] && [ -f "$APK" ] || { printf '失败：找不到 APK（参数或 %s/*-release.apk）\n' "$OUT_DIR" >&2; exit 1; }

say() { printf '%s\n' "$*"; }
die() { printf '\n失败：%s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

# 文件名 → 版本（dsh-hub-app-0.2.5-25-release.apk）
BASE_NAME="$(basename "$APK")"
VERSION="" VERSION_CODE=""
if [[ "$BASE_NAME" =~ ^dsh-hub-app-([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)-release\.apk$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
  VERSION_CODE="${BASH_REMATCH[2]}"
fi
[ -n "$VERSION" ] || die "APK 文件名不符合 dsh-hub-app-<ver>-<code>-release.apk：$BASE_NAME"

SHA="$(sha256sum "$APK" | awk '{print $1}')"
BYTES="$(stat -c %s "$APK")"

say "APK        $APK"
say "版本       $VERSION（versionCode $VERSION_CODE）"
say "sha256     $SHA"
say "大小       $BYTES 字节"

skipped=0

# ── 1. Hub 发布记录 ─────────────────────────────────────────────────────────
if [ -z "$BASE" ]; then
  note '跳过发布记录核对（没设 HUB_ADMIN_BASE）'; skipped=$((skipped + 1))
else
  PUB_JSON="$(curl --noproxy '*' -sS -m 20 "${CURL_TLS[@]}" "$BASE/api/public/android/download")" \
    || die "连不上 Hub：$BASE（Hub 在跑吗？）"
  RECORD="$(printf '%s' "$PUB_JSON" | node -e '
    let s = ""
    process.stdin.on("data", (d) => { s += d }).on("end", () => {
      try {
        const a = JSON.parse(s).app ?? {}
        const rows = {
          R_VERSION: a.version, R_CODE: a.versionCode, R_FILE: a.fileName,
          R_SHA: a.sha256, R_BYTES: a.bytes, R_AT: a.publishedAt,
        }
        for (const [k, v] of Object.entries(rows)) process.stdout.write(k + "=" + (v ?? "") + "\n")
      } catch {}
    })
  ')"
  [ -n "$RECORD" ] || die "公开接口没有发布记录：$PUB_JSON"
  while IFS= read -r line; do
    case "$line" in R_VERSION=*) R_VERSION="${line#R_VERSION=}" ;; esac
    case "$line" in R_CODE=*) R_CODE="${line#R_CODE=}" ;; esac
    case "$line" in R_FILE=*) R_FILE="${line#R_FILE=}" ;; esac
    case "$line" in R_SHA=*) R_SHA="${line#R_SHA=}" ;; esac
    case "$line" in R_BYTES=*) R_BYTES="${line#R_BYTES=}" ;; esac
    case "$line" in R_AT=*) R_AT="${line#R_AT=}" ;; esac
  done <<<"$RECORD"
  [ "$R_VERSION" = "$VERSION" ] || die "Hub 记录的版本是 ${R_VERSION:-（空）}，本地 APK 是 $VERSION"
  [ "$R_CODE" = "$VERSION_CODE" ] || die "Hub 记录的 versionCode 是 ${R_CODE:-（空）}，本地是 $VERSION_CODE"
  [ "$R_SHA" = "$SHA" ] || die "Hub 记录里的 sha256（${R_SHA:-（空）}）与本地 APK（$SHA）不一致"
  [ "$R_BYTES" = "$BYTES" ] || die "Hub 记录里的字节数（${R_BYTES:-（空）}）与本地 APK（$BYTES）不一致"
  [ -n "$R_AT" ] || die "Hub 记录没有 publishedAt（可能只是预发布/草稿）"
  say "Hub 记录   ✓ 版本 / versionCode / 字节 / sha256 一致（published $R_AT）"
fi

# ── 2. Hub 本机归档 ─────────────────────────────────────────────────────────
if [ -z "$APP_BIN_DIR" ]; then
  note '跳过归档核对（没设 HUB_APP_BIN_DIR）'; skipped=$((skipped + 1))
else
  [ -n "${R_FILE:-}" ] || die "要先核对发布记录才知道文件名（设 HUB_ADMIN_BASE）"
  [ -f "$APP_BIN_DIR/$R_FILE" ] || die "归档目录里没有 $R_FILE（$APP_BIN_DIR）"
  APP_SHA="$(sha256sum "$APP_BIN_DIR/$R_FILE" | awk '{print $1}')"
  [ "$APP_SHA" = "$SHA" ] || die "归档文件 sha256 不一致（$APP_SHA ≠ $SHA）"
  say "Hub 归档   ✓ $APP_BIN_DIR/$R_FILE"
fi

# ── 3. 公网下载 ─────────────────────────────────────────────────────────────
if [ -z "$PUBLIC_BASE" ]; then
  note '跳过公网下载核对（没设 HUB_DOWNLOAD_PUBLIC_BASE）'; skipped=$((skipped + 1))
else
  [ -n "${R_FILE:-}" ] || die "要先核对发布记录才知道文件名（设 HUB_ADMIN_BASE）"
  URL="${PUBLIC_BASE%/}${PUBLIC_PATH%/}/$R_FILE"
  TMP_APK="$(mktemp)"
  trap 'rm -f "$TMP_APK"' EXIT
  CODE="$(curl "${CURL_TLS[@]}" --noproxy '*' -sS -m 300 -o "$TMP_APK" -w '%{http_code}' "$URL" || echo 000)"
  [ "$CODE" = "200" ] || die "公网下载 HTTP $CODE（$URL）"
  DL_SHA="$(sha256sum "$TMP_APK" | awk '{print $1}')"
  [ "$DL_SHA" = "$SHA" ] || die "公网下载的 sha256 不一致（$DL_SHA ≠ $SHA）"
  say "公网下载   ✓ $URL（200，sha256 一致）"
fi

say ''
if [ "$skipped" -gt 0 ]; then
  say "核对完成（跳过 $skipped 项；想全核对就设 HUB_ADMIN_BASE / HUB_APP_BIN_DIR / HUB_DOWNLOAD_PUBLIC_BASE）"
else
  say "全部一致 ✓"
fi
