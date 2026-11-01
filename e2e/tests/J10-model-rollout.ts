import { readFileSync } from 'node:fs'
import { errorCodeOf } from '../src/api.js'
import type { Journey } from '../src/context.js'
import { waitFor } from '../src/harness.js'
import { jobSummary, readDshModelSelection, reauth, waitJob } from '../src/rollout.js'

/** 假提供方/模型的可识别标识（断言靠它认出来，避免误命中别的文案） */
const ROUTE_KEY = 'wp8a-fake'
const PROVIDER_NAME = 'WP8A Fake Provider'
const MODEL_ID = 'wp8a-fake-model'
const MODEL_NAME = 'WP8A Fake Model'

interface ProviderRow {
  id: number
  routeKey: string
  displayName: string
  kind: string
  api: string | null
  baseUrl: string | null
  models: { id: string; name: string }[]
  keyMode: string
  apiKey: { set: boolean; last4: string | null }
}

/**
 * J10 模型下发（10 §D9 的配置部分，依赖 WP3）
 *
 * 新建 pi-ai 提供方（**假 baseURL `http://127.0.0.1:9/v1`，不用真密钥**，keyMode=none）+ 预设 →
 * 下发给 A → A 的 DSH 模型选择器/设置页出现该模型。
 */
export default {
  id: 'J10',
  title: '模型下发（假 baseURL 的 pi-ai 提供方 + 预设 → A 的模型选择器）',
  dependsOn: 'WP3 + J3',
  timeoutMs: 8 * 60 * 1000,
  async run(ctx) {
    const admin = await ctx.api('admin')
    const slug = ctx.requireDefined('世界状态里有 A 的 slug', ctx.world.state.users.A?.slug)
    const username = ctx.requireDefined('世界状态里有 A 的用户名', ctx.world.state.users.A?.username)
    const userIdA = ctx.requireDefined('世界状态里有 A 的 userId', ctx.world.state.users.A?.userId)

    // ── 0. 前置：A 的实例在跑（下发只改 managed.patch.yml + 重启） ──
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

    // ── 1. 建提供方（幂等：已存在则复用） ──
    const providers = await admin.get<ProviderRow[]>('/api/admin/models/providers')
    ctx.requireOk('GET /api/admin/models/providers', providers)
    let provider = providers.body.find((item) => item.routeKey === ROUTE_KEY)
    if (!provider) {
      const created = await admin.post<{ provider: ProviderRow }>('/api/admin/models/providers', {
        routeKey: ROUTE_KEY,
        displayName: PROVIDER_NAME,
        kind: 'pi-ai',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [{ id: MODEL_ID, name: MODEL_NAME, contextWindow: 32768 }],
        keyMode: 'none',
      })
      ctx.requireOk('POST /api/admin/models/providers（pi-ai + 假 baseURL + keyMode=none）', created)
      provider = created.body.provider
    } else {
      ctx.note('提供方 wp8a-fake 已存在，复用')
    }
    ctx.expect('提供方协议是 openai-completions', provider.api === 'openai-completions', String(provider.api))
    ctx.expect('提供方 baseURL 是假地址（不用真密钥）', provider.baseUrl === 'http://127.0.0.1:9/v1', String(provider.baseUrl))
    ctx.expect('keyMode=none 时不显示任何密钥', provider.apiKey.set === false, JSON.stringify(provider.apiKey))

    // ── 2. 建预设（默认预设） ──
    const presets = await admin.get<{ id: number; name: string; defaultProvider: string; defaultModel: string; isDefault: boolean; revision: number }[]>(
      '/api/admin/models/presets',
    )
    ctx.requireOk('GET /api/admin/models/presets', presets)
    let preset = presets.body.find((item) => item.name === 'WP8a 假预设')
    if (!preset) {
      const created = await admin.post<{ preset: { id: number; name: string; isDefault: boolean; revision: number } }>(
        '/api/admin/models/presets',
        {
          name: 'WP8a 假预设',
          description: 'WP8a e2e：只验证配置下发，不连真模型',
          providerIds: [provider.id],
          defaultProvider: ROUTE_KEY,
          defaultModel: MODEL_ID,
          isDefault: true,
        },
      )
      ctx.requireOk('POST /api/admin/models/presets（默认预设）', created)
      preset = { ...created.body.preset, defaultProvider: ROUTE_KEY, defaultModel: MODEL_ID }
    }

    // ── 3. 渲染预览（04 §8 #4）：密钥以 env 名出现、不含明文 ──
    const preview = await admin.get<{ userId: number; content: string; warnings: string[] }>(
      `/api/admin/models/presets/${String(preset.id)}/preview?userId=${String(userIdA)}`,
    )
    ctx.requireOk('GET /api/admin/models/presets/:id/preview', preview)
    ctx.expect('预览里有 llm-pi-ai 的 providers 配置', preview.body.content.includes('llm-pi-ai'))
    ctx.expect('预览里有默认模型条目', preview.body.content.includes('agent-default-model'))
    ctx.expect('预览里总是有 workspace-controller（06 §4.3）', preview.body.content.includes('workspace-controller'))
    ctx.expect('预览里不出现假 baseURL 之外的任何密钥明文', !/apiKey:\s*\S/u.test(preview.body.content), preview.body.content.slice(0, 200))

    // ── 4. 下发（需 reauth） ──
    await reauth(admin)
    const rollout = await admin.post<{ jobId: number }>('/api/admin/rollouts', {
      kind: 'models',
      presetId: preset.id,
      targets: { userIds: [userIdA] },
      strategy: { concurrency: 1, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    ctx.requireOk('POST /api/admin/rollouts（kind=models）', rollout)
    const detail = await waitJob(admin, rollout.body.jobId, ctx)
    ctx.expect(
      `任务成功（${jobSummary(detail)}）`,
      detail.job.status === 'succeeded' && detail.tasks.every((task) => task.status === 'succeeded'),
      jobSummary(detail),
    )

    // ── 5. 接口：modelSummary 反映预设与默认模型（04 §3.1） ──
    const mine = await aApi.get<{
      modelSummary: { preset: string; defaultModel: string; providers: string[]; policy: string }
    }>('/api/me/instance')
    ctx.requireOk('GET /api/me/instance（A 自己的视角）', mine)
    const summary = mine.body.modelSummary
    ctx.expect('modelSummary.preset 是刚下发的预设', summary.preset === 'WP8a 假预设', JSON.stringify(summary))
    ctx.expect('modelSummary.defaultModel 是假模型', summary.defaultModel === MODEL_ID, JSON.stringify(summary))
    ctx.expect(
      'modelSummary.providers 含假提供方',
      summary.providers.includes(PROVIDER_NAME) || summary.providers.includes(ROUTE_KEY),
      JSON.stringify(summary),
    )
    ctx.note(`modelSummary=${JSON.stringify(summary)}`)

    // 宿主的 managed.patch.yml 里应有这两个条目
    const managed = readFileSyncOrEmpty(`${ctx.hub.dataDir}/users/${slug}/managed/managed.patch.yml`)
    ctx.expect('managed.patch.yml 写入了 llm-pi-ai 条目', managed.includes('llm-pi-ai'))
    ctx.expect('managed.patch.yml 写入了假 baseURL', managed.includes('http://127.0.0.1:9/v1'))
    ctx.expect('managed.patch.yml 写入默认模型', managed.includes(MODEL_ID))

    // ── 6. 界面：DSH 里能看到这个模型（10 §D9 的配置部分） ──
    const dshPage = await ctx.world.contextFor('A').then((context) => context.newPage())
    try {
      // 模型名可能只在 composer 的 model seat（aria-label）或展开后的菜单里，所以两处都看
      const selection = await readDshModelSelection(dshPage, username)
      const shows = /WP8A|wp8a-fake/i.test(selection.seat) || /WP8A|wp8a-fake/i.test(selection.menu)
      ctx.expect(
        'DSH 的模型选择器/菜单里出现下发的模型（10 §D9 的配置部分）',
        shows,
        `seat=「${selection.seat}」；菜单/页面：${selection.menu.slice(0, 260)}`,
      )
      ctx.note(`DSH model seat：${selection.seat || '（没找到）'}`)
      await ctx.shot(dshPage, 'J10-01-dsh-model')
    } finally {
      await dshPage.close().catch(() => undefined)
    }

    // ── 7. 错误码抽查：被预设引用的提供方不能删 ──
    const blocked = await admin.delete(`/api/admin/models/providers/${String(provider.id)}`)
    ctx.expect(
      '被预设引用的提供方不能删（4xx）',
      blocked.status >= 400 && blocked.status < 500,
      `HTTP ${String(blocked.status)} ${errorCodeOf(blocked) ?? ''}`,
    )
  },
} satisfies Journey

function readFileSyncOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
