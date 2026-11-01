/**
 * 模型 store：目录、选择、思考程度、v2 特性与对话预设。
 *
 * 从 `auth.ts` 里拆出来（WP46 C）。依赖方向单向：**models → auth / backend**。
 *
 * 规则（§1.4 / M5 §17）：
 *  - 选择按「账号 + 后端」记住，存 ordinary preferences（非敏感）；
 *  - 目录优先用通道 v2 `models` 帧（`applyServerModels`），没有就退回本地 mock fixture；
 *  - 四档 ↔ DSH effort 一一映射，是否可选只看模型 `efforts[]`；
 *  - `features` 是 hello 协商回来的 v2 特性（由 chat store 在状态提交时推进来——
 *    「chat 通过回调通知 models」这一个方向，不反向写）；
 *  - 切后端/换账号：选择自己按 `selectedBackendId` + `accountKey` 重新加载（watch），
 *    不需要别人记得调。
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import {
  availableTiers,
  chipLabel,
  defaultTierOf,
  effortIdForSelection,
  effortLabel,
  findModel,
  modelKey,
  normalizeSelection,
  resolveModelCatalog,
  toStoredSelection,
  type BackendModelCatalog,
  type CatalogModel,
  type EffortTierId,
  type ModelSelection,
} from '@dsh-hub/mobile-core'
import { selectionStore } from '@/lib/instance'
import { isHiddenModelChannel } from '@/lib/model-label'
import { shortModelName, effortShortLabel as effortShortNameOf } from '@/lib/model-label'
import { useAuthStore } from './auth'
import { useBackendStore } from './backend'

export const useModelsStore = defineStore('models', () => {
  const auth = useAuthStore()
  const backend = useBackendStore()

  const selection = ref<ModelSelection | null>(null)
  /** 服务端回显的 v2 特性；空 = v1 降级。 */
  const features = ref<string[]>([])
  /** 通道 v2 `models` 帧的目录（可能为空；为空时用本地 mock 目录）。 */
  const serverCatalog = shallowRef<BackendModelCatalog | null>(null)
  /**
   * 新建会话时带的 agent preset。
   *
   * 0.2.12 起手机端也走**标准 DSH 模式**：默认不带 preset（null），让 Host 用标准 DSH
   * 的默认 composition；如果管理员仍下发了「普通对话」预设并希望手机用它，由服务端
   * registry default 决定，App 不再硬写 `chat`。
   */
  const presetId = ref<string | null>(null)

  /**
   * 手机端只展示中转站模型：Claude Code / Codex 两个插件渠道整组隐藏
   * （真机 2026-10-26 要求；provider id = `claude-code` / `codex`，展示名里也兜底）。
   */
  function visibleModelCatalog(source: BackendModelCatalog): BackendModelCatalog {
    const items = source.items.filter((model) => !isHiddenModelChannel(model))
    return items.length === source.items.length ? source : { ...source, items }
  }

  const catalog = computed<BackendModelCatalog>(() => {
    const server = serverCatalog.value
    if (server && server.backendId === backend.selectedBackendId && server.items.length > 0) {
      return visibleModelCatalog(server)
    }
    return resolveModelCatalog(backend.selectedBackend)
  })

  const currentModel = computed<CatalogModel | null>(() =>
    selection.value ? findModel(catalog.value, modelKey(selection.value)) : null,
  )
  const efforts = computed<EffortTierId[]>(() => availableTiers(currentModel.value))
  const chip = computed(() => chipLabel(selection.value))
  const effortText = computed(() => effortLabel(selection.value?.effortTier))
  const supportsThinking = computed(() => efforts.value.length > 0)
  const modelsFeature = computed(() => features.value.includes('models'))
  /**
   * 芯片「模型 + 强度」两段式（Codex 风格）：
   *  - 模型段用 catalog 显示名的短名（见 lib/model-label.ts）；
   *  - 强度段用英文短名（低 Low / 中等 Medium / 高 High / 超高 Max）。
   * 后端没上报 `models` 能力（或目录里还没有当前模型）时模型段为空，芯片退回旧样式。
   */
  const chipModelShort = computed(() => {
    const model = currentModel.value
    if (!modelsFeature.value || !model) return ''
    return shortModelName(model.name) || shortModelName(model.model)
  })
  const chipEffortShort = computed(() => effortShortNameOf(selection.value?.effortTier))
  /** 文件能力：通道协商到 files 且节点报 filesRead（老 Hub 就没有保存/下载入口）。 */
  const capabilitiesFiles = computed(() => features.value.includes('files'))

  // ── 载入 / 持久化 ─────────────────────────────────────────────────────────

  async function loadSelection(backendId: string): Promise<void> {
    const acc = auth.accountKey
    const dir = resolveModelCatalog(backend.backends.find((item) => item.id === backendId) ?? null)
    const saved = acc ? await selectionStore.getSelection(acc, backendId) : null
    selection.value = normalizeSelection(visibleModelCatalog(dir), saved)
    await persistSelection()
  }

  async function persistSelection(): Promise<void> {
    const acc = auth.accountKey
    const current = backend.selectedBackend
    if (!acc || !current) return
    const stored = toStoredSelection(selection.value)
    if (!stored) return
    await selectionStore.setSelection(acc, current.id, stored)
  }

  // ── 选择 ──────────────────────────────────────────────────────────────────

  /** 弹层里选模型：档位保持（不可用则回到该模型默认档）。 */
  async function selectModel(nextModelKey: string): Promise<void> {
    const model = findModel(catalog.value, nextModelKey)
    if (!model) return
    const keepTier = selection.value?.effortTier
    // 注意：`efforts` 是 computed，必须取 `.value`（A1 这里直接 `efforts.includes`，
    // 任何一次选模型都会在运行时抛 TypeError）。
    const tier =
      keepTier && efforts.value.includes(keepTier) ? keepTier : defaultTierOf(model)
    selection.value = { provider: model.provider, model: model.model, effortTier: tier }
    await persistSelection()
  }

  async function selectEffort(tier: EffortTierId): Promise<void> {
    const model = currentModel.value
    if (!model) return
    if (!availableTiers(model).includes(tier)) return
    selection.value = {
      provider: model.provider,
      model: model.model,
      effortTier: tier,
    }
    await persistSelection()
  }

  /**
   * 回滚到某个已知选择（`set-model` 失败时用）。
   * 只接受与当前账号/后端一致的 provider/model；档位不可用就回到该模型的默认档。
   */
  async function restoreSelection(previous: ModelSelection | null): Promise<void> {
    if (!previous) return
    const model = findModel(catalog.value, modelKey(previous))
    if (!model) return
    const tier =
      previous.effortTier && availableTiers(model).includes(previous.effortTier)
        ? previous.effortTier
        : defaultTierOf(model)
    selection.value = { provider: model.provider, model: model.model, effortTier: tier }
    await persistSelection()
  }

  /** 服务端 `models` 帧到达：覆盖目录，并按新目录归一化当前选择。 */
  async function applyServerModels(next: BackendModelCatalog | null): Promise<void> {
    if (!next || next.items.length === 0) return
    if (next.backendId !== backend.selectedBackendId) return
    serverCatalog.value = next
    const saved = toStoredSelection(selection.value)
    const visible = visibleModelCatalog(next)
    // 全部渠道都被隐藏时退回原始目录（不至于整个模型列表空掉）
    selection.value = normalizeSelection(visible.items.length > 0 ? visible : next, saved)
    await persistSelection()
  }

  /** hello.features 回显：没有 `models` 就继续用本地 mock 目录（并隐藏依赖它的 UI）。 */
  function applyFeatures(next: string[]): void {
    features.value = next
    if (!next.includes('models') && serverCatalog.value) serverCatalog.value = null
  }

  /** 给通道用的模型选择（provider/model + DSH effort id；不支持思考时缺省 effort）。 */
  function selectionPayload(): { provider: string; model: string; effort?: string } | null {
    if (!selection.value) return null
    const effort = effortIdForSelection(catalog.value, selection.value)
    return {
      provider: selection.value.provider,
      model: selection.value.model,
      ...(effort === undefined ? {} : { effort }),
    }
  }

  function reset(): void {
    selection.value = null
    features.value = []
    serverCatalog.value = null
  }

  // ── 上游变化 ────────────────────────────────────────────────────────────

  // 切后端 / 换账号：目录作废，选择按新上下文重新加载。
  watch(
    () => [backend.selectedBackendId, auth.accountKey] as const,
    ([backendId]) => {
      serverCatalog.value = null
      if (!backendId || !auth.isAuthenticated) {
        selection.value = null
        return
      }
      void loadSelection(backendId)
    },
  )

  // 退出登录：全部作废（下次登录重新加载）。
  watch(
    () => auth.isAuthenticated,
    (ok) => {
      if (ok) return
      reset()
    },
  )

  return {
    // 状态
    selection,
    features,
    serverCatalog,
    presetId,
    // 派生
    catalog,
    currentModel,
    efforts,
    chip,
    effortText,
    supportsThinking,
    modelsFeature,
    chipModelShort,
    chipEffortShort,
    capabilitiesFiles,
    // 动作
    selectModel,
    selectEffort,
    applyServerModels,
    applyFeatures,
    selectionPayload,
    restoreSelection,
    loadSelection,
    persistSelection,
    visibleModelCatalog,
    reset,
  }
})
