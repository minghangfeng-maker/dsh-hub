// NOTE（维护者）：这个文件就是插件网页端的源码，不经过任何构建 —— 它就是
// `window.__ModuleLoader__.load({ id, factory })` 这一层壳里的工厂函数。
// 改完用 `node --check client.js` 自检。
//
// 这一半只做一件事：在「设置」里加一页 Linear（填 API key、看连接状态与工具列表）。
// 页面自己用同源 fetch 打 POST _dsh/linear-mcp/action（Host 半在 impl.js 里实现），
// 不 import 任何 harness 的 Client 包 —— 样式只用主题 token，控件自己写。
window.__ModuleLoader__.load({
  id: '@local/dsh-linear-mcp',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    /** 同源路由：相对 document.baseURI 解析，反向代理挂载在子路径下也对。 */
    const ACTION_URL = new URL('_dsh/linear-mcp/action', document.baseURI).href
    /** 状态轮询间隔。 */
    const POLL_MS = 3000
    /** 文案命名空间。 */
    const NS = 'dsh-linear-mcp'

    const CSS = `
.lm-page { display: flex; flex-direction: column; gap: 20px; max-width: 46rem; }
.lm-head h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lm-head p { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.lm-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.lm-card > h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lm-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.lm-status { display: flex; align-items: flex-start; gap: 10px; }
.lm-dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.lm-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary); }
.lm-dot[data-state="warn"] { background: var(--dsw-alias-state-warn-primary); }
.lm-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
.lm-status-text { font-size: 13px; color: var(--dsw-alias-label-primary); }
.lm-status-sub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.lm-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lm-input { flex: 1 1 16rem; min-width: 10rem; height: 30px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; }
.lm-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.lm-input::placeholder { color: var(--dsw-alias-label-secondary); }
.lm-btn { height: 30px; padding: 0 12px; border-radius: 8px; font-size: 13px; font-family: inherit;
  cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-primary); white-space: nowrap; }
.lm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.lm-btn[data-variant="primary"] { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.lm-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); }
.lm-btn:disabled { opacity: .55; cursor: default; }
.lm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.lm-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 10px 12px;
  font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); background: transparent; }
.lm-badge { display: inline-block; padding: 1px 6px; border-radius: 6px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.lm-tools { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.lm-tools li { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px;
  padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.lm-link { color: var(--dsw-alias-brand-primary); font-size: 12.5px; word-break: break-all; }
.lm-loading { font-size: 13px; color: var(--dsw-alias-label-secondary); }
`

    /** 中文文案。 */
    const ZH = {
      title: 'Linear',
      description: '通过 Linear 官方 MCP server（mcp.linear.app）访问你的 issue、project 和 comment。填一个 Linear API key 即可（key 存在 DSH 凭据库里）；配好以后模型就能直接调用 mcp__linear__* 工具。',
      loading: '正在读取状态…',
      statusOk: '已连接：Linear 工具已挂到当前会话',
      statusNoCredential: '未配置凭据',
      statusMountedNoTools: '已配置凭据，但还没连上 Linear',
      statusEndpoint: '端点',
      statusTools: '{count} 个工具',
      statusSourceKey: '来源：API key（{ref}）',
      keyTitle: 'API key',
      keyHint: '打开 Linear 的 Settings，搜索 “Personal API keys”，创建 key。',
      keyPlaceholder: 'lin_api_…',
      keySave: '保存',
      keySaving: '保存中…',
      keyClear: '清除',
      keyClearing: '清除中…',
      keyEmpty: '先填入 API key',
      keyConfigured: '已配置（来自{source}）',
      keySourceEnv: '环境变量',
      keySourceStore: '凭据库',
      connectionTitle: '连接与工具',
      testButton: '测试连接',
      testing: '测试中…',
      reloadButton: '重新连接',
      reloading: '重连中…',
      probeOk: '连接正常（MCP {version}），服务端提供 {count} 个工具',
      probeTools: '服务端工具',
      localTools: '已注册到本会话的工具',
      toolsEmpty: '还没有工具：先配置凭据，或点「测试连接」看具体原因。',
      readonlyOn: '只读端点',
      readonlyHint: '当前使用只读端点 /mcp/readonly：只有读取类工具。要改成可写，把插件 config 里的 readonly 改成 false（登录令牌按端点签发，改完需要重新登录）。',
    }

    /** English copy (same key set as ZH). */
    const EN = {
      title: 'Linear',
      description: "Use Linear's official MCP server (mcp.linear.app) for issues, projects and comments. Paste a Linear API key (stored in the DSH credential store) and the model calls mcp__linear__* tools directly.",
      loading: 'Reading status…',
      statusOk: 'Connected: Linear tools are available in this session',
      statusNoCredential: 'No credential configured',
      statusMountedNoTools: 'Credential saved, but Linear is not connected yet',
      statusEndpoint: 'Endpoint',
      statusTools: '{count} tools',
      statusSourceKey: 'Source: API key ({ref})',
      keyTitle: 'API key',
      keyHint: 'Open Linear Settings, search for “Personal API keys”, and create a key.',
      keyPlaceholder: 'lin_api_…',
      keySave: 'Save',
      keySaving: 'Saving…',
      keyClear: 'Clear',
      keyClearing: 'Clearing…',
      keyEmpty: 'Enter an API key first',
      keyConfigured: 'Configured (from {source})',
      keySourceEnv: 'environment',
      keySourceStore: 'credential store',
      connectionTitle: 'Connection and tools',
      testButton: 'Test connection',
      testing: 'Testing…',
      reloadButton: 'Reconnect',
      reloading: 'Reconnecting…',
      probeOk: 'Connection OK (MCP {version}), the server offers {count} tools',
      probeTools: 'Server tools',
      localTools: 'Tools registered in this session',
      toolsEmpty: 'No tools yet: configure a credential, or run “Test connection” to see why.',
      readonlyOn: 'Read-only endpoint',
      readonlyHint: 'The read-only endpoint /mcp/readonly is in use, so only read tools exist. Set readonly to false in the plugin config for write access (tokens are issued per endpoint, so sign in again afterwards).',
    }

    /** `{name}` 占位替换。 */
    function fill(template, values) {
      if (!values) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /** 调一次 Host 动作；失败抛带 Host 文案的 Error。 */
    async function api(action, payload) {
      const response = await fetch(ACTION_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload ?? {}) }),
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`)
      }
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      }
      return body.value
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'linear-mcp: dictionaries')

        /** 设置页：连接状态 + API key + 工具列表。 */
        function LinearSettings() {
          const [snapshot, setSnapshot] = useState(null)
          const [error, setError] = useState('')
          const [busy, setBusy] = useState('')
          const [apiKey, setApiKey] = useState('')
          const [, setLocaleTick] = useState(0)

          // 语言切换后重画一次（nav 的 label 是 thunk，shell 会自己重取）。
          useEffect(() => ctx.locale.subscribe(() => setLocaleTick((tick) => tick + 1)), [])

          const refresh = useCallback(async () => {
            try {
              setSnapshot(await api('state'))
              setError('')
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            }
          }, [])

          useEffect(() => {
            void refresh()
          }, [refresh])

          useEffect(() => {
            const timer = setInterval(() => { void refresh() }, POLL_MS)
            return () => clearInterval(timer)
          }, [refresh])

          const run = useCallback(async (name, payload, after) => {
            setBusy(name)
            setError('')
            try {
              const value = await api(name, payload)
              setSnapshot(value)
              if (after) after(value)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            } finally {
              setBusy('')
            }
          }, [])

          if (snapshot === null) {
            return h('div', { className: 'lm-page' }, h('style', null, CSS), h('p', { className: 'lm-loading' }, error || t('loading')))
          }

          const credential = snapshot.credential ?? {}
          const mcp = snapshot.mcp ?? {}
          const probe = snapshot.lastProbe
          const tools = Array.isArray(mcp.tools) ? mcp.tools : []
          const serverTools = probe?.ok && Array.isArray(probe.tools) ? probe.tools.map((tool) => tool.name) : []
          const failed = Boolean(mcp.error) || Boolean(probe && probe.ok === false)
          const state = mcp.connected ? 'ok' : credential.configured ? 'warn' : failed ? 'error' : 'idle'
          const statusText = mcp.connected
            ? t('statusOk')
            : credential.configured
              ? t('statusMountedNoTools')
              : t('statusNoCredential')

          const statusLines = []
          if (credential.source === 'api-key') statusLines.push(fill(t('statusSourceKey'), { ref: credential.refName ?? snapshot.credentialRef }))
          statusLines.push(`${t('statusEndpoint')}: ${snapshot.endpoint}`)
          if (snapshot.readonly) statusLines.push(t('readonlyOn'))
          if (mcp.error) statusLines.push(mcp.error)
          if (probe && probe.ok === false && probe.error?.message) statusLines.push(probe.error.message)

          const button = (label, onClick, options = {}) => h('button', {
            type: 'button',
            className: 'lm-btn',
            'data-variant': options.variant,
            disabled: busy !== '' || options.disabled === true,
            onClick,
          }, label)

          const sections = []

          // —— 状态 ——
          sections.push(h('div', { className: 'lm-card', key: 'status' },
            h('div', { className: 'lm-status' },
              h('span', { className: 'lm-dot', 'data-state': state }),
              h('div', null,
                h('div', { className: 'lm-status-text' }, statusText,
                  mcp.connected ? h('span', { className: 'lm-badge', style: { marginLeft: 8 } }, fill(t('statusTools'), { count: tools.length })) : null),
                ...statusLines.map((line, index) => h('div', { className: 'lm-status-sub', key: index }, line)),
              ),
            ),
          ))

          // —— API key ——
          const keyRow = []
          if (credential.source === 'api-key') {
            // refSource 由凭据服务给出：环境变量（env）还是凭据库（file/store）。
            const where = credential.refSource === 'env' ? t('keySourceEnv') : t('keySourceStore')
            keyRow.push(h('p', { className: 'lm-hint', key: 'configured' },
              fill(t('keyConfigured'), { source: where }),
              credential.refWritable === false ? '（只读来源，无法从这里覆盖）' : ''))
          }
          keyRow.push(h('div', { className: 'lm-row', key: 'input' },
            h('input', {
              className: 'lm-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('keyPlaceholder'),
              value: apiKey,
              disabled: busy !== '',
              onChange: (event) => setApiKey(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && apiKey.trim() !== '') void run('saveKey', { apiKey }, () => setApiKey('')) },
            }),
            button(busy === 'saveKey' ? t('keySaving') : t('keySave'), () => {
              if (apiKey.trim() === '') { setError(t('keyEmpty')); return }
              void run('saveKey', { apiKey }, () => setApiKey(''))
            }, { variant: 'primary' }),
            credential.source === 'api-key'
              ? button(busy === 'clearKey' ? t('keyClearing') : t('keyClear'), () => void run('clearKey'), { variant: 'danger' })
              : null,
          ))
          sections.push(h('div', { className: 'lm-card', key: 'key' },
            h('h3', null, t('keyTitle')),
            h('p', { className: 'lm-hint' }, t('keyHint')),
            ...keyRow,
          ))

          // —— 连接与工具 ——
          const connectionRows = []
          if (snapshot.readonly) connectionRows.push(h('p', { className: 'lm-hint', key: 'ro' }, t('readonlyHint')))
          if (probe?.ok) {
            connectionRows.push(h('p', { className: 'lm-hint', key: 'probe' },
              fill(t('probeOk'), { version: probe.protocolVersion ?? '?', count: serverTools.length })))
          }
          const listTools = (label, list, key) => h('div', { key },
            h('p', { className: 'lm-hint' }, label),
            list.length === 0
              ? h('p', { className: 'lm-hint' }, t('toolsEmpty'))
              : h('ul', { className: 'lm-tools' }, list.map((name) => h('li', { key: name }, name))),
          )
          if (tools.length > 0) connectionRows.push(listTools(t('localTools'), tools, 'local'))
          else if (serverTools.length > 0) connectionRows.push(listTools(t('probeTools'), serverTools, 'server'))
          else connectionRows.push(h('p', { className: 'lm-hint', key: 'empty' }, t('toolsEmpty')))
          connectionRows.push(h('div', { className: 'lm-row', key: 'actions' },
            button(busy === 'test' ? t('testing') : t('testButton'), () => void run('test')),
            button(busy === 'reload' ? t('reloading') : t('reloadButton'), () => void run('reload')),
          ))
          sections.push(h('div', { className: 'lm-card', key: 'connection' }, h('h3', null, t('connectionTitle')), ...connectionRows))

          return h('div', { className: 'lm-page' },
            h('style', null, CSS),
            h('div', { className: 'lm-head' },
              h('h2', null, t('title')),
              h('p', null, t('description')),
            ),
            error ? h('div', { className: 'lm-error' }, error) : null,
            ...sections,
          )
        }

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'linear-mcp',
          order: 46,
          label: () => t('title'),
          locale: NS,
        }, LinearSettings)), 'linear-mcp: settings page')
      },
    }
  },
})
