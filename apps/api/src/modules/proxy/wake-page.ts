import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { InstanceStatus } from '@dsh-hub/shared'

/**
 * 唤醒页（05 §5.2、02 §7.6）：容器没在跑时给用户的页面。
 *
 * 优先用 hub-web 构建出来的独立入口 `apps/web/dist/wake.html`（WP5a 的占位、WP5b 会做成产品页）；
 * 构建产物不存在（开发/测试）时用本文件里的兜底页。两种情况下都由本模块补一段「启动 + 轮询」脚本，
 * 除非页面自己声明了 `data-hub-wake="own"`（WP5b 自己实现逻辑时）。
 *
 * **代理本身不触发启动**：页面里的按钮/自动逻辑调用 `/api/me/instance/start`（02 §7.6）。
 */
export const WAKE_OWN_MARKER = 'data-hub-wake="own"'

const BUILT_WAKE_PATHS = [
  fileURLToPath(new URL('../../../../web/dist/wake.html', import.meta.url)),
  fileURLToPath(new URL('../../../../../apps/web/dist/wake.html', import.meta.url)),
]

export interface WakePageInput {
  /** 规范地址里的用户名（就绪后跳 `/dsh/<username>/`） */
  username: string
  status: InstanceStatus
  error?: string | null
  /** 构建产物路径（测试可注入；null 表示只用兜底页） */
  builtPath?: string | null
}

export interface WakePageResult {
  html: string
  source: 'built' | 'fallback'
}

let cachedBuilt: { path: string; mtimeMs: number; html: string } | null = null

/** 读构建产物（按 mtime 缓存）；没有就返回 null */
export function readBuiltWakePage(explicitPath?: string | null): { path: string; html: string } | null {
  const candidates =
    explicitPath === undefined ? BUILT_WAKE_PATHS : explicitPath === null ? [] : [explicitPath]
  for (const path of candidates) {
    try {
      const { mtimeMs } = statSync(path)
      if (cachedBuilt && cachedBuilt.path === path && cachedBuilt.mtimeMs === mtimeMs) {
        return { path, html: cachedBuilt.html }
      }
      const html = readFileSync(path, 'utf8')
      cachedBuilt = { path, mtimeMs, html }
      return { path, html }
    } catch {
      // 试下一个候选
    }
  }
  return null
}

/** 生成唤醒页 HTML */
export function renderWakePage(input: WakePageInput): WakePageResult {
  const built = readBuiltWakePage(input.builtPath)
  const base = built ? built.html : fallbackWakeHtml(input)
  if (built && base.includes(WAKE_OWN_MARKER)) return { html: base, source: 'built' }
  return { html: withWakeScript(base, input), source: built ? 'built' : 'fallback' }
}

/** 注入「POST start + 轮询 + ready 自动刷新」的脚本 */
export function withWakeScript(html: string, input: WakePageInput): string {
  const script = `<script>${wakeScript(input)}</script>`
  const index = html.toLowerCase().lastIndexOf('</body>')
  if (index === -1) return html + script
  return `${html.slice(0, index)}${script}${html.slice(index)}`
}

/** 脚本本身（独立导出便于单测断言关键行为） */
export function wakeScript(input: WakePageInput): string {
  const status = JSON.stringify(input.status)
  const error = JSON.stringify(input.error ?? null)
  return `(function(){
  var STATUS = ${status};
  var ERROR = ${error};
  var hint = document.getElementById('hub-wake-hint');
  var bar = document.getElementById('hub-wake-bar');
  function setHint(text, level){
    if (!hint) return;
    hint.textContent = text;
    if (level) hint.setAttribute('data-level', level);
  }
  if (ERROR) setHint('上次启动失败：' + ERROR, 'error');
  else if (STATUS === 'starting') setHint('正在启动你的 DSH…');
  function poll(){
    fetch('/api/me/instance', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null })
      .then(function(data){
        if (!data || !data.instance) return;
        var s = data.instance.status;
        if (s === 'running') {
          if (bar) bar.setAttribute('data-done', '1');
          setHint('已就绪，正在进入…');
          location.replace('/dsh/${input.username}/');
          return;
        }
        if (s === 'error') { setHint('启动失败：' + (data.instance.error || '未知错误'), 'error'); return; }
        setHint(s === 'starting' ? '正在启动你的 DSH…' : '正在唤醒你的 DSH…');
        setTimeout(poll, 2000);
      })
      .catch(function(){ setTimeout(poll, 3000); });
  }
  function start(){
    setHint('正在启动你的 DSH…');
    fetch('/api/me/instance/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(function(){ setTimeout(poll, 800); }).catch(function(){ setTimeout(poll, 1500); });
  }
  var button = document.getElementById('hub-wake-start');
  if (button) button.addEventListener('click', start);
  // 进页面就自动拉起（登录用户点开 /dsh/<username>/ 的预期就是「打开我的 DSH」）
  start();
})();`
}

/** 兜底页：不依赖任何构建产物，样式用设计令牌 + 回退值 */
function fallbackWakeHtml(input: WakePageInput): string {
  const statusText = input.status === 'starting' ? '正在启动…' : '当前未运行'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>正在唤醒你的 DSH… · DSH Hub</title>
<style>
:root{--c-primary:#34c7a0;--c-text:#2c3a35;--c-text-2:#62736d;--c-text-3:#9daea8;--c-bg-grad:linear-gradient(160deg,#f3fbf8 0%,#eef6fe 55%,#fff6f8 100%);--c-surface-glass:rgba(255,255,255,.72);--c-border:#e4f0ec;--radius-card:16px;--space-4:16px;--space-6:24px;--space-8:32px;--shadow-card:0 6px 24px rgba(52,199,160,.08);--font-sans:'HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:var(--space-6) var(--space-4);background:var(--c-bg-grad);color:var(--c-text);font-family:var(--font-sans);font-size:14px;line-height:1.6}
.wake-card{width:100%;max-width:420px;padding:var(--space-8);border:1px solid var(--c-border);border-radius:var(--radius-card);background:var(--c-surface-glass);box-shadow:var(--shadow-card);backdrop-filter:blur(16px);text-align:center}
.wake-title{margin:0;font-size:20px;font-weight:600}
.wake-desc{margin:var(--space-4) 0 0;color:var(--c-text-2)}
.wake-hint{margin:var(--space-4) 0 0;color:var(--c-text-3);font-size:12px}
.wake-hint[data-level='error']{color:#f27a7a}
.wake-bar{height:4px;margin:var(--space-6) auto 0;width:120px;border-radius:999px;background:var(--c-border);overflow:hidden}
.wake-bar::after{content:'';display:block;height:100%;width:40%;border-radius:999px;background:var(--c-primary);animation:wake-slide 1.4s ease-in-out infinite}
.wake-bar[data-done='1']::after{width:100%;animation:none}
@keyframes wake-slide{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){.wake-bar::after{animation:none;width:100%}}
.wake-button{margin-top:var(--space-4);padding:8px 18px;border:1px solid var(--c-border);border-radius:999px;background:var(--c-surface-glass);color:var(--c-text-2);font:inherit;cursor:pointer}
</style>
</head>
<body>
<main class="wake-card">
  <h1 class="wake-title">正在唤醒你的 DSH…</h1>
  <p class="wake-desc">实例${statusText}，就绪后会自动进入。</p>
  <div class="wake-bar" id="hub-wake-bar"></div>
  <p class="wake-hint" id="hub-wake-hint">正在启动你的 DSH…</p>
  <button class="wake-button" id="hub-wake-start" type="button">重新唤醒</button>
</main>
</body>
</html>`
}

export interface AdminWakePageInput {
  /** 被查看的用户名（就绪后跳 `/dsh/<username>/`） */
  username: string
  /** 被查看用户的 id：启动与轮询都走 `/api/admin/...`，不能用「我的实例」接口 */
  userId: number
  status: InstanceStatus
  error?: string | null
}

/**
 * 管理员打开**别人**的实例、而它没在跑时的页面。和用户自己的唤醒页不同：
 * 不自动启动（避免点一下「打开」就替别人拉起容器），按钮调 `POST /api/admin/instances/:id/start`
 * （管理员代启动 = 免费租约，13 §4），轮询 `GET /api/admin/users/:id` 看状态。
 * 自包含（不依赖构建产物）；所有来自状态/错误的文本都经 `textContent` 写入。
 */
export function renderAdminWakePage(input: AdminWakePageInput): WakePageResult {
  const config = JSON.stringify({
    username: input.username,
    userId: input.userId,
    status: input.status,
    error: input.error ?? null,
  }).replaceAll('<', '\\u003c')
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>实例未运行 · DSH Hub</title>
<style>
:root{--c-primary:#34c7a0;--c-text:#2c3a35;--c-text-2:#62736d;--c-text-3:#9daea8;--c-bg-grad:linear-gradient(160deg,#f3fbf8 0%,#eef6fe 55%,#fff6f8 100%);--c-surface-glass:rgba(255,255,255,.72);--c-border:#e4f0ec;--radius-card:16px;--space-4:16px;--space-6:24px;--space-8:32px;--shadow-card:0 6px 24px rgba(52,199,160,.08);--font-sans:'HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:var(--space-6) var(--space-4);background:var(--c-bg-grad);color:var(--c-text);font-family:var(--font-sans);font-size:14px;line-height:1.6}
.card{width:100%;max-width:440px;padding:var(--space-8);border:1px solid var(--c-border);border-radius:var(--radius-card);background:var(--c-surface-glass);box-shadow:var(--shadow-card);text-align:center}
h1{margin:0;font-size:20px;font-weight:600}
p{margin:var(--space-4) 0 0;color:var(--c-text-2)}
.hint{color:var(--c-text-3);font-size:12px}
.hint[data-level='error']{color:#f27a7a}
.actions{display:flex;justify-content:center;gap:12px;margin-top:var(--space-6)}
button,a.link{padding:8px 18px;border:1px solid var(--c-border);border-radius:999px;background:var(--c-surface-glass);color:var(--c-text-2);font:inherit;text-decoration:none;cursor:pointer}
button.primary{border-color:var(--c-primary);background:var(--c-primary);color:#fff}
button[disabled]{opacity:.6;cursor:default}
</style>
</head>
<body>
<main class="card">
  <h1 id="title"></h1>
  <p>你正以管理员身份查看别人的实例。启动由管理员代为发起（不计费），这次进入会记入审计。</p>
  <p class="hint" id="hint"></p>
  <div class="actions">
    <button class="primary" id="start" type="button">启动并进入</button>
    <a class="link" href="/admin/instances">回实例列表</a>
  </div>
</main>
<script>
(function(){
  var C = ${config};
  var title = document.getElementById('title');
  var hint = document.getElementById('hint');
  var button = document.getElementById('start');
  var polling = false;
  function setHint(text, level){ hint.textContent = text; if (level) hint.setAttribute('data-level', level); else hint.removeAttribute('data-level'); }
  function setTitle(starting){ title.textContent = C.username + (starting ? ' 的 DSH 正在启动…' : ' 的 DSH 当前未运行'); }
  function poll(){
    polling = true;
    fetch('/api/admin/users/' + C.userId, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null })
      .then(function(data){
        var instance = data && data.user && data.user.instance;
        if (!instance) { setTimeout(poll, 3000); return; }
        if (instance.status === 'running') { setHint('已就绪，正在进入…'); location.replace('/dsh/' + C.username + '/'); return; }
        if (instance.status === 'error') { polling = false; button.disabled = false; setTitle(false); setHint('启动失败：' + (instance.error || '未知错误'), 'error'); return; }
        setTitle(instance.status === 'starting'); setHint('正在启动…');
        setTimeout(poll, 2000);
      })
      .catch(function(){ setTimeout(poll, 3000); });
  }
  function start(){
    button.disabled = true;
    setTitle(true); setHint('正在启动…');
    fetch('/api/admin/instances/' + C.userId + '/start', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(function(r){
      if (r.ok) { if (!polling) poll(); return; }
      return r.json().catch(function(){ return null }).then(function(body){
        button.disabled = false; setTitle(false);
        setHint('启动失败：' + ((body && body.error && body.error.message) || ('HTTP ' + r.status)), 'error');
      });
    }).catch(function(){ button.disabled = false; setHint('连接不上服务器，请稍后再试。', 'error'); });
  }
  button.addEventListener('click', start);
  setTitle(C.status === 'starting');
  if (C.error) setHint('上次启动失败：' + C.error, 'error');
  if (C.status === 'starting') { button.disabled = true; setHint('正在启动…'); poll(); }
})();
</script>
</body>
</html>`
  return { html, source: 'fallback' }
}
