<script setup lang="ts">
import OpsAssistantSection from '@/components/admin/assistant/OpsAssistantSection.vue'
import AdminPage from '@/components/admin/AdminPage.vue'

/**
 * AI 助手 `/admin/assistant`（WP57，docs/25 §5；WP58 桌面化，docs/26 §2）：
 * 座舱的「对话 → 方案 → 确认执行」，侧边栏在「概览」下面。点「启动」才拉起座舱容器，空闲会被回收。
 *
 * WP58：`hide-header` 关掉页标题那一大行 —— 标题并进助手的卡片头（`AI 助手 ● 就绪 … 重启`），
 * 卡片撑满视口，把高度让给对话。
 */
</script>

<template>
  <AdminPage title="AI 助手" hide-header compact>
    <OpsAssistantSection page />
  </AdminPage>
</template>
