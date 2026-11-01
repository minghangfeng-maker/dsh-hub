#!/usr/bin/env bash
# ============================================================================
# e2e 统一运行器：自动挑空闲端口、自己起 mock hub / vite / headless Chrome、跑完按 PID 收干净。
#
#   bash scripts/e2e-run.sh <名字...>        # 例：bash scripts/e2e-run.sh thread send-anchor
#   bash scripts/e2e-run.sh all              # 全部（见下面 ALL）
#   bash scripts/e2e-run.sh -j 3 all         # 并行 3 个（每个一套独立端口）
#   bash scripts/e2e-run.sh --list           # 列出可跑的名字
#
# 为什么要有它（0.4.8 复盘，2026-10-28）：
#   * 各脚本的默认端口互相重叠，别的 worktree 留下的 vite 一直占着 5247/5250……
#     「跑通了」其实连的是别人的 dev server（跑的是别人的代码）；
#   * 一半脚本要手动先起三件套、一半自己起，每个任务都在重新摸索，单这一项 0.4.8 耗了 ~15 分钟。
#
# 做法：
#   * 端口：从 E2E_PORT_BASE（默认 5400）/ CDP 9400 起按任务序号分段，**绑定探测确认空闲**再用；
#   * 「自带拉起」的脚本（SELF）：传 --hub-port/--app-port/--cdp，让它自己起（它知道自己要的 Chrome 参数）；
#     「需要外部服务」的脚本（MANUAL）：这里起 mock hub + vite(dev) + Chrome，校验 vite 的 cwd
#     确实是**当前这个 worktree**，再传 --app/--hub/--cdp；
#   * 每个脚本的工作目录与 --out 都在 $E2E_OUT/<名字>/（默认 <repo>/.e2e-runs/<时间戳>/），不弄脏仓库；
#   * 环境纪律内置：NODE_ENV=development、摘代理、每个脚本 timeout（E2E_TIMEOUT，默认 600 秒）。
#
# 退出码：全部通过 0，否则 1。汇总在 $E2E_OUT/summary.txt。
# ============================================================================
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.14.0/bin}"
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"
CHROME="${CHROME:-$HOME/.local/bin/google-chrome}"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export NODE_ENV=development

# 自己会拉起服务的脚本（接受 --hub-port/--app-port/--cdp）
#
# web-smoke（WP54 手机网页版）也属于这类：它自己 `build-web`、自己起「在 /m/ 托管产物的
# mock hub」和 Chrome —— 网页版是**同源**的，不能共用下面那套「vite dev + 跨源 hub」。
# web-settings 测的是手机网页版（WP54）：脚本自己给 vite 传 VITE_TARGET=web，
# 不需要在 shell 里设环境变量（`VITE_TARGET=web bash scripts/e2e-run.sh web-settings` 也能跑）。
# web-files 是手机网页版（WP54 / W3）：跑的是网页构建，用
#   VITE_TARGET=web bash scripts/e2e-run.sh web-files
# 脚本起的 vite 继承环境变量；它自己也默认 VITE_TARGET=web，所以不带这个变量也能跑。
# cockpit-embed（WP56d 管理座舱嵌入模式）也属于这一类：它自己 build-web、自己起「托管 /m/ 的
# mock hub + 一个同源父页面（/__cockpit/parent）」和 Chrome，跑的必须是真产物而不是 dev server。
SELF=" conn voice tts tts-stream send-anchor net-diag origin web-smoke cockpit-embed web-settings web-files "
# 需要外部 mock hub + vite + Chrome 的脚本（接受 --app/--hub/--cdp）
# web-nav / web-pwa 是手机网页版（WP54）：vite 必须带 VITE_TARGET=web 起（见 vite_target_of）；
# web-pwa 另外自己跑两次 vite build（网页版 + APK 版，约 1~2 秒）核对产物
MANUAL=" a1 a2 chip thread outbox info session-state web-nav web-pwa "
# 默认全集
ALL="a1 a2 chip thread outbox info session-state conn voice tts tts-stream send-anchor net-diag origin web-smoke cockpit-embed web-settings web-files web-nav web-pwa"
# 个别脚本对 mock hub 的特殊要求
wake_ms_of() { case "$1" in outbox) echo 6000 ;; *) echo 1200 ;; esac; }
# 个别脚本要特殊的构建参数：跑手机网页版构建（VITE_TARGET=web → __DSH_WEB__）
vite_target_of() { case "$1" in web-nav|web-pwa) echo web ;; *) echo "" ;; esac; }

JOBS=1
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    -j) JOBS="$2"; shift 2 ;;
    -j*) JOBS="${1#-j}"; shift ;;
    --list) echo "可跑：$SELF$MANUAL" | tr -s ' '; echo "all = $ALL"; exit 0 ;;
    all) read -r -a more <<<"$ALL"; NAMES+=("${more[@]}"); shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
[ ${#NAMES[@]} -gt 0 ] || { echo "用法：bash scripts/e2e-run.sh [-j N] <名字...|all>（--list 看名字）" >&2; exit 2; }
for n in "${NAMES[@]}"; do
  case "$SELF$MANUAL" in *" $n "*) ;; *) echo "未知 e2e：$n（--list 看名字）" >&2; exit 2 ;; esac
  [ -f "$ROOT/scripts/e2e-$n.mjs" ] || { echo "找不到 scripts/e2e-$n.mjs" >&2; exit 2; }
done
[ -x "$ROOT/packages/mobile-ui/node_modules/.bin/vite" ] || { echo "packages/mobile-ui 还没装依赖（pnpm install）" >&2; exit 2; }

OUT="${E2E_OUT:-$ROOT/.e2e-runs/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
TIMEOUT="${E2E_TIMEOUT:-600}"
PORT_BASE="${E2E_PORT_BASE:-5400}"
CDP_BASE="${E2E_CDP_BASE:-9400}"

port_free() {
  python3 -c 'import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try: s.bind(("0.0.0.0", int(sys.argv[1])))
except OSError: sys.exit(1)' "$1"
}
# 从 start 起找连续 n 个空闲端口
free_ports() {
  local p="$1" n="$2" ok i
  while :; do
    ok=1
    for ((i = 0; i < n; i++)); do port_free $((p + i)) || { ok=0; break; }; done
    [ $ok = 1 ] && { seq "$p" $((p + n - 1)) | tr '\n' ' '; return; }
    p=$((p + n))
  done
}
wait_http() {
  local url="$1" tries="${2:-200}"
  for ((i = 0; i < tries; i++)); do
    curl -sf --noproxy '*' --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.15
  done
  return 1
}

run_one() { # idx name
  local idx="$1" name="$2" dir="$OUT/$2" status=0
  mkdir -p "$dir"
  local hub app cdp
  read -r hub app < <(free_ports $((PORT_BASE + idx * 10)) 2)
  read -r cdp < <(free_ports $((CDP_BASE + idx * 10)) 1)
  local script="$ROOT/scripts/e2e-$name.mjs" log="$dir/run.log"
  echo "[$name] hub:$hub app:$app cdp:$cdp → $log"
  if [[ "$SELF" == *" $name "* ]]; then
    (cd "$dir" && timeout -k 10 "$TIMEOUT" node "$script" --hub-port "$hub" --app-port "$app" --cdp "$cdp" --out "$dir/out") >"$log" 2>&1
    status=$?
  else
    local pids=()
    PORT="$hub" TICK_MS=12 WAKE_MS="$(wake_ms_of "$name")" node "$ROOT/apps/mock-hub/server.mjs" >"$dir/hub.log" 2>&1 &
    pids+=($!)
    # VITE_TARGET 为空串 = 普通（APK）构建；web-nav 要 `web`。空串对 vite 是「没设」的等价物。
    local vt
    vt="$(vite_target_of "$name")"
    (cd "$ROOT/packages/mobile-ui" && VITE_HUB_ORIGIN="http://127.0.0.1:$hub" VITE_TARGET="$vt" exec ./node_modules/.bin/vite --port "$app" --strictPort --host 127.0.0.1) >"$dir/vite.log" 2>&1 &
    local vite_pid=$!
    pids+=("$vite_pid")
    "$CHROME" --headless=new --remote-debugging-port="$cdp" --user-data-dir="$dir/chrome-profile" \
      --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
      --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
      about:blank >"$dir/chrome.log" 2>&1 &
    pids+=($!)
    if ! wait_http "http://127.0.0.1:$hub/__test/health" || ! wait_http "http://127.0.0.1:$app/" 300 \
      || ! wait_http "http://127.0.0.1:$cdp/json/version"; then
      echo "服务没起来（看 $dir/{hub,vite,chrome}.log）" >"$log"
      status=1
    elif [ "$(readlink "/proc/$vite_pid/cwd" 2>/dev/null)" != "$ROOT/packages/mobile-ui" ]; then
      echo "vite 不是这个 worktree 起的（cwd 不对），拒绝跑" >"$log"
      status=1
    else
      (cd "$dir" && timeout -k 10 "$TIMEOUT" node "$script" --app "http://127.0.0.1:$app" \
        --hub "http://127.0.0.1:$hub" --cdp "$cdp" --out "$dir/out") >"$log" 2>&1
      status=$?
    fi
    kill "${pids[@]}" 2>/dev/null
    sleep 0.3
    kill -9 "${pids[@]}" 2>/dev/null
    rm -rf "$dir/chrome-profile"
  fi
  local result
  result="$(grep -E '结果.*[0-9]+/[0-9]+' "$log" | tail -1)"
  if [ -z "$result" ]; then # 没有「结果 X/Y」汇总行的脚本：自己数 ✓ / ✗
    result="结果：$(grep -c '^✓' "$log")/$(( $(grep -c '^✓' "$log") + $(grep -c '^✗' "$log") )) 通过（按 ✓/✗ 计）"
    err="$(grep -v '^✓' "$log" | grep -m1 -E '失败：|Error:' | cut -c1-140)"; [ -z "$err" ] || result="$result；$err"
  fi
  local mark="✓"; [ "$status" = 0 ] || mark="✗"
  echo "$mark $name（exit $status）$result" | tee -a "$OUT/summary.txt"
  return "$status"
}

echo "e2e：${NAMES[*]}（并行 $JOBS，输出 $OUT）"
t0=$SECONDS
fail=0
running=0
idx=0
for name in "${NAMES[@]}"; do
  run_one "$idx" "$name" &
  idx=$((idx + 1))
  running=$((running + 1))
  if [ "$running" -ge "$JOBS" ]; then
    wait -n || fail=1
    running=$((running - 1))
  fi
done
while [ "$running" -gt 0 ]; do
  wait -n || fail=1
  running=$((running - 1))
done
echo "== 用时 $((SECONDS - t0)) 秒；汇总 $OUT/summary.txt"
exit "$fail"
