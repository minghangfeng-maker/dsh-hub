<script setup lang="ts">
/**
 * 首页：抽屉、鲸鱼 + 问候语、底部输入卡。
 * 唤醒/连接状态走顶部细状态条；输入不等连接，就绪后由 chat store 自动发送。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import Composer from '@/components/Composer.vue'
import InstallHint from '@/components/InstallHint.vue'
import StatusStrip from '@/components/StatusStrip.vue'
import BrandMark from '@/components/BrandMark.vue'
import { useAuthStore } from '@/stores/auth'
import { useBackendStore } from '@/stores/backend'
import { useChatStore } from '@/stores/chat'
import { useCockpitStore } from '@/stores/cockpit'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { IS_WEB_BUILD } from '@/lib/app-info'
import { hapticTap } from '@/lib/platform'
import { appendTranscript } from '@/lib/voice-input'

const router = useRouter()
const auth = useAuthStore()
const backend = useBackendStore()
const chat = useChatStore()
const models = useModelsStore()
const ui = useUiStore()
const cockpit = useCockpitStore()

const draft = ref('')

/**
 * 控制台主题的空态（WP58 / docs/26 §3.4）：管理台的语气 + 4 个示例。
 * 点示例只是**填进输入框**（不直接发），用户还能改。
 */
const CONSOLE_EXAMPLES = [
  '本周谁的积分消耗最多？',
  '最近 24 小时有哪些失败的任务？',
  '看一下各实例的内存占用',
  '把某个插件下发给所有云端用户',
]

async function fillExample(text: string): Promise<void> {
  draft.value = text
  await nextTick()
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null
  input?.focus()
}

/**
 * 预填输入框（WP56d 的 `cockpit.prefill`：画布「问 DSH」/「追问这一行」）。
 * 首页与对话页各挂一份 watcher：谁在屏幕上谁填，另一边不会抢。
 */
watch(
  () => ui.prefillRequest,
  (request) => {
    if (request === null) return
    draft.value = request.text
    ui.consumePrefill()
  },
)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

/**
 * 顶部细状态条（0.4.1 §2）：文案与语气全部来自 `chat.connectionBanner` ——
 * 未连上不足 4 秒不显示，4–15 秒中性提示，≥15 秒 / 明确原因才警示 + 重试。
 */
const stripText = computed(() => chat.statusText)

/** 只有真的可执行时才给按钮：唤醒失败/容量满 → 重试；连接超时/断开 → 重连。 */
const stripAction = computed(() => chat.statusAction)

/** 其它会话在等我回答（WP46 的 pendingInteractions）：一条细提示，点它就是打开第一个。 */
const pendingAnswerText = computed(() =>
  chat.pendingAnswerCount > 0 ? `有 ${chat.pendingAnswerCount} 个对话在等你回答` : '',
)
function openFirstPendingAnswer(): void {
  const session = chat.firstPendingAnswerSession
  if (!session) return
  void router.push(`/c/${session.sessionId}`)
}

function onStripAction(): void {
  // 唤醒被拦（容量满/开通失败/唤醒超时）→ 重新唤醒；其它都是链路问题 → 重建通道。
  if (chat.statusAction === '重试' && backend.wakeState === 'blocked') {
    void backend.retryWake()
    return
  }
  chat.retryConnection()
}

/** 首页本身就是「新的空白对话」：没有打开的会话时右上角「新对话」置灰。 */
const isBlankNewChat = computed(() => chat.activeId === null)

/** 按住说话识别出的文字：追加到输入框现有内容后面（0.4.1，只改麦克风这块）。 */
function onVoiceText(text: string): void {
  draft.value = appendTranscript(draft.value, text)
}

/** 新对话：清掉（可能从对话页带回来的）当前会话状态，留在首页。 */
function newChat(): void {
  if (isBlankNewChat.value) return
  void hapticTap()
  chat.newSession()
}

function send(): void {
  const text = draft.value.trim()
  if (!text && chat.attachments.length === 0) return
  void hapticTap()
  const id = chat.send(text)
  draft.value = ''
  void router.push(id ? `/c/${id}` : '/c/new')
}
</script>

<template>
  <div class="home-view">
    <!-- 顶栏（0.4.0 §1.1）：☰ 打开抽屉 / 中间空 / 右上「新对话」。
         首页没有「⋮」：没有打开的会话就没有会话菜单。已经是空白新对话时「新对话」置灰。 -->
    <header class="app-header" data-header="home">
      <div class="app-header__side">
        <!-- 嵌入座舱（WP56d）：会话列表收进「航行日志」按钮（docs/24 §1/§6），不再有抽屉 -->
        <button
          v-if="cockpit.embed && !cockpit.sessionsDocked"
          class="cockpit-log-btn"
          type="button"
          data-testid="nav-log-button"
          aria-label="航行日志"
          :aria-expanded="cockpit.logOpen"
          @click="cockpit.toggleLog()"
        >
          <AppIcon name="menu" :size="16" />
          <span>航行日志</span>
          <AppIcon name="chevronDown" :size="12" />
        </button>
        <!-- 嵌入座舱里没有抽屉（docked 时连航行日志都不需要，这里就不渲染任何按钮） -->
        <button
          v-else-if="!cockpit.embed"
          class="icon-btn"
          type="button"
          aria-label="打开抽屉"
          @click="ui.openDrawer()"
        >
          <AppIcon name="menu" :size="24" />
        </button>
      </div>
      <div class="app-header__title" />
      <div class="app-header__side app-header__side--right">
        <button
          class="icon-btn icon-btn--disabled"
          type="button"
          aria-label="新对话"
          :disabled="isBlankNewChat"
          @click="newChat()"
        >
          <AppIcon name="newChat" :size="24" />
        </button>
      </div>
    </header>

    <StatusStrip
      v-if="stripText"
      :text="stripText"
      :tone="chat.statusTone"
      :action-label="stripAction"
      @action="onStripAction"
    />

    <!-- 其它会话在等你回答（WP46 的 pendingInteractions）：点它就是打开第一个。 -->
    <StatusStrip
      v-if="pendingAnswerText"
      :text="pendingAnswerText"
      tone="ready"
      action-label="去回答"
      @action="openFirstPendingAnswer()"
    />

    <!-- 控制台主题的空态（WP58）：标题 + 一行副标题 + 4 个示例按钮（点了填进输入框） -->
    <div v-if="cockpit.consoleTheme" class="console-empty" data-testid="console-empty">
      <h1 class="console-empty__title">有什么要处理的？</h1>
      <p class="console-empty__sub">说清楚要做什么，AI 出方案，你确认后执行</p>
      <div class="console-empty__list">
        <button
          v-for="example in CONSOLE_EXAMPLES"
          :key="example"
          class="console-empty__item"
          type="button"
          data-console-example
          @click="fillExample(example)"
        >
          {{ example }}
        </button>
      </div>
    </div>

    <div v-else class="home">
      <div class="home__hero">
        <BrandMark class="home__logo" :width="76" />
        <div>
          <h1 class="home__greeting">{{ greeting }}</h1>
          <p v-if="backend.wakeState === 'blocked'" class="home__sub">
            {{ auth.issue?.message ?? '助手暂时不可用' }}
          </p>
          <p v-else class="home__sub">今天想聊点什么？</p>
        </div>
      </div>
    </div>

    <!-- 手机网页版（WP54 / W5）：「添加到桌面」引导，就在输入卡上方一行。
         只在 VITE_TARGET=web 构建里存在（APK 里 IS_WEB_BUILD 是构建期常量 false），
         standalone / 桌面浏览器 / 30 天内关过的，组件自己会收起来。 -->
    <InstallHint v-if="IS_WEB_BUILD && !cockpit.embed" />
  </div>

  <Composer
    v-model="draft"
    :effort-label="models.effortText"
    :model-name="models.chipModelShort"
    :effort-short="models.chipEffortShort"
    :attachments="chat.attachments"
    @send="send"
    @model="ui.openModelSheet()"
    @effort="ui.openEffortSheet()"
    @plus="ui.openPlusSheet()"
    @voice-text="onVoiceText"
    @voice-notice="ui.toast"
    @remove-attachment="chat.removeAttachment"
    @retry-attachment="chat.retryAttachment"
  />
</template>

<style scoped>
.home-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- 控制台主题的空态（WP58 / docs/26 §3.4）---------- */
.console-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  padding: 24px 20px 8px;
}
.console-empty__title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.console-empty__sub {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}
.console-empty__list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 560px;
}
.console-empty__item {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #ffffff;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.4;
  text-align: left;
  transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;
}
.console-empty__item:hover {
  border-color: var(--accent);
  color: var(--text);
  background: var(--surface-2);
}
</style>
