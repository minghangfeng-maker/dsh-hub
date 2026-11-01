/**
 * 手机通道 v2 契约 —— **全部来自 `@dsh-hub/shared`**（vendored tarball）。
 *
 * 来源：Hub `integ/WP40` 的 `packages/shared/src/api/mobile-v2.ts`（WP40c-2）。
 * App 不维护任何一份自己的 v2 zod：A1 的本地临时实现已在 A2 删除。
 *
 * 本文件只做两件事：
 * 1. 把 shared 里带 `MobileServer*` / `MobileClient*` 前缀的长名字，对齐成 App 内部
 *    从 A1 起沿用的短名字（`MobileHelloV2Schema` 等），避免全仓改 import；
 * 2. 声明 App 实际协商的 v2 特性集合（`APP_DECLARED_FEATURES`）。
 *
 * 纪律：字段名、错误码、限额一律以 shared 为准，本文件**不新增/不改写**任何 schema。
 */

import type { z } from 'zod'
import {
  MobileErrorCodeV2ExtraSchema,
  MOBILE_V2_FEATURES as SHARED_V2_FEATURES,
} from '@dsh-hub/shared'
import type { MobileV2Feature } from '@dsh-hub/shared'

// ── 特性协商与能力位 ────────────────────────────────────────────────────────

export {
  MOBILE_V2_FEATURES,
  MobileV2FeatureSchema,
  MobileNodeCapabilitiesV2Schema,
  MobileNodeCapabilitiesFullSchema,
  type MobileV2Feature,
  type MobileNodeCapabilitiesV2,
  type MobileNodeCapabilitiesFull,
} from '@dsh-hub/shared'

/**
 * App 实际处理得了的 v2 特性 = shared 的全部 8 项。
 *
 * A1 只声明了 `models` + `archive`（避免 Hub 推来还没渲染的帧）。A2 已实现工具卡、
 * 思考过程、文件下载、交付物、附件上传、重命名与归档，所以全量声明；
 * Hub 仍会用「双方都支持」求交集并回显实际启用集合，客户端只认回显。
 */
export const APP_DECLARED_FEATURES: MobileV2Feature[] = [...SHARED_V2_FEATURES]

// ── 会话 / 模型 / 思考程度 ──────────────────────────────────────────────────

export {
  MobileSessionRowV2Schema,
  type MobileSessionRowV2,
  MobileModelSelectionSchema,
  type MobileModelSelection,
  MobileModelEffortSchema,
  type MobileModelEffort,
  MobileModelSchema,
  type MobileModel,
  MobileServerModelChangedFrameSchema as MobileModelChangedFrameSchema,
  type MobileServerModelChangedFrame as MobileModelChangedFrame,
  MobileOutgoingAttachmentSchema,
  type MobileOutgoingAttachment,
  MOBILE_EFFORT_TIERS,
  MOBILE_EFFORT_TIER_LABELS,
  MOBILE_DSH_EFFORT_BY_TIER,
  MOBILE_DEFAULT_EFFORT_TIER,
  type MobileEffortTier,
} from '@dsh-hub/shared'

/** shared 的 `MobileServerHelloV2Schema`（v1 hello + features + capabilitiesV2）。 */
export {
  MobileServerHelloV2Schema as MobileHelloV2Schema,
  type MobileServerHelloV2 as MobileHelloV2,
  MobileServerSessionsV2Schema as MobileSessionsV2FrameSchema,
  type MobileServerSessionsV2 as MobileSessionsV2Frame,
  MobileServerModelsFrameSchema as MobileModelsFrameSchema,
  type MobileServerModelsFrame as MobileModelsFrame,
  MobileServerCreatedV2Schema as MobileCreatedV2FrameSchema,
  type MobileServerCreatedV2 as MobileCreatedV2Frame,
  MobileServerDeltaV2Schema as MobileDeltaV2Schema,
  type MobileServerDeltaV2 as MobileDeltaV2,
  MobileServerHistoryV2Schema as MobileHistoryV2FrameSchema,
  type MobileServerHistoryV2 as MobileHistoryV2Frame,
} from '@dsh-hub/shared'

// ── 工具 / 交付物 / 文件 / 上传 ─────────────────────────────────────────────

export {
  MobileFileRefSchema,
  type MobileFileRef,
  MobileToolFrameSchema,
  type MobileToolFrame,
  MobileDeliverableFrameSchema,
  type MobileDeliverableFrame,
  MobileServerRenamedFrameSchema as MobileRenamedFrameSchema,
  type MobileServerRenamedFrame as MobileRenamedFrame,
  MobileServerArchivedFrameSchema as MobileArchivedFrameSchema,
  type MobileServerArchivedFrame as MobileArchivedFrame,
  MobileSessionUsageStatsSchema,
  type MobileSessionUsageStats,
  MobileServerUsageFrameSchema as MobileUsageFrameSchema,
  type MobileServerUsageFrame as MobileUsageFrame,
  MobileServerFileFrameSchema,
  type MobileServerFileFrame,
  MobileServerFileChunkFrameSchema,
  type MobileServerFileChunkFrame,
  MobileServerFileListFrameSchema,
  type MobileServerFileListFrame,
  MobileServerUploadStartedFrameSchema,
  type MobileServerUploadStartedFrame,
  MobileServerUploadReceivedFrameSchema,
  type MobileServerUploadReceivedFrame,
  MobileServerUploadedFrameSchema,
  type MobileServerUploadedFrame,
  MobileServerFrameAllSchema,
  type MobileServerFrameAll,
  MobileClientFrameAllSchema,
  type MobileClientFrameAll,
  MobileErrorCodeV2ExtraSchema,
  type MobileErrorCodeV2Extra,
  MOBILE_V2_FILE_CHUNK_RAW_BYTES,
  MOBILE_V2_FILE_INLINE_RAW_BYTES,
  MOBILE_V2_FILE_MAX_BYTES,
  MOBILE_V2_IMAGE_MAX_BYTES,
  MOBILE_V2_UPLOAD_MAX_BYTES,
  MOBILE_V2_DESKTOP_UPLOAD_MAX_BYTES,
  MOBILE_V2_UPLOAD_TTL_MS,
} from '@dsh-hub/shared'

/** 文件类帧的短名字（A1 起沿用）。 */
export {
  MobileServerFileFrameSchema as MobileFileFrameSchema,
  type MobileServerFileFrame as MobileFileFrame,
  MobileServerFileChunkFrameSchema as MobileFileChunkFrameSchema,
  type MobileServerFileChunkFrame as MobileFileChunkFrame,
  MobileServerFileListFrameSchema as MobileFileListFrameSchema,
  type MobileServerFileListFrame as MobileFileListFrame,
} from '@dsh-hub/shared'

/** A1 起沿用的短名字（现为 shared 的 v1+v2 全量判别联合）。 */
export type MobileServerFrameV2 = import('@dsh-hub/shared').MobileServerFrameAll
export type MobileClientFrameV2 = import('@dsh-hub/shared').MobileClientFrameAll

// ── 客户端帧（分类型 re-export，便于 wire.ts 按需引用）──────────────────────

export {
  MobileClientHelloV2Schema,
  type MobileClientHelloV2,
  MobileClientModelsFrameSchema,
  MobileClientSetModelFrameSchema,
  MobileClientRenameFrameSchema,
  MobileClientArchiveFrameSchema,
  MobileClientUploadBeginFrameSchema,
  MobileClientUploadChunkFrameSchema,
  MobileClientUploadAbortFrameSchema,
  MobileClientFileReadFrameSchema,
  MobileClientFileListFrameSchema,
  MobileClientCreateV2Schema as MobileClientCreateV2FrameSchema,
  MobileClientSessionsV2Schema as MobileClientSessionsV2FrameSchema,
  MobileClientSendV2Schema as MobileClientSendV2FrameSchema,
} from '@dsh-hub/shared'

// ── 错误码增量（中文文案在 core/errors.ts）──────────────────────────────────

/** v2 错误码列表（运行时值来自 shared 的 zod enum，顺序即声明顺序）。 */
export const MOBILE_V2_ERROR_CODES = MobileErrorCodeV2ExtraSchema.options
export type MobileV2ErrorCode = z.infer<typeof MobileErrorCodeV2ExtraSchema>
