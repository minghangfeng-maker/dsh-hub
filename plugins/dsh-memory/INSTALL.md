# dsh-memory 安装说明（可安装包 v{{VERSION}}）

这个目录里是可安装的 DSH 插件包：

| 文件 | 用途 |
|---|---|
| `dsh-memory-{{VERSION}}.tgz` | 插件包本体（`@local/dsh-memory`），装进目标 DSH 的某个 profile |
| `install.sh` | 命令行一键安装（把 tgz 复制到长期路径，再调 `dsh plugin`） |
| `dsh-memory-{{VERSION}}-source.tar.gz` | 对应源码快照（可选，改代码/排查用） |
| `SHA256SUMS` | 校验和（覆盖 tgz、源码快照、install.sh、INSTALL.md） |

```bash
sha256sum -c SHA256SUMS       # 校验（macOS: shasum -a 256 -c SHA256SUMS）
```

**已验证的 DSH 版本：`0.2.1-rc.2`。** 插件用的是宿主 API（工具注册、session projection、
`agent/pre-step`、webServer 路由），更旧/更新的 DSH 没有测过；版本不一致时先按本文验证一遍。

插件本身**没有任何 npm 依赖**，只需要 Node 内置模块；打包好的 tgz 离线可装。

---

## 前置条件

1. 目标机器有 `dsh` 命令，版本 0.2.1-rc.2：

   ```bash
   dsh --version
   ```

2. 目标 profile 已存在（Web 用户至少启动过一次，`${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json`
   在）。要装到别的 profile，把下文 `web` 换成 profile 名。
   如果目标 DSH 用了自定义 `DSH_HOME`（不是 `~/.dsh`），下文所有命令都要带上它——
   `dsh plugin` 只认 `DSH_HOME` 环境变量（它**没有** `--home` 参数；`--home` 是本目录
   `install.sh` 自己的选项）。
3. `dsh plugin` 会把参数转给 **pnpm**：命令行安装固定用 PATH 里的 pnpm，所以 pnpm 必须在
   PATH 里（Web 插件页那条安装路径可以用 profile 里 `plugin-manager` 的 `pnpmCommand` 兜底）：

   ```bash
   pnpm --version    # 没有输出就先装 pnpm，或把 pnpm 所在目录加进 PATH
   ```
4. 把 tgz 放到目标机器上一个**长期保留**的位置，例如 `${DSH_HOME:-$HOME/.dsh}/plugin-packages/`。
   ⚠️ 不要放 `/tmp` 或下载目录：profile 里记的依赖是 `file:/绝对/路径.tgz`，tgz 删了以后
   `pnpm install` 会失败。

   ```bash
   mkdir -p "${DSH_HOME:-$HOME/.dsh}/plugin-packages"
   # 目标机 DSH_HOME 默认 ~/.dsh 时：
   scp dsh-memory-{{VERSION}}.tgz 用户@目标机:'~/.dsh/plugin-packages/'
   ```
5. 记忆数据默认写到**运行用户的 `~/.dsh/memory`**，不跟随 `DSH_HOME`（详见「数据目录与迁移」）。

---

## 方式 A：Web 界面安装（有图形界面时最省事）

1. 打开目标 DSH Web → 侧栏 **插件** → **添加插件**（Add plugin）。
2. 在包名输入框里填 tgz 的**绝对路径**，例如
   `/home/you/.dsh/plugin-packages/dsh-memory-{{VERSION}}.tgz`，点安装。
   （UI 文案写的是「包名或地址」，没列压缩包，但后端接受 `.tgz`/`.tar.gz` 绝对路径，
   直接粘即可；同一个输入框也接受包名、Git 地址、本地目录。）
3. 装完在完成页点 **立即启用**（Enable now）；或回到插件列表把 `@local/dsh-memory` 打开。
   启用即把该包加进 profile 的 `dsh.profile.bundles`。
4. **重启这个 profile 的 DSH 实例**（宿主进程），刷新页面。插件是宿主启动时加载的，
   配置改动可以热更，新装插件的代码不行。

---

## 方式 B：命令行安装（远程/无界面）

一条命令（在本目录下）：

```bash
./install.sh web          # 参数是 profile 名，默认 web
```

`install.sh` 用环境变量 `DSH_HOME` 定位 profile（默认 `~/.dsh`）。目标 DSH 用了自定义
`DSH_HOME` 时必须一起指定，否则会去装 `~/.dsh` 下同名的 profile：

```bash
DSH_HOME=/opt/dsh-home ./install.sh web
# 等价：./install.sh web --home /opt/dsh-home
```

或者手动执行等价步骤：

```bash
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"   # 自定义 DSH_HOME 就改成实际路径
mkdir -p "$DSH_HOME/plugin-packages"
cp dsh-memory-{{VERSION}}.tgz "$DSH_HOME/plugin-packages/"
dsh plugin --profile web add "file:$DSH_HOME/plugin-packages/dsh-memory-{{VERSION}}.tgz"
```

`dsh plugin add` 会自动完成三件事：写 `profile/package.json` 的依赖、跑 pnpm 安装、
把带 `dsh.bundle.patch` 的新包加进 `dsh.profile.bundles`。装完同样要**重启**该 profile 的
DSH 实例。

检查是否装进去了（不需要重启；自定义 DSH_HOME 时加 `DSH_HOME=/opt/dsh-home` 前缀）：

```bash
dsh --profile web --dump-config | grep -A8 "@local/dsh-memory"
# 期望看到：
#   - id: memory
#     name: '@local/dsh-memory'
#     config:
#       hotBudgetChars: 6000
#       ...
# grep 前面可能还有一行 `# == @local/dsh-memory` 注释，正常。
# 如果你在 profile 的 cordis.patch.yml 里覆盖过 config，这里只显示你写的那几个键。
```

> 只把 tgz 传到目标机也有安装说明：tgz 里带了一份 `INSTALL.md`
> （`tar -xzOf dsh-memory-{{VERSION}}.tgz package/INSTALL.md`）。

---

## 装完怎么确认能用

1. 重启后打开 Web：**设置 → 记忆**，应有 概览 / 记忆文件 / 会话记忆 / 整理 / 收件箱 几页。
2. 新开一个会话，让模型记一条再读回来（工具名 `memory_write` / `memory_read`）。
3. 不想动真实数据，跑包内冒烟（冒烟自己用临时目录，结束自动清理，不碰 `~/.dsh/memory`）：

   ```bash
   node "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@local/dsh-memory/tools/smoke.mjs"
   # 期望最后一行：冒烟结果：15/15 通过
   ```

---

## 数据目录与迁移

- 默认数据目录：`~/.dsh/memory`（`<home>/global`、`<home>/workspaces/<key>`、`sessions/`、
  `archive/`、`inbox/`、`journal.jsonl`、`stats.json`、`settings.json`）。
- ⚠️ 数据目录**不跟随 `DSH_HOME`**：插件的默认值就是运行用户的 `~/.dsh/memory`。如果目标 DSH
  用了自定义 `DSH_HOME`（比如 `/opt/dsh-home`），要么在 memory 行配 `home:`，要么设环境变量
  `DSH_MEMORY_HOME`；否则记忆数据仍在 `~/.dsh/memory`。
- 想换位置：profile 的 `cordis.patch.yml` 里给 `memory` 行配 `home:`，或设环境变量
  `DSH_MEMORY_HOME`（config 里的 `home` 优先）。
- **把旧机器的记忆搬过来**：直接把整个目录拷过去即可。

  ```bash
  rsync -a ~/.dsh/memory/ 目标机:~/.dsh/memory/
  ```

  - `global/` 下的条目跨机器直接生效；
  - `workspaces/<key>/` 的 key 由**会话工作目录的绝对路径**编码（`/home/a/work` →
    `--home-a-work--`），两台机器工作目录不同就对不上。要么新机器用同样的工作目录，
    要么把要用的条目改到 global 作用域。
  - `settings.json` 里存了定时整理用的**模型**（provider/model）。换机器后如果那边没有这个
    模型，深整理会报错；到 **设置 → 记忆 → 整理** 里重新选一个即可。
- 目录/文件权限 0600、0700；条目 / 会话笔记 / 收件箱的写操作都进 `journal.jsonl`，设置页可撤销
  （`settings.json`、`stats.json`、`tags.json` 和索引重建不写 journal）。

---

## 配置

部署级参数（热层预算、注入预算、子代理写入策略等）在 profile 的
`cordis.patch.yml` 里**覆盖**，不要重复 `insert`：

```yaml
- id: memory
  config:
    hotBudgetChars: 6000
    injectBudgetChars: 9000
    recentSessions: 20
    graceSessions: 5
    staleDays: 30
    subagentWrites: inbox
```

patch 会**替换整个 config**，所以每个键都要重述。定时整理（开关、深整理频率/时间、模型）
是用户设置在 **设置 → 记忆 → 整理** 里改的，存在 `<home>/settings.json`，不在 patch 里。

---

## 升级 / 卸载

- 升级：拿到新 tgz 后重复安装即可（profile 里记的依赖是 `file:` 绝对路径，用同样的
  `file:` 形式写；否则 pnpm 会提示 `Replaced ... from a different source`，结果正确）：

  ```bash
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
  dsh plugin --profile web add "file:$DSH_HOME/plugin-packages/dsh-memory-<新版本>.tgz"
  ```

  然后重启。包名不变，profile 依赖会被替换，bundle 选择保持。
- 卸载：Web 插件列表里 Remove；或

  ```bash
  dsh plugin --profile web remove @local/dsh-memory
  ```

  卸载不会删数据目录；不想要记忆了再手动删 `~/.dsh/memory`。

---

## 常见问题

**装完设置里没有「记忆」**
- 没重启宿主进程（最常见）。插件代码只在启动时加载。
- 插件列表里 `@local/dsh-memory` 没启用。
- profile 的 `cordis.patch.yml` 里也 `insert` 了同一个包：包自带的 patch 已经插入
  `id: memory`，重复 insert 会挂两次。删掉用户 patch 里的 insert，用 `- id: memory` 覆盖。

**`dsh: pnpm was not found`**
- 把 pnpm 放进 PATH 再重跑；`dsh plugin` 就是 pnpm 的转发器。

**`ERR_PNPM_... file:...tgz` / ENOENT**
- profile 里记的是 tgz 的绝对路径：tgz 被删、或从别的机器拷 profile 过来导致路径不存在。
  把 tgz 放回原路径，或重新 add 一次。

**`dsh plugin` 报版本不兼容**
- 本包没有声明 `engines.dsh` / peerDependencies，正常不会拦；如果目标 DSH 版本更旧导致
  运行期报错，本包没有为旧版本做兼容。

**能装进 headless / 其它 profile 吗**
- 能，工具和注入不依赖 web；但 `/memory/api` 和设置页需要 `webServer`，只有 web profile
  （或装了 `@deepseek-ai/dsh-web-app` 的 profile）才有。headless 里能用 memory_* 工具。
  profile 的 `dsh.profile.bundles` 里有 `@deepseek-ai/dsh-base` 这类基础 bundle 即可。
- 自定义 `DSH_HOME` 时，验证命令也要带上：`DSH_HOME=/opt/dsh-home dsh --profile ... --dump-config`。

**升级/重装时 pnpm 打 `Replaced "@local/dsh-memory" ... from a different source`**
- 无害：指的是「这次传的 spec 写法（裸路径）和已记的 `file:` 写法不同」，装完依赖仍只有一条、
  bundle 不会重复。用 `file:` 形式（见「升级 / 卸载」）就不会提示。

**安全：别把 DSH Web 端口直接暴露出去**
- 记忆的 HTTP 接口 `/memory/api` 和 DSH Web 同端口（只监听回环），读接口没有额外的 token
  校验，写接口只做浏览器跨站来源校验。需要远程访问时走 DSH 自己的入口 / 隧道 / 反代认证，
  不要把 `127.0.0.1:3080` 之类端口直接映射到公网。
- 写接口校验 `Origin` 与 `Host` 一致：反代/隧道必须**保留原始 Host**（或同时改写 Origin），
  否则设置页里的保存会 403（读取不受影响）。
