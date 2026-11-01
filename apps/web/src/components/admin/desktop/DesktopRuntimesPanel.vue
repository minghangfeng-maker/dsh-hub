<script setup lang="ts">
import { getDesktopDelivery } from '@/api/admin-desktop'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import DesktopOtherFragmentsCard from '@/components/admin/desktop/DesktopOtherFragmentsCard.vue'
import DesktopVersionsTab from '@/components/admin/desktop/DesktopVersionsTab.vue'
import { useAsyncData } from '@/composables/useAsyncData'

/**
 * DSH 版本 · 桌面侧（docs/22 §1.3）：原「桌面端 · 版本与升级」整块迁过来，再加一张「其它配置片段」。
 *
 * - 安装包与渠道、灰度、强更地板：`DesktopVersionsTab`（WP25d 的四块面板原样复用）；
 * - 其它配置片段：桌面白名单里没被模型 / 代理 / 桥接三页接管的键（`DesktopOtherFragmentsCard`）。
 *
 * 桌面侧的版本走安装包 feed（不是镜像 runtimes），所以这一侧没有「构建新版本」。
 */
const { data, error, reload } = useAsyncData(() => getDesktopDelivery(), { pollMs: 20_000 })
</script>

<template>
  <div class="desk-runtimes">
    <AdminErrorNotice :error="error" title="桌面版本数据加载失败" @retry="reload" />
    <DesktopVersionsTab :state="data" @changed="reload" />
    <DesktopOtherFragmentsCard :state="data" @changed="reload" />
  </div>
</template>

<style scoped>
.desk-runtimes {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
</style>
