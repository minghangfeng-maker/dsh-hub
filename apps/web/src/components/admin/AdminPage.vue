<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import PageHeader from '@/components/base/PageHeader.vue'
import ReauthGate from '@/components/admin/ReauthGate.vue'
import type { AdminPlatform } from '@/composables/admin-platform'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'

/**
 * 管理端页面外壳：统一的标题区 + 内容区 + 二次确认弹窗挂载点。
 *
 * 挂在每个管理页里（而不是改 WP5a 的 `AdminLayout`），这样敏感操作的
 * `REAUTH_REQUIRED` 自动确认在任何管理页都能弹出来（07 §7、04 §0.2）。
 *
 * `platform` 插槽（docs/22 §1.2）放「云端 | 桌面端」切换，位置固定在标题下方、内容与 Tabs 之上；
 * 没有桌面对应物的页面不传这个插槽，切换就不出现。
 *
 * WP57：带切换的页面同时把当前端传给 `platform` 属性，外壳负责「换端」的视觉区分 ——
 * ①页面顶部一层端色光晕（云端蓝在左上、桌面端紫在右上，交叉淡入）；②切换旁边一条端色导轨；
 * ③内容区从切换方向滑入（切到桌面端从右边进、切回云端从左边进）。内容不重新挂载，只做动画。
 */
const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    backTo?: string
    backText?: string
    /** 表格页最小宽度（07 §2.2：管理端表格页最小 960px） */
    wide?: boolean
    /** 当前端（有平台切换的页面传）：驱动端色与切换动效 */
    platform?: AdminPlatform
    /** 换端时内容区要不要滑入（下发流程有自己的步骤动效，传 false） */
    animatePlatform?: boolean
    /**
     * 不画页标题那一行（WP58：AI 助手页的标题并进了卡片头，把高度让给对话，docs/26 §2.2）。
     * `title` 仍然要传（面包屑 / 文档标题用得上）。
     */
    hideHeader?: boolean
    /**
     * 紧凑页（WP58）：整页只有一张卡片时，不受管理台 960px 最小宽度约束 ——
     * 1100 宽的小窗口也能完整显示（表格页仍然 960，见 `wide`）。
     */
    compact?: boolean
  }>(),
  {
    subtitle: undefined,
    backTo: undefined,
    backText: '返回',
    wide: false,
    platform: undefined,
    animatePlatform: true,
    hideHeader: false,
    compact: false,
  },
)

const reducedMotion = usePrefersReducedMotion()
const body = ref<HTMLElement | null>(null)

const platformClass = computed(() => (props.platform ? `admin-page--plat-${props.platform}` : ''))

watch(
  () => props.platform,
  (next, previous) => {
    if (!next || !previous || next === previous || !props.animatePlatform) return
    const element = body.value
    if (!element || typeof element.animate !== 'function') return
    if (reducedMotion.value) {
      element.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
      return
    }
    // 桌面端在切换的右边：切过去时内容从右边滑进来，切回云端从左边
    const from = next === 'desktop' ? 36 : -36
    element.animate(
      [
        { opacity: 0, transform: `translateX(${String(from)}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
  },
)
</script>

<template>
  <section
    class="admin-page"
    :class="[platformClass, { 'admin-page--compact': compact }]"
    :data-platform="platform"
  >
    <template v-if="platform">
      <span class="admin-page__wash admin-page__wash--cloud" aria-hidden="true" />
      <span class="admin-page__wash admin-page__wash--desktop" aria-hidden="true" />
    </template>

    <PageHeader
      v-if="!hideHeader"
      :title="title"
      :subtitle="subtitle"
      :back-to="backTo"
      :back-text="backText"
    >
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
      <slot name="header-extra" />
    </PageHeader>

    <!-- 平台切换（docs/22 §1.2）：页标题下方、Tabs 之上的统一位置 -->
    <div v-if="$slots.platform" class="admin-page__platform">
      <slot name="platform" />
      <span v-if="platform" class="admin-page__rail" aria-hidden="true" />
    </div>

    <div ref="body" class="admin-page__body" :class="{ 'admin-page__body--wide': wide }">
      <slot />
    </div>

    <ReauthGate />
  </section>
</template>

<style scoped>
.admin-page {
  position: relative;
  display: flex;
  min-height: 100%;
  flex-direction: column;
}

.admin-page--plat-cloud {
  --plat: var(--c-plat-cloud);
  --plat-soft: var(--c-plat-cloud-soft);
  --plat-ink: var(--c-plat-cloud-ink);
}

.admin-page--plat-desktop {
  --plat: var(--c-plat-desktop);
  --plat-soft: var(--c-plat-desktop-soft);
  --plat-ink: var(--c-plat-desktop-ink);
}

.admin-page > :not(.admin-page__wash) {
  position: relative;
  z-index: 1;
}

/* 端色光晕：两层叠着，当前端那层不透明，换端时交叉淡入 */
.admin-page__wash {
  position: absolute;
  z-index: 0;
  inset: calc(var(--space-6) * -1) calc(var(--space-6) * -1) auto;
  height: 340px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 480ms var(--ease-out-soft);
}

.admin-page__wash--cloud {
  background: radial-gradient(60% 100% at 8% 0%, color-mix(in srgb, var(--c-plat-cloud) 13%, transparent), transparent 72%);
}

.admin-page__wash--desktop {
  background: radial-gradient(60% 100% at 92% 0%, color-mix(in srgb, var(--c-plat-desktop) 16%, transparent), transparent 72%);
}

.admin-page--plat-cloud .admin-page__wash--cloud,
.admin-page--plat-desktop .admin-page__wash--desktop {
  opacity: 1;
}

.admin-page__platform {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

/* 切换右边的端色导轨：从端色渐隐到透明，换端时颜色跟着过渡 */
.admin-page__rail {
  height: 2px;
  min-width: 48px;
  flex: 1;
  border-radius: 2px;
  background-color: var(--plat);
  mask-image: linear-gradient(90deg, var(--c-text), transparent);
  opacity: 0.55;
  transition: background-color 320ms var(--ease-out-soft);
}

.admin-page__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

/* 表格页：内容更宽，横向滚动交给表格自身（避免整页横滚，07 §9） */
.admin-page__body--wide {
  min-width: 960px;
}

@media (prefers-reduced-motion: reduce) {
  .admin-page__wash,
  .admin-page__rail {
    transition-duration: var(--duration-press);
  }
}
</style>
