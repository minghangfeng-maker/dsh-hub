<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BubbleCat from '@/components/illustrations/BubbleCat.vue'
import { safeNextPath } from '@/router'
import { useAuthStore } from '@/stores/auth'

/**
 * 404（07 §2.6：圆滚滚小猫探头 + 文案 + 操作）。
 * 登录了就给「回工作台」，没登录就给「去登录」；带上原本想去的路径，登录后能回来。
 */
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const loginQuery = computed(() => {
  const next = safeNextPath(route.fullPath)
  return next ? { next } : undefined
})
</script>

<template>
  <section class="not-found">
    <BubbleCat :size="160" animated />

    <h1 class="not-found__title">这个页面像小猫一样躲起来了</h1>
    <p class="not-found__text">
      地址可能写错了，或者这个页面已经被搬走。检查一下链接，再试一次？
    </p>

    <div class="not-found__actions">
      <NButton v-if="auth.isLoggedIn" type="primary" round @click="router.push('/home')">
        回到我的工作台
      </NButton>
      <RouterLink v-else :to="{ path: '/login', query: loginQuery }">
        <NButton type="primary" round>去登录</NButton>
      </RouterLink>
      <NButton round @click="router.back()">返回上一页</NButton>
    </div>
  </section>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) 0;
  text-align: center;
}

.not-found__title {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.not-found__text {
  max-width: 360px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.not-found__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
