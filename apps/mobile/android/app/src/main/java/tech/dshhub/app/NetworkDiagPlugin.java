package tech.dshhub.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

/**
 * 本地 Capacitor 插件：登录页「网络检测」的原生能力（0.4.9）。
 *
 * 为什么自己写：WebView 里的 fetch 有 CORS、也拿不到「系统认为这条网能不能上网」；
 * 而判断「App 是不是被 ROM 禁止联网」必须看连接层的异常类型（EPERM / Permission denied）。
 *
 * 方法（与 packages/ui/src/lib/net-diag.ts 一一对应）：
 *   status()                { connected, transport, validated, metered, restrictBackground }
 *   probe({url, timeoutMs}) { ok, status, ms, errorKind, bodyHint }
 *   openAppSettings()       本 App 的系统详情页（用户在那里手动打开「联网 / WLAN与移动数据」）
 *   openNetworkSettings()   Settings.ACTION_WIRELESS_SETTINGS，失败退回 ACTION_SETTINGS
 *
 * 重要事实（别把它做成「弹窗申请网络权限」）：Android 的 INTERNET 是安装时自动授予的
 * 普通权限，**没有运行时弹窗**；真正掐断 App 联网的是国产 ROM 的单 App 联网开关
 * （MIUI 联网控制 / ColorOS「WLAN 与移动数据」/ vivo 联网权限 / 鸿蒙「无线数据」），
 * 以及省流量、后台流量限制。App 只能跳到应用详情页让用户自己打开。
 *
 * NetworkCapabilities.NET_CAPABILITY_VALIDATED = 系统自己确认这条网能上网；
 * 有了它才能区分「手机没网」和「网络在、但 App 被单独掐掉」。
 *
 * errorKind 归类（probe）：
 *   UnknownHostException → dns；SocketTimeoutException → timeout；ConnectException → refused；
 *   SSLException → tls；SocketException 带 reset/EPIPE → reset；
 *   消息里有 EPERM / EACCES / Permission denied / Operation not permitted → blocked
 *   （这是国产 ROM 联网开关最典型的表现：连接在发出前就被拒，通常几毫秒就失败）。
 *
 * bodyHint 只回一个短标记（`icp`），**绝不回传正文**：云厂商按未备案域名拦截时会返回
 * HTTP 403 的 HTML 页（含「备案」「ICP」），这是历史上 App 报「网络连接失败」的真凶。
 * 只在 Content-Type 是 text/html 时才扫描，避免 JSON 正文里的「ICP」误触发。
 *
 * 线程：所有网络/查询都在后台线程池里做，结果回到主线程再 resolve 给 JS。
 * 注册：MainActivity#onCreate 里 `registerPlugin(NetworkDiagPlugin.class)`（必须在 super 之前）。
 */
@CapacitorPlugin(name = "NetworkDiag")
public class NetworkDiagPlugin extends Plugin {

    private static final int DEFAULT_TIMEOUT_MS = 5000;
    private static final int MAX_TIMEOUT_MS = 15000;
    /** 只看响应前 2KB：拦截页的关键词都在很前面，正文不往回传。 */
    private static final int BODY_SCAN_BYTES = 2048;
    /** 拦截页特征词（大小写不敏感）。 */
    private static final String[] BLOCK_HINTS = {"备案", "icp", "未备案"};

    private final ExecutorService worker = Executors.newFixedThreadPool(3);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }

    // ── 方法 ────────────────────────────────────────────────────────────────

    /** 当前默认网络的系统状态（ ConnectivityManager + NetworkCapabilities ）。 */
    @PluginMethod
    public void status(PluginCall call) {
        worker.execute(() -> {
            JSObject result = readStatus();
            runOnMain(() -> call.resolve(result));
        });
    }

    /** 发一次 GET，只回报「到达没有 / 多快 / 失败类别 / 是不是拦截页」。 */
    @PluginMethod
    public void probe(PluginCall call) {
        String rawUrl = call.getString("url");
        Integer requested = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        int timeoutMs = clamp(requested == null ? DEFAULT_TIMEOUT_MS : requested, 500, MAX_TIMEOUT_MS);

        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("缺少检测地址");
            return;
        }
        String url = rawUrl.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("只支持 http(s) 地址");
            return;
        }

        worker.execute(() -> {
            ProbeOutcome outcome = runProbe(url, timeoutMs);
            runOnMain(() -> {
                JSObject result = new JSObject();
                result.put("ok", outcome.ok);
                if (outcome.status != null) result.put("status", outcome.status.intValue());
                result.put("ms", outcome.ms);
                if (outcome.errorKind != null) result.put("errorKind", outcome.errorKind);
                if (outcome.bodyHint != null) result.put("bodyHint", outcome.bodyHint);
                call.resolve(result);
            });
        });
    }

    /** 本 App 的系统详情页：用户在那里打开「联网 / WLAN与移动数据」开关。 */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        if (!startIntent(intent)) {
            call.reject("打不开系统设置");
            return;
        }
        call.resolve();
    }

    /** 系统网络设置（Wi-Fi / 移动数据）；个别 ROM 没有 ACTION_WIRELESS_SETTINGS 就退回总设置。 */
    @PluginMethod
    public void openNetworkSettings(PluginCall call) {
        if (startIntent(new Intent(Settings.ACTION_WIRELESS_SETTINGS))
                || startIntent(new Intent(Settings.ACTION_SETTINGS))) {
            call.resolve();
            return;
        }
        call.reject("打不开网络设置");
    }

    // ── 实现 ────────────────────────────────────────────────────────────────

    private JSObject readStatus() {
        boolean connected = false;
        boolean validated = false;
        boolean metered = false;
        String transport = "none";

        try {
            ConnectivityManager manager =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
                // getActiveNetwork 在 API 23+ 才有（minSdk 24）
                Network network = manager.getActiveNetwork();
                NetworkCapabilities caps = network == null ? null : manager.getNetworkCapabilities(network);
                if (caps != null) {
                    // 有默认网络就算 connected；能不能上网由 validated 表达
                    connected = true;
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        transport = "wifi";
                    } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                        transport = "cellular";
                    } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                        transport = "ethernet";
                    } else {
                        transport = "other";
                    }
                    validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                }
            }
        } catch (Exception ignored) {
            // 权限/ROM 差异：按「没连网」回报，前端还有 navigator.onLine 兜底
        }

        JSObject result = new JSObject();
        result.put("connected", connected);
        result.put("transport", transport);
        result.put("validated", validated);
        result.put("metered", metered);
        result.put("restrictBackground", restrictBackground());
        return result;
    }

    /** 后台流量是否被系统限制（省流量模式 / 后台联网限制）。 */
    private boolean restrictBackground() {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return false;
            return manager.getRestrictBackgroundStatus()
                    == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
        } catch (Exception ignored) {
            return false;
        }
    }

    private ProbeOutcome runProbe(String target, int timeoutMs) {
        long startedAt = SystemClock.elapsedRealtime();
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setInstanceFollowRedirects(true);
            connection.setUseCaches(false);
            // 不带任何凭据、不带 Cookie：这只是连通性探测
            connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("User-Agent", "DSHHubApp-NetDiag");

            int status = connection.getResponseCode();
            long ms = SystemClock.elapsedRealtime() - startedAt;
            String hint = scanBlockHint(connection);
            if (hint != null) {
                // 拦截页：请求虽然「到」了，但内容不是目标站点给的
                return new ProbeOutcome(false, Integer.valueOf(status), ms, "blocked", hint);
            }
            // 2xx/3xx = 正常；401/403/404 也说明服务器回答了（探测只看「连不连得上」）
            boolean ok = status < 500;
            return new ProbeOutcome(ok, Integer.valueOf(status), ms, ok ? null : "other", null);
        } catch (Throwable error) {
            long ms = SystemClock.elapsedRealtime() - startedAt;
            return new ProbeOutcome(false, null, ms, classify(error), null);
        } finally {
            if (connection != null) {
                try {
                    connection.disconnect();
                } catch (Exception ignored) {
                    // ignore
                }
            }
        }
    }

    /** 响应前 2KB 里有没有拦截页特征（只对 text/html 生效）。命中返回 `icp`。 */
    private String scanBlockHint(HttpURLConnection connection) {
        String contentType = connection.getContentType();
        String type = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        if (!type.contains("text/html")) return null;

        InputStream stream = null;
        try {
            stream = connection.getResponseCode() >= 400
                    ? connection.getErrorStream()
                    : connection.getInputStream();
            if (stream == null) return null;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[512];
            int total = 0;
            while (total < BODY_SCAN_BYTES) {
                int read = stream.read(chunk, 0, Math.min(chunk.length, BODY_SCAN_BYTES - total));
                if (read <= 0) break;
                buffer.write(chunk, 0, read);
                total += read;
            }
            String body = new String(buffer.toByteArray(), StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
            for (String hint : BLOCK_HINTS) {
                if (body.contains(hint)) return "icp";
            }
            return null;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Exception ignored) {
                    // ignore
                }
            }
        }
    }

    /**
     * 异常 → 稳定的英文 slug。
     *
     * 先查权限类消息：国产 ROM 的联网开关抛的是 `ConnectException: Permission denied`
     * 或 `SocketException: socket failed: EPERM`，它们命中的 instanceof 分支会把它误判成
     * refused/other，而「几毫秒内被权限拒绝」正是「App 被禁止联网」的最强证据。
     */
    private String classify(Throwable error) {
        String message = error.getMessage() == null
                ? ""
                : error.getMessage().toLowerCase(Locale.ROOT);
        boolean denied = message.contains("eperm")
                || message.contains("eacces")
                || message.contains("permission denied")
                || message.contains("operation not permitted");
        if (denied) return "blocked";

        if (error instanceof UnknownHostException) return "dns";
        if (error instanceof SocketTimeoutException) return "timeout";
        if (error instanceof ConnectException) return "refused";
        if (error instanceof SSLException) return "tls";
        if (error instanceof SocketException) {
            if (message.contains("reset") || message.contains("econnreset") || message.contains("epipe")) {
                return "reset";
            }
            return "other";
        }
        if (error instanceof IOException) {
            if (message.contains("timed out") || message.contains("timeout")) return "timeout";
            if (message.contains("reset")) return "reset";
            return "other";
        }
        return "other";
    }

    /** 用应用 context + NEW_TASK 启动，Activity 不在前台时也不会抛。返回是否成功。 */
    private boolean startIntent(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException error) {
            return false;
        } catch (SecurityException error) {
            return false;
        }
    }

    private void runOnMain(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
            return;
        }
        mainHandler.post(task);
    }

    private int clamp(int value, int min, int max) {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    /** 一次探测的结果（只在主线程 pool 内部传递）。 */
    private static final class ProbeOutcome {
        final boolean ok;
        final Integer status;
        final long ms;
        final String errorKind;
        final String bodyHint;

        ProbeOutcome(boolean ok, Integer status, long ms, String errorKind, String bodyHint) {
            this.ok = ok;
            this.status = status;
            this.ms = ms;
            this.errorKind = errorKind;
            this.bodyHint = bodyHint;
        }
    }
}
