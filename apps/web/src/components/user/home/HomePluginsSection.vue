<script setup lang="ts">
import type { MyPluginItem } from '@dsh-hub/shared'
import { NPopover, NRadioButton, NRadioGroup, NSwitch, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { describeError } from '@/api/errors'
import { fetchMyPlugins, installMyPlugin, uninstallMyPlugin } from '@/api/plugins'
import SoftCard from '@/components/base/SoftCard.vue'
import PluginIcon from '@/components/user/PluginIcon.vue'

/**
 * 工作台「我的插件」（16 §7）：放进和其他区块一样的 `SoftCard`，头部是「已安装 N / M」+
 * 分段筛选（全部 / 已安装 / 可安装，筛选结果记在 localStorage），内容是桌面两列、手机一列的
 * 紧凑列表（图标、名称 + 必装锁、单行描述、版本、状态 / 开关）。
 *
 * 轮询沿用原 `MyPluginsTab`：切换后每 3 秒拉一次直到状态稳定（服务端任务是异步的）。
 * 筛选值读写 localStorage 都 try/catch —— 隐私模式下读写都会抛，不能因此白屏。
 */
const props = withDefaults(
  defineProps<{
    /** 轮询间隔（测试注入更短的值） */
    pollIntervalMs?: number
    /** 最多轮询次数，超过就放弃并提示 */
    maxPolls?: number
  }>(),
  { pollIntervalMs: 3000, maxPolls: 40 },
)

const FILTER_KEY = 'home.plugins.filter'
type PluginFilter = 'all' | 'installed' | 'available'

const FILTERS: { label: string; value: PluginFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '已安装', value: 'installed' },
  { label: '可安装', value: 'available' },
]

function readFilter(): PluginFilter {
  try {
    const raw = window.localStorage.getItem(FILTER_KEY)
    if (raw === 'installed' || raw === 'available' || raw === 'all') return raw
  } catch {
    // 隐私模式 / 禁用存储：用默认值，不能因此打不开页面
  }
  return 'all'
}

const message = useMessage()

const items = ref<MyPluginItem[]>([])
const loading = ref(true)
const errorText = ref<string | null>(null)
const busyId = ref<number | null>(null)
const notices = ref<Record<number, string>>({})
const filter = ref<PluginFilter>(readFilter())

watch(filter, (value) => {
  try {
    window.localStorage.setItem(FILTER_KEY, value)
  } catch {
    // 写不进去只是下次回到默认筛选，不影响当前页面
  }
})

let timer: ReturnType<typeof setTimeout> | null = null
let polls = 0

const installedCount = computed(() => items.value.filter((item) => item.installed).length)

const filtered = computed(() => {
  if (filter.value === 'installed') return items.value.filter((item) => item.installed)
  if (filter.value === 'available') return items.value.filter((item) => !item.installed)
  return items.value
})

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

async function load(): Promise<boolean> {
  try {
    const response = await fetchMyPlugins()
    items.value = response.items
    errorText.value = null
    return true
  } catch (error) {
    errorText.value = describeError(error).message
    return false
  } finally {
    loading.value = false
  }
}

/** 目标插件是否已经稳定（不再是 pending） */
function settled(pluginId: number, wantInstalled: boolean): boolean {
  const item = items.value.find((row) => row.plugin.id === pluginId)
  if (!item) return true
  return item.state !== 'pending' && item.installed === wantInstalled
}

function schedulePoll(pluginId: number, wantInstalled: boolean): void {
  clearTimer()
  if (polls >= props.maxPolls) {
    busyId.value = null
    notices.value[pluginId] = '任务还在跑，稍后回来看看结果'
    return
  }
  polls += 1

  timer = setTimeout(() => {
    void load().then(() => {
      if (settled(pluginId, wantInstalled)) {
        timer = null
        busyId.value = null
        const item = items.value.find((row) => row.plugin.id === pluginId)
        if (item?.state === 'failed') {
          notices.value[pluginId] = item.plugin.needsRestart ? '安装失败了，稍后再试' : '操作失败了，稍后再试'
        } else {
          notices.value[pluginId] = item?.plugin.needsRestart === false ? '已经在运行了' : '重启 DSH 后生效'
        }
        message.success(notices.value[pluginId] ?? '完成了')
        return
      }
      schedulePoll(pluginId, wantInstalled)
    })
  }, props.pollIntervalMs)
}

async function toggle(pluginId: number, next: boolean): Promise<void> {
  busyId.value = pluginId
  delete notices.value[pluginId]
  try {
    if (next) await installMyPlugin(pluginId)
    else await uninstallMyPlugin(pluginId)

    // 本地先置为 pending，界面立刻有反馈
    items.value = items.value.map((row) =>
      row.plugin.id === pluginId ? { ...row, state: 'pending', installed: next } : row,
    )
    polls = 0
    schedulePoll(pluginId, next)
  } catch (error) {
    busyId.value = null
    message.error(describeError(error).message)
    await load()
  }
}

function stateText(item: MyPluginItem): string {
  if (item.state === 'pending') return '同步中'
  if (item.state === 'failed') return '失败'
  return item.installed ? '已安装' : '未安装'
}

function failureReason(item: MyPluginItem): string {
  return notices.value[item.plugin.id] ?? '插件同步失败了，稍后再试一次。'
}

/** 失败标签点开看原因（07 §2.7：状态本身表达，不在页面上常驻说明） */
function failedTag(item: MyPluginItem) {
  return item.state === 'failed'
}

onMounted(() => void load())
onBeforeUnmount(clearTimer)
</script>

<template>
  <SoftCard title="我的插件">
    <template #title-extra>
      <span class="plugins__count" data-testid="plugins-count">
        已安装 {{ installedCount }} / {{ items.length }}
      </span>
    </template>
    <template #extra>
      <NRadioGroup v-model:value="filter" size="small" data-testid="plugins-filter">
        <NRadioButton v-for="option in FILTERS" :key="option.value" :value="option.value">
          {{ option.label }}
        </NRadioButton>
      </NRadioGroup>
    </template>

    <p v-if="loading" class="hub-muted">正在读取插件列表…</p>
    <p v-else-if="errorText" class="text-[13px] text-2" role="alert">{{ errorText }}</p>

    <template v-else>
      <ul v-if="filtered.length > 0" class="plugins__list" data-testid="plugins-list">
        <li v-for="item in filtered" :key="item.plugin.id" class="plugins__row" data-testid="plugin-row">
          <PluginIcon :plugin="item.plugin" :size="36" />

          <div class="plugins__main">
            <div class="plugins__name-line">
              <span class="plugins__name" :title="item.plugin.displayName">
                {{ item.plugin.displayName }}
              </span>
              <span
                v-if="item.plugin.policy === 'required'"
                class="i-ph-lock-key plugins__lock"
                :aria-label="`${item.plugin.displayName} 由管理员统一配置`"
              />
            </div>
            <p class="plugins__desc" :title="item.plugin.description">{{ item.plugin.description }}</p>
          </div>

          <span class="plugins__version" :title="item.version ? `v${item.version}` : undefined">
            {{ item.version ? `v${item.version}` : '—' }}
          </span>

          <div class="plugins__actions">
            <!-- 必装：只有「必装」标签，没有开关（16 §7） -->
            <span v-if="item.plugin.policy === 'required'" class="plugins__tag plugins__tag--required">
              必装
            </span>

            <template v-else>
              <span
                v-if="item.state === 'pending'"
                class="plugins__tag plugins__tag--pending"
                data-testid="plugin-state-pending"
              >
                <span class="i-ph-circle-notch plugins__spin" aria-hidden="true" />
                同步中
              </span>
              <NPopover v-else-if="failedTag(item)" trigger="click" placement="top" :width="240">
                <template #trigger>
                  <button
                    type="button"
                    class="plugins__tag plugins__tag--failed"
                    data-testid="plugin-state-failed"
                  >
                    失败
                  </button>
                </template>
                {{ failureReason(item) }}
              </NPopover>
              <span v-else class="plugins__tag plugins__tag--synced" data-testid="plugin-state">
                {{ stateText(item) }}
              </span>

              <NSwitch
                v-if="item.canToggle"
                :value="item.installed"
                :loading="busyId === item.plugin.id"
                :disabled="busyId !== null && busyId !== item.plugin.id"
                :aria-label="`${item.installed ? '卸载' : '安装'} ${item.plugin.displayName}`"
                size="small"
                @update:value="(value: boolean) => toggle(item.plugin.id, value)"
              />
            </template>
          </div>

          <p v-if="notices[item.plugin.id] && item.state !== 'failed'" class="plugins__notice" role="status">
            {{ notices[item.plugin.id] }}
          </p>
        </li>
      </ul>

      <p v-else class="plugins__empty">
        {{
          filter === 'installed' ? '还没有安装任何可选插件。' : '没有可安装的插件，等管理员添加后就能看到。'
        }}
      </p>
    </template>
  </SoftCard>
</template>

<style scoped>
.plugins__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.plugins__list {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.plugins__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  min-height: 64px;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.plugins__main {
  flex: 1 1 140px;
  min-width: 0;
}

.plugins__name-line {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.plugins__name {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugins__lock {
  flex: none;
  color: var(--c-text-3);
  font-size: 14px;
}

.plugins__desc {
  overflow: hidden;
  color: var(--c-text-2);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugins__version {
  flex: none;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.plugins__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}

.plugins__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px var(--space-2);
  border: 0;
  border-radius: var(--radius-pill);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.plugins__tag--required {
  background: var(--c-bg);
  color: var(--c-text-3);
}

.plugins__tag--synced {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.plugins__tag--pending {
  background: var(--c-sky-soft);
  color: var(--c-sky-ink);
}

.plugins__tag--failed {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
  cursor: pointer;
}

.plugins__spin {
  animation: plugins-spin 1s linear infinite;
}

@keyframes plugins-spin {
  to {
    transform: rotate(360deg);
  }
}

.plugins__notice {
  flex: 1 0 100%;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.plugins__empty {
  padding: var(--space-4) 0;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* 手机一列；状态与开关换到第二行也不挤（16 §7） */
@media (max-width: 900px) {
  .plugins__list {
    grid-template-columns: minmax(0, 1fr);
  }

  .plugins__row {
    align-items: flex-start;
  }

  .plugins__actions {
    margin-left: auto;
  }
}

/* 390 下卡片头部放不下「标题 + 已安装 + 筛选」三样：把筛选换到一行，标题不拆字 */
@media (max-width: 720px) {
  :deep(.soft-card__header) {
    flex-wrap: wrap;
  }

  :deep(.soft-card__title) {
    white-space: nowrap;
  }

  :deep(.soft-card__extra) {
    width: 100%;
    margin-left: 0;
  }
}
</style>
