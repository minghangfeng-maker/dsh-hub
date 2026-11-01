<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import cloudShot from '@/assets/landing/cloud-web.webp'
import BrandMark from '@/components/base/BrandMark.vue'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 公开使用文档 `/docs`（WP44）：给还没注册、或刚注册的用户看的「DSH Hub 怎么用」。
 *
 * 免登录（和隐私说明一样，用户还没信任这个站之前就要能读到），从公开主页顶栏与页脚链过来。
 * 这是**文档正文**，用 14px 正文排版，与 `/desktop/privacy` 同一套样式口径。
 * 口径以生产当前配置为准（2026-10-28 核对）：开放注册、空闲 120 分钟自动停；WP53 起文档不写积分与计费。
 * 可被管理员改的数字一律写「目前」并指向工作台里的实时显示，改配置后记得回来对一下这页。
 */

const auth = useAuthStore()
const site = useSiteStore()
const route = useRoute()

/** 目录：id 与正文 `<section :id>` 一一对应（测试会钉住） */
const SECTIONS = [
  { id: 'what', title: 'DSH 是什么' },
  { id: 'quickstart', title: '五分钟上手' },
  { id: 'working', title: '在 DSH 里干活' },
  { id: 'workbench', title: '我的工作台' },
  { id: 'desktop', title: 'Windows 客户端' },
  { id: 'android', title: '安卓 App' },
  { id: 'account', title: '账号、安全与隐私' },
  { id: 'faq', title: '常见问题' },
] as const

const active = ref<string>(SECTIONS[0].id)

/** 章节标题滚到这条线（距视口顶部，px）以上就算「读到这一节」：要比顶栏 + 窄屏目录条高一点 */
const ACTIVE_LINE = 140
let frame = 0

/** 目录高亮：最后一个标题已经过线的章节；滚到底时强制最后一节（最后一节短，标题可能到不了线） */
function updateActive(): void {
  frame = 0
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
  let current: string = SECTIONS[0].id
  for (const section of SECTIONS) {
    const el = document.getElementById(section.id)
    if (el && el.getBoundingClientRect().top <= ACTIVE_LINE) current = section.id
  }
  active.value = atBottom ? (SECTIONS.at(-1)?.id ?? current) : current
}

function onScroll(): void {
  if (!frame) frame = requestAnimationFrame(updateActive)
}

onMounted(() => {
  void site.load()
  // 直接打开 `/docs#faq` 这类深链接：页面是懒加载的，路由的 scrollBehavior 跑的时候正文还不在，这里补一次
  const target = route.hash ? document.getElementById(decodeURIComponent(route.hash.slice(1))) : null
  if (target) void nextTick(() => target.scrollIntoView())
  window.addEventListener('scroll', onScroll, { passive: true })
  updateActive()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  if (frame) cancelAnimationFrame(frame)
})

/** 窄屏下目录是横向滚动条：当前章节变了就把它的链接滚进可视区（只动目录自己的 scrollLeft，不动页面） */
const tocList = ref<HTMLElement | null>(null)
watch(active, (id) => {
  const list = tocList.value
  const link = list?.querySelector<HTMLElement>(`[data-section="${id}"]`)
  if (!list || !link || list.scrollWidth <= list.clientWidth) return
  list.scrollLeft = link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2
})
</script>

<template>
  <div class="docs" data-testid="docs">
    <header class="docs__bar">
      <RouterLink to="/" class="docs__brand" aria-label="DSH Hub 首页">
        <BrandMark :size="26" />
        <span>DSH <span class="docs__brand-hub">Hub</span></span>
        <span class="docs__brand-sub">使用文档</span>
      </RouterLink>
      <nav class="docs__nav" aria-label="账号">
        <RouterLink to="/" class="docs__btn docs__btn--ghost" data-testid="docs-home">回到主页</RouterLink>
        <RouterLink
          v-if="auth.isLoggedIn"
          to="/home"
          class="docs__btn docs__btn--primary"
          data-testid="docs-workbench"
        >
          进入工作台
        </RouterLink>
        <RouterLink v-else to="/login" class="docs__btn docs__btn--primary" data-testid="docs-login">
          登录
        </RouterLink>
      </nav>
    </header>

    <div class="docs__layout">
      <aside class="docs__toc" aria-label="目录">
        <p class="docs__toc-title">目录</p>
        <ol ref="tocList" class="docs__toc-list" data-testid="docs-toc">
          <li v-for="(section, index) in SECTIONS" :key="section.id">
            <RouterLink
              :to="{ hash: `#${section.id}` }"
              class="docs__toc-link"
              :data-section="section.id"
              :class="{ 'docs__toc-link--active': active === section.id }"
              :aria-current="active === section.id ? 'location' : undefined"
            >
              <span class="docs__toc-no">{{ index + 1 }}</span
              >{{ section.title }}
            </RouterLink>
          </li>
        </ol>
      </aside>

      <main class="docs__doc">
        <h1 class="docs__title">DSH Hub 使用文档</h1>
        <p class="docs__p docs__lead">
          DSH Hub 连通万物。这份文档讲清楚三件事：DSH 能做什么、怎么开始用、用的时候要知道的规则。
        </p>

        <!-- 1 -->
        <section id="what" class="docs__section" data-testid="docs-section-what">
          <h2 class="docs__h2">1. DSH 是什么</h2>
          <p class="docs__p">
            DSH（DeepSeek Harness）是一个会自己动手的 AI
            智能体。你用大白话交代任务，它会自己写代码、跑命令、读写文件、查资料，一步步把活干完，最后把结果文件交给你。适合的事情比如：
          </p>
          <ul class="docs__list">
            <li>分析表格：「把这份销售表按月汇总，画趋势图，写一页结论」；</li>
            <li>整理文件：批量改名、格式转换、合并 PDF、从一堆文档里摘出要点；</li>
            <li>写代码：写个小脚本、改一个项目里的 bug、搭一个网页原型；</li>
            <li>查资料写东西：联网搜索后整理成报告、方案、周报。</li>
          </ul>
          <p class="docs__p">
            <strong>DSH Hub</strong> 是把 DSH 交到你手里的地方：帮你开一台自己的云上
            DSH，配好模型和插件，管好账号，同时提供 Windows 客户端和安卓 App。三种用法用的是同一个 Hub 账号：
          </p>
          <div class="docs__table-wrap">
            <table class="docs__table">
              <thead>
                <tr>
                  <th scope="col"></th>
                  <th scope="col">云上模式（推荐）</th>
                  <th scope="col">Windows 客户端</th>
                  <th scope="col">安卓 App</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">在哪里跑</th>
                  <td>Hub 服务器上属于你自己的容器</td>
                  <td>你自己的电脑</td>
                  <td>连到你的云上 DSH</td>
                </tr>
                <tr>
                  <th scope="row">文件放在</th>
                  <td>云上，可随时打包下载</td>
                  <td>你的电脑本地</td>
                  <td>云上（手机里能打开结果）</td>
                </tr>
                <tr>
                  <th scope="row">适合</th>
                  <td>不想装东西、要长时间跑的任务</td>
                  <td>要处理本机文件</td>
                  <td>出门在外看进度、接着聊</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 2 -->
        <section id="quickstart" class="docs__section" data-testid="docs-section-quickstart">
          <h2 class="docs__h2">2. 五分钟上手</h2>
          <ol class="docs__steps">
            <li>
              <strong>注册账号。</strong
              ><template v-if="site.registrationOpen"
                >在<RouterLink to="/register" class="docs__link">注册页</RouterLink
                >填用户名和密码即可。</template
              ><template v-else>当前没有开放注册，找管理员要一个邀请码，或者请管理员帮你开号。</template
              >用户名只能用小写字母、数字、<code>-</code>和<code>_</code>，以字母开头；密码至少 10
              位、含两类字符。
            </li>
            <li>
              <strong>进入工作台，点「打开 DSH」。</strong
              >第一次会创建你的容器，十几秒后自动在新标签页打开。之后每次登录或点「打开」都会自动唤醒。
            </li>
            <li>
              <strong>建一个工作区。</strong
              >左侧「工作区」旁边的按钮新建一个文件夹，比如「数据分析」。同一件事的文件和会话放在一起，DSH
              默认只在这个文件夹里读写。
            </li>
            <li>
              <strong>点「新会话」，用一句话交代任务。</strong
              >说清楚<em>要什么结果、放到哪个文件、有什么要求</em>。需要给它文件时，点输入框左边的<code
                >+</code
              >
              上传，或者用 <code>@</code> 引用工作区里已有的文件。
            </li>
            <li>
              <strong>等它干完，收结果。</strong
              >过程会实时显示，干完后结果文件在工作区里，点开就能看、能下载。
            </li>
          </ol>
          <figure class="docs__figure">
            <img
              :src="cloudShot"
              width="1600"
              height="841"
              loading="lazy"
              alt="网页版 DSH：一句话让它分析销售表，它画出了各产品月度销售额趋势图"
            />
            <figcaption class="docs__caption">
              真实截图：一句话交代「分析 sales-2026.csv，画趋势图，写一页简报」，2 分 36 秒干完。
            </figcaption>
          </figure>
        </section>

        <!-- 3 -->
        <section id="working" class="docs__section" data-testid="docs-section-working">
          <h2 class="docs__h2">3. 在 DSH 里干活</h2>

          <h3 class="docs__h3">把任务说清楚</h3>
          <p class="docs__p">DSH 不会读心，交代得越具体，返工越少。一个好的任务通常包含：</p>
          <ul class="docs__list">
            <li><strong>输入</strong>：用哪个文件、哪份数据、哪个网址；</li>
            <li><strong>产出</strong>：要一张图、一份 Word、一个脚本，叫什么名字；</li>
            <li><strong>要求</strong>：口径、格式、字数、用中文还是英文；</li>
            <li><strong>边界</strong>：哪些文件不要动、不确定时先问你。</li>
          </ul>
          <p class="docs__p">
            大任务可以先让它「先列个计划给我看」，确认后再动手。中途发现方向不对，直接发消息纠正就行，它会在下一步听到。
          </p>

          <h3 class="docs__h3">界面上的几样东西</h3>
          <ul class="docs__list">
            <li><strong>新会话 / 工作区</strong>：左栏。一个工作区可以有很多会话，会话历史一直保留。</li>
            <li>
              <strong>对话 / 轨迹</strong
              >：会话顶部两个页签。「对话」看结论，「轨迹」看它每一步执行了什么命令、改了哪些文件。
            </li>
            <li>
              <strong>权限</strong
              >：输入框下方，比如「工作区内修改」表示它可以直接改工作区里的文件；越权的操作会先弹出审批，等你点同意。
            </li>
            <li>
              <strong>模型与思考程度</strong
              >：输入框右下角。默认的模型已经由管理员配好，一般不用动；难题可以把思考程度调高，会慢一点、贵一点。
            </li>
            <li><strong>停止</strong>：跑的过程中发送键会变成停止键，随时可以叫停，已经产出的文件不会丢。</li>
            <li>
              <strong>输入框里的快捷方式</strong>：<code>/</code> 调用指令，<code>@</code>引用文件或别的对话。
            </li>
            <li>
              <strong>插件</strong>：左栏「插件」，能给 DSH
              加新本事（比如联网搜索）。可选插件也能在工作台里装。
            </li>
            <li><strong>自动化任务</strong>：左栏，让 DSH 按时间自动干某件事，比如每天早上整理一份简报。</li>
          </ul>

          <h3 class="docs__h3">小技巧</h3>
          <ul class="docs__list">
            <li>同一件事接着聊比新开会话更好：它记得前面的上下文和文件。</li>
            <li>换一件不相干的事就新开会话，上下文干净，响应也更快。</li>
            <li>让它「最后用几句话告诉我结论」，结果一眼就能看完。</li>
          </ul>
        </section>

        <!-- 4 -->
        <section id="workbench" class="docs__section" data-testid="docs-section-workbench">
          <h2 class="docs__h2">4. 我的工作台</h2>
          <p class="docs__p">
            登录后的<RouterLink to="/home" class="docs__link">工作台</RouterLink>是管理自己那台 DSH 的地方。
          </p>
          <ul class="docs__list">
            <li>
              <strong>我的 DSH</strong>：看运行状态和 CPU、内存、磁盘占用；可以打开、停止、重启。<strong
                >空闲一段时间（目前 120 分钟）会自动停机</strong
              >，下次打开自动唤醒，对话、文件和插件都在。
            </li>
            <li>
              <strong>切换配置</strong
              >：想要更快可以换更大的规格，运行中切换会按新规格重启（正在跑的任务会中断，数据保留）。
            </li>
            <li><strong>我的模型</strong>：DSH 里能用的模型，由管理员统一配置，在 DSH 设置里改不会生效。</li>
            <li><strong>我的插件</strong>：装 / 卸可选插件，装完重启 DSH 生效。</li>
            <li>
              <strong>我的数据</strong>：勾选工作区、会话记录、DSH 设置，后台打包成 ZIP 下载，24
              小时内有效。密钥和凭据永远不会被打包进去。
            </li>
            <li><strong>桌面设备</strong>：登录过 Windows 客户端的电脑，可以随时吊销。</li>
          </ul>
        </section>

        <!-- 5 -->
        <section id="desktop" class="docs__section" data-testid="docs-section-desktop">
          <h2 class="docs__h2">5. Windows 客户端</h2>
          <p class="docs__p">
            想让 DSH 直接处理你电脑上的文件，就用 Windows 客户端。它是完整的
            DSH，跑在你自己的电脑上，文件不出本机。
          </p>
          <ul class="docs__list">
            <li>
              <strong>下载</strong>：在<RouterLink to="/?platform=desktop" class="docs__link"
                >主页「桌面端」</RouterLink
              >下载。支持 Windows 10 / 11。<em>安装版</em>会自动升级；<em>免安装版</em>解压即用、不自动升级。
            </li>
            <li>
              <strong>登录</strong>：打开客户端，它会拉起系统浏览器到 Hub
              的授权页，登录并点同意后自动回到客户端。登录后模型、插件和配置会自动同步过来，不用自己配。
            </li>
            <li>
              <strong>开箱即用</strong>：自带 Python（含 numpy、pandas、python-docx 等）、Node.js 和
              PowerShell 7，不用另外安装。网络代理默认跟随 Windows 系统代理。
            </li>
            <li>
              <strong>预览版提示</strong>：安装包还没有代码签名，如果 Windows
              提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可。
            </li>
            <li>
              <strong>Hub 看不到你的文件</strong>：客户端只向 Hub
              报告设备名、版本、插件清单这类信息，会话和文件都不上传。完整说明见<RouterLink
                to="/desktop/privacy"
                class="docs__link"
                >桌面端隐私说明</RouterLink
              >。
            </li>
          </ul>
        </section>

        <!-- 6 -->
        <section id="android" class="docs__section" data-testid="docs-section-android">
          <h2 class="docs__h2">6. 安卓 App</h2>
          <p class="docs__p">安卓 App 是你云上 DSH 的随身遥控器：在手机上看进度、接着聊、看结果。</p>
          <ul class="docs__list">
            <li>
              <strong>下载</strong>：在<RouterLink to="/?platform=android" class="docs__link"
                >主页「安卓端」</RouterLink
              >下载 APK，支持 Android 8 及以上。安装时如果提示「未知来源」，按提示允许本次安装即可。
            </li>
            <li><strong>登录</strong>：用 Hub 账号登录一次，之后打开就是上次的对话。</li>
            <li><strong>自动唤醒</strong>：云上 DSH 停机了也没关系，App 会自动把它叫起来。</li>
            <li>
              <strong>能做的事</strong
              >：看会话列表、新建会话、发消息、选模型和思考程度、停止任务、在手机上直接处理审批、打开交付的文件和图片。
            </li>
            <li>App 连的是云上模式，Windows 客户端里的本地会话不会出现在手机上。</li>
          </ul>
        </section>

        <!-- 7 -->
        <section id="account" class="docs__section" data-testid="docs-section-account">
          <h2 class="docs__h2">7. 账号、安全与隐私</h2>
          <ul class="docs__list">
            <li>
              <strong>个人中心</strong
              >：改昵称、头像和密码；「登录设备」里能看到哪些设备登着你的账号，可以逐个踢下线。改密码后其它设备会立刻退出。
            </li>
            <li><strong>忘记密码</strong>：找管理员重置，会给你一个临时密码，下次登录时要求改掉。</li>
            <li><strong>环境隔离</strong>：每个人的云上 DSH 是独立容器，彼此看不到对方的会话和文件。</li>
            <li>
              <strong>管理员能看到什么</strong>：为了排查问题，管理员可以进入用户的云上
              DSH，每次进入都会写审计日志。Windows 客户端里的会话和文件，管理员看不到。
            </li>
            <li>
              <strong>模型请求</strong>：经过 Hub 中转，只记录用了哪个模型、多少 token
              和耗时，<strong>不记录对话内容</strong>。
            </li>
            <li>
              <strong>别把密钥交给 DSH 乱用</strong
              >：它会照你说的去执行命令。涉及账号密码、生产系统的操作，自己把关。
            </li>
          </ul>
        </section>

        <!-- 8 -->
        <section id="faq" class="docs__section" data-testid="docs-section-faq">
          <h2 class="docs__h2">8. 常见问题</h2>
          <dl class="docs__faq">
            <dt>点了「打开 DSH」没反应？</dt>
            <dd>
              多半是浏览器拦了弹出的新标签页。工作台会给出手动打开的链接，点它就行；也可以允许本站弹出窗口。
            </dd>

            <dt>打开 DSH 要等一会儿？</dt>
            <dd>停机后再打开需要先唤醒，通常十几秒。唤醒页会自己跳过去，不用刷新。</dd>

            <dt>任务跑到一半我关了浏览器，会停吗？</dt>
            <dd>
              不会。云上 DSH
              在服务器上跑，关掉浏览器、手机锁屏都不影响，回来打开会话就能看到进度。只有停机（手动停、空闲自动停）才会中断。
            </dd>

            <dt>DSH 设置里改了模型，怎么没生效？</dt>
            <dd>模型由管理员统一配置，以工作台「我的模型」为准。需要别的模型请找管理员。</dd>

            <dt>不想用了，数据怎么拿走？</dt>
            <dd>工作台「我的数据」勾选内容打包下载（ZIP，Windows 双击就能打开）。</dd>

            <dt>DSH 做错了 / 卡住了怎么办？</dt>
            <dd>
              先点停止，再用一句话说明哪里不对、希望怎么改。实在不行就新开一个会话，把需求重新说一遍——工作区里的文件都还在。
            </dd>
          </dl>
        </section>

        <footer class="docs__footer">
          <span>© 2026 DSH Hub</span>
          <RouterLink to="/desktop/privacy" class="docs__link">隐私说明</RouterLink>
          <RouterLink to="/" class="docs__link">回到主页</RouterLink>
        </footer>
      </main>
    </div>
  </div>
</template>

<style scoped>
.docs {
  min-height: 100vh;
  background: var(--c-bg);
}

/* ---------- 顶栏 ---------- */
.docs__bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--c-border);
  background: var(--c-surface-glass);
  backdrop-filter: blur(10px);
}

.docs__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  text-decoration: none;
  white-space: nowrap;
}

.docs__brand:hover {
  color: var(--c-text);
}

.docs__brand-hub {
  color: var(--c-primary);
}

.docs__brand-sub {
  padding-left: var(--space-2);
  border-left: var(--border-width) solid var(--c-border);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  font-weight: var(--fw-normal);
}

.docs__nav {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.docs__btn {
  display: inline-flex;
  height: 34px;
  align-items: center;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-control-sm);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  text-decoration: none;
  white-space: nowrap;
}

.docs__btn--ghost {
  border-color: var(--c-border);
  background: var(--c-surface);
  color: var(--c-text);
}

.docs__btn--ghost:hover {
  border-color: var(--c-primary);
  color: var(--c-primary-press);
}

.docs__btn--primary {
  background: var(--c-primary);
  color: var(--c-surface);
}

.docs__btn--primary:hover {
  background: var(--c-primary-hover);
  color: var(--c-surface);
}

/* ---------- 两栏：目录 + 正文 ---------- */
.docs__layout {
  display: grid;
  max-width: 1080px;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--space-8);
  margin: 0 auto;
  padding: 0 var(--space-4);
}

.docs__toc {
  position: sticky;
  top: 72px;
  align-self: start;
  padding-top: var(--space-8);
}

.docs__toc-title {
  margin-bottom: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.docs__toc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.docs__toc-link {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 6px 10px;
  border-left: 2px solid transparent;
  color: var(--c-text-2);
  font-size: var(--fs-14);
  text-decoration: none;
}

.docs__toc-link:hover {
  color: var(--c-text);
}

.docs__toc-link--active {
  border-left-color: var(--c-primary);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.docs__toc-no {
  min-width: 1em;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.docs__doc {
  min-width: 0;
  max-width: 780px;
  padding: var(--space-8) 0 var(--space-12);
}

/* ---------- 正文排版（与 /desktop/privacy 同口径） ---------- */
.docs__title {
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
}

.docs__lead {
  font-size: var(--fs-16);
}

.docs__section {
  margin-top: calc(var(--space-8) + var(--space-2));
  scroll-margin-top: 80px;
}

.docs__h2 {
  padding-bottom: var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
  color: var(--c-text);
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
}

.docs__h3 {
  margin-top: calc(var(--space-4) + var(--space-1));
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.docs__p {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
}

.docs__p strong,
.docs__list strong,
.docs__steps strong {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.docs__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding-left: calc(var(--space-4) + var(--space-1));
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
  list-style: disc;
}

.docs__steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-left: calc(var(--space-4) + var(--space-1));
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
  list-style: decimal;
}

.docs__steps li::marker {
  color: var(--c-primary);
  font-weight: var(--fw-semibold);
}

.docs__doc em {
  color: var(--c-text);
  font-style: normal;
  font-weight: var(--fw-semibold);
}

.docs__doc code {
  padding: 1px 6px;
  border-radius: var(--radius-control-sm);
  background: var(--c-surface-muted);
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.docs__link {
  color: var(--c-primary-press);
}

.docs__table-wrap {
  margin-top: var(--space-3);
  overflow-x: auto;
}

.docs__table {
  width: 100%;
  border-collapse: collapse;
  background: var(--c-surface);
  font-size: var(--fs-14);
  line-height: 1.6;
}

.docs__table th,
.docs__table td {
  padding: 8px 12px;
  border: var(--border-width) solid var(--c-border);
  color: var(--c-text-2);
  text-align: left;
  vertical-align: top;
}

.docs__table thead th,
.docs__table tbody th {
  background: var(--c-primary-soft);
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.docs__figure {
  margin-top: var(--space-4);
}

.docs__figure img {
  display: block;
  width: 100%;
  height: auto;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.docs__caption {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
  text-align: center;
}

.docs__faq dt {
  margin-top: var(--space-4);
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.docs__faq dd {
  margin: var(--space-1) 0 0;
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: 1.8;
}

.docs__footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-top: var(--space-12);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* ---------- 窄屏：目录变成正文上方的横向滚动条 ---------- */
@media (max-width: 860px) {
  .docs__layout {
    display: block;
  }

  .docs__toc {
    position: sticky;
    top: 59px;
    z-index: 4;
    margin: 0 calc(-1 * var(--space-4));
    padding: var(--space-2) var(--space-4);
    border-bottom: var(--border-width) solid var(--c-border);
    background: var(--c-surface);
  }

  .docs__toc-title {
    display: none;
  }

  .docs__toc-list {
    position: relative;
    flex-direction: row;
    gap: var(--space-1);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .docs__toc-link {
    padding: 4px 10px;
    border-left: none;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }

  .docs__doc {
    padding-top: var(--space-6);
  }

  .docs__section {
    scroll-margin-top: 120px;
  }

  .docs__brand-sub {
    display: none;
  }
}
</style>
