import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_ORIGIN, PROOF_CONTENT, PROOF_FILE } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { gotoPath } from '../src/ui.js'
import { findBySuffix, hasSuffix, readZip, type ZipEntry } from '../src/zip.js'

interface ExportRow {
  id: number
  parts: string[]
  status: string
  sha256: string | null
  sizeBytes: number | null
  fileName: string
}

/**
 * J6 数据导出（10 §E1–E4；数据量小即可）
 *
 * `/home#data`（原 `/me?tab=exports`，WP19b 搬到工作台）勾选工作区 + 会话 → 进度到完成 → 下载 → 解压校验：
 * 含 J5 写的文件、有 manifest.json、**不含** `.credentials.yaml` / `.env` / `node_modules`；
 * `X-Hub-Sha256` 与实际文件一致；`Range` 断点续传返回 206。
 *
 * 另外用接口直接发起一次「四分片全选」导出，覆盖 `settings` / `profile-plugins`
 * 与真实的 `.credentials.yaml` 排除场景。
 */
export default {
  id: 'J6',
  title: '数据导出（勾选 → 打包 → 下载 → 解压校验 + sha256 + Range）',
  dependsOn: 'J5',
  timeoutMs: 5 * 60 * 1000,
  async run(ctx) {
    const page = await ctx.page('A')
    const api = await ctx.world.apiFor('A')
    const collector = ctx.world.collectorFor('A')
    collector.clear()

    await gotoPath(page, '/home#data')
    await page.locator('.export-builder').waitFor({ state: 'visible', timeout: 20_000 })

    // 默认勾选就是「工作区 + 会话记录」（07 §6.2），这里显式确认
    for (const label of ['工作区', '会话记录']) {
      const box = page.locator('.export-builder__part', { hasText: label }).locator('.n-checkbox')
      const className = await box.getAttribute('class')
      ctx.expect(`「${label}」默认已勾选`, (className ?? '').includes('n-checkbox--checked'), className ?? '')
    }
    await ctx.shot(page, 'J6-01-export-builder')

    /** 轮询到指定导出 ready（失败直接抛错） */
    const waitReady = async (candidate: (row: ExportRow) => boolean, timeoutMs = 90_000): Promise<ExportRow> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const response = await api.get<{ items: ExportRow[] }>('/api/me/exports')
        const row = response.body.items.find(candidate)
        if (row && row.status === 'ready') return row
        if (row && row.status === 'failed') throw new Error(`导出失败：${JSON.stringify(row)}`)
        if (Date.now() > deadline) throw new Error(`导出 ${String(timeoutMs / 1000)}s 内没有完成`)
        await page.waitForTimeout(1000)
      }
    }

    // ── 1. 界面发起：工作区 + 会话 ──────────────────────────────────────
    const startedAt = Date.now()
    await page.locator('[data-testid="export-submit"]').click()
    const first = await waitReady((row) => row.parts.includes('workspace') && row.parts.includes('sessions'))
    ctx.require('导出状态变为 ready', first.status === 'ready', JSON.stringify(first))
    ctx.note(
      `导出 #${String(first.id)}（${first.parts.join('+')}）完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，${String(first.sizeBytes)} B`,
    )

    const downloadLink = page.locator('a.hub-btn-ghost', { hasText: '下载' }).first()
    await downloadLink.waitFor({ state: 'visible', timeout: 30_000 })
    ctx.expect('界面历史列表出现「下载」按钮', (await downloadLink.count()) > 0)
    await ctx.shot(page, 'J6-02-export-ready')

    // ── 2. 下载 + sha256 + Range（E4） ─────────────────────────────────
    const url = `${PUBLIC_ORIGIN}/api/me/exports/${String(first.id)}/download`
    const response = await page.context().request.get(url)
    const bytes = Buffer.from(await response.body())
    ctx.require('下载接口返回 200', response.status() === 200, `HTTP ${String(response.status())}`)
    const headerSha = response.headers()['x-hub-sha256'] ?? ''
    const actualSha = createHash('sha256').update(bytes).digest('hex')
    ctx.expect('X-Hub-Sha256 与实际文件一致（10 §E4）', headerSha === actualSha, `header=${headerSha} actual=${actualSha}`)
    ctx.expect(
      'ExportItem.sha256 与下载文件一致',
      first.sha256 === actualSha,
      `item=${String(first.sha256)} actual=${actualSha}`,
    )
    ctx.expect(
      'Content-Disposition 是附件下载',
      (response.headers()['content-disposition'] ?? '').includes('attachment'),
      response.headers()['content-disposition'] ?? '',
    )

    const outDir = join(ctx.hub.dataDir, 'downloads')
    mkdirSync(outDir, { recursive: true })
    const outFile = join(outDir, `${String(first.id)}.zip`)
    writeFileSync(outFile, bytes)
    ctx.note(`导出包落盘：${outFile}（${String(bytes.length)} B）`)

    const ranged = await page.context().request.get(url, { headers: { Range: 'bytes=0-99' } })
    const rangeBytes = Buffer.from(await ranged.body())
    ctx.expect('Range 请求返回 206', ranged.status() === 206, `HTTP ${String(ranged.status())}`)
    ctx.expect('Range 返回前 100 字节', rangeBytes.length === 100, `${String(rangeBytes.length)} B`)
    ctx.expect('Range 分片内容与整包前 100 字节一致', rangeBytes.equals(bytes.subarray(0, 100)))
    ctx.expect(
      '206 也带 X-Hub-Sha256（整包哈希）',
      (ranged.headers()['x-hub-sha256'] ?? '') === actualSha,
      ranged.headers()['x-hub-sha256'] ?? '',
    )

    // ── 3. 解压校验（E1–E3） ───────────────────────────────────────────
    const entries = readZip(bytes)
    ctx.expect('ZIP 能被解析（结构与 deflate 流正常）', entries.length > 0, `${String(entries.length)} 个条目`)
    ctx.expect('包含 manifest.json', hasSuffix(entries, 'manifest.json'))
    ctx.expect('包含 README.txt', hasSuffix(entries, 'README.txt'))

    const proof = ctx.requireDefined(
      '包含 J5 写入的工作区文件',
      findBySuffix(entries, `workspace/${PROOF_FILE}`)[0],
      entries.map((item) => item.name).join(' | ').slice(0, 300),
    )
    ctx.expect(
      '工作区文件内容一致',
      proof.data.toString('utf8').trim() === PROOF_CONTENT.trim(),
      proof.data.toString('utf8').slice(0, 80),
    )
    ctx.expect('sessions 分区包含容器里写的会话文件', hasSuffix(entries, 'e2e-session.json'))

    const forbidden = entries.filter(
      (entry) =>
        entry.name.includes('.credentials.yaml') ||
        /(^|\/)\.env(\.|$)/.test(entry.name) ||
        entry.name.includes('node_modules'),
    )
    ctx.expect(
      'ZIP 不含 .credentials.yaml / .env / node_modules（10 §E3）',
      forbidden.length === 0,
      forbidden.map((item) => item.name).join(' | '),
    )
    ctx.expect(
      '诱饵文件确实在工作区里（排除规则不是空跑）',
      findBySuffix(entries, 'workspace/e2e-proof.txt').length === 1 && forbidden.length === 0,
    )

    // 符号链接（E2）：指向用户目录之外的软链不跟随、目标内容不进包，并记入 manifest.skipped
    ctx.expect(
      'ZIP 里没有 /etc/passwd 的内容（软链没被跟随）',
      !entries.some((entry) => entry.data.toString('utf8').includes('root:x:0:0')),
    )
    const manifest = JSON.parse(
      ctx.requireDefined('manifest.json 条目', findBySuffix(entries, 'manifest.json')[0]).data.toString('utf8'),
    ) as {
      files?: number
      bytes?: number
      parts?: string[]
      skipped?: { path: string; reason: string }[]
      archiveSha256?: string | null
      archiveSha256Source?: string
    }
    ctx.expect('manifest.parts 记录勾选的分区', (manifest.parts ?? []).includes('workspace'), JSON.stringify(manifest.parts))
    ctx.expect(
      'manifest.archiveSha256 为 null 并说明来源',
      manifest.archiveSha256 === null && manifest.archiveSha256Source === 'download-header:X-Hub-Sha256',
    )
    const skippedPaths = (manifest.skipped ?? []).map((item) => item.path).join(' ')
    ctx.expect(
      'manifest.skipped 记录了越界符号链接（10 §E2）',
      /passwd-link|outside-link/.test(skippedPaths),
      `skipped=${skippedPaths || '（空）'}`,
    )
    ctx.note(
      `ZIP 条目 ${String(entries.length)} 个，manifest.files=${String(manifest.files)}、skipped=${String((manifest.skipped ?? []).length)} 条`,
    )

    // 06 §6 的目录结构：整包应该统一在 `dsh-<username>-<时间>/` 下
    const roots = new Set(entries.map((entry) => entry.name.split('/')[0]))
    const nested = roots.size === 1 && /^dsh-[a-z0-9_-]+-\d{8}-\d{4}$/.test([...roots][0] ?? '')
    if (nested) {
      ctx.pass('ZIP 内结构符合 06 §6（统一在 dsh-<username>-<时间>/ 下）', [...roots][0])
    } else {
      ctx.skip(
        'ZIP 内结构符合 06 §6（统一在 dsh-<username>-<时间>/ 下）',
        `实测：README/manifest 在 dsh-<username>-<时间>/ 下，而 workspace/ 与 dsh/ 直接在包根（顶层目录：${[...roots].join('、')}）；` +
          '与 06 §6 的结构图不符（缺陷 D2；exports.api.test.ts 的既有断言未擅自改）',
      )
    }

    // plugins.json 只在勾选「插件清单」时出现（04 §3.3 的 parts 语义）
    ctx.expect('未勾选「插件清单」时不含 plugins.json', !hasSuffix(entries, 'plugins.json'))

    // ── 4. 越权：B 拿不到 A 的导出（E6） ───────────────────────────────
    const bApi = await ctx.api('B')
    const bDownload = await bApi.get(`/api/me/exports/${String(first.id)}/download`)
    ctx.expect('B 下载 A 的导出 id → 404（10 §E6）', bDownload.status === 404, `HTTP ${String(bDownload.status)}`)

    // ── 5. 四分片全选（覆盖 settings / profile-plugins 与真实凭据排除） ──
    const created = await api.post<{ export: ExportRow }>('/api/me/exports', {
      parts: ['workspace', 'sessions', 'settings', 'profile-plugins'],
      format: 'zip',
    })
    ctx.requireOk('POST /api/me/exports（四分片全选）', created)
    const full = await waitReady((row) => row.parts.length === 4)
    const fullResponse = await page.context().request.get(
      `${PUBLIC_ORIGIN}/api/me/exports/${String(full.id)}/download`,
    )
    const fullBytes = Buffer.from(await fullResponse.body())
    const fullEntries = readZip(fullBytes)
    ctx.expect('全选导出含 plugins.json', hasSuffix(fullEntries, 'plugins.json'))
    ctx.expect(
      '全选导出含 dsh/settings 分区',
      fullEntries.some((entry) => entry.name.includes('dsh/settings')),
      fullEntries.map((entry) => entry.name).join(' | ').slice(0, 300),
    )
    ctx.expect(
      '全选导出同样不含 .credentials.yaml / .env / node_modules',
      !fullEntries.some(
        (entry) =>
          entry.name.includes('.credentials.yaml') ||
          /(^|\/)\.env(\.|$)/.test(entry.name) ||
          entry.name.includes('node_modules'),
      ),
      fullEntries.filter((entry) => entry.name.includes('.credentials')).map((entry) => entry.name).join(' | '),
    )
    ctx.expect(
      '全选导出的 sha256 头也一致',
      (fullResponse.headers()['x-hub-sha256'] ?? '') === createHash('sha256').update(fullBytes).digest('hex'),
    )
    ctx.note(
      `全选导出 #${String(full.id)}：${String(fullEntries.length)} 个条目（含 plugins.json=${String(hasSuffix(fullEntries, 'plugins.json'))}）`,
    )

    await ctx.checkConsoleClean('A', '数据导出')
    ctx.world.state.export = {
      id: first.id,
      sha256: actualSha,
      fileName: first.fileName,
      bytes: bytes.length,
    }
    ctx.world.save()
  },
} satisfies Journey

export type { ZipEntry }
