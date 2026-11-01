<script setup lang="ts">
import type { DesktopDeviceAdminItem } from '@dsh-hub/shared'
import { computed } from 'vue'

import { getDesktopDelivery } from '@/api/admin-desktop'
import { listAdminDesktopDevices } from '@/api/desktop'
import AdminStatCard from '@/components/admin/AdminStatCard.vue'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { summarizeDevices } from '@/utils/desktop-delivery'

/**
 * 实例 · 桌面侧的设备统计（docs/22 §1.3：原「桌面端 · 总览」的统计部分迁到这里）。
 *
 * 四颗数：清单当前 revision、在线设备（/ 总数）、待应用、失败 —— 与下方设备台账同一份数据源
 * （`GET /api/admin/desktop-devices`），所以点进台账看到的条数不会是另一套算法。
 * 这里只读，不下发；台账本身的筛选 / 分页 / 吊销在 `AdminDesktopDevicesPanel` 里。
 */
const { data: delivery, error: deliveryError, reload: reloadDelivery } = useAsyncData(
  () => getDesktopDelivery(),
  { pollMs: 20_000 },
)

const { data: devicePage, error: deviceError, reload: reloadDevices } = useAsyncData(
  () => listAdminDesktopDevices({ pageSize: 100 }),
  { pollMs: 20_000 },
)

const devices = computed<DesktopDeviceAdminItem[]>(() => devicePage.value?.items ?? [])
const summary = computed(() => summarizeDevices(devices.value))

function reload(): void {
  void reloadDelivery()
  void reloadDevices()
}
</script>

<template>
  <div class="devices-summary" data-testid="devices-summary">
    <AdminErrorNotice
      :error="deliveryError ?? deviceError"
      title="设备统计加载失败"
      @retry="reload"
    />

    <div class="devices-summary__cards">
      <AdminStatCard
        label="当前 revision"
        :value="delivery?.revision ?? 0"
        icon="i-ph-git-commit"
        tone="primary"
      />
      <AdminStatCard
        label="在线设备"
        :value="summary.online"
        :suffix="` / ${String(summary.total)}`"
        icon="i-ph-desktop"
        tone="sky"
      />
      <AdminStatCard label="待应用" :value="summary.pending" icon="i-ph-hourglass" tone="butter" />
      <AdminStatCard label="失败" :value="summary.failed" icon="i-ph-warning-circle" tone="danger" />
    </div>
  </div>
</template>

<style scoped>
.devices-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.devices-summary__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-4);
}
</style>
