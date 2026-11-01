#!/usr/bin/env bash
# ============================================================================
# 生成 DSH Hub App 的**正式签名**用 release keystore（用户自己运行）
#
#   bash scripts/release/gen-keystore.sh
#   bash scripts/release/gen-keystore.sh --keystore ~/keys/dsh-hub-app-release.jks
#
# 这个脚本**只生成密钥库**，不做构建；私钥文件必须自己备份：
#   * 丢了 keystore → 以后发的包无法覆盖安装（Android 只认同一个签名），只能换包名重新上架；
#   * 泄露了 keystore → 任何人都能签冒充你的包。
# 请把 .jks 与两个口令分别备份到**两个地方**（例如密码管理器 + 离线 U 盘/加密云盘）。
#
# 口令输入：脚本用 `read -s` 交互读取，**不回显、不落盘、不打印**；
# 也不会把口令写进 shell 历史（没有把口令放到命令行参数里）。
#
# 生成之后怎么用（把值放进环境变量，构建脚本才读得到）：
#   export DSH_HUB_APP_KEYSTORE=$HOME/keys/dsh-hub-app-release.jks
#   export DSH_HUB_APP_KEYSTORE_PASSWORD='…'     # 密钥库口令
#   export DSH_HUB_APP_KEY_PASSWORD='…'          # key 口令（与上面相同时可省略）
#   bash scripts/release/build-release.sh
# ============================================================================
set -euo pipefail
umask 077

ALIAS_DEFAULT="dsh-hub-app-release"
KEYSTORE_DEFAULT="$HOME/keys/dsh-hub-app-release.jks"

KEYSTORE="$KEYSTORE_DEFAULT"
ALIAS="$ALIAS_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --keystore)
      [ $# -ge 2 ] || { printf '%s\n' '--keystore 需要一个路径' >&2; exit 2; }
      KEYSTORE="$2"; shift 2 ;;
    --alias)
      [ $# -ge 2 ] || { printf '%s\n' '--alias 需要一个名字' >&2; exit 2; }
      ALIAS="$2"; shift 2 ;;
    -h|--help)
      awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '\n失败：%s\n' "$*" >&2; exit 1; }

# keytool 来自 JDK（不需要 Android SDK）：优先 JAVA_HOME，其次 PATH
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
  KEYTOOL="$JAVA_HOME/bin/keytool"
elif command -v keytool >/dev/null 2>&1; then
  KEYTOOL="$(command -v keytool)"
else
  die "找不到 keytool（装一个 JDK 21，或设 JAVA_HOME）"
fi

KEYSTORE="${KEYSTORE/#\~/$HOME}"
if [ -e "$KEYSTORE" ]; then
  die "keystore 已存在：$KEYSTORE（**不要覆盖**：覆盖等于换签名。要重建请先自己备份并删掉它）"
fi

say "将生成 release keystore："
say "  路径   $KEYSTORE"
say "  别名   $ALIAS"
say "  算法   RSA 4096 / SHA256withRSA，有效期 10000 天（约 27 年）"
say ""
say "接下来要输入三个口令（输入时不回显）："
say "  1) 密钥库口令（keystore password）——至少 6 位，建议 20 位以上"
say "  2) 同一个口令再输一次"
say "  3) key 口令（key password）——直接回车 = 与密钥库口令相同（推荐）"
say ""

read -r -s -p "密钥库口令： " PASS1; printf '\n'
[ "${#PASS1}" -ge 6 ] || die "口令至少 6 位"
read -r -s -p "再输一次：  " PASS2; printf '\n'
[ "$PASS1" = "$PASS2" ] || die "两次输入不一致"
read -r -s -p "key 口令（回车＝同上）： " PASSK; printf '\n'
[ -n "$PASSK" ] || PASSK="$PASS1"

mkdir -p "$(dirname "$KEYSTORE")"
chmod 700 "$(dirname "$KEYSTORE")" 2>/dev/null || true

# -storepass / -keypass 用 :file: 语法从临时文件读，避免口令出现在进程命令行（ps 可见）
PASSDIR="$(mktemp -d)"
trap 'rm -rf "$PASSDIR"' EXIT
printf '%s' "$PASS1" >"$PASSDIR/store.pass"
printf '%s' "$PASSK" >"$PASSDIR/key.pass"
chmod 600 "$PASSDIR/store.pass" "$PASSDIR/key.pass"

say ""
say "生成中（keytool 可能需要几秒钟做 RSA 4096 密钥对）…"
"$KEYTOOL" -genkeypair \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 \
  -dname "CN=DSH Hub App, OU=DSH Hub, O=DSH Hub, L=Shanghai, ST=Shanghai, C=CN" \
  -storetype PKCS12 \
  -storepass:file "$PASSDIR/store.pass" \
  -keypass:file "$PASSDIR/key.pass" \
  >/dev/null 2>&1 || die "keytool 生成失败（口令太短？磁盘只读？）"

chmod 600 "$KEYSTORE"
FINGERPRINT="$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -alias "$ALIAS" \
  -storepass:file "$PASSDIR/store.pass" 2>/dev/null | awk -F': ' '/SHA256:|SHA-256:/{print $2; exit}')"

say ""
say "完成。"
say "  文件        $KEYSTORE（权限 600）"
say "  SHA-256     ${FINGERPRINT:-（读不到指纹，可稍后自己 keytool -list 看）}"
say ""
say "════════ 请立刻做这两件事 ════════"
say "1. 备份：把 $KEYSTORE 复制到**两个**地方（密码管理器附件 + 离线 U 盘/加密云盘）。"
say "   丢了以后发布的包无法覆盖安装；泄露了别人能签冒牌包。"
say "2. 记下口令：keystore 口令与 key 口令存进密码管理器（脚本没有、也不该把它们写到任何文件里）。"
say ""
say "构建正式包（口令只放环境变量，不要写进仓库里的文件）："
say "  export DSH_HUB_APP_KEYSTORE=\"$KEYSTORE\""
say "  export DSH_HUB_APP_KEYSTORE_PASSWORD='…'"
say "  # 若 key 口令与密钥库口令不同：export DSH_HUB_APP_KEY_PASSWORD='…'"
say "  bash scripts/release/build-release.sh"
