import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  DESKTOP_RELAY_PATH,
  MOBILE_CHANNEL_IDLE_MS,
  MOBILE_CLOUD_NODE_ID,
  MOBILE_COCKPIT_NODE_ID,
  MOBILE_MAX_CHANNELS_PER_NODE,
  MOBILE_MAX_CHANNELS_PER_USER,
  MOBILE_NODES_PATH,
  RELAY_MICRO_PER_POINT,
  DesktopRelayFrameEnvelopeV2Schema,
  MobileBootstrapResponseSchema,
  MobileNodesResponseSchema,
  MobileServerFrameAllSchema,
  MobileTicketResponseSchema,
  MobileWakeResponseSchema,
  SESSION_COOKIE_NAME,
  deviceKindOf,
  type DesktopMobilePlatform,
  type DesktopRelayHello,
  type MobileBootstrapResponse,
  type MobileErrorCode,
  type MobileNode,
  type MobileNodeBlockedReason,
  type MobileSessionRowV2,
  type OpsStatus,
  type MobileNodeCapabilities,
  type MobileNodesResponse,
  type MobileTicketResponse,
  type MobileWakeResponse,
} from '@dsh-hub/shared'
import {
  createNodeRemote,
  NodeRemoteIncompatibleError,
  NodeRemoteProbeError,
  type NodeRemote,
} from '@dsh-hub/dsh-node-remote'
import { PROXY_AUTHORITY } from '../proxy/index.js'
// WP54a：bootstrap 要知道「这台设备是不是手机网页版」（只读一行，SQL 仍在 desktop/repo.ts）
import { getDeviceRow } from '../desktop/repo.js'
import { NodeSessionRegistry, type NodeSession } from './node-session.js'
import type { InstanceSummary } from '@dsh-hub/shared'
import { resolveUpstreamTarget } from '../instances/types.js'
import { containerNameFor } from '../instances/spec.js'
import { HubError } from '../../lib/errors.js'
import { resolveSession, type SessionUser } from '../../lib/session.js'
import { acceptUpgrade, isWebSocketUpgrade, rejectUpgrade, type WsConnection } from '../../lib/ws-upgrade.js'
import { SYSTEM_ACCOUNT_SLUG } from '../../lib/system-account.js'
import { cockpitSessionInitiators, recordCockpitSessionInitiator } from './cockpit-repo.js'
import type { AppDeps } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'
import { MobileChannel, IdempotencyStore } from './channel.js'
import { mobileVoiceInfo } from './asr.js'
import { mobileTtsInfo } from './tts.js'
import { canRelayRoute, mapDesktopStatus } from './routing.js'
import { RelayAdmission, ReservationBook } from './admission.js'
import { createMobileTicketStore } from './ticket.js'
import type { ChannelNode, MobileDeviceIdentity, MobileService, RelayConnection, RelayRegistry } from './types.js'

const CLOUD_PROBE_TTL_MS = 30_000
const RELAY_IDLE_MS = 120_000
const RELAY_HEARTBEAT_MS = 25_000
const DEFAULT_RELAY_REVALIDATE_MS = 60_000
/**
 * wake 的同步等待窗口：启动准入（磁盘/容量/余额/规格）在几百毫秒内就能得出结论，
 * 所以「立刻失败就立刻回错误码」；超过这个窗口说明容器已经在创建/启动了，
 * 回 202 `{status:'starting'}` 让 App 去轮询（契约 §2：App 每秒轮询最多 30 秒）。
 */
const DEFAULT_WAKE_SYNC_MS = 1_500
/**
 * 最后一条手机通道断开后，常驻会话代理（NodeSession）再活多久（WP46 / M6 §1）。
 *
 * 90 秒的理由：App 切后台/换网/亮屏重连通常在这个窗口内回来，回来时还看得见
 * 「回合在跑 / 有一个没答的提问」，不需要重新走一遍 hello + 订阅 + catch-up。
 */
const DEFAULT_NODE_SESSION_LINGER_MS = 90_000
/** 有未决交互或回合在跑时，NodeSession 最多保持多久（WP46 / M6 §1）。 */
const DEFAULT_INTERACTION_PARK_MS = 30 * 60_000

interface CloudReadiness {
  status: MobileNode['status']
  connectable: boolean
  reason?: MobileNodeBlockedReason
  capabilities?: MobileNodeCapabilities
}

interface ActiveChannel {
  channel: MobileChannel
  userId: number
  nodeId: string
  /** Bearer（ticket）建立的通道绑定的设备；cookie 通道没有（0.2.0 兼容路径）。 */
  deviceId?: string
  /** 桌面通道绑定的具体 relay 实例（R1：旧实例不得操作新通道）。 */
  relay?: RelayConnection
}

interface RelayEntry extends RelayConnection {
  generation: string
  closed: boolean
}

export function createMobileService(deps: AppDeps): MobileService {
  const rawRevalidate = Number(process.env['HUB_MOBILE_RELAY_REVALIDATE_MS'] ?? '')
  /** 测试可注入更短的复检周期；生产默认 60s。 */
  const relayRevalidateMs = Number.isFinite(rawRevalidate) && rawRevalidate > 0 ? rawRevalidate : DEFAULT_RELAY_REVALIDATE_MS
  const rawWakeSync = Number(process.env['HUB_MOBILE_WAKE_SYNC_MS'] ?? '')
  // 注意空串：`Number('') === 0`，不能只判 isFinite（否则默认值永远生效不了）
  const wakeSyncMs = Number.isFinite(rawWakeSync) && rawWakeSync > 0 ? rawWakeSync : DEFAULT_WAKE_SYNC_MS
  const rawLinger = Number(process.env['HUB_MOBILE_NODE_SESSION_LINGER_MS'] ?? '')
  const lingerMs =
    Number.isFinite(rawLinger) && rawLinger > 0 ? rawLinger : DEFAULT_NODE_SESSION_LINGER_MS
  const rawPark = Number(process.env['HUB_MOBILE_INTERACTION_PARK_MS'] ?? '')
  const parkMs = Number.isFinite(rawPark) && rawPark > 0 ? rawPark : DEFAULT_INTERACTION_PARK_MS
  const tickets = createMobileTicketStore()
  const relays = new Map<string, RelayEntry>()
  const channels = new Map<string, ActiveChannel>()
  const idempotency = new Map<string, IdempotencyStore>()
  const reservations = new ReservationBook()
  const admission = new RelayAdmission()
  const cloudCache = new Map<number, { at: number; value: CloudReadiness }>()
  let disposed = false

  const registry: RelayRegistry = {
    get: (deviceId) => {
      const entry = relays.get(deviceId)
      return entry === undefined || entry.closed ? undefined : entry
    },
    listByUser: (userId) => [...relays.values()].filter((relay) => relay.userId === userId && !relay.closed),
    attach: (connection) => {
      const existing = relays.get(connection.deviceId)
      if (existing === connection) return
      relays.set(connection.deviceId, connection as RelayEntry)
    },
    /** 只有登记的就是这个实例才删（R2：旧连接关不掉新连接）。 */
    detach: (deviceId) => {
      const entry = relays.get(deviceId)
      if (entry !== undefined && entry.closed) relays.delete(deviceId)
    },
  }

  const log = (event: string, meta?: Record<string, unknown>): void => {
    deps.logger.debug({ mobile: event, ...meta }, '移动端')
  }

  /**
   * 常驻会话代理（WP46 / M6 §1）：`(userId,nodeId)` → 唯一的 NodeSession。
   *
   * 以前每条手机通道各自 `createNodeRemote()`，通道一断 adapter 的 `close()` 就把
   * 未决提问/审批 next 回 Host（真机事故：App 切后台，AI 自己删了文件）。现在通道只是
   * 观察者，adapter 跨通道共享，断开不再 next。
   */
  const nodeSessions = new NodeSessionRegistry({
    lingerMs,
    parkMs,
    log,
    // 容器停止/登出/设备吊销时，NodeSession 关闭要连带把还挂着的通道断掉：
    // 手机不能停在「还以为连着」的状态里等下一次请求超时。
    onChannelClosed: (channelId, reason) => {
      const active = channels.get(channelId)
      if (active === undefined) return
      active.channel.deliver({ v: 1, type: 'bye', code: 'node-offline', reason })
      void active.channel.dispose(`session-${reason}`)
    },
  })

  function idempotencyFor(userId: number, nodeId: string): IdempotencyStore {
    const key = `${String(userId)}:${nodeId}`
    let store = idempotency.get(key)
    if (store === undefined) {
      if (idempotency.size >= 512) {
        const oldest = idempotency.keys().next()
        if (!oldest.done) idempotency.delete(oldest.value)
      }
      store = new IdempotencyStore()
      idempotency.set(key, store)
    }
    return store
  }

  function audit(
    user: SessionUser | number,
    action: string,
    detail: Record<string, unknown>,
    ip: string | null,
  ): void {
    const actorId = typeof user === 'number' ? user : user.id
    deps.audit.log({ actorId, actorIp: ip, action, targetType: 'user', targetId: actorId, detail })
  }

  // ── 云节点 ────────────────────────────────────────────────────────────────

  async function cloudHeaders(user: SessionUser): Promise<Record<string, string>> {
    const cookie = await deps.services.proxy.mintDshCookie(user.slug)
    return { cookie: `${cookie.name}=${cookie.value}`, host: PROXY_AUTHORITY }
  }

  function cloudNodeOptions(user: SessionUser, target: { host: string; port: number }, park = false) {
    return {
      origin: `http://${target.host}:${String(target.port)}`,
      node: { id: 'cloud:self', kind: 'cloud' as const, name: '云实例', status: 'running' },
      headers: () => cloudHeaders(user),
      probeTimeoutMs: 3_000,
      // history/usage 的游标要等 mux 首连 + Host follow：比 probe 放宽，且 adapter 内部会再快速重试一次
      cursorTimeoutMs: 10_000,
      // WP46：只有常驻会话代理的 adapter 打开 park（通道断开不回 next、非订阅会话也接住）。
      // 探测/别的调用方保持老行为。
      ...(park ? { parkInteractions: { parkMs } } : {}),
      // 手机端计费信息（Hub 中转站）：模型列表显示渠道倍率、会话用量算积分消耗。
      // 老 App 不发这些请求就不触发；拿不到价格信息时钩子返回 null，adapter 会省略字段。
      pricing: {
        multiplierOf: (modelId: string) => deps.services.relay.modelMultiplier(modelId),
        costMicroOf: (input: {
          provider: string
          model: string
          tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
        }) =>
          deps.services.relay.quoteCostMicro({
            userId: user.id,
            model: input.model,
            tokens: input.tokens,
          }),
      },
      log,
    }
  }

  /**
   * 云实例的可连接性。
   *
   * `fresh=true` 跳过 30 秒缓存：`bootstrap` 在实例已经是 running 时必须立刻反映
   * 「通道能不能连」，否则 App 唤醒后要盯着旧缓存等半分钟（C0 实测冷唤醒 3 秒，
   * 缓存反而成了最慢的一环）。
   */
  async function cloudReadiness(user: SessionUser, options: { fresh?: boolean } = {}): Promise<CloudReadiness> {
    const cached = cloudCache.get(user.id)
    if (options.fresh !== true && cached !== undefined && Date.now() - cached.at < CLOUD_PROBE_TTL_MS) {
      return cached.value
    }
    let value: CloudReadiness
    const summary = await deps.services.instances.getSummary(user.id)
    if (summary.status !== 'running') {
      value = { status: summary.status, connectable: false, reason: 'instance-not-running' }
    } else {
      const info = await deps.driver.inspect(containerNameFor(user.slug, deps.config.containerPrefix))
      const target = info === null ? null : resolveUpstreamTarget(deps.driver, info)
      if (info === null || info.state !== 'running' || target === null) {
        value = { status: summary.status, connectable: false, reason: 'adapter-probe-failed' }
      } else {
        try {
          const remote = await createNodeRemote(cloudNodeOptions(user, target))
          value = { status: summary.status, connectable: true, capabilities: remote.capabilities }
          await remote.close()
        } catch (error) {
          value = {
            status: summary.status,
            connectable: false,
            reason:
              error instanceof NodeRemoteIncompatibleError ? 'adapter-incompatible' : 'adapter-probe-failed',
          }
          log('cloud.probe-failed', {
            reason:
              error instanceof NodeRemoteProbeError
                ? `${error.endpoint}: ${error.code}`
                : error instanceof Error
                  ? error.message
                  : String(error),
          })
        }
      }
    }
    cloudCache.set(user.id, { at: Date.now(), value })
    return value
  }

  async function openCloudRemote(user: SessionUser, options: { park?: boolean } = {}): Promise<NodeRemote | null> {
    const info = await deps.driver.inspect(containerNameFor(user.slug, deps.config.containerPrefix))
    const target = info === null ? null : resolveUpstreamTarget(deps.driver, info)
    if (info === null || info.state !== 'running' || target === null) return null
    try {
      return await createNodeRemote(cloudNodeOptions(user, target, options.park === true))
    } catch (error) {
      log('cloud.adapter-failed', { message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  // ── 常驻会话代理（WP46） ──────────────────────────────────────────────────

  /**
   * 取（或建）该用户云节点的 NodeSession。
   *
   * 并发安全：两条通道同时首连时只建一个 adapter（注册表里同一个 Promise 给所有等待者）。
   * 建不出来（容器没在跑/探测失败）返回 null，调用方按 `node-not-connectable` 关通道。
   */
  async function ensureCloudNodeSession(user: SessionUser): Promise<NodeSession | null> {
    if (disposed) return null
    return await nodeSessions.ensure(user.id, MOBILE_CLOUD_NODE_ID, () => openCloudRemote(user, { park: true }))
  }

  /**
   * 座舱节点的 adapter（参照 `cloud:self`）：**所有管理员连的是同一个容器** `dshhub-ops`。
   *
   * 为什么 cookie 用系统账号的 slug：容器里的 DSH 只认自己的浏览器 cookie，
   * 座舱令牌（Hub 侧凭据）管的是 Hub 的 `/ops/*`，与容器无关。
   * 会话按 `(adminId, 'cloud:ops')` 各建一条 adapter —— 会话列表来自容器本身，所以多个管理员
   * 看到的是同一份列表（docs/24 §10 决策 4：共享会话列表）。
   */
  function cockpitNodeOptions(user: SessionUser, target: { host: string; port: number }, park = false) {
    /** 登记「这条会话是谁开的」：幂等（第一次写入胜出），失败只记日志 */
    const recordInitiator = (sessionId: string): void => {
      try {
        recordCockpitSessionInitiator(deps.db, {
          sessionId,
          adminId: user.id,
          username: user.username,
          displayName: user.displayName.length > 0 ? user.displayName.slice(0, 64) : null,
          at: deps.clock.nowIso(),
        })
      } catch (error) {
        log('cockpit.initiator-record-failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      origin: `http://${target.host}:${String(target.port)}`,
      node: { id: MOBILE_COCKPIT_NODE_ID, kind: 'cloud' as const, name: '座舱 DSH', status: 'running' as const },
      headers: async () => {
        const cookie = await deps.services.proxy.mintDshCookie(SYSTEM_ACCOUNT_SLUG)
        return { cookie: `${cookie.name}=${cookie.value}`, host: PROXY_AUTHORITY }
      },
      probeTimeoutMs: 3_000,
      cursorTimeoutMs: 10_000,
      ...(park ? { parkInteractions: { parkMs } } : {}),
      // 座舱会话的发起人（docs/24 §6）：共享会话列表里要能看出「谁开的」
      onSessionCreated: recordInitiator,
      onSessionTouched: recordInitiator,
      decorateSessionRows: (items: MobileSessionRowV2[]) => {
        try {
          const who = cockpitSessionInitiators(deps.db, items.map((item) => item.sessionId))
          if (who.size === 0) return items
          return items.map((item) => {
            const initiator = who.get(item.sessionId)
            if (initiator === undefined) return item
            return {
              ...item,
              initiator: {
                username: initiator.username,
                ...(initiator.displayName === null ? {} : { displayName: initiator.displayName }),
              },
            }
          })
        } catch (error) {
          log('cockpit.initiator-read-failed', { message: error instanceof Error ? error.message : String(error) })
          return items
        }
      },
      log,
    }
  }

  async function openCockpitRemote(
    user: SessionUser,
    options: { park?: boolean } = {},
  ): Promise<NodeRemote | null> {
    const name = deps.services.cockpitOps.containerName()
    const info = await deps.driver.inspect(name)
    const target = info === null ? null : resolveUpstreamTarget(deps.driver, info)
    if (info === null || info.state !== 'running' || target === null) return null
    try {
      return await createNodeRemote(cockpitNodeOptions(user, target, options.park === true))
    } catch (error) {
      log('cockpit.adapter-failed', { message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** 取（或建）该管理员在座舱节点上的常驻会话代理。 */
  async function ensureCockpitNodeSession(user: SessionUser): Promise<NodeSession | null> {
    if (disposed) return null
    return await nodeSessions.ensure(user.id, MOBILE_COCKPIT_NODE_ID, () => openCockpitRemote(user, { park: true }))
  }

  /** 立即关闭该用户的云节点会话（容器停止/被休眠、登出、设备吊销、Hub 关闭）。 */
  async function closeUserNodeSessions(userId: number, reason: string): Promise<void> {
    await nodeSessions.closeUser(userId, reason)
  }

  /** 该用户当前还有几条手机通道（设备吊销后判断要不要顺带关掉 NodeSession）。 */
  function channelCountOf(userId: number): number {
    let count = 0
    for (const active of channels.values()) if (active.userId === userId) count += 1
    return count
  }

  // ── 节点列表 ──────────────────────────────────────────────────────────────

  /** 座舱作用域的节点表：**只有** `cloud:ops`（docs/24 §3.3）。 */
  async function cockpitNodes(): Promise<MobileNodesResponse> {
    return MobileNodesResponseSchema.parse({
      items: [await cockpitNode()],
      limits: {
        channelsPerUser: MOBILE_MAX_CHANNELS_PER_USER,
        channelsPerNode: MOBILE_MAX_CHANNELS_PER_NODE,
        idleMs: MOBILE_CHANNEL_IDLE_MS,
        maxFrameBytes: 262_144,
      },
    })
  }

  /**
   * 座舱节点：状态直接取 `cockpitOps.probe.status()`（与顶栏胶囊同一个来源）。
   * connectable 只在 running 时为真——容器没起来时 App 立刻显示「未运行」而不是等超时。
   */
  async function cockpitNode(): Promise<MobileNode> {
    let status: OpsStatus | null = null
    try {
      status = await deps.services.cockpitOps.status()
    } catch (error) {
      log('cockpit.status-failed', { message: error instanceof Error ? error.message : String(error) })
    }
    const instance = status?.instance ?? 'missing'
    const mapped: MobileNode['status'] =
      instance === 'running'
        ? 'running'
        : instance === 'starting'
          ? 'starting'
          : instance === 'stopped'
            ? 'stopped'
            : instance === 'error'
              ? 'error'
              : 'absent'
    return {
      id: MOBILE_COCKPIT_NODE_ID,
      kind: 'cloud',
      name: '座舱 DSH',
      status: mapped,
      connectable: instance === 'running',
      ...(instance === 'running' ? {} : { reason: 'instance-not-running' as MobileNodeBlockedReason }),
      ...(status?.model === null || status?.model === undefined ? {} : { clientVersion: status.model }),
    }
  }

  async function listNodes(
    user: SessionUser,
    options: { freshCloud?: boolean; device?: MobileDeviceIdentity | null } = {},
  ): Promise<MobileNodesResponse> {
    // 座舱作用域（docs/24 §3.3）：节点列表只有 cloud:ops，看不到自己的云实例与桌面设备
    if (options.device?.scope === 'cockpit') return cockpitNodes()
    const items: MobileNode[] = []
    const cloud = await cloudReadiness(user, { fresh: options.freshCloud === true })
    items.push({
      id: 'cloud:self',
      kind: 'cloud',
      name: '云实例',
      status: cloud.status,
      connectable: cloud.connectable,
      ...(cloud.reason === undefined ? {} : { reason: cloud.reason }),
      ...(cloud.capabilities === undefined ? {} : { capabilities: cloud.capabilities }),
    })

    // 手机设备（WP40a）与桌面设备共用台账，但手机不是「后端」：只把桌面端列进来
    const desktops = deps.services.desktop.listMine(user.id).items.filter((item) => deviceKindOf(item) === 'desktop')
    for (const device of desktops) {
      const relay = registry.get(device.deviceId)
      const capabilities = relay?.capabilities ?? null
      const connectable =
        relay !== undefined &&
        relay.hostStatus === 'running' &&
        capabilities !== null &&
        isCompleteCapabilities(capabilities)
      const reason: MobileNodeBlockedReason | undefined = connectable
        ? undefined
        : relay === undefined
          ? 'desktop-relay-disconnected'
          : relay.hostStatus !== 'running'
            ? 'desktop-host-stopped'
            : 'desktop-needs-upgrade'
      items.push({
        id: device.deviceId,
        kind: 'desktop',
        name: device.name,
        status: relay === undefined ? 'unknown' : mapDesktopStatus(relay.hostStatus),
        presence: device.presence,
        connectable,
        ...(reason === undefined ? {} : { reason }),
        ...(capabilities === null ? {} : { capabilities }),
        ...(device.appVersion === null || device.appVersion === undefined
          ? {}
          : { clientVersion: device.appVersion }),
      })
    }

    return MobileNodesResponseSchema.parse({
      items,
      limits: {
        channelsPerUser: MOBILE_MAX_CHANNELS_PER_USER,
        channelsPerNode: MOBILE_MAX_CHANNELS_PER_NODE,
        idleMs: MOBILE_CHANNEL_IDLE_MS,
        maxFrameBytes: 262_144,
      },
    })
  }

  // ── App 首屏（v2 §4.2） ───────────────────────────────────────────────────

  /**
   * 手机网页版（`platform='web'`，WP54a）的 `bootstrap.app`：**没有 APK 更新，也没有强更地板**。
   *
   * 为什么由 Hub 主动下发「无更新」形态，而不是照发 APK 的值让 App 自己忽略：
   * 1. 网页版没有 versionCode —— 它的版本是 Hub 上那份构建（`/m/version.json`），与 APK 的
   *    数字版本没有任何对应关系，拿 `minVersionCode=7` 去比是**无意义的比较**。一旦网页端漏了
   *    忽略判断（或以后多出一个别的网页客户端），用户会被锁进「请升级到新版」的弹窗，而那个
   *    「新版」是 APK，在浏览器里装不上 —— 故障模式是「用不了」。
   * 2. 反过来，把值降到「什么都不用做」（地板 0、最新 0、没有下载地址/镜像），任何按数值比较的
   *    客户端都不会被拦、也不会显示下载入口；契约形状（`MobileAppInfoSchema`）本来就允许
   *    `downloadUrl: null` 与非负整数，所以这只是**填值**，没有改契约。
   * 3. cookie 路径（0.2.0 老 APK）与 android/ios 拿到的仍是设置里的值，行为不变。
   */
  const WEB_APP_INFO = { minVersionCode: 0, latestVersionCode: 0, downloadUrl: null, downloadMirrors: [] } as const

  /**
   * `bootstrap.app` 的三项：**管理端设置**与**安卓发布记录**两个来源，规则写死在这里：
   *
   * - `downloadUrl`：管理端显式配了就用它（允许托管在别处），否则用当前 APK 发布记录的绝对地址；
   * - `latestVersionCode`：取「发布记录的 versionCode」与「设置里的值」的**较大者** ——
   *   上传 APK 就自动把最新版本号告诉 App，不需要管理员再手填一次；
   * - `minVersionCode`：只认设置（强更地板是运营决定，不由发布动作隐式改变）。
   *
   * `platform` = 当前设备台账里的手机平台：`'web'` 走上面的「无更新」形态，其余（含 null）照旧。
   */
  function appReleaseInfo(
    origin: RequestOrigin,
    platform: DesktopMobilePlatform | null,
  ): {
    minVersionCode: number
    latestVersionCode: number
    downloadUrl: string | null
    downloadMirrors: readonly string[]
  } {
    if (platform === 'web') return WEB_APP_INFO
    const settingsApp = deps.settings.get('mobile').app
    const releaseCode = deps.services.mobileApp.latestVersionCode()
    const releaseUrl = deps.services.mobileApp.downloadUrl(origin)
    return {
      minVersionCode: settingsApp.minVersionCode,
      latestVersionCode:
        releaseCode === null ? settingsApp.latestVersionCode : Math.max(settingsApp.latestVersionCode, releaseCode),
      downloadUrl: settingsApp.downloadUrl ?? releaseUrl,
      // WP52：同一个 APK 的镜像列表（本入口第一）。管理端显式配了 downloadUrl 也照发 ——
      // 它只是「首选地址」，镜像列表描述的是发布记录里那个文件的其他可用位置，老 App 忽略。
      downloadMirrors: deps.services.mobileApp.downloadMirrors(origin),
    }
  }

  /**
   * 这台设备在台账里的手机平台（WP54a）。查不到 / 不是自己的设备 / 老 cookie 路径（没有设备身份）
   * → null，也就是「照旧发 APK 更新信息」。
   */
  function mobilePlatformOf(userId: number, device: MobileDeviceIdentity | null): DesktopMobilePlatform | null {
    if (device === null) return null
    const row = getDeviceRow(deps.db, device.deviceId)
    if (row === undefined || row.user_id !== userId) return null
    return row.mobile_platform
  }

  /**
   * 座舱 iframe 的首屏：用户身份 + 座舱节点 + 语音能力 + 服务器时间。
   *
   * 刻意**不给**：积分（座舱用量不扣任何人）、实例状态（那是管理员自己的云实例，与座舱无关）、
   * APK 更新信息（嵌入模式没有下载入口）。`app` 用网页版的「无更新」形态，避免 App 端
   * 任何按版本号比较的分支误触发升级弹窗。
   */
  async function cockpitBootstrap(user: SessionUser): Promise<MobileBootstrapResponse> {
    const [asrAvailable, ttsAvailable] = await Promise.all([
      deps.services.mobileAsr.available(),
      deps.services.mobileTts.available(),
    ])
    return MobileBootstrapResponseSchema.parse({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      points: { balance: 0, enabled: false },
      backends: [await cockpitNode()],
      instance: { status: 'running', capacityFull: false },
      app: WEB_APP_INFO,
      voice: {
        ...mobileVoiceInfo(asrAvailable),
        tts: mobileTtsInfo(ttsAvailable, deps.config.ttsStreamEnabled),
      },
      serverTime: deps.clock.nowIso(),
    })
  }

  /**
   * `GET /api/mobile/bootstrap`：App 打开后的第一屏。
   *
   * 复用而不是重写：
   * - 后端列表 = `listNodes`（云 `cloud:self` + 该用户的桌面节点，`connectable` 语义与 v1 完全一致）；
   * - 实例状态 = `instances.getSummary`；`capacityFull` = 正在跑/正在起的数量达到
   *   `settings.capacity.maxRunning`（与 `ensureRunning` 的准入同一条判据）；
   * - 积分 = `relay.myRelay` 的 `enabled` 与钱包余额（库里是微积分，这里换算成积分）；
   * - App 版本地板 = `settings.mobile.app`（管理端可配，默认 1/1/null）；
   *   手机网页版（`platform='web'`）例外：没有 APK 也没有地板，见 `WEB_APP_INFO`。
   *
   * `device` 是当前请求的设备身份（Bearer 才有；老 APK 的 cookie 路径是 null）—— 只用来判断
   * 是不是网页版，不影响其余字段。
   */
  async function bootstrap(
    user: SessionUser,
    origin: RequestOrigin,
    device: MobileDeviceIdentity | null,
  ): Promise<MobileBootstrapResponse> {
    // 座舱作用域：只给通道需要的字段（docs/24 §3.3），不暴露实例状态、积分、APK 更新
    if (device?.scope === 'cockpit') return cockpitBootstrap(user)
    const summary = await deps.services.instances.getSummary(user.id)
    // 实例已经在跑：绕开探测缓存，让 `connectable` 立刻变成 true（App 唤醒后的轮询要看到它）
    const nodes = await listNodes(user, { freshCloud: summary.status === 'running' })
    const counts = deps.services.instances.counts()
    let points: MobileBootstrapResponse['points'] = { balance: 0, enabled: false }
    try {
      const relay = deps.services.relay
      if (relay !== undefined) {
        const mine = relay.myRelay(user.id, user.role)
        points = {
          balance: mine.wallet.balanceMicro / RELAY_MICRO_PER_POINT,
          enabled: mine.enabled,
        }
      }
    } catch (error) {
      // 积分是附加信息：读失败不该让 App 进不去（下一轮轮询会重试）
      log('bootstrap.wallet-failed', { message: error instanceof Error ? error.message : String(error) })
    }
    const app = appReleaseInfo(origin, mobilePlatformOf(user.id, device))
    // WP49/WP50：语音能力。`asr` / `tts.enabled` 都是本机服务的 30 秒健康缓存（失败即 false，
    // 老 App 不读这些字段；新 App 据此决定「按住说话」走 Hub 还是系统识别、要不要显示朗读入口）。
    // 两个探测并行发：bootstrap 的总延迟不叠加。
    const [asrAvailable, ttsAvailable] = await Promise.all([
      deps.services.mobileAsr.available(),
      deps.services.mobileTts.available(),
    ])
    return MobileBootstrapResponseSchema.parse({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      points,
      backends: nodes.items,
      instance: { status: summary.status, capacityFull: counts.running >= counts.max },
      app: {
        minVersionCode: app.minVersionCode,
        latestVersionCode: app.latestVersionCode,
        downloadUrl: app.downloadUrl,
        // WP52：App 自动更新按这个顺序回退（老 App 忽略这个字段）
        downloadMirrors: app.downloadMirrors,
      },
      // WP51：`tts.stream` = 朗读可用 + `HUB_TTS_STREAM_ENABLED`（关掉后 App 只走整段朗读）
      voice: {
        ...mobileVoiceInfo(asrAvailable),
        tts: mobileTtsInfo(ttsAvailable, deps.config.ttsStreamEnabled),
      },
      serverTime: deps.clock.nowIso(),
    })
  }

  /**
   * `POST /api/mobile/instance/wake`：复用 instances 的 `ensureRunning`（不是另写一套启动）。
   *
   * 契约要 202 + `{status}`，而 `ensureRunning` 会一直等到容器就绪（最长 90 秒）。
   * 做法是**同步等一小段窗口**：准入拒绝（容量满 / 余额不足 / 磁盘配额 / 镜像没就绪）
   * 都在建容器之前发生，几百毫秒内就能拿到；拿到就按契约回错误码。
   * 超出窗口说明已经在建/在起了 → 回 `starting`，后台继续跑（App 轮询 bootstrap）。
   */
  async function wake(user: SessionUser): Promise<MobileWakeResponse> {
    let summary = await deps.services.instances.getSummary(user.id)
    // 上线决定 ①（2026-10-25）：首次唤醒自动开通实例
    if (summary.status === 'absent') summary = await provisionOnFirstWake(user)
    if (summary.status === 'running') return MobileWakeResponseSchema.parse({ status: 'running' })

    const task = deps.services.instances.ensureRunning(user.id, { reason: 'user' })
    // 后台失败只记日志（App 会在下一次 bootstrap 看到 status=error/stopped）
    void task.then(
      () => log('wake.ready', { userId: user.id }),
      (error: unknown) => {
        log('wake.failed', {
          userId: user.id,
          code: HubError.is(error) ? error.code : 'INTERNAL',
        })
      },
    )
    const outcome = await new Promise<
      { kind: 'done'; status: MobileWakeResponse['status'] } | { kind: 'pending' } | { kind: 'error'; error: unknown }
    >((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'pending' }), wakeSyncMs)
      timer.unref()
      void task.then(
        (value) => {
          clearTimeout(timer)
          resolve({ kind: 'done', status: value.status })
        },
        (error: unknown) => {
          clearTimeout(timer)
          resolve({ kind: 'error', error })
        },
      )
    })
    if (outcome.kind === 'error') throw mapWakeError(outcome.error)
    if (outcome.kind === 'done') return MobileWakeResponseSchema.parse({ status: outcome.status })
    return MobileWakeResponseSchema.parse({ status: 'starting' })
  }

  /**
   * 首次唤醒自动开通（上线决定 ①，2026-10-25）。
   *
   * 背景：`provision`（建目录 + 实例行 + 渲染 managed 文件）原来只在**自助注册**里调用，
   * 管理员在后台建的用户、以及 M1 之前就存在的老用户都没有实例行，App 上只能看到
   * `INSTANCE_ABSENT`（「请联系管理员」）。
   *
   * 现在改成：账号 active 且已审批的用户，App 第一次 wake 时自动走**同一条** `provision` 路径。
   * - 不复制逻辑：直接调 `instances.provision`（与 `auth` 注册后调用的是同一个方法）；
   * - 开通本身不建容器：只建目录、写实例行（`stopped`）、渲染 managed 补丁；真正的启动还是
   *   后面的 `ensureRunning`，磁盘配额 / 容量 / 余额 / 镜像这些准入检查一条都没绕过；
   * - 开通是**同步**做的（几百毫秒）：这样开通失败能立刻回明确的错误码，而不是被
   *   `starting` 吞掉（App 只能轮询到 status=stopped，永远看不到原因）；
   * - 幂等：并发两次 wake 时 `instances.provision` 内部有按用户的锁（`lock(userId, …)`），
   *   第二次会看到实例行已存在，不会建两遍。
   *
   * 账号状态：`/api/mobile/*` 的鉴权（Bearer / cookie）每个请求都会校验「active + 未改密 + 未删除」，
   * 正常走到这里的用户一定是 active 且已审批；这里再判一次是**防御性**的（错误码明确、不误开通）。
   */
  async function provisionOnFirstWake(user: SessionUser): Promise<InstanceSummary> {
    if (user.status !== 'active') {
      // 与手机鉴权同一套语义：停用 → USER_DISABLED，待审批 → USER_PENDING
      throw new HubError(user.status === 'pending' ? 'USER_PENDING' : 'USER_DISABLED')
    }
    let summary: InstanceSummary
    try {
      summary = await deps.services.instances.provision(user.id)
    } catch (error) {
      const cause = HubError.is(error) ? error.code : 'INTERNAL'
      log('wake.auto-provision.failed', { userId: user.id, code: cause })
      audit(user, 'mobile.instance.provision', { result: 'failed', cause }, null)
      // 明确错误码：App 端按 INSTANCE_PROVISION_FAILED 提示「开通失败，可重试」
      throw new HubError('INSTANCE_PROVISION_FAILED', '开通云实例失败，请稍后重试或联系管理员', { cause })
    }
    if (summary.status === 'absent') {
      // 理论上不会发生（provision 一定落行）；落不到行就是内部错误，别把 absent 当成成功返回
      throw new HubError('INSTANCE_PROVISION_FAILED', '开通云实例失败：实例行没有建成', { cause: 'absent-after-provision' })
    }
    log('wake.auto-provision', { userId: user.id, status: summary.status })
    audit(user, 'mobile.instance.provision', { result: 'ok', status: summary.status }, null)
    return summary
  }

  /** 启动准入的错误码按契约映射（wake 的容量满要 409，网页端是 503） */
  function mapWakeError(error: unknown): unknown {
    if (!HubError.is(error)) return error
    if (error.code === 'CAPACITY_FULL') {
      return new HubError('CAPACITY_FULL', error.message, error.details, { httpStatus: 409 })
    }
    return error
  }

  // ── 一次性通道 ticket（v2 §4.1 / §3） ──────────────────────────────────────

  async function issueTicket(
    user: SessionUser,
    nodeId: string,
    device: MobileDeviceIdentity | null,
  ): Promise<MobileTicketResponse> {
    await assertNodeVisible(user, nodeId, device?.scope ?? 'mobile')
    const ticket = tickets.issue(
      { userId: user.id, deviceId: device?.deviceId ?? null, nodeId },
      deps.clock.nowIso(),
    )
    audit(user, 'mobile.ticket.issue', { nodeId, deviceId: device?.deviceId ?? null }, null)
    return MobileTicketResponseSchema.parse({ ticket: ticket.ticket, expiresAt: ticket.expiresAt })
  }

  /**
   * 节点 id 必须存在于该用户的节点列表里（别人的设备一律 404，不做归属探测）。
   *
   * 作用域（docs/24 §3.3）：座舱令牌只看得见 `cloud:ops`，普通令牌看不见 `cloud:ops`。
   * 作用域从 nodeId 反推而不是再传一个参数：票/通道里只有 nodeId，两处判据必须是同一份。
   */
  async function assertNodeVisible(
    user: SessionUser,
    nodeId: string,
    scope: 'mobile' | 'cockpit',
  ): Promise<void> {
    if (nodeId === MOBILE_COCKPIT_NODE_ID) {
      // 座舱节点只对「座舱作用域的管理员」开放：普通手机令牌即使猜到 id 也看不到
      if (scope !== 'cockpit' || user.role !== 'admin') throw new HubError('NOT_FOUND', '节点不存在')
      return
    }
    if (scope === 'cockpit') throw new HubError('NOT_FOUND', '节点不存在')
    if (nodeId === MOBILE_CLOUD_NODE_ID) return
    const device = deps.services.desktop
      .listMine(user.id)
      .items.find((item) => item.deviceId === nodeId && deviceKindOf(item) === 'desktop')
    if (device === undefined) throw new HubError('NOT_FOUND', '节点不存在')
  }

  // ── 升级分派 ──────────────────────────────────────────────────────────────

  function attachUpgrade(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (path === DESKTOP_RELAY_PATH) {
        void handleRelayUpgrade(req, socket, head).catch((error: unknown) => {
          deps.logger.warn({ err: error }, '移动端：中继升级失败')
          try {
            rejectUpgrade(socket, 500, 'RELAY_UPGRADE_FAILED')
          } catch {
            // 对端已断开
          }
        })
        return
      }
      if (path.startsWith(`${MOBILE_NODES_PATH}/`)) {
        void handleMobileUpgrade(req, socket, head).catch((error: unknown) => {
          deps.logger.warn({ err: error }, '移动端：通道升级失败')
          try {
            rejectUpgrade(socket, 500, 'CHANNEL_UPGRADE_FAILED')
          } catch {
            // 对端已断开
          }
        })
        return
      }
      // 其他路径不碰 socket
    })
  }

  // ── 手机通道 ──────────────────────────────────────────────────────────────

  /**
   * 手机通道升级。两种鉴权并存（v2 §4.1）：
   *
   * 1. **ticket**（v2 App）：`?ticket=…`，一次性、30 秒、绑定用户/设备/节点。
   *    浏览器 WebSocket 不能带 `Authorization` 头，所以凭据只能走查询串 —— 必须是短命一次性的票。
   * 2. **cookie**（0.2.0 老 APK）：`hub_sid`，行为与 M1 完全一致，不动。
   *
   * Origin：ticket 路径放行配置里的 App 来源（`https://localhost` / `capacitor://localhost`）；
   * cookie 路径沿用原来的判定（公网 origin + 本机 origin，且本机 origin 只认回环请求）。
   */
  async function handleMobileUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!isWebSocketUpgrade(req)) return rejectUpgrade(socket, 400, 'WEBSOCKET_REQUIRED')

    const nodeId = nodeIdOf(req.url ?? '')
    if (nodeId === null) return rejectUpgrade(socket, 404, 'NODE_NOT_FOUND')
    const ticketValue = queryParam(req.url ?? '', 'ticket')

    let user: SessionUser
    let validate: () => { id: number } | null
    let deviceId: string | null = null

    if (ticketValue !== null) {
      if (!appOriginAllowed(req)) return rejectUpgrade(socket, 403, 'ORIGIN_NOT_ALLOWED')
      // 一次性：无论后面的校验是否通过，这张票都不再可用（防重放）
      const ticket = tickets.consume(ticketValue, deps.clock.nowIso())
      if (ticket === null) return rejectUpgrade(socket, 401, 'TICKET_INVALID')
      if (ticket.nodeId !== nodeId) return rejectUpgrade(socket, 403, 'TICKET_NODE_MISMATCH')
      const resolved = loadActiveUser(ticket.userId)
      if (resolved === null) return rejectUpgrade(socket, 401, 'UNAUTHENTICATED')
      if (ticket.deviceId !== null) {
        if (!deps.services.mobileAuth.isDeviceUsable(ticket.userId, ticket.deviceId)) {
          return rejectUpgrade(socket, 403, 'DEVICE_REVOKED')
        }
        deviceId = ticket.deviceId
      }
      user = resolved
      validate = ticketValidator(ticket.userId, ticket.deviceId)
    } else {
      if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'ORIGIN_NOT_ALLOWED')
      const token = cookieValue(req.headers.cookie, SESSION_COOKIE_NAME)
      const current = token === null ? null : resolveSession(deps.db, token, deps.clock.nowIso())
      if (token === null || current === null) return rejectUpgrade(socket, 401, 'UNAUTHENTICATED')
      // 与网页端一致：必须已改初始密码，否则移动端也不给进
      if (current.mustChangePassword) return rejectUpgrade(socket, 403, 'PASSWORD_CHANGE_REQUIRED')
      user = current
      validate = () => {
        const again = resolveSession(deps.db, token, deps.clock.nowIso())
        return again === null || again.mustChangePassword ? null : { id: again.id }
      }
    }

    try {
      // 升级路径的作用域由节点反推：`cloud:ops` 只可能来自座舱票（issueTicket 已经把闸门卡过）
      await assertNodeVisible(user, nodeId, nodeId === MOBILE_COCKPIT_NODE_ID ? 'cockpit' : 'mobile')
    } catch {
      return rejectUpgrade(socket, 404, 'NODE_NOT_FOUND')
    }

    // R9：异步握手前先占配额，断开/失败都要释放
    if (!reserve(user.id, nodeId)) return rejectUpgrade(socket, 429, 'TOO_MANY_CONNECTIONS')
    let aborted = false
    socket.once('close', () => {
      aborted = true
    })

    try {
      if (nodeId === MOBILE_COCKPIT_NODE_ID) {
        const session = await ensureCockpitNodeSession(user)
        if (aborted || socket.destroyed) {
          release(user.id, nodeId)
          return
        }
        const connection = acceptUpgrade(req, socket, head)
        if (session === null) {
          release(user.id, nodeId)
          failChannel(connection, 'node-not-connectable', '座舱 DSH 当前不可连接（容器没在跑）')
          return
        }
        startChannel(connection, user, nodeId, { kind: 'session', session }, validate, deviceId)
        return
      }
      if (nodeId === MOBILE_CLOUD_NODE_ID) {
        // WP46：取（或建）该用户唯一的常驻会话代理；通道只是它的观察者。
        const session = await ensureCloudNodeSession(user)
        if (aborted || socket.destroyed) {
          // 握手期间客户端就跑了：新会话没人挂，按 linger 自己收（不在这里 close，
          // 避免和并发连上来的另一条通道抢同一个 adapter）
          release(user.id, nodeId)
          return
        }
        const connection = acceptUpgrade(req, socket, head)
        if (session === null) {
          release(user.id, nodeId)
          failChannel(connection, 'node-not-connectable', '云实例当前不可连接')
          return
        }
        startChannel(connection, user, nodeId, { kind: 'session', session }, validate, deviceId)
        return
      }
      const relay = registry.get(nodeId)
      const connection = acceptUpgrade(req, socket, head)
      if (relay === undefined || relay.hostStatus !== 'running' || relay.capabilities === null) {
        release(user.id, nodeId)
        failChannel(connection, 'node-offline', '桌面节点未连接到 Hub 或未开启远程访问')
        return
      }
      startChannel(connection, user, nodeId, { kind: 'desktop', relay }, validate, deviceId)
    } catch (error) {
      release(user.id, nodeId)
      throw error
    }
  }

  /** 用 id 取一个「仍然可用」的用户（停用/待审批/已删除/必须改密 → null） */
  function loadActiveUser(userId: number): SessionUser | null {
    const row = deps.db.get<{
      id: number
      slug: string
      username: string
      display_name: string
      avatar_file: string | null
      role: 'user' | 'admin'
      status: string
      must_change_password: number
      deleted_at: string | null
      created_at: string
    }>(
      `SELECT id, slug, username, display_name, avatar_file, role, status, must_change_password,
              deleted_at, created_at
         FROM users WHERE id = ?`,
      userId,
    )
    if (row === undefined || row.deleted_at !== null || row.status !== 'active') return null
    if (row.must_change_password === 1) return null
    const at = deps.clock.nowIso()
    return {
      id: row.id,
      slug: row.slug,
      username: row.username,
      displayName: row.display_name,
      avatarFile: row.avatar_file,
      role: row.role,
      status: 'active',
      mustChangePassword: false,
      sessionId: `mob-ticket:${String(row.id)}`,
      createdAt: row.created_at,
      expiresAt: at,
      lastSeenAt: at,
      reauthAt: null,
    }
  }

  /** ticket 通道的复查：用户仍可用 + 设备未被吊销（每 20 秒一次，见 MobileChannel） */
  function ticketValidator(userId: number, deviceId: string | null): () => { id: number } | null {
    return () => {
      if (loadActiveUser(userId) === null) return null
      if (deviceId !== null && !deps.services.mobileAuth.isDeviceUsable(userId, deviceId)) return null
      return { id: userId }
    }
  }

  function failChannel(connection: WsConnection, code: MobileErrorCode, message: string): void {
    connection.send(JSON.stringify({ v: 1, type: 'error', code, message, retryable: false }))
    connection.send(JSON.stringify({ v: 1, type: 'bye', code, reason: message }))
    connection.close(1008, message)
  }

  function reserve(userId: number, nodeId: string): boolean {
    const active = [...channels.values()].filter((item) => item.userId === userId)
    const activeNode = active.filter((item) => item.nodeId === nodeId)
    const pending = reservations.counts(userId, nodeId)
    if (active.length + pending.user >= MOBILE_MAX_CHANNELS_PER_USER) {
      const stale = active[0]
      if (stale === undefined) return false
      closeActive(stale, '有新设备接入，本连接被关闭')
    }
    if (activeNode.length + pending.node >= MOBILE_MAX_CHANNELS_PER_NODE) {
      const stale = activeNode[0]
      if (stale !== undefined) closeActive(stale, '同一节点连接数超限，旧连接被关闭')
      else return false
    }
    return reservations.reserve(userId, nodeId, MOBILE_MAX_CHANNELS_PER_USER, MOBILE_MAX_CHANNELS_PER_NODE)
  }

  function release(userId: number, nodeId: string): void {
    reservations.release(userId, nodeId)
  }

  function closeActive(active: ActiveChannel, reason: string): void {
    active.channel.deliver({ v: 1, type: 'bye', code: 'rate-limited', reason })
    void active.channel.dispose('limit')
  }

  function startChannel(
    connection: WsConnection,
    user: SessionUser,
    nodeId: string,
    node: ChannelNode,
    validate: () => { id: number } | null,
    deviceId: string | null = null,
  ): void {
    release(user.id, nodeId)
    const channel = new MobileChannel(
      connection,
      {
        userId: user.id,
        nodeId,
        node,
        validateSession: validate,
        audit: (action, detail) => {
          audit(user, action, { nodeId, ...(detail ?? {}) }, connection.remoteAddress)
        },
      },
      idempotencyFor(user.id, nodeId),
      log,
      (id) => channels.delete(id),
    )
    channels.set(channel.id, {
      channel,
      userId: user.id,
      nodeId,
      ...(deviceId === null ? {} : { deviceId }),
      ...(node.kind === 'desktop' ? { relay: node.relay } : {}),
    })
    void channel.start().catch((error: unknown) => {
      log('channel.start-failed', { message: error instanceof Error ? error.message : String(error) })
      void channel.dispose('start-failed')
    })
  }

  // ── 桌面中继 ──────────────────────────────────────────────────────────────

  async function handleRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!isWebSocketUpgrade(req)) return rejectUpgrade(socket, 400, 'WEBSOCKET_REQUIRED')
    const token = bearerOf(req)
    const principal = token === null ? null : deps.services.desktop.resolveDeviceToken(token)
    if (token === null || principal === null) return rejectUpgrade(socket, 401, 'UNAUTHENTICATED')
    if (principal.user.mustChangePassword) return rejectUpgrade(socket, 403, 'PASSWORD_CHANGE_REQUIRED')

    // R2：upgrade 即占代际；第二个同设备 socket 在这里就被拒，不存在先都通过再互相覆盖
    const generation = randomUUID()
    if (!admission.begin(principal.device.deviceId, generation, 10_000, () => undefined)) {
      return rejectUpgrade(socket, 429, 'DEVICE_ALREADY_CONNECTED')
    }
    const connection = acceptUpgrade(req, socket, head)
    registerRelay(connection, principal.user.id, principal.device.deviceId, token, generation)
  }

  function registerRelay(
    connection: WsConnection,
    userId: number,
    deviceId: string,
    token: string,
    generation: string,
  ): void {
    let hello: DesktopRelayHello | null = null
    const relay: RelayEntry = {
      deviceId,
      generation,
      userId,
      clientVersion: '',
      hostStatus: 'starting',
      capabilities: null,
      // WP48：旧 connector 不发 `relayFeatures` → null = 中继只放行 v1 帧。
      relayFeatures: null,
      closed: false,
      channels: new Set<string>(),
      send: (envelope) => {
        if (!connection.closed) connection.send(JSON.stringify(envelope))
      },
      close: (code, reason) => {
        for (const channelId of relay.channels) {
          connection.send(JSON.stringify({ v: 1, type: 'close', channelId, code, reason }))
        }
        connection.close(1008, reason)
      },
    }

    const detach = (code: MobileErrorCode | 'node-offline', reason: string): void => {
      if (relay.closed) return
      relay.closed = true
      // 只有登记的还是本实例时才删（旧代际不会误删新连接）
      if (relays.get(deviceId) === relay && admission.isLive(deviceId, generation)) relays.delete(deviceId)
      admission.release(deviceId, generation)
      for (const channelId of relay.channels) {
        const active = channels.get(channelId)
        // 只关属于本 relay 实例的通道
        if (active === undefined || active.relay !== relay) continue
        active.channel.deliver({ v: 1, type: 'bye', code, reason })
        void active.channel.dispose(code)
      }
      relay.channels.clear()
      log('relay.detached', { deviceId, generation: relay.generation })
    }

    const timers: NodeJS.Timeout[] = []
    const schedule = (intervalMs: number, task: () => void): void => {
      const timer = setInterval(task, intervalMs)
      timer.unref()
      timers.push(timer)
    }
    schedule(RELAY_HEARTBEAT_MS, () => {
      if (connection.closed) return
      if (Date.now() - connection.lastActivityAt > RELAY_IDLE_MS) {
        connection.close(1008, 'relay idle timeout')
        return
      }
      connection.ping()
    })
    // 吊销复检独立定时器：不能被 25s 心跳周期拖住
    schedule(relayRevalidateMs, () => {
      if (connection.closed) return
      if (deps.services.desktop.resolveDeviceToken(token) === null)
        relay.close('session-expired', '设备令牌已失效')
    })
    connection.onClose(() => {
      for (const timer of timers.splice(0)) clearInterval(timer)
      detach('node-offline', '桌面已断开')
    })

    connection.onText((text) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        connection.close(1002, 'invalid json')
        return
      }
      // v2：用扩展后的外层解析，否则 v2 服务端帧（tool/file/uploaded…）会被静默丢掉
      const envelope = DesktopRelayFrameEnvelopeV2Schema.safeParse(parsed)
      if (!envelope.success) {
        connection.close(1002, 'invalid relay frame')
        return
      }
      const frame = envelope.data
      if (frame.type === 'hello') {
        if (frame.deviceId !== deviceId) {
          connection.close(1008, 'device mismatch')
          return
        }
        const firstHello = hello === null
        if (firstHello) {
          // 首次 hello：把 upgrade 时预留的 pending 名额转成 live
          if (!admission.confirm(deviceId, generation)) {
            connection.close(1008, 'relay superseded')
            return
          }
        } else if (!admission.isLive(deviceId, generation)) {
          // 本代际已被更新的连接顶替：旧连接不再接受刷新
          connection.close(1008, 'relay superseded')
          return
        }
        // 桌面连接器会在本机 probe 结果变化时**再次**发 hello 刷新能力（bridge.ts 的
        // runProbe 成功后调用 relay.hello()）。同一代际的重复 hello 是协议允许的刷新，
        // 不是顶替：更新字段后继续服务，不再关闭连接，也不重复记审计。
        hello = frame
        relay.clientVersion = frame.clientVersion
        relay.hostStatus = frame.hostStatus
        relay.capabilities = frame.capabilities
        // WP48 / 评估 R1：中继层自己也要声明它放行哪些 v2 帧。没有这个声明的 connector
        // 只认 v1 的 11 种帧 —— 桌面通道的 hello 会被降级成 v1 形状（channel.ts）。
        relay.relayFeatures = frame.relayFeatures ?? null
        registry.attach(relay)
        if (firstHello)
          audit(userId, 'desktop.relay.attach', { deviceId, hostStatus: frame.hostStatus }, null)
        return
      }
      if (hello === null) {
        connection.close(1008, 'hello required')
        return
      }
      if (frame.type === 'frame') {
        const active = channels.get(frame.channelId)
        if (active === undefined) return
        // R1：跨用户/跨设备/旧 relay 实例一律不投递
        if (
          !canRelayRoute(
            {
              userId: active.userId,
              nodeId: active.nodeId,
              relay: active.relay ?? relay,
              channelId: frame.channelId,
            },
            relay,
          )
        )
          return
        const payload = MobileServerFrameAllSchema.safeParse(frame.payload)
        if (!payload.success) return
        active.channel.deliver(payload.data)
        return
      }
      if (frame.type === 'close') {
        const active = channels.get(frame.channelId)
        if (active === undefined) return
        if (
          !canRelayRoute(
            {
              userId: active.userId,
              nodeId: active.nodeId,
              relay: active.relay ?? relay,
              channelId: frame.channelId,
            },
            relay,
          )
        )
          return
        active.channel.deliver({ v: 1, type: 'bye', code: frame.code, reason: frame.reason })
        void active.channel.dispose(frame.code)
      }
    })
  }

  // ── 请求解析 ──────────────────────────────────────────────────────────────

  /**
   * 两个对外 origin（公网入口 `HUB_PUBLIC_ORIGIN` + 边缘入口 `HUB_EDGE_ORIGIN`）都可信：
   * App 可能在两个入口之间切换（08 §3 的例外条款），换入口后同一个 Hub 后端仍要能用。
   * 边缘入口未配置时只有公网入口一个。
   */
  function trustedHubOrigins(): string[] {
    return deps.config.edgeOrigin === null
      ? [deps.config.publicOrigin]
      : [deps.config.publicOrigin, deps.config.edgeOrigin]
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined || origin === '') return true // 原生客户端不发 Origin
    // 配置的 Hub 公网 origin（两个入口都算）永远可信
    if (trustedHubOrigins().includes(origin)) return true
    // 本机 origin 只在**请求本身来自回环**时可信；公网连接带 http://localhost 不算
    const remote = req.socket.remoteAddress ?? ''
    const fromLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!fromLoopback) return false
    try {
      const url = new URL(origin)
      return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    } catch {
      return false
    }
  }

  /**
   * ticket 通道的 Origin 判定（v2）：App 的来源（配置的 `HUB_MOBILE_ORIGINS`，默认
   * `https://localhost` / `capacitor://localhost`，开发模式还有 `http://localhost`）
   * 是**跨域 WebView**，`originAllowed` 的「本机 origin 只认回环请求」在这里不适用。
   * 另外仍然接受：不带 Origin（原生 HTTP 客户端）与 Hub 自己的公网 origin。
   */
  function appOriginAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined || origin === '') return true
    if (trustedHubOrigins().includes(origin)) return true
    return deps.config.mobileAppOrigins.includes(origin.replace(/\/+$/u, ''))
  }

  // ── 设备吊销 → 立刻关通道 ─────────────────────────────────────────────────

  /**
   * 用户在网页端吊销这台手机（或改密 / 被停用 / refresh 重放被吊销）时，
   * 已经建立的通道必须**立刻**收到 `bye` 并断开 —— 不能等 20 秒一次的会话复查，
   * 更不能出现「Hub 认为断了、手机以为还连着」的分叉（M4 §16 的阻断问题）。
   */
  /**
   * 实例状态一变就丢掉探测缓存（WP40 集成联调发现）。
   *
   * `cloudReadiness` 把「能不能连」缓存 30 秒，而 App 唤醒后轮询的上界也正好是 30 秒：
   * 缓存里存的是**上一个状态**的结论（唤醒前那次「instance-not-running」），唤醒成功后
   * 手机仍然要等缓存过期才看到 connectable=true —— 集成环境实测冷唤醒 3.4 秒、可见 30 秒。
   * 监听 `instance.status`（起停的每个阶段都会发）清掉这个用户的缓存，命中路径不变、零额外开销。
   */
  const offInstanceStatus = deps.events.on('instance.status', ({ userId, event }) => {
    cloudCache.delete(userId)
    // WP46 / M6 §1：容器停止/被休眠 → 立即关闭 NodeSession（未决交互 next 回 Host）
    const status = event.instance.status
    if (status === 'running') return
    void closeUserNodeSessions(userId, `instance-${status}`)
  })

  const offDeviceRevoked = deps.events.on('mobile.device.revoked', ({ userId, deviceId }) => {
    for (const active of [...channels.values()]) {
      if (active.userId !== userId) continue
      // Bearer 通道绑定了具体设备：只关这台手机的；cookie 通道（无 deviceId）一起关
      if (active.deviceId !== undefined && active.deviceId !== deviceId) continue
      active.channel.deliver({ v: 1, type: 'bye', code: 'session-expired', reason: '设备已被吊销，请重新登录' })
      void active.channel.dispose('device-revoked')
    }
    // WP46 / M6 §1：登出/设备吊销也是「立即关闭」的时机。只有该用户已经一条通道都不剩
    // 才真的关（别的设备还在看时关掉会把它正在等的提问一起 next 掉）。
    const remaining = channelCountOf(userId)
    if (remaining > 0) return
    setTimeout(() => {
      // dispose 是异步的（`void` 调用），等一拍再看通道表
      if (channelCountOf(userId) > 0) return
      void closeUserNodeSessions(userId, 'device-revoked')
    }, 0).unref?.()
  })

  /**
   * 管理员登出 / 被降级 / 被删除（WP56b / docs/24 §3.3）：座舱令牌由 cockpit-auth 吊销，
   * 这里负责把还挂着的座舱通道断掉并发 `bye` —— 否则 App 会停在「还以为连着」的状态等超时。
   *
   * 只关座舱节点（`cloud:ops`）；管理员自己的云实例通道不受影响（那是另一件事）。
   */
  const offCockpitLogout = deps.events.on('cockpit.admin-logout', ({ adminId }) => {
    for (const active of [...channels.values()]) {
      if (active.userId !== adminId || active.nodeId !== MOBILE_COCKPIT_NODE_ID) continue
      active.channel.deliver({ v: 1, type: 'bye', code: 'session-expired', reason: '座舱会话已结束，请重新进入管理座舱' })
      void active.channel.dispose('cockpit-logout')
    }
    void nodeSessions.closeNode(adminId, MOBILE_COCKPIT_NODE_ID, 'cockpit-logout')
  })

  return {
    listNodes,
    bootstrap,
    wake,
    issueTicket,
    attachUpgrade,
    async dispose() {
      if (disposed) return
      disposed = true
      offCockpitLogout()
      offDeviceRevoked()
      offInstanceStatus()
      // 先关会话（把未决交互 next 回 Host），再断通道：顺序反了的话通道 dispose
      // 只是 detach，adapter 会按 linger 多活一阵，Hub 却在关。
      await nodeSessions.closeAll('shutdown')
      for (const active of [...channels.values()]) await active.channel.dispose('shutdown')
      channels.clear()
      for (const relay of relays.values()) relay.close('relay-disconnected', 'Hub 正在关闭')
      relays.clear()
      idempotency.clear()
      cloudCache.clear()
    },
  }
}

function isCompleteCapabilities(capabilities: MobileNodeCapabilities): boolean {
  return (
    capabilities.sessions &&
    capabilities.history &&
    capabilities.send &&
    capabilities.stop &&
    capabilities.stream &&
    capabilities.questions &&
    capabilities.create
  )
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=').trim()
  }
  return null
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/u.exec(header.trim())
  return match?.[1] ?? null
}

function queryParam(url: string, name: string): string | null {
  const index = url.indexOf('?')
  if (index < 0) return null
  const params = new URLSearchParams(url.slice(index + 1))
  const value = params.get(name)
  return value === null || value.length === 0 ? null : value
}

function nodeIdOf(url: string): string | null {
  const path = url.split('?')[0] ?? ''
  if (!path.startsWith(`${MOBILE_NODES_PATH}/`)) return null
  const rest = path.slice(MOBILE_NODES_PATH.length + 1)
  const match = /^([^/]+)\/channel$/u.exec(rest)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}
