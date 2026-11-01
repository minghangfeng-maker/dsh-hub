/**
 * 朗读 store（0.4.3 / WP50）：把播放器接到 Pinia 上，并管住「音色 / 自动朗读」两个本地偏好。
 *
 * 分工：
 *  - `lib/tts-player.ts`  纯状态机（合成、预取、缓存、重试、停止），不依赖 Vue；
 *  - `lib/tts-audio.ts`   Web Audio 出口（真机播放）；
 *  - 本 store 只做三件事：**能力可见性**（bootstrap.voice.tts）、**偏好持久化**（按账号）、
 *    **把快照映射成界面状态**（对话页按钮的 loading/playing）。
 *
 * 偏好按账号存 localStorage（`dsh-hub:tts:v1`）：同一台手机换账号登录时，音色与自动朗读
 * 互不影响。音色 id 只是「偏好」——真正用时还要和 Hub 下发的列表求交集（见 resolveTtsVoiceId），
 * 换 Hub / 音色改名不会把不存在的 id 发给服务端。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { BootstrapTts, TtsVoice } from '@dsh-hub/mobile-core'
import { useAuthStore } from './auth'
import { useUiStore } from './ui'
import { gateway } from '@/lib/instance'
import { recordDiag } from '@/lib/diagnostics'
import {
  createTtsSink,
  createTtsStreamSink,
  hasWebAudio,
  type TtsSink,
  type TtsStreamSink,
} from '@/lib/tts-audio'
import {
  TtsClipCache,
  TtsPlayer,
  type TtsController,
  type TtsPhase,
  type TtsSnapshot,
  type TtsStopReason,
} from '@/lib/tts-player'
import { TtsPcmCache, TtsStreamPlayer } from '@/lib/tts-stream-player'
import {
  TTS_PREVIEW_TEXT,
  isTtsAvailable,
  resolveTtsVoiceId,
  ttsMaxChars,
  ttsUnavailableHint,
  ttsVoiceList,
} from '@/lib/tts-availability'

/** 本地偏好（按账号 key 分开）。 */
const PREFS_KEY = 'dsh-hub:tts:v1'
/** 试听用的伪消息 key（不会与对话块 key 相同）。 */
export const TTS_PREVIEW_KEY = '__preview__'

interface TtsPrefs {
  voice?: string
  autoRead?: boolean
}

type PrefsMap = Record<string, TtsPrefs>

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function loadPrefs(): PrefsMap {
  try {
    const raw = storage()?.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PrefsMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      out[key] = {
        ...(typeof record['voice'] === 'string' && record['voice'].length > 0
          ? { voice: record['voice'] }
          : {}),
        ...(typeof record['autoRead'] === 'boolean' ? { autoRead: record['autoRead'] } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

export const useTtsStore = defineStore('tts', () => {
  const auth = useAuthStore()
  const ui = useUiStore()

  const prefs = ref<PrefsMap>(loadPrefs())
  /** 账号 key（未登录时用 anonymous；正常不会在未登录时朗读）。 */
  const accountKey = computed(() => auth.accountKey ?? 'anonymous')
  const saved = computed<TtsPrefs>(() => prefs.value[accountKey.value] ?? {})

  /** 用户选的音色 id（可能已经不在 Hub 的列表里）。 */
  const preferredVoice = computed<string | null>(() => saved.value.voice ?? null)
  const autoRead = computed<boolean>(() => saved.value.autoRead === true)

  /** Hub 下发的朗读能力（老 Hub 是 null）。 */
  const capability = computed<BootstrapTts | null>(() => auth.voice?.tts ?? null)
  const available = computed(() => isTtsAvailable(capability.value))
  const voices = computed<TtsVoice[]>(() => ttsVoiceList(capability.value))
  /** 实际会用的音色（偏好 ∩ 下发列表 → default → 第一个）。 */
  const voiceId = computed(() => resolveTtsVoiceId(capability.value, preferredVoice.value))
  const maxChars = computed(() => ttsMaxChars(capability.value))
  const unavailableHint = computed(() => ttsUnavailableHint(capability.value))
  /**
   * 流式朗读（0.4.6）：Hub 声明 `voice.tts.stream` 且浏览器有 Web Audio 才走流式；
   * 老 Hub / 老 WebView 继续用整段播放器（行为与 0.4.5 一致）。
   */
  const streamCapable = computed(() => capability.value?.stream === true && hasWebAudio())

  // ── 播放器状态（快照映射）────────────────────────────────────────────────
  const phase = ref<TtsPhase>('idle')
  const readingKey = ref<string | null>(null)
  const segment = ref(0)
  const total = ref(0)
  const busy = computed(() => phase.value === 'loading' || phase.value === 'playing')
  const loading = computed(() => phase.value === 'loading')
  const playing = computed(() => phase.value === 'playing')

  /** 段缓存跨播放器实例共享（bootstrap 刷新会重建播放器，缓存不丢）。 */
  const cache = new TtsClipCache()
  const pcmCache = new TtsPcmCache()
  let clipSink: TtsSink | null = null
  let streamSink: TtsStreamSink | null = null
  let player: TtsController | null = null
  /** 当前播放器是不是流式（bootstrap 换了 Hub 形态时重建一次）。 */
  let playerStream = false

  function onSnapshot(snapshot: TtsSnapshot): void {
    phase.value = snapshot.phase
    readingKey.value = snapshot.messageKey
    segment.value = snapshot.segment
    total.value = snapshot.total
  }

  /**
   * 按 Hub 的能力选播放器：流式（0.4.6 新 Hub + Web Audio）或整段（老 Hub 回退）。
   * 两者共用快照/停止语义，界面不用区分。
   */
  function ensurePlayer(): TtsController {
    const stream = streamCapable.value
    if (player && playerStream === stream) return player
    player?.stop('switch')
    playerStream = stream
    player = stream
      ? new TtsStreamPlayer({
          synthesizeStream: (input) => gateway.synthesizeStream(input),
          // 音频出口在第一次「朗读」点击（用户手势）里创建，Android WebView 才不会挂起 AudioContext
          sink: () => (streamSink ??= createTtsStreamSink()),
          maxChars: () => maxChars.value,
          cache: pcmCache,
          onSnapshot,
          onNotice: (text: string) => ui.toast(text),
          onDiag: (name: string, detail?: string) => recordDiag(name, detail ?? ''),
        })
      : new TtsPlayer({
          synthesize: (text, voice) => gateway.synthesize({ text, voice }),
          sink: () => (clipSink ??= createTtsSink()),
          maxChars: () => maxChars.value,
          cache,
          onSnapshot,
          onNotice: (text: string) => ui.toast(text),
          onDiag: (name: string, detail?: string) => recordDiag(name, detail ?? ''),
        })
    return player
  }

  /** 这条消息是不是正在读（按钮显示「停止」）。 */
  function isReading(messageKey: string): boolean {
    return busy.value && readingKey.value === messageKey
  }

  /** 朗读一条回复（内部会先停掉上一条）。 */
  function playMessage(messageKey: string, text: string): void {
    if (!available.value) {
      ui.toast('朗读暂时不可用')
      return
    }
    ensurePlayer().start({ key: messageKey, text, voice: voiceId.value ?? undefined })
  }

  /** 对话页按钮：正在读这条 → 停止；否则开始读。 */
  function toggleMessage(messageKey: string, text: string): void {
    if (isReading(messageKey) || (busy.value && readingKey.value === messageKey)) {
      stop('user')
      return
    }
    playMessage(messageKey, text)
  }

  /** 设置页「试听」：用当前音色读一句固定示例。 */
  function preview(): void {
    if (!available.value) {
      ui.toast('朗读暂时不可用')
      return
    }
    ensurePlayer().start({ key: TTS_PREVIEW_KEY, text: TTS_PREVIEW_TEXT, voice: voiceId.value ?? undefined })
  }

  /** 停止（原因进诊断：user / send / leave / background）。 */
  function stop(reason: TtsStopReason = 'user'): void {
    player?.stop(reason)
  }

  // ── 偏好 ──────────────────────────────────────────────────────────────────

  function persist(): void {
    try {
      storage()?.setItem(PREFS_KEY, JSON.stringify(prefs.value))
    } catch {
      /* 隐私模式/配额满：只在当次生效 */
    }
  }

  function patchSaved(patch: TtsPrefs): void {
    prefs.value = {
      ...prefs.value,
      [accountKey.value]: { ...prefs.value[accountKey.value], ...patch },
    }
    persist()
  }

  /** 选音色（只存本地；不是 Hub 列表里的 id 会在下次播放时自动回落到默认）。 */
  function setVoice(id: string): void {
    patchSaved({ voice: id })
  }

  function setAutoRead(on: boolean): void {
    patchSaved({ autoRead: on })
  }

  function toggleAutoRead(): void {
    setAutoRead(!autoRead.value)
  }

  // 退出登录：立刻停止朗读，别让上一位用户的声音继续播
  watch(
    () => auth.isAuthenticated,
    (ok) => {
      if (!ok) stop('leave')
    },
  )

  return {
    // 能力
    capability,
    available,
    streamCapable,
    voices,
    voiceId,
    preferredVoice,
    maxChars,
    unavailableHint,
    previewText: TTS_PREVIEW_TEXT,
    // 偏好
    autoRead,
    setVoice,
    setAutoRead,
    toggleAutoRead,
    // 播放状态
    phase,
    readingKey,
    segment,
    total,
    busy,
    loading,
    playing,
    // 动作
    isReading,
    playMessage,
    toggleMessage,
    preview,
    stop,
  }
})
