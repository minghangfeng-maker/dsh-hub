#!/usr/bin/env bash
# 把 dsh-codex-pilot 以 link 方式装进一个 DSH profile（默认 profile 名 web）。
# 用法：tools/install.sh [profile]      装完后重启你的 DSH 进程 / 服务
set -euo pipefail
PROFILE="${1:-web}"
P="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$P/package.json" ] || { echo "找不到 profile：$P"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S)
cp -p "$P/package.json" "$P/package.json.bak-before-codex-pilot-$TS"
python3 - "$P/package.json" "$PLUGIN" <<'PY'
import json, sys
path, plugin = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d.setdefault('dependencies', {})['@local/dsh-codex-pilot'] = f'link:{plugin}'
bundles = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if '@local/dsh-codex-pilot' not in bundles: bundles.append('@local/dsh-codex-pilot')
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False); open(path, 'a').write('\n')
PY
mkdir -p "$P/node_modules/@local"
ln -sfn "$PLUGIN" "$P/node_modules/@local/dsh-codex-pilot"
# 先存下来再 grep：pipefail 下 grep -q 提前关管道会让 dsh 收到 SIGPIPE，整条管道判为失败
CONFIG=$(dsh "$PROFILE" --dump-config 2>/dev/null || true)
if grep -q "id: codex-pilot$" <<<"$CONFIG"; then
  echo "已装进 profile $PROFILE（备份：package.json.bak-before-codex-pilot-$TS）。重启 DSH 后生效。"
else
  echo "组合配置里没看到 codex-pilot，请检查"; exit 1
fi
