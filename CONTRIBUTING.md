# 参与开发

欢迎 issue 与 PR。提之前先看一眼 [README](README.md) 与 [docs/design/](docs/design/README.md)，
很多「为什么这么做」在里面。

## 环境与命令

```bash
node -v          # 24.x（见 .nvmrc）
corepack enable  # 或者自己装 pnpm 10.33.2（packageManager 已固定）

pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r --workspace-concurrency=1 test   # 串行跑：每个 vitest 最多 4 worker，并行开多个会吃光内存
pnpm e2e         # 可选：真 Docker + 真浏览器的端到端（很慢，见 e2e/README.md）
```

提交前这四条（build / typecheck / lint / test）必须全绿——CI 就跑这四条。

## 工程约定

| 项 | 约定 |
| --- | --- |
| 语言 | TypeScript strict、ESM；Node 内置模块用 `node:` 前缀 |
| 风格 | Prettier（2 空格、单引号、无分号、行宽 110）；ESLint 不得有 error |
| 命名 | 文件 kebab-case；类型 PascalCase；变量 camelCase；数据库列 snake_case，DTO 字段 camelCase（在 repo 层转换） |
| 注释 | 写「为什么」，不写「是什么」；公共接口加一句 TSDoc |
| 错误 | 业务错误统一抛 `HubError(code, message?, details?)`，不要直接 `reply.code(400).send(...)` |
| 日志 | 用 `req.log` / `app.log`（pino）；**不要打印**密钥、cookie、token、密码 |
| 时间 | `new Date().toISOString()`；需要可测试时从 `ctx.clock.now()` 取 |
| SQL | 只写在 `modules/<m>/repo.ts` 里；全部参数化；事务用 `db.tx(fn)` |
| 迁移 | `apps/api/src/db/migrations/NNN_xxx.sql`，编号连续、只增不改；表结构变更同时更新 `docs/design/03-数据模型.md` |
| 契约 | 接口契约以 `docs/design/04-API接口.md` 为准，schema 在 `packages/shared/src/api/*.ts`；`contract-map.ts` 登记「接口 → schema」，`packages/shared/test/contract.test.ts` 会核对覆盖率 |
| 测试 | Vitest；后端集成测试用 `buildApp({ testing: true })` + `app.inject`（不监听端口）；容器相关一律用 FakeDriver，真容器测试放 `*.podman.test.ts` 且没有 `DOCKER_HOST` 时自动跳过 |
| 前端 | `<script setup lang="ts">`；样式用 Uno 原子类 + 设计令牌变量，**禁止写死颜色值**；开发假数据走 `?mock=`（`apps/web/src/mocks/`，只在 DEV 生效） |

**不要引入原生依赖**（`better-sqlite3`、`sharp`、`argon2`、`bcrypt` 之类）：数据库用 `node:sqlite`，
密码用 `node:crypto` 的 scrypt，这样装依赖不需要编译工具链。

模块之间只能通过 `modules/index.ts` 导出的 service 接口互相调用，不要跨模块 import 别人的 repo。

## 提交与 PR

- 一个 PR 一件事；标题写清「改了什么 + 为什么」。
- 提交信息用 conventional commits 风格，常见的几种：

  ```
  feat(api): 插件下发支持按标签筛选
  fix(web): 浅色主题下状态条的对比度
  docs(design): 补充中转站计费口径
  chore(deps): 升级 vitest 到 3.2.7
  ```

- 破坏性改动写 `feat!:` / `fix!:`，并在正文里写 `BREAKING CHANGE:` 一段。
- 改了接口或数据模型：同一个 PR 里更新 `packages/shared` 的 schema、`contract-map.ts` 与
  `docs/design/` 对应章节。
- 新功能请带测试；修 bug 请带能复现的测试。
- 不要在 PR 里放 `node_modules/`、`.data/`、构建产物、真实域名/IP/本机路径、任何真实密钥。

## 报告问题

- 功能/缺陷：开 issue，附上版本、部署方式（Docker / fake 驱动）、复现步骤与日志（**删掉密钥与域名**）。
- 安全漏洞：**不要开 issue**，按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

提交即表示你同意以 [Apache-2.0](LICENSE) 授权你的贡献。新增文件不需要逐个头注释，仓库根有 LICENSE。
