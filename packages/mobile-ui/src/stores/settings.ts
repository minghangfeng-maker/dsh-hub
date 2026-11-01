/**
 * 外观设置（A1 只保留主题；服务器地址、默认模型已按 §1.4 从设置页删除）。
 *
 * 主题是纯 UI 偏好，放 localStorage / WebView 本地存储即可，不属于令牌或对话内容。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { isCockpitBridgeTheme, isCockpitConsoleTheme } from '@/lib/cockpit-embed'
import type { VoiceEnginePreference } from '@/lib/voice-input'

export type ThemeMode = 'system' | 'light' | 'dark'
export type { VoiceEnginePreference }

const KEY = 'dsh-hub:ui:v1'

interface Persisted {
  theme?: ThemeMode
  voiceEngine?: VoiceEnginePreference
}

const VOICE_ENGINES: readonly VoiceEnginePreference[] = ['auto', 'server', 'native']

function load(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Persisted
  } catch {
    return {}
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const saved = load()
  const theme = ref<ThemeMode>(saved.theme ?? 'system')
  const voiceEngine = ref<VoiceEnginePreference>(
    VOICE_ENGINES.includes(saved.voiceEngine as VoiceEnginePreference)
      ? (saved.voiceEngine as VoiceEnginePreference)
      : 'auto',
  )

  const media =
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

  const isDark = computed(
    () => theme.value === 'dark' || (theme.value === 'system' && (media?.matches ?? false)),
  )

  function applyTheme(): void {
    if (typeof document === 'undefined') return
    // 舰桥嵌入（WP56d）：父页面传了 theme=bridge → 永远深色、背景交给父页面（透明）。
    // 这里**不能**写 inline background：浅色用户会在深色舰桥里看到一块白底。
    if (isCockpitBridgeTheme()) {
      document.documentElement.dataset.theme = 'dark'
      document.documentElement.style.removeProperty('background')
      return
    }
    // 控制台嵌入（WP58 / docs/26 §3.1）：父页面传了 theme=console → 永远浅色，
    // 忽略系统深色与用户自己的主题设置（管理台的卡片是白的，深色会糊成一块）。
    // 同样不写 inline background：底色透明，透出 Hub 卡片的 --c-surface。
    if (isCockpitConsoleTheme()) {
      document.documentElement.dataset.theme = 'light'
      document.documentElement.style.removeProperty('background')
      return
    }
    document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
    document.documentElement.style.background = isDark.value ? '#17171A' : '#F9F8F6'
  }

  function persist(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ theme: theme.value, voiceEngine: voiceEngine.value }),
      )
    } catch {
      /* ignore */
    }
  }

  function setTheme(mode: ThemeMode): void {
    theme.value = mode
  }

  function setVoiceEngine(mode: VoiceEnginePreference): void {
    voiceEngine.value = mode
  }

  applyTheme()
  media?.addEventListener('change', () => theme.value === 'system' && applyTheme())
  watch(theme, () => {
    applyTheme()
    persist()
  })
  watch(voiceEngine, persist)

  return { theme, isDark, voiceEngine, setTheme, setVoiceEngine }
})
