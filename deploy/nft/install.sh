#!/usr/bin/env bash
# 出网规则安装器（02 §4）：把 dshhub.nft 装成**系统**服务 dshhub-egress.service。
#
# 为什么是系统服务：nftables 规则属于内核网络栈，跟某个用户会话无关；开机要在容器起来之前加载。
# 为什么脚本里能用 sudo：**由部署者在普通终端执行**（不通过自动化会话跑 sudo、不动 /etc）。
#
# 用法：
#   deploy/nft/install.sh --dry-run      # 只做语法检查 + 打印将要安装的内容（不需要 root）
#   deploy/nft/install.sh --print        # 只打印渲染后的规则与单元文件
#   sudo deploy/nft/install.sh           # 安装到 /etc/dshhub + /etc/systemd/system 并立即启用
#   sudo deploy/nft/install.sh --no-enable   # 只安装，不 enable/start
#
# 卸载：
#   sudo systemctl disable --now dshhub-egress.service
#   sudo rm -f /etc/systemd/system/dshhub-egress.service /etc/dshhub/dshhub.nft
#   sudo systemctl daemon-reload
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RULES_SRC="$SELF_DIR/dshhub.nft"
UNIT_SRC="$SELF_DIR/dshhub-egress.service"

RULES_DEST="${DSHHUB_NFT_DEST:-/etc/dshhub/dshhub.nft}"
UNIT_DIR="${DSHHUB_UNIT_DIR:-/etc/systemd/system}"
UNIT_DEST="$UNIT_DIR/dshhub-egress.service"
NFT_BIN="${DSHHUB_NFT_BIN:-}"
if [ -z "$NFT_BIN" ]; then
  NFT_BIN="$(command -v nft || true)"
fi
[ -n "$NFT_BIN" ] || NFT_BIN=/usr/sbin/nft

MODE=install
ENABLE=1

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --print) MODE=print ;;
    --no-enable) ENABLE=0 ;;
    --rules-dest)
      shift
      [ $# -gt 0 ] || die "--rules-dest 需要一个路径"
      RULES_DEST="$1"
      ;;
    --unit-dir)
      shift
      [ $# -gt 0 ] || die "--unit-dir 需要一个目录"
      UNIT_DIR="$1"
      UNIT_DEST="$UNIT_DIR/dshhub-egress.service"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

[ -f "$RULES_SRC" ] || die "找不到规则文件：$RULES_SRC"
[ -f "$UNIT_SRC" ] || die "找不到单元模板：$UNIT_SRC"

# 单元模板里的占位符 → 实际路径；只用 | 作分隔符，路径里不会有 |
render_unit() {
  sed -e "s|__NFT_BIN__|$NFT_BIN|g" -e "s|__RULES_DEST__|$RULES_DEST|g" "$UNIT_SRC"
}

print_rules() {
  printf '### %s\n' "$RULES_SRC"
  cat "$RULES_SRC"
  printf '\n### %s（渲染后）\n' "$UNIT_SRC"
  render_unit
  printf '\n### 安装位置\n'
  printf '规则：%s\n单元：%s\n' "$RULES_DEST" "$UNIT_DEST"
}

# 语法检查：非 root 时 nft 会在 netlink 缓存初始化处失败，但**解析已经完成**，
# 所以「除了 cache initialization failed 之外没有任何 Error」即可认为语法通过；
# 完整的语义校验（集合类型、hook 是否可用）需要 root，见 --dry-run 的提示。
check_syntax() {
  if [ ! -x "$NFT_BIN" ]; then
    printf 'WARN: 找不到 nft（%s），跳过语法检查；装好 nftables 后重跑此脚本\n' "$NFT_BIN"
    return 0
  fi
  local out rc real
  set +e
  out="$("$NFT_BIN" -c -f "$RULES_SRC" 2>&1)"
  rc=$?
  set -e
  real="$(printf '%s\n' "$out" | grep -v 'netlink: Error: cache initialization failed' | grep -v '^[[:space:]]*$' || true)"
  if [ -n "$real" ]; then
    printf 'FAIL: nft 规则有问题（%s -c -f %s 退出码 %s）：\n%s\n' "$NFT_BIN" "$RULES_SRC" "$rc" "$real" >&2
    return 1
  fi
  printf 'OK  : nft 语法检查通过（%s -c -f）\n' "$NFT_BIN"
  if [ "$(id -u)" -ne 0 ]; then
    printf '注意: 当前不是 root，只能做语法解析；完整校验请执行 sudo %s --dry-run\n' "$0"
  fi
  return 0
}

case "$MODE" in
  print)
    print_rules
    exit 0
    ;;
  dry-run)
    printf '== 干跑：只检查、不写任何文件、不动内核规则 ==\n\n'
    check_syntax
    printf '\n'
    print_rules
    printf '\n要真正安装： sudo %s\n' "$0"
    exit 0
    ;;
esac

# ── 真正的安装（需要 root） ──────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "安装需要 root：sudo $0   （只检查用 --dry-run）"
[ -x "$NFT_BIN" ] || die "找不到 nft（$NFT_BIN）：sudo apt install nftables"

printf '== 安装出网规则 ==\n'
check_syntax

install -d -m 0755 -- "$(dirname -- "$RULES_DEST")"
install -m 0644 -- "$RULES_SRC" "$RULES_DEST"
install -d -m 0755 -- "$UNIT_DIR"
render_unit >"$UNIT_DEST.tmp"
chmod 0644 "$UNIT_DEST.tmp"
mv -f "$UNIT_DEST.tmp" "$UNIT_DEST"
printf 'OK  : 规则 → %s\nOK  : 单元 → %s\n' "$RULES_DEST" "$UNIT_DEST"

systemctl daemon-reload
if [ "$ENABLE" -eq 1 ]; then
  systemctl enable dshhub-egress.service
  # restart 而不是 start：改过规则后重新灌一遍（oneshot + RemainAfterExit，ExecStop 会先删表）
  systemctl restart dshhub-egress.service
  systemctl --no-pager --full status dshhub-egress.service || true
else
  printf '跳过 enable/start（--no-enable）；手动生效： systemctl start dshhub-egress.service\n'
fi

printf '\n== 验证 ==\n'
printf 'sudo nft list table inet dshhub          # 应看到 fwd4/in 两条链与 blocked4 集合\n'
printf 'scripts/security-gate.sh                 # 10 §A 的 A0–A10（由你执行）\n'
