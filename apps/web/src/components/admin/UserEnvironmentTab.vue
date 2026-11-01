<script setup lang="ts">
import type { ModelPolicy, Quota, UserAdminView } from '@dsh-hub/shared'
import { NButton, NSelect, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import {
  listInstances,
  instanceAction,
  fetchInstanceLogs,
  instanceLogsStreamUrl,
} from '@/api/admin-instances'
import { getRelayDsh } from '@/api/admin-relay'
import { listRuntimes } from '@/api/admin-runtimes'
import { updateUser } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import LogViewer from '@/components/admin/LogViewer.vue'
import MiniBars from '@/components/admin/MiniBars.vue'
import QuotaForm from '@/components/admin/QuotaForm.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime } from '@/composables/useFormat'

/**
 * 用户详情 · 环境（07 §7.3）：实例状态与资源、日志查看器（等宽 / 跟随 / 搜索 / SSE）、
 * 配额表单、DSH 版本钉选与模型策略。
 *
 * WP12 起模型不再按用户挑预设、也没有 per-user 密钥可填：模型统一由
 * 「模型 → 下发到 DSH」配置（12 §7.0 §10），这里只留一行只读摘要 + 链接。
 */
const props = defineProps<{ user: UserAdminView }>()
const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const router = useRouter()
const saving = ref(false)
const busy = ref(false)
/** 配额 / 版本钉选有未保存的改动：保存后要重建实例才生效，只在此时提醒 */
const quotaDirty = ref(false)

// ── 数据 ──

const { data: mine } = useAsyncData(
  async () => {
    const rows = await listInstances()
    return rows.find((row) => row.user.id === props.user.id) ?? null
  },
  { pollMs: 10_000 },
)
const { data: logs, reload: reloadLogs } = useAsyncData(() => fetchInstanceLogs(props.user.id, 300))
const { data: runtimes } = useAsyncData(() => listRuntimes())
const { data: dsh } = useAsyncData(() => getRelayDsh())
const streamUrl = computed(() => instanceLogsStreamUrl(props.user.id))

/** 只读一行：统一管理的模型数（可下发的）与默认模型（12 §10） */
const modelSummary = computed(() => {
  const value = dsh.value
  if (!value) return null
  const count = value.models.filter((model) => model.selected && model.blockedReason === null).length
  const defaultModel = value.models.find((model) => model.id === value.defaultModelId) ?? null
  return { count, defaultName: defaultModel?.displayName ?? null }
})
const logText = computed(() => logs.value?.text ?? '')

// ── 环境设置表单 ──

const quota = ref<Quota | null>(props.user.quotaIsDefault ? null : props.user.quota)
const runtimeId = ref<number | null>(props.user.runtimeId)
const modelPolicy = ref<ModelPolicy>(props.user.modelPolicy)

watch(
  () => props.user,
  (user) => {
    quota.value = user.quotaIsDefault ? null : user.quota
    runtimeId.value = user.runtimeId
    modelPolicy.value = user.modelPolicy
  },
)

// Naive 的 Select 不接受 null 值，用 0 当「跟随默认」的哨兵（id 都是正整数）
const runtimeOptions = computed(() => [
  { label: '跟随默认版本', value: 0 },
  ...(runtimes.value ?? []).map((item) => ({
    label: `${item.dshVersion}${item.isDefault ? '（默认）' : ''}${item.status !== 'ready' ? ` · ${item.status}` : ''}`,
    value: item.id,
  })),
])

const runtimeValue = computed({
  get: () => runtimeId.value ?? 0,
  set: (value: number) => {
    runtimeId.value = value === 0 ? null : value
    quotaDirty.value = true
  },
})

async function saveEnvironment(): Promise<void> {
  saving.value = true
  try {
    await updateUser(props.user.id, {
      quota: quota.value,
      runtimeId: runtimeId.value,
      modelPolicy: modelPolicy.value,
    })
    message.success('好的，已保存（版本 / 配额变化需要重建实例生效）')
    quotaDirty.value = false
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    saving.value = false
  }
}

async function runAction(action: 'start' | 'stop' | 'restart' | 'recreate'): Promise<void> {
  busy.value = true
  try {
    await instanceAction(props.user.id, action)
    message.success('操作已提交')
    emit('changed')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    busy.value = false
  }
}

function gotoSingleRollout(): void {
  void router.push({ path: '/admin/rollouts/new', query: { kind: 'models', userIds: String(props.user.id) } })
}
</script>

<template>
  <div class="user-env">
    <SoftCard title="实例">
      <template #extra>
        <StatusPill :status="user.instance.status" size="sm" />
      </template>

      <dl class="user-env__meta">
        <div>
          <dt>DSH 版本</dt>
          <dd>{{ user.instance.runtimeVersion ?? '默认版本' }}</dd>
        </div>
        <div>
          <dt>启动于</dt>
          <dd>{{ formatDateTime(user.instance.startedAt) }}</dd>
        </div>
        <div>
          <dt>最近活跃</dt>
          <dd>{{ formatDateTime(user.instance.lastActiveAt) }}</dd>
        </div>
      </dl>

      <p v-if="user.instance.error" class="user-env__error">{{ user.instance.error }}</p>
      <p v-else-if="user.instance.needsRecreate" class="user-env__warn">配置已更新，重建实例后生效</p>

      <MiniBars class="mt-3" :stats="mine?.stats ?? null" />

      <div class="user-env__actions">
        <NButton size="small" type="primary" :loading="busy" @click="runAction('start')">启动</NButton>
        <NButton size="small" :loading="busy" @click="runAction('stop')">停止</NButton>
        <NButton size="small" :loading="busy" @click="runAction('restart')">重启</NButton>
        <NButton size="small" type="warning" ghost :loading="busy" @click="runAction('recreate')"
          >重建</NButton
        >
        <NButton size="small" quaternary tag="a" :href="user.instance.openUrl" target="_blank" rel="noopener">
          打开 DSH
        </NButton>
      </div>
    </SoftCard>

    <SoftCard title="容器日志">
      <template #extra>
        <NButton size="tiny" quaternary @click="reloadLogs">重新拉取</NButton>
      </template>
      <LogViewer
        :text="logText"
        :stream-url="streamUrl"
        :height="280"
        empty-text="暂无日志（实例可能还没启动）"
      />
    </SoftCard>

    <SoftCard title="配额与版本">
      <QuotaForm v-model="quota" @change="quotaDirty = true" />

      <div class="user-env__grid">
        <label class="user-env__field">
          <span>DSH 版本（钉选）</span>
          <NSelect v-model:value="runtimeValue" size="small" :options="runtimeOptions" />
        </label>
        <label class="user-env__field">
          <span>模型策略</span>
          <NSelect
            v-model:value="modelPolicy"
            size="small"
            :options="[
              { label: '管理员统一配置', value: 'managed' },
              { label: '用户自助', value: 'free' },
            ]"
          />
        </label>
      </div>

      <p v-if="quotaDirty" class="user-env__warn" data-testid="user-env-dirty">
        保存后需要重建实例才会生效（DSH 版本 / 配额变化都会触发重建）。
      </p>

      <p class="user-env__models" data-testid="user-env-models">
        <span class="i-ph-lock-key" aria-hidden="true" />
        <span>
          模型：由
          <RouterLink class="user-env__link" to="/admin/models?tab=dsh">「模型 → 下发到 DSH」</RouterLink>
          统一配置<template v-if="modelSummary">（{{ modelSummary.count }} 个模型，默认 {{ modelSummary.defaultName ?? '未设置' }}）</template>
        </span>
      </p>

      <div class="user-env__actions">
        <NButton size="small" type="primary" :loading="saving" @click="saveEnvironment">保存环境设置</NButton>
        <NButton size="small" @click="gotoSingleRollout">只给这位用户下发模型配置</NButton>
      </div>
    </SoftCard>
  </div>
</template>

<style scoped>
.user-env {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.user-env__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  font-size: var(--fs-13);
}

.user-env__meta dt {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.user-env__error,
.user-env__warn {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-12);
}

.user-env__error {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
}

.user-env__warn {
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
}

.user-env__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.user-env__grid {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.user-env__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.user-env__models {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.user-env__link {
  color: var(--c-primary);
}
</style>
