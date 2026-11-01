<script setup lang="ts">
import { NButton, NModal, NTabPane, NTabs } from 'naive-ui'

/**
 * 根证书安装说明（07 §5.1）：四个平台 Tab，文案准确、步骤可照做。
 * 自签证书的下载地址来自站点配置（`caCertUrl`，默认 `/ca.crt`）。
 */
withDefaults(
  defineProps<{
    show: boolean
    caCertUrl?: string
  }>(),
  { caCertUrl: '/ca.crt' },
)

const emit = defineEmits<{ 'update:show': [value: boolean] }>()

interface PlatformGuide {
  key: string
  label: string
  icon: string
  steps: string[]
  tip?: string
}

const GUIDES: PlatformGuide[] = [
  {
    key: 'windows',
    label: 'Windows',
    icon: 'i-ph-monitor',
    steps: [
      '点上面的「下载根证书」，保存 ca.crt。',
      '双击 ca.crt → 安装证书 → 存储位置选「本地计算机」→ 下一步。',
      '选「将所有的证书都放入下列存储」→ 浏览 → 受信任的根证书颁发机构 → 确定 → 下一步 → 完成。',
      '弹出安全警告时点「是」。',
      '重启浏览器（Chrome / Edge 会跟随系统证书）。',
    ],
    tip: '命令行等价做法（管理员 PowerShell）：certutil -addstore -f "ROOT" ca.crt',
  },
  {
    key: 'macos',
    label: 'macOS',
    icon: 'i-ph-laptop',
    steps: [
      '点「下载根证书」，保存 ca.crt。',
      '双击 ca.crt，在「钥匙串访问」里把它加入「系统」钥匙串（需要输入登录密码）。',
      '在钥匙串里找到这张证书，双击 → 展开「信任」→「使用此证书时」选「始终信任」。',
      '关闭窗口并再次输入密码确认。',
      '重启 Safari / Chrome。',
    ],
    tip: 'Firefox 使用独立证书库：设置 → 隐私与安全 → 证书 → 查看证书 → 导入。',
  },
  {
    key: 'ios',
    label: 'iOS / iPadOS',
    icon: 'i-ph-device-mobile',
    steps: [
      '用 Safari 打开这个页面并点「下载根证书」（或在电脑上把 ca.crt 通过 AirDrop / 邮件发到设备后点开）。',
      '设置 → 通用 → VPN 与设备管理 → 已下载的描述文件 → 安装（需要输入锁屏密码）。',
      '设置 → 通用 → 关于本机 → 证书信任设置 → 打开这张证书的「完全信任」开关。',
      '回到 Safari 重新打开站点。',
    ],
    tip: '必须用 Safari 下载，且第 3 步的信任开关是单独的，别漏掉。',
  },
  {
    key: 'android',
    label: 'Android',
    icon: 'i-ph-device-mobile-speaker',
    steps: [
      '点「下载根证书」把 ca.crt 存到手机。',
      '设置 → 安全 → 加密与凭据（部分机型在「更多安全设置」）→ 安装证书 → CA 证书。',
      '确认风险提示后选择刚下载的 ca.crt 文件安装。',
      '在「受信任的凭据 → 用户」里能看到这张证书即安装成功。',
      '重启浏览器。',
    ],
    tip: '部分国产系统会把入口放在「设置 → 密码与安全 → 系统安全」。',
  },
]
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="安装 DSH Hub 根证书"
    class="ca-dialog"
    :style="{ maxWidth: '620px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p class="ca-dialog__intro">
      Hub 使用的是自签证书，装上根证书后浏览器就不会再提示「不安全」。证书只用于这一台机器。
    </p>

    <div class="ca-dialog__download">
      <a :href="caCertUrl" download>
        <NButton type="primary" round>
          <template #icon>
            <span class="i-ph-download-simple" aria-hidden="true" />
          </template>
          下载根证书（ca.crt）
        </NButton>
      </a>
    </div>

    <NTabs type="line" animated>
      <NTabPane v-for="guide in GUIDES" :key="guide.key" :name="guide.key" :tab="guide.label">
        <ol class="ca-dialog__steps">
          <li v-for="(step, index) in guide.steps" :key="step" class="ca-dialog__step">
            <span class="ca-dialog__step-index">{{ index + 1 }}</span>
            <span>{{ step }}</span>
          </li>
        </ol>
        <p v-if="guide.tip" class="ca-dialog__tip">
          <span class="i-ph-lightbulb" aria-hidden="true" />
          {{ guide.tip }}
        </p>
      </NTabPane>
    </NTabs>

    <template #footer>
      <div class="ca-dialog__footer">
        <NButton @click="emit('update:show', false)">知道了</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.ca-dialog__intro {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.ca-dialog__download {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}

.ca-dialog__steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.ca-dialog__step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-13);
}

.ca-dialog__step-index {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
}

.ca-dialog__tip {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-butter-soft);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.ca-dialog__footer {
  display: flex;
  justify-content: flex-end;
}
</style>
