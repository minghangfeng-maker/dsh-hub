<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { DevCockpitSession } from '@/components/admin/cockpit/dev-sessions'
import type { CockpitAppStatus } from '@/utils/assist-phase'
import type { CockpitLayoutPayload } from '@/utils/assist-layout'

/**
 * 中控台的**开发占位面板**（docs/24 §1、任务书 WP56c；WP58 增补加载阶段与会话列表形态）。
 *
 * 真实模式这块是同源 iframe `/m/?embed=cockpit&theme=console`（App 网页版的嵌入模式）；
 * 开发环境没有 `/m/`，于是用一列假对话顶替：
 * - 顶部「航行日志 ▾」= 会话列表（`cockpit.layout.sessions === 'menu'`）；
 * - `docked`（L 档及以上）时会话列表变成对话区里常驻的左栏；
 * - 点会话 / 新会话 → `emit('session')`，父页面用与 iframe 消息同一份逻辑处理；
 * - 画布「问 DSH」预填的文字会落进输入框；
 * - 还会按 `?mock=` 场景演一遍 App 的握手与 `cockpit.status`（见 {@link scriptOf}），
 *   好让启动加载的各个阶段在开发环境能看到（`cockpit-boot` / `cockpit-legacy`）。
 */
const props = withDefaults(
  defineProps<{
    sessions: DevCockpitSession[]
    sessionId: string | null
    /** 画布「问 DSH」/「追问这一行」预填进来的文字 */
    prefill: string
    /** 父页面同步来的布局（docs/26 §5）：决定会话列表是常驻左栏还是下拉 */
    layout?: CockpitLayoutPayload | null
  }>(),
  { layout: null },
)

const emit = defineEmits<{
  session: [id: string | null]
  /** 模拟 App 的 `cockpit.ready`：带 caps = 新 App，`undefined` = 老 App（只能靠 ready 兜底） */
  ready: [caps?: string[]]
  /** 模拟 App 的 `cockpit.status` */
  status: [status: CockpitAppStatus]
}>()

const draft = ref('')
const journalOpen = ref(false)
/** 本地面板里发出去的话（占位对话不连真 DSH，只回显在气泡里） */
const extra = ref<string[]>([])

const docked = computed(() => props.layout?.sessions === 'docked')
const scale = computed(() => props.layout?.scale ?? 1)

watch(
  () => props.prefill,
  (text) => {
    if (text) draft.value = text
  },
  // 面板挂载时可能已经有预填文字（画布上先点了「问 DSH」）
  { immediate: true },
)

function pick(id: string | null): void {
  journalOpen.value = false
  emit('session', id)
}

function send(): void {
  const text = draft.value.trim()
  if (!text) return
  extra.value = [...extra.value, text]
  draft.value = ''
}

const currentTitle = computed(
  () => props.sessions.find((session) => session.id === props.sessionId)?.title ?? '新会话',
)

/**
 * 假 App 的脚本（按 `?mock=` 场景挑一个）：
 * - `quick`（缺省）：很快 ready，日常开发不折腾；
 * - `boot`（`?mock=cockpit-boot`）：ready → waking → auth → connecting → ready，各阶段都停一会儿，
 *   给启动加载的截图用；
 * - `legacy`（`?mock=cockpit-legacy`）：老 App —— 发 `cockpit.ready` 但**不带 caps**，之后不再报进度。
 */

function scriptOf(search: string): 'quick' | 'boot' | 'legacy' {
  const scenario = new URLSearchParams(search).get('mock') ?? ''
  if (scenario === 'cockpit-legacy') return 'legacy'
  if (scenario === 'cockpit-boot') return 'boot'
  return 'quick'
}

const timers: ReturnType<typeof setTimeout>[] = []
const CAPS = ['status', 'layout', 'console']

function at(delayMs: number, run: () => void): void {
  timers.push(setTimeout(run, delayMs))
}

/** 一挂上就按脚本演：先握手（ready），再按阶段报状态 */
function runScript(): void {
  const script = typeof window === 'undefined' ? 'quick' : scriptOf(window.location.search)
  if (script === 'legacy') {
    at(250, () => emit('ready'))
    return
  }
  at(150, () => emit('ready', [...CAPS]))
  if (script === 'quick') {
    at(400, () => emit('status', { phase: 'ready' }))
    return
  }
  // boot：每个阶段停 1–2 秒，截图能抓到
  at(700, () => emit('status', { phase: 'waking', message: '正在唤醒对话服务…' }))
  at(2400, () => emit('status', { phase: 'auth', message: '正在校验交接码…' }))
  at(3000, () => emit('status', { phase: 'connecting', message: '正在连接对话…' }))
  at(4200, () => emit('status', { phase: 'ready' }))
}

onMounted(runScript)

onBeforeUnmount(() => {
  for (const timer of timers) clearTimeout(timer)
  timers.length = 0
})
</script>

<template>
  <div class="ph" data-testid="cockpit-placeholder">
    <header class="ph__bar">
      <button
        v-if="!docked"
        type="button"
        class="ph__journal press"
        :aria-expanded="journalOpen"
        aria-label="航行日志（会话列表）"
        @click="journalOpen = !journalOpen"
      >
        <span class="i-ph-book-open-text" aria-hidden="true" />
        <span class="ph__journal-text">航行日志</span>
        <span class="i-ph-caret-down" aria-hidden="true" />
      </button>
      <span class="ph__current">{{ currentTitle }}</span>
      <button type="button" class="ph__new press" aria-label="新会话" title="新会话" @click="pick(null)">
        <span class="i-ph-plus" aria-hidden="true" />
      </button>
    </header>

    <div v-if="journalOpen && !docked" class="ph__dropdown" role="menu">
      <p class="ph__dropdown-title">航行日志</p>
      <button
        v-for="session in sessions"
        :key="session.id"
        type="button"
        class="ph__dropdown-item"
        :class="{ 'ph__dropdown-item--active': session.id === sessionId }"
        role="menuitem"
        @click="pick(session.id)"
      >
        <span class="ph__dropdown-title-text">{{ session.title }}</span>
        <span class="ph__dropdown-owner">{{ session.owner }}</span>
      </button>
      <p v-if="sessions.length === 0" class="ph__dropdown-empty">还没有会话</p>
    </div>

    <div class="ph__body">
      <!-- 会话常驻左栏（L 档及以上；真实模式由 App 在 iframe 里渲染） -->
      <aside v-if="docked" class="ph__sessions" aria-label="会话列表（常驻）" data-testid="cockpit-ph-sessions">
        <button type="button" class="ph__sessions-new press" @click="pick(null)">
          <span class="i-ph-plus" aria-hidden="true" />
          新会话
        </button>
        <button
          v-for="session in sessions"
          :key="session.id"
          type="button"
          class="ph__session press"
          :class="{ 'ph__session--active': session.id === sessionId }"
          @click="pick(session.id)"
        >
          <span class="ph__session-text">{{ session.title }}</span>
          <span class="ph__session-owner">{{ session.owner }}</span>
          <span class="ph__session-more" title="重命名 / 删除（示意）" aria-hidden="true">⋯</span>
        </button>
      </aside>

      <div class="ph__chat">
        <div class="ph__bubbles">
          <p class="ph__bubble ph__bubble--user">这周谁的积分消耗最多？</p>
          <p class="ph__bubble ph__bubble--dsh">
            本周 <strong>alice</strong> 用得最多（32.14 积分，1203 次请求）。
            <span class="ph__process">⟶ 已投放左舷：本周消耗最多的用户</span>
          </p>
          <p
            v-for="(text, index) in extra"
            :key="`extra-${String(index)}`"
            class="ph__bubble ph__bubble--user"
          >
            {{ text }}
          </p>
        </div>

        <form class="ph__composer" @submit.prevent="send">
          <textarea
            v-model="draft"
            class="ph__input"
            rows="2"
            placeholder="问点什么…"
            aria-label="对话输入（占位）"
          />
          <button type="submit" class="ph__send press" :disabled="draft.trim().length === 0">发送</button>
        </form>
      </div>
    </div>

    <p class="ph__note">
      占位面板 · 开发环境没有 <code>/m/</code> · {{ docked ? '会话常驻' : '会话下拉' }} · scale
      {{ scale }}
    </p>
  </div>
</template>

<style scoped>
.ph {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: inherit;
  /* 外框（描边/辉光）由 CockpitFrame 画，占位面板与真 iframe 一样透明 */
  background: transparent;
}

.ph__bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
}

.ph__journal,
.ph__new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px var(--space-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--fs-12);
  white-space: nowrap;
}

.ph__journal:hover,
.ph__new:hover,
.ph__journal:focus-visible,
.ph__new:focus-visible {
  border-color: var(--b-line-strong, var(--c-primary));
  color: var(--c-primary-press);
}

.ph__new {
  margin-left: auto;
  font-size: 14px;
}

.ph__current {
  min-width: 0;
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph__dropdown {
  position: absolute;
  z-index: 5;
  top: 44px;
  left: var(--space-3);
  display: flex;
  width: 240px;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--b-panel-solid, var(--c-surface));
  box-shadow: var(--shadow-hover);
}

.ph__dropdown-title {
  padding: 2px var(--space-2);
  color: var(--c-text-3);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.ph__dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-control-sm);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  text-align: left;
}

.ph__dropdown-item:hover,
.ph__dropdown-item:focus-visible {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.ph__dropdown-item--active {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.ph__dropdown-title-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph__dropdown-owner {
  color: var(--c-text-3);
  font-size: 11px;
}

.ph__dropdown-empty {
  padding: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

/* ── 会话常驻左栏（L 档及以上） ── */

.ph__body {
  display: flex;
  min-height: 0;
  flex: 1;
  gap: var(--space-3);
}

.ph__sessions {
  display: flex;
  width: 200px;
  flex: none;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding-right: var(--space-2);
  border-right: var(--border-width) solid var(--c-border);
}

.ph__sessions-new {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-1);
  padding: var(--space-2);
  border: 1px dashed var(--c-border);
  border-radius: var(--radius-control-sm);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--fs-12);
}

.ph__sessions-new:hover,
.ph__sessions-new:focus-visible {
  border-color: var(--c-primary);
  color: var(--c-primary-press);
}

.ph__session {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-control-sm);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  text-align: left;
}

.ph__session:hover,
.ph__session:focus-visible {
  background: var(--c-surface-muted);
}

.ph__session--active {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.ph__session-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph__session-owner {
  color: var(--c-text-3);
  font-size: 11px;
}

/* 悬停才出的「⋯」（桌面交互的示意，真实模式由 App 渲染菜单） */
.ph__session-more {
  display: none;
  padding-inline: 2px;
  color: var(--c-text-3);
  font-size: 14px;
}

.ph__session:hover .ph__session-more,
.ph__session:focus-visible .ph__session-more {
  display: inline;
}

.ph__chat {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
}

.ph__bubbles {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding-block: var(--space-1);
}

.ph__bubble {
  max-width: 88%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  font-size: var(--fs-13);
  line-height: var(--lh-base);
  overflow-wrap: anywhere;
}

.ph__bubble--user {
  align-self: flex-end;
  background: var(--c-primary);
  color: var(--b-on-accent, var(--c-surface));
}

.ph__bubble--dsh {
  align-self: flex-start;
  background: var(--c-bg);
  color: var(--c-text);
}

/* 过程行（真实模式由 iframe 里的 App 渲染，这里给个样子） */
.ph__process {
  display: block;
  margin-top: var(--space-1);
  color: var(--c-sky);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.ph__composer {
  display: flex;
  flex: none;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: var(--border-width) solid var(--c-border);
}

.ph__input {
  min-width: 0;
  flex: 1;
  resize: none;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--fs-13);
}

.ph__input:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.ph__send {
  align-self: flex-end;
  padding: var(--space-2) var(--space-4);
  border: 0;
  border-radius: var(--radius-control);
  background: var(--c-primary);
  color: var(--b-on-accent, var(--c-surface));
  cursor: pointer;
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.ph__send:disabled {
  background: var(--c-surface-muted);
  color: var(--c-text-3);
  cursor: not-allowed;
}

.ph__note {
  flex: none;
  color: var(--c-text-3);
  font-size: 11px;
  text-align: center;
}

.ph__note code {
  font-family: var(--font-mono);
  white-space: nowrap;
}
</style>
