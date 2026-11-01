# runtime/ —— 用户 DSH 运行时镜像

每个用户一个容器，跑 `dsh --profile web`。Hub（`apps/api/src/modules/instances`）通过 Docker Engine
API 创建容器、挂载用户卷、等就绪、经 `/u/<slug>/` 反向代理访问它。

> 结论与实测细节见下文各节；历史的技术验证记录未随开源版发布。
> 设计文档：`docs/05-用户DSH容器.md`。

## 1. 文件

| 文件              | 作用                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `Dockerfile`      | 镜像定义：Node 24 + 全局 `@deepseek-ai/dsh` + pnpm + 常用工具 + 中文字体                                |
| `entry.sh`        | 容器入口：选转发器 → 起 `dsh web`（`DSH_BIND=loopback` 时 dsh 绑回环，转发器占 3000）                   |
| `forward.mjs`     | 纯 TCP 转发器（`0.0.0.0:3000` → `127.0.0.1:3001`），零依赖兜底实现                                      |
| `healthcheck.mjs` | 就绪探针：读 `.credentials.yaml` 现签 cookie → `Host: <authority>` 请求 `/` → 断言 200 + `__DSH_BOOT__` |

镜像不裁剪：中文字体（`fonts-noto-cjk`）、`python3`、`openssh-client`、`git`、`ripgrep` 等都保留。

WP40d 起还带数值/绘图栈（手机 App「普通对话」的 python 计算与画图）：

| 内容 | 版本 / 位置 | 说明 |
| --- | --- | --- |
| `python3-pip`、`fontconfig`、`zstd` | apt（清华源） | pip 可自装包；`fc-list` 可查字体；`zstd` 解会话日志 |
| numpy / pandas / matplotlib / scipy / openpyxl / pillow | 2.4.6 / 3.1.0 / 3.11.2 / 1.17.1 / 3.1.5 / 10.4.0 | 装进系统 python（`--break-system-packages`），bash 里直接 `python3` 可用 |
| `/etc/matplotlibrc` | `MATPLOTLIBRC` | 默认 `Agg` + `font.sans-serif: Noto Sans CJK SC` + `axes.unicode_minus: False` |
| matplotlib 字体缓存 | `MPLCONFIGDIR=/home/dsh/.cache/matplotlib` | 用户卷上，只读根/`noexec /tmp` 下唯一可写且可用的位置 |

当前验证过的测试 tag：`dshhub/runtime:0.2.1-rc.2-chat1`（2026-10-25，WP40d）。
生产仍用 `0.2.1-rc.2`，切换是上线步骤（见下文）。

## 2. 构建

```bash
# Docker（生产/开发同一个守护进程；Hub 的 runtime.build 任务也走这条）
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NODE_USE_ENV_PROXY
docker build -t dshhub/runtime:0.2.1-rc.2-chat1 \
  --build-arg DSH_VERSION=0.2.1-rc.2 \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  runtime/

# podman（B 计划）：必须 --format docker 才保留 HEALTHCHECK，
# 并且要显式清空代理 build-arg（podman 会把宿主 http_proxy 注入构建容器，本机代理不通时会 ECONNREFUSED）
podman build --format docker -t localhost/dshhub/runtime:0.2.0-rc.2 \
  --build-arg DSH_VERSION=0.2.0-rc.2 \
  --build-arg http_proxy= --build-arg https_proxy= --build-arg HTTP_PROXY= \
  --build-arg HTTPS_PROXY= --build-arg no_proxy='*' --build-arg NO_PROXY='*' \
  runtime/
```

构建参数：

| ARG            | 默认                             | 说明                                                              |
| -------------- | -------------------------------- | ----------------------------------------------------------------- |
| `NODE_IMAGE`   | `node:24-bookworm-slim`          | 基础镜像（经 daemon 的 registry-mirrors 拉取）                    |
| `DSH_VERSION`  | `0.2.1-rc.2`                     | `@deepseek-ai/dsh` 版本，镜像 tag 与 `runtimes.dsh_version` 一致  |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | npm 源（同时写进容器 env）                                        |
| `APT_MIRROR`   | `mirrors.tuna.tsinghua.edu.cn`   | Debian 源（同时兼容 `debian.sources` 与 `sources.list` 两种布局） |
| `PIP_INDEX_URL`| `https://pypi.tuna.tsinghua.edu.cn/simple` | PyPI 源（国内直连，别走代理）                            |
| `PNPM_VERSION` | `10`                             | 容器内全局 pnpm 版本（`dsh plugin add` 需要）                     |

构建期两个必须注意的点（都在 Dockerfile 里处理了）：

1. `npm ≥ 11.19` 默认**不执行**依赖的 install 脚本 → 必须
   `--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs`，
   否则容器能起但终端/PTY 是坏的；
2. `PNPM_HOME` 必须落在可写卷上（`/home/dsh/.local/share/pnpm`）——只读根下写 `/usr/local/pnpm` 会直接失败。

## 3. 运行（Hub 实际使用的形态）

环境变量：

| 变量                                      | 默认                    | 说明                                                                                                    |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `HOME`                                    | `/home/dsh`             | 挂载 `users/<slug>/home`                                                                                |
| `DSH_HOME`                                | `/home/dsh/.dsh`        | DSH 的数据根（profile、`.credentials.yaml`、会话）                                                      |
| `DSH_AUTHORITY`                           | `127.0.0.1:3000`        | Hub 实际发送的 `Host`。回环天然受信，且插件的 localhost-only 路由可用（05 F14）                         |
| `DSH_PORT`                                | `3000`                  | 容器对外端口（转发器监听）                                                                              |
| `DSH_BIND`                                | `loopback`              | `loopback`=dsh 绑 127.0.0.1:3001 + 转发器；`any`=直接绑 0.0.0.0（插件本地路由会 403）                   |
| `DSH_FORWARDER`                           | `auto`                  | `auto`/`socat`/`node`，见下                                                                             |
| `DSH_PROFILE`                             | `web`                   | DSH profile 名                                                                                          |
| `NARB_DISABLE_NATIVE_CACHE`               | `1`                     | 关掉 DSH 原生加载器往 `/tmp` 复制 `.node` 的行为（只读根 + `noexec /tmp` 下会 `failed to map segment`） |
| `MATPLOTLIBRC`                            | `/etc/matplotlibrc`     | 中文字体 + Agg 后端 + 负号（见上表）                                                                    |
| `MPLCONFIGDIR`                            | `/home/dsh/.cache/matplotlib` | matplotlib 字体缓存的落点（用户卷可写）                                                          |
| `DSH_PERMISSION_MODE`                     | Hub 注入（默认 `danger-full-access`） | 容器内权限预设；管理员改回 `workspace-write` 即「需要审批」。参与 config_hash，改值会重建容器 |
| `npm_config_registry`                     | 构建时的 `NPM_REGISTRY` | 容器内 `dsh plugin add` 用它                                                                            |
| `HUB_SLUG`                                | Hub 注入                | 容器内识别自己属于哪个用户（日志、诊断用）                                                              |
| `HUB_MK_<ROUTE_KEY>` / `DEEPSEEK_API_KEY` | Hub 注入                | 模型密钥（只在创建容器时以 env 注入，不进镜像/日志）                                                    |

挂载（Hub 的 `ContainerSpec`，见 05 §4）：`home`/`workspace` 读写，`managed`（`/opt/hub/managed`）与
`plugin-store`（`/opt/hub/plugin-store`）只读。容器运行时参数（cap-drop ALL、no-new-privileges、
只读根 + `/tmp` tmpfs 512MB、MemorySwap=Memory、pids 限额、`RestartPolicy=no`、json-file 日志
10MB×3）由 `DockerDriver.create` 统一施加（02 §2）。

手工跑一个（排查用）：

```bash
docker run -d --rm --name dshhub-test-wp2-s1 \
  --network dshhub-test-wp2-net \
  -e DSH_AUTHORITY=127.0.0.1:3000 \
  --read-only --tmpfs /tmp:rw,size=512m,nosuid,nodev \
  -v "$PWD/.data/s1/home:/home/dsh" -v "$PWD/.data/s1/workspace:/workspace" \
  dshhub/runtime:0.2.0-rc.2
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dshhub-test-wp2-s1)
docker exec dshhub-test-wp2-s1 node /opt/hub/healthcheck.mjs 127.0.0.1:3000   # → healthcheck: ready
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3000' "http://$IP:3000/"   # → 401（无 cookie）
docker rm -f dshhub-test-wp2-s1
```

## 4. 转发器对照实验（WP2）

`DSH_BIND=loopback` 下 dsh 只监听回环，必须有东西把容器网络的 3000 转进去。两种实现实测：

| 实现                                                      | 常驻 RSS     | F14 回环路由（`/_dsh/dsh-email/settings`） | 说明                       |
| --------------------------------------------------------- | ------------ | ------------------------------------------ | -------------------------- |
| `socat TCP-LISTEN:3000,fork,reuseaddr TCP:127.0.0.1:3001` | **≈ 4.5 MB** | `200`（Host `127.0.0.1:3000`）             | 默认；一连接一子进程       |
| `node /opt/hub/forward.mjs`                               | ≈ 50 MB      | 200（WP0b 已实测）                         | 兜底；单进程 pipe 所有连接 |

结论：**默认 socat**（省约 45MB/容器，约占空闲内存的 19%），镜像里仍保留 node 版；
`DSH_FORWARDER=node` 可强制回退。两者的「Hub 看到的 Host 改写 + 容器内回环一跳」语义完全一致，
插件自带的 localhost-only 路由都可用。

## 5. 已知坑（复现/排查时先看这里）

1. **只读根 + `noexec /tmp`**：DSH 的原生加载器默认把 `prebuilt/*.node` 复制到
   `/tmp/node-addon-native-custom-loader-<uid>/native-cache` 再 `dlopen`，`--tmpfs /tmp` 默认带
   `noexec` → `No usable native binding found … failed to map segment from shared object`。
   镜像里设 `NARB_DISABLE_NATIVE_CACHE=1` 规避（不改安全基线、不给 `/tmp` 加 exec）。
2. **HEALTHCHECK 与 OCI 格式**：podman 构建要 `--format docker`，否则 HEALTHCHECK 被忽略
   （Hub 的就绪判据不依赖它，但 `podman inspect` 里会看不到）。
3. **rootless podman 的 uid 映射**：宿主挂载目录属主是 uid 1000，rootless 下要
   `--userns keep-id:uid=1000,gid=1000`；rootful Docker 天然一致。
4. **rootless podman 连不上容器 IP**：宿主没有到容器网段的路由，需要发布回环端口并在
   `ContainerSpec.labels['dshhub.published_port']` 里告诉驱动（DockerDriver.resolveUpstream 会用它）。
5. **冷启动时序**：端口 ~1.7s 可连 → `.credentials.yaml` +40ms → 200 + `__DSH_BOOT__` ≈2.0s。
   就绪判据必须等密钥（Hub 的 `waitForReady` 就是这么做的）。
