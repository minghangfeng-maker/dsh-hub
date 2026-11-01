<script setup lang="ts">
import type { Settings } from '@dsh-hub/shared'
import { NButton, NForm, NFormItem, NInput, NInputNumber, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { fetchSettings, updateSettings } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import ComputeSettingsSection from '@/components/admin/compute/ComputeSettingsSection.vue'
import MobileAppSettingsSection from '@/components/admin/MobileAppSettingsSection.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatBytes } from '@/composables/useFormat'

/**
 * 系统设置（07 §7.10）：分组表单（站点信息与公告、注册策略、默认配额、容量、导出、安全）。
 * 每组独立保存（04 §4.4：`PATCH /api/admin/settings` 按键整体替换）。
 */
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => fetchSettings())

/** 本地草稿：保存成功后回填，避免未保存的改动被刷新覆盖 */
const form = ref<Settings | null>(null)
const savingKey = ref<string | null>(null)

watch(
  data,
  (value) => {
    if (value) form.value = structuredClone(value)
  },
  { immediate: true },
)

const dirtyKeys = computed(() => {
  if (!data.value || !form.value) return [] as string[]
  return (Object.keys(form.value) as (keyof Settings)[]).filter(
    (key) => JSON.stringify(form.value?.[key]) !== JSON.stringify(data.value?.[key]),
  )
})

async function saveKey(key: keyof Settings): Promise<void> {
  const current = form.value
  if (!current) return

  savingKey.value = key
  try {
    const updated = await updateSettings({ [key]: current[key] })
    data.value = updated
    message.success('好的，已保存')
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    savingKey.value = null
  }
}

/** 整组保存按钮的状态（有改动才可点） */
function isDirty(key: keyof Settings): boolean {
  return dirtyKeys.value.includes(key)
}
</script>

<template>
  <AdminPage title="系统设置">
    <template #actions>
      <NButton size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        重新读取
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="设置加载失败" @retry="reload" />

    <SoftCard v-if="!form && loading">
      <p class="text-2">正在读取设置…</p>
    </SoftCard>

    <template v-else-if="form">
      <SoftCard title="站点信息与公告">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('site')"
            :loading="savingKey === 'site'"
            @click="saveKey('site')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="站点名称">
            <NInput v-model:value="form.site.name" maxlength="64" />
          </NFormItem>
          <NFormItem label="标语">
            <NInput v-model:value="form.site.tagline" maxlength="120" />
          </NFormItem>
          <NFormItem label="公告级别">
            <NSelect
              v-model:value="form.site.announcementLevel"
              :options="[
                { label: '信息（水青蓝）', value: 'info' },
                { label: '成功（水绿）', value: 'success' },
                { label: '警告（琥珀）', value: 'warning' },
                { label: '错误（珊瑚红）', value: 'error' },
              ]"
            />
          </NFormItem>
          <NFormItem label="公告内容" class="settings__wide">
            <NInput
              v-model:value="form.site.announcement"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-count
              placeholder="留空则不在用户端显示"
            />
          </NFormItem>
        </NForm>
      </SoftCard>

      <SoftCard title="注册策略">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('registration')"
            :loading="savingKey === 'registration'"
            @click="saveKey('registration')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="注册模式">
            <NSelect
              v-model:value="form.registration.mode"
              :options="[
                { label: '开放注册', value: 'open' },
                { label: '需要邀请码', value: 'invite' },
                { label: '关闭注册', value: 'closed' },
              ]"
            />
          </NFormItem>
          <NFormItem label="需要管理员审批">
            <NSwitch v-model:value="form.registration.requireApproval" />
          </NFormItem>
          <NFormItem label="用户上限">
            <NInputNumber v-model:value="form.registration.maxUsers" :min="1" :max="1000" />
          </NFormItem>
        </NForm>
      </SoftCard>

      <SoftCard title="默认配额">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('default_quota')"
            :loading="savingKey === 'default_quota'"
            @click="saveKey('default_quota')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="CPU 核数">
            <NInputNumber v-model:value="form.default_quota.cpus" :min="0.5" :max="8" :step="0.5" />
          </NFormItem>
          <NFormItem label="内存（MB）">
            <NInputNumber v-model:value="form.default_quota.memoryMb" :min="512" :max="8192" :step="256" />
          </NFormItem>
          <NFormItem label="进程数上限">
            <NInputNumber v-model:value="form.default_quota.pidsLimit" :min="64" :max="8192" :step="64" />
          </NFormItem>
          <NFormItem label="磁盘（GB）">
            <NInputNumber v-model:value="form.default_quota.diskGb" :min="1" :max="200" />
          </NFormItem>
          <NFormItem label="空闲回收（分钟）">
            <NInputNumber v-model:value="form.default_quota.idleStopMinutes" :min="0" :max="10080" />
          </NFormItem>
          <!--
            WP45：这个字段以前只在「用户详情 → 环境」的单用户配额表单里，全局默认面板漏了它，
            导致管理员按「空闲回收 = 120」调完之后，无人在看的实例仍然按 30 分钟被回收
            （unattended 走的是 idleNoClientMinutes，见 docs/22 §6.2、instances/service.ts §③）。
          -->
          <NFormItem label="没人看时休眠（分钟）">
            <NInputNumber
              v-model:value="form.default_quota.idleNoClientMinutes"
              :min="0"
              :max="10080"
            />
          </NFormItem>
          <NFormItem label="允许用户自助装插件">
            <NSwitch v-model:value="form.default_quota.allowUserPlugins" />
          </NFormItem>
        </NForm>
        <p class="settings__hint">
          「空闲回收」= 开着页面但闲着多久后回收；「没人看时休眠」= 完全没有客户端连接（关了页面、
          手机不在前台）时的回收阈值，默认 30 分钟，填 0 表示沿用「空闲回收」；两项都填 0 则不会自动回收。
        </p>
      </SoftCard>

      <SoftCard title="容量">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('capacity')"
            :loading="savingKey === 'capacity'"
            @click="saveKey('capacity')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="同时运行实例上限（0 = 维护模式，只停不起）">
            <NInputNumber v-model:value="form.capacity.maxRunning" :min="0" :max="200" />
          </NFormItem>
          <NFormItem label="并发导出任务">
            <NInputNumber v-model:value="form.capacity.maxConcurrentExports" :min="1" :max="16" />
          </NFormItem>
          <NFormItem label="连续进行中上限（分钟，0 不限）">
            <NInputNumber v-model:value="form.capacity.busyMaxMinutes" :min="0" :max="10080" :step="60" />
          </NFormItem>
        </NForm>
      </SoftCard>

      <!-- 容器设置（WP40d）：容器内权限预设 + 是否下发「普通对话」预设 -->
      <SoftCard title="容器">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('container')"
            :loading="savingKey === 'container'"
            @click="saveKey('container')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="容器内权限">
            <NSelect
              v-model:value="form.container.permissionPreset"
              :options="[
                { label: '完全放行（容器内免审批）', value: 'danger-full-access' },
                { label: '需要审批（只写工作区，即 ask）', value: 'workspace-write' },
              ]"
            />
          </NFormItem>
          <NFormItem label="下发「普通对话」预设">
            <NSwitch v-model:value="form.container.chatPreset" />
          </NFormItem>
        </NForm>
        <p class="settings__hint">
          容器本身就是隔离边界，手机 App 默认在容器内完全放行，避免第一句话停在审批上。改权限会改变容器的
          config_hash，现有实例在下次启动时会重建（数据卷保留）；「普通对话」预设只影响之后重新渲染的 managed
          配置。
        </p>
      </SoftCard>

      <!-- 算力租赁（13 §7）：独立接口与独立保存，不挤进 Settings 的按键包里 -->
      <!-- 安卓 App（WP40r）：上传 APK 即发布，主页右卡与 bootstrap.app 自动跟着变 -->
      <MobileAppSettingsSection data-testid="mobile-app-settings-section" />

      <ComputeSettingsSection data-testid="compute-settings-section" />


      <SoftCard title="数据导出">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('exports')"
            :loading="savingKey === 'exports'"
            @click="saveKey('exports')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="保留时长（小时）">
            <NInputNumber v-model:value="form.exports.ttlHours" :min="1" :max="720" />
          </NFormItem>
          <NFormItem label="单包大小上限（字节）">
            <NInputNumber v-model:value="form.exports.maxBytes" :min="1" :step="1073741824" />
          </NFormItem>
          <NFormItem label="每日次数上限">
            <NInputNumber v-model:value="form.exports.dailyLimit" :min="1" :max="100" />
          </NFormItem>
        </NForm>
        <p class="settings__hint">当前单包上限 ≈ {{ formatBytes(form.exports.maxBytes) }}。</p>
      </SoftCard>

      <SoftCard title="安全">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('security')"
            :loading="savingKey === 'security'"
            @click="saveKey('security')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="管理员会话时长（小时）">
            <NInputNumber v-model:value="form.security.adminSessionHours" :min="1" :max="168" />
          </NFormItem>
          <NFormItem label="二次确认有效期（分钟）">
            <NInputNumber v-model:value="form.security.reauthMinutes" :min="1" :max="120" />
          </NFormItem>
        </NForm>
      </SoftCard>

      <!-- 桌面端设备台账（WP25c，D6 §5.5）：每台设备的心跳与上限，字段与 settings.desktop 一一对应 -->
      <SoftCard title="桌面端">
        <template #extra>
          <NButton
            size="tiny"
            type="primary"
            :disabled="!isDirty('desktop')"
            :loading="savingKey === 'desktop'"
            @click="saveKey('desktop')"
          >
            保存
          </NButton>
        </template>
        <NForm label-placement="top" size="small" class="settings__form">
          <NFormItem label="每人设备上限">
            <NInputNumber v-model:value="form.desktop.maxDevicesPerUser" :min="1" :max="20" />
          </NFormItem>
          <NFormItem label="心跳间隔（秒）">
            <NInputNumber v-model:value="form.desktop.reportIntervalSec" :min="30" :max="900" :step="10" />
          </NFormItem>
          <NFormItem label="最短上报间隔（秒）">
            <NInputNumber v-model:value="form.desktop.minReportIntervalSec" :min="10" :max="300" :step="5" />
          </NFormItem>
          <NFormItem label="离线判定（秒）">
            <NInputNumber v-model:value="form.desktop.offlineAfterSec" :min="60" :max="3600" :step="30" />
          </NFormItem>
          <NFormItem label="允许上报诊断">
            <NSwitch v-model:value="form.desktop.diagnosticsAllowed" />
          </NFormItem>
        </NForm>
      </SoftCard>

      <p v-if="dirtyKeys.length > 0" class="settings__dirty">
        <span class="i-ph-pencil-simple" aria-hidden="true" />
        有未保存的分组：{{ dirtyKeys.join('、') }}
      </p>
    </template>
  </AdminPage>
</template>

<style scoped>
.settings__form {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.settings__wide {
  grid-column: 1 / -1;
}

.settings__hint {
  margin-top: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.settings__dirty {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}
</style>
