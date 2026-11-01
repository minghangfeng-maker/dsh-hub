<script setup lang="ts">
/**
 * 无壳布局：给不需要 Auth/User/Admin 外壳的独立页面用（目前只有开发环境的样式自查页 `/__style`）。
 * 页面背景与基础排版与全局一致，内容自己决定宽度。
 */
</script>

<template>
  <div class="min-h-screen bg-bg">
    <slot />
  </div>
</template>
