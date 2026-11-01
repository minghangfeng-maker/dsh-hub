<script setup lang="ts">
import type { MobileAppRelease } from '@dsh-hub/shared'
import { NButton, NInput, NInputNumber, NTag, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import {
  fetchMobileAppReleases,
  publishMobileAppRelease,
  rollbackMobileAppRelease,
} from '@/api/admin-mobile-app'
import { updateSettings } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'

/**
 * 系统设置 · 安卓 App（WP40r）。
 *
 * 这个卡片做三件事：
 * 1. **上传 APK 即发布**：文件名由服务端按「版本号 + sha256 前 8 位」生成（内容寻址），
 *    旧的记录自动 yank；主页右卡与 `bootstrap.app` 立刻指向新版本，不用再手填地址；
 * 2. **回滚**：只切状态，文件保留，所以回滚不需要重新上传；
 * 3. **版本地板**：`minVersionCode` 门 App 的最低版本；`downloadUrl` 留空 = 用当前发布记录
 *    的地址（推荐），填 URL = 托管到 CDN（例如以后的正式签名分发）。
 *
 * 主页显示的是「当前发布」；`latestVersionCode` 取「发布记录」与「设置」的较大者，所以在
 * 这里改设置不会把 App 的更新提示调低。
 */
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => fetchMobileAppReleases())

const version = ref('')
const versionCode = ref<number | null>(null)
const file = ref<File | null>(null)
const uploading = ref(false)
const uploadError = ref('')

const minVersionCode = ref(1)
const downloadUrl = ref('')
const saving = ref(false)
const saveError = ref('')

watch(
  data,
  (value) => {
    if (!value) return
    minVersionCode.value = value.settings.minVersionCode
    downloadUrl.value = value.settings.downloadUrl ?? ''
    // 默认把「下一版」预填成当前 +1，省得每次手敲
    versionCode.value = (value.current?.versionCode ?? value.settings.latestVersionCode) + 1
  },
  { immediate: true },
)

const current = computed<MobileAppRelease | null>(() => data.value?.current ?? null)
const history = computed<MobileAppRelease[]>(() =>
  (data.value?.items ?? []).filter((item) => item.id !== current.value?.id),
)
const canRollback = computed(() =>
  (data.value?.items ?? []).some((item) => item.id !== current.value?.id && item.versionCode < (current.value?.versionCode ?? 0)),
)
const settingsDirty = computed(() => {
  if (!data.value) return false
  return (
    data.value.settings.minVersionCode !== minVersionCode.value ||
    (data.value.settings.downloadUrl ?? '') !== downloadUrl.value
  )
})

function bytesText(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function pickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
}

async function upload(): Promise<void> {
  uploadError.value = ''
  if (!file.value) {
    uploadError.value = '先选择 APK 文件'
    return
  }
  if (version.value.trim().length === 0) {
    uploadError.value = '先填版本号，例如 0.2.1'
    return
  }
  if (versionCode.value === null || versionCode.value < 1) {
    uploadError.value = 'versionCode 必须是正整数'
    return
  }
  uploading.value = true
  try {
    const release = await publishMobileAppRelease({
      version: version.value.trim(),
      versionCode: versionCode.value,
      apk: file.value,
    })
    message.success(`已发布 ${release.versionName}（versionCode ${String(release.versionCode)}）`)
    file.value = null
    await reload()
  } catch (cause) {
    uploadError.value = describeError(cause).message
  } finally {
    uploading.value = false
  }
}

async function rollback(): Promise<void> {
  uploadError.value = ''
  try {
    const result = await rollbackMobileAppRelease()
    message.success(`已回滚到 ${result.release.versionName}`)
    await reload()
  } catch (cause) {
    uploadError.value = describeError(cause).message
  }
}

async function saveSettings(): Promise<void> {
  saveError.value = ''
  if (!data.value) return
  const url = downloadUrl.value.trim()
  if (url.length > 0 && !/^https?:\/\//u.test(url)) {
    saveError.value = '下载地址要以 http:// 或 https:// 开头，或者留空用发布记录里的地址'
    return
  }
  saving.value = true
  try {
    await updateSettings({
      mobile: {
        app: {
          minVersionCode: minVersionCode.value,
          // 保留服务端当前值：App 的更新提示以「发布记录」为主，这里不主动降它
          latestVersionCode: data.value.settings.latestVersionCode,
          downloadUrl: url.length === 0 ? null : url,
        },
      },
    })
    message.success('设置已保存')
    await reload()
  } catch (cause) {
    saveError.value = describeError(cause).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SoftCard title="安卓 App" data-testid="mobile-app-settings-section">
    <template #extra>
      <NButton size="tiny" quaternary :loading="loading" data-testid="mobile-app-refresh" @click="reload">
        刷新
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="安卓发布记录加载失败" @retry="reload" />

    <div class="mobile-app__current" data-testid="mobile-app-current">
      <template v-if="current">
        <div class="mobile-app__row">
          <NTag type="success" size="small">当前发布</NTag>
          <strong>v{{ current.versionName }}</strong>
          <span class="mobile-app__muted">
            versionCode {{ current.versionCode }} · {{ bytesText(current.bytes) }}
          </span>
        </div>
        <div class="mobile-app__row mobile-app__muted">
          下载地址 <code>{{ current.path }}</code>
          <InfoTip text="主页右卡与 App 的 bootstrap.app.downloadUrl 都指向这里；文件名带 sha256 前 8 位，所以可以长期缓存。" />
        </div>
        <div class="mobile-app__row mobile-app__muted">
          上传于 {{ current.uploadedAt }}
        </div>
      </template>
      <p v-else class="mobile-app__muted" data-testid="mobile-app-empty">
        还没有发布过 APK。上传一个后，主页右卡与 App 的更新提示会自动出现。
      </p>
    </div>

    <p class="mobile-app__label">发布新版本</p>
    <div class="mobile-app__form">
      <NInput
        v-model:value="version"
        size="small"
        placeholder="版本号，例如 0.2.1"
        class="mobile-app__input-version"
        data-testid="mobile-app-version"
      />
      <NInputNumber
        v-model:value="versionCode"
        size="small"
        :min="1"
        :max="10000000"
        placeholder="versionCode"
        class="mobile-app__input-code"
        data-testid="mobile-app-version-code"
      />
      <input
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        class="mobile-app__file"
        data-testid="mobile-app-file"
        @change="pickFile"
      />
      <NButton
        size="small"
        type="primary"
        :loading="uploading"
        data-testid="mobile-app-upload"
        @click="upload"
      >
        上传并发布
      </NButton>
      <NButton
        v-if="canRollback"
        size="small"
        :disabled="uploading"
        data-testid="mobile-app-rollback"
        @click="rollback"
      >
        回滚到上一版
      </NButton>
    </div>
    <p v-if="uploadError" class="mobile-app__error" data-testid="mobile-app-upload-error">{{ uploadError }}</p>

    <div v-if="history.length > 0" class="mobile-app__history" data-testid="mobile-app-history">
      <p class="mobile-app__label">历史版本</p>
      <ul>
        <li v-for="item in history" :key="item.id">
          <NTag size="small" :type="item.status === 'published' ? 'success' : 'default'">
            {{ item.status === 'published' ? '已发布' : '已下线' }}
          </NTag>
          <span>v{{ item.versionName }}（{{ item.versionCode }}）· {{ bytesText(item.bytes) }} · {{ item.uploadedAt }}</span>
        </li>
      </ul>
    </div>

    <p class="mobile-app__label">版本地板与下载地址</p>
    <div class="mobile-app__form">
      <NInputNumber
        v-model:value="minVersionCode"
        size="small"
        :min="1"
        :max="10000000"
        data-testid="mobile-app-min-version-code"
      />
      <span class="mobile-app__muted">最低 versionCode（低于它 App 提示必须更新）</span>
      <NInput
        v-model:value="downloadUrl"
        size="small"
        placeholder="留空 = 用当前发布记录的地址（推荐）"
        class="mobile-app__input-url"
        data-testid="mobile-app-download-url"
      />
      <NButton
        size="small"
        :disabled="!settingsDirty"
        :loading="saving"
        data-testid="mobile-app-save-settings"
        @click="saveSettings"
      >
        保存设置
      </NButton>
    </div>
    <p v-if="saveError" class="mobile-app__error" data-testid="mobile-app-save-error">{{ saveError }}</p>
  </SoftCard>
</template>

<style scoped>
.mobile-app__current {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control-sm);
  background: var(--c-surface-muted);
}

.mobile-app__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-13);
}

.mobile-app__muted {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.mobile-app__label {
  margin: 4px 0 8px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
  font-weight: 600;
}

.mobile-app__form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.mobile-app__input-version {
  width: 160px;
}

.mobile-app__input-code {
  width: 140px;
}

.mobile-app__input-url {
  width: 320px;
}

.mobile-app__file {
  font-size: var(--fs-13);
}

.mobile-app__history ul {
  margin: 0;
  padding-left: 18px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.mobile-app__error {
  margin-top: 8px;
  color: var(--c-danger);
  font-size: var(--fs-13);
}
</style>
