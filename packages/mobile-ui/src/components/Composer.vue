<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppDialog from './AppDialog.vue'
import AppIcon from './AppIcon.vue'
import AttachmentTray from './AttachmentTray.vue'
import CockpitAttachMenu from './CockpitAttachMenu.vue'
import CockpitEffortSegment from './CockpitEffortSegment.vue'
import CockpitModelMenu from './CockpitModelMenu.vue'
import VoiceHoldOverlay from './VoiceHoldOverlay.vue'
import type { LocalAttachment } from '@/stores/chat'
import { VOICE_TEXT, VoiceInput } from '@/lib/voice-input'
import type { VoiceEngine, VoiceNotice, VoicePhase } from '@/lib/voice-input'
import {
  createSpeechBridge,
  ensureMicPermission,
  loadSpeechAvailability,
  openSpeechSettings,
} from '@/lib/speech-native'
import { gateway } from '@/lib/instance'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useCockpitStore } from '@/stores/cockpit'
import { useSettingsStore } from '@/stores/settings'
import { isBrowserRuntime, pickedFromFiles } from '@/lib/media'
import {
  focusKeepKeyboardClosed,
  hapticStrong,
  hapticTap,
  onAppStateChange,
} from '@/lib/platform'

/**
 * 输入卡。芯片按 Codex 风格拆成**两段各自可点**：
 *   模型段（短名，如 `DeepSeek Flash`）→ 打开模型选择弹层（顶部含后端切换）；
 *   强度段（英文短名，如 `High` / `Max`）→ 打开横向拖动条弹层。
 * 后端没上报 `models` 能力时模型段为空，芯片退回旧样式「思考程度 高」，绝不报错。
 * S0 的「演示」提示已删除。
 *
 * 控制台主题（WP58 / docs/26 §3.2，`html.cockpit-console` 下才走）把这一行换成桌面控件：
 *   回形针（小菜单 / 拖文件进来）→ 模型（**锚定在按钮上方的下拉**）→ 思考分段「低|中|高|超高」；
 *   麦克风隐藏（按住说话是手机交互）、占位文字带快捷键说明。其余主题（含 bridge、APK）一字不改。
 *
 * 0.4.2：麦克风是**按住说话**，引擎由 `bootstrap.voice` 与设置页决定：
 *  - 服务端（推荐）：App 自己录音（lib/voice-recorder.ts），松手后上传到 Hub 识别；
 *  - 手机系统：0.4.1 的 `SpeechRecognizer`，作为兜底。
 * 手势与识别会话的状态机在 `lib/voice-input.ts`；这里只负责把 pointer 事件喂给它、
 * 画浮层、弹「不可用 / 没权限 / 服务器识别暂时不可用」的说明，并把识别出来的文字交给
 * 上层（`voiceText`）拼进输入框。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 强度中文档位（旧样式与无障碍文案用）：低 / 中等 / 高 / 超高。 */
    effortLabel: string
    /** 模型短名；空串 = 后端没有 models 能力，芯片退回旧样式。 */
    modelName?: string
    /** 强度英文短名：Low / Medium / High / Max。 */
    effortShort?: string
    streaming?: boolean
    placeholder?: string
    disabled?: boolean
    /** 待发送附件（发送后由 store 清空）。 */
    attachments?: LocalAttachment[]
  }>(),
  {
    placeholder: '给 DSH Hub 发消息…',
    streaming: false,
    disabled: false,
    attachments: () => [],
    modelName: '',
    effortShort: '—',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
  model: []
  effort: []
  plus: []
  /** 语音识别完的一段文字（上层用 appendTranscript 追加到输入框）。 */
  voiceText: [text: string]
  /** 需要轻提示的一句话（不可用弹窗走组件内部的对话框，不发这个事件）。 */
  voiceNotice: [text: string]
  removeAttachment: [localId: string]
  retryAttachment: [localId: string]
}>()

const area = ref<HTMLTextAreaElement>()
const textFilled = ref(false)
/** 只有文字或只有附件都能发（图片可以不带文字直接发）。 */
const canSend = computed(() => textFilled.value || props.attachments.length > 0)

/* ---------- 控制台主题（WP58 / docs/26 §3.2） ---------- */

const cockpit = useCockpitStore()
const chatStore = useChatStore()
/** `theme=console` 才换成桌面控件（APK / 手机网页版 / bridge 都是 false）。 */
const consoleMode = computed(() => cockpit.consoleTheme)
/** 控制台占位文字：带快捷键说明（Enter 发送只对实体键盘生效，见 enterSends）。 */
const CONSOLE_PLACEHOLDER = '给 AI 助手发消息…（Enter 发送，Shift+Enter 换行）'
const placeholderText = computed(() =>
  consoleMode.value ? CONSOLE_PLACEHOLDER : props.placeholder,
)
/** 模型下拉是否打开（锚定在按钮上方，不是底部抽屉）。 */
const modelMenuOpen = ref(false)
/** 没有 models 能力时按钮显示「默认模型」且不可点（文档 §3.2）。 */
const modelLabel = computed(() => props.modelName || '默认模型')
function toggleModelMenu(): void {
  if (!props.modelName) return
  modelMenuOpen.value = !modelMenuOpen.value
}

/** 拖文件进输入卡（控制台主题）：图片自动压缩、其余按文件走，和回形针/「+」同一个附件链。 */
const dropActive = ref(false)

function onDragOver(event: DragEvent): void {
  if (!consoleMode.value) return
  if (!event.dataTransfer) return
  event.preventDefault()
  dropActive.value = true
}

function onDragLeave(): void {
  dropActive.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  if (!consoleMode.value) return
  event.preventDefault()
  dropActive.value = false
  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return
  const picked = await pickedFromFiles(files, 'file')
  for (const item of picked) {
    const ok = chatStore.addAttachment(item)
    if (!ok && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  }
}

function autosize(): void {
  const el = area.value
  if (!el) return
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, 132)
  el.style.height = `${next}px`
}

watch(
  () => props.modelValue,
  async () => {
    textFilled.value = props.modelValue.trim().length > 0
    await nextTick()
    autosize()
  },
  { immediate: true },
)

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement
  emit('update:modelValue', el.value)
  autosize()
}

function submit(): void {
  if (!canSend.value || props.disabled) return
  emit('send')
}

/**
 * 有实体键盘的设备（鼠标/触控板 = pointer: fine，电脑浏览器、座舱中控台）：Enter 发送、Shift+Enter 换行。
 * 手机触屏键盘照旧 Enter 换行（发送靠按钮）。中文输入法选词时的 Enter（isComposing / keyCode 229）不算发送。
 */
const enterSends =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: fine)').matches
    : false

function onKeydown(event: KeyboardEvent): void {
  if (!enterSends || event.key !== 'Enter') return
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

const inputId = 'composer-input'

/* ---------- 按住说话（0.4.2） ---------- */

const auth = useAuthStore()
const settings = useSettingsStore()

const voicePhase = ref<VoicePhase>('idle')
const voiceText = ref('')
const voiceLevel = ref(0)
const voiceCancelling = ref(false)
const voiceEngine = ref<VoiceEngine | null>(null)
const voiceCountdown = ref<number | null>(null)
const voiceOpen = computed(
  () => voicePhase.value === 'recording' || voicePhase.value === 'finalizing',
)
const voiceFinalizing = computed(() => voicePhase.value === 'finalizing')

/** 居中弹窗：系统没有识别服务 / 麦克风权限被拒。 */
interface VoiceDialogState {
  title: string
  text: string
  tips: string[]
  settings: boolean
}
const voiceDialog = ref<VoiceDialogState | null>(null)

function unavailableDialog(text?: string): VoiceDialogState {
  // 网页版（WP54 / W3）：没有系统识别服务与系统设置，「去系统设置里启用」这类建议全都不适用
  const web = isBrowserRuntime()
  return {
    title: '语音输入不可用',
    text: text && text.trim().length > 0 ? text : VOICE_TEXT.unavailable,
    tips: web
      ? [
          '网页版用浏览器麦克风录音、由 Hub 做识别，所以必须通过 https 打开（http 下浏览器不给麦克风）。',
          'Hub 的服务器识别没开启时也会这样（可以让管理员在 Hub 上开启语音识别）。',
        ]
      : [
          'Hub 的服务器识别没有开启（可以让管理员在 Hub 上开启语音识别）。',
          '在系统设置里启用语音输入服务（设置 → 系统 → 语言和输入法 → 语音输入）。',
          '或在应用商店安装 / 启用系统语音识别服务（例如「Google 语音服务」、厂商自带的语音助手）。',
          '部分机型需要先下载中文离线语音包，装好后回到这里再按住麦克风。',
        ],
    settings: false,
  }
}

/** 服务器识别挂了、手机系统识别也不可用：只能说明情况（不是权限问题）。 */
function serverUnavailableDialog(text: string): VoiceDialogState {
  return {
    title: '服务器识别暂时不可用',
    text,
    tips: [
      '这段录音已经发出去了，但 Hub 那边的识别服务没响应（或当前网络连不上 Hub）。',
      '稍等一会儿再按住麦克风重试；如果一直失败，可以让管理员检查 Hub 的语音识别服务。',
      '这台手机也没有可用的系统语音识别，所以暂时没有别的引擎可以顶上。',
    ],
    settings: false,
  }
}

function permissionDialog(text: string): VoiceDialogState {
  // 网页版（WP54 / W3）：权限在**浏览器**里管，没有「去设置」（系统设置页）可跳
  if (isBrowserRuntime()) {
    return {
      title: '需要麦克风权限',
      text: VOICE_TEXT.webPermission,
      tips: [
        '点地址栏左侧的图标（锁 / 网站设置），把「麦克风」改成「允许」，再重新载入页面。',
        'iPhone / iPad：地址栏「ᴀA」→ 网站设置 → 麦克风；或在系统「设置 → Safari 浏览器」里检查。',
        '微信等内置浏览器可能不给麦克风：请点右上角「在浏览器中打开」，或直接用系统浏览器访问。',
      ],
      settings: false,
    }
  }
  return {
    title: '需要麦克风权限',
    text: text || VOICE_TEXT.permission,
    tips: ['在系统设置 → 应用 → DSH Hub → 权限里允许「麦克风」，再回到 App 按住说话。'],
    settings: true,
  }
}

function handleVoiceNotice(notice: VoiceNotice): void {
  if (notice.dialog) {
    if (notice.kind === 'permission') voiceDialog.value = permissionDialog(notice.text)
    else if (notice.kind === 'server') voiceDialog.value = serverUnavailableDialog(notice.text)
    else voiceDialog.value = unavailableDialog(notice.text)
    return
  }
  emit('voiceNotice', notice.text)
}

function closeVoiceDialog(): void {
  voiceDialog.value = null
}

async function openVoiceSettings(): Promise<void> {
  voiceDialog.value = null
  const ok = await openSpeechSettings()
  if (!ok) emit('voiceNotice', '打不开系统设置，请手动打开「设置 → 应用 → DSH Hub → 权限」')
}

const speechBridge = createSpeechBridge()

const voice = new VoiceInput({
  bridge: speechBridge,
  checkAvailability: loadSpeechAvailability,
  // 每次按住时现算：bootstrap 可能晚到，设置页也可能刚改过引擎
  engine: () => ({
    preference: settings.voiceEngine,
    serverEnabled: auth.voice?.asr === true,
  }),
  transcribe: (wav, lang) => gateway.transcribe(wav, lang),
  // 单段上限来自 Hub 的 bootstrap.voice.maxSeconds（老 Hub 用默认 60）
  maxSeconds: () => auth.voice?.maxSeconds ?? 60,
  // Android WebView 的 getUserMedia 之外，再经原生插件显式申请一次 RECORD_AUDIO
  ensureMicPermission: () => ensureMicPermission(speechBridge),
  haptic: (kind) => {
    void (kind === 'start' ? hapticStrong() : hapticTap())
  },
  onSnapshot: (snapshot) => {
    voicePhase.value = snapshot.phase
    voiceText.value = snapshot.text
    voiceLevel.value = snapshot.level
    voiceCancelling.value = snapshot.cancelling
    voiceEngine.value = snapshot.engine
    voiceCountdown.value = snapshot.countdown
  },
  onNotice: handleVoiceNotice,
  onText: (text) => {
    emit('voiceText', text)
    // 文字由上层拼进 v-model，等这一帧渲染完再把光标放回输入框（微信式：不顶键盘）
    void nextTick(() => focusKeepKeyboardClosed(area.value ?? null))
  },
})

// 换引擎偏好 / bootstrap 里服务端识别恢复：清掉「上次服务器失败」的标记
watch(
  () => settings.voiceEngine,
  () => voice.resetServerFailure(),
)
watch(
  () => auth.voice?.asr,
  () => voice.resetServerFailure(),
)

/** 正在按着的那根手指（多点触控时只认第一根）。 */
let activePointer: number | null = null

function onMicDown(event: PointerEvent): void {
  if (props.disabled) return
  event.preventDefault()
  // 已经有一根手指在按着就忽略第二根；但如果上一次的 pointerup 被系统吞了
  // （来电/手势被接管），而语音状态已经回到 idle，这里要能重新接上。
  if (activePointer !== null && voice.active) return
  activePointer = event.pointerId
  const target = event.currentTarget as HTMLElement | null
  try {
    target?.setPointerCapture(event.pointerId)
  } catch {
    /* 老 WebView 不支持捕获：松手在按钮外也能收到 pointerup（document 兜底由浏览器给） */
  }
  void voice.pointerDown(event.clientX, event.clientY)
}

function onMicMove(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  event.preventDefault()
  voice.pointerMove(event.clientY)
}

function onMicUp(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  activePointer = null
  const target = event.currentTarget as HTMLElement | null
  try {
    target?.releasePointerCapture(event.pointerId)
  } catch {
    /* ignore */
  }
  void voice.pointerUp()
}

function onMicCancel(event: PointerEvent): void {
  if (activePointer !== null && event.pointerId !== activePointer) return
  activePointer = null
  // 系统打断（来电 / 手势被系统接管）：静默取消，不插字
  voice.cancel()
}

let removeAppState: (() => void) | null = null
let disposed = false

onMounted(() => {
  // 进页面先查一次可用性：按住时就不用等检查（也顺便写一条诊断事件）
  void voice.prepare()
  void onAppStateChange((isActive) => {
    if (!isActive) voice.cancel()
  }).then((remove) => {
    if (disposed) remove()
    else removeAppState = remove
  })
})

onBeforeUnmount(() => {
  disposed = true
  removeAppState?.()
  removeAppState = null
  voice.destroy()
})
</script>

<template>
  <div class="composer">
    <VoiceHoldOverlay
      :open="voiceOpen"
      :cancelling="voiceCancelling"
      :finalizing="voiceFinalizing"
      :text="voiceText"
      :level="voiceLevel"
      :engine="voiceEngine"
      :countdown="voiceCountdown"
    />

    <div
      class="composer__card"
      :class="{ 'is-drop-active': dropActive }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <textarea
        :id="inputId"
        ref="area"
        class="composer__input"
        :value="modelValue"
        :placeholder="placeholderText"
        rows="1"
        autocomplete="off"
        autocapitalize="sentences"
        :spellcheck="false"
        :disabled="disabled"
        :enterkeyhint="enterSends ? 'send' : 'enter'"
        @input="onInput"
        @keydown="onKeydown"
      />
      <AttachmentTray
        :items="attachments"
        @remove="emit('removeAttachment', $event)"
        @retry="emit('retryAttachment', $event)"
      />
      <div class="composer__row" :class="{ 'composer__row--console': consoleMode }">
        <div class="composer__row-left">
          <!-- 控制台主题（WP58）：回形针 → 模型下拉 → 思考分段 -->
          <template v-if="consoleMode">
            <CockpitAttachMenu />
            <div class="composer__model">
              <button
                class="console-model"
                :class="{ 'is-disabled': !modelName }"
                type="button"
                data-testid="console-model-btn"
                :disabled="!modelName"
                :aria-label="modelName ? `选择模型，当前 ${modelName}` : '默认模型（后端没有上报模型列表）'"
                :aria-expanded="modelMenuOpen"
                :aria-haspopup="modelName ? 'listbox' : undefined"
                @click="toggleModelMenu"
              >
                <span class="console-model__name">{{ modelLabel }}</span>
                <AppIcon name="chevronDown" :size="12" />
              </button>
              <CockpitModelMenu :open="modelMenuOpen" @close="modelMenuOpen = false" />
            </div>
            <CockpitEffortSegment v-if="modelName" />
          </template>
          <template v-else>
            <button class="circle-btn" type="button" aria-label="更多" @click="emit('plus')">
              <AppIcon name="plus" :size="18" />
            </button>
            <div v-if="modelName" class="chip" role="group" aria-label="模型与思考程度">
              <button
                class="chip__part chip__part--model"
                type="button"
                :aria-label="`选择模型，当前 ${modelName}`"
                @click="emit('model')"
              >
                <span class="chip__model-text">{{ modelName }}</span>
              </button>
              <span class="chip__sep" aria-hidden="true" />
              <button
                class="chip__part chip__part--effort chip__effort"
                type="button"
                :aria-label="`调整思考程度，当前 ${effortLabel}`"
                @click="emit('effort')"
              >
                <span class="chip__effort-text">{{ effortShort }}</span>
              </button>
            </div>
            <button
              v-else
              class="chip chip--legacy"
              type="button"
              aria-label="选择后端与模型"
              @click="emit('model')"
            >
              <span class="chip__effort">思考程度 {{ effortLabel }}</span>
              <AppIcon class="chip__caret" name="chevronDown" :size="14" />
            </button>
          </template>
        </div>
        <div class="composer__row-right">
          <!-- 按住说话是手机交互：控制台主题下整个按钮不渲染 -->
          <button
            v-if="!consoleMode"
            class="icon-btn icon-btn--ghost composer__mic"
            :class="{ 'is-voice-on': voiceOpen }"
            type="button"
            aria-label="按住说话"
            :aria-pressed="voiceOpen ? 'true' : 'false'"
            @pointerdown="onMicDown"
            @pointermove="onMicMove"
            @pointerup="onMicUp"
            @pointercancel="onMicCancel"
            @contextmenu.prevent
          >
            <AppIcon name="mic" :size="20" />
          </button>
          <button
            v-if="streaming"
            class="send-btn send-btn--stop"
            type="button"
            aria-label="停止生成"
            @click="emit('stop')"
          >
            <AppIcon name="square" :size="14" />
          </button>
          <button
            v-else
            class="send-btn"
            type="button"
            aria-label="发送"
            :disabled="!canSend || disabled"
            @click="submit"
          >
            <AppIcon name="up" :size="18" />
          </button>
        </div>
      </div>
    </div>

    <AppDialog
      :open="voiceDialog !== null"
      :label="voiceDialog?.title ?? '语音输入'"
      :dismissible="false"
      @close="closeVoiceDialog"
    >
      <template v-if="voiceDialog">
        <p class="voice-dialog__title">{{ voiceDialog.title }}</p>
        <p class="voice-dialog__text">{{ voiceDialog.text }}</p>
        <ul v-if="voiceDialog.tips.length > 0" class="voice-dialog__tips">
          <li v-for="tip in voiceDialog.tips" :key="tip">{{ tip }}</li>
        </ul>
        <div class="voice-dialog__actions">
          <button
            class="voice-dialog__btn voice-dialog__btn--ghost"
            type="button"
            @click="closeVoiceDialog"
          >
            知道了
          </button>
          <button
            v-if="voiceDialog.settings"
            class="voice-dialog__btn"
            type="button"
            @click="openVoiceSettings"
          >
            去设置
          </button>
        </div>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.composer__mic {
  /* 按住期间手指不能在页面上滑动/选中文字 */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.composer__mic.is-voice-on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

/* ---------- 控制台主题（WP58）：桌面控件 ---------- */

/* 模型按钮：显示短名 + ▾，点开锚定在它上方的下拉（CockpitModelMenu） */
.composer__model {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
}
.console-model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  height: 30px;
  padding: 0 8px 0 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #ffffff;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.console-model:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--border-strong);
}
.console-model.is-disabled,
.console-model[disabled] {
  color: var(--text-3);
  cursor: default;
}
.console-model .icon {
  color: var(--text-3);
}
.console-model__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 拖文件进输入卡：整张卡片描边高亮（控制台主题才用得上） */
.composer__card.is-drop-active {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.15) !important;
}

.voice-dialog__title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.voice-dialog__text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-2);
}
.voice-dialog__tips {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.voice-dialog__tips li + li {
  margin-top: 4px;
}
.voice-dialog__actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.voice-dialog__btn {
  flex: 1;
  height: 42px;
  border-radius: 12px;
  font-size: 14.5px;
  font-weight: 600;
  background: var(--btn);
  color: var(--btn-ink);
  transition: opacity 0.14s ease;
}
.voice-dialog__btn--ghost {
  background: var(--surface-2);
  color: var(--text-2);
}
.voice-dialog__btn:active {
  opacity: 0.82;
}
</style>
