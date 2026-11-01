import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AdjustRelayWalletRequestSchema,
  CreateRelayChannelRequestSchema,
  CreateRelayKeyRequestSchema,
  CreateRelayModelRequestSchema,
  ImportRelayModelsRequestSchema,
  RelayChannelListResponseSchema,
  RelayChannelResponseSchema,
  RelayDshQuerySchema,
  RelayDshResponseSchema,
  RelayKeyListResponseSchema,
  RelayKeyResponseSchema,
  RelayKeySecretResponseSchema,
  RelayLedgerListResponseSchema,
  RelayLedgerQuerySchema,
  RelayModelListResponseSchema,
  RelayModelResponseSchema,
  RelayScopeQuerySchema,
  RelayOverviewResponseSchema,
  RelaySettingsResponseSchema,
  RelayUsageLogQuerySchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsQuerySchema,
  RelayUsageStatsResponseSchema,
  RelayWalletListQuerySchema,
  RelayWalletListResponseSchema,
  RelayWalletResponseSchema,
  AddRelayChannelKeysRequestSchema,
  AddRelayChannelKeysResponseSchema,
  DiscoverRelayChannelResponseSchema,
  TestRelayChannelResponseSchema,
  UpdateRelayChannelKeyRequestSchema,
  UpdateRelayChannelRequestSchema,
  UpdateRelayDshRequestSchema,
  UpdateRelayKeyRequestSchema,
  UpdateRelayModelRequestSchema,
  UpdateRelaySettingsRequestSchema,
  UpdateRelayWalletRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireUser } from '../../app.js'
import { requestOrigin } from '../../server/public-request.js'
import type { BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { RelayService } from './types.js'

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() })
const UserIdParamsSchema = z.object({ userId: z.coerce.number().int().positive() })
const KeyParamsSchema = IdParamsSchema.extend({ keyId: z.coerce.number().int().positive() })

/**
 * 管理端中转站路由（04 §4.9、12 §9）。前缀 `/api/admin/relay`。
 * 所有写操作都要 admin；密钥明文永不进响应（新建/重置只回一次）。
 */
export function registerRelayAdminRoutes(app: FastifyInstance, deps: BaseDeps, service: RelayService): void {
  const admin = { preHandler: requireAdmin }

  app.get('/overview', admin, async () => RelayOverviewResponseSchema.parse(service.overview()))

  app.get('/settings', admin, async (req) =>
    RelaySettingsResponseSchema.parse(service.settingsResponse(requestOrigin(req, deps.config))),
  )

  // ── 下发到 DSH（12 §7.0；WP12a）────────────────────────────────────────────
  // docs/22 §3：`?platform=cloud|desktop` 缺省 cloud（云上的调用行为不变）
  app.get('/dsh', admin, async (req) => {
    const { platform } = RelayDshQuerySchema.parse(req.query ?? {})
    return RelayDshResponseSchema.parse(await service.dshResponse(platform))
  })

  app.put('/dsh', admin, async (req) => {
    const { platform } = RelayDshQuerySchema.parse(req.query ?? {})
    const input = UpdateRelayDshRequestSchema.parse(req.body)
    return RelayDshResponseSchema.parse(
      await service.updateDsh(input, req.user!.id, requestMeta(req), platform),
    )
  })

  app.patch('/settings', admin, async (req) => {
    const input = UpdateRelaySettingsRequestSchema.parse(req.body ?? {})
    const result = service.updateSettings(input, req.user!.id, requestMeta(req), requestOrigin(req, deps.config))
    return RelaySettingsResponseSchema.parse(result)
  })

  // ── 渠道 ──────────────────────────────────────────────────────────────────
  // 18 §3.1：`?scope=` 缺省 dsh（老前端行为不变）
  app.get('/channels', admin, async (req) => {
    const { scope } = RelayScopeQuerySchema.parse(req.query)
    return RelayChannelListResponseSchema.parse(service.listChannels(scope))
  })

  app.post('/channels', admin, async (req) => {
    const input = CreateRelayChannelRequestSchema.parse(req.body)
    return RelayChannelResponseSchema.parse({
      channel: service.createChannel(input, req.user!.id, requestMeta(req)),
    })
  })

  app.patch('/channels/:id', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateRelayChannelRequestSchema.parse(req.body ?? {})
    return RelayChannelResponseSchema.parse({
      channel: service.updateChannel(id, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/channels/:id', admin, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    service.deleteChannel(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.post('/channels/:id/test', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    return TestRelayChannelResponseSchema.parse(await service.testChannel(id))
  })

  app.post('/channels/:id/discover', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    return DiscoverRelayChannelResponseSchema.parse(await service.discoverChannel(id))
  })

  app.post('/channels/:id/keys', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = AddRelayChannelKeysRequestSchema.parse(req.body)
    return AddRelayChannelKeysResponseSchema.parse(
      service.addChannelKeys(id, input, req.user!.id, requestMeta(req)),
    )
  })

  app.patch('/channels/:id/keys/:keyId', admin, async (req) => {
    const { id, keyId } = KeyParamsSchema.parse(req.params)
    const input = UpdateRelayChannelKeyRequestSchema.parse(req.body ?? {})
    return RelayChannelResponseSchema.parse({
      channel: service.updateChannelKey(id, keyId, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/channels/:id/keys/:keyId', admin, async (req) => {
    const { id, keyId } = KeyParamsSchema.parse(req.params)
    return RelayChannelResponseSchema.parse({
      channel: service.deleteChannelKey(id, keyId, req.user!.id, requestMeta(req)),
    })
  })

  // ── 对外模型 ──────────────────────────────────────────────────────────────
  app.get('/models', admin, async (req) => {
    const { scope } = RelayScopeQuerySchema.parse(req.query)
    return RelayModelListResponseSchema.parse(service.listModels(scope))
  })

  app.post('/models', admin, async (req) => {
    const input = CreateRelayModelRequestSchema.parse(req.body)
    return RelayModelResponseSchema.parse({
      model: await service.createModel(input, req.user!.id, requestMeta(req)),
    })
  })

  app.post('/models/import', admin, async (req) => {
    const input = ImportRelayModelsRequestSchema.parse(req.body)
    return await service.importModels(input, req.user!.id, requestMeta(req))
  })

  app.patch('/models/:id', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateRelayModelRequestSchema.parse(req.body ?? {})
    return RelayModelResponseSchema.parse({
      model: await service.updateModel(id, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/models/:id', admin, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    service.deleteModel(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  // ── 钱包 / 流水 / 用量 ────────────────────────────────────────────────────
  app.get('/wallets', admin, async (req) => {
    const query = RelayWalletListQuerySchema.parse(req.query)
    return RelayWalletListResponseSchema.parse(service.listWallets(query))
  })

  app.get('/wallets/:userId', admin, async (req) => {
    const { userId } = UserIdParamsSchema.parse(req.params)
    return RelayWalletResponseSchema.parse({ wallet: service.getWalletRow(userId) })
  })

  app.patch('/wallets/:userId', admin, async (req) => {
    const { userId } = UserIdParamsSchema.parse(req.params)
    const input = UpdateRelayWalletRequestSchema.parse(req.body ?? {})
    return RelayWalletResponseSchema.parse({
      wallet: service.updateWallet(userId, input, req.user!.id, requestMeta(req)),
    })
  })

  app.post('/wallets/:userId/adjust', admin, async (req) => {
    const { userId } = UserIdParamsSchema.parse(req.params)
    const input = AdjustRelayWalletRequestSchema.parse(req.body)
    return RelayWalletResponseSchema.parse({
      wallet: service.adjustWallet(userId, input, req.user!.id, requestMeta(req)),
    })
  })

  app.get('/ledger', admin, async (req) => {
    const query = RelayLedgerQuerySchema.parse(req.query)
    return RelayLedgerListResponseSchema.parse(service.listLedger(query, {}))
  })

  app.get('/usage', admin, async (req) => {
    const query = RelayUsageStatsQuerySchema.parse(req.query)
    return RelayUsageStatsResponseSchema.parse(service.usageStats(query, { scope: 'admin' }))
  })

  app.get('/logs', admin, async (req) => {
    const query = RelayUsageLogQuerySchema.parse(req.query)
    return RelayUsageLogResponseSchema.parse(service.usageLogs(query, { scope: 'admin' }))
  })

  void deps
}

/**
 * 用户端路由（12 §9）。前缀 `/api/me/relay`。
 * `MUST_CHANGE_PASSWORD` 规则与其它 `/api/me` 一致（由 app.ts 的钩子统一处理：GET /api/me 放行）。
 */
export function registerRelayMeRoutes(app: FastifyInstance, deps: BaseDeps, service: RelayService): void {
  const user = { preHandler: requireUser }

  app.get('/', user, async (req) =>
    service.myRelay(
      req.user!.id,
      req.user!.role === 'admin' ? 'admin' : 'user',
      requestOrigin(req, deps.config),
    ),
  )

  app.get('/usage', user, async (req) => {
    const query = RelayUsageStatsQuerySchema.parse(req.query)
    return RelayUsageStatsResponseSchema.parse(
      service.usageStats(query, { userId: req.user!.id, scope: 'user' }),
    )
  })

  app.get('/logs', user, async (req) => {
    const query = RelayUsageLogQuerySchema.parse(req.query)
    return RelayUsageLogResponseSchema.parse(
      service.usageLogs(query, { userId: req.user!.id, scope: 'user' }),
    )
  })

  app.get('/ledger', user, async (req) => {
    const query = RelayLedgerQuerySchema.parse(req.query)
    return RelayLedgerListResponseSchema.parse(service.listLedger(query, { userId: req.user!.id }))
  })

  app.get('/keys', user, async (req) => RelayKeyListResponseSchema.parse(service.listKeys(req.user!.id)))

  app.post('/keys', user, async (req) => {
    const input = CreateRelayKeyRequestSchema.parse(req.body)
    return RelayKeySecretResponseSchema.parse(
      service.createKey(req.user!.id, input, req.user!.id, requestMeta(req)),
    )
  })

  app.patch('/keys/:id', user, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateRelayKeyRequestSchema.parse(req.body ?? {})
    return RelayKeyResponseSchema.parse({
      key: service.updateKey(req.user!.id, id, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/keys/:id', user, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    service.deleteKey(req.user!.id, id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.post('/keys/:id/rotate', user, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const keys = service.listKeys(req.user!.id)
    const target = keys.find((key) => key.id === id)
    if (!target) throw new HubError('NOT_FOUND', '密钥不存在')
    if (target.kind !== 'system') {
      throw new HubError('VALIDATION_FAILED', '只有 DSH 内置密钥可以重置', { fields: { id: '不是 system' } })
    }
    return RelayKeySecretResponseSchema.parse(
      service.rotateSystemKey(req.user!.id, req.user!.id, requestMeta(req)),
    )
  })

  void deps
}
