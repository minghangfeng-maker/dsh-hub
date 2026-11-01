<script setup lang="ts">
/**
 * 「航行日志」下拉（WP56d / docs/24 §1、§6；WP58 起与控制台左栏共用一份行）：嵌入座舱里
 * 会话列表的**下拉形态**（`cockpit.layout.sessions='menu'`，Hub 的 S/M 档）。
 *
 * 2026-10-29 用户定调：会话列表不占一栏，收进中控台顶部这个按钮里；
 * 中控台本身就是全部可视区域。WP58（docs/26 §3.3）在控制台主题下多了 `docked` 形态
 * （常驻左栏，`CockpitSessionRail.vue`）；两种形态的行都在 `CockpitSessionList.vue` 里，
 * 所以下拉里同样是**悬停「⋯」菜单（重命名 / 删除）**，不用手机的长按。
 *
 * 列表项按 docs/24 §1 的示意给三样东西：**会话标题、发起人、更新时间**；
 * 末尾是「+ 新会话」。没有账号/设置入口（嵌入模式隐藏账号与设置）。
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import CockpitSessionList from './CockpitSessionList.vue'
import { useCockpitStore } from '@/stores/cockpit'

const cockpit = useCockpitStore()

const open = computed(() => cockpit.logOpen)
</script>

<template>
  <div v-if="open" class="cockpit-log-mask" data-testid="cockpit-log-mask" @click="cockpit.closeLog()" />
  <section
    v-if="open"
    class="cockpit-log"
    data-testid="cockpit-log"
    role="dialog"
    aria-label="航行日志"
  >
    <header class="cockpit-log__head">
      <span class="cockpit-log__title">航行日志</span>
      <button class="cockpit-log__new" type="button" @click="cockpit.newSessionFromLog()">
        <AppIcon name="plus" :size="13" />
        新会话
      </button>
    </header>

    <div class="cockpit-log__list">
      <CockpitSessionList variant="menu" />
    </div>
  </section>
</template>

<style scoped>
.cockpit-log-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: transparent;
}
.cockpit-log {
  position: absolute;
  z-index: 41;
  /* 挂在中控台顶栏下方、靠左（「航行日志」按钮就在左上角） */
  top: calc(var(--safe-top) + 52px);
  left: 10px;
  width: min(320px, calc(100% - 20px));
  max-height: min(60vh, 420px);
  display: flex;
  flex-direction: column;
  padding: 8px;
  border-radius: 14px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-float);
}
.cockpit-log__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 8px;
}
.cockpit-log__title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-2);
}
.cockpit-log__new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
}
.cockpit-log__new:active {
  opacity: 0.7;
}
.cockpit-log__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
