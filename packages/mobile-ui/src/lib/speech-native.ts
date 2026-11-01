/**
 * 系统语音识别（0.4.1）的原生接线：本地 Capacitor 插件 `SpeechInput`。
 *
 * 只调用**手机系统自带**的识别服务（`android.speech.SpeechRecognizer`），不连服务端识别：
 * 用户按住麦克风说话，松手后把系统返回的文字填进输入框。Java 实现在
 * `apps/mobile/android/app/src/main/java/tech/dshhub/app/SpeechInputPlugin.java`，
 * 在 `MainActivity#onCreate` 里于 `super.onCreate` **之前** registerPlugin。
 *
 * 这里做三件事：
 *  1. `createSpeechBridge()`：把插件包成一个小接口（Web/壳里没注册插件时返回 null，
 *     **绝不盲调**，否则会抛「not implemented」异常）；
 *  2. `loadSpeechAvailability()`：可用性检查（同一进程只查一次）+ 一条诊断事件；
 *  3. `speechSupportLabel()`：把可用性翻成设置页/弹窗用的中文（可用 / 仅离线 / 不可用）。
 *
 * 可用性语义（与 Java 侧一一对应）：
 *  - `available`：系统里有语音识别服务（`isRecognitionAvailable`）；
 *  - `onDevice`：API 31+ 的离线识别可用（`isOnDeviceRecognitionAvailable`）；
 *  - `reason`：`system` / `on-device-only` / `none` / `error`。
 * Android 11+ 的包可见性很关键：Manifest 里没有
 * `<queries><intent><action android:name="android.speech.RecognitionService" /></intent></queries>`
 * 时 `isRecognitionAvailable` 会永远返回 false，界面就会误报「不可用」。
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { IS_WEB_BUILD } from './app-info'
import { recordDiag } from './diagnostics'

export interface SpeechAvailability {
  /** 系统识别服务是否可用（可走在线/离线由系统决定）。 */
  available: boolean
  /** API 31+ 的端侧（离线）识别是否可用。 */
  onDevice: boolean
  /** 诊断原因：system / on-device-only / none / error。 */
  reason: string
}

export interface SpeechStartOptions {
  language?: string
  partial?: boolean
  preferOffline?: boolean
}

export interface SpeechPartialPayload {
  text?: string
}

export interface SpeechFinalPayload {
  text?: string
}

export interface SpeechLevelPayload {
  rms?: number
}

export interface SpeechErrorPayload {
  /** 稳定的英文错误码（如 `no-speech` / `permission-denied`），见 lib/voice-input 的映射表。 */
  code?: string | number
  /** 原生侧已经翻好的中文说明。 */
  message?: string
  /**
   * 0.4.2 真机排错：系统给的原始错误码（`SpeechRecognizer.ERROR_*` 的数值）。
   * 只进本地诊断，不上报、不显示；识别文字永远不进诊断。
   */
  nativeCode?: number
  /**
   * 0.4.2 真机排错：默认的系统识别服务组件名
   * （Java 侧读 `Settings.Secure.getString(cr, "voice_recognition_service")`）。
   * 国产 ROM 上这一项能直接看出「系统把识别交给了谁」。
   */
  service?: string
}

export interface SpeechPayloadMap {
  partial: SpeechPartialPayload
  final: SpeechFinalPayload
  level: SpeechLevelPayload
  end: Record<string, never>
  error: SpeechErrorPayload
}

export type SpeechEventName = keyof SpeechPayloadMap

export interface SpeechSubscription {
  remove: () => void
}

/**
 * `stop()` 的返回：`listening=false` 表示系统**早就把这一段结束了**（识别器已释放），
 * 不会再有 final —— JS 侧可以立刻收尾，不用白等 2 秒；`true` 表示还在听，等最终结果。
 */
export interface SpeechStopResult {
  listening?: boolean
}

/** 麦克风权限状态（0.4.2：录音前先显式申请，保证首次一定弹系统弹窗）。 */
export interface MicPermissionResult {
  granted: boolean
}

export interface SpeechBridge {
  availability: () => Promise<SpeechAvailability>
  start: (options?: SpeechStartOptions) => Promise<void>
  stop: () => Promise<SpeechStopResult | void>
  cancel: () => Promise<void>
  on: <E extends SpeechEventName>(event: E, handler: (payload: SpeechPayloadMap[E]) => void) => SpeechSubscription
  openSettings: () => Promise<void>
  /** 只查麦克风权限（不弹窗）；旧壳里没有这个方法。 */
  checkMicPermission?: () => Promise<MicPermissionResult>
  /** 申请麦克风权限（会弹系统弹窗）；旧壳里没有这个方法。 */
  requestMicPermission?: () => Promise<MicPermissionResult>
}

/** Java 插件的方法签名（与 SpeechInputPlugin.java 一一对应）。 */
interface SpeechInputPlugin {
  availability(): Promise<SpeechAvailability>
  start(options: SpeechStartOptions): Promise<void>
  stop(): Promise<SpeechStopResult>
  cancel(): Promise<void>
  openSettings(): Promise<void>
  /** 0.4.2：录音（getUserMedia）之前先显式申请 RECORD_AUDIO。 */
  checkMicPermission(): Promise<MicPermissionResult>
  requestMicPermission(): Promise<MicPermissionResult>
  addListener(
    eventName: string,
    listener: (payload: unknown) => void,
  ): Promise<{ remove: () => Promise<void> | void }>
}

const SpeechInput = registerPlugin<SpeechInputPlugin>('SpeechInput')

/** 假语音桥的构建期开关（`VITE_VOICE_DEMO=1`，只给截图/联调用；见 vite.config.ts）。 */
declare const __DSH_VOICE_DEMO_ENABLED__: boolean

/**
 * 截图/联调用的注入点（**只有 `VITE_VOICE_DEMO=1` 的构建里才有**）。
 *
 * 真机之外的浏览器里没有系统识别服务，浮层（音量波形、partial 文本）没法用真实交互演示。
 * 截图脚本在页面加载前塞一个假的 bridge，就能走真实的手势与状态机。正式构建里这个常量
 * 是 false，整段代码被折掉 —— 不能拿 `import.meta.env.DEV` 判断：build-apk.sh 把
 * NODE_ENV 设成 development，正式构建里 DEV 也是 true，假桥会被打进 APK。
 */
function demoBridge(): SpeechBridge | null {
  if (!__DSH_VOICE_DEMO_ENABLED__) return null
  const candidate = (globalThis as { __DSH_VOICE_DEMO__?: unknown }).__DSH_VOICE_DEMO__
  if (!candidate || typeof candidate !== 'object') return null
  const bridge = candidate as Partial<SpeechBridge>
  if (typeof bridge.availability !== 'function' || typeof bridge.start !== 'function') return null
  return bridge as SpeechBridge
}

/** 原生语音桥；Web（或壳里没注册插件）返回 null，界面退到「语音输入仅在 App 中可用」。 */
export function createSpeechBridge(): SpeechBridge | null {
  const demo = demoBridge()
  if (demo) return demo
  if (!Capacitor.isNativePlatform()) return null
  if (!Capacitor.isPluginAvailable('SpeechInput')) return null
  return {
    availability: () => SpeechInput.availability(),
    start: (options) => SpeechInput.start(options ?? {}),
    stop: () => SpeechInput.stop(),
    cancel: () => SpeechInput.cancel(),
    openSettings: () => SpeechInput.openSettings(),
    checkMicPermission: () => SpeechInput.checkMicPermission(),
    requestMicPermission: () => SpeechInput.requestMicPermission(),
    on(event, handler) {
      let handle: { remove: () => Promise<void> | void } | null = null
      let removed = false
      void SpeechInput.addListener(event, handler as (payload: unknown) => void)
        .then((value) => {
          handle = value
          if (removed) void value.remove()
        })
        .catch(() => {
          /* 旧壳里没有该事件：忽略，靠 stop/final 兜底 */
        })
      return {
        remove(): void {
          removed = true
          if (handle) void handle.remove()
        },
      }
    },
  }
}

/** 能不能真的录音（系统服务或端侧识别至少有一个）。 */
export function isSpeechUsable(availability: SpeechAvailability | null | undefined): boolean {
  return availability?.available === true || availability?.onDevice === true
}

function normalizeAvailability(value: SpeechAvailability | null | undefined): SpeechAvailability {
  return {
    available: value?.available === true,
    onDevice: value?.onDevice === true,
    reason: typeof value?.reason === 'string' && value.reason.length > 0 ? value.reason : 'unknown',
  }
}

let availabilityPromise: Promise<SpeechAvailability | null> | null = null
let cachedAvailability: SpeechAvailability | null = null

/**
 * 读一次语音识别可用性（同一进程缓存；`null` = 没有原生桥，即 Web）。
 *
 * 同时写一条诊断事件（只有类别，**不包含任何识别文字**），方便真机上排查
 * 「为什么麦克风按了没反应」。
 */
export function loadSpeechAvailability(): Promise<SpeechAvailability | null> {
  if (availabilityPromise) return availabilityPromise
  const bridge = createSpeechBridge()
  if (!bridge) {
    cachedAvailability = null
    availabilityPromise = Promise.resolve(null)
    return availabilityPromise
  }
  availabilityPromise = bridge
    .availability()
    .then((value) => {
      const availability = normalizeAvailability(value)
      cachedAvailability = availability
      const info = speechSupportLabel(availability)
      recordDiag('speech:availability', `${info.label} · ${info.detail}`)
      return availability
    })
    .catch(() => {
      const availability: SpeechAvailability = { available: false, onDevice: false, reason: 'error' }
      cachedAvailability = availability
      recordDiag('speech:availability', '检查失败')
      return availability
    })
  return availabilityPromise
}

/** 最近一次查到的可用性（没查过是 null）。 */
export function cachedSpeechAvailability(): SpeechAvailability | null {
  return cachedAvailability
}

export interface SpeechSupportInfo {
  label: string
  detail: string
  state: 'ok' | 'offline' | 'bad'
}

const REASON_DETAIL: Record<string, string> = {
  system: '使用手机系统的语音识别服务',
  'on-device-only': '系统识别服务缺失，只有离线识别可用',
  none: '这台手机没有可用的系统语音识别服务',
  error: '检查语音识别时出错了，按住说话时会再试一次',
  unknown: '没有拿到系统语音识别的状态',
}

/** 设置页「关于和版本」里显示的一行：可用 / 仅离线 / 不可用（附原因）。 */
export function speechSupportLabel(
  availability: SpeechAvailability | null,
  options: { web?: boolean } = {},
): SpeechSupportInfo {
  if (!availability) {
    // 网页版（WP54 / W3）：没有系统识别，但录音上传 Hub 的链路是通的 —— 别写「请用 App」。
    const web = options.web ?? IS_WEB_BUILD
    if (web) {
      return {
        label: '网页版录音',
        detail: '按住说话直接用浏览器麦克风录音，识别由 Hub 完成（浏览器没有系统语音识别）',
        state: 'ok',
      }
    }
    return {
      label: '仅 App 内可用',
      detail: '浏览器里没有系统语音识别，请用 App 按住说话',
      state: 'bad',
    }
  }
  const detail = REASON_DETAIL[availability.reason] ?? REASON_DETAIL['unknown']!
  if (availability.available) return { label: '可用', detail, state: 'ok' }
  if (availability.onDevice) return { label: '仅离线', detail, state: 'offline' }
  return { label: '不可用', detail, state: 'bad' }
}

/**
 * 录音前的麦克风权限（0.4.2）。
 *
 * Android WebView 里 `getUserMedia` 本身会走 Capacitor 的
 * `BridgeWebChromeClient.onPermissionRequest`（Capacitor 8 里它同时申请
 * `MODIFY_AUDIO_SETTINGS` 与 `RECORD_AUDIO`，两个都要在 Manifest 里声明）。但 WebView 的
 * 这条路径在部分国产 ROM 上会被静默拒绝、也不弹窗，所以**先经原生插件显式申请**一次：
 * 首次一定看到系统授权弹窗，用户拒绝后界面能立刻给「去设置」。
 *
 * 返回 `unknown` 表示没有原生桥（浏览器 / 旧壳）：交给 `getUserMedia` 自己处理。
 */
export async function ensureMicPermission(
  bridge: SpeechBridge | null = createSpeechBridge(),
): Promise<'granted' | 'denied' | 'unknown'> {
  if (!bridge || typeof bridge.requestMicPermission !== 'function') return 'unknown'
  try {
    if (typeof bridge.checkMicPermission === 'function') {
      const current = await bridge.checkMicPermission()
      if (current?.granted === true) return 'granted'
    }
    const result = await bridge.requestMicPermission()
    return result?.granted === true ? 'granted' : 'denied'
  } catch (error) {
    // 原生拒绝（permission-denied）与「插件没实现」都按 denied/unknown 区分
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'permission-denied') return 'denied'
    return 'unknown'
  }
}

/** 打开系统设置里本应用的权限页（没有原生桥时返回 false，界面退到文字引导）。 */
export async function openSpeechSettings(): Promise<boolean> {
  const bridge = createSpeechBridge()
  if (!bridge) return false
  try {
    await bridge.openSettings()
    return true
  } catch {
    return false
  }
}
