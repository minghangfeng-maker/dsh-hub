#!/usr/bin/env bash
# DSH ASR（WP49）安装脚本 —— 幂等，可反复执行。
#
#   bash services/asr/install.sh
#
# 做的事：
#   1. 建独立 venv（$ASR_HOME/venv，uv + Python 3.12 + 清华 PyPI 源）
#   2. 下载 SenseVoice-Small int8 模型（$ASR_HOME/models/…，GitHub release，校验 sha256）
#   3. 把 server.py / requirements.txt 拷到 $ASR_HOME/app（单元文件不依赖仓库路径）
#   4. 渲染 systemd 用户单元到 ~/.config/systemd/user/dsh-asr.service，daemon-reload + enable --now
#   5. 轮询 http://127.0.0.1:9890/health 直到就绪
#
# 可覆盖的环境变量：
#   DSH_ASR_HOME          数据目录（默认 ~/.local/share/dsh-asr）
#   DSH_ASR_PORT          (9890)
#   DSH_ASR_PYTHON        (3.12)         传给 uv venv
#   UV_BIN                (~/.local/bin/uv)
#   PIP_INDEX             (https://pypi.tuna.tsinghua.edu.cn/simple)
#   DSH_ASR_MODEL_MIRROR  第一个下载镜像（默认 https://gh-proxy.com/<github url>）
#   DSH_ASR_CHUNKS        并行分块数（默认 4）
#   DSH_ASR_SKIP_SYSTEMD  =1 只准备 venv/模型/代码，不碰 systemd（沙箱/CI 用）
#
# 说明：本机代理只有 ~25KB/s，脚本开头会 unset 代理变量（模型与 pip 都走国内镜像/直连）。
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASR_HOME="${DSH_ASR_HOME:-$HOME/.local/share/dsh-asr}"
PORT="${DSH_ASR_PORT:-9890}"
PYTHON="${DSH_ASR_PYTHON:-3.12}"
UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
SKIP_SYSTEMD="${DSH_ASR_SKIP_SYSTEMD:-0}"
MODEL_NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
MODEL_TGZ="$MODEL_NAME.tar.bz2"
MODEL_SIZE=163002883
MODEL_SHA256="7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"
GITHUB_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL_TGZ"
CHUNKS="${DSH_ASR_CHUNKS:-4}"

say() { printf '[dsh-asr] %s\n' "$*"; }
die() { printf '[dsh-asr] 错误：%s\n' "$*" >&2; exit 1; }

# 只清掉代理变量：模型与 pip 都走直连镜像，继承 shell 里的隧道反而更慢
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

[ -x "$UV_BIN" ] || die "找不到 uv：$UV_BIN（先装：curl -LsSf https://astral.sh/uv/install.sh | sh）"
command -v curl >/dev/null || die "需要 curl"
command -v tar >/dev/null || die "需要 tar"
command -v sha256sum >/dev/null || die "需要 sha256sum"
if [[ "$ASR_HOME" == *" "* ]]; then
  die "DSH_ASR_HOME 不能包含空格（systemd ExecStart 无法安全渲染）：$ASR_HOME"
fi

mkdir -p "$ASR_HOME"/{models,download,app,venv,logs}
say "安装目录：$ASR_HOME（端口 $PORT）"

# ── 1. venv + 依赖 ─────────────────────────────────────────────────────────

if [ ! -x "$ASR_HOME/venv/bin/python" ]; then
  say "创建 venv（Python $PYTHON）"
  "$UV_BIN" venv --python "$PYTHON" "$ASR_HOME/venv"
else
  say "venv 已存在，复用"
fi
say "安装 Python 依赖（$PIP_INDEX）"
"$UV_BIN" pip install --python "$ASR_HOME/venv/bin/python" -r "$SERVICE_DIR/requirements.txt" -i "$PIP_INDEX"

# ── 2. 模型（分块并行下载 + sha256 校验） ─────────────────────────────────

MODEL_DIR="$ASR_HOME/models/$MODEL_NAME"
# 权重 ~229MB；小于 100MB 说明上次解压不完整，按缺失处理
MODEL_OK=0
if [ -f "$MODEL_DIR/model.int8.onnx" ] && [ -f "$MODEL_DIR/tokens.txt" ] \
  && [ "$(stat -c %s "$MODEL_DIR/model.int8.onnx")" -gt 100000000 ]; then
  MODEL_OK=1
fi
if [ "$MODEL_OK" = "1" ]; then
  say "模型已存在，跳过下载：$MODEL_DIR"
else
  ARCHIVE="$ASR_HOME/download/$MODEL_TGZ"
  MIRRORS=(
    "${DSH_ASR_MODEL_MIRROR:-https://gh-proxy.com/$GITHUB_URL}"
    "https://ghproxy.net/$GITHUB_URL"
    "$GITHUB_URL"
  )
  if [ -f "$ARCHIVE" ] && [ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" != "$MODEL_SHA256" ]; then
    say "已有压缩包校验不通过，删除重下"
    rm -f "$ARCHIVE"
  fi
  if [ ! -f "$ARCHIVE" ]; then
    say "下载模型（$(numfmt --to=iec "$MODEL_SIZE")，$CHUNKS 块并行；镜像 ${MIRRORS[0]}）"
    PART=$(( (MODEL_SIZE + CHUNKS - 1) / CHUNKS ))
    for i in $(seq 0 $((CHUNKS - 1))); do
      START=$(( i * PART ))
      END=$(( START + PART - 1 ))
      [ "$END" -ge "$MODEL_SIZE" ] && END=$(( MODEL_SIZE - 1 ))
      WANT=$(( END - START + 1 ))
      (
        for url in "${MIRRORS[@]}"; do
          for attempt in 1 2 3; do
            say "块 $i：$url（第 $attempt 次）"
            if curl -fsSL --connect-timeout 15 --max-time 900 -r "$START-$END" -o "$ARCHIVE.part.$i" "$url"; then
              if [ "$(stat -c %s "$ARCHIVE.part.$i" 2>/dev/null || echo 0)" -eq "$WANT" ]; then exit 0; fi
            fi
            sleep 2
          done
        done
        say "块 $i 所有镜像都失败"
        exit 1
      ) &
    done
    wait
    cat $(for i in $(seq 0 $((CHUNKS - 1))); do echo "$ARCHIVE.part.$i"; done) > "$ARCHIVE"
    rm -f "$ARCHIVE".part.*
  fi
  ACTUAL_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [ "$ACTUAL_SHA" = "$MODEL_SHA256" ] || die "模型 sha256 不匹配：$ACTUAL_SHA（期望 $MODEL_SHA256）"
  say "sha256 校验通过，解压模型"
  rm -rf "$MODEL_DIR"
  tar -xjf "$ARCHIVE" -C "$ASR_HOME/models"
  [ -f "$MODEL_DIR/model.int8.onnx" ] && [ -f "$MODEL_DIR/tokens.txt" ] || die "解压后缺少 model.int8.onnx / tokens.txt"
fi

# ── 3. 应用代码（拷到数据目录，单元不引用仓库路径） ────────────────────────

install -m 0644 "$SERVICE_DIR/server.py" "$ASR_HOME/app/server.py"
install -m 0644 "$SERVICE_DIR/requirements.txt" "$ASR_HOME/app/requirements.txt"
say "已复制 server.py 到 $ASR_HOME/app/"

# ── 4. systemd 用户单元 ────────────────────────────────────────────────────

if [ "$SKIP_SYSTEMD" = "1" ]; then
  say "DSH_ASR_SKIP_SYSTEMD=1：跳过 systemd。手动启动："
  printf '  %s/venv/bin/python %s/app/server.py\n' "$ASR_HOME" "$ASR_HOME"
  exit 0
fi

command -v systemctl >/dev/null || die "没有 systemctl（这是 WSL/容器环境？可用 DSH_ASR_SKIP_SYSTEMD=1 只装依赖）"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s|@ASR_HOME@|$ASR_HOME|g" -e "s|@PORT@|$PORT|g" \
  "$SERVICE_DIR/dsh-asr.service" > "$UNIT_DIR/dsh-asr.service"
say "已写入单元：$UNIT_DIR/dsh-asr.service"

systemctl --user daemon-reload
systemctl --user enable dsh-asr.service
systemctl --user restart dsh-asr.service
say "已 enable --now（restart）dsh-asr"

# ── 5. 健康检查 ────────────────────────────────────────────────────────────

say "等待 http://127.0.0.1:$PORT/health"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  printf '[dsh-asr] 健康检查失败。排查：\n' >&2
  systemctl --user --no-pager status dsh-asr.service >&2 || true
  journalctl --user -u dsh-asr.service -n 50 --no-pager >&2 || true
  exit 1
fi

curl -fsS "http://127.0.0.1:$PORT/health"; echo
say "完成。日志：journalctl --user -u dsh-asr -f"
