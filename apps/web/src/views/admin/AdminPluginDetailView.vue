<script setup lang="ts">
import type { AdminPluginRow, PluginPolicy, PluginSourceType, PluginUserMatrixItem } from '@dsh-hub/shared'
import {
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NUpload,
  useMessage,
  type DataTableColumns,
  type UploadFileInfo,
} from 'naive-ui'
import { PLUGIN_UPLOAD_MAX_BYTES } from '@dsh-hub/shared'
import { computed, h, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  addPluginVersion,
  deletePlugin,
  deletePluginVersion,
  listPluginUsers,
  listPlugins,
  removePluginPlatform,
  updatePlugin,
  updatePluginPlatform,
  uploadDesktopVersion,
  uploadPluginVersion,
} from '@/api/admin-plugins'
import { listDesktopArtifacts } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import JsonCollapse from '@/components/admin/JsonCollapse.vue'
import YamlEditor from '@/components/admin/YamlEditor.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { useAsyncData } from '@/composables/useAsyncData'
import { pluginSourceText } from '@/composables/job-meta'
import {
  desktopPluginDeliveryLocation,
  pluginDeliveryLocation,
  type PluginDeliveryAction,
} from '@/utils/plugin-delivery'
import { formatBytes, formatDateTime } from '@/composables/useFormat'
import { USER_PLUGIN_STATE_TEXT } from '@/composables/useInstanceStatus'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 插件详情（07 §7.5；docs/22 §2 双平台）：页标题下方一个「云端 | 桌面」切换，**版本按平台显示**。
 *
 * 身份（包名 / 显示名 / 描述 / 图标 / 主页）两平台共用；策略、bundle 顺序、配置 YAML、
 * 版本号按平台各自一套：
 * - 云端：和以前完全一样（`PATCH /plugins/:id` + 版本入库 + 装机矩阵）；
 * - 桌面：设置走 `PATCH /plugins/:id/platforms/desktop`，版本列表是桌面版本（每版都有整包），
 *   「新增版本」只收上传的 `.tgz`（= 创建桌面版本），装机情况改看实例 · 桌面台账。
 */
const { platform, isDesktop } = useAdminPlatform()
const route = useRoute()
const router = useRouter()
const message = useMessage()

const pluginId = computed(() => Number(route.params['id']))

const { data, loading, error, reload } = useAsyncData(async () => {
  // 桌面侧返回的是桌面库视图（版本 / 策略都是桌面的）；插件不在桌面库时这里就是 null
  const list = await listPlugins(isDesktop.value ? 'desktop' : 'cloud')
  return list.find((item) => item.id === pluginId.value) ?? null
})

/** 桌面版本的整包信息（`GET /api/admin/desktop/artifacts`；云端侧不请求） */
const { data: artifactPage, reload: reloadArtifacts } = useAsyncData(() =>
  isDesktop.value ? listDesktopArtifacts() : Promise.resolve(null),
)
const artifactVersionIds = computed(
  () => new Set((artifactPage.value?.items ?? []).map((item) => item.versionId)),
)
// 04 §10.1：装机情况返回全量用户矩阵（row=null 表示从未安装）
const { data: users, reload: reloadUsers } = useAsyncData(() => listPluginUsers(pluginId.value))

const plugin = computed<AdminPluginRow | null>(() => data.value ?? null)
const matrix = computed<PluginUserMatrixItem[]>(() => users.value?.items ?? [])

type InstallFilter = 'all' | 'installed' | 'missing'
const installFilter = ref<InstallFilter>('all')

const matrixCounts = computed(() => {
  const installed = matrix.value.filter((item) => item.row?.desired === 'installed').length
  const missing = matrix.value.filter((item) => item.row === null || item.row.desired !== 'installed').length
  return { installed, missing, total: matrix.value.length }
})

const userRows = computed<PluginUserMatrixItem[]>(() => {
  if (installFilter.value === 'installed')
    return matrix.value.filter((item) => item.row?.desired === 'installed')
  if (installFilter.value === 'missing')
    return matrix.value.filter((item) => item.row === null || item.row.desired !== 'installed')
  return matrix.value
})

const installFilterOptions = computed(() => [
  { label: `全部 ${matrixCounts.value.total}`, value: 'all' },
  { label: `已安装 ${matrixCounts.value.installed}`, value: 'installed' },
  { label: `未安装 ${matrixCounts.value.missing}`, value: 'missing' },
])

watch([pluginId, platform], () => {
  void reload()
  void reloadUsers()
  void reloadArtifacts()
})

// ── 基本信息 ──

const info = ref({
  displayName: '',
  description: '',
  policy: 'optional' as PluginPolicy,
  isBundle: true,
  bundleOrder: 0,
  needsRestart: false,
})

watch(
  plugin,
  (value) => {
    if (!value) return
    info.value = {
      displayName: value.displayName,
      description: value.description,
      policy: value.policy,
      isBundle: value.isBundle,
      bundleOrder: value.bundleOrder,
      needsRestart: value.needsRestart,
    }
  },
  { immediate: true },
)

const savingInfo = ref(false)

async function saveInfo(): Promise<void> {
  savingInfo.value = true
  try {
    if (isDesktop.value) {
      // 身份（显示名 / 描述）两平台共用；策略、顺序、重启是桌面库自己的设置
      await updatePlugin(pluginId.value, {
        displayName: info.value.displayName,
        description: info.value.description,
      })
      await updatePluginPlatform(pluginId.value, 'desktop', {
        policy: info.value.policy,
        bundleOrder: info.value.bundleOrder,
        needsRestart: info.value.needsRestart,
      })
    } else {
      await updatePlugin(pluginId.value, { ...info.value })
    }
    message.success('好的，已保存')
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    savingInfo.value = false
  }
}

// ── 配置 YAML ──

const configYaml = ref('')
const configValid = ref(true)

watch(
  plugin,
  (value) => {
    configYaml.value = value?.configYaml ?? ''
  },
  { immediate: true },
)

const savingConfig = ref(false)

async function saveConfig(): Promise<void> {
  if (!configValid.value) {
    message.error('配置里还有结构错误，请先修正（右侧错误列表可点击定位）')
    return
  }
  savingConfig.value = true
  try {
    if (isDesktop.value) {
      await updatePluginPlatform(pluginId.value, 'desktop', { configYaml: configYaml.value })
    } else {
      await updatePlugin(pluginId.value, { configYaml: configYaml.value })
    }
    message.success(
      isDesktop.value
        ? '桌面配置已保存（下次下发给桌面设备时生效）'
        : '配置已保存（对已安装该插件的用户重渲染 managed.patch.yml）',
    )
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    savingConfig.value = false
  }
}

// ── 版本 ──

const showVersion = ref(false)
const versionSource = ref<PluginSourceType>('npm')
const versionForm = ref({ version: '', url: '', path: '' })
const uploadFile = ref<UploadFileInfo | null>(null)
const versionBusy = ref(false)

/** 04 §10.7：上传上限（shared 常量），超了就地提示，不发请求 */
function onVersionUploadChange(options: { fileList: UploadFileInfo[] }): void {
  const file = options.fileList[0] ?? null
  if (file?.file && file.file.size > PLUGIN_UPLOAD_MAX_BYTES) {
    message.error(`文件 ${formatBytes(file.file.size)} 超过上限 ${formatBytes(PLUGIN_UPLOAD_MAX_BYTES)}`)
    uploadFile.value = null
    return
  }
  uploadFile.value = file
}

async function submitVersion(): Promise<void> {
  versionBusy.value = true
  try {
    if (isDesktop.value) {
      if (!uploadFile.value?.file) {
        message.error('桌面版本必须有整包：请选择 .tgz')
        return
      }
      const created = await uploadDesktopVersion(pluginId.value, uploadFile.value.file)
      message.success(`桌面版本 ${created.version.version} 已入库`)
      showVersion.value = false
      uploadFile.value = null
      await reload()
      await reloadArtifacts()
      return
    }
    if (versionSource.value === 'npm') {
      await addPluginVersion(pluginId.value, { sourceType: 'npm', version: versionForm.value.version.trim() })
    } else if (versionSource.value === 'tarball') {
      await addPluginVersion(pluginId.value, {
        sourceType: 'tarball',
        url: versionForm.value.url.trim(),
        version: versionForm.value.version.trim(),
      })
    } else if (versionSource.value === 'local') {
      await addPluginVersion(pluginId.value, { sourceType: 'local', path: versionForm.value.path.trim() })
    } else if (uploadFile.value?.file) {
      await uploadPluginVersion(pluginId.value, uploadFile.value.file, uploadFile.value.name)
    }

    message.success('版本已入库')
    showVersion.value = false
    versionForm.value = { version: '', url: '', path: '' }
    uploadFile.value = null
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    versionBusy.value = false
  }
}

async function removeVersion(versionId: number, version: string): Promise<void> {
  try {
    await sensitive(() => deletePluginVersion(pluginId.value, versionId), {
      title: `删除版本 ${version}`,
      description: '已安装该版本的用户需要重新下发，确定继续吗？',
      confirmText: '删除',
      type: 'error',
    })
    message.success('版本已删除')
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

async function removePlugin(): Promise<void> {
  const current = plugin.value
  if (!current) return
  try {
    await sensitive(() => deletePlugin(current.id), {
      title: `删除插件 ${current.displayName}`,
      description: '仍有用户安装时会被拒绝（需要先下发卸载）。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('插件已删除')
    await router.push('/admin/plugins')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

/**
 * 与插件库列表上的批量按钮同一个行为（WP28c 交付物 3）：跳统一下发向导并预填，
 * 版本缺省最新，预览与二次密码都在向导里。
 */
function deliver(action: PluginDeliveryAction): void {
  const { path, query } = isDesktop.value
    ? desktopPluginDeliveryLocation(action, [pluginId.value])
    : pluginDeliveryLocation(action, [pluginId.value])
  void router.push({ path, query })
}

/** 桌面侧把插件移出桌面库（有下发目标时服务端拒绝 → 提示去插件库页带 force 处理） */
async function removeFromDesktop(): Promise<void> {
  const current = plugin.value
  if (!current) return
  try {
    await sensitive(() => removePluginPlatform(current.id, 'desktop'), {
      title: `把 ${current.displayName} 移出桌面插件库`,
      description: '云端库不受影响；还有桌面下发目标时会被拒绝，需要到插件库页撤销目标再移出。',
      confirmText: '移出',
      type: 'error',
    })
    message.success('已移出桌面插件库')
    await router.push('/admin/plugins?platform=desktop')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

const versionColumns = computed<DataTableColumns<AdminPluginRow['versions'][number]>>(() => [
  { title: '版本', key: 'version', width: 120 },
  ...(isDesktop.value
    ? [
        {
          title: '整包',
          key: 'artifact',
          width: 100,
          render: (row: AdminPluginRow['versions'][number]) =>
            h(MiniTag, {
              text: artifactVersionIds.value.has(row.id) ? '已上传' : '缺整包',
              tone: artifactVersionIds.value.has(row.id) ? ('success' as const) : ('danger' as const),
              size: 'sm',
            }),
        },
      ]
    : []),
  { title: '来源', key: 'sourceType', width: 110, render: (row) => pluginSourceText(row.sourceType) },
  { title: '引用', key: 'spec', minWidth: 200 },
  { title: 'minDsh', key: 'minDsh', width: 100, render: (row) => row.minDsh ?? '—' },
  {
    title: 'sha256',
    key: 'sha256',
    width: 140,
    render: (row) => (row.sha256 ? `${row.sha256.slice(0, 12)}…` : '—'),
  },
  { title: '创建时间', key: 'createdAt', width: 160, render: (row) => formatDateTime(row.createdAt) },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', type: 'error', ghost: true, onClick: () => void removeVersion(row.id, row.version) },
        { default: () => '删除' },
      ),
  },
])

const userColumns = computed<DataTableColumns<PluginUserMatrixItem>>(() => [
  {
    title: '用户',
    key: 'user',
    width: 200,
    render: (item) => h(UserCell, { user: item.user, to: `/admin/users/${item.user.id}` }),
  },
  {
    title: '安装情况',
    key: 'installed',
    width: 110,
    render: (item) =>
      item.row
        ? h(MiniTag, {
            text: item.row.desired === 'installed' ? '已安装' : '已卸载',
            tone: item.row.desired === 'installed' ? 'primary' : 'neutral',
            size: 'sm',
          })
        : h(MiniTag, { text: '未安装', tone: 'neutral', size: 'sm' }),
  },
  {
    title: '期望',
    key: 'desired',
    width: 90,
    render: (item) => (item.row ? (item.row.desired === 'installed' ? '安装' : '不安装') : '—'),
  },
  { title: '实际版本', key: 'actualVersion', width: 110, render: (item) => item.row?.actualVersion ?? '—' },
  {
    title: '同步状态',
    key: 'state',
    width: 100,
    render: (item) =>
      item.row
        ? h(MiniTag, {
            text: USER_PLUGIN_STATE_TEXT[item.row.state] ?? item.row.state,
            tone:
              item.row.state === 'synced' ? 'success' : item.row.state === 'pending' ? 'butter' : 'danger',
            size: 'sm',
          })
        : '—',
  },
  { title: '错误', key: 'error', minWidth: 160, render: (item) => item.row?.error ?? '—' },
  {
    title: '更新时间',
    key: 'updatedAt',
    width: 150,
    render: (item) => (item.row ? formatDateTime(item.row.updatedAt) : '—'),
  },
])
</script>

<template>
  <AdminPage
    :title="plugin ? plugin.displayName : '插件详情'"
    :subtitle="plugin ? plugin.packageName : undefined"
    back-to="/admin/plugins"
    back-text="返回插件列表"
    :platform="platform"
  >
    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <template #actions>
      <NButton v-if="plugin" size="small" type="primary" @click="deliver('install')">下发 / 安装</NButton>
      <NButton v-if="plugin" size="small" @click="deliver('upgrade')">
        {{ isDesktop ? '升级已安装设备' : '升级已安装用户' }}
      </NButton>
      <NButton v-if="!isDesktop" size="small" type="error" ghost @click="removePlugin">删除插件</NButton>
      <NButton v-else-if="plugin" size="small" type="error" ghost @click="removeFromDesktop">移出桌面库</NButton>
    </template>

    <AdminErrorNotice :error="error" title="插件加载失败" @retry="reload" />

    <SoftCard v-if="!plugin && loading">
      <p class="text-2">正在加载插件…</p>
    </SoftCard>

    <EmptyState
      v-else-if="!plugin && isDesktop"
      title="这个插件不在桌面插件库"
      description="桌面插件要有自己的版本与整包；到插件页的桌面侧上传整包或加入桌面库。"
      action-text="去桌面插件库"
      @action="router.push('/admin/plugins?platform=desktop')"
    />

    <template v-else-if="plugin">
      <SoftCard title="基本信息">
        <template #extra>
          <div class="plugin-detail__tags">
            <MiniTag :text="`装机 ${plugin.stats.installed}`" tone="primary" size="sm" />
            <MiniTag :text="`待装 ${plugin.stats.pending}`" tone="butter" size="sm" />
            <MiniTag
              :text="`失败 ${plugin.stats.failed}`"
              :tone="plugin.stats.failed > 0 ? 'danger' : 'neutral'"
              size="sm"
            />
          </div>
        </template>

        <NForm label-placement="top" size="small" class="plugin-detail__form">
          <NFormItem label="显示名">
            <NInput v-model:value="info.displayName" />
          </NFormItem>
          <NFormItem label="描述">
            <NInput v-model:value="info.description" type="textarea" :rows="2" />
          </NFormItem>
          <NFormItem label="策略">
            <NSelect
              v-model:value="info.policy"
              :options="[
                { label: 'required · 必装', value: 'required' },
                { label: 'default · 默认装', value: 'default' },
                { label: 'optional · 可选', value: 'optional' },
                { label: 'hidden · 下线', value: 'hidden' },
              ]"
            />
          </NFormItem>
          <NFormItem label="bundle 顺序">
            <NInputNumber v-model:value="info.bundleOrder" :min="0" :max="9999" />
          </NFormItem>
        </NForm>

        <div class="plugin-detail__switches">
          <NButton
            size="small"
            :type="info.isBundle ? 'primary' : 'default'"
            @click="info.isBundle = !info.isBundle"
          >
            {{ info.isBundle ? '写入 bundles' : '不写入 bundles' }}
          </NButton>
          <NButton
            size="small"
            :type="info.needsRestart ? 'warning' : 'default'"
            @click="info.needsRestart = !info.needsRestart"
          >
            {{ info.needsRestart ? '安装后需要重启' : '安装后无需重启' }}
          </NButton>
        </div>

        <div class="plugin-detail__actions">
          <NButton size="small" type="primary" :loading="savingInfo" @click="saveInfo">保存基本信息</NButton>
        </div>
      </SoftCard>

      <SoftCard :title="isDesktop ? '桌面版本' : '版本列表'">
        <template #extra>
          <NButton size="tiny" type="primary" ghost @click="showVersion = true">
            {{ isDesktop ? '上传整包' : '新增版本' }}
          </NButton>
        </template>

        <NDataTable
          :columns="versionColumns"
          :data="plugin.versions"
          :row-key="(row: AdminPluginRow['versions'][number]) => row.id"
          :scroll-x="880"
          size="small"
          :pagination="false"
        />
      </SoftCard>

      <SoftCard title="配置（YAML）">
        <template #extra>
          <span class="text-3 text-[12px]">注入 managed.patch.yml 的 patch 条目数组</span>
        </template>
        <YamlEditor
          v-model="configYaml"
          :package-name="plugin.packageName"
          :height="300"
          @validity="(result) => (configValid = result.ok)"
        />
        <div class="plugin-detail__actions">
          <NButton
            size="small"
            type="primary"
            :disabled="!configValid"
            :loading="savingConfig"
            @click="saveConfig"
          >
            保存配置
          </NButton>
        </div>
      </SoftCard>

      <SoftCard v-if="isDesktop" title="装机情况">
        <template #title-extra>
          <InfoTip text="桌面侧的装机按设备上报（不是按用户），逐台状态与吊销在实例页的桌面设备台账里。" />
        </template>
        <template #extra>
          <RouterLink class="hub-link plugin-detail__link" to="/admin/instances?platform=desktop">
            实例 · 桌面台账
          </RouterLink>
        </template>
      </SoftCard>

      <SoftCard v-else title="装机情况">
        <template #extra>
          <div class="plugin-detail__matrix-head">
            <NSelect
              v-model:value="installFilter"
              size="tiny"
              class="plugin-detail__filter"
              :options="installFilterOptions"
              aria-label="筛选安装情况"
            />
            <NButton size="tiny" quaternary @click="reloadUsers">刷新</NButton>
          </div>
        </template>
        <NDataTable
          :columns="userColumns"
          :data="userRows"
          :row-key="(item: PluginUserMatrixItem) => `${item.user.id}`"
          :scroll-x="920"
          size="small"
          :pagination="{ pageSize: 10 }"
        />
      </SoftCard>

      <SoftCard title="原始数据">
        <JsonCollapse label="插件 JSON（便于排查）" :value="plugin" />
      </SoftCard>
    </template>

    <!-- 新增版本 -->
    <NModal
      v-model:show="showVersion"
      preset="card"
      :title="isDesktop ? '上传桌面整包（创建桌面版本）' : '新增版本'"
      :style="{ maxWidth: '480px' }"
    >
      <NRadioGroup v-if="!isDesktop" v-model:value="versionSource" size="small" class="mb-3">
        <NRadioButton value="npm">npm</NRadioButton>
        <NRadioButton value="tarball">tarball</NRadioButton>
        <NRadioButton value="local">本地目录</NRadioButton>
        <NRadioButton value="upload">上传 tgz</NRadioButton>
      </NRadioGroup>

      <p v-if="isDesktop" class="plugin-detail__hint">
        桌面版本号取包内 package.json；服务端会校验包名、密钥与 patch 文件，codex 整包必须带 LICENSE 与 NOTICE。
      </p>

      <NForm label-placement="top" size="small">
        <NFormItem v-if="versionSource === 'npm'" label="版本号" required>
          <NInput v-model:value="versionForm.version" placeholder="0.16.0（精确版本，不用 ^）" />
        </NFormItem>
        <NFormItem v-if="versionSource === 'tarball'" label="tarball 地址" required>
          <NInput v-model:value="versionForm.url" placeholder="https://…/pkg-1.0.0.tgz" />
        </NFormItem>
        <NFormItem v-if="versionSource === 'tarball'" label="版本标签" required>
          <NInput v-model:value="versionForm.version" placeholder="1.0.0" />
        </NFormItem>
        <NFormItem v-if="versionSource === 'local'" label="宿主目录" required>
          <NInput v-model:value="versionForm.path" placeholder="/path/to/plugin" />
        </NFormItem>
        <NFormItem v-if="isDesktop || versionSource === 'upload'" label="选择 .tgz">
          <NUpload :max="1" :default-upload="false" accept=".tgz,.tar.gz" @change="onVersionUploadChange">
            <NButton size="small">选择文件</NButton>
          </NUpload>
        </NFormItem>
      </NForm>

      <template #footer>
        <div class="plugin-detail__modal-footer">
          <NButton size="small" @click="showVersion = false">取消</NButton>
          <NButton size="small" type="primary" :loading="versionBusy" @click="submitVersion">
            {{ isDesktop ? '上传' : '入库' }}
          </NButton>
        </div>
      </template>
    </NModal>
  </AdminPage>
</template>

<style scoped>
.plugin-detail__form {
  display: grid;
  gap: var(--space-3) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.plugin-detail__matrix-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.plugin-detail__filter {
  width: 130px;
}

.plugin-detail__tags {
  display: flex;
  gap: var(--space-1);
}

.plugin-detail__switches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.plugin-detail__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.plugin-detail__link {
  font-size: var(--fs-13);
  white-space: nowrap;
}

.plugin-detail__hint {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.plugin-detail__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
