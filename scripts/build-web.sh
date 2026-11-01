#!/usr/bin/env bash
# ============================================================================
# 构建「手机网页版」产物（packages/mobile-ui/dist-web），由 Hub 托管在 `/m/`。
#
#   bash scripts/build-web.sh
#
# 与 APK 构建的区别：
#   * `VITE_TARGET=web` → 构建期常量 `__DSH_WEB__=true`（`IS_WEB_BUILD`）；
#   * **不设** `VITE_HUB_ORIGINS`：正式网页版的入口永远是页面自己的 origin
#     （Hub 同源托管在 `/m/`）。要联调别的 Hub 再用 `VITE_HUB_ORIGIN=...` 临时覆盖；
#   * 产物目录 `packages/mobile-ui/dist-web`（不碰 APK 用的 `dist`）；
#   * 额外产出 `dist-web/version.json`（`{version, build, builtAt}`），由 vite 插件生成。
#
# 产物自检：
#   1. MockHub 不在产物里（复用 scripts/verify-no-mock.sh 的断言，传目录）；
#   2. version.json 存在、JSON 合法、version/build 非空、与 index.html 同目录（相对引用能取到）；
#   3. 网页专属代码确实在（反向抽查：网页分支没被折掉 —— 折掉说明构建参数没生效）。
#
# 环境变量（都可选）：
#   PNPM              pnpm 命令（默认 pnpm；也可以用绝对路径指到自己的 pnpm）
#   HEAVY_BUILD_LOCK  设了就 flock 这把锁（和 APK/gradle 构建串行）
#   VITE_HUB_ORIGIN   临时联调用的入口覆盖（正式发布不要设）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/packages/mobile-ui"
OUT="$UI/dist-web"
PNPM="${PNPM:-pnpm}"

# 正式网页版入口 = 页面 origin：不能带 VITE_HUB_ORIGIN（除非调用方显式给了别的值）
if [ -n "${VITE_HUB_ORIGIN:-}" ]; then
  echo "注意：VITE_HUB_ORIGIN=$VITE_HUB_ORIGIN（只用于联调；正式发布不要带）" >&2
fi
export VITE_TARGET=web

run_locked() { # $@ = 要执行的命令
  if [ -n "${HEAVY_BUILD_LOCK:-}" ]; then
    flock "$HEAVY_BUILD_LOCK" "$@"
  else
    "$@"
  fi
}

echo "== 1/3 构建网页版（vite，outDir=dist-web） =="
if [ ! -x "$UI/node_modules/.bin/vite" ]; then
  echo "packages/mobile-ui 还没装依赖：先在仓库根跑 $PNPM install" >&2
  exit 1
fi
(cd "$UI" && export VITE_TARGET=web && run_locked ./node_modules/.bin/vite build)

echo "== 2/3 自检：产物里没有 MockHub（scripts/verify-no-mock.sh dist-web） =="
bash "$ROOT/scripts/verify-no-mock.sh" "$OUT"

echo "== 3/3 自检：version.json 与网页专属代码 =="
VERSION_FILE="$OUT/version.json"
[ -f "$VERSION_FILE" ] || { echo "失败：没有产出 $VERSION_FILE（vite 插件没生效？）" >&2; exit 1; }
node - "$VERSION_FILE" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const raw = fs.readFileSync(file, 'utf8')
let info
try {
  info = JSON.parse(raw)
} catch {
  console.error(`失败：${file} 不是合法 JSON：${raw.slice(0, 120)}`)
  process.exit(1)
}
for (const key of ['version', 'build', 'builtAt']) {
  if (typeof info[key] !== 'string' || info[key].trim() === '') {
    console.error(`失败：version.json 缺字段 ${key}（${raw.trim()}）`)
    process.exit(1)
  }
}
if (!/^\d+\.\d+\.\d+/.test(info.version)) {
  console.error(`失败：version.json 的 version 不像版本号：${info.version}`)
  process.exit(1)
}
console.log(`  version.json: ${raw.trim()}`)
NODE
# index.html 与 version.json 必须在同一目录（客户端用相对路径 './version.json' 取）
[ -f "$OUT/index.html" ] || { echo "失败：dist-web/index.html 不存在" >&2; exit 1; }
# 反向抽查：网页专属代码必须在产物里 —— 没有说明 VITE_TARGET=web 没生效（会静默发出一个
# APK 语义的包）。用两个标记，任意一个在就算过：`version.json`（lib/web-version 的拉取路径）
# 与「手机网页版」（设备名前缀）。
if grep -rqaF -- 'version.json' "$OUT" || grep -rqaF -- '手机网页版' "$OUT"; then
  echo "  网页专属代码：在（version.json 拉取路径 / 设备名格式已在产物里）"
else
  echo "失败：产物里没有网页版专属代码（VITE_TARGET=web 没生效？）" >&2
  exit 1
fi

echo
echo "网页版产物：$OUT"
du -sh "$OUT"
echo "托管：Hub 的 HUB_MOBILE_WEB_DIR 指向这个目录即可（不设时默认就是这个目录），见 README。"
