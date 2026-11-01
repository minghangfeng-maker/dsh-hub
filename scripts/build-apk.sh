#!/usr/bin/env bash
# ============================================================================
# 构建 debug APK：vite build → cap sync android → gradle assembleDebug
#
# 版本号来自 apps/mobile/android/app/build.gradle（versionCode / versionName），
# 正式包由 scripts/release/build-release.sh 注入版本号与签名。
#
# 用法：
#   bash scripts/build-apk.sh                       # 用环境里的 VITE_HUB_ORIGINS（不设 = 登录页手填）
#   VITE_HUB_ORIGINS=https://hub.example.com bash scripts/build-apk.sh
#   bash scripts/build-apk.sh mock                  # 自包含开发版：进程内假 Hub，不联网
#
# 明文 http 只在 **debug** 壳里放行（app/src/debug/AndroidManifest.xml），
# 所以连局域网 http Hub 的联调包必须是 debug 构建；release 构建不带这个 overlay。
#
# 产物：
#   apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
#   并复制到 $APK_OUT_DIR（默认 scripts/release/out）：
#     dsh-hub-app-<versionName>-<versionCode>-debug.apk
#
# 环境变量（都只从环境读，脚本里不写死任何本机路径）：
#   JAVA_HOME / ANDROID_HOME（或 ANDROID_SDK_ROOT）/ GRADLE_USER_HOME  —— 构建工具链
#   ANDROID_USER_HOME（可选）
#   HEAVY_BUILD_LOCK  —— 设了就 flock 这把锁（vite 与 gradle 都是重型构建，建议串行）
#   APK_OUT_DIR       —— 产物复制目录；设为空串则不复制
#   PNPM              —— pnpm 命令（默认 pnpm）
#   VITE_HUB_ORIGINS / VITE_HUB_ORIGIN —— Hub 入口（见 apps/mobile/README.md 的「配置入口」）
# ============================================================================
set -euo pipefail

MODE="${1:-}"
ROOT="$(dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")")"
OUT_DIR="${APK_OUT_DIR-$ROOT/scripts/release/out}"
PNPM="${PNPM:-pnpm}"

case "$MODE" in
  '') ;;
  mock) export VITE_HUB_ORIGIN=mock ;;
  -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *)
    echo "未知参数：$MODE（只支持 mock；要内置入口用环境变量 VITE_HUB_ORIGINS）" >&2
    exit 2
    ;;
esac

# ── 工具链：全部来自环境变量，脚本不猜任何路径 ──────────────────────────────
if [ -z "${JAVA_HOME:-}" ]; then
  echo "失败：请先设置 JAVA_HOME（Capacitor 8 / AGP 需要 JDK 21）" >&2
  exit 1
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  echo "失败：请先设置 ANDROID_HOME（或 ANDROID_SDK_ROOT）指向 Android SDK" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

VERSION_NAME="$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' "$ROOT/apps/mobile/android/app/build.gradle" | head -1)"
VERSION_CODE="$(sed -n 's/.*versionCode \([0-9]*\).*/\1/p' "$ROOT/apps/mobile/android/app/build.gradle" | head -1)"
APK_NAME="dsh-hub-app-${VERSION_NAME:-0.0.0}-${VERSION_CODE:-0}-debug.apk"

if [ "${VITE_HUB_ORIGIN:-}" = "mock" ]; then
  echo "构建模式：mock（VITE_HUB_ORIGIN=mock，不访问网络）"
elif [ -n "${VITE_HUB_ORIGINS:-}" ]; then
  echo "构建模式：内置入口 VITE_HUB_ORIGINS=$VITE_HUB_ORIGINS"
else
  echo "构建模式：无内置入口（APK 首次启动时由登录页让用户填服务器地址）"
fi

run_locked() { # $@ = 要执行的命令
  if [ -n "${HEAVY_BUILD_LOCK:-}" ]; then
    flock "$HEAVY_BUILD_LOCK" "$@"
  else
    "$@"
  fi
}

echo "== 1/3 构建 Web（vite） =="
[ -x "$ROOT/packages/mobile-ui/node_modules/.bin/vite" ] || {
  echo "packages/mobile-ui 还没装依赖：先在仓库根跑 $PNPM install" >&2
  exit 1
}
(cd "$ROOT/packages/mobile-ui" && run_locked ./node_modules/.bin/vite build)

echo "== 2/3 同步到 Android 工程（cap sync） =="
(cd "$ROOT/apps/mobile" && ./node_modules/.bin/cap sync android)

echo "== 3/3 打包 debug APK（gradle，--max-workers=2） =="
# -Pkotlin.compiler.execution.strategy=in-process：某些受限环境下 Kotlin 的独立编译守护进程
# 起不来，Gradle 会**无声挂住**（无输出、无进度）；改成在 Gradle 进程内编译，结果不变。
(cd "$ROOT/apps/mobile/android" && run_locked ./gradlew :app:assembleDebug --max-workers=2 --console=plain \
  -Pkotlin.compiler.execution.strategy=in-process)

APK="$ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "失败：没找到 $APK" >&2; exit 1; }

echo
echo "APK:  $APK"
ls -l "$APK"
sha256sum "$APK"

if [ -n "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR"
  cp -f "$APK" "$OUT_DIR/$APK_NAME"
  echo "复制到：$OUT_DIR/$APK_NAME"
fi
