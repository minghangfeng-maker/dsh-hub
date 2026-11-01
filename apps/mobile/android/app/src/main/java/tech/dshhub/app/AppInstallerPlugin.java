package tech.dshhub.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;

/**
 * 本地 Capacitor 插件：把 App 内下载好的更新包交给系统安装器（0.3.1）。
 *
 * 为什么自己写：官方没有「调起 APK 安装器」的插件；而 0.3.0 及以前把下载地址丢给 Chrome
 * （Custom Tab）在真机上永远收不了尾（Chrome 的 APK 安全扫描要连 Google，国内不通）。
 * 现在下载在 WebView 里用 fetch 完成（见 packages/ui/src/lib/update-download.ts），
 * 本插件只负责最后一步：FileProvider 生成 content:// URI → ACTION_VIEW。
 *
 * 方法（与 packages/ui/src/lib/app-update-native.ts 一一对应）：
 *   canInstall()          Android 8+ 返回 canRequestPackageInstalls()，更早返回 true（全局开关）
 *   openInstallSettings() 打开「安装未知应用」里本应用的设置页
 *   install({path})       调起系统安装器；path 是相对 Cache 的路径（如 updates/xxx.apk）
 *   openInBrowser({url})  兜底：交给系统默认浏览器（不是 Custom Tab）
 *
 * 注册：MainActivity#onCreate 里 `registerPlugin(AppInstallerPlugin.class)`（必须在 super 之前）。
 */
@CapacitorPlugin(name = "AppInstaller")
public class AppInstallerPlugin extends Plugin {

    private static final String APK_MIME = "application/vnd.android.package-archive";

    /** 是否已允许本应用安装未知来源的应用（Android 8.0 起是「按应用」的开关）。 */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", canRequestPackageInstalls());
        call.resolve(result);
    }

    /** 打开系统设置里「安装未知应用 → DSH Hub」那一页。 */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        } else {
            // 8.0 以前没有按应用的开关，退回「安全」设置页
            intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        }
        if (!startIntent(intent)) {
            if (!startIntent(new Intent(Settings.ACTION_SECURITY_SETTINGS))) {
                call.reject("打不开系统设置");
                return;
            }
        }
        call.resolve();
    }

    /**
     * 调起系统安装器。
     *
     * path 来自 JS（`updates/dsh-hub-app-<版本>.apk`，由 Filesystem 写在 Cache 下）。
     * 这里做一次规范化校验，只允许 Cache 目录内的文件 —— 别让一段脏 JS 用 `../` 读别处。
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少安装包路径");
            return;
        }

        File apk;
        try {
            apk = resolveCacheFile(path);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        if (!apk.isFile() || apk.length() == 0) {
            call.reject("安装包不存在，请重新下载");
            return;
        }
        if (!canRequestPackageInstalls()) {
            // 正常流程不会走到这里（JS 先查 canInstall），防御一下：别让系统弹无意义的拒绝页
            call.reject("还没有允许安装应用");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (IllegalArgumentException error) {
            // FileProvider 的 path 配置不认这个文件（res/xml/file_paths.xml）
            call.reject("安装包路径不在共享范围内：" + error.getLocalizedMessage());
        } catch (ActivityNotFoundException error) {
            call.reject("没有可用的系统安装器");
        } catch (Exception error) {
            call.reject("打不开系统安装器：" + error.getLocalizedMessage());
        }
    }

    /** 兜底下载：交给系统默认浏览器（真正的浏览器窗口，不是 Custom Tab）。 */
    @PluginMethod
    public void openInBrowser(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        try {
            if (!startIntent(new Intent(Intent.ACTION_VIEW, Uri.parse(url)))) {
                call.reject("打不开浏览器");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("打不开浏览器：" + error.getLocalizedMessage());
        }
    }

    private boolean canRequestPackageInstalls() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    /** 用应用 context + NEW_TASK 启动，Activity 不在前台时也不会抛。返回是否成功。 */
    private boolean startIntent(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException error) {
            return false;
        }
    }

    /** 把相对路径解析成 Cache 下的文件，并拒绝逃出 Cache 目录的路径。 */
    private File resolveCacheFile(String path) {
        File cacheDir = getContext().getCacheDir();
        File file = new File(cacheDir, path);
        try {
            String root = cacheDir.getCanonicalPath();
            String target = file.getCanonicalPath();
            if (!target.startsWith(root + File.separator)) {
                throw new IllegalArgumentException("安装包路径不合法");
            }
            return file;
        } catch (IOException error) {
            throw new IllegalArgumentException("安装包路径不合法");
        }
    }
}
