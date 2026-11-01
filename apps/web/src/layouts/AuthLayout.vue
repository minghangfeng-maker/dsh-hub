<script setup lang="ts">
import { onMounted } from 'vue'

import BrandMark from '@/components/base/BrandMark.vue'
import MobileWebBar from '@/components/base/MobileWebBar.vue'
import WaterBackdrop from '@/components/base/WaterBackdrop.vue'
import { useSiteStore } from '@/stores/site'

/**
 * 认证页外壳（07 §4）：全屏渐变背景 + 水波纹（涟漪环 / 波浪 / 指针涟漪）；
 * ≥960px 左侧品牌区只放品牌标记（星座鲸）+ 站点名 + 一句标语（标语来自系统设置，默认「探索未至之境」），
 * 右侧 400px 玻璃卡片；手机上只显示卡片。
 *
 * WP54c：手机浏览器里从手机网页版（`/m/`）外链过来（注册 / 重设密码 / 改密码）时，
 * 顶部给一条「返回手机版」。这条在电脑 UA 下渲染为空，所以布局改成「纵向列 + 卡片区
 * `margin: auto`」之后，桌面上的观感与改动前一致（卡片仍在视口正中）。
 */
const site = useSiteStore()

onMounted(() => {
  void site.load()
})
</script>

<template>
  <div class="auth-layout hub-grad-bg">
    <WaterBackdrop />

    <MobileWebBar kind="back" />

    <div class="auth-layout__inner">
      <section class="auth-layout__brand">
        <div class="auth-layout__logo">
          <BrandMark :size="52" />
          <span>{{ site.site.name }}</span>
        </div>

        <p class="stagger-item auth-layout__tagline" :style="{ '--stagger': 1 }">{{ site.site.tagline }}</p>
      </section>

      <main class="auth-layout__card hub-glass">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.auth-layout {
  position: relative;
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  padding: var(--space-6) var(--space-4);
}

.auth-layout__inner {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  max-width: 1040px;
  /* 顶部细条占了高度时，卡片用自己的 auto 外边距在剩余空间里居中（不受条是否出现影响） */
  margin: auto;
  justify-items: center;
  gap: var(--space-12);
}

.auth-layout__card {
  width: 100%;
  max-width: 400px;
  padding: var(--space-8);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.auth-layout__brand {
  display: none;
  /* 品牌字号随窗口宽度缩放（960px 宽时 44px，≥1390px 封顶 64px）；标记与标语缩进都按它算 */
  --brand-size: clamp(44px, 4.6vw, 64px);
  --brand-icon: calc(var(--brand-size) * 1.35);
  --brand-gap: calc(var(--brand-size) * 0.3);
}

@media (min-width: 960px) {
  .auth-layout__inner {
    grid-template-columns: minmax(0, 1fr) 400px;
    align-items: center;
  }

  .auth-layout__brand {
    display: block;
  }
}

.auth-layout__logo {
  display: flex;
  align-items: center;
  gap: var(--brand-gap);
  color: var(--c-text);
  font-size: var(--brand-size);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.5px;
  line-height: 1.1;
}

/* CSS 尺寸覆盖 BrandMark 的 width/height 属性，让标记跟着字号缩放 */
.auth-layout__logo :deep(.brand-mark) {
  width: var(--brand-icon);
  height: var(--brand-icon);
}

.auth-layout__tagline {
  margin-top: calc(var(--brand-size) * 0.35);
  /* 与标记右侧的站点名左对齐 */
  padding-left: calc(var(--brand-icon) + var(--brand-gap));
  color: var(--c-text-2);
  font-size: calc(var(--brand-size) * 0.4);
  letter-spacing: 0.4em;
}
</style>
