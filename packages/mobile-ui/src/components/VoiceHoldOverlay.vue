<script setup lang="ts">
/**
 * 按住说话的浮层（0.4.2）：出现在输入卡正上方，微信式。
 *
 * 三段：音量波形（`level` 驱动的 9 根竖条）· 中间文字 · 底部提示。
 *  - 手机系统引擎：中间是实时识别文字（partial），与 0.4.1 一样；
 *  - 服务端引擎（0.4.2）：中间固定「正在听…」/「正在识别…」（服务端不出实时文字），
 *    录音最后 10 秒右上角出现倒计时。
 *
 * 纯展示组件：状态由 `VoiceInput` 状态机（lib/voice-input.ts）推过来。
 */
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 浮层是否显示（只在录音 / 等最终结果时显示）。 */
    open: boolean
    /** 手指已经上滑到取消区。 */
    cancelling?: boolean
    /** 已松手，正在等系统给最终结果。 */
    finalizing?: boolean
    /** 已经识别出来的文字。 */
    text?: string
    /** 0–1 的音量。 */
    level?: number
    /** 本次用的引擎：服务端 = 没有实时文字、有倒计时。 */
    engine?: 'server' | 'native' | null
    /** 服务端引擎的倒计时（剩 10…1 秒；没有 = 不显示）。 */
    countdown?: number | null
  }>(),
  {
    cancelling: false,
    finalizing: false,
    text: '',
    level: 0,
    engine: null,
    countdown: null,
  },
)

const BAR_COUNT = 9
/** 中间高两边低：看起来像一段声波，而不是一排等高条。 */
const BAR_FACTORS = [0.5, 0.72, 0.9, 1, 0.82, 1, 0.9, 0.72, 0.5]
const EMPTY_BARS = (): number[] => Array.from({ length: BAR_COUNT }, () => 0)

const levels = ref<number[]>(EMPTY_BARS())

watch(
  () => props.open,
  (open) => {
    if (open) levels.value = EMPTY_BARS()
  },
)

watch(
  () => props.level,
  (level) => {
    if (!props.open) return
    // 新音量从右侧进来，旧值往左推：波形会「流动」起来
    levels.value = [...levels.value.slice(1), Math.min(1, Math.max(0, level))]
  },
)

const bars = computed(() =>
  levels.value.map((level, index) => {
    const factor = BAR_FACTORS[index] ?? 0.7
    const scale = 0.12 + level * factor
    return { transform: `scaleY(${scale.toFixed(3)})` }
  }),
)

const display = computed(() => {
  const text = props.text.trim()
  if (text.length > 0) return text
  return props.finalizing ? '正在识别…' : '正在听…'
})

/** 倒计时只在录音阶段、剩 ≤10 秒时出现。 */
const countdownText = computed(() => {
  const left = props.countdown
  if (props.finalizing || props.cancelling) return ''
  if (typeof left !== 'number' || !Number.isFinite(left) || left <= 0) return ''
  return `${Math.round(left)}″`
})

const hint = computed(() => {
  if (props.finalizing) return '正在识别，马上填入'
  if (props.cancelling) return '松开取消'
  const left = countdownText.value
  if (left.length > 0) return `还剩 ${left} · 松开填入输入框`
  return '松开 填入输入框 · 上滑取消'
})
</script>

<template>
  <Transition name="voice-pop">
    <div
      v-if="open"
      class="voice"
      :class="{ 'is-cancel': cancelling }"
      role="status"
      aria-live="polite"
      data-voice-overlay
      :data-voice-cancel="cancelling ? '1' : '0'"
      :data-voice-engine="engine ?? ''"
      :data-voice-phase="finalizing ? 'finalizing' : 'recording'"
    >
      <div class="voice__wave" aria-hidden="true">
        <span v-for="(style, index) in bars" :key="index" class="voice__bar" :style="style" />
      </div>
      <span
        v-if="countdownText"
        class="voice__count"
        data-voice-countdown
        aria-live="off"
      >{{ countdownText }}</span>
      <p class="voice__text" data-voice-text>{{ display }}</p>
      <p class="voice__hint" data-voice-hint>{{ hint }}</p>
    </div>
  </Transition>
</template>

<style scoped>
.voice {
  position: absolute;
  left: 12px;
  right: 12px;
  /* 贴在输入卡上方（.composer 是定位容器） */
  bottom: calc(100% + 2px);
  z-index: 30;
  padding: 14px 16px 12px;
  border-radius: 22px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-float);
  color: var(--accent);
  /* 手指可能滑到浮层上：别把 touch 抢走 */
  pointer-events: none;
}
.voice.is-cancel {
  color: var(--danger);
  border-color: var(--danger);
}
.voice__wave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 34px;
}
.voice__bar {
  display: block;
  width: 4px;
  height: 30px;
  border-radius: 999px;
  background: currentColor;
  transform-origin: center;
  transition: transform 90ms linear;
}
.voice__count {
  position: absolute;
  top: 10px;
  right: 14px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  opacity: 0.9;
}
.voice__text {
  margin: 8px 0 0;
  min-height: 22px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--text);
  text-align: center;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.voice.is-cancel .voice__text {
  color: var(--danger);
}
.voice__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}
.voice.is-cancel .voice__hint {
  color: var(--danger);
}
.voice-pop-enter-active,
.voice-pop-leave-active {
  transition: opacity 0.16s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.voice-pop-enter-from,
.voice-pop-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}
</style>
