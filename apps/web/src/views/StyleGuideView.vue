<script setup lang="ts">
import {
  NAlert,
  NBadge,
  NButton,
  NCheckbox,
  NDataTable,
  NDivider,
  NInput,
  NPagination,
  NProgress,
  NRadio,
  NRadioGroup,
  NSelect,
  NSkeleton,
  NSpin,
  NStep,
  NSteps,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
} from 'naive-ui'
import { h, ref } from 'vue'

import AvatarImg from '@/components/base/AvatarImg.vue'
import CheckDraw from '@/components/base/CheckDraw.vue'
import ConfirmPasswordDialog from '@/components/base/ConfirmPasswordDialog.vue'
import CopyText from '@/components/base/CopyText.vue'
import CountUp from '@/components/base/CountUp.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import PageHeader from '@/components/base/PageHeader.vue'
import PasswordStrength from '@/components/base/PasswordStrength.vue'
import SectionTitle from '@/components/base/SectionTitle.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import WaterBackdrop from '@/components/base/WaterBackdrop.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import UsageBar from '@/components/base/UsageBar.vue'
import BubbleCat from '@/components/illustrations/BubbleCat.vue'
import CloudNap from '@/components/illustrations/CloudNap.vue'
import KeyLeaf from '@/components/illustrations/KeyLeaf.vue'
import LeafSprout from '@/components/illustrations/LeafSprout.vue'
import PaperPlane from '@/components/illustrations/PaperPlane.vue'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'

/**
 * 样式自查页（**仅开发环境**，路由 `/__style`）。
 *
 * 用途：评审时一眼看全「令牌 / Naive 组件主题 / 基础组件 / 插画 / 动效」的一致性，
 * 检查有没有默认蓝色的 Naive 组件漏网（10 §H3）。生产构建里这个路由与组件都不存在。
 */
const prefersReducedMotion = usePrefersReducedMotion()
const showReauth = ref(false)
const switchOn = ref(true)
const progress = ref(62)

const COLOR_TOKENS: { token: string; label: string }[] = [
  { token: '--c-primary', label: '主色' },
  { token: '--c-primary-hover', label: '主色 hover' },
  { token: '--c-primary-press', label: '主色 press' },
  { token: '--c-primary-soft', label: '主色浅底' },
  { token: '--c-sky', label: '水青蓝' },
  { token: '--c-sky-soft', label: '水青蓝浅底' },
  { token: '--c-sakura', label: '紫罗兰（sakura）' },
  { token: '--c-sakura-soft', label: '紫罗兰浅底' },
  { token: '--c-butter', label: '琥珀' },
  { token: '--c-butter-soft', label: '琥珀浅底' },
  { token: '--c-success', label: '水绿（成功/运行中）' },
  { token: '--c-success-soft', label: '水绿浅底' },
  { token: '--c-warning', label: '警告色（Naive）' },
  { token: '--c-danger', label: '珊瑚红' },
  { token: '--c-danger-soft', label: '珊瑚红浅底' },
  { token: '--c-bg', label: '页面背景' },
  { token: '--c-surface', label: '卡片面' },
  { token: '--c-border', label: '描边' },
  { token: '--c-text', label: '正文' },
  { token: '--c-text-2', label: '次要文字' },
  { token: '--c-text-3', label: '占位/禁用' },
  { token: '--c-sky-ink', label: '水青蓝深字' },
  { token: '--c-sakura-ink', label: '紫罗兰深字' },
  { token: '--c-butter-ink', label: '琥珀深字' },
  { token: '--c-danger-ink', label: '珊瑚红深字' },
  { token: '--c-success-ink', label: '水绿深字' },
  { token: '--c-scrim', label: '抽屉遮罩' },
  { token: '--c-status-stopped', label: '实例已停止' },
]

const ILLUSTRATIONS = [
  { name: 'LeafSprout 新芽', component: LeafSprout },
  { name: 'CloudNap 小云朵', component: CloudNap },
  { name: 'PaperPlane 纸飞机', component: PaperPlane },
  { name: 'BubbleCat 小猫', component: BubbleCat },
  { name: 'KeyLeaf 叶子钥匙', component: KeyLeaf },
]

const INSTANCE_STATUSES = ['running', 'starting', 'stopping', 'stopped', 'absent', 'error'] as const

const selectOptions = [
  { label: 'DeepSeek 蓝', value: 'primary' },
  { label: '水青蓝', value: 'sky' },
  { label: '紫罗兰', value: 'violet' },
]

interface Row {
  name: string
  status: string
  createdAt: string
}

const tableColumns = [
  { title: '用户名', key: 'name' },
  {
    title: '状态',
    key: 'status',
    render: (row: Row) =>
      h(NTag, { type: row.status === '运行中' ? 'success' : 'default', round: true }, () => row.status),
  },
  { title: '创建时间', key: 'createdAt' },
]

const tableData: Row[] = [
  { name: 'mint-tea', status: '运行中', createdAt: '2026-10-12 09:30' },
  { name: 'sky-walker', status: '已停止', createdAt: '2026-10-11 21:04' },
  { name: 'sakura-mochi', status: '运行中', createdAt: '2026-10-10 08:15' },
]

const FONT_SIZES = [
  { token: '--fs-32', label: '页面主标题 32' },
  { token: '--fs-24', label: '区块标题 24' },
  { token: '--fs-20', label: '小标题 20' },
  { token: '--fs-16', label: '卡片标题 16' },
  { token: '--fs-14', label: '正文 14' },
  { token: '--fs-13', label: '次要 13' },
  { token: '--fs-12', label: '说明 12' },
]
</script>

<template>
  <div class="hub-page style-guide">
    <PageHeader title="样式自查" subtitle="07 §2 的设计令牌、基础组件与插画在同一页里的样子（仅开发环境）">
      <template #actions>
        <NTag :type="prefersReducedMotion ? 'warning' : 'success'" round>
          prefers-reduced-motion：{{ prefersReducedMotion ? '已开启（动效关闭）' : '未开启' }}
        </NTag>
      </template>
    </PageHeader>

    <!-- ① 色板 -->
    <SoftCard title="① 色彩令牌（07 §2.1）">
      <div class="sg-swatches">
        <div v-for="item in COLOR_TOKENS" :key="item.token" class="sg-swatch">
          <span class="sg-swatch__chip" :style="{ background: `var(${item.token})` }" />
          <code class="sg-swatch__token">{{ item.token }}</code>
          <span class="sg-swatch__label">{{ item.label }}</span>
        </div>
      </div>
      <div class="sg-gradient" />
      <p class="sg-note">.hub-grad-bg（登录/注册/唤醒页背景渐变）</p>
    </SoftCard>

    <!-- ② 排版 -->
    <SoftCard title="② 字体与排版（07 §2.2）" class="mt-6">
      <p v-for="item in FONT_SIZES" :key="item.token" :style="{ fontSize: `var(${item.token})` }">
        {{ item.label }}：清透、留白、圆润、轻盈、柔和
      </p>
      <p class="mt-3 font-mono text-[13px] text-2">等宽数字：0123456789 · abcdef · /api/me/instance</p>
    </SoftCard>

    <!-- ③ 形状 / 阴影 / 间距 -->
    <SoftCard title="③ 圆角、阴影、间距（07 §2.3）" class="mt-6">
      <div class="sg-row">
        <div class="sg-box rounded-card">rounded-card 16</div>
        <div class="sg-box rounded-control">rounded-control 12</div>
        <div class="sg-box rounded-pill">rounded-pill 999</div>
      </div>
      <div class="sg-row mt-4">
        <div class="sg-box shadow-soft">shadow-soft（卡片）</div>
        <div class="sg-box lift shadow-soft">shadow-hover（悬浮：鼠标移上来）</div>
      </div>
      <div class="sg-row mt-4">
        <div class="sg-space" style="padding: var(--space-1)">4</div>
        <div class="sg-space" style="padding: var(--space-2)">8</div>
        <div class="sg-space" style="padding: var(--space-3)">12</div>
        <div class="sg-space" style="padding: var(--space-4)">16</div>
        <div class="sg-space" style="padding: var(--space-6)">24</div>
        <div class="sg-space" style="padding: var(--space-8)">32</div>
        <div class="sg-space" style="padding: var(--space-12)">48</div>
      </div>
    </SoftCard>

    <!-- ④ Naive 组件 -->
    <SoftCard title="④ Naive UI 主题下的组件（07 §2.4）" class="mt-6">
      <SectionTitle title="按钮" description="圆角 12、主色 DeepSeek 蓝；点击有水波扩散" />
      <div class="sg-row">
        <NButton type="primary">主按钮</NButton>
        <NButton>次按钮</NButton>
        <NButton tertiary>tertiary</NButton>
        <NButton quaternary>quaternary</NButton>
        <NButton type="warning">警告</NButton>
        <NButton type="error">危险</NButton>
        <NButton disabled>禁用</NButton>
        <NButton loading>加载中</NButton>
        <NButton round>圆角按钮</NButton>
      </div>

      <NDivider />

      <SectionTitle title="输入与选择" />
      <div class="sg-grid">
        <NInput placeholder="普通输入框" />
        <NInput placeholder="密码" type="password" show-password-on="click" />
        <NSelect :options="selectOptions" default-value="primary" />
        <div class="sg-row">
          <NSwitch v-model:value="switchOn" />
          <NCheckbox :checked="true">复选框</NCheckbox>
          <NRadioGroup :value="'a'">
            <NRadio value="a">选项 A</NRadio>
            <NRadio value="b">选项 B</NRadio>
          </NRadioGroup>
        </div>
      </div>

      <NDivider />

      <SectionTitle title="标签、进度与反馈" />
      <div class="sg-row">
        <NTag round>默认标签</NTag>
        <NTag type="success" round>成功</NTag>
        <NTag type="info" round>信息</NTag>
        <NTag type="warning" round>警告</NTag>
        <NTag type="error" round>错误</NTag>
        <NBadge :value="3" />
        <NBadge dot type="success" />
      </div>
      <div class="sg-grid mt-4">
        <NProgress type="line" :percentage="progress" indicator-placement="inside" />
        <NProgress type="circle" :percentage="progress" style="width: 88px" />
        <NSpin />
        <NSkeleton text :repeat="2" style="width: 220px" />
      </div>

      <NAlert type="info" class="mt-4" :bordered="false">这是一条 info 提示（水青蓝）</NAlert>
      <NAlert type="success" class="mt-2" :bordered="false">这是一条成功提示（水绿）</NAlert>
      <NAlert type="warning" class="mt-2" :bordered="false">这是一条警告提示（琥珀）</NAlert>
      <NAlert type="error" class="mt-2" :bordered="false">这是一条错误提示（珊瑚红）</NAlert>

      <NDivider />

      <SectionTitle title="表格与分页" description="表头浅蓝、悬浮行浅色、圆角 12" />
      <NDataTable :columns="tableColumns" :data="tableData" :bordered="false" :pagination="false" />
      <div class="mt-4 flex justify-end">
        <NPagination :page="2" :page-count="9" />
      </div>

      <NDivider />

      <SectionTitle title="步骤条与选项卡" />
      <NSteps :current="2" size="small">
        <NStep title="创建" description="creating" />
        <NStep title="启动" description="booting" />
        <NStep title="引导插件" description="bootstrapping" />
        <NStep title="就绪" description="ready" />
      </NSteps>
      <NTabs type="line" animated class="mt-4">
        <NTabPane name="a" tab="提供方">提供方内容</NTabPane>
        <NTabPane name="b" tab="预设">预设内容</NTabPane>
      </NTabs>
    </SoftCard>

    <!-- ⑤ 基础组件 -->
    <SoftCard title="⑤ 基础组件（components/base）" class="mt-6">
      <SectionTitle
        title="StatusPill 五种（六种）实例状态"
        description="运行中带呼吸光点，启动/停止带旋转细环"
      />
      <div class="sg-row">
        <StatusPill v-for="status in INSTANCE_STATUSES" :key="status" :status="status" />
      </div>

      <NDivider />

      <SectionTitle title="UsageBar 阈值" description=">90% 琥珀、>100% 珊瑚红" />
      <div class="sg-grid">
        <UsageBar :used="1.2 * 1024 ** 3" :limit="4 * 1024 ** 3" label="磁盘" />
        <UsageBar :used="9.5 * 1024 ** 3" :limit="10 * 1024 ** 3" label="磁盘（>90%）" />
        <UsageBar :used="11 * 1024 ** 3" :limit="10 * 1024 ** 3" label="磁盘（超额）" />
      </div>

      <NDivider />

      <SectionTitle title="AvatarImg" description="无头像时用昵称首字 + slug 派生底色" />
      <div class="sg-row">
        <AvatarImg name="薄荷茶" seed="u7k2m9x" :size="40" />
        <AvatarImg name="Sky Walker" seed="u3aa11b" :size="40" />
        <AvatarImg name="樱花麻薯" seed="u9zz00c" :size="40" />
        <AvatarImg name="Butter" seed="u5qq77d" :size="40" />
        <AvatarImg name="Danger" seed="u1pp22e" :size="40" />
        <AvatarImg name="带边框" seed="u7k2m9x" :size="40" bordered />
        <AvatarImg
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%2334C7A0'/%3E%3C/svg%3E"
          name="有图"
          :size="40"
        />
      </div>

      <NDivider />

      <SectionTitle title="CopyText" description="一键复制（http 下也能用）" />
      <CopyText label="注册链接" text="https://hub.example.com/register?code=ABCD2345EFGH" truncate />
      <CopyText label="slug" text="u7k2m9x" size="sm" class="mt-2" />

      <NDivider />

      <SectionTitle title="PasswordStrength" description="三段渐变：珊瑚 → 琥珀 → 水绿" />
      <div class="sg-grid">
        <div>
          <NInput value="12345678" readonly />
          <PasswordStrength password="12345678" />
        </div>
        <div>
          <NInput value="mint-tea-2026" readonly />
          <PasswordStrength password="mint-tea-2026" />
        </div>
        <div>
          <NInput value="Mint#Soda-2026!long" readonly />
          <PasswordStrength password="Mint#Soda-2026!long" />
        </div>
      </div>

      <NDivider />

      <SectionTitle
        title="CountUp / CheckDraw"
        description="数字 600ms 计数；勾号 400ms 描边（reduce 时直接落值）"
      />
      <div class="sg-row">
        <span class="text-[28px] font-semibold text-1">
          <CountUp :value="1234" />
        </span>
        <CheckDraw :size="56" />
      </div>

      <NDivider />

      <SectionTitle title="ConfirmPasswordDialog（reauth）" />
      <NButton @click="showReauth = true">打开二次密码确认</NButton>
      <ConfirmPasswordDialog v-model:show="showReauth" @confirm="() => undefined" />

      <NDivider />

      <SectionTitle
        title="WaterBackdrop（水波纹背景）"
        description="登录页 full：涟漪环 + 波浪 + 鼠标划过/点击荡开涟漪；工作台 calm：底部淡波浪"
      />
      <div class="sg-water hub-grad-bg">
        <WaterBackdrop />
      </div>
      <div class="sg-water sg-water--calm mt-3">
        <WaterBackdrop variant="calm" />
      </div>

      <NDivider />

      <SectionTitle title="EmptyState" />
      <EmptyState
        illustration="cloud"
        title="还没有实例"
        description="点下面的按钮创建第一个 DSH，数据会留在自己的机器上。"
        action-text="创建实例"
      />
    </SoftCard>

    <!-- ⑥ 插画 -->
    <SoftCard title="⑥ 插画（07 §2.6）" class="mt-6">
      <div class="sg-row sg-row--center">
        <div v-for="item in ILLUSTRATIONS" :key="item.name" class="sg-illustration">
          <component :is="item.component" :size="110" animated />
          <span class="sg-note">{{ item.name }}</span>
        </div>
      </div>
    </SoftCard>

    <!-- ⑦ 动效 -->
    <SoftCard title="⑦ 动效（07 §2.5）" class="mt-6">
      <div class="sg-row">
        <div class="sg-box lift shadow-soft">悬浮上浮（.lift）</div>
        <NButton class="press">按下缩放（.press）</NButton>
        <span class="sg-dot breathe" />
        <span class="i-ph-circle-notch ring-spin text-[20px] text-primary" />
        <span class="skeleton sg-skeleton" />
      </div>
      <p class="sg-note mt-3">
        系统开启「减少动态效果」时：漂移、呼吸、旋转、流光全部关闭，只保留 ≤120ms 的淡入（H2）。
      </p>
    </SoftCard>
  </div>
</template>

<style scoped>
.style-guide {
  display: flex;
  flex-direction: column;
}

.sg-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.sg-row--center {
  align-items: flex-end;
  justify-content: space-around;
}

.sg-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.sg-swatches {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.sg-swatch {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sg-swatch__chip {
  height: 44px;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.sg-swatch__token {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.sg-swatch__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.sg-gradient {
  height: 56px;
  margin-top: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-bg-grad);
}

.sg-box {
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.sg-space {
  border: var(--border-width) dashed var(--c-border);
  background: var(--c-primary-soft);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.sg-note {
  margin-top: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.sg-water {
  position: relative;
  height: 220px;
  overflow: hidden;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
}

.sg-water--calm {
  height: 160px;
  background: var(--c-bg);
  /* calm 变体是 fixed 的：在这里把它框回演示区 */
  transform: translateZ(0);
}

.sg-illustration {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.sg-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c-primary);
}

.sg-skeleton {
  display: inline-block;
  width: 140px;
  height: 18px;
}
</style>
