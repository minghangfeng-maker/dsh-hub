<script setup lang="ts">
/**
 * 连接诊断面板（0.4.0 §1.3）：从旧 `ConversationInfoSheet` 的折叠区块拆出来，占满全屏。
 *
 * 三段：链路状态（连接 / 重连次数）+ 事件总数 + 最近事件列表（时间、事件名、摘要），
 * 底部「复制诊断信息」把纯文本报告放进剪贴板（**不含对话正文与地址**，见 lib/diagnostics）。
 *
 * 事件来自 `readDiagEvents()`（localStorage 里跨重启保留的最近 40 条），
 * 打开面板时读一次快照——诊断看的是「这次启动前后发生了什么」，不需要实时刷新。
 *
 * 手机网页版（WP54）：多写三件事，排查「网页版怎么和 App 不一样」时第一眼就要看到它们：
 * 平台是 `web`、浏览器 UA、以及是不是「添加到主屏幕」后全屏运行（standalone）。
 */
import { computed, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import { APP_PACKAGE, APP_VERSION, APP_VERSION_CODE, BUILD_INFO, IS_WEB_BUILD } from '@/lib/app-info'
import { platformName } from '@/lib/platform'
import { copyText } from '@/lib/clipboard'
import { isStandaloneDisplay, webVersionText } from '@/lib/web-ui'
import {
  diagLinkText,
  formatDiagReport,
  formatDiagTime,
  readDiagEvents,
} from '@/lib/diagnostics'
import type { DiagEvent } from '@/lib/diagnostics'

const chat = useChatStore()
const ui = useUiStore()

/** 面板打开时的快照（新→旧）。 */
const events = ref<DiagEvent[]>([])
/** 列表只画最近这么多条：40 条会把「复制诊断信息」推到好几屏之外；复制仍然拿全部。 */
const VISIBLE_LIMIT = 12
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const platform = platformName()
/**
 * 网页版的运行形态：浏览器 UA + 是否 standalone。
 * APK 构建里恒为 null（这段永远不渲染），界面与 0.4.11 完全一致。
 */
const web = IS_WEB_BUILD
  ? {
      ua: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      standalone: isStandaloneDisplay(),
    }
  : null
/** 版本：网页版是「手机网页版 0.4.11」，APK 是 `0.4.11 (51)`。 */
const versionText = IS_WEB_BUILD ? webVersionText(APP_VERSION, BUILD_INFO.build) : `${APP_VERSION} (${APP_VERSION_CODE})`
const linkText = computed(() => diagLinkText(chat.link, chat.reconnectAttempt))
const linkState = computed<'ok' | 'busy' | 'bad'>(() => {
  if (chat.link === 'connected') return 'ok'
  if (chat.link === 'failed' || chat.link === 'closed') return 'bad'
  return 'busy'
})
const total = computed(() => events.value.length)
const visible = computed(() => events.value.slice(0, VISIBLE_LIMIT))
const truncated = computed(() => total.value > VISIBLE_LIMIT)

function load(): void {
  events.value = [...readDiagEvents()].reverse()
}

async function copyReport(): Promise<void> {
  const text = formatDiagReport([...events.value].reverse(), {
    appVersion: APP_VERSION,
    link: chat.link,
    reconnectAttempt: chat.reconnectAttempt,
    // 设置页不再显示运行环境/包名（0.4.5）：挪到诊断里，复制时一并带走
    environment: web
      ? `${platform}（${web.standalone ? 'standalone' : '浏览器标签页'}）· UA ${web.ua}`
      : `${platformName()} · 包名 ${APP_PACKAGE}`,
  })
  const ok = await copyText(text)
  ui.toast(ok ? '诊断信息已复制' : '复制失败，请重试')
  if (!ok) return
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
    copiedTimer = null
  }, 2000)
}

onMounted(load)
</script>

<template>
  <section class="diag" data-panel="diagnostics">
    <div class="diag__card">
      <p class="diag__card-label">链路状态</p>
      <p class="diag__card-value" :class="`is-${linkState}`" data-key="link">{{ linkText }}</p>
      <p class="diag__card-sub" data-diag-meta>
        事件 {{ total }} 条 · 版本 {{ versionText }} · {{ platform }}
        <template v-if="web">· {{ web.standalone ? 'standalone' : '浏览器标签页' }}</template>
      </p>
      <!-- 网页版：把浏览器 UA 摆出来（排查「同样的操作，网页和 App 表现不同」时第一现场） -->
      <p v-if="web" class="diag__card-ua" data-web-ua>{{ web.ua }}</p>
    </div>

    <p class="diag__group-label">最近事件</p>
    <ul v-if="events.length > 0" class="diag__list">
      <li v-for="(item, index) in visible" :key="`${item.at}-${index}`" class="diag__row">
        <span class="diag__time">{{ formatDiagTime(item.at) }}</span>
        <span class="diag__event">{{ item.name }}</span>
        <span v-if="item.detail" class="diag__detail">{{ item.detail }}</span>
      </li>
    </ul>
    <p v-else class="diag__empty">还没有诊断事件</p>
    <p v-if="truncated" class="diag__more">
      只显示最近 {{ VISIBLE_LIMIT }} 条（共 {{ total }} 条），复制可拿到全部
    </p>

    <button class="diag__copy" type="button" aria-label="复制诊断信息" @click="copyReport">
      <AppIcon :name="copied ? 'check' : 'copy'" :size="17" />
      {{ copied ? '已复制' : '复制诊断信息' }}
    </button>
  </section>
</template>

<style scoped>
.diag {
  padding-top: 6px;
}
.diag__card {
  padding: 16px 16px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.diag__card-label {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.diag__card-value {
  margin: 6px 0 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.diag__card-value.is-ok {
  color: var(--accent-ink);
}
.diag__card-value.is-bad {
  color: var(--danger);
}
.diag__card-sub {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
/* 网页版：浏览器 UA（可能很长，允许换行，字号再小半号） */
.diag__card-ua {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-3);
  word-break: break-word;
}

.diag__group-label {
  margin: 22px 0 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-3);
}
.diag__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.diag__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 0.5px solid var(--border);
  font-size: 12.5px;
  color: var(--text-2);
}
.diag__row:last-child {
  border-bottom: 0;
}
.diag__time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}
.diag__event {
  flex: 0 0 auto;
  font-weight: 500;
  color: var(--text);
}
.diag__detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
.diag__empty {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-3);
}
.diag__more {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

.diag__copy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 46px;
  margin-top: 24px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14.5px;
  font-weight: 600;
  transition: background-color 0.14s ease;
}
.diag__copy:active {
  background: var(--surface-3);
}
</style>
