/**
 * dsh-codex-pilot —— Client 半边（浏览器）。
 *
 *   ① Codex 派出 DSH 任务时，在右侧栏打开那个子会话（原生 subagentchat tab）；
 *   ② 侧栏里 Codex 模式的会话，行前挂一个终端小图标（slot: sidebar.session.row.leading）；
 *   ③ Codex 会话运行时，把 DSH 的「深度求索中」换成 Codex 的状态行：思考摘要的标题（没有就是 Working）+ 耗时；
 *   ④ 设置 → Codex（settings.section）：打开就自动检测状态与本机已有配置，账号登录 / 第三方 API 两种方式；
 *      对话里只在未登录时留一行短提示（输入框 dock），不做登录表单、没有 /codex-setup、没有设置弹窗；
 *   ⑤ 输入框下方的用量条：ChatGPT 套餐额度（5 小时 / 每周，只有账号登录才有）+ 本会话 token / 上下文，点开看详情。
 *
 * 数据都来自 host 半边 GET /codex-pilot?since=…（每 1.5 秒）。
 * 约定：只从浏览器模块表 require('react')，不 import harness 客户端包。
 * 和 Claude Code 模式的插件各管各的：属性名、样式 id、命令名都不重复。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-codex-pilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React
    const NS = 'codexPilot'
    const SUBAGENT_CHAT = 'dsh-resource://subagentchat/session/'
    const chatAddress = (spawn) =>
      `${SUBAGENT_CHAT}${encodeURIComponent(spawn.child)}?${new URLSearchParams({ parent: spawn.parent, mode: spawn.mode || 'continuable' })}`

    /** 共享状态：Codex 模式的会话、各会话的状态行、是否已登录。 */
    const pilot = { ids: new Set(), activity: {}, setupReady: null, setupNote: null, listeners: new Set() }
    const notifyPilot = () => {
      for (const listener of pilot.listeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[codex-pilot] 状态刷新出错：', error)
        }
      }
    }
    const publishPilot = (ids) => {
      const next = new Set(ids || [])
      if (next.size === pilot.ids.size && [...next].every((id) => pilot.ids.has(id))) return
      pilot.ids = next
      try {
        installRowStyle(next)
      } catch (error) {
        console.warn('[codex-pilot] 侧栏运行中图标样式出错：', error)
      }
      notifyPilot()
    }

    /*
     * 会话运行中时，DSH 侧栏行首显示状态转圈，不渲染 sidebar.session.row.leading 槽（Codex 图标就没了）。
     * 按会话 id 生成 CSS：Codex 会话的转圈（data-state=ongoing）换成光标闪烁的终端图标。纯 CSS，React 重绘不丢。
     */
    const ROW_STYLE_ID = 'codex-pilot-row-style'
    const RUNNING_ICON = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="1" y="1" width="14" height="14" rx="4" stroke-width="1.4"/>' +
        '<path d="M4.6 5.6 7 8l-2.4 2.4" stroke-width="1.5"/>' +
        '<path d="M8.6 10.6h2.8" stroke-width="1.5"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1s" repeatCount="indefinite"/></path>' +
        '</svg>',
    )
    const installRowStyle = (ids) => {
      let style = document.getElementById(ROW_STYLE_ID)
      if (!style) {
        style = document.createElement('style')
        style.id = ROW_STYLE_ID
        document.head.appendChild(style)
      }
      const rows = [...ids].map((id) => `[data-row-key="session:${CSS.escape(id)}"]`)
      if (!rows.length) {
        style.textContent = ''
        return
      }
      style.textContent = `
${rows.map((row) => `${row} [class*="_slot"] > svg[data-state="ongoing"]`).join(',\n')} { display: none !important; }
${rows.map((row) => `${row} [class*="_slot"]:has(> svg[data-state="ongoing"])::before`).join(',\n')} {
  content: ''; display: block; width: 13px; height: 13px; margin: auto;
  background-color: #10a37f;
  -webkit-mask: url("${RUNNING_ICON}") center / contain no-repeat;
  mask: url("${RUNNING_ICON}") center / contain no-repeat;
}`
    }
    const publishReady = (ready, note = null) => {
      if (ready === undefined || (ready === pilot.setupReady && note === pilot.setupNote)) return
      pilot.setupReady = ready
      pilot.setupNote = note
      notifyPilot()
    }
    const usePilot = () => {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((n) => n + 1)
        pilot.listeners.add(listener)
        return () => pilot.listeners.delete(listener)
      }, [])
      return pilot
    }

    /** 槽注册：等槽存在再注册，HMR 重挂载时有限重试。 */
    const registerSlot = (ctx, name, options, component, label) => {
      let timer = null
      let dispose = () => {}
      let attempts = 0
      const attempt = () => {
        try {
          dispose = ctx.slots.register(options, component)
          attempts = 0
        } catch (error) {
          attempts += 1
          if (attempts <= 12) {
            if (timer) clearTimeout(timer)
            timer = setTimeout(attempt, 120)
            return
          }
          console.warn(`[codex-pilot] ${label} 注册失败：${error.message}（刷新页面即可恢复）`)
        }
      }
      const disposeInject = ctx.slots.inject(name, () => {
        attempt()
        return () => {
          if (timer) clearTimeout(timer)
          dispose()
        }
      })
      return () => {
        if (timer) clearTimeout(timer)
        dispose()
        if (typeof disposeInject === 'function') disposeInject()
      }
    }

    // 终端提示符小图标（跟随文字颜色，深浅色主题都清楚）
    const CodexIcon = ({ size = 14 }) =>
      h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M4.6 5.6 7 8l-2.4 2.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M8.6 10.6h2.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )

    const CodexSessionMark = (props) => {
      const sessionId = props?.sessionId
      const isPilot = () => sessionId !== undefined && pilot.ids.has(sessionId)
      const [on, setOn] = useState(isPilot)
      useEffect(() => {
        const listener = () => setOn(isPilot())
        pilot.listeners.add(listener)
        listener()
        return () => pilot.listeners.delete(listener)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])
      if (!on) return null
      return h(
        'span',
        { title: 'Codex 模式', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--dsw-alias-label-secondary, #555)' } },
        h(CodexIcon, { size: 13 }),
      )
    }

    /* ---- ④ 登录与配置：都在 DSH 设置页的「Codex」分区；对话里只留一行短提示 ---- */

    // 相对路径（页面有 <base href="./">）：经广州 /home/ 这类前缀反代时也能打到本机 DSH
    const SETUP_API = 'api/codex-pilot.setup'
    const callSetup = async (body) => {
      const response = await fetch(SETUP_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || { action: 'state' }),
      })
      const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (typeof data.ready === 'boolean') publishReady(data.ready, data.status?.authType === 'hub' && !data.ready ? data.status.error || null : null)
      return data
    }
    let portal = null
    try {
      portal = require('react-dom')?.createPortal || null
    } catch {
      portal = null
    }

    /* ---- ⑤ 输入框下方的用量条：ChatGPT 套餐额度（只有账号登录才有）+ 本会话用量 ---- */

    const USAGE_REFRESH_MS = 60000
    const usageState = { data: null, sessionId: null, at: 0, inflight: null, listeners: new Set() }
    const loadUsage = async (sessionId, force = false) => {
      if (usageState.inflight) return usageState.inflight
      usageState.inflight = (async () => {
        try {
          const data = await callSetup({ action: 'usage', sessionId, force })
          if (data?.ok) {
            usageState.data = data
            usageState.sessionId = sessionId
            usageState.at = Date.now()
            for (const listener of usageState.listeners) listener()
          }
        } catch {
          /* 下次再试 */
        } finally {
          usageState.inflight = null
        }
      })()
      return usageState.inflight
    }

    const USAGE_STYLE_ID = 'codex-pilot-usage-style'
    const installUsageStyle = () => {
      if (document.getElementById(USAGE_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = USAGE_STYLE_ID
      // 颜色只给条形「填充」用（严重程度）：正常 = Codex 绿，≥70% 琥珀，≥90% 红；轨道是同色相的浅一档。
      // 文字一律用 DSH 的文字色，暗色模式跟着 DSH 的变量走。
      style.textContent = `
.cx-usage-anchor { display: inline-flex; min-width: 0; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.cx-usage-pill { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm, 6px); background: none; color: var(--dsw-alias-label-tertiary, #81858c); font: inherit; line-height: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.cx-usage-pill:hover, .cx-usage-pill[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-secondary, #555); }
.cx-usage-pill > svg { flex: none; }
.cx-usage-sep { color: var(--dsw-alias-separator-primary, #d0d0d0); margin: 0 2px; }
.cx-usage-item { display: inline-flex; align-items: center; gap: 5px; }
.cx-meter { --cx-fill: #10a37f; position: relative; display: inline-block; flex: none; width: 28px; height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--cx-fill) 20%, transparent); }
.cx-meter > i { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--cx-fill); transition: width .4s ease; }
.cx-meter[data-level="warning"] { --cx-fill: #D4A017; }
.cx-meter[data-level="critical"] { --cx-fill: #D64545; }
.cx-meter.cx-meter-wide { width: 100%; height: 6px; border-radius: 3px; }
.cx-meter.cx-meter-wide > i { border-radius: 3px; }
.cx-usage-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: 320px; max-width: calc(100vw - 24px); padding: 16px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-specific-menu, #fff); backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent, 0 8px 30px rgba(0,0,0,.15)); color: var(--dsw-alias-label-secondary, #555); font-size: 12px; line-height: 18px; cursor: default; }
.cx-usage-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: var(--dsw-alias-label-primary, #111); font-weight: 500; }
.cx-usage-title > span { display: inline-flex; align-items: center; gap: 6px; }
.cx-usage-badge { padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 500; color: color-mix(in srgb, #10a37f 65%, var(--dsw-alias-label-primary, #111)); background: color-mix(in srgb, #10a37f 14%, transparent); }
.cx-usage-rule { border-top: .5px solid var(--dsw-alias-border-l2, #e5e5e5); margin: 0 0 10px; }
.cx-usage-limit { margin-bottom: 12px; }
.cx-usage-limit-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.cx-usage-limit-head b { font-weight: 500; color: var(--dsw-alias-label-primary, #111); font-variant-numeric: tabular-nums; }
.cx-usage-reset { margin-top: 3px; color: var(--dsw-alias-label-tertiary, #888); }
.cx-usage-section { margin: 4px 0 6px; color: var(--dsw-alias-label-tertiary, #888); }
.cx-usage-dl { display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 4px 16px; margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #888); }
.cx-usage-dl dt, .cx-usage-dl dd { margin: 0; min-width: 0; }
.cx-usage-dl dd { text-align: right; color: var(--dsw-alias-label-secondary, #555); font-variant-numeric: tabular-nums; }
.cx-usage-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.cx-usage-foot button { padding: 0 6px; border: none; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary, #555); font: inherit; cursor: pointer; }
.cx-usage-foot button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.cx-usage-note { margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #888); }
.cx-usage-warn { margin: 0 0 10px; color: var(--dsw-alias-label-secondary, #555); }`
      document.head.appendChild(style)
    }

    const PLAN_NAMES = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro' }
    const planName = (plan) => PLAN_NAMES[plan] || (plan && plan !== 'unknown' ? String(plan).replace(/_/g, ' ') : 'ChatGPT')
    const levelOf = (percent, reached = false) => (reached || percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal')
    const LEVEL_TEXT = { warning: '接近上限', critical: '即将用满' }
    const Meter = ({ percent, level, wide }) =>
      h('span', { className: wide ? 'cx-meter cx-meter-wide' : 'cx-meter', 'data-level': level || levelOf(percent), 'aria-hidden': true }, h('i', { style: { width: `${Math.max(percent > 0 ? 2 : 0, Math.min(100, percent))}%` } }))

    const formatReset = (at) => {
      if (!at) return ''
      const ms = at - Date.now()
      const when = new Date(at)
      const sameDay = when.toDateString() === new Date().toDateString()
      const clock = when.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      const absolute = sameDay ? clock : `${when.getMonth() + 1}/${when.getDate()} ${clock}`
      if (ms <= 0) return `已到重置时间（${absolute}）`
      const minutes = Math.round(ms / 60000)
      const relative = minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}` : `${Math.round(minutes / 1440)} 天`
      return `${relative}后重置 · ${absolute}`
    }
    const formatTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0))
    const formatAgo = (at) => {
      const s = Math.round((Date.now() - at) / 1000)
      return s < 10 ? '刚刚更新' : s < 60 ? `${s} 秒前更新` : `${Math.round(s / 60)} 分钟前更新`
    }
    // 状态栏上只放主额度（codex 桶）的两个窗口，其余桶进面板
    const headline = (limits) => {
      const main = limits.filter((limit) => limit.main)
      return (main.length ? main : limits).slice(0, 2)
    }
    const contextOf = (stats) => {
      const used = Number(stats?.lastContext) || 0
      const total = Number(stats?.contextWindow) || 0
      return used && total ? { used, total, percent: Math.round((used / total) * 100) } : null
    }
    const cacheRate = (stats) => (stats?.inputTokens ? Math.round(((Number(stats.cachedInputTokens) || 0) / stats.inputTokens) * 100) : null)

    const UsagePanel = ({ data, anchor, onClose, onRefresh, refreshing }) => {
      const [, tick] = useState(0)
      useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 30000)
        const onKey = (event) => event.key === 'Escape' && onClose()
        const onDown = (event) => {
          if (anchor?.contains(event.target) || event.target.closest?.('.cx-usage-panel')) return
          onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          clearInterval(timer)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [anchor])
      const rect = anchor?.getBoundingClientRect?.()
      const width = 320
      const left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) : 12
      const bottom = rect ? window.innerHeight - rect.top + 8 : 80
      const plan = data?.plan || {}
      const stats = data?.session || null
      const limits = Array.isArray(plan.limits) ? plan.limits : []
      const badge = plan.kind === 'plan' ? planName(plan.plan) : plan.kind === 'apiKey' ? 'API Key' : plan.kind === 'provider' ? '自定义提供者' : null
      const children = [
        h('div', { className: 'cx-usage-title', key: 'title' },
          h('span', null, h(CodexIcon, { size: 13 }), 'Codex 用量'),
          badge ? h('span', { className: 'cx-usage-badge' }, badge) : null,
        ),
        h('div', { className: 'cx-usage-rule', key: 'rule' }),
      ]
      if (plan.error) children.push(h('div', { className: 'cx-usage-warn', key: 'err' }, `⚠ 暂时没能更新额度：${plan.error}`))
      if (plan.kind === 'plan') {
        if (plan.blocked) children.push(h('div', { className: 'cx-usage-warn', key: 'blocked' }, '⚠ 套餐额度已用完，等重置后才能继续用。'))
        for (const limit of limits) {
          const level = levelOf(limit.percent, limit.reached)
          children.push(
            h('div', { className: 'cx-usage-limit', key: limit.id },
              h('div', { className: 'cx-usage-limit-head' },
                h('span', null, limit.long, level !== 'normal' ? ` · ⚠ ${LEVEL_TEXT[level]}` : ''),
                h('b', null, `${limit.percent}%`),
              ),
              h(Meter, { percent: limit.percent, level, wide: true }),
              limit.resetsAt ? h('div', { className: 'cx-usage-reset' }, formatReset(limit.resetsAt)) : null,
            ),
          )
        }
        if (!limits.length && !plan.error) children.push(h('div', { className: 'cx-usage-note', key: 'nolimit' }, '账户暂时没有返回额度窗口。'))
        if (plan.credits) children.push(h('dl', { className: 'cx-usage-dl', key: 'credits' }, h('dt', null, '额外点数'), h('dd', null, plan.credits.unlimited ? '不限' : plan.credits.balance ?? '—')))
      } else if (plan.kind === 'apiKey' || plan.kind === 'provider') {
        children.push(h('div', { className: 'cx-usage-note', key: 'nolimit' }, plan.kind === 'apiKey' ? '用 API Key 登录，按量计费，没有 ChatGPT 套餐额度。' : '用的是自定义提供者（中转站等），没有 ChatGPT 套餐额度。'))
      }
      if (stats) {
        const context = contextOf(stats)
        const rate = cacheRate(stats)
        const rows = [
          ['Codex 轮次', `${stats.turns || 0}${stats.abortedTurns ? `（停止 ${stats.abortedTurns}）` : ''}${stats.steeredMessages ? `（插话 ${stats.steeredMessages}）` : ''}`],
          ['输入', `${formatTokens(stats.inputTokens)}${rate !== null ? `（缓存命中 ${rate}%）` : ''}`],
          ['输出', formatTokens(stats.outputTokens)],
          ['合计', formatTokens(stats.totalTokens)],
        ]
        children.push(h('div', { className: 'cx-usage-section', key: 'sec' }, `本会话${stats.model ? ` · ${stats.model}` : ''}`))
        if (context) {
          const level = levelOf(context.percent)
          children.push(
            h('div', { className: 'cx-usage-limit', key: 'ctx' },
              h('div', { className: 'cx-usage-limit-head' },
                h('span', null, `上下文 ${formatTokens(context.used)} / ${formatTokens(context.total)}`, level !== 'normal' ? ' · ⚠ 快满了，可以 /compact' : ''),
                h('b', null, `${context.percent}%`),
              ),
              h(Meter, { percent: context.percent, level, wide: true }),
            ),
          )
        }
        children.push(h('dl', { className: 'cx-usage-dl', key: 'dl' }, ...rows.flatMap(([k, v]) => [h('dt', { key: `${k}-t` }, k), h('dd', { key: `${k}-d` }, v)])))
      } else {
        children.push(h('div', { className: 'cx-usage-note', key: 'nostats' }, '本会话还没有跑完的 Codex 轮次。'))
      }
      children.push(
        h('div', { className: 'cx-usage-foot', key: 'foot' },
          h('span', null, plan.kind === 'plan' ? `来自 ChatGPT 账户 · ${formatAgo(plan.fetchedAt || Date.now())}` : formatAgo(plan.fetchedAt || Date.now())),
          h('button', { type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'),
        ),
      )
      const panel = h('div', { className: 'cx-usage-panel', role: 'dialog', 'aria-label': 'Codex 用量', style: { left, bottom } }, ...children)
      return portal ? portal(panel, document.body) : panel
    }

    const CodexUsagePill = (props) => {
      const sessionId = props?.sessionId
      usePilot()
      const isPilot = sessionId !== undefined && pilot.ids.has(sessionId)
      const [, setTick] = useState(0)
      const [open, setOpen] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [anchor, setAnchor] = useState(null)
      useEffect(() => {
        installUsageStyle()
        const listener = () => setTick((n) => n + 1)
        usageState.listeners.add(listener)
        return () => usageState.listeners.delete(listener)
      }, [])
      useEffect(() => {
        if (!isPilot) return
        if (usageState.sessionId !== sessionId || Date.now() - usageState.at > USAGE_REFRESH_MS) void loadUsage(sessionId)
        const timer = setInterval(() => void loadUsage(sessionId), USAGE_REFRESH_MS)
        // 一轮跑完（状态行消失）就刷新一次：本会话用量是回合结束时记的
        let running = Boolean(pilot.activity[sessionId])
        const watch = setInterval(() => {
          const now = Boolean(pilot.activity[sessionId])
          if (running && !now) setTimeout(() => void loadUsage(sessionId, true), 1500)
          running = now
        }, 1500)
        return () => {
          clearInterval(timer)
          clearInterval(watch)
        }
      }, [isPilot, sessionId])
      if (!isPilot) return null
      const data = usageState.sessionId === sessionId ? usageState.data : null
      const plan = data?.plan || {}
      const stats = data?.session || null
      const limits = plan.kind === 'plan' && Array.isArray(plan.limits) ? plan.limits : []
      const items = []
      const sep = (key) => h('span', { className: 'cx-usage-sep', key }, '·')
      for (const limit of headline(limits)) {
        const level = levelOf(limit.percent, limit.reached)
        if (items.length) items.push(sep(`sep-${limit.id}`))
        items.push(h('span', { className: 'cx-usage-item', key: limit.id }, limit.short, h(Meter, { percent: limit.percent, level }), `${level !== 'normal' ? '⚠' : ''}${limit.percent}%`))
      }
      if (stats?.totalTokens) {
        if (items.length) items.push(sep('sep-tok'))
        items.push(h('span', { key: 'tok' }, `${formatTokens(stats.totalTokens)} tok`))
        const context = !limits.length ? contextOf(stats) : null
        if (context) {
          const level = levelOf(context.percent)
          items.push(sep('sep-ctx'), h('span', { className: 'cx-usage-item', key: 'ctx' }, '上下文', h(Meter, { percent: context.percent, level }), `${level !== 'normal' ? '⚠' : ''}${context.percent}%`))
        }
      }
      if (!items.length) return null
      const aria = limits.length
        ? `Codex 用量：${headline(limits).map((l) => `${l.long} ${l.percent}%`).join('，')}`
        : `Codex 用量：本会话 ${formatTokens(stats?.totalTokens)} tokens`
      return h('span', { className: 'cx-usage-anchor', ref: setAnchor },
        h('button', { type: 'button', className: 'cx-usage-pill', 'aria-label': aria, 'aria-expanded': open, 'aria-haspopup': 'dialog', title: plan.stale ? `额度数据可能过时：${plan.error || ''}` : undefined, onClick: () => setOpen((v) => !v) },
          h(CodexIcon, { size: 12 }),
          ...items,
        ),
        open
          ? h(UsagePanel, {
              data,
              anchor,
              refreshing,
              onClose: () => setOpen(false),
              onRefresh: async () => {
                setRefreshing(true)
                await loadUsage(sessionId, true)
                setRefreshing(false)
              },
            })
          : null,
      )
    }

    /* ---- ④ 设置 → Codex：状态、本机检测、账号登录 / 第三方 API ---- */

    const SETTINGS_STYLE_ID = 'codex-pilot-settings-style'
    const installSettingsStyle = () => {
      if (document.getElementById(SETTINGS_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = SETTINGS_STYLE_ID
      // 颜色全走 DSH 的变量：亮 / 暗主题都跟着设置页走
      style.textContent = `
.cx-set { display: flex; flex-direction: column; gap: 14px; max-width: 660px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; }
.cx-set-head { display: flex; flex-direction: column; gap: 4px; }
.cx-set-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; line-height: 24px; }
.cx-set-desc, .cx-set-sub { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.cx-set-break { word-break: break-all; }
.cx-set-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); border-radius: 12px; }
.cx-set-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cx-set-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.cx-set-badge { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, #10a37f 14%, transparent); }
.cx-set-state { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #555); }
.cx-set-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #10a37f); }
.cx-set-dot-warn { background: var(--dsw-alias-state-error-primary, #d64545); }
.cx-set-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary, #555); }
.cx-set-list li { word-break: break-all; }
.cx-set-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cx-set-field { display: flex; flex-direction: column; gap: 6px; }
.cx-set-label { color: var(--dsw-alias-label-secondary, #555); font-size: 12px; }
.cx-set-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3)); border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.cx-set-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.cx-set-btn:disabled { cursor: not-allowed; opacity: .45; }
.cx-set-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f2329); color: var(--dsw-alias-label-primary-foreground, #fff); }
.cx-set-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #333); }
.cx-set-btn-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 45%, transparent); color: var(--dsw-alias-state-error-primary, #d64545); }
.cx-set-mode { display: flex; flex-direction: column; gap: 10px; }
.cx-set-tabs { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; padding: 4px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08)); }
.cx-set-tab { height: 32px; border: none; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-secondary, #555); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.cx-set-tab:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.cx-set-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-3, #fff); color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(0,0,0,.08)); }
.cx-set-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.35)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, #1f2329); font: inherit; font-size: 13px; }
.cx-set-input::placeholder { color: var(--dsw-alias-label-dimmed, #a0a0a0); }
.cx-set-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.cx-set-radio { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #555); cursor: pointer; }
.cx-set-link { color: var(--dsw-alias-label-primary, #1f2329); text-decoration: underline; word-break: break-all; }
.cx-set-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 20px; letter-spacing: 3px; font-weight: 600; user-select: all; color: var(--dsw-alias-label-primary, #1f2329); }
.cx-set-msg-err { color: var(--dsw-alias-state-error-primary, #d4380d); word-break: break-all; }
.cx-set-warn { padding: 6px 10px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #555); background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #D4A017) 12%, transparent); }`
      document.head.appendChild(style)
    }

    const MODE_NAMES = { machine: '本机 Codex（~/.codex）', chatgpt: 'ChatGPT 账号（插件登录）', apiKey: '第三方 API', hub: 'DSH Hub 下发' }
    const AUTH_TYPE_NAMES = { chatgpt: 'ChatGPT 账号登录', apiKey: 'API Key 登录' }

    function describeStatus(state) {
      const status = state?.status
      if (!status) return '检测中…'
      if (status.authType === 'hub') return status.loggedIn ? '已接入 DSH Hub' : `不可用（${status.error || '连不上 DSH Hub'}）`
      if (!status.loggedIn) return status.error ? `未登录（${status.error}）` : '未登录'
      const how = { apiKey: 'API Key', chatgpt: 'ChatGPT 账号', provider: '自定义提供者' }[status.authType] || status.authType
      return ['已登录', how, status.planType, status.email].filter(Boolean).join(' · ')
    }
    function describeBinary(binary) {
      if (!binary?.path) return '找不到 Codex 程序'
      return binary.source === 'bundled' ? `插件自带（${binary.path}）` : binary.path
    }

    /** 后端 detected → 给人看的几行：只有路径、provider 名字、base_url，没有任何密钥值。 */
    function detectedLines(detected) {
      if (!detected) return []
      const lines = []
      const home = detected.codexHome || '~/.codex'
      const auth = detected.authFile || {}
      if (auth.present) lines.push(`检测到 ${home}/auth.json（${AUTH_TYPE_NAMES[auth.type] || '登录类型未知'}）`)
      else lines.push(`没有检测到 ${home}/auth.json（本机 Codex 还没登录）`)
      const config = detected.configFile || {}
      if (config.present) {
        if (config.modelProvider) {
          const who = config.providerName && config.providerName !== config.modelProvider ? `${config.modelProvider}（${config.providerName}）` : config.modelProvider
          lines.push(`检测到 config.toml 里的提供者 ${who}${config.baseUrl ? ` · ${config.baseUrl}` : ''}${config.model ? ` · 模型 ${config.model}` : ''}`)
          if (config.envKeyConfigured) lines.push('config.toml 的提供者从环境变量取 key（该变量已设置）')
        } else lines.push(`检测到 ${home}/config.toml（没有配置自定义提供者）`)
      } else lines.push(`没有检测到 ${home}/config.toml`)
      if (detected.env?.openaiApiKey) lines.push('进程环境变量里设置了 OPENAI_API_KEY')
      if (detected.env?.codexHome) lines.push('CODEX_HOME 指向了自定义目录')
      return lines
    }
    const hasMachineConfig = (detected) => Boolean(detected?.authFile?.present || detected?.configFile?.present || detected?.env?.openaiApiKey)

    /** 设置页渲染出错时不要连累整个设置页：降级成一张错误卡片。 */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'cx-set' }, h('div', { className: 'cx-set-card' },
            h('div', { className: 'cx-set-msg-err', key: 'err' }, `Codex 设置加载失败：${String(this.state.error?.message ?? this.state.error)}`),
            h('div', { className: 'cx-set-sub', key: 'hint' }, '刷新页面再试；对话框里的 Codex 功能不受影响。'),
          ))
        }
        return this.props.children
      }
    }

    /** 设置 → Codex：打开就自动检测（state），两种方式用分段切换，Hub 模式整块只读。 */
    function CodexSettingsSection() {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      const [tab, setTab] = useState('account')
      const [login, setLogin] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [baseUrl, setBaseUrl] = useState('')
      const [wireApi, setWireApi] = useState('responses')
      const [model, setModel] = useState('')
      const [confirmClear, setConfirmClear] = useState(false)
      const apply = (data) => {
        if (!data || data.ok === false || !data.mode) return
        setState(data)
        setBaseUrl(data.baseUrl || '')
        setWireApi(data.wireApi || 'responses')
        setModel(data.model || '')
        // Tab 跟着当前方式走：Hub / 第三方 API / 账号登录
        setTab(data.mode === 'hub' ? 'hub' : data.mode === 'apiKey' ? 'api' : 'account')
      }
      const run = async (label, body, after) => {
        setBusy(label)
        setMessage('')
        setError('')
        try {
          const data = await callSetup(body)
          if (data?.ok === false) setError(data.error || '操作失败')
          else {
            apply(data)
            if (after) after(data)
          }
          return data
        } catch (err) {
          setError(String(err?.message || err))
          return null
        } finally {
          setBusy('')
        }
      }
      useEffect(() => {
        installSettingsStyle()
        let alive = true
        setBusy('state')
        callSetup({ action: 'state' })
          .then((data) => {
            if (!alive) return
            if (data?.ok === false) setError(data.error || '读取状态失败')
            else apply(data)
          })
          .catch((err) => {
            if (alive) setError(`读取状态失败：${String(err?.message || err)}`)
          })
          .finally(() => {
            if (alive) setBusy('')
          })
        return () => {
          alive = false
          void callSetup({ action: 'login-cancel' }).catch(() => {})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      // 设备码登录：每 3 秒问一次结果
      useEffect(() => {
        if (!login) return undefined
        let alive = true
        const timer = setInterval(async () => {
          const data = await callSetup({ action: 'login-status', loginId: login.loginId }).catch(() => null)
          if (!alive || !data) return
          if (data.ok === false) {
            setLogin(null)
            setError(data.error || '登录会话已失效')
          } else if (data.done) {
            setLogin(null)
            apply(data)
            if (data.success) setMessage('✓ 登录成功，已切换为 ChatGPT 账号')
            else setError(`登录没有完成${data.error ? `：${data.error}` : ''}`)
          }
        }, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [login])

      const mode = state?.mode
      const isHub = mode === 'hub'
      const hubAvailable = state?.hubAvailable === true
      const hub = state?.hub || null
      const status = state?.status || null
      const usable = status?.loggedIn === true
      const detected = state?.detected || null
      const lines = detectedLines(detected)

      const stateCard = h('div', { className: 'cx-set-card', key: 'state' },
        h('div', { className: 'cx-set-card-head' },
          h('div', { className: 'cx-set-card-title' }, '当前状态',
            mode ? h('span', { className: 'cx-set-badge' }, MODE_NAMES[mode] || mode) : null),
          h('span', { className: 'cx-set-state' },
            h('span', { className: `cx-set-dot${usable ? '' : ' cx-set-dot-warn'}`, 'aria-hidden': true }),
            usable ? '可用' : busy === 'state' && !state ? '检测中…' : '不可用'),
        ),
        h('div', { className: 'cx-set-sub cx-set-break' }, describeStatus(state)),
        h('div', { className: 'cx-set-sub cx-set-break' }, '程序：', describeBinary(state?.binary)),
        hubAvailable && !isHub ? h('div', { className: 'cx-set-sub' }, '环境里有 Hub 下发的账号，现在按你自己的配置走（可在「Hub 下发」里改回去）。') : null,
        lines.length
          ? h('div', { className: 'cx-set-field', key: 'detected' },
              h('div', { className: 'cx-set-label' }, '本机已有配置（自动检测）'),
              h('ul', { className: 'cx-set-list' }, ...lines.map((line, index) => h('li', { key: index }, line))))
          : null,
        h('div', { className: 'cx-set-row', key: 'actions' },
          h('button', { type: 'button', className: 'cx-set-btn', disabled: !!busy, onClick: () => run('test', { action: 'test' }, (data) => setMessage(`✓ 连接正常（${data.model || 'Codex 默认模型'}，${Math.round(data.ms / 100) / 10}s）`)) }, busy === 'test' ? '测试中…' : '测试连接'),
          !isHub && hasMachineConfig(detected) && mode !== 'machine'
            ? h('button', { type: 'button', className: 'cx-set-btn', disabled: !!busy, onClick: () => run('machine', { action: 'use-machine' }, () => setMessage('已切换为本机配置（~/.codex）')) }, '使用本机配置')
            : null,
        ),
      )

      // Hub 下发：在用的时候只读；用户改用自己的配置后，这里给一个「改回 Hub 下发」
      const hubPanel = h('div', { className: 'cx-set-card', key: 'hub' },
        h('div', { className: 'cx-set-card-head' },
          h('div', { className: 'cx-set-card-title' }, '由 DSH Hub 管理员下发', isHub ? h('span', { className: 'cx-set-badge' }, '当前使用') : null)),
        h('div', { className: 'cx-set-sub cx-set-break' }, `Hub：${hub?.label || 'DSH Hub'}${hub?.baseUrl ? ` · ${hub.baseUrl}` : ''}`),
        h('div', { className: 'cx-set-sub cx-set-break' }, `默认模型：${hub?.defaultModel || '（未指定）'}`),
        h('div', { className: 'cx-set-sub cx-set-break' }, `可用模型：${hub?.models?.length ? hub.models.join('、') : isHub ? '（Hub 还没返回模型列表）' : '（改回 Hub 下发后从 Hub 拉取）'}`),
        h('div', { className: 'cx-set-sub' }, isHub ? '这块只读：账号由 Hub 管理员配置。要改用自己的账号，切到「账号登录」或「第三方 API」。' : '现在用的是你自己的配置，Hub 下发没有生效；切换过去不会删掉你保存的凭据。'),
        !isHub
          ? h('div', { className: 'cx-set-row' },
              h('button', { type: 'button', className: 'cx-set-btn cx-set-btn-primary', disabled: !!busy, onClick: () => run('use-hub', { action: 'use-hub' }, () => setMessage('已改回 Hub 下发')) }, busy === 'use-hub' ? '切换中…' : '改回 Hub 下发'))
          : null,
      )

      const hubSwitchNote = hubAvailable && isHub
        ? h('div', { className: 'cx-set-warn', key: 'hub-note' }, '改用自己的配置后，用量不走 Hub 计费，模型列表也不再由 Hub 提供。随时可以在「Hub 下发」里改回去。')
        : null

      const accountPanel = h('div', { className: 'cx-set-card', key: 'account' },
        hubSwitchNote,
        h('div', { className: 'cx-set-sub' }, '用 ChatGPT 账号登录（设备码）：打开链接 → 输入页面上的一次性代码 → 回来这里自动完成。登录保存在插件自己的目录，不动 ~/.codex。'),
        !login
          ? h('div', { className: 'cx-set-row' },
              h('button', { type: 'button', className: 'cx-set-btn cx-set-btn-primary', disabled: !!busy, onClick: () => run('login', { action: 'login-start' }, (data) => setLogin(data)) }, busy === 'login' ? '正在准备…' : '开始登录'),
              state?.chatgptSaved
                ? h('button', { type: 'button', className: 'cx-set-btn', disabled: !!busy, onClick: () => run('use-chatgpt', { action: 'use-chatgpt' }, () => setMessage('已切换为 ChatGPT 账号')) }, '使用已登录的账号')
                : null,
              state?.chatgptSaved ? h('span', { className: 'cx-set-sub' }, '插件里已有 ChatGPT 登录') : null,
            )
          : h('div', { className: 'cx-set-field' },
              h('div', null, '① 打开下面的链接，用 ChatGPT 账号登录：'),
              h('a', { className: 'cx-set-link', href: login.url, target: '_blank', rel: 'noreferrer' }, login.url),
              h('div', null, '② 在页面上输入这个代码：'),
              h('div', { className: 'cx-set-code' }, login.code),
              h('div', { className: 'cx-set-sub' }, '完成后这里会自动刷新。'),
              h('div', { className: 'cx-set-row' }, h('button', { type: 'button', className: 'cx-set-btn', onClick: () => { setLogin(null); void callSetup({ action: 'login-cancel' }).catch(() => {}) } }, '取消登录')),
            ),
      )

      const apiPanel = h('div', { className: 'cx-set-card', key: 'api' },
        hubSwitchNote,
        h('div', { className: 'cx-set-sub' }, '填第三方 / 中转站的 Base URL 与 API Key；API Key 留空表示只改 URL，不换 key。'),
        h('label', { className: 'cx-set-field' },
          h('span', { className: 'cx-set-label' }, 'API Key'),
          h('input', { className: 'cx-set-input', type: 'password', autoComplete: 'off', value: apiKey, placeholder: state?.apiKey?.configured ? '已保存（留空则不改）' : 'sk-…', onChange: (event) => setApiKey(event.target.value) })),
        h('label', { className: 'cx-set-field' },
          h('span', { className: 'cx-set-label' }, 'Base URL'),
          h('input', { className: 'cx-set-input', value: baseUrl, placeholder: 'https://example.com/v1（留空就是 OpenAI 官方）', onChange: (event) => setBaseUrl(event.target.value) })),
        h('label', { className: 'cx-set-field' },
          h('span', { className: 'cx-set-label' }, '默认模型（可选）'),
          h('input', { className: 'cx-set-input', value: model, placeholder: '中转站给模型起的名字，如 gpt-5.1', onChange: (event) => setModel(event.target.value) })),
        h('div', { className: 'cx-set-row' },
          h('span', { className: 'cx-set-label' }, '接口'),
          h('label', { className: 'cx-set-radio' }, h('input', { type: 'radio', checked: wireApi === 'responses', onChange: () => setWireApi('responses') }), 'Responses（推荐）'),
          h('label', { className: 'cx-set-radio' }, h('input', { type: 'radio', checked: wireApi === 'chat', onChange: () => setWireApi('chat') }), 'Chat Completions'),
        ),
        h('div', { className: 'cx-set-row' },
          h('button', { type: 'button', className: 'cx-set-btn cx-set-btn-primary', disabled: !!busy, onClick: () => run('key', { action: 'save-api-key', apiKey, baseUrl, wireApi, model }, () => { setApiKey(''); setMessage('✓ 已保存第三方 API 配置') }) }, busy === 'key' ? '保存中…' : '保存并使用'),
          h('span', { className: 'cx-set-sub' }, state?.apiKey?.configured ? '凭据库：已保存 API Key' : '凭据库：还没有 API Key'),
        ),
      )

      const views = { hub: 'Hub 下发', account: '账号登录', api: '第三方 API' }
      const tabIds = ['hub', 'account', 'api'].filter((id) => id !== 'hub' || hubAvailable)
      const modeTab = (id) => h('button', { type: 'button', role: 'tab', id: `codex-pilot-tab-${id}`, className: 'cx-set-tab', 'aria-selected': tab === id, 'aria-controls': `codex-pilot-panel-${id}`, onClick: () => setTab(id) }, views[id])
      const activeTab = tabIds.includes(tab) ? tab : tabIds[0]
      const modeCard = h('div', { className: 'cx-set-mode', key: 'mode' },
        h('div', { className: 'cx-set-tabs', role: 'tablist', 'aria-label': '配置方式' }, ...tabIds.map(modeTab)),
        h('div', { role: 'tabpanel', id: `codex-pilot-panel-${activeTab}`, 'aria-labelledby': `codex-pilot-tab-${activeTab}` },
          activeTab === 'hub' ? hubPanel : activeTab === 'account' ? accountPanel : apiPanel),
      )

      const clearCard = isHub ? null : h('div', { className: 'cx-set-card', key: 'clear' },
        h('div', { className: 'cx-set-card-title' }, '清除插件保存的凭据'),
        h('div', { className: 'cx-set-sub' }, hubAvailable ? '删掉插件自己存的 API Key 和 ChatGPT 登录，回到 Hub 下发；不会动 ~/.codex。' : '删掉插件自己存的 API Key 和 ChatGPT 登录，回到本机 Codex 方式；不会动 ~/.codex。'),
        h('div', { className: 'cx-set-row' },
          !confirmClear
            ? h('button', { type: 'button', className: 'cx-set-btn', disabled: !!busy, onClick: () => setConfirmClear(true) }, '清除插件保存的凭据')
            : h(React.Fragment, null,
                h('button', { type: 'button', className: 'cx-set-btn cx-set-btn-danger', disabled: !!busy, onClick: () => run('clear', { action: 'clear' }, () => { setConfirmClear(false); setMessage('已清除本插件保存的凭据，回到本机 Codex 方式') }) }, busy === 'clear' ? '清除中…' : '确认清除'),
                h('button', { type: 'button', className: 'cx-set-btn', disabled: !!busy, onClick: () => setConfirmClear(false) }, '取消'),
              ),
        ),
      )

      // 操作结果放在标题下面：面板会滚动，放底部时保存 / 登录的反馈经常看不见
      const notice = error || message
        ? h('div', { className: 'cx-set-row', key: 'notice' }, h('span', { className: error ? 'cx-set-msg-err' : 'cx-set-sub' }, error ? `✗ ${error}` : message))
        : null

      return h('div', { className: 'cx-set' },
        h('div', { className: 'cx-set-head', key: 'head' },
          h('div', { className: 'cx-set-title' }, h(CodexIcon, { size: 16 }), 'Codex'),
          h('div', { className: 'cx-set-desc' }, 'Codex 模式的登录与配置都在这里；对话里不再显示登录表单。'),
        ),
        notice,
        stateCard,
        modeCard,
        clearCard,
      )
    }

    /** 输入框上方：Codex 会话且还没登录时显示一行短提示（登录表单在 设置 → Codex）。 */
    function CodexDock(props) {
      const state = usePilot()
      const sessionId = props?.session?.sessionId ?? props?.session?.id ?? props?.sessionId
      const isPilot = sessionId !== undefined && state.ids.has(sessionId)
      const showHint = isPilot && state.setupReady === false
      // 停靠槽在一个 flex 列里，子元素会被拉满整栏；提示条按输入框卡片的宽度居中，和它对齐
      const hintRef = useRef(null)
      const [cardWidth, setCardWidth] = useState(712)
      useEffect(() => {
        if (!showHint) return undefined
        const card = hintRef.current?.closest?.('[class*="composerStack"]')?.querySelector?.('[class*="_card"]')
        if (!card || typeof ResizeObserver !== 'function') return undefined
        const sync = () => {
          const width = Math.round(card.getBoundingClientRect().width)
          if (width > 0) setCardWidth(width)
        }
        sync()
        const observer = new ResizeObserver(sync)
        observer.observe(card)
        return () => observer.disconnect()
      }, [showHint])
      if (!showHint) return null
      return h('div', {
        ref: hintRef,
        title: state.setupNote || '登录与配置在 设置 → Codex',
        style: { display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'center', width: '100%', maxWidth: cardWidth, boxSizing: 'border-box', padding: '4px 12px', borderRadius: 12, background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))', color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden' },
      },
        h(CodexIcon, { size: 12 }),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, state.setupNote || 'Codex 未登录 · 去「设置 → Codex」配置'),
      )
    }

    /* ---- ③ 运行状态：DSH 的「深度求索中」→ Codex 的状态行 ---- */

    const STYLE_ID = 'codex-pilot-running-style'
    const installStyle = () => {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      // Codex TUI 的状态行前面是一个呼吸的圆点
      style.textContent = `
[data-codex-running] [class*="runningIcon"] > * { display: none !important; }
[data-codex-running] [class*="runningIcon"]::before {
  content: '•'; display: inline-flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; font-size: 18px; line-height: 1;
  animation: codex-pilot-pulse 1.2s ease-in-out infinite;
}
@keyframes codex-pilot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }`
      document.head.appendChild(style)
    }

    /** 从 DSH 原文里取出耗时（"深度求索中，用时 6秒 ···" / "Deep diving for 6s ···"）。 */
    const durationOf = (text) => {
      const match = /用时\s*(.+?)\s*·/.exec(text) || /for\s+(.+?)\s*·/.exec(text)
      return match ? match[1] : ''
    }
    const rewriteRunning = () => {
      for (const running of document.querySelectorAll('[data-chat-running]')) {
        const sessionId = running.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
        if (!sessionId || !pilot.ids.has(sessionId)) {
          if (running.hasAttribute('data-codex-running')) running.removeAttribute('data-codex-running')
          continue
        }
        if (!running.hasAttribute('data-codex-running')) running.setAttribute('data-codex-running', '')
        const header = pilot.activity[sessionId] || 'Working'
        // 改的是 React 自己那个文本节点的 nodeValue（不能换节点）；React 每秒写回原文 → 观察器触发 → 再改回来
        const textNodes = running.querySelectorAll('[class*="runningText"] [class*="_text_"]')
        const main = [...textNodes].find((node) => !node.hasAttribute('data-shimmer-text'))
        const textNode = main?.firstChild
        if (!main || !textNode || textNode.nodeType !== 3) continue
        const current = textNode.nodeValue || ''
        if (current !== main.dataset.codexLabel) main.dataset.codexNative = current
        const duration = durationOf(main.dataset.codexNative || '')
        const label = `${header}${duration ? ` (${duration})` : ''}`
        main.dataset.codexLabel = label
        if (current !== label) textNode.nodeValue = label
        for (const node of textNodes) {
          if (node.hasAttribute('data-shimmer-text') && node.getAttribute('data-shimmer-text') !== label) node.setAttribute('data-shimmer-text', label)
        }
        const status = running.querySelector('[role="status"]')?.firstChild
        if (status?.nodeType === 3 && status.nodeValue !== header) status.nodeValue = header
      }
    }

    // ⚠ 前端插件激活时只要抛错，DSH 整个网页都起不来（web boot: entry did not activate）。
    // 所以每一块都单独兜住：出错只让那一块失效。
    const guarded = (label, fn) => {
      try {
        fn()
      } catch (error) {
        console.warn(`[codex-pilot] ${label} 启用失败（不影响其他功能）：`, error)
      }
    }

    return {
      apply(ctx) {
        guarded('右侧栏自动打开任务', () => applySidebar(ctx))
        guarded('侧栏图标', () => applyMascot(ctx))
        guarded('运行状态', () => applyRunning(ctx))
        guarded('未登录提示条', () => applySetupDock(ctx))
        guarded('设置 → Codex 分区', () => applySettingsSection(ctx))
        guarded('用量条', () => applyUsagePill(ctx))
      },
    }

    function applySidebar(ctx) {
      ctx.inject(['sidebarRight'], (scope) => scope.effect(() => {
        let alive = true
        let since = null
        const pending = new Map()
        const opened = new Set()
        const sidebar = scope.sidebarRight
        const mountedSession = () => {
          try {
            return sidebar?.mounted?.getSnapshot?.()
          } catch {
            return undefined
          }
        }
        const openDue = () => {
          const current = mountedSession()
          if (!current || !sidebar?.openResource) return
          for (const [child, spawn] of pending) {
            if (spawn.parent !== current) continue
            pending.delete(child)
            if (opened.has(child)) continue
            opened.add(child)
            try {
              sidebar.openResource(chatAddress(spawn), { kind: 'subagentchat', preferNewPane: true })
            } catch (error) {
              console.warn('[codex-pilot] 右侧栏打开任务失败：', error)
            }
          }
        }
        const poll = async () => {
          try {
            const response = await fetch(`codex-pilot?since=${since ?? 0}`, { headers: { accept: 'application/json' } })
            const data = await response.json()
            if (!alive || !data?.ok) return
            if (since === null) since = (Number(data.now) || 0) - 30000
            pilot.activity = data.activity || {}
            publishPilot(data.pilotSessions)
            publishReady(data.setupReady, data.setupNote || null)
            for (const spawn of data.spawns || []) {
              if (spawn.at <= since) continue
              since = Math.max(since, spawn.at)
              if (!opened.has(spawn.child)) pending.set(spawn.child, spawn)
            }
          } catch {
            /* host 半边没起来：什么都不做 */
          }
          openDue()
          rewriteRunning()
        }
        void poll()
        const timer = setInterval(poll, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, 'codex-pilot: 右侧栏自动打开派出的任务'))
    }

    function applyMascot(ctx) {
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'sidebar.session.row.leading',
              { name: 'sidebar.session.row.leading', id: 'codex-pilot-mark', order: 2, label: () => 'Codex', locale: NS },
              CodexSessionMark,
              '侧栏图标',
            ),
          'codex-pilot: sidebar session mark',
        ),
      )
    }

    function applySetupDock(ctx) {
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'conversation.input.dock',
              { name: 'conversation.input.dock', id: 'codex-pilot-setup', order: 6, label: () => 'Codex 未登录提示', locale: NS },
              CodexDock,
              '未登录提示条',
            ),
          'codex-pilot: setup dock',
        ),
      )
    }

    /** DSH 设置页里的「Codex」分区（登录 / 配置都在这里，对话里不再做）。 */
    function applySettingsSection(ctx) {
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'settings.section',
              { name: 'settings.section', id: 'codex-pilot', order: 41, label: () => 'Codex', locale: NS },
              () => h(SettingsBoundary, null, h(CodexSettingsSection)),
              '设置分区',
            ),
          'codex-pilot: settings section',
        ),
      )
    }

    function applyUsagePill(ctx) {
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'conversation.composer.dock',
              { name: 'conversation.composer.dock', id: 'codex-pilot-usage', order: 2, label: () => 'Codex 用量', locale: NS },
              CodexUsagePill,
              '用量条',
            ),
          'codex-pilot: usage pill',
        ),
      )
    }

    function applyRunning(ctx) {
      ctx.effect(() => {
        installStyle()
        let scheduled = false
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          queueMicrotask(() => {
            scheduled = false
            rewriteRunning()
          })
        })
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-shimmer-text'] })
        return () => observer.disconnect()
      }, 'codex-pilot: Codex 运行状态')
    }
  },
})
