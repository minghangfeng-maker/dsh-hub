/**
 * 朗读能力的可见性判断（0.4.3 / WP50）：老 Hub / 关掉朗读 / 没音色时怎么显示。
 *
 * 三条规则（任务包 WP50 §5）：
 *  - `bootstrap.voice.tts` 缺失（老 Hub）→ 对话页**不显示**朗读按钮，设置页说明「不可用」；
 *  - `enabled === false`（合成服务当前不可用）→ 同上（不显示按钮）；
 *  - `voices` 为空 → 没有可选音色，同样按不可用处理。
 *
 * 音色选择是「用户偏好 + Hub 下发」的交集：偏好里的音色不在下发列表里（换了 Hub/改名）
 * 就退回 `defaultVoice` / 第一个音色，绝不把不存在的 id 发给服务端（那会是 400）。
 */

import type { BootstrapTts, TtsVoice } from '@dsh-hub/mobile-core'

/** 试听用的固定示例句（设置页「试听」按钮）。 */
export const TTS_PREVIEW_TEXT = '你好呀，我是星汐。'

/** 从 bootstrap.voice 里取朗读能力（老 Hub 返回 null）。 */
export function ttsCapabilityOf(voice: { tts?: BootstrapTts } | null | undefined): BootstrapTts | null {
  return voice?.tts ?? null
}

/** 能不能朗读：服务端开启且至少有一个音色。 */
export function isTtsAvailable(tts: BootstrapTts | null | undefined): boolean {
  return tts?.enabled === true && (tts.voices?.length ?? 0) > 0
}

/** 可选的音色列表（不可用时是空数组）。 */
export function ttsVoiceList(tts: BootstrapTts | null | undefined): TtsVoice[] {
  if (!tts || tts.enabled !== true) return []
  return tts.voices ?? []
}

/** 实际会用哪个音色：用户选的（若仍存在）→ Hub 默认 → 第一个；都没有就是 null。 */
export function resolveTtsVoiceId(
  tts: BootstrapTts | null | undefined,
  preferred?: string | null,
): string | null {
  const voices = ttsVoiceList(tts)
  if (voices.length === 0) return null
  if (preferred && voices.some((voice) => voice.id === preferred)) return preferred
  if (tts?.defaultVoice && voices.some((voice) => voice.id === tts.defaultVoice)) {
    return tts.defaultVoice
  }
  return voices[0]!.id
}

/** 单次合成的字数上限：Hub 没给或给得离谱时退回 200。 */
export function ttsMaxChars(tts: BootstrapTts | null | undefined, fallback = 200): number {
  const value = tts?.maxChars
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/** 音色的一句话介绍：Hub 没给描述时用通用说明。 */
export function ttsVoiceDescription(voice: TtsVoice, tts: BootstrapTts | null = null): string {
  const description = voice.description?.trim()
  if (description) return description
  if (tts?.defaultVoice === voice.id) return '默认音色，适合朗读 AI 的回复'
  return '用这个声音朗读 AI 的回复'
}

/**
 * 设置页「朗读」分组在不可用时的说明（放在分组里当置灰行）。
 * `null` = 可用（不显示说明）。
 */
export function ttsUnavailableHint(tts: BootstrapTts | null | undefined): string | null {
  if (isTtsAvailable(tts)) return null
  if (!tts) return '这个 Hub 还没有开启朗读'
  if (tts.enabled !== true) return '朗读暂时不可用'
  return '暂时没有可用的音色'
}
