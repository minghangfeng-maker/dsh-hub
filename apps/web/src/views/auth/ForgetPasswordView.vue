<script setup lang="ts">
import { NButton } from 'naive-ui'

/**
 * 找回密码 `/forgot-password`（WP54c）。
 *
 * 为什么有这个页面：手机 App 与手机网页版的登录页都有「忘记密码」（App 里是 `webPage('/forgot-password')`
 * 同源打开），而 Hub **没有**自助重置（00 §「不做」：没有域名与发信策略，忘记密码由管理员重置，
 * 生成一次性临时密码、强制下次登录修改）。以前这个地址直接落 404，在手机上等于没有这条路，
 * 所以在这里给一条最短说明 + 回登录页的按钮；自助重置做出来之前不要删。
 *
 * 文案口径与 Hub 登录页的那句「忘记密码？请联系管理员重置」一致，07 §2.7 允许空状态留一句引导。
 */
</script>

<template>
  <section class="forgot">
    <header class="forgot__head">
      <h1 class="forgot__title">找回密码</h1>
    </header>

    <p class="forgot__text">
      Hub 不发重置邮件。请联系管理员重置密码：管理员会给你一个临时密码，登录后会先让你设置新密码。
    </p>

    <RouterLink to="/login" class="forgot__action">
      <NButton type="primary" block>返回登录</NButton>
    </RouterLink>
  </section>
</template>

<style scoped>
.forgot {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.forgot__head {
  text-align: center;
}

.forgot__title {
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
}

.forgot__text {
  color: var(--c-text-2);
  font-size: var(--fs-14);
  line-height: var(--lh-base);
}

.forgot__action {
  display: block;
  margin-top: var(--space-2);
  text-decoration: none;
}
</style>
