package tech.dshhub.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Capacitor 的 WebView 默认跟随 Android 系统字体大小（WebSettings#getTextZoom）。
 * 真机反馈：系统字体调大后，输入卡里的模型芯片会被挤得换行。
 *
 * 布局侧的修法是「芯片单行 + 省略号」，但这只能保证不换行；字体继续放大到 130%+
 * 时输入卡仍然会变高、按钮会被压缩。所以这里再加一道闸：
 * 系统缩放 ≤ 115% 时原样跟随（尊重用户设置），> 115% 一律按 115% 处理。
 *
 * 选 115% 的理由：真机（1260×2800，约 393dp 宽）在 115% 下输入卡、首页问候、抽屉
 * 都还是标准布局；再往上（130%）虽然不换行，但模型芯片已经只剩很短一截省略号、
 * 按钮也开始贴边，体验收益为负。
 *
 * 另外这里注册本地插件（都必须在 super.onCreate() **之前** registerPlugin ——
 * 那一步才会把插件表交给 BridgeBuilder）：
 *  - AppInstaller（0.3.1）：App 内下载完更新包后调起系统安装器；
 *  - SpeechInput（0.4.1 / 0.4.2）：按住说话。0.4.1 调手机系统语音识别；0.4.2 起主要用
 *    App 内录音（WebView 的 getUserMedia），插件额外提供 checkMicPermission /
 *    requestMicPermission，保证首次录音一定弹系统授权（国产 ROM 的 WebView 路径会静默拒绝）；
 *  - NetworkDiag（0.4.9）：登录页「网络检测」。系统网络状态（NetworkCapabilities）、原生 GET 探测
 *    （不走 WebView，避开 CORS，能看连接层异常类型）、跳转应用详情页 / 网络设置页。
 */
public class MainActivity extends BridgeActivity {

    private static final int MAX_TEXT_ZOOM_PERCENT = 115;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppInstallerPlugin.class);
        registerPlugin(SpeechInputPlugin.class);
        registerPlugin(NetworkDiagPlugin.class);
        super.onCreate(savedInstanceState);
        applyTextZoomCap();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 用户可能在系统设置里改完字体大小又切回来，这里再钳一次
        applyTextZoomCap();
    }

    private void applyTextZoomCap() {
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;

        WebSettings settings = webView.getSettings();
        int current = settings.getTextZoom();
        if (current > MAX_TEXT_ZOOM_PERCENT) {
            settings.setTextZoom(MAX_TEXT_ZOOM_PERCENT);
        }
    }
}
