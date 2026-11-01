import { statSync } from 'node:fs'
import { join } from 'node:path'
import { PROOF_CONTENT, PROOF_FILE } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { dockerExec } from '../src/harness.js'

/**
 * J5 工作区落盘（10 §C4，另加 E2/E3 需要的诱饵文件）
 *
 * 以 uid 1000 往容器里的 `/workspace/...` 写文件 → 宿主 `users/<slug>/workspace` 立刻可见且属主 1000。
 * 顺带布置导出测试要用的排除项与符号链接（`.env`、`.credentials.yaml`、`node_modules/`、指向 /etc/passwd 的软链）。
 */
export default {
  id: 'J5',
  title: '工作区落盘（容器 /workspace ↔ 宿主 users/<slug>/workspace，属主 1000）',
  dependsOn: 'J3',
  async run(ctx) {
    const slug = ctx.requireDefined('世界状态里有 A 的 slug', ctx.world.state.users.A?.slug)
    const container = ctx.requireDefined(
      'e2e 网络里能找到 A 的容器',
      ctx.world.state.users.A?.containerName ?? (await ctx.hub.containerForSlug(slug)),
    )

    // ── 1. 容器内以 uid 1000 写文件 ──────────────────────────────────────
    const written = await dockerExec(container, [
      'sh',
      '-c',
      `set -e
printf '%s\\n' '${PROOF_CONTENT.trim()}' > /workspace/${PROOF_FILE}
mkdir -p /workspace/node_modules/decoy
printf 'should be excluded\\n' > /workspace/node_modules/decoy/index.js
printf 'SECRET=not-a-real-secret\\n' > /workspace/.env
printf 'not-a-real-credential\\n' > /workspace/.credentials.yaml
ln -sfn /etc/passwd /workspace/passwd-link
ln -sfn ../../outside /workspace/outside-link
id -u > /workspace/.e2e-uid
ls -la /workspace`,
    ])
    ctx.require(
      'docker exec（uid 1000）在容器内写入 /workspace 成功',
      written.code === 0,
      `code=${String(written.code)} out=${written.stdout.slice(0, 200)} err=${written.stderr.slice(0, 200)}`,
    )
    const uid = await dockerExec(container, ['cat', '/workspace/.e2e-uid'])
    ctx.expect(
      '写入进程的 uid 是 1000（docker exec -u 1000:1000）',
      uid.stdout.trim() === '1000',
      `id -u → 「${uid.stdout.trim()}」`,
    )

    const insideRead = await dockerExec(container, ['cat', `/workspace/${PROOF_FILE}`])
    ctx.expect('容器内能读回文件内容', insideRead.stdout.trim() === PROOF_CONTENT.trim(), insideRead.stdout.trim())

    // ── 2. 宿主侧检查（挂载卷是同一个目录） ──────────────────────────────
    const hostWorkspace = join(ctx.hub.dataDir, 'users', slug, 'workspace')
    const hostFile = join(hostWorkspace, PROOF_FILE)
    const exists = await ctx.check(`宿主 ${hostWorkspace.replace(ctx.hub.dataDir, '.data/<run>')}/${PROOF_FILE} 存在`, () => {
      statSync(hostFile)
    })
    if (exists) {
      const stat = statSync(hostFile)
      ctx.expect('宿主文件属主是 uid 1000（xdedmi）', stat.uid === 1000, `uid=${String(stat.uid)}`)
      ctx.expect('宿主文件属主 gid 是 1000', stat.gid === 1000, `gid=${String(stat.gid)}`)
    }
    ctx.expect(
      '宿主目录 users/<slug>/workspace 存在（与容器内同一目录）',
      statSync(hostWorkspace).isDirectory(),
    )

    // 诱饵文件也在宿主上（J6 校验导出排除规则时用）
    for (const decoy of ['.env', '.credentials.yaml', 'node_modules/decoy/index.js']) {
      ctx.expect(`诱饵 ${decoy} 已落在宿主工作区`, statSync(join(hostWorkspace, decoy)).isFile())
    }

    // 挂载是否真的是这个宿主目录（docker inspect 的 Source 对得上）
    const mounts = await ctx.hub.docker(['inspect', container, '--format', '{{json .Mounts}}'])
    ctx.expect(
      'docker inspect 显示 /workspace 挂在 users/<slug>/workspace 上',
      mounts.stdout.includes(hostWorkspace),
      mounts.stdout.slice(0, 300),
    )

    // ── 3. 会话目录（J6 的 sessions 部分）──
    const sessions = await dockerExec(container, [
      'sh',
      '-c',
      'mkdir -p "$DSH_HOME/sessions" && printf "{\\"e2e\\":true}\\n" > "$DSH_HOME/sessions/e2e-session.json" && ls -la "$DSH_HOME/sessions"',
    ])
    ctx.expect(
      '容器内 .dsh/sessions 可写（导出 sessions 分区有内容）',
      sessions.code === 0 && sessions.stdout.includes('e2e-session.json'),
      `code=${String(sessions.code)} ${sessions.stdout.slice(0, 200)}`,
    )
    ctx.note(`工作区宿主路径：${hostWorkspace}`)
  },
} satisfies Journey
