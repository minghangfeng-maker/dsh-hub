/**
 * dsh-claude-pilot —— Client 半边（浏览器）。
 *
 *   ① Claude 派出 DSH 任务时，在右侧栏打开那个子会话（原生 subagentchat tab）；
 *   ② 侧栏里 Claude Code 模式的会话，行前挂一个 Claude 小人（slot: sidebar.session.row.leading）；
 *   ③ Claude Code 会话运行时，把 DSH 的「深度求索中」换成 Claude Code 的动作词（Pondering… 等）
 *      和它的星形动画。右侧栏里的 DSH 任务保持原样 —— 那边确实是 DeepSeek 在跑。
 *
 * 数据都来自 host 半边 GET /claude-pilot?since=…（每 1.5 秒）：新派出的任务 + Claude Code 模式的会话。
 * 约定：只从浏览器模块表 require('react')，不 import harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-claude-pilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React
    const NS = 'claudePilot'
    const SUBAGENT_CHAT = 'dsh-resource://subagentchat/session/'
    const chatAddress = (spawn) =>
      `${SUBAGENT_CHAT}${encodeURIComponent(spawn.child)}?${new URLSearchParams({ parent: spawn.parent, mode: spawn.mode || 'continuable' })}`

    // Claude Code 2.1.303 的 spinner 动作词（从 claude 程序里取出的原表）
    const VERBS = ['Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kerfuffling', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Onioning', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophizing', 'Photosynthesizing', 'Polishing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmogrifying', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unraveling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging']
    const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)]

    // Claude 的小人（透明底 PNG，沿用 dsh-claude-code-agent 那张）
    const CLAWD_ICON = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAABwAAAATCAYAAACDW21BAAACC0lEQVR42mNgQAKn6+IPnayNvwTGdRRioBkn6lNWMeADQAtfn6qJ+w/CJ0nEp7Dx65LOEbTwJBmW4cIn6hKJt/BUbfz/U3UJ/0/WJhDtw1N1iWB9ZFnYHRf6X8vA9f/6gmiifL0uP/K/toHL/8ao4I9kWdgbH/Lf0MT9/4bCWKIsXA+00NDY/X9zdMinwWXhqdoEvxN18enAuMo4XRv/GZZKV+VGfi0OCXy+tzz2Hd54g7L3lsX8Lg4Jer40J+otXLw28fHJmvgMMK4F4rr4CIYztfHHsGUDcKIBayI2W8RDMFKiOYWGgT6+AQzGuOOnqJgVCGQToIW1qBbSwnIUHwJLg8Tj9Sk1x+tTa081pE46RUVLgGZfBJkLw8ca0jJREtDV/lKtU1QNwuQFeLMFyMLTNbFU9CEBCy/2V2gBXfXvRF3SP1IKbMxQgaRUYG2B30IYuNCY4HwalMSb0lIPtRSpA8vIW8D8+gnIVgPxYfhoY3Y4OPvUJ+893JKvdqI++TwwP38/2AqSL1Tf31khQZSF55uSnUEGna2P9wQXDnVJV4CFwgd0dcfrMixOAfPpKWi9BwydY0ALvzKQCs43JTmDMvHZ+jiohYlACxOwWwgK0oZUiIX1ZFp4tiXd8mRDyq0zTSl2IP7JxrStJxpSz6KrO9Sab3CyIfXWyabMGWAHNGWuOtGQdgmf2QCQv+t8q5uwrwAAAABJRU5ErkJggg=='

    /** 共享状态：Claude Code 模式的会话（侧栏小人与动作词都看它）。 */
    const pilot = { ids: new Set(), setupReady: null, setupNote: null, setupHint: null, listeners: new Set() }
    const notifyPilot = () => {
      for (const listener of pilot.listeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[claude-pilot] 状态刷新出错：', error)
        }
      }
    }
    const publishPilot = (ids) => {
      const next = new Set(ids || [])
      if (next.size === pilot.ids.size && [...next].every((id) => pilot.ids.has(id))) return
      pilot.ids = next
      guardedStyle(() => installRowStyle(next))
      notifyPilot()
    }

    /*
     * 会话运行中时，DSH 侧栏行首那一格显示的是状态转圈，不渲染 sidebar.session.row.leading 槽，小人就看不到了。
     * 这里用一段按会话 id 生成的 CSS：Claude Code 会话的转圈（data-state=ongoing）藏起来，换成一个跳动的小人。
     * 纯 CSS、不碰 DOM 节点 —— React 重绘行也不会丢。
     */
    const ROW_STYLE_ID = 'claude-pilot-row-style'
    const guardedStyle = (fn) => {
      try {
        fn()
      } catch (error) {
        console.warn('[claude-pilot] 侧栏运行中小人样式出错：', error)
      }
    }
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
      const slot = (suffix) => rows.map((row) => `${row} [class*="_slot"]:has(> svg[data-state="ongoing"])${suffix}`).join(',\n')
      style.textContent = `
${rows.map((row) => `${row} [class*="_slot"] > svg[data-state="ongoing"]`).join(',\n')} { display: none !important; }
${slot('::before')} {
  content: ''; display: block; width: 15px; height: 10px; margin: auto;
  background: url("${CLAWD_ICON}") center / contain no-repeat;
  animation: claude-pilot-hop 0.9s ease-in-out infinite;
  transform-origin: 50% 100%;
}
@keyframes claude-pilot-hop {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  15% { transform: translateY(0) scale(1.12, 0.86); }
  45% { transform: translateY(-3px) scale(0.94, 1.08); }
  70% { transform: translateY(0) scale(1.06, 0.94); }
}`
    }

    /*
     * 强制刷新一次：DSH 会把改过的 client.js 热替换进已打开的标签页（HMR），但旧模块留下的东西
     * （已挂的样式、旧闭包）不一定清得干净。改了 RELOAD_TOKEN 的版本经 HMR 到达已打开的页面时，
     * 整页刷新一次；新打开的页面只记下 token、不刷新。sessionStorage 防止循环。
     */
    const RELOAD_TOKEN = '2026-10-21.1'
    const forceReloadOnce = () => {
      const key = 'claude-pilot:reload-token'
      try {
        const seen = sessionStorage.getItem(key)
        sessionStorage.setItem(key, RELOAD_TOKEN)
        const hotSwapped = document.readyState === 'complete' && performance.now() > 20000
        if (hotSwapped && seen !== RELOAD_TOKEN) {
          console.info('[claude-pilot] 插件前端已更新，刷新页面')
          setTimeout(() => location.reload(), 300)
        }
      } catch {
        /* 无 sessionStorage：不刷新 */
      }
    }
    const publishHint = (hint) => {
      // 只在第一次拿到时记下来（服务端每次轮询都会给；页面里只提示一次，刷新页面才会再来一次）
      if (!hint || pilot.setupHint === hint) return
      pilot.setupHint = hint
      notifyPilot()
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

    /** 槽注册：等槽存在再注册，HMR 重挂载时有限重试（照抄 dsh-claude-code-agent 的写法）。 */
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
          console.warn(`[claude-pilot] ${label} 注册失败：${error.message}（刷新页面即可恢复）`)
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

    const ClaudeSessionMark = (props) => {
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
        { title: 'Claude Code 模式', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' } },
        h('img', { src: CLAWD_ICON, width: 15, height: 10, alt: '', 'aria-hidden': true, style: { display: 'block' } }),
      )
    }

    /* ---- ④ 设置页分区「Claude Code」+ 对话里的一行未登录提示 ---- */

    // 相对路径（页面有 <base href="./">）：经广州 /home/ 这类前缀反代时也能打到本机 DSH
    const SETUP_API = 'api/claude-pilot.setup'
    const callSetup = async (body) => {
      const response = await fetch(SETUP_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || { action: 'state' }),
      })
      const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (typeof data.ready === 'boolean') publishReady(data.ready, data.status?.authMethod === 'hub' && !data.ready ? data.status.error || null : null)
      return data
    }

    /* ---- ⑤ 输入框下方的用量条：Claude 订阅额度（5 小时 / 每周）+ 本会话累计，排在「缓存命中」右边 ---- */

    // 用量面板浮层挂到 document.body 上，免得被输入框那一栏的 overflow 裁掉
    let portal = null
    try {
      portal = require('react-dom')?.createPortal || null
    } catch {
      portal = null
    }

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

    const USAGE_STYLE_ID = 'claude-pilot-usage-style'
    const installUsageStyle = () => {
      if (document.getElementById(USAGE_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = USAGE_STYLE_ID
      // 颜色只给条形「填充」用（严重程度）：正常 = Claude 橙，≥70% 琥珀，≥90% 红；轨道是同色相的浅一档。
      // 文字一律用 DSH 的文字色（tertiary / secondary），暗色模式跟着 DSH 的变量走。
      style.textContent = `
.cp-usage-anchor { display: inline-flex; min-width: 0; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.cp-usage-pill { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm, 6px); background: none; color: var(--dsw-alias-label-tertiary, #81858c); font: inherit; line-height: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.cp-usage-pill:hover, .cp-usage-pill[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-secondary, #555); }
.cp-usage-pill img { flex: none; width: 14px; height: 9px; image-rendering: pixelated; }
.cp-usage-sep { color: var(--dsw-alias-separator-primary, #d0d0d0); margin: 0 2px; }
.cp-usage-item { display: inline-flex; align-items: center; gap: 5px; }
.cp-meter { --cp-fill: #D97757; position: relative; display: inline-block; flex: none; width: 28px; height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--cp-fill) 20%, transparent); }
.cp-meter > i { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--cp-fill); transition: width .4s ease; }
.cp-meter[data-level="warning"] { --cp-fill: #D4A017; }
.cp-meter[data-level="critical"] { --cp-fill: #D64545; }
.cp-meter.cp-meter-wide { width: 100%; height: 6px; border-radius: 3px; }
.cp-meter.cp-meter-wide > i { border-radius: 3px; }
.cp-usage-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: 320px; max-width: calc(100vw - 24px); padding: 16px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-specific-menu, #fff); backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent, 0 8px 30px rgba(0,0,0,.15)); color: var(--dsw-alias-label-secondary, #555); font-size: 12px; line-height: 18px; cursor: default; }
.cp-usage-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: var(--dsw-alias-label-primary, #111); font-weight: 500; }
.cp-usage-title span { display: inline-flex; align-items: center; gap: 6px; }
.cp-usage-title img { width: 15px; height: 10px; image-rendering: pixelated; }
.cp-usage-badge { padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 500; color: #B5583A; background: color-mix(in srgb, #D97757 14%, transparent); }
.cp-usage-rule { border-top: .5px solid var(--dsw-alias-border-l2, #e5e5e5); margin: 0 0 10px; }
.cp-usage-limit { margin-bottom: 12px; }
.cp-usage-limit-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.cp-usage-limit-head b { font-weight: 500; color: var(--dsw-alias-label-primary, #111); font-variant-numeric: tabular-nums; }
.cp-usage-reset { margin-top: 3px; color: var(--dsw-alias-label-tertiary, #888); }
.cp-usage-section { margin: 4px 0 6px; color: var(--dsw-alias-label-tertiary, #888); }
.cp-usage-dl { display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 4px 16px; margin: 0 0 10px; color: var(--dsw-alias-label-tertiary, #888); }
.cp-usage-dl dt, .cp-usage-dl dd { margin: 0; min-width: 0; }
.cp-usage-dl dd { text-align: right; color: var(--dsw-alias-label-secondary, #555); font-variant-numeric: tabular-nums; }
.cp-usage-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.cp-usage-foot button { padding: 0 6px; border: none; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary, #555); font: inherit; cursor: pointer; }
.cp-usage-foot button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.cp-usage-warn { margin: 0 0 10px; color: var(--dsw-alias-label-secondary, #555); }`
      document.head.appendChild(style)
    }

    const LIMIT_NAMES = {
      session: { short: '5h', long: '当前 5 小时窗口' },
      weekly_all: { short: '周', long: '本周 · 全部模型' },
      weekly_opus: { short: 'Opus', long: '本周 · Opus' },
      weekly_sonnet: { short: 'Sonnet', long: '本周 · Sonnet' },
    }
    const limitName = (limit) => LIMIT_NAMES[limit.kind] || { short: limit.kind, long: limit.kind.replace(/_/g, ' ') }
    const levelOf = (limit) => {
      const severity = String(limit.severity || 'normal')
      if (limit.percent >= 90 || /critical|exceeded|rejected|blocked/.test(severity)) return 'critical'
      if (limit.percent >= 70 || severity === 'warning') return 'warning'
      return 'normal'
    }
    const LEVEL_TEXT = { warning: '接近上限', critical: '即将用满' }
    const Meter = ({ limit, wide }) =>
      h('span', { className: wide ? 'cp-meter cp-meter-wide' : 'cp-meter', 'data-level': levelOf(limit), 'aria-hidden': true }, h('i', { style: { width: `${Math.max(limit.percent > 0 ? 2 : 0, limit.percent)}%` } }))

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
    // 状态栏上只放最要紧的两个：5 小时窗口 + 每周（全部模型）；其余窗口进面板
    const headline = (limits) => {
      const pick = []
      const session = limits.find((l) => l.kind === 'session')
      const weekly = limits.find((l) => l.kind === 'weekly_all') || limits.find((l) => l.group === 'weekly')
      if (session) pick.push(session)
      if (weekly) pick.push(weekly)
      return pick.length ? pick : limits.slice(0, 2)
    }

    const UsagePanel = ({ data, anchor, onClose, onRefresh, refreshing }) => {
      const [, tick] = useState(0)
      useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 30000)
        const onKey = (event) => event.key === 'Escape' && onClose()
        const onDown = (event) => {
          if (anchor?.contains(event.target) || event.target.closest?.('.cp-usage-panel')) return
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
      const children = []
      children.push(
        h('div', { className: 'cp-usage-title', key: 'title' },
          h('span', null, h('img', { src: CLAWD_ICON, alt: '' }), 'Claude 用量'),
          plan.kind === 'plan' && plan.plan ? h('span', { className: 'cp-usage-badge' }, String(plan.plan).toUpperCase()) : plan.kind === 'apiKey' ? h('span', { className: 'cp-usage-badge' }, 'API Key') : null,
        ),
        h('div', { className: 'cp-usage-rule', key: 'rule' }),
      )
      if (plan.error) children.push(h('div', { className: 'cp-usage-warn', key: 'warn' }, `⚠ 暂时没能更新：${plan.error}`))
      if (plan.kind === 'apiKey') children.push(h('div', { className: 'cp-usage-warn', key: 'api' }, 'API Key 方式按量计费，没有订阅额度窗口。'))
      for (const limit of limits) {
        const name = limitName(limit)
        const level = levelOf(limit)
        children.push(
          h('div', { className: 'cp-usage-limit', key: limit.kind },
            h('div', { className: 'cp-usage-limit-head' },
              h('span', null, name.long, level !== 'normal' ? ` · ⚠ ${LEVEL_TEXT[level]}` : ''),
              h('b', null, `${limit.percent}%`),
            ),
            h(Meter, { limit, wide: true }),
            limit.resetsAt ? h('div', { className: 'cp-usage-reset' }, formatReset(limit.resetsAt)) : null,
          ),
        )
      }
      if (plan.extra) {
        children.push(h('div', { className: 'cp-usage-limit', key: 'extra' },
          h('div', { className: 'cp-usage-limit-head' }, h('span', null, '额外用量（本月）'), h('b', null, `${Math.round(plan.extra.utilization)}%`)),
          h(Meter, { limit: { percent: Math.round(plan.extra.utilization), severity: 'normal' }, wide: true }),
        ))
      }
      if (stats) {
        const rows = [
          ['Claude 轮次', `${stats.turns || 0}${stats.abortedTurns ? `（停止 ${stats.abortedTurns}）` : ''}${stats.steeredTurns ? `（插话 ${stats.steeredTurns}）` : ''}`],
          ['输出', formatTokens(stats.output)],
          ['缓存读取', formatTokens(stats.cacheRead)],
          ['缓存写入', formatTokens(stats.cacheWrite)],
          ['未缓存输入', formatTokens(stats.input)],
        ]
        if (stats.costUsd) rows.push([plan.kind === 'apiKey' ? '费用' : '按 API 价折算', `$${Number(stats.costUsd).toFixed(2)}`])
        children.push(
          h('div', { className: 'cp-usage-section', key: 'sec' }, `本会话${stats.model ? ` · ${stats.model}` : ''}`),
          h('dl', { className: 'cp-usage-dl', key: 'dl' }, ...rows.flatMap(([k, v]) => [h('dt', { key: `${k}-t` }, k), h('dd', { key: `${k}-d` }, v)])),
        )
      }
      children.push(
        h('div', { className: 'cp-usage-foot', key: 'foot' },
          h('span', null, plan.kind === 'plan' ? `来自 Claude 账户 · ${formatAgo(plan.fetchedAt || Date.now())}` : formatAgo(plan.fetchedAt || Date.now())),
          h('button', { type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'),
        ),
      )
      const panel = h('div', { className: 'cp-usage-panel', role: 'dialog', 'aria-label': 'Claude 用量', style: { left, bottom } }, ...children)
      return portal ? portal(panel, document.body) : panel
    }

    const ClaudeUsagePill = (props) => {
      const sessionId = props?.sessionId
      const useProjection = props?.useProjection
      // 本会话 token 用量一变（一轮跑完）就顺手刷新额度；hook 必须无条件调用
      const tokenUsage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
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
        return () => clearInterval(timer)
      }, [isPilot, sessionId])
      const usageKey = tokenUsage ? `${tokenUsage.outputTokens}|${tokenUsage.cacheReadTokens}` : ''
      useEffect(() => {
        if (!isPilot || !usageKey) return
        const timer = setTimeout(() => void loadUsage(sessionId), 2500)
        return () => clearTimeout(timer)
      }, [usageKey])
      if (!isPilot) return null
      const data = usageState.sessionId === sessionId ? usageState.data : null
      const plan = data?.plan
      if (!plan || plan.kind === 'none') return null
      const limits = Array.isArray(plan.limits) ? plan.limits : []
      let body
      if (plan.kind === 'plan' && limits.length) {
        const items = headline(limits)
        body = items.flatMap((limit, index) => {
          const level = levelOf(limit)
          const item = h('span', { className: 'cp-usage-item', key: limit.kind },
            `${limitName(limit).short}`,
            h(Meter, { limit }),
            `${level !== 'normal' ? '⚠' : ''}${limit.percent}%`,
          )
          return index ? [h('span', { className: 'cp-usage-sep', key: `sep-${index}` }, '·'), item] : [item]
        })
      } else if (data?.session?.costUsd) {
        body = [h('span', { key: 'cost' }, `本会话 $${Number(data.session.costUsd).toFixed(2)}`)]
      } else {
        return null
      }
      const aria = plan.kind === 'plan' ? `Claude 用量：${headline(limits).map((l) => `${limitName(l).long} ${l.percent}%`).join('，')}` : 'Claude 用量'
      return h('span', { className: 'cp-usage-anchor', ref: setAnchor },
        h('button', { type: 'button', className: 'cp-usage-pill', 'aria-label': aria, 'aria-expanded': open, 'aria-haspopup': 'dialog', title: plan.stale ? `数据可能过时：${plan.error || ''}` : undefined, onClick: () => setOpen((v) => !v) },
          h('img', { src: CLAWD_ICON, alt: '' }),
          ...body,
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

    const colors = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      line: 'var(--dsw-alias-separator-primary, rgba(127,127,127,0.25))',
      bg: 'var(--dsw-alias-bg-primary, #fff)',
      soft: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
      claude: '#D97757',
    }
    const button = (primary) => ({
      padding: '6px 14px', borderRadius: '8px', border: primary ? 'none' : `1px solid ${colors.line}`,
      background: primary ? colors.claude : 'transparent', color: primary ? '#fff' : colors.text,
      cursor: 'pointer', fontSize: '13px', lineHeight: '20px', whiteSpace: 'nowrap',
    })
    const input = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: `1px solid ${colors.line}`, background: 'transparent', color: colors.text, fontSize: '13px' }

    function describeMode(state) {
      if (!state) return '检测中…'
      if (state.mode === 'hub') return `DSH Hub 下发（${state.hub?.label || 'DSH Hub'}）`
      if (state.mode === 'apiKey') return '第三方 API（插件保存的 Key）'
      if (state.mode === 'oauthToken') return '账号登录（插件保存的 token）'
      return '本机配置（这台机器上的 Claude Code 登录 / 环境变量）'
    }
    function describeBinary(binary) {
      if (!binary?.path) return '找不到 Claude Code 程序'
      return binary.source === 'bundled' ? '插件自带（Agent SDK）' : binary.path
    }
    const AUTH_METHODS = { 'claude.ai': '订阅账号', oauth_token: '订阅 token', api_key: 'API Key', hub: 'DSH Hub' }
    /** 本机已有配置 → 一行行中文；只描述「有什么」，不含任何密钥值。 */
    function detectedLines(detected) {
      if (!detected) return []
      const lines = []
      const auth = detected.auth
      if (auth?.loggedIn) {
        const how = AUTH_METHODS[auth.authMethod] || auth.authMethod || '已登录'
        const extra = [auth.subscriptionType, auth.email].filter(Boolean).join(' · ')
        lines.push(`检测到本机 Claude Code 已登录（${how}${extra ? `：${extra}` : ''}）`)
      } else if (detected.credentialsFile?.present) {
        lines.push(`检测到 ${detected.credentialsFile.path}（本机登录过 Claude Code；账号信息没有读取）`)
      }
      const settings = detected.settingsFile
      if (settings?.present) {
        const keys = [settings.hasApiKey ? 'ANTHROPIC_API_KEY' : '', settings.hasAuthToken ? 'ANTHROPIC_AUTH_TOKEN' : ''].filter(Boolean)
        if (settings.baseUrl) {
          lines.push(`检测到 ${settings.path} 里配置了 ANTHROPIC_BASE_URL=${settings.baseUrl}${keys.length ? `（另外还配置了 ${keys.join(' / ')}，值不显示）` : ''}`)
        } else if (keys.length) {
          lines.push(`检测到 ${settings.path} 里配置了 ${keys.join(' / ')}（值不显示）`)
        } else {
          lines.push(`检测到 ${settings.path}（里面没有 ANTHROPIC_* 配置）`)
        }
      }
      const env = detected.env
      if (env?.hasApiKey || env?.hasAuthToken || env?.baseUrl) {
        const bits = [env.baseUrl ? `ANTHROPIC_BASE_URL=${env.baseUrl}` : '', env.hasApiKey ? 'ANTHROPIC_API_KEY' : '', env.hasAuthToken ? 'ANTHROPIC_AUTH_TOKEN' : ''].filter(Boolean)
        lines.push(`检测到 DSH 进程环境变量里已有 ${bits.join(' / ')}（值不显示）`)
      }
      if (!lines.length) lines.push('没有检测到本机已有的 Claude Code 配置')
      return lines
    }

    // 设置页里的卡片 / 文字 / 页签：颜色全部走 DSH 的变量，亮暗主题都跟着变
    const card = { border: '1px solid var(--dsw-alias-settings-card-stroke, rgba(127,127,127,0.22))', borderRadius: 'var(--dsw-radius-xl, 12px)', background: 'var(--dsw-alias-settings-card-fill, transparent)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }
    const muted = { color: colors.sub, fontSize: 12, lineHeight: '18px' }
    const badgeStyle = (color) => ({ padding: '0 6px', borderRadius: 4, fontSize: 11, lineHeight: '18px', fontWeight: 500, color, background: `color-mix(in srgb, ${color} 14%, transparent)` })
    const tabRow = { display: 'inline-flex', gap: 2, padding: 2, borderRadius: 10, background: colors.soft, alignSelf: 'flex-start' }
    const tabButton = (active) => ({ border: 'none', borderRadius: 8, padding: '4px 12px', fontSize: 13, lineHeight: '20px', cursor: 'pointer', background: active ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18))' : 'transparent', color: active ? colors.text : colors.sub, fontWeight: active ? 500 : 400, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' })
    const linkButton = { border: 'none', background: 'none', padding: 0, fontSize: 12, color: colors.sub, cursor: 'pointer' }
    const field = { display: 'flex', flexDirection: 'column', gap: 4 }
    const fieldLabel = { fontSize: 12, color: colors.sub }
    const divider = { borderTop: `0.5px solid ${colors.line}`, margin: '2px 0' }

    /** 分区渲染出错时只坏这一块，别连累整个设置页。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h('div', { style: { ...card, color: colors.text } },
            h('div', { style: { fontWeight: 600 } }, 'Claude Code 设置加载出错'),
            h('div', { style: muted }, String(this.state.error?.message || this.state.error)))
        }
        return this.props.children
      }
    }

    /**
     * 设置 → Claude Code：打开就自动跑一次 state（含后端 detected 的本机配置检测），
     * 两种方式用页签切换：账号登录（setup-token 流程）/ 第三方 API（Base URL + Key）；
     * Hub 下发时整块只读。任何地方都不显示 key / token。
     */
    function ClaudeSettingsSection() {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [tab, setTab] = useState('account')
      const [apiKey, setApiKey] = useState('')
      const [baseUrl, setBaseUrl] = useState('')
      const [keyHeader, setKeyHeader] = useState('x-api-key')
      const [login, setLogin] = useState(null)
      const [code, setCode] = useState('')
      const [manualToken, setManualToken] = useState('')
      const [confirmClear, setConfirmClear] = useState(false)
      const tabPicked = useRef(false)

      const applyState = (data) => {
        if (!data || typeof data.mode !== 'string') return
        setState(data)
        setBaseUrl(data.baseUrl || '')
        setKeyHeader(data.keyHeader === 'bearer' ? 'bearer' : 'x-api-key')
        if (!tabPicked.current) {
          tabPicked.current = true
          setTab(data.mode === 'hub' ? 'hub' : data.mode === 'apiKey' ? 'api' : 'account')
        }
      }
      const run = async (label, body, after) => {
        setBusy(label)
        setError('')
        setNotice('')
        try {
          const data = await callSetup(body)
          if (!data || data.ok === false) {
            setError((data && data.error) || '操作失败')
          } else {
            applyState(data)
            if (after) after(data)
          }
          return data
        } catch (caught) {
          setError(String(caught?.message || caught))
          return null
        } finally {
          setBusy('')
        }
      }
      useEffect(() => {
        void run('state', { action: 'state' })
        // 离开分区时如果登录还在进行（伪终端还开着），顺手取消
        return () => {
          void callSetup({ action: 'login-cancel' }).catch(() => {})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const mode = state?.mode
      const hub = state?.hub
      const hubAvailable = state?.hubAvailable === true
      const detected = state?.detected
      const autoLogin = state?.autoLogin !== false
      const label = (which, idle, working) => (busy === which ? working : idle)
      const noticeLine = error
        ? h('div', { style: { color: '#d4380d', wordBreak: 'break-all' } }, `✗ ${error}`)
        : notice ? h('div', { style: muted }, notice) : null

      const statusCard = h('div', { style: card, key: 'status' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('b', { style: { fontWeight: 600 } }, '当前状态'),
          state?.ready === true ? h('span', { style: badgeStyle('#2f9e44') }, '可用')
            : state?.ready === false ? h('span', { style: badgeStyle('#d4380d') }, '不可用')
              : h('span', { style: badgeStyle(colors.sub) }, '检测中…')),
        h('div', null, h('span', { style: { color: colors.sub } }, '方式：'), describeMode(state)),
        h('div', null, h('span', { style: { color: colors.sub } }, '程序：'), describeBinary(state?.binary)),
        state?.status?.error ? h('div', { style: { color: '#d4380d', wordBreak: 'break-all' } }, state.status.error) : null,
        h('div', { style: divider }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          h('div', { style: fieldLabel }, '本机已有的配置'),
          ...detectedLines(detected).map((line) => h('div', { key: line, style: { wordBreak: 'break-all' } }, `· ${line}`))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: button(false), disabled: !!busy, onClick: () => run('test', { action: 'test' }, (data) => setNotice(data?.ok ? `✓ 连接正常（${data.model || '默认模型'}，${Math.round((Number(data.ms) || 0) / 100) / 10}s）` : '✗ 连接失败')) }, label('test', '测试连接', '测试中…')),
          detected?.usable && mode !== 'machine'
            ? h('button', { type: 'button', style: button(true), disabled: !!busy, onClick: () => run('machine', { action: 'use-machine' }, () => setNotice('✓ 已切换为使用本机配置')) }, label('machine', '使用本机配置', '切换中…'))
            : null))

      const hubCard = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, key: 'hub' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('b', { style: { fontWeight: 600 } }, '由 DSH Hub 管理员下发'),
          mode === 'hub' ? h('span', { style: badgeStyle(colors.claude) }, '正在使用') : h('span', { style: badgeStyle(colors.sub) }, '只读')),
        h('div', { style: { wordBreak: 'break-all' } },
          `账号：${hub?.label || 'DSH Hub'}${hub?.auth ? ` · ${{ apiKey: 'API Key', authToken: 'Auth Token', oauthToken: '订阅 token' }[hub.auth] || ''}` : ''}${hub?.baseUrl ? ` · ${hub.baseUrl}` : ''}`),
        hub?.defaultModel ? h('div', { style: { wordBreak: 'break-all' } }, `默认模型：${hub.defaultModel}`) : null,
        hub?.models?.length
          ? h('div', { style: { wordBreak: 'break-all' } }, `可用模型（${hub.models.length}）：${hub.models.join('、')}`)
          : h('div', { style: muted }, '还没有拉到可用模型列表'),
        h('div', { style: muted }, mode === 'hub' ? '这里不能修改；需要换账号或换模型请联系管理员。' : '当前没有在用 Hub 下发的配置；你自己的凭据还留着，随时可以切回去。'),
        mode !== 'hub'
          ? h('div', null, h('button', { type: 'button', style: button(true), disabled: !!busy, onClick: () => run('hub', { action: 'use-hub' }, () => { setTab('hub'); setNotice('✓ 已改回使用 Hub 下发的配置（你自己保存的凭据还留着）') }) }, label('hub', '改回 Hub 下发', '切换中…')))
          : null)

      const accountPane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: muted }, '用 Claude 订阅账号登录（在伪终端里跑 claude setup-token）。token 存进 DSH 凭据库，不写进插件文件。'),
        state?.oauthToken?.configured ? h('div', { style: muted }, '插件已保存登录 token（不回显）') : null,
        autoLogin
          ? login
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', null, '① 打开链接，用要使用的 Claude 账号授权：'),
                h('a', { href: login.url, target: '_blank', rel: 'noreferrer', style: { color: colors.claude, wordBreak: 'break-all' } }, '在新标签页打开授权页面'),
                h('div', null, '② 把授权页面上显示的授权码粘贴到这里：'),
                h('input', { style: input, value: code, placeholder: '授权码', onChange: (event) => setCode(event.target.value) }),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', style: button(true), disabled: !!busy || !code.trim(), onClick: () => run('login-code', { action: 'login-code', loginId: login.loginId, code }, () => { setLogin(null); setCode(''); setNotice('✓ 登录成功') }) }, label('login-code', '完成登录', '正在完成…')),
                  h('button', { type: 'button', style: button(false), disabled: !!busy, onClick: () => { setLogin(null); void callSetup({ action: 'login-cancel' }).catch(() => {}) } }, '取消')))
            : h('div', null, h('button', { type: 'button', style: button(true), disabled: !!busy, onClick: () => run('login-start', { action: 'login-start' }, (data) => { if (data?.url) setLogin(data) }) }, label('login-start', state?.oauthToken?.configured ? '重新登录' : '开始登录', '正在准备…')))
          : h('div', { style: muted }, '这台机器不支持自动登录：请在终端运行 claude setup-token，把得到的 token 粘贴到下面。'),
        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: colors.sub, fontSize: 12 } }, '手动粘贴 setup-token'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('input', { style: input, type: 'password', value: manualToken, placeholder: 'claude setup-token 输出的整串 token', autoComplete: 'off', onChange: (event) => setManualToken(event.target.value) }),
            h('button', { type: 'button', style: button(false), disabled: !!busy || !manualToken.trim(), onClick: () => run('token', { action: 'save-oauth-token', token: manualToken }, () => { setManualToken(''); setNotice('✓ 已保存登录 token') }) }, label('token', '保存', '保存中…')))))

      const apiPane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: muted }, '接中转站或官方 API：Base URL 留空 = 官方接口；API Key 留空 = 只改 Base URL / 请求头，不换 key。'),
        state?.apiKey?.configured ? h('div', { style: muted }, '插件已保存 API Key（不回显）') : null,
        h('label', { style: field }, h('span', { style: fieldLabel }, 'Base URL'),
          h('input', { style: input, value: baseUrl, placeholder: 'https://api.anthropic.com（留空 = 官方）', onChange: (event) => setBaseUrl(event.target.value) })),
        h('label', { style: field }, h('span', { style: fieldLabel }, 'API Key'),
          h('input', { style: input, type: 'password', value: apiKey, autoComplete: 'off', placeholder: state?.apiKey?.configured ? '已保存（留空则不改）' : 'sk-ant-…', onChange: (event) => setApiKey(event.target.value) })),
        h('div', { style: { display: 'flex', gap: 16, alignItems: 'center', color: colors.sub, fontSize: 12, flexWrap: 'wrap' } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h('input', { type: 'radio', checked: keyHeader === 'x-api-key', onChange: () => setKeyHeader('x-api-key') }), 'x-api-key（官方）'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h('input', { type: 'radio', checked: keyHeader === 'bearer', onChange: () => setKeyHeader('bearer') }), 'Bearer（部分中转站）')),
        h('div', null, h('button', { type: 'button', style: button(true), disabled: !!busy, onClick: () => run('key', { action: 'save-api-key', apiKey, baseUrl, keyHeader }, () => { setApiKey(''); setNotice('✓ 已保存，正在使用第三方 API') }) }, label('key', '保存并使用', '保存中…'))))

      const clearRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        confirmClear
          ? [h('span', { key: 'ask', style: muted }, hubAvailable ? '清除插件保存的 API Key / 登录 token，并回到 Hub 下发？' : '清除插件保存的 API Key / 登录 token，并回到本机配置？'),
              h('button', { key: 'yes', type: 'button', style: { ...button(true), background: '#d4380d' }, disabled: !!busy, onClick: async () => { await run('clear', { action: 'clear' }, () => setNotice(hubAvailable ? '已清除插件保存的凭据，回到 Hub 下发' : '已清除插件保存的凭据，回到本机配置')); setConfirmClear(false) } }, label('clear', '确认清除', '清除中…')),
              h('button', { key: 'no', type: 'button', style: button(false), disabled: !!busy, onClick: () => setConfirmClear(false) }, '取消')]
          : h('button', { type: 'button', style: { ...button(false), color: '#d4380d' }, disabled: !!busy, onClick: () => setConfirmClear(true) }, '清除插件保存的凭据'))

      // 「Hub 下发」只在有 Hub 配置时出现；没有时 tab 不会停在 hub
      const tabs = [...(hubAvailable ? [['hub', 'Hub 下发']] : []), ['account', '账号登录'], ['api', '第三方 API']]
      const activeTab = tab === 'hub' && !hubAvailable ? 'account' : tab
      const hubHint = hubAvailable && activeTab !== 'hub'
        ? h('div', { style: { ...muted, color: colors.claude } }, mode === 'hub'
            ? '当前在用 Hub 下发的配置；在这里保存或登录成功后就会改用自己的配置。'
            : '当前用的是你自己的配置；「Hub 下发」页签可以随时改回。')
        : null
      const hubWarn = hubAvailable && activeTab !== 'hub'
        ? h('div', { style: muted }, '改用自己的配置后，用量不走 Hub 计费，模型列表也不再由 Hub 提供。')
        : null

      const tabCard = h('div', { style: card, key: 'tabs' },
        h('div', { style: tabRow }, ...tabs.map(([id, text]) => h('button', { key: id, type: 'button', style: tabButton(activeTab === id), onClick: () => setTab(id) }, text))),
        hubHint,
        hubWarn,
        activeTab === 'hub'
          ? h(React.Fragment, null, h('div', { style: divider }), hubCard)
          : h(React.Fragment, null, activeTab === 'account' ? accountPane : apiPane, h('div', { style: divider }), clearRow))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, color: colors.text, fontSize: 13, lineHeight: '20px', paddingBottom: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, h('span', { style: { color: colors.claude, marginRight: 6 } }, '✻'), 'Claude Code'),
          h('button', { type: 'button', style: linkButton, disabled: !!busy, onClick: () => run('state', { action: 'state' }) }, label('state', '重新检测', '检测中…'))),
        statusCard,
        noticeLine,
        tabCard)
    }

    /** 输入框上方：Claude Code 会话且还没登录时，放一行不可点的短提示（登录配置在 设置 → Claude Code）。 */
    function ClaudeDock(props) {
      const state = usePilot()
      const sessionId = props?.session?.sessionId ?? props?.session?.id ?? props?.sessionId
      const isPilot = sessionId !== undefined && state.ids.has(sessionId)
      // 两种提示：没登录（红色起点的「未就绪」）与 Windows 上没有 Git Bash（提示一次，见 host 的 setupHint）
      const showBanner = isPilot && (state.setupReady === false || Boolean(state.setupHint))
      // 停靠槽在一个 flex 列里，子元素会被拉满整栏；提示条按输入框卡片的宽度居中，和它对齐
      const bannerRef = useRef(null)
      const [cardWidth, setCardWidth] = useState(712)
      useEffect(() => {
        if (!showBanner) return undefined
        const composer = bannerRef.current?.closest?.('[class*="composerStack"]')?.querySelector?.('[class*="_card"]')
        if (!composer || typeof ResizeObserver !== 'function') return undefined
        const sync = () => {
          const width = Math.round(composer.getBoundingClientRect().width)
          if (width > 0) setCardWidth(width)
        }
        sync()
        const observer = new ResizeObserver(sync)
        observer.observe(composer)
        return () => observer.disconnect()
      }, [showBanner])
      if (!showBanner) return null
      const text = state.setupReady === false
        ? state.setupNote || 'Claude Code 未登录 · 去「设置 → Claude Code」配置'
        : state.setupHint
      return h('div', {
        ref: bannerRef,
        style: { display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'center', width: '100%', maxWidth: cardWidth, boxSizing: 'border-box', padding: '4px 12px', borderRadius: 12, background: colors.soft, color: colors.text, fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden' },
      },
      h('span', { style: { color: colors.claude } }, '✻'),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, text))
    }

    /* ---- ③ 运行状态：DSH 的「深度求索中」→ Claude Code 的动作词 + 星形动画 ---- */

    const STYLE_ID = 'claude-pilot-running-style'
    const installStyle = () => {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      // Claude Code 的 spinner 帧：· ✢ ✳ ✶ ✻ ✽ 来回
      style.textContent = `
[data-pilot-running] [class*="runningIcon"] > * { display: none !important; }
[data-pilot-running] [class*="runningIcon"]::before {
  content: '✻'; display: inline-flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; color: #D97757; font-size: 15px; line-height: 1;
  animation: claude-pilot-spin 1.6s steps(1, end) infinite;
}
[data-pilot-running] [class*="runningText"] { color: #D97757; }
@keyframes claude-pilot-spin {
  0% { content: '·'; } 10% { content: '✢'; } 20% { content: '✳'; } 30% { content: '✶'; } 40% { content: '✻'; }
  50% { content: '✽'; } 60% { content: '✻'; } 70% { content: '✶'; } 80% { content: '✳'; } 90% { content: '✢'; }
}`
      document.head.appendChild(style)
    }

    /** 从 DSH 原文里取出耗时（"深度求索中，用时 6秒 ···" / "Deep diving for 6s ···"）。 */
    const durationOf = (text) => {
      const match = /用时\s*(.+?)\s*·/.exec(text) || /for\s+(.+?)\s*·/.exec(text)
      return match ? match[1] : ''
    }
    const verbs = new WeakMap()
    const rewriteRunning = () => {
      for (const running of document.querySelectorAll('[data-chat-running]')) {
        const sessionId = running.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
        if (!sessionId || !pilot.ids.has(sessionId)) {
          if (running.hasAttribute('data-pilot-running')) running.removeAttribute('data-pilot-running')
          continue
        }
        if (!running.hasAttribute('data-pilot-running')) running.setAttribute('data-pilot-running', '')
        let verb = verbs.get(running)
        if (!verb) {
          verb = pickVerb()
          verbs.set(running, verb)
        }
        // 正文和扫光层各有一份文字（后者在 data-shimmer-text 属性里）。
        // 改的是 React 自己那个文本节点的 nodeValue（不能换节点，否则 React 之后更新的是脱离页面的旧节点）；
        // React 每秒写回原文（耗时变了）→ 观察器触发 → 这里再改成动作词 + 新耗时。
        const textNodes = running.querySelectorAll('[class*="runningText"] [class*="_text_"]')
        const main = [...textNodes].find((node) => !node.hasAttribute('data-shimmer-text'))
        const textNode = main?.firstChild
        if (!main || !textNode || textNode.nodeType !== 3) continue
        const current = textNode.nodeValue || ''
        if (current !== main.dataset.pilotLabel) main.dataset.pilotNative = current
        const duration = durationOf(main.dataset.pilotNative || '')
        const label = `${verb}…${duration ? ` (${duration})` : ''}`
        main.dataset.pilotLabel = label
        if (current !== label) textNode.nodeValue = label
        for (const node of textNodes) {
          if (node.hasAttribute('data-shimmer-text') && node.getAttribute('data-shimmer-text') !== label) node.setAttribute('data-shimmer-text', label)
        }
        const status = running.querySelector('[role="status"]')?.firstChild
        if (status?.nodeType === 3 && status.nodeValue !== `${verb}…`) status.nodeValue = `${verb}…`
      }
    }

    // ⚠ 前端插件激活时只要抛错，DSH 整个网页都起不来（web boot: entry did not activate）。
    // 所以每一块都单独兜住：出错只让那一块失效。
    const guarded = (label, fn) => {
      try {
        fn()
      } catch (error) {
        console.warn(`[claude-pilot] ${label} 启用失败（不影响其他功能）：`, error)
      }
    }

    return {
      apply(ctx) {
        guarded('强制刷新', forceReloadOnce)
        guarded('右侧栏自动打开任务', () => applySidebar(ctx))
        guarded('侧栏小人', () => applyMascot(ctx))
        guarded('运行状态动作词', () => applyRunning(ctx))
        guarded('未登录提示', () => applySetupDock(ctx))
        guarded('设置页分区', () => applySettingsSection(ctx))
        guarded('用量条', () => applyUsagePill(ctx))
      },
    }

    function applySidebar(ctx) {
        // ① 右侧栏自动打开任务 + 拉取 Claude Code 会话列表（sidebarRight 可能晚于 apply 就绪：用 inject 等它）
        ctx.inject(['sidebarRight'], (scope) => scope.effect(() => {
          let alive = true
          // 时间基准用 host 的时钟（浏览器可能在另一台机器上）：首次请求后取 host 的 now 往前 30 秒
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
                console.warn('[claude-pilot] 右侧栏打开任务失败：', error)
              }
            }
          }
          const poll = async () => {
            try {
              const response = await fetch(`claude-pilot?since=${since ?? 0}`, { headers: { accept: 'application/json' } })
              const data = await response.json()
              if (!alive || !data?.ok) return
              if (since === null) since = (Number(data.now) || 0) - 30000
              publishPilot(data.pilotSessions)
              publishReady(data.setupReady, data.setupNote || null)
              publishHint(data.setupHint || null)
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
        }, 'claude-pilot: 右侧栏自动打开派出的任务'))
    }

    function applyMascot(ctx) {
      // ② 侧栏会话行前的 Claude 小人（slots 服务要动态注入，不能直接读 ctx.slots）
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'sidebar.session.row.leading',
              { name: 'sidebar.session.row.leading', id: 'claude-pilot-mascot', order: 1, label: () => 'Claude Code', locale: NS },
              ClaudeSessionMark,
              '侧栏小人图标',
            ),
          'claude-pilot: sidebar session mark',
        ),
      )
    }

    function applyUsagePill(ctx) {
      // 和 DSH 的「轮/步」(order 0)、「tok · 缓存命中」(order 1) 同一个槽，排在它们右边
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'conversation.composer.dock',
              { name: 'conversation.composer.dock', id: 'claude-pilot-usage', order: 2, label: () => 'Claude 用量', locale: NS },
              ClaudeUsagePill,
              '用量条',
            ),
          'claude-pilot: usage pill',
        ),
      )
    }

    function applySetupDock(ctx) {
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              // 0.2.1 的输入框停靠槽（0.2.0 叫 conversation.composer.dock，已不存在）；props = { session, input }
              'conversation.input.dock',
              { name: 'conversation.input.dock', id: 'claude-pilot-notice', order: 5, label: () => 'Claude Code 未登录提示', locale: NS },
              ClaudeDock,
              '未登录提示',
            ),
          'claude-pilot: setup notice',
        ),
      )
    }

    function applySettingsSection(ctx) {
      // 设置 → Claude Code：登录 / 配置都在这里（对话里不再有登录入口）
      ctx.inject(['slots'], (scope) =>
        scope.effect(
          () =>
            registerSlot(
              scope,
              'settings.section',
              { name: 'settings.section', id: 'claude-pilot', order: 40, label: () => 'Claude Code', locale: NS },
              () => h(PanelBoundary, null, h(ClaudeSettingsSection)),
              '设置分区「Claude Code」',
            ),
          'claude-pilot: settings section',
        ),
      )
    }

    function applyRunning(ctx) {
        // ③ 运行状态文字：DOM 一变就改写（MutationObserver 回调在绘制前执行，不会闪）
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
        }, 'claude-pilot: Claude Code 运行状态')
    }
  },
})
