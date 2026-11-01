<script setup lang="ts">
import { UpdateMeRequestSchema } from '@dsh-hub/shared'
import { NButton, NInput, useMessage } from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'

import { deleteAvatar, updateMe, uploadAvatar } from '@/api/me'
import { describeError, isHubApiError } from '@/api/errors'
import AvatarCropper from '@/components/user/AvatarCropper.vue'
import AvatarImg from '@/components/base/AvatarImg.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { AVATAR_ACCEPT } from '@/utils/avatar-crop'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { useAuthStore } from '@/stores/auth'

/**
 * 个人中心 → 资料（07 §6.2）：头像（裁剪后上传）、用户名（30 天冷却）、昵称、简介。
 * 保存按钮只在有改动时可用；字段校验用 shared 的 `UpdateMeRequestSchema`（与后端同一套）。
 */
const auth = useAuthStore()
const message = useMessage()

const form = reactive({ username: '', displayName: '', bio: '' })
const saving = ref(false)
const uploading = ref(false)
const fieldErrors = reactive<Record<string, string>>({})
const usernameNotice = ref('')

const fileInput = ref<HTMLInputElement | null>(null)
const cropperVisible = ref(false)
const pendingFile = ref<File | null>(null)

const user = computed(() => auth.user)

function syncFromUser(): void {
  form.username = user.value?.username ?? ''
  form.displayName = user.value?.displayName ?? ''
  form.bio = user.value?.bio ?? ''
  usernameNotice.value = ''
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key]
}

watch(user, syncFromUser, { immediate: true, deep: true })

const dirty = computed(() => {
  if (!user.value) return false
  return (
    form.username !== user.value.username ||
    form.displayName !== user.value.displayName ||
    form.bio !== user.value.bio
  )
})

const bioLeft = computed(() => 200 - form.bio.length)

function pickFile(): void {
  fileInput.value?.click()
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return
  pendingFile.value = file
  cropperVisible.value = true
}

async function onCropped(blob: Blob, filename: string): Promise<void> {
  uploading.value = true
  try {
    const response = await uploadAvatar(blob, filename)
    auth.setUser(response.user)
    message.success('新头像换好啦')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    uploading.value = false
    pendingFile.value = null
  }
}

async function removeAvatar(): Promise<void> {
  uploading.value = true
  try {
    const response = await deleteAvatar()
    auth.setUser(response.user)
    message.success('头像已移除')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    uploading.value = false
  }
}

async function save(): Promise<void> {
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key]

  const payload: Record<string, string> = {}
  if (form.username !== user.value?.username) payload.username = form.username
  if (form.displayName !== user.value?.displayName) payload.displayName = form.displayName
  if (form.bio !== user.value?.bio) payload.bio = form.bio

  const parsed = UpdateMeRequestSchema.safeParse(payload)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form')
      if (!fieldErrors[key]) fieldErrors[key] = issue.message
    }
    message.error(Object.values(fieldErrors)[0] ?? '有几项填写还需要调整')
    return
  }

  saving.value = true
  try {
    const response = await updateMe(parsed.data)
    auth.setUser(response.user)
    message.success('好的，已保存')
  } catch (error) {
    const description = describeError(error)
    for (const [key, text] of Object.entries(description.fieldErrors)) fieldErrors[key] = text
    if (isHubApiError(error) && error.code === 'USERNAME_CHANGE_TOO_SOON') {
      const changedAt = typeof error.details['changedAt'] === 'string' ? error.details['changedAt'] : null
      usernameNotice.value = changedAt
        ? `上次修改：${formatDateTime(changedAt)}（${fromNow(changedAt)}），30 天后可再改`
        : '用户名 30 天内只能改一次'
      fieldErrors.username = usernameNotice.value
    } else {
      message.error(description.message)
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
    <section class="flex flex-col items-center gap-2" aria-label="头像">
      <button type="button" class="avatar-button press" :disabled="uploading" @click="pickFile">
        <AvatarImg :src="auth.avatarUrl" :name="auth.displayName" :seed="user?.slug" :size="96" bordered />
        <span class="avatar-button__mask">
          <span class="i-ph-camera" aria-hidden="true" />
          <span class="avatar-button__mask-text">{{ uploading ? '上传中…' : '换头像' }}</span>
        </span>
      </button>

      <input
        ref="fileInput"
        class="hidden"
        type="file"
        :accept="AVATAR_ACCEPT"
        data-testid="avatar-input"
        @change="onFileChange"
      />

      <button v-if="auth.avatarUrl" type="button" class="hub-btn-ghost" @click="removeAvatar">移除头像</button>
      <!-- 格式清单（不是解释句）：文件选择器按这些类型过滤 -->
      <p class="text-[12px] text-3">PNG / JPEG / WebP</p>
    </section>

    <section class="flex flex-col gap-4" aria-label="资料表单">
      <label class="flex flex-col gap-1">
        <span class="flex items-center text-[13px] text-2">
          用户名
          <InfoTip label="用户名 30 天内可修改一次" text="登录时也用它；改完要记好。" />
        </span>
        <NInput v-model:value="form.username" placeholder="小写字母、数字、- 和 _" :status="fieldErrors.username ? 'error' : undefined" />
        <span v-if="fieldErrors.username" class="text-[12px] text-danger" role="alert" aria-live="polite">
          {{ fieldErrors.username }}
        </span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-2">昵称</span>
        <NInput v-model:value="form.displayName" maxlength="32" placeholder="想让大家怎么称呼你" :status="fieldErrors.displayName ? 'error' : undefined" />
        <span v-if="fieldErrors.displayName" class="text-[12px] text-danger" role="alert">{{ fieldErrors.displayName }}</span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-2">个人简介</span>
        <NInput
          v-model:value="form.bio"
          type="textarea"
          :maxlength="200"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="一两句话介绍自己（200 字以内）"
          :status="fieldErrors.bio ? 'error' : undefined"
        />
        <span class="self-end text-[12px]" :class="bioLeft < 0 ? 'text-danger' : 'text-3'">
          还能写 {{ bioLeft }} 字
        </span>
        <span v-if="fieldErrors.bio" class="text-[12px] text-danger" role="alert">{{ fieldErrors.bio }}</span>
      </label>

      <div class="flex items-center gap-3">
        <NButton type="primary" :disabled="!dirty" :loading="saving" data-testid="profile-save" @click="save">
          保存修改
        </NButton>
        <NButton quaternary :disabled="!dirty || saving" @click="syncFromUser">撤销改动</NButton>
        <span v-if="dirty" class="text-[12px] text-3">有未保存的修改</span>
      </div>
    </section>

    <AvatarCropper
      v-model:show="cropperVisible"
      :file="pendingFile"
      :username="user?.username ?? 'avatar'"
      @cropped="onCropped"
    />
  </div>
</template>

<style scoped>
.avatar-button {
  position: relative;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}

.avatar-button__mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: 50%;
  background: var(--c-scrim);
  color: var(--c-surface);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out-soft);
}

.avatar-button:hover .avatar-button__mask,
.avatar-button:focus-visible .avatar-button__mask {
  opacity: 1;
}

/* 触屏没有 hover：换成右下角的小相机角标，别盖住头像和下面的说明 */
@media (hover: none) {
  .avatar-button__mask {
    inset: auto 0 0 auto;
    width: 30px;
    height: 30px;
    border: var(--border-width) solid var(--c-border);
    background: var(--c-surface);
    color: var(--c-primary-press);
    opacity: 1;
  }

  .avatar-button__mask-text {
    display: none;
  }
}
</style>
