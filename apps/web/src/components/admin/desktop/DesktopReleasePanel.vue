<script setup lang="ts">
import type {
  DesktopRelease,
  DesktopReleaseChannel,
  DesktopReleaseTarget,
} from '@dsh-hub/shared'
import { DESKTOP_RELEASE_CHANNELS, DESKTOP_RELEASE_TARGETS } from '@dsh-hub/shared'
import {
  NButton,
  NDataTable,
  NInput,
  NSelect,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref } from 'vue'

import { publishDesktopRelease, rollbackDesktopRelease } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import DesktopUploadProgress from '@/components/admin/desktop/DesktopUploadProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatBytes, formatDateTime } from '@/composables/useFormat'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import {
  channelLabel,
  isPrerelease,
  shortHash,
  validateVersion,
} from '@/utils/desktop-delivery'

/**
 * 安装包发布与回滚（WP25d 交付物 4，D3 §7.2）。
 *
 * 发布 = 上传安装包（+ Windows 的 blockmap）→ 服务端流式算 sha512、逐字生成 feed YAML；
 * 回滚 = 把比目标更新的同 target+channel 标 `yanked`（产物不删，差分包与回滚都要它），
 * 二次密码确认后才动手。
 */
defineProps<{
  releases: DesktopRelease[]
  loading?: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const target = ref<DesktopReleaseTarget>('win-x64')
const channel = ref<DesktopReleaseChannel>('latest')
const version = ref('')
const installer = ref<File | null>(null)
const blockmap = ref<File | null>(null)
const publishing = ref(false)
const errors = ref<Record<string, string>>({})
const uploadError = ref<string | null>(null)
const uploadErrorDetail = ref<string | null>(null)
const progress = ref<{ percent: number | null; loaded: number; total: number } | null>(null)
const uploadName = ref('')

const targetOptions = DESKTOP_RELEASE_TARGETS.map((value) => ({ label: value, value }))
const channelOptions = DESKTOP_RELEASE_CHANNELS.map((value) => ({ label: channelLabel(value), value }))

function onPickInstaller(event: Event): void {
  const input = event.target as HTMLInputElement
  installer.value = input.files?.[0] ?? null
}

function onPickBlockmap(event: Event): void {
  const input = event.target as HTMLInputElement
  blockmap.value = input.files?.[0] ?? null
}

async function submit(): Promise<void> {
  errors.value = {}
  uploadError.value = null
  uploadErrorDetail.value = null
  const versionError = validateVersion(version.value)
  if (versionError) {
    errors.value = { version: versionError }
    return
  }
  if (channel.value === 'latest' && isPrerelease(version.value.trim())) {
    errors.value = { version: '稳定通道不能发预发布版本' }
    return
  }
  if (!installer.value) {
    errors.value = { installer: '先选安装包' }
    return
  }
  const installerFile = installer.value
  const blockmapFile = blockmap.value

  publishing.value = true
  uploadName.value = installerFile.name
  progress.value = { percent: null, loaded: 0, total: installerFile.size + (blockmapFile?.size ?? 0) }
  try {
    const release = await publishDesktopRelease(
      {
        target: target.value,
        channel: channel.value,
        version: version.value.trim(),
        installer: installerFile,
        blockmap: blockmapFile,
      },
      {
        onProgress: (event) => {
          progress.value = {
            percent: event.total > 0 ? (event.loaded / event.total) * 100 : null,
            loaded: event.loaded,
            total: event.total || installerFile.size,
          }
        },
      },
    )
    progress.value = { percent: 100, loaded: release.installerBytes, total: release.installerBytes }
    message.success(`已发布 ${release.version}（${release.target} / ${channelLabel(release.channel)}）`)
    version.value = ''
    installer.value = null
    blockmap.value = null
    emit('changed')
  } catch (cause) {
    const description = describeError(cause)
    progress.value = null
    uploadError.value = isHubApiError(cause) ? cause.message : description.message
    uploadErrorDetail.value = Object.values(description.fieldErrors)[0] ?? null
    if (description.fieldErrors['version']) errors.value = { version: description.fieldErrors['version'] }
  } finally {
    publishing.value = false
  }
}

/** 回滚：二次密码确认，确认框里写清后果（新版本标 yanked、feed 回到上一版、产物不删） */
async function rollback(row: DesktopRelease): Promise<void> {
  try {
    const result = await sensitive(
      () => rollbackDesktopRelease({ target: row.target, channel: row.channel }),
      {
        title: '确认回滚安装包',
        description: `${row.target} / ${channelLabel(row.channel)}：${row.version} 会标为已撤回，feed 回到上一版（安装包不删除）。已经升上去的设备不会降级。`,
        confirmText: '回滚',
        type: 'warning',
      },
    )
    message.success(`已回滚到 ${result.release.version}（撤回 ${result.yanked.join('、')}）`)
    emit('changed')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

const columns = computed<DataTableColumns<DesktopRelease>>(() => [
  {
    title: '版本',
    key: 'version',
    minWidth: 180,
    render: (row) =>
      h('div', { class: 'release-row', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } }, [
        h('span', { class: 'release-row__name', style: { whiteSpace: 'nowrap' } }, row.version),
        h(
          'span',
          {
            class: 'release-row__sub',
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: row.installerFile,
          },
          row.installerFile,
        ),
      ]),
  },
  {
    title: '平台',
    key: 'target',
    width: 96,
    render: (row) => h('span', { class: 'release-row__mono', style: { whiteSpace: 'nowrap' } }, row.target),
  },
  {
    title: '通道',
    key: 'channel',
    width: 72,
    render: (row) => h(MiniTag, { text: channelLabel(row.channel), tone: row.channel === 'latest' ? 'success' : 'sky', size: 'sm' }),
  },
  {
    title: '大小',
    key: 'bytes',
    width: 88,
    render: (row) =>
      h('span', { class: 'release-row__mono', style: { whiteSpace: 'nowrap' } }, formatBytes(row.installerBytes)),
  },
  {
    title: 'sha512',
    key: 'sha512',
    width: 116,
    render: (row) =>
      h(
        'span',
        {
          class: 'release-row__mono',
          style: { whiteSpace: 'nowrap' },
          title: row.installerSha512,
        },
        shortHash(row.installerSha512),
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 84,
    render: (row) =>
      h(MiniTag, {
        text: row.status === 'published' ? '已发布' : '已撤回',
        tone: row.status === 'published' ? 'success' : 'neutral',
        size: 'sm',
      }),
  },
  {
    title: '发布时间',
    key: 'publishedAt',
    width: 136,
    render: (row) =>
      h('span', { class: 'release-row__time', style: { whiteSpace: 'nowrap' } }, formatDateTime(row.publishedAt)),
  },
  {
    title: '',
    key: 'actions',
    width: 72,
    render: (row) =>
      row.status === 'published'
        ? h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              'data-testid': `desk-release-rollback-${row.id}`,
              onClick: () => void rollback(row),
            },
            { default: () => '回滚' },
          )
        : null,
  },
])
</script>

<template>
  <SoftCard title="安装包发布">
    <template #title-extra>
      <InfoTip
        text="回滚只会让还没升级的设备不再升；已经升到新版本的设备要等下一个正常版本。安装包与 blockmap 永远保留。"
      />
    </template>

    <div class="release-form">
      <label class="release-field">
        <span class="release-field__label">平台</span>
        <NSelect v-model:value="target" size="small" :options="targetOptions" data-testid="desk-release-target" />
      </label>
      <label class="release-field">
        <span class="release-field__label">通道</span>
        <NSelect v-model:value="channel" size="small" :options="channelOptions" data-testid="desk-release-channel" />
      </label>
      <label class="release-field">
        <span class="release-field__label">版本</span>
        <NInput v-model:value="version" size="small" placeholder="0.2.2" data-testid="desk-release-version" />
      </label>
      <label class="release-field release-field--file">
        <span class="release-field__label">安装包</span>
        <input type="file" class="release-file" data-testid="desk-release-installer" @change="onPickInstaller" />
      </label>
      <label class="release-field release-field--file">
        <span class="release-field__label">blockmap</span>
        <input type="file" class="release-file" data-testid="desk-release-blockmap" @change="onPickBlockmap" />
      </label>
      <NButton
        size="small"
        type="primary"
        :loading="publishing"
        :disabled="publishing"
        data-testid="desk-release-publish"
        @click="submit"
      >
        上传并发布
      </NButton>
    </div>

    <p v-if="errors['version']" class="release-error" role="alert" data-testid="desk-release-version-error">
      {{ errors['version'] }}
    </p>
    <p v-if="errors['installer']" class="release-error" role="alert">{{ errors['installer'] }}</p>

    <DesktopUploadProgress
      v-if="progress"
      class="release-progress"
      :percent="progress.percent"
      :loaded="progress.loaded"
      :total="progress.total"
      :file-name="uploadName"
      :error="uploadError"
      :error-detail="uploadErrorDetail"
    />
    <div v-else-if="uploadError" class="release-error" role="alert" data-testid="desk-release-error">
      {{ uploadError }}
      <p v-if="uploadErrorDetail" class="release-error__detail">{{ uploadErrorDetail }}</p>
    </div>

    <NDataTable
      class="release-table"
      :columns="columns"
      :data="releases"
      :loading="loading"
      :row-key="(row: DesktopRelease) => row.id"
      :pagination="false"
      :scroll-x="880"
      size="small"
      data-testid="desk-release-table"
    />
  </SoftCard>
</template>

<style scoped>
.release-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}

.release-field {
  display: flex;
  min-width: 130px;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--space-1);
}

.release-field--file {
  min-width: 200px;
  flex: 1 1 200px;
}

.release-field__label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.release-file {
  width: 100%;
  font-size: var(--fs-13);
}

.release-error__detail {
  font-size: var(--fs-12);
}

.release-error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.release-progress {
  margin-top: var(--space-3);
}

.release-table {
  margin-top: var(--space-4);
}

.release-row {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.release-row__name {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.release-row__sub {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.release-row__mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.release-row__time {
  white-space: nowrap;
}
</style>
