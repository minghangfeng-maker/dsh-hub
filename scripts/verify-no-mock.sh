#!/usr/bin/env bash
# ============================================================================
# 验证「正式产物里没有 MockHub」（0.2.17）。
#
# 用法：
#   bash scripts/verify-no-mock.sh                 # 检查 packages/mobile-ui/dist（默认）
#   bash scripts/verify-no-mock.sh <dir>           # 检查别的构建目录
#   bash scripts/verify-no-mock.sh --expect-mock   # 反过来：mock 构建必须**包含**它
#
# 检查的是 `core/src/mock/` 里**只属于 mock Hub 的字符串字面量**：
# 类名会被压缩器改名，所以只认字面量。任何一处出现就说明 MockHub 被打进了产物。
#
# 背景：0.2.16 及以前 `packages/mobile-core/src/factory.ts` 用运行期判断 `isMockOrigin(origin)` 选实现，
# Vite 折不掉，900 行的 MockHub 就随正式 APK 一起发布了。现在 mock 分支是构建期常量
# （`__DSH_MOCK_HUB__`，见 packages/mobile-ui/vite.config.ts），正式构建里整块被删。
# ============================================================================
set -euo pipefail

MODE="absent"
DIR=""
for arg in "$@"; do
  case "$arg" in
    --expect-mock) MODE="present" ;;
    -*) echo "未知参数：$arg" >&2; exit 1 ;;
    *) DIR="$arg" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${DIR:-$ROOT/packages/mobile-ui/dist}"
[ -d "$DIR" ] || { echo "构建目录不存在：$DIR（先跑 vite build）" >&2; exit 1; }

# 只属于 mock Hub 的字面量（见 packages/mobile-core/src/mock/mock-hub.ts 与 mock/content.ts）
MARKERS=(
  '书房的 Windows'          # DESKTOP_NODE.name（mock 的桌面设备）
  'dv_mock_desktop_01'      # DESKTOP_NODE.id
  '收到！我先按你的要求'      # MOCK_REPLY 正文开头（用户消息气泡里的假回复）
  'ratelimit'               # mock 专属账号（限流演示）
  'changepw'                # mock 专属账号（必须改密码）
)

echo "检查目录：$DIR"
found=0
for marker in "${MARKERS[@]}"; do
  # -a：产物是二进制安全的（含中文 UTF-8），按文本搜
  if grep -rqaF -- "$marker" "$DIR"; then
    hits="$(grep -rlaF -- "$marker" "$DIR" | tr '\n' ' ')"
    echo "  命中：$marker  →  $hits"
    found=1
  else
    echo "  未命中：$marker"
  fi
done

if [ "$MODE" = "present" ]; then
  [ "$found" = "1" ] || { echo "" >&2; echo "失败：mock 构建里**没有** MockHub（mock APK 会连不上任何东西）" >&2; exit 1; }
  echo ""
  echo "通过：mock 构建包含 MockHub（预期）"
  exit 0
fi

[ "$found" = "0" ] || { echo "" >&2; echo "失败：正式产物里出现了 MockHub 的字面量（体积与攻击面都白送）" >&2; exit 1; }
echo ""
echo "通过：正式产物里没有 MockHub"
