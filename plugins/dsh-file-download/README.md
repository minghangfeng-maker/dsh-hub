# @local/dsh-file-download

给预览中的工作区文件加一个「下载到本地」按钮：**Host 半边的流式下载路由 + 浏览器原生下载**
（支持大文件、进度、暂停/断点续传）。

## 为什么需要它

原来浏览器拿文件是 `workspaceFiles.readBytes` + `Blob` 保存：一次性的整份 RPC ——
Host 要把整个文件读进内存，浏览器的下载管理器看不到进度、不能暂停/续传，连接一断就从 0 开始。

本插件改成 Host 流式路由：

- `GET/HEAD /api/workspace.download`，按 `Range` 分块从 `ctx.fs` 读（每块 4 MiB，
  限制的是 Host 内存而不是文件大小）；浏览器自己的下载管理器接管传输 —— 进度条、
  暂停/断点续传、后台继续、比进程内存还大的文件都能下载。
- 路由挂在 `/api` 下，所以 Connection 的浏览器信任栅栏与浏览器会话 Cookie 会像 RPC 一样
  认证它；客户端用文档相对路径 `api/workspace.download` 寻址。
- 文件通过组合文件系统提供者读取，和预览用同一套闸门：Session 头指定工作区根、
  路径最后一段不能是符号链接、目标必须是普通文件；路由不列目录、不写。
- 响应头固定 `no-store` / `nosniff` / CSP `sandbox` / `no-transform`（关掉 gzip，
  保证下载带真实 `Content-Length`，浏览器能显示进度）。

## 安装

1. 打成一个 npm 包：

   ```bash
   npm pack . --pack-destination dist --ignore-scripts
   ```

2. 装进 DSH profile（三选一）：
   - **Hub 管理台**：插件库 → 添加插件 → 上传上一步的 `.tgz`，再下发给用户；
   - **命令行**：`dsh plugin --profile <profile> add ./dist/local-dsh-file-download-1.2.0.tgz`；
   - **本地开发**：profile 的 `package.json` 里加
     `"@local/dsh-file-download": "link:/path/to/dsh-file-download"`，并把包名加进
     `dsh.profile.bundles`，然后重启 DSH。

3. 打开任意文件的预览，动作区会多一个「下载」按钮。

> 包名保持 `@local/dsh-file-download`：Hub 插件库与桌面随包清单按包名识别插件，改名会断升级路径。

## 配置

本插件**不需要配置**：`cordis.patch.yml` 里只插入一行 Loader 行，`config` 留空。

唯一的可选调整见 `cordis.patch.yml` 末尾的注释：若 Host 是**旧版**（没有流式路由），
按钮会回退到「整份读取 + Blob」，而回退路径受 `workspace-files` 的 `maxFileBytes` 限制。
需要兼容超大文件时再按注释取消那四行（补丁对匹配到的 `config` 是整块替换，四项必须写全）。

## 失败语义

路由把失败映射成状态码 + 稳定的机器可读原因（`x-file-download-error` 头，HEAD 没有响应体时也带）：

| 情况 | 状态 | 原因 |
|---|---|---|
| 文件不存在 | 404 | `FS_NOT_FOUND` |
| 不是普通文件 | 403 | `FS_NOT_REGULAR_FILE` |
| 其它文件系统拒绝 | 403 / 400 | 后端 published code 原样透传 |

客户端在把 URL 交给浏览器之前先发一次 `HEAD` 预检 —— 文件不存在或登录过期会变成一句
可读的提示，而不是一个失败的下载。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册流式下载路由（`/api/workspace.download`） |
| `client.js` | Client 半边：预览动作区的「下载」按钮 + `HEAD` 预检 + 旧 Host 回退 |
| `cordis.patch.yml` | 插入 `file-download` 这一行 |
| `test/route.test.mjs` | 路由行为测试（真文件 + mock ctx/fs） |

## 测试

```bash
node test/route.test.mjs     # 47 个用例
```

## 许可

Apache-2.0。
