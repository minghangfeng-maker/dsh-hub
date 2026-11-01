#!/usr/bin/env bash
#
# dsh-memory 一键安装。
#
#   ./install.sh [profile] [--home <DSH_HOME>]
#
# 做的事：
#   1. 把同目录下的 dsh-memory-*.tgz 复制到 <DSH_HOME>/plugin-packages/（长期路径，
#      因为 profile 里记的依赖是 file: 绝对路径）；
#   2. 调 `dsh plugin --profile <profile> add <tgz>`：pnpm 安装 + 自动写依赖 +
#      自动把包加进 dsh.profile.bundles；
#   3. 打印重启与验证命令（不会替你重启宿主进程）。
#
# 环境变量：
#   DSH_HOME   不改的话默认 ~/.dsh；--home 等价。
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="web"
dsh_home="${DSH_HOME:-$HOME/.dsh}"

usage() {
  cat <<'EOF'
dsh-memory 一键安装

  ./install.sh [profile] [--home <DSH_HOME>]

做的事：
  1. 把同目录下的 dsh-memory-*.tgz 复制到 <DSH_HOME>/plugin-packages/（长期路径，
     因为 profile 里记的依赖是 file: 绝对路径）；
  2. 调 `dsh plugin --profile <profile> add <tgz>`：pnpm 安装 + 自动写依赖 +
     自动把包加进 dsh.profile.bundles；
  3. 打印重启与验证命令（不会替你重启宿主进程）。

参数：
  profile        要装的 profile 名，默认 web
  --home <dir>   DSH_HOME，默认取环境变量 DSH_HOME，否则 ~/.dsh
  -h, --help     显示本说明
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --home)
      [[ $# -ge 2 ]] || { echo "缺少 --home 的值" >&2; exit 2; }
      dsh_home="$2"
      shift 2
      ;;
    --home=*)
      dsh_home="${1#*=}"
      shift
      ;;
    -*)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      profile="$1"
      shift
      ;;
  esac
done

# 归一 DSH_HOME：展开 ~/，要求绝对路径（dsh 不会替你展开引号里的 ~）
case "$dsh_home" in
  "~") dsh_home="$HOME" ;;
  "~/"*) dsh_home="$HOME/${dsh_home#\~/}" ;;
esac
if [[ "$dsh_home" != /* ]]; then
  echo "DSH_HOME 必须是绝对路径：$dsh_home" >&2
  exit 2
fi

tgzs="$(ls -t "$here"/dsh-memory-*.tgz 2>/dev/null || true)"
if [[ -z "$tgzs" ]]; then
  echo "找不到插件包：$here/dsh-memory-*.tgz" >&2
  echo "请把本脚本和 tgz 放在同一个目录里运行。" >&2
  exit 1
fi
tgz="$(printf '%s\n' "$tgzs" | head -n 1)"
count="$(printf '%s\n' "$tgzs" | wc -l | tr -d ' ')"
if [[ "$count" -gt 1 ]]; then
  echo "警告：脚本目录里有 $count 个 tgz，按修改时间取最新的：$(basename "$tgz")" >&2
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "找不到 dsh 命令，先把 DSH 的 bin 目录加进 PATH。" >&2
  exit 1
fi
dsh_version="$(dsh --version 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
if [[ -n "$dsh_version" ]]; then
  echo "→ dsh：$dsh_version（本包验证过 0.2.1-rc.2）"
  if [[ "$dsh_version" != "0.2.1-rc.2" ]]; then
    echo "警告：本包只在 DSH 0.2.1-rc.2 上验证过，当前是 $dsh_version；先看 INSTALL.md 的版本说明再装。" >&2
  fi
else
  echo "→ dsh：读不到版本（继续；本包验证过 0.2.1-rc.2）"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "警告：PATH 里没有 pnpm。命令行安装固定用 PATH 里的 pnpm，安装大概率会失败" >&2
  echo "      （Web 插件页那条安装路径才可以用 profile 里 plugin-manager 的 pnpmCommand 兜底）。" >&2
fi
if [[ ! -f "$dsh_home/profiles/$profile/package.json" ]]; then
  echo "找不到 profile：$dsh_home/profiles/$profile/package.json" >&2
  echo "先用该 profile 启动一次 DSH（Web 用户打开过即可），或用 --home 指定 DSH_HOME。" >&2
  exit 1
fi

dest="$dsh_home/plugin-packages"
mkdir -p "$dest"
target="$dest/$(basename "$tgz")"
if [[ "$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")" != "$target" ]]; then
  cp -f "$tgz" "$target"
  echo "→ 插件包已复制到长期路径：$target"
fi

echo "→ DSH_HOME=$dsh_home dsh plugin --profile $profile add file:$target"
DSH_HOME="$dsh_home" dsh plugin --profile "$profile" add "file:$target"

echo
echo "装好了。还差最后一步：重启 profile「$profile」的 DSH 实例（宿主进程），再刷新页面。"
echo "  验证（不用重启）：DSH_HOME=$dsh_home dsh --profile $profile --dump-config | grep -A8 '@local/dsh-memory'"
echo "  冒烟（自带临时数据目录）：node $dsh_home/profiles/$profile/node_modules/@local/dsh-memory/tools/smoke.mjs"
echo "  数据目录：~/.dsh/memory（不跟随 DSH_HOME；要改就在 profile 的 cordis.patch.yml 给 memory 行配 home:，或设 DSH_MEMORY_HOME）"
echo "  详细说明见同目录 INSTALL.md。"
