#!/bin/sh
# Hub 用户容器的入口：以固定 authority 起 `dsh web`，对外端口交给转发器。
#
# ── 监听形态（WP0b S1 实测）────────────────────────────────────────────────
#
#   DSH_BIND=loopback（默认）
#     `dsh web` 绑 `127.0.0.1:3001`，转发器占 `0.0.0.0:3000` 纯 TCP 转发进去。好处有二：
#       1. 完全走 DSH 官方支持的绑定（`webserver.host` 的 schema 只接受 127.0.0.1/0.0.0.0，
#          传容器 IP 会直接 config 校验失败）；
#       2. 第三方插件常见的「settings 路由只允许 127.0.0.1」检查（dsh-email 就要求
#          `req.socket.remoteAddress` 是回环）在 Hub 从宿主转发过来的场景下也能通过。
#
#   DSH_BIND=any
#     直接通过 runtime patch 把 webserver 绑到 `0.0.0.0:3000`（省一个进程，但插件的
#     localhost-only 路由会 403）。
#
# ── 转发器实现（DSH_FORWARDER，WP2 对照实验）──────────────────────────────────
#
#   auto（默认） 有 socat 就用 socat，否则回退 node /opt/hub/forward.mjs
#   socat        `socat TCP-LISTEN:3000,fork,reuseaddr TCP:127.0.0.1:3001`
#   node         `node /opt/hub/forward.mjs`（零依赖，RSS 约 50MB）
#
#   实测（WP2，同一镜像 + 同一容器规格）：socat 常驻 RSS ≈ 4.5MB，node 版 ≈ 50MB；
#   两者都能让 dsh-email 的 `/_dsh/dsh-email/settings` 返回 200（即 F14 的「只允许回环」
#   路由成立）。代价是 socat 一连接一子进程，长连接（SSE/WS）多时子进程数上升——仍远低于
#   pids 限额，总内存也低于 node 版，故默认走 socat，node 版作为兜底保留。
#
# authority 统一 `127.0.0.1:3000`（Hub 实际发送的 Host）：回环天然受信，`--trusted-host`
# 因此不再是必需（仍然传参，便于将来改回 per-user authority 时行为不变）。
set -eu

: "${DSH_HOME:=/home/dsh/.dsh}"
: "${DSH_AUTHORITY:=127.0.0.1:3000}"
: "${DSH_PORT:=3000}"
: "${DSH_PROFILE:=web}"
: "${DSH_BIND:=loopback}"
: "${DSH_FORWARDER:=auto}"

mkdir -p "$DSH_HOME" "$DSH_HOME/run"

LISTEN_PORT="$DSH_PORT"
PATCH_ARGS=""

if [ "$DSH_BIND" = "any" ]; then
  # runtime 层 patch：只钉监听地址与端口，永远排在 --patch 列表最前，
  # Hub 渲染的 managed.patch.yml 在后（后者可覆盖本文件里的任何条目）。
  RUNTIME_PATCH="$DSH_HOME/run/runtime.patch.yml"
  cat > "$RUNTIME_PATCH" <<'YAML'
# 由 /opt/hub/entry.sh 生成，请勿手改
- id: webserver
  config:
    host: 0.0.0.0
    port: !!js ctx.webStartup.port ?? 3000
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
YAML
  PATCH_ARGS="--patch $RUNTIME_PATCH"
else
  # dsh 绑回环，转发器占对外端口
  LISTEN_PORT=$((DSH_PORT + 1))
  UPSTREAM_PORT="$LISTEN_PORT"
  case "$DSH_FORWARDER" in
    socat)
      socat "TCP-LISTEN:$DSH_PORT,fork,reuseaddr" "TCP:127.0.0.1:$UPSTREAM_PORT" &
      ;;
    node)
      DSH_UPSTREAM_PORT="$UPSTREAM_PORT" DSH_PORT="$DSH_PORT" node /opt/hub/forward.mjs &
      ;;
    *)
      if command -v socat >/dev/null 2>&1; then
        socat "TCP-LISTEN:$DSH_PORT,fork,reuseaddr" "TCP:127.0.0.1:$UPSTREAM_PORT" &
      else
        DSH_UPSTREAM_PORT="$UPSTREAM_PORT" DSH_PORT="$DSH_PORT" node /opt/hub/forward.mjs &
      fi
      ;;
  esac
fi

if [ -f /opt/hub/managed/managed.patch.yml ]; then
  PATCH_ARGS="$PATCH_ARGS --patch /opt/hub/managed/managed.patch.yml"
fi

# shellcheck disable=SC2086  # PATCH_ARGS 是固定拼接的参数表，无空格路径风险
exec dsh --profile "$DSH_PROFILE" $PATCH_ARGS \
  --no-open \
  --port "$LISTEN_PORT" \
  --trusted-host "$DSH_AUTHORITY"
