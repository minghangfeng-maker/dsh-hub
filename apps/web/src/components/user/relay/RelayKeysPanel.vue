<script setup lang="ts">
import type { RelayKey } from '@dsh-hub/shared'
import {
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref } from 'vue'

import { describeError } from '@/api/errors'
import { createMyRelayKey, deleteMyRelayKey, rotateMyRelayKey, updateMyRelayKey } from '@/api/relay'
import MiniTag from '@/components/admin/MiniTag.vue'
import CopyText from '@/components/base/CopyText.vue'
import { formatDateTime, fromNow } from '@/composables/useFormat'

/**
 * 「API 密钥」区（12 §10 第 4 条）：
 * - DSH 内置（`system`）每人一把，标「自动」，操作只有「重置」（二次确认 + 说明要重启 DSH）；
 * - 自建（`user`）可改名 / 停用 / 删除（删除走二次确认）；
 * - 新建 / 重置后的**明文只在一次性弹窗里显示**，关掉就再也看不到（列表只有 preview）。
 */
const props = withDefaults(defineProps<{ keys: RelayKey[]; loading?: boolean }>(), { loading: false })

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const showCreate = ref(false)
const createName = ref('')
const creating = ref(false)

const renameTarget = ref<RelayKey | null>(null)
const renameValue = ref('')
const renaming = ref(false)

const rotateTarget = ref<RelayKey | null>(null)
const rotating = ref(false)

/** 一次性明文（新建 / 重置后只在这里存在；关闭即丢弃） */
const secret = ref('')
const secretKey = ref<RelayKey | null>(null)
const secretNeedsRecreate = ref(false)
const showSecret = ref(false)

const userKeyCount = computed(() => props.keys.filter((key) => key.kind === 'user').length)

function openCreate(): void {
  createName.value = ''
  showCreate.value = true
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim()
  if (!name) {
    message.warning('给密钥起个名字吧，比如「本机 curl」')
    return
  }
  creating.value = true
  try {
    const result = await createMyRelayKey({ name })
    showCreate.value = false
    revealSecret(result.secret, result.key, result.needsRecreate)
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    creating.value = false
  }
}

function revealSecret(value: string, key: RelayKey, needsRecreate: boolean): void {
  secret.value = value
  secretKey.value = key
  secretNeedsRecreate.value = needsRecreate
  showSecret.value = true
}

/** 关掉一次性弹窗 = 明文销毁（列表里只有 preview） */
function closeSecret(): void {
  showSecret.value = false
  secret.value = ''
  secretKey.value = null
  secretNeedsRecreate.value = false
}

async function submitRotate(): Promise<void> {
  const key = rotateTarget.value
  if (!key) return
  rotating.value = true
  try {
    const result = await rotateMyRelayKey(key.id)
    rotateTarget.value = null
    revealSecret(result.secret, result.key, result.needsRecreate)
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    rotating.value = false
  }
}

function openRename(key: RelayKey): void {
  renameTarget.value = key
  renameValue.value = key.name
}

async function submitRename(): Promise<void> {
  const key = renameTarget.value
  const name = renameValue.value.trim()
  if (!key || !name) return
  renaming.value = true
  try {
    await updateMyRelayKey(key.id, { name })
    message.success('已改名')
    renameTarget.value = null
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    renaming.value = false
  }
}

async function toggleKey(key: RelayKey): Promise<void> {
  try {
    await updateMyRelayKey(key.id, { enabled: !key.enabled })
    message.success(key.enabled ? '已停用这把密钥' : '已启用这把密钥')
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  }
}

async function removeKey(key: RelayKey): Promise<void> {
  try {
    await deleteMyRelayKey(key.id)
    message.success('密钥已删除')
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  }
}

const columns = computed<DataTableColumns<RelayKey>>(() => [
  {
    title: '名称',
    key: 'name',
    minWidth: 200,
    render: (row) =>
      h('div', { class: 'keys__name' }, [
        h('span', { class: 'keys__name-text', title: row.name }, row.name),
        row.kind === 'system'
          ? h(MiniTag, {
              text: '自动',
              tone: 'primary',
              icon: 'i-ph-lock-key',
              size: 'sm',
              title: '自动注入你的 DSH，改完重启 DSH 才生效',
            })
          : null,
        !row.enabled ? h(MiniTag, { text: '已停用', tone: 'neutral', size: 'sm' }) : null,
      ]),
  },
  {
    title: '密钥',
    key: 'preview',
    width: 235,
    render: (row) => h(CopyText, { text: row.preview, size: 'sm', truncate: true }),
  },
  {
    title: '最近使用',
    key: 'lastUsedAt',
    width: 130,
    render: (row) => (row.lastUsedAt ? fromNow(row.lastUsedAt) : '从未使用'),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 150,
    render: (row) => formatDateTime(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    fixed: 'right',
    render: (row) =>
      h(
        'div',
        { class: 'keys__actions' },
        row.kind === 'system'
          ? [
              h(
                NButton,
                { size: 'tiny', onClick: () => (rotateTarget.value = row) },
                { default: () => '重置' },
              ),
            ]
          : [
              h(NButton, { size: 'tiny', quaternary: true, onClick: () => openRename(row) }, { default: () => '改名' }),
              h(
                NButton,
                { size: 'tiny', quaternary: true, onClick: () => void toggleKey(row) },
                { default: () => (row.enabled ? '停用' : '启用') },
              ),
              h(
                NPopconfirm,
                { onPositiveClick: () => void removeKey(row) },
                {
                  trigger: () =>
                    h(NButton, { size: 'tiny', type: 'error', ghost: true }, { default: () => '删除' }),
                  default: () => '删除后使用这把密钥的工具会立刻失效，确定吗？',
                },
              ),
            ],
      ),
  },
])
</script>

<template>
  <div class="keys">
    <div class="keys__bar">
      <NButton
        size="small"
        type="primary"
        :disabled="userKeyCount >= 10"
        :title="userKeyCount >= 10 ? '自建密钥每人最多 10 把' : undefined"
        @click="openCreate"
      >
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
        新建密钥
      </NButton>
    </div>

    <NDataTable
      class="keys__table"
      :columns="columns"
      :data="keys"
      :loading="loading"
      :row-key="(row: RelayKey) => row.id"
      :scroll-x="910"
      table-layout="fixed"
      :pagination="false"
      size="small"
    />

    <!-- 新建 -->
    <NModal v-model:show="showCreate" preset="card" title="新建 API 密钥" :style="{ maxWidth: '420px' }">
      <NForm label-placement="top" size="small">
        <NFormItem label="名称" required>
          <NInput v-model:value="createName" maxlength="32" placeholder="本机 curl" @keyup.enter="submitCreate" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="keys__footer">
          <NButton size="small" @click="showCreate = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </div>
      </template>
    </NModal>

    <!-- 改名 -->
    <NModal
      :show="renameTarget !== null"
      preset="card"
      title="给密钥改名"
      :style="{ maxWidth: '420px' }"
      @update:show="(value: boolean) => (renameTarget = value ? renameTarget : null)"
    >
      <NInput v-model:value="renameValue" maxlength="32" placeholder="新名字" @keyup.enter="submitRename" />
      <template #footer>
        <div class="keys__footer">
          <NButton size="small" @click="renameTarget = null">取消</NButton>
          <NButton size="small" type="primary" :loading="renaming" @click="submitRename">保存</NButton>
        </div>
      </template>
    </NModal>

    <!-- 重置 DSH 内置密钥：二次确认 -->
    <NModal
      :show="rotateTarget !== null"
      preset="card"
      title="重置 DSH 内置密钥？"
      :style="{ maxWidth: '460px' }"
      @update:show="(value: boolean) => (rotateTarget = value ? rotateTarget : null)"
    >
      <p class="keys__confirm-text">旧的密钥会立刻作废。重置后需要重启 DSH 才生效——没重启之前，你的 DSH 仍然拿着旧密钥，会连不上中转站。</p>
      <p class="keys__confirm-text">如果你的 DSH 正在跑任务，建议等它跑完再重置。</p>
      <template #footer>
        <div class="keys__footer">
          <NButton size="small" @click="rotateTarget = null">取消</NButton>
          <NButton size="small" type="warning" :loading="rotating" @click="submitRotate">确认重置</NButton>
        </div>
      </template>
    </NModal>

    <!-- 一次性明文 -->
    <NModal
      :show="showSecret"
      preset="card"
      title="这是你的新密钥（只显示这一次）"
      :style="{ maxWidth: '560px' }"
      :mask-closable="false"
      @update:show="(value: boolean) => (value ? (showSecret = true) : closeSecret())"
    >
      <p class="keys__secret-name">{{ secretKey?.name }}</p>
      <CopyText class="keys__secret" :text="secret" label="密钥" />
      <p class="keys__secret-warn">关闭后无法再次查看，请立刻复制保存到安全的地方。</p>
      <p v-if="secretNeedsRecreate" class="keys__secret-recreate">
        还需要重启 DSH 才生效（配置注入在容器启动时完成）。
      </p>
      <template #footer>
        <div class="keys__footer">
          <NButton size="small" type="primary" @click="closeSecret">我已保存</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.keys__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}

:deep(.keys__name) {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

:deep(.keys__name-text) {
  overflow: hidden;
  color: var(--c-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.keys__actions) {
  display: flex;
  gap: 4px;
}

.keys__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.keys__confirm-text {
  margin-bottom: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.keys__secret-name {
  margin-bottom: var(--space-2);
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

/* 密钥是标识符：不拆字（07 §2.8）；一行放不下时在框内横向滚动，方便手动选中 */
.keys__secret :deep(.copy-text__value) {
  overflow-x: auto;
  white-space: nowrap;
}

.keys__secret-warn {
  margin-top: var(--space-3);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.keys__secret-recreate {
  margin-top: var(--space-1);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}
</style>
