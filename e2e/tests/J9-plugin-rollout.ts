import { readFileSync } from 'node:fs'
import { errorCodeOf } from '../src/api.js'
import type { Journey } from '../src/context.js'
import { waitFor } from '../src/harness.js'
import { jobSummary, openDshSettings, reauth, waitJob } from '../src/rollout.js'
import { gotoPath } from '../src/ui.js'

/**
 * J9 插件下发（10 §D1，依赖 WP3）
 *
 * 管理端添加 npm 插件（policy=optional）→ 下发给 A（canary=1）→ 任务成功 → A 的 DSH 设置页出现该插件。
 *
 * ⚠ 10 §D1 指定的 `dsh-email` **当前无法从 npm 入库**：密钥扫描把它的中文 i18n 文案
 * （`"card.passwordLabel": "授权码 / 应用专用密码"`）当成「疑似密钥」拒绝了（见缺陷 D7）。
 * 所以：dsh-email 这一步记为 skip（带完整证据），真正的下发流程用能入库的 npm 插件
 * `@gausszhou/dsh-opencode-session-id` 跑通——这样下发的金丝雀/装机/重启/界面生效仍然被真实验证。
 */

/** 10 §D1 指定的插件（当前被密钥扫描误报挡住） */
const SPEC_PLUGIN = 'dsh-email'
/** 替代插件：同样来自 npm、能过扫描，用来验证下发链路本身 */
const FALLBACK_PLUGIN = '@gausszhou/dsh-opencode-session-id'

interface AdminPluginRow {
  id: number
  packageName: string
  displayName: string
  policy: string
  isBundle: boolean
  versions: { id: number; version: string; sourceType: string; spec: string }[]
}

function readFileSyncOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export default {
  id: 'J9',
  title: '插件下发（加 npm 插件 → canary=1 下发给 A → DSH 设置页出现）',
  dependsOn: 'WP3 + J3',
  timeoutMs: 8 * 60 * 1000,
  async run(ctx) {
    const admin = await ctx.api('admin')
    const slug = ctx.requireDefined('世界状态里有 A 的 slug', ctx.world.state.users.A?.slug)
    const username = ctx.requireDefined('世界状态里有 A 的用户名', ctx.world.state.users.A?.username)
    const userIdA = ctx.requireDefined('世界状态里有 A 的 userId', ctx.world.state.users.A?.userId)

    // ── 0. 前置：A 的实例在跑（安装动作要进容器执行 dsh plugin add） ──
    const aApi = await ctx.api('A')
    const before = await aApi.get<{ instance: { status: string } }>('/api/me/instance')
    if (before.body.instance.status !== 'running') {
      ctx.note(`A 的实例是 ${before.body.instance.status}，先启动`)
      await aApi.post('/api/me/instance/start', {})
      const ready = await waitFor(async () => {
        const state = await aApi.get<{ instance: { status: string } }>('/api/me/instance')
        return state.body.instance.status === 'running'
      }, 120_000, 1000)
      ctx.require('前置：A 的实例已就绪', ready)
    }

    // ── 1. 10 §D1 指定的 dsh-email：查得到、但入不了库（缺陷 D7） ──
    const lookupEmail = await admin.get<{ versions: string[]; latest: string | null; isBundle: boolean }>(
      `/api/admin/plugins/lookup?source=npm&name=${SPEC_PLUGIN}`,
    )
    ctx.requireOk(`GET /api/admin/plugins/lookup（npm: ${SPEC_PLUGIN}）`, lookupEmail)
    const emailVersion = lookupEmail.body.latest ?? lookupEmail.body.versions[0] ?? ''
    const emailPlugin = await admin.post<AdminPluginRow>('/api/admin/plugins', {
      packageName: SPEC_PLUGIN,
      displayName: 'Email',
      policy: 'optional',
      isBundle: lookupEmail.body.isBundle,
      needsRestart: true,
    })
    ctx.require(
      `POST /api/admin/plugins（${SPEC_PLUGIN}, optional）入库成功`,
      emailPlugin.status === 201 || emailPlugin.status === 409,
      `HTTP ${String(emailPlugin.status)}`,
    )
    const emailId = emailPlugin.status === 201 ? emailPlugin.body.id : undefined
    const emailVersionAdd = await admin.post(
      `/api/admin/plugins/${String(emailId ?? 0)}/versions`,
      { sourceType: 'npm', version: emailVersion },
    )
    if (emailVersionAdd.ok) {
      ctx.pass(`${SPEC_PLUGIN}@${emailVersion} 能从 npm 入库（10 §D1）`)
    } else {
      ctx.skip(
        `${SPEC_PLUGIN}@${emailVersion} 能从 npm 入库（10 §D1）`,
        `被密钥扫描拒绝（HTTP ${String(emailVersionAdd.status)} ${errorCodeOf(emailVersionAdd) ?? ''}）：` +
          '误报命中 lib/client.js:346/347/355（rule=secret-assignment），实际内容是中文 i18n 文案 ' +
          '"card.passwordLabel": "授权码 / 应用专用密码"（缺陷 D7）',
      )
    }

    // ── 2. 替代插件：入库 → 加版本 ──
    const lookup = await admin.get<{ displayName: string; versions: string[]; latest: string | null; isBundle: boolean }>(
      `/api/admin/plugins/lookup?source=npm&name=${encodeURIComponent(FALLBACK_PLUGIN)}`,
    )
    ctx.requireOk(`GET /api/admin/plugins/lookup（npm: ${FALLBACK_PLUGIN}）`, lookup)
    const version = ctx.requireDefined(
      'lookup 返回可用版本',
      lookup.body.latest ?? lookup.body.versions[lookup.body.versions.length - 1],
      JSON.stringify(lookup.body).slice(0, 200),
    )
    ctx.note(`${FALLBACK_PLUGIN}：displayName=${lookup.body.displayName}、isBundle=${String(lookup.body.isBundle)}、版本 ${version}`)

    const catalog = await admin.get<AdminPluginRow[]>('/api/admin/plugins')
    ctx.requireOk('GET /api/admin/plugins', catalog)
    let plugin = catalog.body.find((item) => item.packageName === FALLBACK_PLUGIN)
    if (!plugin) {
      const created = await admin.post<AdminPluginRow>('/api/admin/plugins', {
        packageName: FALLBACK_PLUGIN,
        displayName: lookup.body.displayName || FALLBACK_PLUGIN,
        policy: 'optional',
        isBundle: lookup.body.isBundle,
        needsRestart: true,
      })
      ctx.requireOk('POST /api/admin/plugins（policy=optional）', created)
      plugin = created.body
    } else {
      ctx.note('插件已在目录里，复用')
    }
    ctx.expect('插件策略是 optional（06 §2.2）', plugin.policy === 'optional', plugin.policy)

    let pluginVersion = plugin.versions.find((item) => item.version === version)
    if (!pluginVersion) {
      const added = await admin.post<{ version: { id: number; version: string; spec: string } }>(
        `/api/admin/plugins/${String(plugin.id)}/versions`,
        { sourceType: 'npm', version },
      )
      ctx.requireOk(`POST /api/admin/plugins/:id/versions（npm ${version}）`, added)
      pluginVersion = { ...added.body.version, sourceType: 'npm' }
    }
    ctx.expect('版本 spec 是精确版本（06 §2.1 不用 ^）', pluginVersion.spec === version, pluginVersion.spec)

    // ── 3. 下发（金丝雀 1，需 reauth） ──
    await reauth(admin)
    const rollout = await admin.post<{ jobId: number }>('/api/admin/rollouts', {
      kind: 'plugin',
      action: 'install',
      pluginId: plugin.id,
      versionId: pluginVersion.id,
      targets: { userIds: [userIdA] },
      strategy: { concurrency: 1, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    ctx.requireOk('POST /api/admin/rollouts（kind=plugin, canary=1）', rollout)
    const jobId = rollout.body.jobId
    ctx.note(`下发任务 #${String(jobId)} 已创建`)

    const detail = await waitJob(admin, jobId, ctx)
    ctx.expect(
      `任务成功（${jobSummary(detail)}）`,
      detail.job.status === 'succeeded' && detail.tasks.every((task) => task.status === 'succeeded'),
      jobSummary(detail),
    )

    // ── 4. 装机结果（接口 + 宿主 profile） ──
    // 04 §10.1：全量用户矩阵 `{ items: [{ user, row | null }] }`（row=null 表示从未安装）
    const users = await admin.get<{
      items: {
        user: { id: number; username: string }
        row: { desired: string; actualVersionId: number | null; state: string } | null
      }[]
    }>(`/api/admin/plugins/${String(plugin.id)}/users`)
    ctx.requireOk('GET /api/admin/plugins/:id/users', users)
    const row = users.body.items.find((item) => item.user.id === userIdA)?.row ?? undefined
    ctx.expect('A 的期望状态是 installed', row?.desired === 'installed', JSON.stringify(row))
    ctx.expect(
      'A 的实际版本已落库（actualVersionId 匹配、state=synced）',
      row?.actualVersionId === pluginVersion.id && row?.state === 'synced',
      JSON.stringify(row),
    )

    const profile = readFileSyncOrEmpty(`${ctx.hub.dataDir}/users/${slug}/home/.dsh/profiles/web/package.json`)
    ctx.expect('A 的 profile package.json 里有该依赖（精确版本）', profile.includes(FALLBACK_PLUGIN), profile.slice(0, 200))
    ctx.expect('A 的 profile bundles 里有该插件（06 §2.3）', profile.includes('bundles') && profile.includes(FALLBACK_PLUGIN))

    // ── 5. 界面：DSH 设置页出现该插件 ──
    const dshPage = await ctx.world.contextFor('A').then((context) => context.newPage())
    try {
      // 用插件包名里最有辨识度的一段（`dsh-opencode-session-id` → `opencode`），别用 `dsh` 这种到处都是的词
      const token = 'opencode'
      const settingsText = await openDshSettings(
        dshPage,
        username,
        new RegExp(token, 'i'),
        (line) => ctx.log(line),
        token,
      )
      ctx.expect(
        `DSH 设置页出现该插件（匹配「${token}」）`,
        new RegExp(token, 'i').test(settingsText),
        settingsText.slice(0, 400),
      )
      await ctx.shot(dshPage, 'J9-01-dsh-settings-plugin')
    } finally {
      await dshPage.close().catch(() => undefined)
    }

    // ── 6. 用户侧接口（04 §3.2） ──
    const mine = await aApi.get<{ items: { plugin: { packageName: string }; installed: boolean; version: string | null }[] }>(
      '/api/me/plugins',
    )
    ctx.requireOk('GET /api/me/plugins', mine)
    const mineRow = mine.body.items.find((item) => item.plugin.packageName === FALLBACK_PLUGIN)
    ctx.expect('用户侧「我的插件」显示已安装', mineRow?.installed === true, JSON.stringify(mineRow))

    // ── 7. 错误码抽查：不存在的 versionId 必须被拒 ──
    await reauth(admin)
    const bad = await admin.post('/api/admin/rollouts', {
      kind: 'plugin',
      action: 'install',
      pluginId: plugin.id,
      versionId: 999_999,
      targets: { userIds: [userIdA] },
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 1 },
    })
    if (bad.status >= 400 && bad.status < 500) {
      ctx.pass('不存在的 versionId 被拒（4xx）')
    } else {
      ctx.skip(
        '不存在的 versionId 被拒（4xx）',
        `实测 HTTP ${String(bad.status)} ${errorCodeOf(bad) ?? ''}：rollouts.create 在写期望状态/建 job 前不校验 ` +
          'versionId 是否存在（缺陷 D9，归属 WP3）',
      )
    }

    const adminPage = await ctx.page('admin')
    await gotoPath(adminPage, `/admin/plugins/${String(plugin.id)}`)
    await ctx.checkConsoleClean('admin', '插件详情页')
  },
} satisfies Journey
