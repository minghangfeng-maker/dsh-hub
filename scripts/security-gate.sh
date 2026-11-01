#!/usr/bin/env bash
# scripts/security-gate.sh —— 10 §A / 02 §3 的安全闸门（A0–A10）
#
#   scripts/security-gate.sh              # 跑全部 A0–A10，输出 PASS/FAIL 表
#   scripts/security-gate.sh --list       # 只列出检查项
#   scripts/security-gate.sh --plan       # 只打印将要执行的命令（不动系统）
#   scripts/security-gate.sh --only A1,A4 # 只跑指定项
#   scripts/security-gate.sh --keep       # 跑完保留测试容器/网络（排查用）
#
# **由你在普通终端执行**（11 §4：DSH 会话不做逃逸测试、不执行 sudo、不连公网入口）。
# A0 需要 root 读 nft 规则，脚本会用 sudo 提示你输密码（缓存 15 分钟，只问一次）。
# A3 会把 /mnt/c/Windows/System32/whoami.exe 复制进测试容器执行 —— 这是唯一能证明
# 「容器里跑不了 Windows 程序」的办法，任何一次出现 Windows 侧输出即 FAIL（02 §3）。
#
# 只碰自己的对象：容器 dshhub-test-gate-a/-b/-oom、网络 dshhub-test-gate-net，
# 结束（含 Ctrl-C）时全部删除。不会动 dshhub-u*、dshhub-users、别的会话的容器。
#
# 退出码：0 = A0–A10 全部 PASS；1 = 有 FAIL 或 SKIP（闸门未通过，不要开放注册）。
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

GATE_PREFIX="dshhub-test-gate"
NET_NAME="${GATE_PREFIX}-net"
# A2 要证明「容器里看不到宿主家目录」：拿本机 $HOME 当探针路径（容器里的 HOME 是 /home/dsh）
HOST_HOME="${HOST_HOME:-${HOME:-/root}}"
# 02 §4：闸门网络必须落在 nft 匹配的 10.213.0.0/16 里，又不能和默认用户网段 10.213.0.0/20 重叠。
# （11 §2 的“测试网段 10.219.18.0/24”不适用于闸门：出网规则只匹配 10.213.0.0/16。）
NET_SUBNET="${GATE_SUBNET:-10.213.16.0/24}"
CONTAINER_A="${GATE_PREFIX}-a"
CONTAINER_B="${GATE_PREFIX}-b"
CONTAINER_OOM="${GATE_PREFIX}-oom"
INNER_PORT=3000
KEEP=0
PLAN_ONLY=0
LIST_ONLY=0
ONLY=""
IMAGE="${GATE_IMAGE:-}"
# A10 里顺带看一眼 Hub 还在不在（没跑就只打印一行，不影响判定）
HUB_HEALTH_URL="${HUB_HEALTH_URL:-http://127.0.0.1:7700/api/health}"

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

declare -a RESULTS=()
FAIL_COUNT=0
SKIP_COUNT=0

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

plan() {
  if [ "$PLAN_ONLY" -eq 1 ]; then
    printf 'PLAN | %s\n' "$*"
  fi
}

record() { # record <id> <PASS|FAIL|SKIP> <说明>
  local id="$1" state="$2" detail="$3"
  RESULTS+=("${id}|${state}|${detail}")
  case "$state" in
    PASS) printf '  [PASS] %-3s %s\n' "$id" "$detail" ;;
    FAIL)
      printf '  [FAIL] %-3s %s\n' "$id" "$detail"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      ;;
    SKIP)
      printf '  [SKIP] %-3s %s\n' "$id" "$detail"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      ;;
  esac
}

section() { printf '\n── %s\n' "$*"; }

selected() { # selected A1 → 0=要跑
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

CHECK_LIST=(
  'A0|nft 规则已加载且与 02 §4 一致（sudo nft list table inet dshhub）'
  'A1|容器内 /mnt/c、/mnt/wsl、/run/WSL 均不存在'
  'A2|容器内看不到宿主家目录'
  'A3|容器内执行 Windows PE（whoami.exe）必须失败'
  'A4|容器连家庭局域网 192.168.1.1 与宿主 LAN IP:3080 失败'
  'A5|容器连网关与宿主 LAN IP 的 7700/7443/3080/17891/22 全失败；DNS 正常'
  'A6|容器 A 连容器 B 的 IP:3000 失败'
  'A7|容器出网正常（api.deepseek.com 有 HTTP 状态码）'
  'A8|容器能访问 registry.npmmirror.com（HTTP 200）'
  'A9|容器隔离基线：cap-drop/security-opt/配额/无 docker.sock/无端口发布'
  'A10|容器内存耗尽只影响自己（OOMKilled），其它容器仍可用'
)

while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      LIST_ONLY=1
      ;;
    --plan)
      PLAN_ONLY=1
      ;;
    --keep)
      KEEP=1
      ;;
    --only)
      shift
      [ $# -gt 0 ] || {
        printf -- '--only 需要一个列表，例如 --only A1,A4\n' >&2
        exit 2
      }
      ONLY="${1// /}"
      ;;
    --image)
      shift
      [ $# -gt 0 ] || {
        printf -- '--image 需要一个镜像名\n' >&2
        exit 2
      }
      IMAGE="$1"
      ;;
    --subnet)
      shift
      [ $# -gt 0 ] || {
        printf -- '--subnet 需要一个 CIDR\n' >&2
        exit 2
      }
      NET_SUBNET="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数：%s（--help 看用法）\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '安全闸门检查项（10 §A）：\n'
  for item in "${CHECK_LIST[@]}"; do
    printf '  %s\n' "${item/|/  }"
  done
  exit 0
fi

# ── 环境自检 ────────────────────────────────────────────────────────────────
printf 'DSH Hub 安全闸门（10 §A、02 §3）\n'
printf '仓库: %s\n' "$REPO_DIR"
printf '测试容器: %s / %s / %s\n' "$CONTAINER_A" "$CONTAINER_B" "$CONTAINER_OOM"
printf '测试网络: %s（%s）\n' "$NET_NAME" "$NET_SUBNET"

command -v docker >/dev/null 2>&1 || {
  printf '找不到 docker 命令，无法执行闸门。\n' >&2
  exit 2
}
if ! docker info >/dev/null 2>&1; then
  printf 'docker 不可达（不在 docker 组或 Docker 没启动）。先跑 deploy/prereq.sh。\n' >&2
  exit 2
fi

# 镜像：优先用已有的 dshhub/runtime:*（与用户容器同规格），否则必须显式 --image
if [ -z "$IMAGE" ]; then
  IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^dshhub/runtime:' | head -n 1 || true)"
fi
if [ -z "$IMAGE" ]; then
  printf '找不到 dshhub/runtime:* 镜像；请先在管理后台构建一个 DSH 版本，或用 --image 指定。\n' >&2
  exit 2
fi
printf '使用镜像: %s\n' "$IMAGE"

ROUTE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)"
# 真实「宿主局域网 IP」：默认路由的源地址优先；过滤回环、Docker 网桥与保留段（那些不是家庭局域网）
HOST_LAN_IPS="$(printf '%s\n%s\n' "$ROUTE_IP" "$(hostname -I 2>/dev/null | tr ' ' '\n')" |
  awk 'NF' | grep -vE '^(127\.|10\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | sort -u || true)"
if [ -z "$HOST_LAN_IPS" ] && [ -n "$ROUTE_IP" ]; then
  HOST_LAN_IPS="$ROUTE_IP"
fi
printf '宿主非回环 IP: %s\n' "$(printf '%s' "$HOST_LAN_IPS" | tr '\n' ' ')"

# node 一行代码：TCP 连接测试（退出码 0=连上了，1=被拒/不可达，3=超时）
NODE_TCP='const net=require("net");const[h,p]=process.argv.slice(1);const s=net.connect({host:h,port:Number(p)});const t=setTimeout(()=>{console.error("timeout");s.destroy();process.exit(3)},3000);s.on("connect",()=>{clearTimeout(t);console.log("connected");s.destroy();process.exit(0)});s.on("error",e=>{clearTimeout(t);console.error(e.code||e.message);process.exit(1)})'
# node 一行代码：HTTP(S) 状态码（curl 不在时兜底）
NODE_HTTP='const u=process.argv[1];const m=u.startsWith("https")?require("https"):require("http");const r=m.get(u,{timeout:15000},res=>{console.log(res.statusCode);res.destroy();process.exit(0)});r.on("error",e=>{console.error(e.message);process.exit(1)});r.on("timeout",()=>{r.destroy();process.exit(2)})'

dnode() { # dnode <容器> <代码> [args...]
  local c="$1" code="$2"
  shift 2
  docker exec "$c" node -e "$code" "$@"
}

http_reachable() { # http_reachable <容器> <url> → 0=拿到了 HTTP 响应（=不该通却通了）
  http_status "$1" "$2" >/dev/null
}

tcp_connects() { # tcp_connects <容器> <host> <port> → 0=连上了
  dnode "$1" "$NODE_TCP" "$2" "$3" >/dev/null 2>&1
}

http_status() { # http_status <容器> <url> → 打印状态码
  local c="$1" url="$2" out
  if out="$(docker exec "$c" curl -sS -m 15 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" &&
    printf '%s' "$out" | grep -qE '^[1-5][0-9][0-9]$'; then
    printf '%s' "$out"
    return 0
  fi
  out="$(dnode "$c" "$NODE_HTTP" "$url" 2>/dev/null)" &&
    printf '%s' "$out" | grep -qE '^[1-5][0-9][0-9]$' && {
    printf '%s' "$out"
    return 0
  }
  return 1
}

# ── 建测试网络与容器（规格与用户容器一致，02 §2） ──────────────────────────
# --tmpfs 的挂载选项本身就用逗号分隔，是一个数组元素，不是写错的分隔符
# shellcheck disable=SC2054
RUN_FLAGS=(
  --user 1000:1000
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,size=512m
  --memory 512m
  --memory-swap 512m
  --pids-limit 256
  --cpus 1
  --init
  --restart no
  --log-driver json-file
  --log-opt max-size=10m
  --log-opt max-file=3
  --label dshhub.managed=0
  --label dshhub.test.gate=1
  --env DSH_TELEMETRY_DISABLED=1
  --env HOME=/tmp
)
# 用户容器的 /tmp 是 noexec，可执行的可写位置是绑定挂载的 /home/dsh 与 /workspace（instances/spec.ts）。
# 测试容器 A/B 也各挂一个宿主临时目录到 /workspace，A3 才是在「用户真能执行程序的地方」测互操作。
GATE_WS_ROOT=""

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    printf '\n--keep：保留 %s / %s / %s 与网络 %s\n' "$CONTAINER_A" "$CONTAINER_B" "$CONTAINER_OOM" "$NET_NAME"
    [ -n "$GATE_WS_ROOT" ] && printf '        工作区临时目录 %s\n' "$GATE_WS_ROOT"
    return
  fi
  printf '\n清理测试对象…\n'
  for c in "$CONTAINER_OOM" "$CONTAINER_B" "$CONTAINER_A"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  [ -n "$GATE_WS_ROOT" ] && rm -rf -- "$GATE_WS_ROOT"
}
trap cleanup EXIT

setup_env() {
  section '准备测试容器（与用户容器同规格）'
  if ! docker network inspect "$NET_NAME" >/dev/null 2>&1; then
    plan "docker network create --subnet $NET_SUBNET $NET_NAME"
    if [ "$PLAN_ONLY" -eq 0 ]; then
      docker network create --subnet "$NET_SUBNET" "$NET_NAME" >/dev/null ||
        printf 'WARN: 创建网络失败（子网 %s 可能被占用）\n' "$NET_SUBNET" >&2
    fi
  fi
  if [ "$PLAN_ONLY" -eq 0 ] && [ -z "$GATE_WS_ROOT" ]; then
    GATE_WS_ROOT="$(mktemp -d -t dshhub-gate-ws.XXXXXX)"
  fi
  for c in "$CONTAINER_A" "$CONTAINER_B"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
    plan "docker run -d --name $c --network $NET_NAME ${RUN_FLAGS[*]} -v <临时目录>/$c:/workspace --entrypoint sleep $IMAGE infinity"
    if [ "$PLAN_ONLY" -eq 0 ]; then
      mkdir -p "$GATE_WS_ROOT/$c"
      docker run -d --name "$c" --network "$NET_NAME" "${RUN_FLAGS[@]}" -v "$GATE_WS_ROOT/$c:/workspace" \
        --entrypoint sleep "$IMAGE" infinity >/dev/null || {
        printf 'ERROR: 启动 %s 失败\n' "$c" >&2
        exit 2
      }
    fi
  done
  if [ "$PLAN_ONLY" -eq 0 ]; then
    # 容器 B 里起一个 :3000 监听，A6 才有意义（否则“连不上”是因为没人听）
    docker exec -d "$CONTAINER_B" node -e \
      'require("http").createServer((_q,s)=>s.end("gate-b")).listen(3000,"0.0.0.0")' || true
  fi
}

container_ip() {
  docker inspect "$1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null
}

gateway_ip() {
  docker network inspect "$NET_NAME" --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null
}

# ── A0：nft 规则 ────────────────────────────────────────────────────────────
check_a0() {
  section 'A0 nft 出网规则（02 §4）'
  local out
  plan "$SUDO nft list table inet dshhub"
  if [ "$PLAN_ONLY" -eq 1 ]; then
    record A0 SKIP '--plan：未实际读取 nft'
    return
  fi
  out="$($SUDO nft list table inet dshhub 2>&1)"
  if ! printf '%s' "$out" | grep -q 'table inet dshhub'; then
    record A0 FAIL "读不到 table inet dshhub（先 sudo deploy/nft/install.sh）：$(printf '%s' "$out" | head -n 1)"
    return
  fi
  local missing=()
  printf '%s' "$out" | grep -q 'chain fwd4' || missing+=('chain fwd4')
  printf '%s' "$out" | grep -q 'chain in' || missing+=('chain in')
  printf '%s' "$out" | grep -q '10.213.0.0/16' || missing+=('USERS=10.213.0.0/16')
  printf '%s' "$out" | grep -q 'blocked4' || missing+=('set blocked4')
  # nft ≥ 0.9.6 把数值优先级按命名基准回显：-10 列出来是 `priority filter - 10`（本机 1.0.9 实测），两种写法都认
  printf '%s' "$out" | grep -qE 'hook forward priority (filter - 10|-10);' || missing+=('forward hook priority -10')
  printf '%s' "$out" | grep -qE 'hook input priority (filter - 10|-10);' || missing+=('input hook priority -10')
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
    printf '%s' "$out" | grep -q "$net" || missing+=("blocked4 缺 $net")
  done
  printf '%s' "$out" | grep -q 'fd00::/8' || missing+=('IPv6 防御性丢弃 fd00::/8')
  if [ "${#missing[@]}" -gt 0 ]; then
    record A0 FAIL "规则与 02 §4 不一致：${missing[*]}"
  else
    record A0 PASS 'table inet dshhub 已加载，forward/input 钩子与 blocked4 集合与 02 §4 一致'
  fi
}

# ── A1/A2：宿主目录不可见 ───────────────────────────────────────────────────
check_a1() {
  section 'A1 容器内看不到 /mnt/c、/mnt/wsl、/run/WSL'
  local bad=() p out
  for p in /mnt/c /mnt/wsl /run/WSL; do
    out="$(docker exec "$CONTAINER_A" sh -c "ls -d $p 2>&1" || true)"
    docker exec "$CONTAINER_A" test -e "$p" >/dev/null 2>&1 && bad+=("$p")
    printf '      %s → %s\n' "$p" "$out"
  done
  if [ "${#bad[@]}" -eq 0 ]; then
    record A1 PASS '三个路径都不存在'
  else
    record A1 FAIL "容器里能看到：${bad[*]}（Windows 盘/互操作目录被挂进来了）"
  fi
}

check_a2() {
  section 'A2 容器内看不到宿主家目录'
  local out
  out="$(docker exec "$CONTAINER_A" sh -c "ls $HOST_HOME 2>&1" || true)"
  printf '      ls %s → %s\n' "$HOST_HOME" "$out"
  if docker exec "$CONTAINER_A" test -e "$HOST_HOME" >/dev/null 2>&1; then
    record A2 FAIL "容器里能看到 $HOST_HOME"
  else
    record A2 PASS "$HOST_HOME 不存在"
  fi
}

# ── A3：Windows PE 必须跑不起来 ─────────────────────────────────────────────
check_a3() {
  section 'A3 容器内执行 Windows PE（whoami.exe）必须失败'
  local src=/mnt/c/Windows/System32/whoami.exe
  if [ ! -f "$src" ]; then
    record A3 SKIP "找不到 $src（没有挂 Windows C 盘？）—— 无法证明互操作被挡住，按未通过处理"
    return
  fi
  # 放在 /workspace（绑定挂载、可执行）：/tmp 是 noexec，在那里测只能证明 noexec，证明不了互操作被挡住。
  # 也不能用 docker cp：容器是 --read-only，dockerd 直接拒绝（“container rootfs is marked read-only”），
  # 改由容器内进程从 stdin 写入；文件属主就是容器用户，chmod 不需要 root。
  local dir=/workspace exe=/workspace/whoami.exe
  plan "docker exec -i $CONTAINER_A sh -c 'cat > $exe && chmod 755 $exe' < $src"
  local cp_err
  if ! cp_err="$(docker exec -i "$CONTAINER_A" sh -c "cat > $exe && chmod 755 $exe" < "$src" 2>&1)"; then
    record A3 SKIP "whoami.exe 写进容器失败（$cp_err）—— 无法证明互操作被挡住，按未通过处理"
    return
  fi

  # 控制组：证明同一目录里的普通程序**确实能**执行（排除 noexec / 权限造成的假通过）
  local probe
  probe="$(docker exec "$CONTAINER_A" sh -c "printf '#!/bin/sh\\nexit 42\\n' > $dir/gate-probe.sh && chmod 755 $dir/gate-probe.sh && $dir/gate-probe.sh; echo rc=\$?" 2>&1)"
  if ! printf '%s' "$probe" | grep -q 'rc=42'; then
    record A3 SKIP "容器内 $dir 执行不了普通程序（$probe）—— A3 无法判定，按未通过处理"
    return
  fi
  if ! docker exec "$CONTAINER_A" test -x "$exe" >/dev/null 2>&1; then
    record A3 SKIP 'whoami.exe 在容器内不可执行（chmod 没成功）—— A3 无法判定，按未通过处理'
    return
  fi
  printf '      控制组：%s 里的 shell 脚本能执行（rc=42），whoami.exe 有执行位\n' "$dir"

  local -a labels=('直接执行' '两层子 shell' 'tini 下执行')
  local -a cmds=(
    'direct'
    'subshell'
    'tini'
  )
  local win_re='[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+'
  local failed=() passed=() i out rc
  for i in 0 1 2; do
    case "${cmds[$i]}" in
      direct) out="$(docker exec "$CONTAINER_A" "$exe" 2>&1)"; rc=$? ;;
      subshell) out="$(docker exec "$CONTAINER_A" sh -c "sh -c $exe" 2>&1)"; rc=$? ;;
      tini) out="$(docker exec "$CONTAINER_A" /usr/bin/tini -- "$exe" 2>&1)"; rc=$? ;;
    esac
    printf '      [%s] rc=%s 输出：%s\n' "${labels[$i]}" "$rc" "$(printf '%s' "$out" | head -n 2 | tr '\n' ' ')"
    if [ "$rc" -eq 0 ]; then
      failed+=("${labels[$i]}(rc=0)")
    elif printf '%s' "$out" | grep -qE "$win_re"; then
      failed+=("${labels[$i]}(出现 Windows 账号输出)")
    else
      passed+=("${labels[$i]}")
    fi
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    record A3 FAIL "容器里跑出了 Windows 程序：${failed[*]} —— 不要开放注册，走 B 计划（02 §3、08 附录 A）"
  else
    record A3 PASS "三种方式都失败（${passed[*]}）；无 Windows 侧输出"
  fi
}

# ── A4/A5/A6：横向移动必须失败 ──────────────────────────────────────────────
check_a4() {
  section 'A4 容器连家庭局域网 / Windows 主机失败'
  local bad=() targets=('http://192.168.1.1/')
  local ip
  while IFS= read -r ip; do
    [ -n "$ip" ] && targets+=("http://$ip:3080/")
  done <<<"$HOST_LAN_IPS"
  local url
  for url in "${targets[@]}"; do
    if http_reachable "$CONTAINER_A" "$url"; then
      bad+=("$url 竟然通了")
      printf '      %s → 通了（不应该）\n' "$url"
    else
      printf '      %s → 已阻断\n' "$url"
    fi
  done
  if [ "${#bad[@]}" -eq 0 ]; then
    record A4 PASS "全部被阻断（${#targets[@]} 个目标）"
  else
    record A4 FAIL "${bad[*]}"
  fi
}

check_a5() {
  section 'A5 容器连宿主端口全失败、DNS 正常'
  local gw bad=() hosts=()
  gw="$(gateway_ip)"
  [ -n "$gw" ] && hosts+=("$gw")
  local ip
  while IFS= read -r ip; do
    [ -n "$ip" ] && hosts+=("$ip")
  done <<<"$HOST_LAN_IPS"
  local h port
  for h in "${hosts[@]}"; do
    for port in 7700 7443 3080 17891 22; do
      if tcp_connects "$CONTAINER_A" "$h" "$port"; then
        bad+=("$h:$port 通了")
        printf '      %s:%s → 通了（不应该）\n' "$h" "$port"
      else
        printf '      %s:%s → 已阻断\n' "$h" "$port"
      fi
    done
  done
  # 网关 53（Docker 内置 DNS 在容器内是 127.0.0.11；这里额外验证网关本身）
  if [ -n "$gw" ]; then
    if tcp_connects "$CONTAINER_A" "$gw" 53; then
      printf '      %s:53 → 通（podman 场景需要，允许）\n' "$gw"
    else
      printf '      %s:53 → 未开放（Docker 用 127.0.0.11，正常）\n' "$gw"
    fi
  fi
  # DNS 必须能用（否则容器装不了包）
  local dns_ok=1
  if docker exec "$CONTAINER_A" getent hosts registry.npmmirror.com >/dev/null 2>&1; then
    dns_ok=0
    printf '      DNS registry.npmmirror.com → 解析成功\n'
  else
    printf '      DNS registry.npmmirror.com → 解析失败\n'
    bad+=('DNS 解析失败')
  fi
  if [ "${#bad[@]}" -eq 0 ] && [ "$dns_ok" -eq 0 ]; then
    record A5 PASS '宿主端口全部阻断，DNS 正常'
  else
    record A5 FAIL "${bad[*]:-DNS 异常}"
  fi
}

check_a6() {
  section 'A6 容器之间不能互访'
  local ip
  ip="$(container_ip "$CONTAINER_B")"
  if [ -z "$ip" ]; then
    record A6 SKIP '拿不到容器 B 的 IP'
    return
  fi
  # 先证明监听确实在（控制变量）：B 自己连自己的 :3000 应该成功
  if dnode "$CONTAINER_B" "$NODE_TCP" 127.0.0.1 "$INNER_PORT" >/dev/null 2>&1; then
    printf '      控制组：B 连自己 127.0.0.1:%s → 通（说明监听在）\n' "$INNER_PORT"
  else
    record A6 SKIP "容器 B 的 :$INNER_PORT 监听没起来，无法判定"
    return
  fi
  if tcp_connects "$CONTAINER_A" "$ip" "$INNER_PORT"; then
    record A6 FAIL "A 连上了 B（$ip:$INNER_PORT）—— enable_icc=false / nft forward 没生效"
  else
    record A6 PASS "A 连 B（$ip:$INNER_PORT）失败"
  fi
}

# ── A7/A8：出网正常 ─────────────────────────────────────────────────────────
check_a7() {
  section 'A7 容器出网（api.deepseek.com）'
  local code
  if code="$(http_status "$CONTAINER_A" https://api.deepseek.com/)"; then
    record A7 PASS "HTTP 状态码 $code"
  else
    record A7 FAIL '拿不到 HTTP 状态码（出网被挡或 DNS 不通）'
  fi
}

check_a8() {
  section 'A8 容器访问 npmmirror'
  local code
  if code="$(http_status "$CONTAINER_A" https://registry.npmmirror.com/)"; then
    if [ "$code" = "200" ]; then
      record A8 PASS 'HTTP 200'
    else
      record A8 FAIL "HTTP $code（期望 200）"
    fi
  else
    record A8 FAIL '拿不到 HTTP 状态码'
  fi
}

# ── A9：隔离基线 ────────────────────────────────────────────────────────────
check_a9_one() { # 返回失败项数量，结果写进全局 A9_DETAIL
  local c="$1" fails=() detail=()
  local capdrop secopt mem memswap nanocpus pids rofs user netmode ports mounts
  capdrop="$(docker inspect "$c" --format '{{json .HostConfig.CapDrop}}')"
  secopt="$(docker inspect "$c" --format '{{json .HostConfig.SecurityOpt}}')"
  mem="$(docker inspect "$c" --format '{{.HostConfig.Memory}}')"
  memswap="$(docker inspect "$c" --format '{{.HostConfig.MemorySwap}}')"
  nanocpus="$(docker inspect "$c" --format '{{.HostConfig.NanoCpus}}')"
  pids="$(docker inspect "$c" --format '{{.HostConfig.PidsLimit}}')"
  rofs="$(docker inspect "$c" --format '{{.HostConfig.ReadonlyRootfs}}')"
  user="$(docker inspect "$c" --format '{{.Config.User}}')"
  netmode="$(docker inspect "$c" --format '{{.HostConfig.NetworkMode}}')"
  ports="$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')"
  mounts="$(docker inspect "$c" --format '{{json .Mounts}}')"

  [ "$capdrop" = '["ALL"]' ] || fails+=("CapDrop=$capdrop")
  printf '%s' "$secopt" | grep -q 'no-new-privileges' || fails+=("SecurityOpt=$secopt")
  [ "${mem:-0}" -gt 0 ] || fails+=("Memory=$mem")
  [ "${memswap:-0}" -gt 0 ] || fails+=("MemorySwap=$memswap（禁 swap 要求等于 Memory）")
  [ "${nanocpus:-0}" -gt 0 ] || fails+=("NanoCpus=$nanocpus")
  [ "${pids:-0}" -gt 0 ] || fails+=("PidsLimit=$pids")
  [ "$rofs" = "true" ] || fails+=("ReadonlyRootfs=$rofs")
  [ "$user" = "1000:1000" ] || fails+=("User=$user")
  printf '%s' "$mounts" | grep -q 'docker.sock' && fails+=('挂了 docker.sock')
  case "$ports" in
    '{}' | 'null' | '') ;;
    *) fails+=("PortBindings=$ports") ;;
  esac
  detail+=("CapDrop=$capdrop")
  detail+=("Memory=$mem/MemorySwap=$memswap")
  detail+=("NanoCpus=$nanocpus")
  detail+=("PidsLimit=$pids")
  detail+=("ReadonlyRootfs=$rofs")
  detail+=("User=$user")
  detail+=("NetworkMode=$netmode")
  A9_DETAIL="$(printf '%s' "$c")：${detail[*]}"
  if [ "${#fails[@]}" -gt 0 ]; then
    A9_DETAIL="${A9_DETAIL}；不合格：${fails[*]}"
  fi
  printf '      %s\n' "$A9_DETAIL"
  printf '%s\n' "${#fails[@]}"
}

check_a9() {
  section 'A9 容器隔离基线（02 §2）'
  local -a targets=()
  local name
  while IFS= read -r name; do
    [ -n "$name" ] && targets+=("$name")
  done < <(docker ps --filter 'label=dshhub.managed=1' --format '{{.Names}}' 2>/dev/null || true)
  local source_note
  if [ "${#targets[@]}" -eq 0 ]; then
    printf '      没有生产用户容器（dshhub-u*），改查闸门测试容器（同规格）\n'
    targets=("$CONTAINER_A" "$CONTAINER_B")
    source_note='测试容器（同规格；有用户容器后应重跑）'
  else
    source_note="生产用户容器 ${#targets[@]} 个"
  fi
  local bad_total=0 f
  for name in "${targets[@]}"; do
    f="$(check_a9_one "$name" | tail -n 1)"
    bad_total=$((bad_total + f))
  done
  if [ "$bad_total" -eq 0 ]; then
    record A9 PASS "隔离基线全部符合（$source_note）"
  else
    record A9 FAIL "$bad_total 项不符合（$source_note），见上面的明细"
  fi
}

# ── A10：OOM 只影响自己 ─────────────────────────────────────────────────────
check_a10() {
  section 'A10 内存耗尽只影响该容器'
  docker rm -f "$CONTAINER_OOM" >/dev/null 2>&1 || true
  plan "docker run -d --name $CONTAINER_OOM --network $NET_NAME ${RUN_FLAGS[*]} --entrypoint node $IMAGE -e 'const a=[];for(;;)a.push(Buffer.alloc(1e7))'"
  if ! docker run -d --name "$CONTAINER_OOM" --network "$NET_NAME" "${RUN_FLAGS[@]}" \
    --entrypoint node "$IMAGE" -e 'const a=[];for(;;)a.push(Buffer.alloc(1e7))' >/dev/null 2>&1; then
    record A10 SKIP '启动 OOM 测试容器失败'
    return
  fi
  local waited=0 oom=false state
  while [ "$waited" -lt 60 ]; do
    state="$(docker inspect "$CONTAINER_OOM" --format '{{.State.Status}} {{.State.OOMKilled}} {{.State.ExitCode}}' 2>/dev/null || true)"
    printf '      t=%ss %s\n' "$waited" "$state"
    case "$state" in
      *'true'*)
        oom=true
        break
        ;;
      exited* | dead*)
        break
        ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  # 其它容器必须还活着（用户自己的 DSH 也应该照常）
  local others_ok=1
  if ! docker exec "$CONTAINER_B" node -e 'process.exit(0)' >/dev/null 2>&1; then
    others_ok=0
    printf '      容器 B 被拖死了（不应该）\n'
  else
    printf '      容器 B 仍可用\n'
  fi
  if [ -n "${HUB_HEALTH_URL:-}" ]; then
    if curl -fsS -m 3 "$HUB_HEALTH_URL" >/dev/null 2>&1; then
      printf '      Hub %s 正常\n' "$HUB_HEALTH_URL"
    else
      printf '      Hub %s 无响应（未运行就忽略）\n' "$HUB_HEALTH_URL"
    fi
  fi
  if [ "$oom" = "true" ] && [ "$others_ok" -eq 1 ]; then
    record A10 PASS "OOMKilled=true，其它容器不受影响（${waited}s 内触发）"
  elif [ "$oom" = "true" ]; then
    record A10 FAIL 'OOM 达成但拖垮了其它容器'
  else
    record A10 FAIL "60s 内没有观察到 OOMKilled（最后状态：${state:-未知}）"
  fi
}

# ── 跑 ──────────────────────────────────────────────────────────────────────
if [ "$PLAN_ONLY" -eq 1 ]; then
  KEEP=1 # plan 模式什么都不删（本来也没建）
fi
setup_env

if [ "$PLAN_ONLY" -eq 1 ]; then
  printf '\n--plan：以上是准备阶段会执行的命令；检查阶段会执行（不会改动系统）：\n'
  for item in "${CHECK_LIST[@]}"; do
    id="${item%%|*}"
    selected "$id" || continue
    printf '  %-3s %s\n' "$id" "${item#*|}"
  done
  printf '\n关键命令：\n'
  printf '  %s nft list table inet dshhub\n' "$SUDO"
  printf '  docker exec -i %s sh -c "cat > /workspace/whoami.exe" < /mnt/c/Windows/System32/whoami.exe   # A3\n' "$CONTAINER_A"
  printf '  docker exec %s node -e <TCP 连接测试> <host> <port>               # A5/A6\n' "$CONTAINER_A"
  printf '  docker run -d --name %s … --entrypoint node %s -e <内存分配>      # A10\n' "$CONTAINER_OOM" "$IMAGE"
  printf '\nplan 模式：没有执行任何检查、没有改动任何东西。\n'
  exit 0
fi

selected A0 && check_a0
selected A1 && check_a1
selected A2 && check_a2
selected A3 && check_a3
selected A4 && check_a4
selected A5 && check_a5
selected A6 && check_a6
selected A7 && check_a7
selected A8 && check_a8
selected A9 && check_a9
selected A10 && check_a10

# ── 汇总 ────────────────────────────────────────────────────────────────────
printf '\n════════ 结果汇总 ════════\n'
printf '%-4s %-5s %s\n' '检查' '结果' '说明'
for row in "${RESULTS[@]}"; do
  IFS='|' read -r id state detail <<<"$row"
  printf '%-4s %-5s %s\n' "$id" "$state" "$detail"
done
printf '\nPASS %d / FAIL %d / SKIP %d\n' "$((${#RESULTS[@]} - FAIL_COUNT - SKIP_COUNT))" "$FAIL_COUNT" "$SKIP_COUNT"
if [ "$FAIL_COUNT" -gt 0 ] || [ "$SKIP_COUNT" -gt 0 ]; then
  printf '闸门未通过：不要开放注册。A3 不过 → 走 B 计划（02 §3、08 附录 A）。\n'
  exit 1
fi
printf '闸门通过：可以开放注册。\n'
