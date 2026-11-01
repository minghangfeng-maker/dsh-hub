<script setup lang="ts">
/**
 * 控制台主题的**常驻会话栏**（WP58 / docs/26 §3.3）：父页面发来
 * `cockpit.layout.sessions='docked'`（Hub 的 L 档及以上）时，航行日志从左上角下拉
 * 变成对话区里的左栏——宽 248 / 264 / 280（由 `scale` 决定，见 lib/cockpit-layout.ts）。
 *
 * 顶部「＋ 新会话」，每行标题 / 发起人 / 相对时间，悬停出「⋯」菜单（重命名 / 删除，
 * 替代手机的长按）——行本身与下拉形态共用 `CockpitSessionList.vue`。
 *
 * 只在 `theme=console` + `sessions='docked'` 时挂载（App.vue），其它形态一律不渲染。
 */
import AppIcon from './AppIcon.vue'
import CockpitSessionList from './CockpitSessionList.vue'
import { useCockpitStore } from '@/stores/cockpit'

withDefaults(defineProps<{ width?: number }>(), { width: 248 })

const cockpit = useCockpitStore()
</script>

<template>
  <aside
    class="session-rail"
    data-testid="cockpit-session-rail"
    aria-label="会话列表"
    :style="{ width: `${width}px` }"
  >
    <header class="session-rail__head">
      <span class="session-rail__title">会话</span>
      <button
        class="session-rail__new"
        type="button"
        data-testid="cockpit-rail-new"
        @click="cockpit.newSessionFromLog()"
      >
        <AppIcon name="plus" :size="13" />
        新会话
      </button>
    </header>
    <div class="session-rail__list">
      <CockpitSessionList variant="rail" />
    </div>
  </aside>
</template>

<style scoped>
.session-rail {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  padding: 8px 6px 10px;
}
.session-rail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 6px;
}
.session-rail__title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.session-rail__new {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #ffffff;
  color: var(--text-2);
  font-size: 11.5px;
  white-space: nowrap;
}
.session-rail__new:hover {
  background: var(--surface-2);
  color: var(--text);
}
.session-rail__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
