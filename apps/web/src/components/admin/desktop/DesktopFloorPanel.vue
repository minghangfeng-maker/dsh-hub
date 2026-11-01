<script setup lang="ts">
import type { DesktopUpdateFloor } from '@dsh-hub/shared'
import { NButton, NInput, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { updateDesktopFloor } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import SoftCard from '@/components/base/SoftCard.vue'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'
import {
  FLOOR_DETAIL_MAX,
  FLOOR_TITLE_MAX,
  floorForm,
  validateFloor,
} from '@/utils/desktop-delivery'

/**
 * 强更地板（D3 §1.4 / 裁决 #13）：低于这个版本的桌面端（含**登录前**）
 * 会收到匿名 `GET /api/v0/check_client_update` 的 40005，弹「必须更新」。
 *
 * 保存前给出弹窗预览与字数：标题 ≤256、说明 ≤16384，超了服务端 400。
 */
const props = defineProps<{ floor: DesktopUpdateFloor | null }>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const form = ref(floorForm(props.floor))
const errors = ref<Record<string, string>>({})
const saving = ref(false)

watch(
  () => props.floor,
  (floor) => {
    form.value = floorForm(floor)
    errors.value = {}
  },
  { immediate: true },
)

const titleCount = computed(() => form.value.title.length)
const detailCount = computed(() => form.value.detail.length)

/** 预览里只关心「会显示什么」，不模拟窗口尺寸 */
const previewLink = computed(() => form.value.appLink.trim())

async function save(): Promise<void> {
  errors.value = validateFloor(form.value)
  if (Object.keys(errors.value).length > 0) return
  saving.value = true
  try {
    const response = await withReauth(() =>
      updateDesktopFloor({
        minVersion: form.value.minVersion.trim() === '' ? null : form.value.minVersion.trim(),
        title: form.value.title,
        detail: form.value.detail,
        appLink: previewLink.value === '' ? null : previewLink.value,
      }),
    )
    message.success(
      response.floor.minVersion === null
        ? '已关闭强更（不再拦截旧版本）'
        : `强更地板已保存：${response.floor.minVersion}`,
    )
    emit('changed')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SoftCard title="强更地板">
    <div class="floor">
      <div class="floor__form">
        <label class="floor-field">
          <span class="floor-field__label">最低版本</span>
          <NInput
            v-model:value="form.minVersion"
            size="small"
            placeholder="留空 = 不强制"
            data-testid="desk-floor-version"
          />
        </label>
        <label class="floor-field">
          <span class="floor-field__label">
            标题
            <span class="floor-field__count">{{ titleCount }} / {{ FLOOR_TITLE_MAX }}</span>
          </span>
          <NInput v-model:value="form.title" size="small" data-testid="desk-floor-title" />
        </label>
        <label class="floor-field">
          <span class="floor-field__label">
            说明
            <span class="floor-field__count">{{ detailCount }} / {{ FLOOR_DETAIL_MAX }}</span>
          </span>
          <NInput
            v-model:value="form.detail"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            data-testid="desk-floor-detail"
          />
        </label>
        <label class="floor-field">
          <span class="floor-field__label">打开链接</span>
          <NInput
            v-model:value="form.appLink"
            size="small"
            placeholder="https://…（留空 = 不显示按钮）"
            data-testid="desk-floor-link"
          />
        </label>

        <p v-if="errors['minVersion']" class="floor-error" role="alert">{{ errors['minVersion'] }}</p>
        <p v-if="errors['title']" class="floor-error" role="alert">{{ errors['title'] }}</p>
        <p v-if="errors['detail']" class="floor-error" role="alert">{{ errors['detail'] }}</p>
        <p v-if="errors['appLink']" class="floor-error" role="alert" data-testid="desk-floor-link-error">
          {{ errors['appLink'] }}
        </p>

        <div class="floor__actions">
          <NButton size="small" type="primary" :loading="saving" data-testid="desk-floor-save" @click="save">
            保存
          </NButton>
        </div>
      </div>

      <div class="floor__preview" data-testid="desk-floor-preview">
        <div class="floor__preview-card" role="presentation">
          <p class="floor__preview-title">{{ form.title || '标题' }}</p>
          <p class="floor__preview-body">{{ form.detail || '说明' }}</p>
          <div class="floor__preview-actions">
            <span v-if="previewLink" class="floor__preview-link">打开网页</span>
            <span class="floor__preview-button">退出</span>
          </div>
        </div>
      </div>
    </div>
  </SoftCard>
</template>

<style scoped>
.floor {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
}

.floor__form {
  display: flex;
  min-width: 280px;
  flex: 1 1 340px;
  flex-direction: column;
  gap: var(--space-3);
}

.floor-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.floor-field__label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.floor-field__count {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.floor-error {
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.floor__actions {
  display: flex;
  justify-content: flex-end;
}

.floor__preview {
  display: flex;
  min-width: 240px;
  flex: 0 1 300px;
  align-items: flex-start;
  justify-content: center;
}

.floor__preview-card {
  width: 100%;
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-bg);
  box-shadow: var(--shadow-card);
}

.floor__preview-title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.floor__preview-body {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-14);
  white-space: pre-wrap;
}

.floor__preview-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.floor__preview-link {
  color: var(--c-primary-press);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.floor__preview-button {
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-13);
  white-space: nowrap;
}
</style>
