#!/usr/bin/env bash
# ============================================================================
# 打**正式签名**的 release APK（内置入口由环境的 VITE_HUB_ORIGINS 决定）
#
#   export DSH_HUB_APP_KEYSTORE=$HOME/keys/dsh-hub-app-release.jks
#   export DSH_HUB_APP_KEYSTORE_PASSWORD='…'
#   # key 口令与密钥库口令不同时再说：export DSH_HUB_APP_KEY_PASSWORD='…'
#   export JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk
#   export VITE_HUB_ORIGINS=https://hub.example.com     # 内置入口（不设 = 登录页手填）
#   bash scripts/release/build-release.sh
#
# 环境变量：
#   DSH_HUB_APP_KEYSTORE          必填，release keystore 路径
#   DSH_HUB_APP_KEYSTORE_PASSWORD 必填，密钥库口令（只从环境读，不写进仓库）
#   DSH_HUB_APP_KEY_PASSWORD      可选，key 口令（默认与密钥库口令相同）
#   DSH_HUB_APP_KEY_ALIAS         默认 dsh-hub-app-release
#   DSH_HUB_APP_VERSION           默认取 apps/mobile/android/app/build.gradle
#   DSH_HUB_APP_VERSION_CODE      默认取 apps/mobile/android/app/build.gradle
#   DSH_HUB_APP_OUT_DIR           默认 scripts/release/out
#   JAVA_HOME / ANDROID_HOME      必填（构建工具链；脚本不猜任何本机路径）
#   GRADLE_USER_HOME              可选
#   HEAVY_BUILD_LOCK              可选，设了就 flock 这把锁（vite 与 gradle 串行）
#   VITE_HUB_ORIGINS / VITE_HUB_ORIGIN  可选，APK 内置的 Hub 入口
#
# 做的事：vite build → cap sync → gradle assembleRelease（注入签名）
#        → apksigner 校验（必须验签通过、且证书是我们自己的）→ sha256 → 复制到 out/
#
# 安全：
#   * 口令只从环境变量读，写进临时属性文件（0600）给 gradle，**构建结束立刻删除**；
#   * 口令不进命令行（ps 里看不到）、不 echo、不写进仓库、不出现在日志里；
#   * 构建结束打印 apksigner 的证书指纹，方便和 gen-keystore.sh 的指纹对照。
# ============================================================================
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${DSH_HUB_APP_OUT_DIR:-$ROOT/scripts/release/out}"
GRADLE_FILE="$ROOT/apps/mobile/android/app/build.gradle"
PNPM="${PNPM:-pnpm}"

VERSION="${DSH_HUB_APP_VERSION:-$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' "$GRADLE_FILE" | head -1)}"
VERSION_CODE="${DSH_HUB_APP_VERSION_CODE:-$(sed -n 's/.*versionCode \([0-9]*\).*/\1/p' "$GRADLE_FILE" | head -1)}"
ALIAS="${DSH_HUB_APP_KEY_ALIAS:-dsh-hub-app-release}"
KEYSTORE="${DSH_HUB_APP_KEYSTORE:-}"
STORE_PASS="${DSH_HUB_APP_KEYSTORE_PASSWORD:-}"
KEY_PASS="${DSH_HUB_APP_KEY_PASSWORD:-$STORE_PASS}"

say() { printf '%s\n' "$*"; }
die() { printf '\n失败：%s\n' "$*" >&2; exit 1; }

# ── 0. 前置检查（都在改任何东西之前）─────────────────────────────────────────
[ -n "$JAVA_HOME" ] || die "请先设置 JAVA_HOME（需要 JDK 21）"
[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] || die "请先设置 ANDROID_HOME（或 ANDROID_SDK_ROOT）"
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

[ -n "$KEYSTORE" ] || die "请先 export DSH_HUB_APP_KEYSTORE=<keystore 路径>（没有就先生成：bash scripts/release/gen-keystore.sh）"
[ -n "$STORE_PASS" ] || die "请先 export DSH_HUB_APP_KEYSTORE_PASSWORD=<密钥库口令>（口令不会显示、也不会写进仓库）"
KEYSTORE="${KEYSTORE/#\~/$HOME}"
[ -f "$KEYSTORE" ] || die "keystore 不存在：$KEYSTORE"
command -v keytool >/dev/null 2>&1 || die "找不到 keytool（JAVA_HOME/bin 里应该有）"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "版本号应是 1.2.3 这种三段式，当前：$VERSION" ;;
esac
case "$VERSION_CODE" in
  ''|*[!0-9]*) die "DSH_HUB_APP_VERSION_CODE 必须是正整数，当前：$VERSION_CODE" ;;
esac

mkdir -p "$OUT_DIR"
BUILD_TOOLS="$(ls -1d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS" ] || die "Android SDK build-tools 不存在：$ANDROID_HOME/build-tools"
APKSIGNER="${BUILD_TOOLS}apksigner"
AAPT2="${BUILD_TOOLS}aapt2"

say "版本：$VERSION（versionCode $VERSION_CODE）"
if [ -n "${VITE_HUB_ORIGINS:-}" ]; then
  say "内置入口：$VITE_HUB_ORIGINS"
elif [ -n "${VITE_HUB_ORIGIN:-}" ]; then
  say "内置入口（单入口覆盖）：$VITE_HUB_ORIGIN"
else
  say "内置入口：（无）—— 首次启动时由登录页让用户填服务器地址"
fi
say "keystore：$KEYSTORE（alias $ALIAS）"
say "build-tools：$BUILD_TOOLS"

# ── 1. 临时签名属性文件（0600，构建结束即删）────────────────────────────────
PASS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dshhub-signing-XXXXXX")"
SIGN_PROPS="$PASS_DIR/release-signing.properties"
cleanup() { rm -rf "$PASS_DIR"; }
trap cleanup EXIT INT TERM
{
  printf 'storeFile=%s\n' "$KEYSTORE"
  printf 'storePassword=%s\n' "$STORE_PASS"
  printf 'keyAlias=%s\n' "$ALIAS"
  printf 'keyPassword=%s\n' "$KEY_PASS"
  printf 'versionCode=%s\n' "$VERSION_CODE"
  printf 'versionName=%s\n' "$VERSION"
} >"$SIGN_PROPS"
chmod 600 "$SIGN_PROPS"

# 先用 keytool 验一次口令（口令错了要在花几分钟构建之前就知道）
printf '%s' "$STORE_PASS" >"$PASS_DIR/store.pass"
keytool -list -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:file "$PASS_DIR/store.pass" >/dev/null 2>&1 \
  || die "keystore 口令不对，或者没有这个 alias：$ALIAS（口令不打印）"
EXPECTED_FP="$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:file "$PASS_DIR/store.pass" 2>/dev/null | awk -F': ' '/SHA256:|SHA-256:/{print $2; exit}')"
rm -f "$PASS_DIR/store.pass"
say "证书 SHA-256：${EXPECTED_FP:-（读不到）}"

run_locked() { # $@ = 要执行的命令
  if [ -n "${HEAVY_BUILD_LOCK:-}" ]; then
    flock "$HEAVY_BUILD_LOCK" "$@"
  else
    "$@"
  fi
}

# ── 2. Web 构建（入口由环境的 VITE_HUB_ORIGINS 决定）────────────────────────
say "== 1/4 构建 Web =="
[ -x "$ROOT/packages/mobile-ui/node_modules/.bin/vite" ] || die "packages/mobile-ui 还没装依赖（先在仓库根跑 $PNPM install）"
(cd "$ROOT/packages/mobile-ui" && run_locked ./node_modules/.bin/vite build)

# ── 3. 同步进 Android 工程 ──────────────────────────────────────────────────
say "== 2/4 cap sync =="
(cd "$ROOT/apps/mobile" && ./node_modules/.bin/cap sync android >/dev/null)

# ── 4. Gradle release 构建（注入签名）──────────────────────────────────────
say "== 3/4 gradle :app:assembleRelease（注入签名，--max-workers=2）=="
# -Pkotlin.compiler.execution.strategy=in-process：某些受限环境下 Kotlin 的独立编译守护进程
# 起不来（Gradle 会卡在 newDaemonConnection，表现为构建「挂住」不动）；改成在 Gradle 进程内
# 编译，稳定且不需要额外的守护进程，版本/签名结果不受影响。
(cd "$ROOT/apps/mobile/android" && run_locked ./gradlew :app:assembleRelease --max-workers=2 --console=plain \
  -Pkotlin.compiler.execution.strategy=in-process \
  --init-script "$ROOT/scripts/release/signing.init.gradle" \
  -PdshReleaseSigningProps="$SIGN_PROPS")

APK="$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || die "没找到 release APK：$APK"

# ── 5. 校验：签名、包名、版本、sha256 ───────────────────────────────────────
say "== 4/4 校验 =="
"$APKSIGNER" verify --verbose --print-certs "$APK" >"$PASS_DIR/verify.txt" 2>&1 \
  || { cat "$PASS_DIR/verify.txt" >&2; die "apksigner 验签失败"; }
grep -q 'Verified using v2 scheme (APK Signature Scheme v2): true' "$PASS_DIR/verify.txt" \
  || say '  注意：没有 v2 签名（老系统仍可装）'
grep -q 'Verified using v1 scheme (JAR signing): true' "$PASS_DIR/verify.txt" \
  || say '  v1（JAR）签名：关闭（minSdk 24，AGP 默认只签 v2/v3；Android 7+ 不受影响）'
ACTUAL_FP="$(awk -F': ' '/Signer #1 certificate SHA-256 digest:/{print $2; exit}' "$PASS_DIR/verify.txt")"
[ -n "$ACTUAL_FP" ] || die "读不到 APK 的签名证书指纹"
if [ -n "$EXPECTED_FP" ]; then
  norm_expected="$(printf '%s' "$EXPECTED_FP" | tr -d ':' | tr 'A-F' 'a-f')"
  norm_actual="$(printf '%s' "$ACTUAL_FP" | tr -d ':' | tr 'A-F' 'a-f')"
  [ "$norm_expected" = "$norm_actual" ] \
    || die "APK 的签名证书与 keystore 不一致（expected $EXPECTED_FP / actual $ACTUAL_FP）"
fi

BADGING="$("$AAPT2" dump badging "$APK" 2>/dev/null | head -3 || true)"
PKG="$(printf '%s' "$BADGING" | sed -n "s/.*package: name='\([^']*\)'.*/\1/p")"
VC="$(printf '%s' "$BADGING" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
VN="$(printf '%s' "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
[ "$VC" = "$VERSION_CODE" ] || die "APK 的 versionCode 是 $VC，期望 $VERSION_CODE"
[ "$VN" = "$VERSION" ] || die "APK 的 versionName 是 $VN，期望 $VERSION"
say "  包名 $PKG · versionName $VN · versionCode $VC"

DEST="$OUT_DIR/dsh-hub-app-$VERSION-$VERSION_CODE-release.apk"
cp -f "$APK" "$DEST"
SHA="$(sha256sum "$DEST" | awk '{print $1}')"

say ""
say "完成。"
say "  APK      $DEST"
say "  大小     $(du -h "$DEST" | awk '{print $1}')"
say "  sha256   $SHA"
say "  签名证书 ${ACTUAL_FP}"
say ""
say "下一步：把 APK 传到 Hub（管理端「系统设置 → 安卓 App」上传并发布，或直接调"
say "  POST /api/admin/mobile/app/releases），发布后主页与 App 的更新提示会自动指向它。"
say "  上传时填：version=$VERSION，versionCode=$VERSION_CODE。"
