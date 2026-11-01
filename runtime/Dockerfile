# DSH Hub 用户运行时镜像（WP0b 原型 → WP2 定稿）
#
# 构建：
#   docker build -t dshhub/runtime:0.2.0-rc.2 \
#     --build-arg DSH_VERSION=0.2.0-rc.2 --build-arg NPM_REGISTRY=https://registry.npmmirror.com runtime/
#   （podman 需额外加 `--format docker` 才保留 HEALTHCHECK，并显式清空代理 build-arg：
#     --build-arg http_proxy= --build-arg https_proxy= --build-arg HTTP_PROXY= \
#     --build-arg HTTPS_PROXY= --build-arg no_proxy='*' --build-arg NO_PROXY='*'）
#
# 与 05 §3 的差异（实测修正，见 runtime/README.md）：
#   * `--host` 不再由 entry.sh 传容器 IP（DSH 只接受 127.0.0.1/0.0.0.0）；默认
#     `DSH_BIND=loopback`：dsh 绑 127.0.0.1，转发器把 0.0.0.0:3000 纯 TCP 转进去
#     （宿主无端口发布；同时让插件的 localhost-only 路由可用）。转发器默认 socat
#     （RSS ≈ 4.5MB），没有 socat 时回退 `node /opt/hub/forward.mjs`（≈ 50MB）；
#   * PNPM_HOME 从 `/usr/local/pnpm` 改到 `/home/dsh/.local/share/pnpm`：只读根文件系统下
#     pnpm 需要能建自己的 store，指到镜像里会让 `dsh plugin add` 直接 ENOENT 失败；
#   * apt 源换成清华镜像时同时替换 `debian.sources` 与老的 `sources.list`（bookworm-slim
#     两种布局都兼容，避免基础镜像换代时静默失效）；
#   * 镜像内自带 HEALTHCHECK，用的是与 Hub 相同的就绪判据（现签 cookie + __DSH_BOOT__）；
#   * 新增 `NARB_DISABLE_NATIVE_CACHE=1`：只读根 + `/tmp` 带 `noexec` 时，DSH 的原生加载器
#     会先把 `.node` 复制到 `/tmp/...native-cache` 再 dlopen，结果
#     `failed to map segment from shared object` 直接启动失败（WP2 在 Docker 上实测）。
#     关掉缓存后直接从只读镜像路径加载。
#
# WP40d（手机 App「普通对话」运行时补齐）：
#   * 补 `python3-pip` / `fontconfig` / `zstd` 与数值绘图栈（numpy/pandas/matplotlib/scipy/
#     openpyxl/pillow）：C0 实测出厂镜像里 `import numpy` 直接 ModuleNotFoundError，而「手机
#     App 里让 DSH 算数、画图」是 P0 能力。
#   * 追加 matplotlib 默认配置（默认 Agg + 中文字体 Noto Sans CJK SC）：不显式设置时中文标题
#     全是豆腐块（C0 §3.3 反例）。改的是 mpl-data/matplotlibrc 这个默认值来源，追加在文件末尾，
#     后面的值赢。
#   * `MPLCONFIGDIR` 指到 `/home/dsh/.cache/matplotlib`：容器是只读根 + `noexec` 的 `/tmp`，
#     matplotlib 首次 import 要写字体缓存；放用户卷上既写得了，也只付一次成本。
#   * apt 用清华、PyPI 用清华（国内直连，别走代理）。`--break-system-packages` 是 bookworm 的
#     PEP 668 规定（系统 python 受管，装进去必须显式声明）。版本固定，避免上游大版本漂移让
#     「能画图」这件事在某个周一突然失效。
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.2.1-rc.2
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PNPM_VERSION=10

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/home/dsh \
    DSH_HOME=/home/dsh/.dsh \
    DSH_PORT=3000 \
    DSH_TELEMETRY_DISABLED=1 \
    NARB_DISABLE_NATIVE_CACHE=1 \
    MPLCONFIGDIR=/home/dsh/.cache/matplotlib \
    MATPLOTLIBRC=/etc/matplotlibrc \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    npm_config_registry=${NPM_REGISTRY} \
    PNPM_HOME=/home/dsh/.local/share/pnpm \
    PATH=/home/dsh/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tini git curl ca-certificates ripgrep jq unzip zip less procps \
      python3 python3-venv fonts-noto-cjk tzdata openssh-client socat \
      python3-pip fontconfig zstd; \
    fc-cache -f >/dev/null 2>&1 || true; \
    rm -rf /var/lib/apt/lists/*

# 数值 / 绘图栈（WP40d）。用系统 python（`--break-system-packages`），这样模型在 bash 里
# 直接 `python3 -c 'import numpy'` 就能用，不需要每次自己建 venv。
RUN python3 -m pip install --break-system-packages --no-cache-dir -i "${PIP_INDEX_URL}" \
      numpy==2.4.6 \
      pandas==3.1.0 \
      matplotlib==3.11.2 \
      scipy==1.17.1 \
      openpyxl==3.1.5 \
      pillow==10.4.0 \
 && python3 -c "import numpy, pandas, matplotlib, scipy, openpyxl, PIL; print('py-stack', numpy.__version__, pandas.__version__, matplotlib.__version__, scipy.__version__, openpyxl.__version__, PIL.__version__)"

# 让 matplotlib 默认就用中文字体（否则中文标题是豆腐块，C0 §3.3）+ 默认 Agg 后端。
# 用 `MATPLOTLIBRC` 指到一份只写这四个键的配置，而不是追加到包内 mpl-data/matplotlibrc：
# 后者会让 rc 解析器在同一文件里看到重复键（matplotlib 3.11 每次 import 都打三条 warning），
# 而 `MATPLOTLIBRC` 文件是在默认值之上覆盖，其余默认值（figsize、grid…）都保留。
RUN printf 'backend: Agg\nfont.family: sans-serif\nfont.sans-serif: Noto Sans CJK SC, Noto Sans CJK JP, DejaVu Sans\naxes.unicode_minus: False\n' > /etc/matplotlibrc \
 && cat /etc/matplotlibrc

# 构建期自检：matplotlib 必须能从 Noto CJK 的 .ttc 里认出简体中文字族，且后端是 Agg。
# 失败就让构建失败——「镜像里中文字体可用」是 P0 能力的硬前提，不能等到用户第一次画图才发现。
RUN MPLCONFIGDIR=/tmp/mpl-build python3 - <<'PY'
import matplotlib
from matplotlib import font_manager

families = sorted({font.name for font in font_manager.fontManager.ttflist if 'Noto' in font.name})
ttc = [path for path in font_manager.findSystemFonts() if path.endswith('.ttc')]
print('mpl', matplotlib.__version__, '| backend', matplotlib.get_backend())
print('ttc:', ttc)
print('noto families:', families)
assert 'Noto Sans CJK SC' in families, 'Noto Sans CJK SC 不在 matplotlib 字体列表里'
assert matplotlib.get_backend().lower() == 'agg', '默认后端不是 Agg'
PY
RUN rm -rf /tmp/mpl-build && mkdir -p /home/dsh/.cache/matplotlib && chown -R 1000:1000 /home/dsh/.cache

# node 镜像自带 uid/gid 1000 的 node 用户与 /home/node；统一改名为 dsh。
# 先改名再装包：npm 按 HOME 建目录，/home/dsh 已存在时 `usermod -m` 会拒绝移动。
RUN usermod -l dsh -d /home/dsh node \
 && groupmod -n dsh node \
 && rm -rf /home/node \
 && mkdir -p /home/dsh /workspace /opt/hub/managed \
 && chown -R 1000:1000 /home/dsh /workspace

# DSH 与 pnpm 都装在镜像里（运行时只读，容器内不需要再装全局包）；pnpm 是 S4
# 「插件安装用 dsh plugin 还是 Hub 自己跑 pnpm」的前提。
# npm ≥ 11.19 默认**不执行**依赖的 install 脚本（本机实测 npm 11.19.0 报
# "install-scripts not yet covered by allowScripts"），而下面这几个是 DSH 运行要用的：
#   * dsh-subprocess-local：给 node-pty 的 spawn-helper 补可执行位（容器内终端要用）
#   * node-pty / koffi：原生模块 prebuild 的选择/构建
#   * protobufjs / @google/genai：常规 postinstall
# 不放行的话容器里 dsh 能起，但终端/PTY 是坏的。
RUN npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /home/dsh/.npm \
 && chown -R 1000:1000 /home/dsh

COPY entry.sh healthcheck.mjs forward.mjs /opt/hub/
RUN chmod 0755 /opt/hub/entry.sh /opt/hub/healthcheck.mjs /opt/hub/forward.mjs

LABEL dshhub.runtime="1" \
      dshhub.dsh_version="${DSH_VERSION}" \
      org.opencontainers.image.title="dshhub runtime" \
      org.opencontainers.image.description="Per-user DSH runtime (Node 24 + @deepseek-ai/dsh + pnpm)"

USER 1000:1000
WORKDIR /workspace
EXPOSE 3000

# 与 05 §6 就绪判据一致：现签 cookie + Host 围栏 + __DSH_BOOT__。
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "/opt/hub/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hub/entry.sh"]
