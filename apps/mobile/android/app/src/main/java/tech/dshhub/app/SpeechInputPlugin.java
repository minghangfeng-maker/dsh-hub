package tech.dshhub.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * 本地 Capacitor 插件：按住说话 → 手机系统语音识别（0.4.1）。
 *
 * 只用 Android 自带的 {@link SpeechRecognizer}，不连服务端识别：用户按住麦克风说话，
 * 系统把文字返回来，JS 侧（lib/voice-input.ts）负责手势、取消、静音自动续段与拼接。
 *
 * 方法（与 packages/ui/src/lib/speech-native.ts 一一对应）：
 *   availability()   { available, onDevice, reason } —— 有没有系统识别服务 / 有没有离线识别
 *   start({...})     在**主线程**创建识别器并开听；没有麦克风权限时先走 Capacitor 的权限流程
 *   stop()           stopListening()：等系统把最后一段结果给完
 *   cancel()         cancel()：立刻停，不保留结果
 *   openSettings()   打开系统设置里本应用的权限页（拒绝麦克风后的引导）
 *   checkMicPermission()   { granted } —— 只查 RECORD_AUDIO，不弹窗（0.4.2）
 *   requestMicPermission() { granted } —— 显式申请 RECORD_AUDIO，会弹系统弹窗（0.4.2）
 *
 * 0.4.2 为什么要显式申请权限：按住说话改成 App 自己录音（getUserMedia），Android WebView
 * 的这条路径由 Capacitor 的 BridgeWebChromeClient.onPermissionRequest 兜（Capacitor 8 里它
 * 同时申请 MODIFY_AUDIO_SETTINGS 与 RECORD_AUDIO，两个都要写在 Manifest 里），但部分国产
 * ROM 上它会静默拒绝、连弹窗都不出。所以 JS 在调用 getUserMedia **之前**先用
 * requestMicPermission() 走一次原生权限申请：首次一定看到系统授权弹窗，拒绝也能立刻给
 * 「去设置」。
 *
 * 事件：partial{text} · final{text} · level{rms}（≈15Hz）· end ·
 *      error{code,message,nativeCode,service}（0.4.2 起 error 带系统原始码与默认识别服务名）。
 * 错误码统一成稳定的英文 slug（如 no-speech / permission-denied），中文文案由这里给出，
 * JS 侧还有一份同样的映射（lib/voice-input.ts），两边都能独立兜底。
 *
 * Manifest 两件必需的事（缺一个就会误报不可用）：
 *   1. `<uses-permission android:name="android.permission.RECORD_AUDIO" />`
 *   2. Android 11+ 的包可见性：
 *      `<queries><intent><action android:name="android.speech.RecognitionService" /></intent></queries>`
 *
 * 注册：MainActivity#onCreate 里 `registerPlugin(SpeechInputPlugin.class)`（必须在 super 之前）。
 */
@CapacitorPlugin(
    name = "SpeechInput",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class SpeechInputPlugin extends Plugin {

    private static final String DEFAULT_LANGUAGE = "zh-CN";
    /** 音量事件节流：约 15Hz 足够画波形，又不至于每帧都过桥。 */
    private static final long LEVEL_INTERVAL_MS = 66L;
    /** 静音判停：尽量拉长（部分 ROM 会忽略这些 extra，只能算提示）。 */
    private static final long SPEECH_COMPLETE_SILENCE_MS = 4000L;
    private static final long SPEECH_POSSIBLY_COMPLETE_SILENCE_MS = 3000L;
    private static final long SPEECH_MINIMUM_LENGTH_MS = 5000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** 只在主线程创建/销毁/调用。 */
    private SpeechRecognizer recognizer;
    /** 已经 startListening 且还没收到结果/错误。主线程读写。 */
    private boolean listening = false;
    /** 音量节流时间戳（主线程）。 */
    private long lastLevelAt = 0L;

    /**
     * 会话号：JS 每次 start 一个号，cancel/stop 之后旧号作废。
     * 权限弹窗会把 Activity 暂停，JS 那边会先 cancel —— 授权回调回来时不能又偷偷开麦。
     */
    private volatile long sessionCounter = 0L;
    private volatile long activeSession = 0L;
    private volatile long pendingStartSession = 0L;

    /** 有没有系统识别服务（API 31+ 再区分离线识别）。 */
    @PluginMethod
    public void availability(PluginCall call) {
        JSObject result = new JSObject();
        boolean system = false;
        boolean onDevice = false;
        try {
            system = SpeechRecognizer.isRecognitionAvailable(getContext());
        } catch (Exception ignored) {
            // 极端 ROM 会直接抛：当作不可用
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
            } catch (Exception ignored) {
                onDevice = false;
            }
        }
        result.put("available", system);
        result.put("onDevice", onDevice);
        result.put("reason", system ? "system" : (onDevice ? "on-device-only" : "none"));
        call.resolve(result);
    }

    /** 开始一段识别（按住期间系统静音结束时，JS 会再调一次，续下一段）。 */
    @PluginMethod
    public void start(PluginCall call) {
        long session = ++sessionCounter;
        activeSession = session;
        pendingStartSession = session;

        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            // 权限申请最终要走 ActivityResultLauncher，必须在主线程发起
            runOnMain(() -> requestPermissionForAlias("microphone", call, "microphoneCallback"));
            return;
        }
        startListening(call, session);
    }

    /** 权限结果回来：只有「这次 start 还活着」才真的开麦。 */
    @PermissionCallback
    private void microphoneCallback(PluginCall call) {
        if (pendingStartSession == 0L || pendingStartSession != activeSession) {
            // 等待授权期间已经被 cancel（切后台 / 松手）：不要再开麦
            pendingStartSession = 0L;
            call.resolve();
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            pendingStartSession = 0L;
            JSObject data = new JSObject();
            data.put("code", "permission-denied");
            data.put("message", "没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风");
            data.put("settings", true);
            call.reject(
                    "没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风",
                    "permission-denied",
                    data);
            return;
        }
        long session = pendingStartSession;
        pendingStartSession = 0L;
        startListening(call, session);
    }

    /**
     * 松手后调用：等系统把最后一段结果给完（JS 最多等 2 秒）。
     *
     * 返回 `{ listening }`：false = 这一段早就结束了（识别器已释放、不会再有 final），
     * JS 可以立刻收尾。顺便作废会话号，别让还在创建中的识别器偷偷开麦。
     */
    @PluginMethod
    public void stop(PluginCall call) {
        runOnMain(() -> {
            boolean wasListening = recognizer != null && listening;
            if (wasListening) {
                try {
                    recognizer.stopListening();
                } catch (Exception ignored) {
                    // 服务已经走了：交给 stop 之后的超时收尾
                }
            } else {
                sessionCounter++;
                activeSession = 0L;
                releaseRecognizer();
            }
            JSObject result = new JSObject();
            result.put("listening", wasListening);
            call.resolve(result);
        });
    }

    /** 取消：立刻停、丢弃结果（上滑取消 / 切后台 / 页面切走）。 */
    @PluginMethod
    public void cancel(PluginCall call) {
        sessionCounter++;
        activeSession = 0L;
        pendingStartSession = 0L;
        runOnMain(() -> {
            releaseRecognizer();
            call.resolve();
        });
    }

    /**
     * 只查麦克风权限（不弹窗）：给 JS 决定「要不要申请 / 要不要直接提示去设置」。
     */
    @PluginMethod
    public void checkMicPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("microphone") == PermissionState.GRANTED);
        call.resolve(result);
    }

    /**
     * 显式申请麦克风权限（会弹系统弹窗）。
     *
     * 与 `start()` 里的权限流程分开：这里只为「录音前一定弹一次授权」服务，
     * 不碰识别器状态，也不影响正在进行的识别会话（两者不会同时发生）。
     */
    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        runOnMain(() -> requestPermissionForAlias("microphone", call, "micPermissionCallback"));
    }

    /** 权限结果：JS 侧据此决定「继续录音」还是「弹去设置」。 */
    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        boolean granted = getPermissionState("microphone") == PermissionState.GRANTED;
        JSObject result = new JSObject();
        result.put("granted", granted);
        if (granted) {
            call.resolve(result);
        } else {
            call.reject(
                    "没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风",
                    "permission-denied",
                    result);
        }
    }

    /** 打开系统设置里本应用的详情页（麦克风权限被拒后的引导）。 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException error) {
            call.reject("打不开系统设置");
        }
    }

    // ── 生命周期：暂停 / 销毁时自动停，绝不在后台录音 ──────────────────────
    @Override
    protected void handleOnPause() {
        sessionCounter++;
        activeSession = 0L;
        pendingStartSession = 0L;
        runOnMain(this::releaseRecognizer);
    }

    @Override
    protected void handleOnDestroy() {
        sessionCounter++;
        activeSession = 0L;
        pendingStartSession = 0L;
        runOnMain(this::releaseRecognizer);
    }

    // ── 识别器 ─────────────────────────────────────────────────────────────

    private void startListening(PluginCall call, long session) {
        Context context = getContext();
        boolean system;
        boolean onDevice = false;
        try {
            system = SpeechRecognizer.isRecognitionAvailable(context);
        } catch (Exception error) {
            system = false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
            } catch (Exception ignored) {
                onDevice = false;
            }
        }
        if (!system && !onDevice) {
            rejectSpeechError(call, "no-recognizer", "这台手机没有可用的系统语音识别服务");
            return;
        }

        String language = call.getString("language", DEFAULT_LANGUAGE);
        boolean partial = call.getBoolean("partial", Boolean.TRUE);
        boolean preferOffline = call.getBoolean("preferOffline", Boolean.TRUE);
        boolean onDeviceOnly = !system && onDevice;

        runOnMain(() -> {
            if (session != activeSession) {
                // 等待期间被取消（权限弹窗/切后台）：不要再开麦
                call.resolve();
                return;
            }
            releaseRecognizer();
            SpeechRecognizer created;
            try {
                created = onDeviceOnly
                        ? SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                        : SpeechRecognizer.createSpeechRecognizer(context);
            } catch (Exception error) {
                rejectSpeechError(call, "unavailable", "这台手机没有可用的系统语音识别服务");
                return;
            }
            if (created == null) {
                rejectSpeechError(call, "unavailable", "这台手机没有可用的系统语音识别服务");
                return;
            }
            recognizer = created;
            created.setRecognitionListener(listener);
            try {
                created.startListening(buildIntent(context, language, partial, preferOffline));
                listening = true;
            } catch (Exception error) {
                releaseRecognizer();
                rejectSpeechError(
                        call,
                        "unavailable",
                        "开始语音识别失败，请稍后再试");
                return;
            }
            call.resolve();
        });
    }

    private Intent buildIntent(
            Context context, String language, boolean partial, boolean preferOffline) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
        // 静音判停尽量拉长：按住说话时停顿很常见，短了会不停重启（部分 ROM 忽略）
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                SPEECH_COMPLETE_SILENCE_MS);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                SPEECH_POSSIBLY_COMPLETE_SILENCE_MS);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS,
                SPEECH_MINIMUM_LENGTH_MS);
        return intent;
    }

    private final RecognitionListener listener =
            new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {}

                @Override
                public void onBeginningOfSpeech() {}

                @Override
                public void onRmsChanged(float rmsdB) {
                    if (recognizer == null) return;
                    long now = SystemClock.uptimeMillis();
                    if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
                    lastLevelAt = now;
                    JSObject data = new JSObject();
                    data.put("rms", (double) rmsdB);
                    notifyListeners("level", data);
                }

                @Override
                public void onBufferReceived(byte[] buffer) {}

                @Override
                public void onEndOfSpeech() {}

                @Override
                public void onError(int error) {
                    if (recognizer == null) return;
                    listening = false;
                    activeSession = 0L;
                    JSObject data = new JSObject();
                    data.put("code", errorCodeName(error));
                    data.put("message", errorMessage(error));
                    // 0.4.2 真机排错：系统原始码 + 默认识别服务组件名（只进本地诊断，不含文字）
                    data.put("nativeCode", error);
                    data.put("service", defaultRecognitionService());
                    notifyListeners("error", data);
                    notifyListeners("end", new JSObject());
                    // 回调里 destroy 会踩到系统内部状态：丢到下一轮主线程
                    mainHandler.post(SpeechInputPlugin.this::releaseRecognizer);
                }

                @Override
                public void onResults(Bundle results) {
                    if (recognizer == null) return;
                    listening = false;
                    activeSession = 0L;
                    JSObject data = new JSObject();
                    data.put("text", bestResult(results));
                    notifyListeners("final", data);
                    notifyListeners("end", new JSObject());
                    mainHandler.post(SpeechInputPlugin.this::releaseRecognizer);
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    if (recognizer == null) return;
                    String text = bestResult(partialResults);
                    if (text.isEmpty()) return;
                    JSObject data = new JSObject();
                    data.put("text", text);
                    notifyListeners("partial", data);
                }

                @Override
                public void onEvent(int eventType, Bundle params) {}
            };

    /** 主线程释放识别器（cancel + destroy 都不抛）。 */
    private void releaseRecognizer() {
        SpeechRecognizer current = recognizer;
        recognizer = null;
        listening = false;
        if (current == null) return;
        try {
            current.cancel();
        } catch (Exception ignored) {
            // 服务可能已经断开
        }
        try {
            current.destroy();
        } catch (Exception ignored) {
            // ignore
        }
    }

    private void runOnMain(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
            return;
        }
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(task);
        } else {
            mainHandler.post(task);
        }
    }

    private void rejectSpeechError(PluginCall call, String code, String message) {
        JSObject data = new JSObject();
        data.put("code", code);
        data.put("message", message);
        call.reject(message, code, data);
    }

    /**
     * 默认的系统语音识别服务组件名（`Settings.Secure` 的 `voice_recognition_service`）。
     *
     * 国产 ROM 上「一按就 ERROR_CLIENT」多半是这一项指向了厂商自己的服务（或为空）。
     * 只用于诊断事件，不显示给用户，也不含任何识别内容。
     */
    private String defaultRecognitionService() {
        try {
            String name = Settings.Secure.getString(
                    getContext().getContentResolver(), "voice_recognition_service");
            return name == null ? "" : name;
        } catch (Exception ignored) {
            return "";
        }
    }

    /** 取识别结果里最可信的一条（没有就空串）。 */
    private static String bestResult(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> results = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (results == null || results.isEmpty()) return "";
        String text = results.get(0);
        return text == null ? "" : text.trim();
    }

    /** SpeechRecognizer 的整数错误码 → 稳定的英文 slug（JS 侧有同样的映射）。 */
    private static String errorCodeName(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network-timeout";
            case SpeechRecognizer.ERROR_NETWORK:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no-match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission-denied";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                return "too-many-requests";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "server-disconnected";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                return "language-not-supported";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "language-unavailable";
            case SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT:
                return "cannot-check-support";
            case SpeechRecognizer.ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS:
                return "cannot-listen-downloads";
            default:
                return "unknown";
        }
    }

    /** 错误码 → 中文（界面上直接用这条 message）。 */
    private static String errorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "网络超时了，请重试";
            case SpeechRecognizer.ERROR_NETWORK:
                return "网络不可用，请检查网络后再试";
            case SpeechRecognizer.ERROR_AUDIO:
                return "录音出错了，请重试";
            case SpeechRecognizer.ERROR_SERVER:
                return "识别服务出错了，请重试";
            case SpeechRecognizer.ERROR_CLIENT:
                return "识别被中断了，请重试";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没听清，请再说一次";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "识别服务忙，请稍后再试";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                return "识别太频繁了，请稍后再试";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "识别服务断开了，请重试";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                return "系统语音识别不支持中文";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "系统缺少中文识别包，请在系统设置里下载";
            case SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT:
                return "这台手机的系统语音识别不可用";
            case SpeechRecognizer.ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS:
                return "系统识别服务还没准备好，请稍后再试";
            default:
                return "识别出错了，请再试一次";
        }
    }
}
