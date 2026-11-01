# 05 用户 DSH 容器

## 0. 修订（2026-10-25，WP40d；手机 App「普通对话」）

本节记录对前面各节的**覆盖性**修订，后面的原文保留作为背景。

### 0.1 容器内权限：默认 `danger-full-access`（改 §4 的 env 表与 §3 的镜像验收）

- **决定**：用户容器默认以 DSH 权限预设 `danger-full-access` 启动（沙箱全开 + 审批策略 `never`）。
  管理员可在管理端「系统设置 → 容器」改回 `workspace-write`（= 只写工作区 + 审批 `ask`，即 DSH 出厂行为）。
- **为什么可以放行**：DSH 的沙箱本来就不是安全边界（§1 F11），隔离由容器承担。本项目的容器同时满足：
  非 root（`User=1000:1000`）、`cap-drop ALL`、`no-new-privileges`、只读根 + `/tmp` tmpfs（`nosuid,nodev`）、
  `pids-limit` / `cpus` / `memory` 上限、只接 `dshhub-users` 网络（`enable_icc=false`，用户之间不能互访）、
  只挂载**本用户**的 `home` / `workspace` / `managed`（`managed` 只读）。放开的只是「容器内」的写范围与审批，
  不越过任何一条容器边界。
- **为什么必须放**：手机 App 没有审批 UI 的产品位（M4 §9 只保留「去网页端批准」的兜底）。C0 实测：
  不设权限时，手机上一句「画个图」会停在审批卡上，回合永远不结束——这是 P0 阻断项（开发文档 §4.3）。
- **实现方式（以 DSH 0.2.1-rc.2 源码为准）**：写容器 env `DSH_PERMISSION_MODE=danger-full-access`。
  依据是 `@deepseek-ai/dsh-base/cordis.patch.yml`：
  - `sandbox-policy.config.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`
  - `approval.config.policy = DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'`
  - 两处默认值正好等于 `permission-presets` 的 `danger-full-access` 预设（sandbox `danger-full-access` +
    approval `never`），所以 `permission-presets` 推导出的默认预设也是它。
  - 也可以在 `managed.patch.yml` 里改 `permission.config.defaultPreset`，但 patch 的 `config` 是**整块替换**
    （§1 F6），必须把 `presets` 表一起写全，且只影响**新会话**；env 同时决定两个执行层的默认值，更贴近
    「容器内自动批准」的语义。两种方式 Hub 都能用，当前选 env。
- **对现有生产用户的影响**：`DSH_PERMISSION_MODE` 参与 `config_hash`（§4 公式），所以新版本 Hub 上线后，
  已有用户实例在**下次启动**时会被判定为「规格变了」→ 删除重建。重建只换容器，四个数据卷
  （`users/<slug>/{home,workspace,managed}` 与 `plugin-store`）**原样保留**，会话、记忆、插件、工作区文件都不丢；
  正在运行、有人使用的容器不会被主动打断，等它被停掉后的下一次 start 才重建（05 §6「start」一行）。
  已经在库里且不重启的旧容器仍按旧权限运行，直到下次启动。
- **DSH 升级风险**：`permission-presets` 的 `presets` 表随 DSH 版本演进。env 只声明「模式 + 审批」两个
  执行层默认值，由 DSH 自己匹配预设，因此比在 patch 里抄一份 `presets` 表更抗升级。

### 0.2 运行时镜像：补齐数值/绘图栈与中文字体验收口径（改 §3 与「fc-list」那条验收）

- 新测试 tag：`dshhub/runtime:0.2.1-rc.2-chat1`（`runtime/Dockerfile`，WP40d 构建，**未切生产**）。
- 补齐：`python3-pip`、`fontconfig`、`zstd`、`numpy`、`pandas`、`matplotlib`、`scipy`、`openpyxl`、`pillow`；
  apt 与 PyPI 都用清华镜像（`APT_MIRROR` / `PIP_INDEX_URL`），`pip` 用 `--break-system-packages`（bookworm PEP 668）。
- matplotlib：`MATPLOTLIBRC=/etc/matplotlibrc`，内容只有四行（默认 Agg、`font.sans-serif` 首选
  `Noto Sans CJK SC`、`axes.unicode_minus: False`）。**没有**去追加包内 `mpl-data/matplotlibrc`：matplotlib 3.11
  会把「同一文件里重复的键」当 warning 打给每个用户，用独立 rc 文件是在默认值之上覆盖，行为一样但没有噪声。
  `MPLCONFIGDIR=/home/dsh/.cache/matplotlib`（只读根 + `noexec` 的 `/tmp` 不能放字体缓存）。
- **验收口径修订**：原文若以「`fc-list :lang=zh` 有输出」判断中文字体是否可用，**这条不成立**——
  `dshhub/runtime:0.2.1-rc.2` 里没有 fontconfig，`fc-list` 命令不存在（C0 §3.4）。新的验收口径是：

  ```sh
  # 在容器里直接跑（不依赖模型/上游）
  python3 -c "import numpy, pandas, matplotlib, scipy, openpyxl; print('ok')"
  MPLCONFIGDIR=/home/dsh/.cache/matplotlib python3 - <<'PY'
  import matplotlib; matplotlib.use('Agg')
  import matplotlib.pyplot as plt
  import numpy as np
  x = np.linspace(0, 6.28, 200)
  fig, ax = plt.subplots(figsize=(6, 4))
  ax.plot(x, np.sin(x), label='正弦')
  ax.plot(x, np.cos(x), label='余弦')
  ax.set_title('中文标题：正弦与余弦')
  ax.set_xlabel('横轴'); ax.set_ylabel('纵轴'); ax.legend()
  fig.savefig('/tmp/zh-check.png', dpi=120, bbox_inches='tight')
  PY
  ```

  然后把 `/tmp/zh-check.png` 复制出来**肉眼确认没有方块/豆腐块**（「无豆腐块」是唯一可信的验收；
  `fc-list :lang=zh` 在新镜像里能跑，但它只证明字体文件注册过，不证明 matplotlib 选对了字族）。
  构建期已有同样的自动检查（`runtime/Dockerfile` 的 `Noto Sans CJK SC 不在 matplotlib 字体列表里` 断言）。

### 0.3 「普通对话」预设（新增 §4.1）

- DSH 的 preset 不是目录扫描，而是两行 patch：
  1. `- insert: [{id: preset-chat, name: '@deepseek-ai/dsh-agent-preset', config: {id: chat, …}}]`
     —— `config.plugins` 决定这个会话挂哪些子插件（persona / 工具 / 压缩）；
  2. `- id: agent-preset-registry` + `config: {default: chat}` —— 新会话没指定预设时的默认值。
- Hub 在生成 `managed.patch.yml` 时写入这两行（`apps/api/src/modules/models/chat-preset.ts`），
  随现有 managed 下发通道（ro 挂载 + `--patch`）到每个用户实例；管理端「系统设置 → 容器」可以整体关掉。
- 预设内容见 `chat-preset.ts`：中文、简洁、不主动展示命令行细节；告知联网搜索、python 计算与画图
  （matplotlib 中文字体已配好，图存 `outputs/` 再 `present`）、记忆（仅当工具存在）；不擅自删除用户文件。
- 产出约定按 M5 通道 v2 契约（§17）：手机新建的会话 cwd 固定为 `/workspace/chat`，预设让模型把图存到
  「当前工作目录的 `outputs/`」（即 `/workspace/chat/outputs/`），并用 `present`/交付物呈现，手机端才能发现和下载。
- 预设只影响**新会话**；已经存在的会话保留创建时的预设（DSH 的会话日志记了 preset id）。
- **联网搜索的前提**：预设只挂 `tool-web`，搜索/抓取的 provider 由 Hub 的搜索池下发决定
  （`apps/api/src/modules/relay/tools/service.ts` 的 `renderForUser` 往 managed patch 写
  `web` + `web-deepseek-api` 两条，密钥用容器 env `HUB_MK_HUB`）。这两个条目只在
  「搜索池总开关开 + 下发到用户 DSH 开 + 内部监听器在监听」时才渲染，而出厂默认是关的——
  没开时 `web_search` 走 DSH 自带的 DeepSeek 官方搜索，需要 `DEEPSEEK_API_KEY`，容器里通常没有，
  表现为「搜索报错、抓取可用」。上线时必须先打开搜索池下发并抽查 managed patch（见 14 §8）。

## 1. 已确认的 DSH 事实（2026-10-12，本机 `@deepseek-ai/dsh@0.2.0-rc.2`）

| # | 事实 | 来源 | 对设计的影响 |
| --- | --- | --- | --- |
| F1 | `dsh --profile web` 选项：`--host`、`--port`、`--no-open`、`--trusted-host <authority...>`；命令行禁用字面量 `--host 0.0.0.0`，且 `webserver.host` 的 schema **只接受 `127.0.0.1` 与 `0.0.0.0`**——**不能绑容器 IP**（WP0b S1 实测 `ValidationError`） | `dsh-web-app/lib/startup.js`、`dsh-host-webserver` | 容器内 DSH 绑 `127.0.0.1:3001`，`0.0.0.0:3000` 由转发器转入（§3） |
| F2 | `/api` 有 Host/Origin 信任围栏：Host 必须是回环或 `--trusted-host` 声明的 authority | DSH 自带行为（实测） | 代理必须改写 `Host` 与 `Origin` |
| F3 | 首页没有 cookie 一律 401；cookie = HMAC 签名，密钥在 `$DSH_HOME/.credentials.yaml` 的 `records["client-connection/browser-session"].payload.secret` | 同上；参考实现在 `apps/api/test/fixtures/dsh-browser-auth.mjs` | Hub 读密钥**现签** cookie，服务端注入；cookie 跨度 ≤ `cookieMaxAgeDays`（默认 30 天） |
| F4 | cookie 名 = `"dsh-auth-" + base64url(sha256(authority))` | 同上 | 已定 authority 统一为 `127.0.0.1:3000` → 所有用户 cookie 名相同；无碍：签名密钥每实例一份，且 cookie 只由 Hub 服务端注入、从不下发浏览器 |
| F5 | 配置分层：bundles 的 patch → profile 的 `cordis.patch.yml`（用户层，设置页写这里）→ `--patch` 覆盖层（最高）。被覆盖的字段在 DSH 设置页**不回填**；用户点保存会提示成功，但写入落在用户层、被 `--patch` **遮蔽**（WP0b S5 实测，不是「拒绝」） | `dsh --help`、`dsh-settings/README.md`、WP0b S5 | 管理员配置放 `--patch` 只读文件；Hub 界面要明确告诉用户「这些由管理员管理，在 DSH 设置页里改不动」 |
| F6 | patch 条目：`- id: <entry-id>` + `config:`（**整块替换，不深合并**）；`- insert: [ {id, name} ]` 插入新条目 | 实测（任一带 `cordis.patch.yml` 的插件） | 渲染 managed.patch 时每个 config 必须写全 |
| F7 | profile = 目录 `$DSH_HOME/profiles/<name>/`：`package.json`（`dependencies` + `dsh.profile.bundles`）、`cordis.patch.yml`、`cordis.yml`（启动时**每次重写**）、`node_modules/` | 本机 `~/.dsh/profiles/web/` | profile 目录必须可写；插件 = 依赖 + bundles 列表 |
| F8 | 访问不存在的 profile 会**自动从出厂模板创建**（`dsh --profile headless --help` 就创建了 `profiles/headless/`） | 记忆 + 本机现象 | 首次启动即生成 profile，无需 Hub 预置模板（S3 验证） |
| F9 | 多模型：`@deepseek-ai/dsh-llm-pi-ai` 条目（id `llm-pi-ai`）的 `config.providers`，`apiKeyEnv` 引用凭据名；默认模型由 `@deepseek-ai/dsh-agent-default-model` 条目的 `config.provider/model` 决定（出厂 `deepseek-official` / `deepseek-flash`） | `dsh-base/cordis.patch.yml`、`dsh-llm-pi-ai/README.md` | managed.patch 写这两个条目（默认模型条目 id = **`agent-default-model`**，WP0b S5；原文：需 S5 确认） |
| F10 | 凭据解析顺序：**启动环境变量** > `.credentials.yaml` > 项目 `.env` > `$DSH_HOME/.env`；环境变量在界面只读 | `dsh-credentials-local/README.md` | 管理员下发的密钥以 env 注入 |
| F11 | DSH 沙箱是「同世界约束」，不是安全边界 | 农场方案 §2.2 | 隔离靠容器 |
| F12 | 单实例空闲 RSS：干净 profile ≈ 265MB，14 个 bundle ≈ 377MB；冷启动 2.8s | 农场方案 §1.4 | 默认 2GB 内存上限绰绰有余 |
| F13 | 遥测：`DSH_TELEMETRY_DISABLED` 非空即关闭 | `dsh-base/cordis.patch.yml` | 容器默认关闭 |
| F14 | 部分插件自带「只允许回环」的路由（`dsh-email@0.16.0` 的 `/_dsh/dsh-email/settings` 同时检查 `req.socket.remoteAddress` 与 `Host`） | WP0b S1 | 必须「容器内转发 + 回环 authority」——这是选 `127.0.0.1:3000` 的决定性理由 |
| F15 | profile 用 pnpm（`pnpm-workspace.yaml`，`nodeLinker: hoisted`）；npm ≥ 11.19 默认不执行依赖的 install 脚本，镜像构建要 `--allow-scripts=…`；只读根下 `PNPM_HOME` 必须在用户卷上 | WP0b S4/S6 | 已写进 `runtime/Dockerfile` |
| F17 | `--patch` 文件必须是 **YAML 数组**；只有注释的文件会让 DSH 启动失败（fatal） | WP2 真容器 | managed.patch.yml 至少输出 `workspace-controller` 条目，永不为空 |
| F18 | 只读根 + `noexec` 的 `/tmp` 下，DSH 的原生模块缓存加载失败 | WP2 真容器 | 镜像设 `NARB_DISABLE_NATIVE_CACHE=1` |
| F19 | Docker rootful 下宿主可直连容器 IP:3000（经 socat 转发器到 DSH 的 127.0.0.1:3001）；socat RSS ≈ 4.5MB（node 转发器 ≈ 50MB） | WP2 实验 | 默认 socat，`forward.mjs` 兜底 |
| F16 | 其他条目 id：`webserver`、`workspace-controller`（`documentsDirectory` 决定默认工作区根）、`agent-default-model`、`llm-pi-ai`；`deepseek-official` 的密钥 env 为 `DEEPSEEK_API_KEY` | WP0b S5/S7 | managed.patch 渲染依据 |

## 2. S1–S8 的验证结论（WP0b 已全部实测）

| # | 问题 | 验证方法（podman 即可，无需 sudo） | 不成立时的退路 | **结论（WP0b 实测）** |
| --- | --- | --- | --- | --- |
| S1 | `--host <容器IP>` 能否正常监听，Hub 以 `Host: dshhub-<slug>:3000` + `--trusted-host dshhub-<slug>:3000` 访问 `/api` 是否 200 | 起容器 → 宿主 curl 容器 IP | 容器内 `--host 127.0.0.1`，入口脚本再起一个 Node 小转发（`0.0.0.0:3001 → 127.0.0.1:3000`），Host 用 `127.0.0.1:3000` | **原方案不成立、退路成立（改用退路）**：schema 只接受 `127.0.0.1`/`0.0.0.0`，传容器 IP 直接 `ValidationError`；退路（容器内转发 + 回环 Host）实测全绿，还能让插件的「只允许回环」路由通过（如 dsh-email 的 settings 路由要求 remoteAddress 与 Host 都是回环）。rootless podman 下宿主无法直连容器 IP，需发布回环端口（§4） |
| S2 | DSH 界面挂在路径前缀 `/dsh/<用户名>/` 下能否完整工作（静态资源、`/api`、WS `/api/remote.mux`、SSE `/plugins/events`；WP16 前是 `/u/<slug>/`，slug 只是内部标识） | 移植 `dsh-remote/cloud/server.js` 的代理逻辑做最小代理，用无头 Chrome 打开 | 资源路径重写（HTML/JS 中 `"/assets/` 等）或 `<base href>` 注入；最差退路：每用户一个子端口不可行（无公网端口），则改用 cookie 路由的根路径（`/` 下按会话路由，Hub 自身页面移到 `/hub/`） | **成立**：前端全用相对路径，无需改资源路径，只要把 `/dsh/<用户名>` 301 到 `/dsh/<用户名>/`；WS 101、SSE 首帧立即到、设置页可开、0 console error。HTML 只需注入 `ownsHost` 一行 |
| S3 | 全新 `DSH_HOME` 首次 `dsh --profile web` 是否自动创建 `profiles/web` 且可直接用；首次启动耗时 | 空卷启动 | Hub 在 provision 时用一次性容器执行 `dsh --from-default-profile` 预建 | **成立**：0.09 s 从模板生成 profile，出厂 bundle 由全局安装解析、首启不需要 `pnpm install`；冷启动到可服务 ≈ 2.0 s |
| S4 | 插件安装的正确姿势：`dsh plugin --profile web add <spec>` 是否同时更新 `dsh.profile.bundles`？还是要 Hub 自己改 `package.json` 再 `pnpm install`？pnpm 是否随 DSH 提供 | 在容器里分别试 `dsh-email`（npm）与本地 tgz | 一律 Hub 改 `package.json` + `pnpm install --prod` | **成立（用 `dsh plugin add`）**：同时写 `dependencies`（精确版本，无 `^`）与 `dsh.profile.bundles`（追加在末尾）；容器内有 pnpm 10；`file:` tgz 也可行。Hub 只需按序重写 bundles 并保留备份回滚 |
| S5 | 默认模型条目的 **id**；`llm-pi-ai` 的 `providers` 经 `--patch` 下发后，模型选择器是否出现、默认模型是否生效；deepseek-official 的密钥 env 名 | `dsh --profile web --dump-config` 对比；界面验证 | 若 `--patch` 不能覆盖，则写入用户 profile 的 `cordis.patch.yml`（并在 manifest 记录，便于下次覆盖） | **成立**：默认模型条目 id = `agent-default-model`（webserver 条目 id = `webserver`）；`--patch` 覆盖 `llm-pi-ai.providers` 与默认模型后 dump-config 0 warning、浏览器模型选择器/设置页都看得到。被覆盖字段在设置页不回填、Apply 后被遮蔽（F5） |
| S6 | 只读根文件系统下 DSH 是否能跑（是否写 `/usr/local/lib/node_modules`、`~/.cache`、`/tmp`） | `--read-only --tmpfs /tmp` | 去掉 `ReadonlyRootfs`，保留其它限制 | **成立**：`--read-only --tmpfs /tmp` 下冷启动、页面、WS/SSE、`dsh plugin add`、重启全部正常，日志零 `EACCES/EROFS`；唯一要挪出镜像的可写目录是 pnpm 的 `PNPM_HOME` |
| S7 | 默认工作区：如何让 DSH 首次打开就落在 `/workspace`（旧门户是预置 `storages/workspace.json`） | 看 `~/.dsh/storages/` 的结构（**只看结构，不看值**） | 容器 `WorkingDir=/workspace` 并在唤醒页提示用户选择 | **成立（两条路都可用）**：① managed patch 写 `workspace-controller.config.documentsDirectory: /workspace` → 自动建 `/workspace/deepseek-harness/default-workspace`；② provision 时预置 `storages/workspace.json`（v2 结构）→ 工作区就是 `/workspace` 本体 |
| S8 | 就绪判据：DSH 写出 browser-session 密钥的时机（首次启动是否在监听前写好） | 启动后轮询文件 | 回退为抓取日志中的 `?token=` 做握手（旧门户做法） | **成立**：顺序是「先监听（~1.7 s）→ 写 browser-session 密钥（+40 ms）→ 200 + `__DSH_BOOT__`（~2.0 s）」，判据 ①② 会早熟（路由未挂完就 404），必须等 ③④ |

## 3. 运行时镜像 `runtime/`

**实现已完成并实测构建**：`runtime/Dockerfile`、`runtime/entry.sh`、`runtime/forward.mjs`、
`runtime/healthcheck.mjs`，产出 `dshhub/runtime:0.2.0-rc.2`（约 1 GB）。下面是与原草案的差异要点，
下面是结论摘要，历史实测记录未随开源版发布。

```dockerfile
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.0-rc.2
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai LANG=C.UTF-8 HOME=/home/dsh \
    DSH_HOME=/home/dsh/.dsh DSH_PORT=3000 DSH_TELEMETRY_DISABLED=1 \
    npm_config_registry=${NPM_REGISTRY} \
    PNPM_HOME=/home/dsh/.local/share/pnpm          # ← 必须在可写卷上（S4 坑 1）
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      tini git curl ca-certificates ripgrep jq unzip zip less procps python3 python3-venv \
      fonts-noto-cjk tzdata openssh-client \
 && rm -rf /var/lib/apt/lists/*
# 先改名再装包：npm 按 HOME 建目录，/home/dsh 已存在时 `usermod -m` 会拒绝
RUN usermod -l dsh -d /home/dsh node && groupmod -n dsh node && rm -rf /home/node \
 && mkdir -p /home/dsh /workspace /opt/hub/managed && chown -R 1000:1000 /home/dsh /workspace
# npm ≥ 11.19 默认不跑依赖的 install 脚本（S4 坑 2）
RUN npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" pnpm@10 && npm cache clean --force && rm -rf /root/.npm
COPY entry.sh healthcheck.mjs forward.mjs /opt/hub/
LABEL dshhub.runtime="1" dshhub.dsh_version="${DSH_VERSION}"
USER 1000:1000
WORKDIR /workspace
EXPOSE 3000
HEALTHCHECK CMD ["node", "/opt/hub/healthcheck.mjs"]   # 构建要 --format docker，否则 OCI 格式会忽略它
ENTRYPOINT ["/usr/bin/tini","--","/opt/hub/entry.sh"]
```

`entry.sh` 要点（两种绑定模式，默认 `DSH_BIND=loopback`）：

```sh
#!/bin/sh
set -eu
: "${DSH_AUTHORITY:?}"                       # Hub 实际发送的 Host：推荐 127.0.0.1:3000
: "${DSH_PORT:=3000}"; : "${DSH_BIND:=loopback}"; : "${DSH_HOME:=/home/dsh/.dsh}"
mkdir -p "$DSH_HOME/run"
if [ "$DSH_BIND" = any ]; then               # A：直接绑全网卡（需要 runtime patch 绕开 CLI 限制）
  printf '%s\n' '- id: webserver' '  config:' '    host: 0.0.0.0' \
    '    port: !!js ctx.webStartup.port ?? 3000' '    compression: gzip' \
    '    compressionLevel: 1' '    compressionThresholdBytes: 1024' > "$DSH_HOME/run/runtime.patch.yml"
  PATCH="--patch $DSH_HOME/run/runtime.patch.yml"; LISTEN=$DSH_PORT
else                                          # B（默认）：dsh 绑回环，转发器占对外端口
  DSH_PORT=$DSH_PORT DSH_UPSTREAM_PORT=$((DSH_PORT + 1)) node /opt/hub/forward.mjs &
  LISTEN=$((DSH_PORT + 1))
fi
[ -f /opt/hub/managed/managed.patch.yml ] && PATCH="$PATCH --patch /opt/hub/managed/managed.patch.yml"
exec dsh --profile web $PATCH --no-open --port "$LISTEN" --trusted-host "$DSH_AUTHORITY"
```

`healthcheck.mjs` = 05 §6 判据 ③④ 的容器内实现（读 `$DSH_HOME/.credentials.yaml` 现签 cookie →
带 `Host: $DSH_AUTHORITY` 请求 `127.0.0.1:$DSH_PORT/` → 断言 200 且含 `__DSH_BOOT__`），
`podman healthcheck` 与 Hub 的 `driver.exec(容器, ['node','/opt/hub/healthcheck.mjs'])` 都能直接用。

镜像构建由 Hub 通过 Docker API 完成（`runtime.build` 任务）：上下文 = `runtime/` 目录打 tar，
build-arg `DSH_VERSION`、`NPM_REGISTRY`；基础镜像经 `/etc/docker/daemon.json` 已配的国内 registry-mirrors 拉取。
构建日志逐行写入任务日志，完成后 `docker image inspect` 记录 `image_id`、`size_bytes`。
**若驱动是 podman**：还要 `--format docker`（保留 HEALTHCHECK），并显式清空代理 build-arg
（podman 会把宿主 `http_proxy` 注入构建容器，代理不通时 npm 直接 ECONNREFUSED）。

## 4. 容器规格（`ContainerDriver.create` 的输入）

```ts
interface ContainerSpec {
  name: string                      // dshhub-<slug>
  image: string                     // dshhub/runtime:<ver>
  env: Record<string, string>       // 见下
  labels: Record<string, string>    // dshhub.managed=1, dshhub.slug, dshhub.user_id, dshhub.runtime, dshhub.config_hash
  mounts: { host: string; container: string; readOnly: boolean }[]
  cpus: number; memoryMb: number; pidsLimit: number
  network: string                   // dshhub-users
  readOnlyRootfs: boolean           // 依 S6
}
```

env：

| 变量 | 值 |
| --- | --- |
| `HOME` | `/home/dsh` |
| `DSH_HOME` | `/home/dsh/.dsh` |
| `DSH_AUTHORITY` | Hub 实际发送的 Host。**推荐 `127.0.0.1:3000`**（回环天然受信、插件的回环路由可用）；用 `dshhub-<slug>:3000` 时必须与 `--trusted-host` 一致（S1） |
| `DSH_TELEMETRY_DISABLED` | `1` |
| `TZ` | `Asia/Shanghai` |
| `npm_config_registry` | `HUB_NPM_REGISTRY` |
| `HUB_SLUG` | `<slug>` |
| `HUB_MK_<ROUTE_KEY 大写下划线>` | 解密后的模型密钥（per-user 优先，其次 shared）；例如 `HUB_MK_HUB_RELAY` |
| `DEEPSEEK_API_KEY` | 仅当预设包含 `deepseek-official` 提供方时 |

挂载：

| 宿主 | 容器 | 模式 |
| --- | --- | --- |
| `users/<slug>/home` | `/home/dsh` | rw |
| `users/<slug>/workspace` | `/workspace` | rw |
| `users/<slug>/managed` | `/opt/hub/managed` | ro |
| `plugin-store` | `/opt/hub/plugin-store` | ro |

容器运行时参数（依 S1/S6 实测，rootless podman 与 Docker 的差别写在括号里）：

| 项 | 值 |
| --- | --- |
| 用户 / userns | `User=1000:1000`；**rootless podman 必须加 `--userns keep-id:uid=1000,gid=1000`**，否则容器 uid 1000 映射到宿主 subuid，挂载卷不可写（Docker rootful 不需要） |
| 网络 | 只接 `dshhub-users`（`enable_icc=false`）。**rootless podman 下 Hub 连不上容器 IP**（宿主没有到容器网段的路由），要给每个实例发布一个回环端口 `127.0.0.1:<port>:3000` 并连它；Docker rootful 直连容器 IP，无需发布 |
| 代理注入 | podman 会把宿主 `http_proxy` 等注入容器，必须 `--http-proxy=false`（dockerode 不自动注入 env，没这个问题） |
| 进程 | `Init`/tini 已由镜像 ENTRYPOINT 提供；`RestartPolicy: no` |
| 只读根 | `readOnlyRootfs: true` + `/tmp` tmpfs 512MB `nosuid,nodev`（S6 成立） |
| 日志 | `json-file`，`max-size=10m`，`max-file=3` |
| 健康检查 | 镜像自带 HEALTHCHECK（`node /opt/hub/healthcheck.mjs`）；podman 构建要 `--format docker` 才保留 |

`config_hash = sha256(image + cpus + memoryMb + pidsLimit + readOnlyRootfs + 排序后的 env 键=值 sha256 + mounts)`。
注意 env 值参与哈希但**哈希本身不可逆**，日志与 label 中都不出现明文。

## 5. 反向代理 `/dsh/<用户名>/*`（WP2 `modules/proxy`，WP16 改地址）

> 对外地址是 `/dsh/<用户名>/`（用户名 `^[a-z][a-z0-9_-]{2,31}$`，不可改也不可枚举）；
> slug（`^u[a-z0-9]{7}$`）只在内部使用：容器名 `dshhub-<slug>`、数据目录 `users/<slug>/`、标签与 `HUB_SLUG` 都不动。
> 旧地址 `/u/<slug>/...` 保留 301 到 `/dsh/<用户名>/...`（保留子路径与查询串）。

处理顺序：

0. **`GET /dsh/<用户名>`（无斜杠）必须 301 到 `/dsh/<用户名>/`**：DSH 前端全用相对路径（`./assets/…`、`plugins/??…`），
   少了斜杠资源会落到 `/dsh/assets/…` 上（实测 404）。这一步不需要改写任何 HTML 资源路径，也不需要 `<base href>`。
   用户名大写或形状不合法 → 直接 404（不做 301）。旧的 `/u/<slug>...`：先校验 `hub_sid` 会话属于该 slug 的主人，
   是主人则 301 到规范地址，未登录 302 登录，非主人/未知 slug 一律 404；WS 升级不跟随 301，旧地址直接 404。
1. 解析用户名（`^[a-z][a-z0-9_-]{2,31}$`）；校验 `hub_sid` 会话的用户名与路径一致（02 §7）——
   用户名不存在与不是主人返回同样的 404，不需要查库。**管理员例外**：会话是管理员时按路径用户名查库，
   未删除的用户放行，实例（容器名、DSH cookie、活跃度）都按**目标用户**处理，并写审计 `instance.admin.open`（02 §7.1）。
2. 取实例：未运行 → 返回唤醒页（HTML 由 hub-web 构建出的独立入口 `wake.html` 提供，不经 DSH）。
3. 构造上游请求：
   - 目标：`http://<容器IP>:3000<去掉 /dsh/<用户名> 的路径>`（rootless podman 下是 `http://127.0.0.1:<发布端口>…`，见 §4）；
   - `Host: <DSH_AUTHORITY>`；有 `Origin` 时改为 `http://<DSH_AUTHORITY>`；`Referer` 同理只改 origin（路径保留，含 `/dsh/<用户名>/` 前缀）；
   - 删除浏览器带来的 `cookie` 中的 `hub_sid` 与所有 `dsh-auth-*`，追加 `dsh-auth-<…>=<现签值>`；
   - 删除 `x-forwarded-*` 外部值后重设 `x-forwarded-for`（真实 IP）、`x-forwarded-proto: https`；
4. WebSocket：`server.on('upgrade')` 同样做 1–3，双向 pipe；空闲 10 分钟无帧则断开。
5. SSE / 流式：不缓冲、不压缩、不改 `content-length`；`flushHeaders` 立即发出。
6. HTML 文档（`Accept` 含 `text/html` 且响应含 `__DSH_BOOT__`）：**请求上游时把 `accept-encoding` 改成 `identity`**
   （DSH webserver 开了 gzip，压缩体没法注入），在 `</body>` 前注入：

   ```html
   <script>globalThis.__DSH_TRANSPORT__={...globalThis.__DSH_TRANSPORT__,ownsHost:true}</script>
   ```

   `ownsHost` 决定客户端的 `isLoopback`（设置页依赖它，S2 实测缺了会报 settings unavailable）；
   同一处再注入一个极小的悬浮按钮「回到 Hub」（`#dshhub-back`，可在设置里关掉）。注入后 `Content-Length` 要重算。
7. 响应头：移除 `dsh-auth-*` 的 `Set-Cookie`；其它 cookie 的 `Path` 改写到 `/dsh/<用户名>/` 之下并去掉 `Domain`；加 `X-Frame-Options: SAMEORIGIN`。
8. 活跃度：每个请求/WS 帧更新内存中的 `lastActiveAt`，每 30 秒批量落库。
9. 在场信息（WP33，22 §6.1）：按**实例主人**维护打开的 WS 数与最后断开时刻（`openClients` / `lastClientAt`），
   供实例休眠规则用；管理员看别人的实例也计入那个主人的数。客户端半关闭（关标签页）即收尾，不留悬空连接。

补充（WP0b 实测）：

- **authority 的选择**（S1）：`Host: 127.0.0.1:3000` + 容器内转发器 → 插件自带的「只允许回环」路由
  （F14，例如 `dsh-email` 的设置/资源路由）才能用，也不需要 `--trusted-host`；代价是所有用户的
  authority 与 cookie 名相同（签名密钥仍是每实例一份，cookie 不通用，且从不下发浏览器）。
  用 `dshhub-<slug>:3000` 则保留 per-user cookie 名，但这类插件路由会 403。默认取前者。
- **设置页不是 URL 路由**：`/dsh/<用户名>/settings` 会 404（历史上 `/u/<slug>/settings` 同样 404），验收脚本要点侧栏 `button[aria-label="Settings"]`。
- **WS/SSE 实测**：`/api/remote.mux` → 101（浏览器收到 ≥3 帧）；`/plugins/events` → `text/event-stream`
  首帧立即到达（`{"requests":140,"upgraded":3,"sse":3,"injected":4,"errors":0}`）。

cookie 签发（复刻 `mint-cookie.mjs`，单元测试必须与它逐字节一致）：

```ts
name  = 'dsh-auth-' + base64url(sha256(authority))
body  = base64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))   // issuedAt=now, expiresAt=now+1h
value = 'v1.' + body + '.' + base64url(hmacSha256(secret, body))
```

密钥读取：`users/<slug>/home/.dsh/.credentials.yaml` → 取 `records["client-connection/browser-session"].payload.secret`；
按文件 mtime 缓存；签出的 cookie 缓存 50 分钟。WP0b 的实现（`scripts/spike/mint-cookie.mjs`）用正则读这一行、
不引入 YAML 依赖，并有与参考实现逐字节对照的单元测试（7 例全绿）；`ttlMs` 超过 25 天直接抛错，
避免签出被实例拒绝的 cookie。

## 6. 生命周期与状态机

```
absent ──provision──► stopped ──start──► starting ──ready──► running ──stop──► stopping ──► stopped
                         ▲                   │                  │
                         └──────── error ◄───┴──── 崩溃/超时 ───┘   （error 可重试 start；不自动重启）
```

| 操作 | 行为 |
| --- | --- |
| provision | 建 `users/<slug>/{home,workspace,managed}`（0700）；渲染 `managed/`（其中**总是**包含 `workspace-controller.config.documentsDirectory: /workspace`，使默认工作区落在 `/workspace/deepseek-harness/default-workspace`——已定用配置驱动，不预置 `storages/workspace.json`，避免耦合 DSH 内部存储格式）；`instances` 行置 `stopped`（不建容器） |
| start | 检查容量（`capacity.maxRunning`）→ 期望规格算 `config_hash` → 容器不存在或哈希不同则（删旧）建新 → start → 就绪等待（≤ 90s）→ 首次则跑 bootstrap（应用 required/default 插件）→ `running` |
| 就绪判据 | ①容器 running；②容器 IP:3000 TCP 可连；③browser-session 密钥可读；④带现签 cookie `GET /` 返回 200 且含 `__DSH_BOOT__`。**①② 会早熟**（端口一通就可能先返回 404，路由还没挂完），必须等 ③ 之后再做 ④。实测冷启动时序：② +1.7 s → ③ +1.77 s → ④ +2.0 s（WP0b S8）；轮询间隔 100 ms |
| stop | `docker stop -t 15`，保留容器（下次 start 若哈希未变直接 start，更快） |
| restart | 哈希变了 → recreate；否则 `docker restart` |
| recreate | stop → remove → create → start（数据在卷上不受影响） |
| 对账 | Hub 启动时及每 60 秒：列出 `label dshhub.managed=1` 的容器，与 `instances` 对齐（容器没了 → `stopped`；意外退出 → `error` 并附最后 50 行日志） |
| 会话探针（WP33） | 每分钟对 `running` 实例发一次 `POST /api/session/list`（Hub 现签 DSH cookie；**只读**：不 attach、不拿写租约、不建会话），读 `items[].running`（含子代理会话）与 `updatedAt`（用户消息推进）。超时 3 s、并发 ≤ 8、**不 touchActivity**、只探 `running`（绝不唤醒已停实例）。结果落 `instances.probe_state/probe_at/running_sessions/last_busy_at/last_prompt_at/last_client_at`（迁移 102） |
| 休眠规则（WP33，22 §6.2） | 每分钟一轮，按探针状态分流：**busy**（任一会话 running）不停、记 `lastBusyAt`，连续 busy 超过 `capacity.busyMaxMinutes`（缺省 720，0=不限）才按空闲规则处理并写日志；**watching**（无 running、`openClients ≥ 1`）到 `now - max(startedAt,lastBusyAt,lastPromptAt) ≥ idleStopMinutes`；**unattended**（无 running、`openClients = 0`）到 `now - max(startedAt,lastBusyAt,lastPromptAt,lastClientAt) ≥ idleNoClientMinutes`（配额，缺省 30；0=沿用 `idleStopMinutes`）；**unknown**（探针失败/旧版 DSH）沿用下面的 CPU 规则。`idleStopMinutes = 0` 仍是「不自动停」。审计 `instance.stop`（reason `idle`）的 detail 写 `probeState`/`rule`/`idleMinutes`/`thresholdMinutes` 与各时间点 |
| 空闲回收（旧规则，仅未知状态） | 每分钟：`running` 且 `now - max(lastActiveAt, startedAt) > idleStopMinutes` 且最近 5 分钟平均 CPU < 3% → stop（审计 `instance.stop`，reason `idle`）。**空闲起点取两者较晚的那个**：`lastActiveAt` 只在有代理流量时更新（管理端展示的「真实使用时间」），启动/重启/重建/对账恢复只刷新 `startedAt`，所以刚被管理员启动、还没人打开 DSH 的实例不会被上一轮的旧 `lastActiveAt` 立刻回收。CPU 判据每分钟采一个样本、**采满 5 个（≈5 分钟）**才判定，重启/离开 running 时样本清零；防止停掉正在后台跑长任务的 agent。开着标签页不再让实例永不休眠（走 watching），没人看但 agent 在跑的回合也不会被中途停掉（走 busy） |
| 管理端列表（WP33） | `listForAdmin` **一次** `docker ps`（`listManaged()`）拿全部容器状态/标签，替代逐行 `inspect`；期望 `config_hash` 并发算（各自 5 s 记忆）；stats **不内联**——后台采样器每 15 s 采运行中实例（并发 ≤ 4，只在最近 2 分钟有管理员请求过列表时运转；空闲回收那一路的采样也写同一份缓存），列表只带缓存值与 `statsAt`。本机实测：`docker ps -a` ≈ 30 ms、`docker stats --no-stream` ≈ 2.0 s |
| 并发控制 | 每个用户一把异步锁（`withUserLock(userId, fn)`）；实例操作、插件安装、导出读 profile 都走它 |

## 7. 容量与配额

- **算力租赁（13）**：计费开启时 `cpus`/`memoryMb` 取租约规格，启动前另有余额准入（402）与内存准入（`compute.capacityMemoryMb`，503）。

- 同时运行上限 `capacity.maxRunning`（默认 12；按宿主内存估算，可在系统设置的容量项里调）。超出时 start 返回 `CAPACITY_FULL`，前端提示「当前使用人数较多」并提供排队重试。
- 磁盘：每 10 分钟对 `users/<slug>` 做一次 `du`（`fs` 递归统计，不跟随符号链接，包含 `node_modules`），写入内存缓存；
  超过 `diskGb` 的 100% → 在「我的工作台」显示红色提醒并**拒绝再启动**（`403 DISK_QUOTA_EXCEEDED`，`details: {usedBytes, limitBytes}`；已运行的不强停）；超过 90% 黄色提醒。
- 宿主资源仪表：`/proc/loadavg`、`/proc/meminfo`、`statfs(HUB_DATA_DIR)`。

## 8. ContainerDriver 接口（WP0 定义，WP2 实现）

```ts
export interface ContainerDriver {
  ping(): Promise<{ ok: boolean; version?: string }>
  ensureNetwork(name: string, subnet: string): Promise<void>        // enable_icc=false
  inspect(name: string): Promise<ContainerInfo | null>              // {id, state:'running'|'exited'|..., ip, labels, startedAt, exitCode}
  create(spec: ContainerSpec): Promise<{ id: string }>
  start(name: string): Promise<void>
  stop(name: string, timeoutSec: number): Promise<void>
  remove(name: string): Promise<void>
  restart(name: string, timeoutSec: number): Promise<void>
  exec(name: string, cmd: string[], opts?: { env?: Record<string,string>; timeoutMs?: number; onOutput?: (chunk: string) => void }): Promise<{ exitCode: number; output: string }>
  runOnce(spec: ContainerSpec, cmd: string[], opts?: { timeoutMs?: number; onOutput?: (chunk: string) => void }): Promise<{ exitCode: number; output: string }>  // 一次性维护容器，--rm
  logs(name: string, opts: { tail: number; follow?: false }): Promise<string>
  followLogs(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void>
  stats(name: string): Promise<{ cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; pids: number } | null>
  listManaged(): Promise<ContainerInfo[]>                           // label dshhub.managed=1；一次 docker ps，startedAt/exitCode 为 null（要精确值请再 inspect 那一个）
  buildImage(contextDir: string, tag: string, buildArgs: Record<string,string>, onLog: (line: string) => void): Promise<{ imageId: string; sizeBytes: number }>
  removeImage(tag: string): Promise<void>
  imageExists(tag: string): Promise<boolean>
}
```

`FakeDriver`：内存实现，`create/start` 后用一个本机 HTTP 假 DSH（返回含 `__DSH_BOOT__` 的页面、回显 Host/cookie 的 `/api/echo`）模拟容器，
供全部单元/集成测试与「无 Docker 开发模式」使用。
