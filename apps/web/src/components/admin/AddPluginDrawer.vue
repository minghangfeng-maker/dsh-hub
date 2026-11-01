<script setup lang="ts">
import type { PluginLookupResponse, PluginPlatform, PluginPolicy, PluginSourceType } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSteps,
  NStep,
  NUpload,
  type UploadFileInfo,
} from 'naive-ui'
import { PLUGIN_UPLOAD_MAX_BYTES } from '@dsh-hub/shared'
import { computed, ref, watch } from 'vue'

import {
  addPluginVersion,
  createPlugin,
  deletePlugin,
  lookupPlugin,
  lookupPluginUpload,
  updatePlugin,
  uploadPluginVersion,
} from '@/api/admin-plugins'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import { pluginPolicyText } from '@/composables/job-meta'
import { formatBytes } from '@/composables/useFormat'

/**
 * 「添加插件」三步抽屉（07 §7.5）：
 * ① 选来源（npm / 本地目录 / tarball URL / 上传 tgz）→ ② 自动读取元数据并确认 →
 * ③ 完成后可直接「下发」（跳到下发向导并预填插件）。
 *
 * npm、本地目录、上传的 `.tgz` 走 `plugins/lookup` 自动读取（上传由服务端读包内 `package.json`，
 * 包名 / 描述 / 版本都自动填好）；tarball 需要手填元数据。
 */
const props = defineProps<{
  show: boolean
  /**
   * 新建到哪个平台的库（docs/22 §2.2）：缺省云端；插件页切到桌面时传 `desktop`，
   * 创建 + 首个版本都落到桌面库（桌面版本必须有整包，所以要选「上传 tgz」）。
   */
  platform?: PluginPlatform
}>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 插件创建完成（父页刷新列表） */
  created: [pluginId: number]
  /** 点「立即下发」 */
  rollout: [pluginId: number]
}>()

const step = ref(0)
const source = ref<PluginSourceType>('npm')
const loading = ref(false)
const errorText = ref('')

const npmName = ref('')
const localPath = ref('')
const tarballUrl = ref('')
const tarballVersion = ref('')
const uploadFile = ref<UploadFileInfo | null>(null)

const lookup = ref<PluginLookupResponse | null>(null)
const createdId = ref<number | null>(null)

const form = ref({
  packageName: '',
  displayName: '',
  description: '',
  policy: 'optional' as PluginPolicy,
  isBundle: true,
  bundleOrder: 0,
  needsRestart: false,
  version: '',
})

const policyOptions = [
  { label: 'required · 必装（用户不能卸载）', value: 'required' },
  { label: 'default · 新用户默认安装', value: 'default' },
  { label: 'optional · 可选（用户自助安装）', value: 'optional' },
  { label: 'hidden · 下线（不在列表展示）', value: 'hidden' },
]

const sourceOptions: { label: string; value: PluginSourceType; icon: string }[] = [
  { label: 'npm 包', value: 'npm', icon: 'i-ph-package' },
  { label: '本地目录', value: 'local', icon: 'i-ph-folder' },
  { label: 'tarball URL', value: 'tarball', icon: 'i-ph-link' },
  { label: '上传 tgz', value: 'upload', icon: 'i-ph-upload-simple' },
]

watch(
  () => props.show,
  (visible) => {
    if (!visible) reset()
  },
)

function reset(): void {
  step.value = 0
  lookup.value = null
  createdId.value = null
  errorText.value = ''
  uploadFile.value = null
  npmName.value = ''
  localPath.value = ''
  tarballUrl.value = ''
  tarballVersion.value = ''
  form.value = {
    packageName: '',
    displayName: '',
    description: '',
    policy: 'optional',
    isBundle: true,
    bundleOrder: 0,
    needsRestart: false,
    version: '',
  }
}

/** ① → ②：能自动读元数据的先读，读不到的留给用户手填。 */
async function goConfirm(): Promise<void> {
  errorText.value = ''

  if (source.value === 'npm' && !npmName.value.trim()) {
    errorText.value = '请填写 npm 包名'
    return
  }
  if (source.value === 'local' && !localPath.value.trim()) {
    errorText.value = '请填写宿主上的插件目录（绝对路径）'
    return
  }
  if (source.value === 'tarball') {
    if (!tarballUrl.value.trim()) {
      errorText.value = '请填写 tarball 地址'
      return
    }
    if (!tarballVersion.value.trim()) {
      errorText.value = '请填写版本标签（写进 package.json 的 spec）'
      return
    }
    step.value = 1
    return
  }
  const uploaded = uploadFile.value
  if (source.value === 'upload' && !uploaded?.file) {
    errorText.value = '请选择要上传的 .tgz 文件'
    return
  }

  loading.value = true
  try {
    const result =
      source.value === 'upload' && uploaded?.file
        ? await lookupPluginUpload(uploaded.file, uploaded.name)
        : source.value === 'npm'
          ? await lookupPlugin({ source: 'npm', name: npmName.value.trim() })
          : await lookupPlugin({ source: 'local', path: localPath.value.trim() })

    lookup.value = result
    form.value = {
      ...form.value,
      packageName: result.packageName,
      displayName: result.displayName || result.packageName,
      description: result.description,
      isBundle: result.isBundle,
      needsRestart: result.needsRestart ?? false,
      version: result.latest ?? result.versions[0] ?? '',
    }
    step.value = 1
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    loading.value = false
  }
}

/** ② → ③：创建插件（+ 首个版本），失败留在原地。 */
async function submit(): Promise<void> {
  errorText.value = ''
  if (!form.value.packageName.trim()) {
    errorText.value = '请填写包名'
    return
  }
  if (!form.value.displayName.trim()) {
    errorText.value = '请填写显示名'
    return
  }

  loading.value = true
  try {
    const target = props.platform ?? 'cloud'
    const created = await createPlugin({
      platform: target,
      packageName: form.value.packageName.trim(),
      displayName: form.value.displayName.trim(),
      description: form.value.description || undefined,
      policy: form.value.policy,
      isBundle: form.value.isBundle,
      bundleOrder: form.value.bundleOrder,
      needsRestart: form.value.needsRestart,
    })
    createdId.value = created.id
    emit('created', created.id)

    // 首个版本：四种来源各走各的接口（上传走 multipart）
    if (source.value === 'npm' && form.value.version) {
      await addPluginVersion(created.id, { sourceType: 'npm', version: form.value.version.trim(), platform: target })
    } else if (source.value === 'local') {
      await addPluginVersion(created.id, { sourceType: 'local', path: localPath.value.trim(), platform: target })
    } else if (source.value === 'tarball') {
      await addPluginVersion(created.id, {
        sourceType: 'tarball',
        url: tarballUrl.value.trim(),
        version: tarballVersion.value.trim(),
        platform: target,
      })
    } else if (source.value === 'upload' && uploadFile.value?.file) {
      await uploadPluginVersion(created.id, uploadFile.value.file, uploadFile.value.name, target)
    }

    // 云端：策略在创建后再确认一次（历史行为）；桌面侧的策略创建时已按 platform 写入，不能再 PATCH 云端行
    if (target !== 'desktop' && (form.value.policy === 'required' || form.value.policy === 'default')) {
      await updatePlugin(created.id, { policy: form.value.policy })
    }

    step.value = 2
    emit('created', created.id)
  } catch (error) {
    errorText.value = describeError(error).message
    await rollbackCreated()
  } finally {
    loading.value = false
  }
}

/**
 * 目录条目建成了、但首个版本没入库（密钥扫描没过、包名不符、缺 patch 文件…）：把空壳条目删掉，
 * 否则它留在目录里，再点「创建插件」会 409「已在目录里」。回滚后改完表单可以直接重来。
 */
async function rollbackCreated(): Promise<void> {
  const id = createdId.value
  if (id === null) return
  createdId.value = null
  try {
    await deletePlugin(id)
  } catch {
    errorText.value += '（目录里留下了一条没有版本的空条目，请到插件列表里手动删除）'
  }
  emit('created', id)
}

function onUploadChange(options: { fileList: UploadFileInfo[] }): void {
  const file = options.fileList[0] ?? null

  // 04 §10.7：上传上限（shared 常量）；超了先在这里挡一次，省得白传一遍
  if (file?.file && file.file.size > PLUGIN_UPLOAD_MAX_BYTES) {
    errorText.value = `文件 ${formatBytes(file.file.size)} 超过上限 ${formatBytes(PLUGIN_UPLOAD_MAX_BYTES)}`
    uploadFile.value = null
    return
  }

  errorText.value = ''
  uploadFile.value = file
}

function onRollout(): void {
  if (createdId.value === null) return
  emit('rollout', createdId.value)
  emit('update:show', false)
}

const canNext = computed(() => {
  if (source.value === 'npm') return Boolean(npmName.value.trim())
  if (source.value === 'local') return Boolean(localPath.value.trim())
  if (source.value === 'tarball') return Boolean(tarballUrl.value.trim() && tarballVersion.value.trim())
  return Boolean(uploadFile.value)
})
</script>

<template>
  <NDrawer
    :show="show"
    :width="560"
    placement="right"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NDrawerContent :title="props.platform === 'desktop' ? '添加桌面插件' : '添加插件'" closable>
      <p v-if="props.platform === 'desktop'" class="add-plugin__platform">
        这个插件会创建到<strong>桌面插件库</strong>（与云端库独立）；桌面版本必须有整包，来源请选「上传 tgz」。
      </p>

      <NSteps :current="step" size="small" class="add-plugin__steps">
        <NStep title="选择来源" />
        <NStep title="确认元数据" />
        <NStep title="完成" />
      </NSteps>

      <!-- ① 来源 -->
      <div v-if="step === 0" class="add-plugin__pane">
        <NRadioGroup v-model:value="source" class="add-plugin__sources">
          <NRadioButton v-for="option in sourceOptions" :key="option.value" :value="option.value">
            <span :class="option.icon" aria-hidden="true" /> {{ option.label }}
          </NRadioButton>
        </NRadioGroup>

        <NForm label-placement="top" size="small" class="add-plugin__form">
          <NFormItem v-if="source === 'npm'" label="npm 包名" required>
            <NInput v-model:value="npmName" placeholder="dsh-email 或 @xmanrui/dsh-im" />
          </NFormItem>

          <NFormItem v-if="source === 'local'" label="宿主目录（绝对路径）" required>
            <NInput v-model:value="localPath" placeholder="/path/to/plugin" />
          </NFormItem>

          <template v-if="source === 'tarball'">
            <NFormItem label="tarball 地址" required>
              <NInput v-model:value="tarballUrl" placeholder="https://…/pkg-1.0.0.tgz" />
            </NFormItem>
            <NFormItem label="版本标签" required>
              <NInput v-model:value="tarballVersion" placeholder="1.0.0" />
            </NFormItem>
          </template>

          <NFormItem v-if="source === 'upload'" label="选择 .tgz" required>
            <NUpload :max="1" :default-upload="false" accept=".tgz,.tar.gz" @change="onUploadChange">
              <NButton size="small">选择文件</NButton>
            </NUpload>
          </NFormItem>
        </NForm>

        <NAlert v-if="errorText" type="error" :bordered="false" class="add-plugin__error">{{
          errorText
        }}</NAlert>
      </div>

      <!-- ② 确认 -->
      <div v-else-if="step === 1" class="add-plugin__pane">
        <NAlert v-if="lookup" type="success" :bordered="false" class="add-plugin__alert">
          已读取到元数据：{{ lookup.packageName }}
          <template v-if="lookup.versions.length">
            · {{ lookup.versions.length }} 个版本<template v-if="lookup.latest"
              >，最新 {{ lookup.latest }}</template
            >
          </template>
        </NAlert>
        <NAlert v-else type="warning" :bordered="false" class="add-plugin__alert">
          这种来源无法自动读取元数据，请手工确认下面的信息（服务端还会校验包内容）。
        </NAlert>

        <NForm label-placement="top" size="small" class="add-plugin__form">
          <NFormItem label="包名" required>
            <NInput v-model:value="form.packageName" placeholder="dsh-email" />
          </NFormItem>
          <NFormItem label="显示名" required>
            <NInput v-model:value="form.displayName" placeholder="邮件助手" />
          </NFormItem>
          <NFormItem label="描述">
            <NInput
              v-model:value="form.description"
              type="textarea"
              :rows="2"
              placeholder="一句话说明它做什么"
            />
          </NFormItem>
          <NFormItem label="策略">
            <NSelect v-model:value="form.policy" :options="policyOptions" />
          </NFormItem>
          <NFormItem v-if="source === 'npm'" label="要锁定的版本">
            <NSelect
              v-model:value="form.version"
              filterable
              tag
              :options="(lookup?.versions ?? []).map((version) => ({ label: version, value: version }))"
            />
          </NFormItem>
          <NFormItem label="bundle 顺序">
            <NInputNumber v-model:value="form.bundleOrder" :min="0" :max="9999" />
          </NFormItem>
        </NForm>

        <div class="add-plugin__checks">
          <NCheckbox v-model:checked="form.isBundle">写入 dsh.profile.bundles（大部分插件都要勾）</NCheckbox>
          <NCheckbox v-model:checked="form.needsRestart">安装后需要重启 DSH 才生效</NCheckbox>
        </div>

        <NAlert v-if="errorText" type="error" :bordered="false" class="add-plugin__error">{{
          errorText
        }}</NAlert>
      </div>

      <!-- ③ 完成 -->
      <div v-else class="add-plugin__pane add-plugin__done">
        <span class="i-ph-check-circle add-plugin__done-icon" aria-hidden="true" />
        <p class="add-plugin__done-title">插件已入库</p>
        <p class="add-plugin__done-desc">
          {{ form.displayName }}（{{ form.packageName }}）已登记，策略
          <MiniTag :text="pluginPolicyText(form.policy)" tone="sky" size="sm" />。下一步可以把它下发给用户。
        </p>
        <div class="add-plugin__done-actions">
          <NButton type="primary" @click="onRollout">立即下发</NButton>
          <RouterLink v-if="createdId" :to="`/admin/plugins/${createdId}`">
            <NButton @click="emit('update:show', false)">去插件详情</NButton>
          </RouterLink>
        </div>
      </div>

      <template #footer>
        <div class="add-plugin__footer">
          <NButton v-if="step > 0 && step < 2" size="small" @click="step -= 1">上一步</NButton>
          <NButton
            v-if="step === 0"
            size="small"
            type="primary"
            :disabled="!canNext"
            :loading="loading"
            @click="goConfirm"
          >
            下一步
          </NButton>
          <NButton v-else-if="step === 1" size="small" type="primary" :loading="loading" @click="submit">
            创建插件
          </NButton>
          <NButton v-else size="small" @click="emit('update:show', false)">完成</NButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.add-plugin__platform {
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.add-plugin__steps {
  margin-bottom: var(--space-4);
}

.add-plugin__pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.add-plugin__sources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.add-plugin__form {
  margin-top: var(--space-2);
}

.add-plugin__alert {
  border-radius: var(--radius-control);
}

.add-plugin__checks {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.add-plugin__error {
  border-radius: var(--radius-control);
}

.add-plugin__done {
  align-items: center;
  padding-top: var(--space-6);
  text-align: center;
}

.add-plugin__done-icon {
  color: var(--c-primary);
  font-size: 40px;
}

.add-plugin__done-title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.add-plugin__done-desc {
  max-width: 380px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.add-plugin__done-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.add-plugin__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
