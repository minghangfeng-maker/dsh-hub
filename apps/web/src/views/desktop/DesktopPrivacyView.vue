<script setup lang="ts">
import BrandMark from '@/components/base/BrandMark.vue'
import MobileWebBar from '@/components/base/MobileWebBar.vue'
import { useSiteStore } from '@/stores/site'

/**
 * 桌面端隐私说明 `/desktop/privacy`（WP25c 交付物 4）。
 *
 * 文案来源：产品设计文档的「隐私声明」与「诚实披露」两节，
 * 只做排版、不改口径。这是**文档正文**（不是界面说明小字，07 §2.7 管的是操作提示），
 * 所以用 14px 正文；读者是最终用户，客户端「关于」里以后直接复用这一份。
 *
 * 谁链接过来：桌面端授权页（每次登录都会看到）、工作台「桌面设备」卡片、下载页，
 * 以及手机 App / 手机网页版的「隐私政策」（WP54c：App 里 `webPage('/privacy')` 走 `/privacy` 别名，
 * 手机浏览器打开时顶部有「返回手机版」）。
 * 页面不需要登录：它要在用户还没信任这个站之前就能读到。
 */
const site = useSiteStore()
</script>

<template>
  <div class="privacy-page">
    <MobileWebBar kind="back" />

    <header class="privacy-page__bar">
      <RouterLink to="/" class="privacy-page__brand">
        <BrandMark :size="26" />
        <span>{{ site.site.name }}</span>
      </RouterLink>
    </header>

    <main class="privacy-page__doc">
      <h1 class="privacy-page__title">桌面端隐私说明</h1>
      <p class="privacy-page__p">
        DSH Hub 桌面端运行在你自己的电脑上。这一页写清楚它会向 Hub 报告什么、不会报告什么。
      </p>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">会报告的</h2>
        <p class="privacy-page__p">
          为了让管理员能把插件、配置和升级推送到你的电脑，桌面端只报告下面这些内容：
        </p>
        <ul class="privacy-page__list">
          <li>设备名（默认是「Windows 11 上的 DSH」，你可以改）、系统类型与主版本、CPU 架构；</li>
          <li>客户端版本、内置 DSH 运行时版本、更新通道；</li>
          <li>已安装插件的<strong>包名和版本</strong>、是必装 / 默认 / 可选 / 你自己装的、是否启用；</li>
          <li>管理员下发的配置有没有应用成功（成功 / 等待 / 失败，加一个错误代码）；</li>
          <li>这台设备最近一次报到的<strong>服务器时间</strong>。</li>
        </ul>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">不会报告的</h2>
        <p class="privacy-page__p">
          对话与会话内容、工作区里的文件和文件名、任何本地路径、命令历史、环境变量、密钥与登录凭据、系统用户名与机器名、剪贴板、屏幕内容，都不会上报，也不会上传你的日志文件。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">Hub 读不到你电脑上的文件</h2>
        <p class="privacy-page__p">
          Hub 没有远程执行能力：没有远程终端，没有反向代理，也没有文件下载接口。你和 Hub
          之间只有「你来问、我来答」的拉取——客户端主动问「有什么要应用的」，Hub
          回答清单，客户端自己装、自己报结果。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">模型请求与计费</h2>
        <p class="privacy-page__p">
          模型请求会经过 Hub 中转站（和云端实例一样，用于计费）。中转站会记录本次请求用了哪个模型、多少
          token、花了多少钱、耗时多少；如果上游报错，会记录一条截断到 300
          字、已去掉密钥的错误摘要。<strong>对话内容不会被记录</strong>。如果你不希望模型请求经过
          Hub，可以在设置里改用你自己的模型密钥（免费模式），那样请求完全直连上游。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">管理员能看到什么</h2>
        <p class="privacy-page__p">
          管理员能看到上面「会报告的」那几项：设备名、系统与架构、版本、插件清单、应用状态与最近在线时间。这些是设备台账的用途。管理员看不到你的会话、文件和任何本地内容。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">你可以查看和吊销</h2>
        <p class="privacy-page__p">
          随时在「我的工作台 → 桌面设备」看到 Hub
          目前保存了关于这台设备的哪些内容，也可以一键吊销；吊销后本机立即退出登录，本地会话和文件不受影响。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">崩溃诊断</h2>
        <p class="privacy-page__p">
          崩溃诊断默认关闭。以后做出来时，你可以在出错时点「发送诊断」——点之前会先看到将要发送的完整内容。
        </p>
      </section>

      <section class="privacy-page__section">
        <h2 class="privacy-page__h2">访问日志</h2>
        <p class="privacy-page__p">
          和其它网站一样，Hub 的访问日志会记录请求的来源 IP，用于限流与审计，不与上面任何内容关联。
        </p>
      </section>

      <footer class="privacy-page__footer">
        <RouterLink to="/home" class="privacy-page__link">回到我的工作台</RouterLink>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.privacy-page {
  min-height: 100vh;
  background: var(--c-bg);
}

.privacy-page__bar {
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--space-4);
  border-bottom: var(--border-width) solid var(--c-border);
  background: var(--c-surface);
}

.privacy-page__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  text-decoration: none;
}

.privacy-page__doc {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-4) var(--space-12);
}

.privacy-page__title {
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
}

.privacy-page__p {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
}

.privacy-page__p strong {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.privacy-page__section {
  margin-top: var(--space-6);
}

.privacy-page__h2 {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.privacy-page__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding-left: var(--space-4);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
  list-style: disc;
}

.privacy-page__list strong {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.privacy-page__footer {
  margin-top: var(--space-8);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}

.privacy-page__link {
  color: var(--c-primary-press);
  font-size: var(--fs-13);
}
</style>
