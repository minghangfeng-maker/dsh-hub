<script setup lang="ts">
import ConfirmPasswordDialog from '@/components/base/ConfirmPasswordDialog.vue'
import { cancelReauth, reauthDialog, resolveReauth } from '@/composables/useReauth'

/**
 * 二次确认弹窗的挂载点（配合 `composables/useReauth.ts`）。
 * 每个 `AdminPage` 里放一个：任何敏感请求拿到 `REAUTH_REQUIRED` 后自动弹出，
 * 确认成功即重试原请求（07 §7）。
 */
</script>

<template>
  <ConfirmPasswordDialog
    v-model:show="reauthDialog.visible"
    :title="reauthDialog.title ?? '请再输入一次密码'"
    :description="reauthDialog.description ?? '这是敏感操作，为了确认是你本人。'"
    :confirm-text="reauthDialog.confirmText ?? '确认'"
    :type="reauthDialog.type ?? 'primary'"
    @confirm="resolveReauth"
    @cancel="cancelReauth"
  />
</template>
