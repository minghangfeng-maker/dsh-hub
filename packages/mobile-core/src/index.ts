// ── 契约与错误 ──────────────────────────────────────────────────────────────
// v1 帧 / 节点列表来自 Hub 的 vendored 包；认证与 bootstrap 是本地临时 zod（TODO WP40a）。
export * from './contracts/auth-bootstrap.js'
export * from './contracts/mobile-v2.js'
export type {
  MobileSessionRow,
  MobileNodeCapabilities,
  MobileNode,
  MobileNodeKind,
  MobileNodeBlockedReason,
  MobileQuestionAnswer,
} from '@dsh-hub/shared'
export {
  MOBILE_PROTOCOL_VERSION,
  MobileClientFrameSchema,
  MobileServerFrameSchema,
  hello,
  sessions,
  history,
  create,
  send,
  stop,
  subscribe,
  unsubscribe,
  answerQuestion,
  answerApproval,
  ping,
  encodeClientFrame,
  decodeClientFrame,
  parseServerFrame,
  frameSessionId,
  frameCursor,
  type ClientIdentity,
  type ParsedServerFrame,
} from './channel/wire.js'
export {
  errorMessage,
  FALLBACK_MESSAGE,
  isAuthLostCode,
  isRetryableCode,
  isMobileErrorCode,
  normalizeCode,
  codeFromHttpStatus,
  blockedReasonText,
  HubApiError,
  type HubErrorCode,
  type AuthErrorCode,
  type ClientErrorCode,
  type BootstrapErrorCode,
} from './errors.js'

// ── 地址与账号隔离 ──────────────────────────────────────────────────────────
export {
  MOCK_HUB_ORIGIN,
  normalizeHubOrigin,
  normalizeHubOrigins,
  parseHubOrigins,
  parseHubOriginLabels,
  injectedHubOrigins,
  resolveHubOrigins,
  resolveHubOrigin,
  resolveWebHubOrigins,
  type HubOriginSources,
  webPageOf,
  isMockOrigin,
  wsOriginOf,
  accountKeyOf,
} from './config.js'
export {
  OriginManager,
  ORIGIN_PROBE_PATH,
  ORIGIN_PROBE_TIMEOUT_MS,
  ORIGIN_FAILOVER_COOLDOWN_MS,
  looksLikeInterceptPage,
  type FailoverReason,
  type OriginSwitch,
  type OriginSwitchReason,
  type OriginProbe,
  type OriginManagerOptions,
} from './http/origin-manager.js'

// ── 令牌与网关 ──────────────────────────────────────────────────────────────
export {
  MemoryTokenStore,
  SecureTokenStore,
  SessionStorageTokenStore,
  describeTokens,
  isAccessExpired,
  isRefreshExpired,
  type TokenStore,
  type SecureStringStore,
  type StringStorage,
} from './auth/token-store.js'
export {
  HubClient,
  TTS_TIMEOUT_MS,
  TTS_STREAM_START_TIMEOUT_MS,
  TTS_STREAM_IDLE_TIMEOUT_MS,
  type HubClientOptions,
  type FetchLike,
} from './http/hub-client.js'
export { alignPcm16, concatBytes, PCM16_BYTES } from './http/pcm.js'
export {
  exchangeCockpitHandoff,
  COCKPIT_EXCHANGE_TIMEOUT_MS,
  COCKPIT_HANDOFF_INVALID,
  type CockpitExchangeOptions,
  type CockpitFetchLike,
} from './http/cockpit.js'

// ── 管理座舱（WP56d / docs/24 §6）───────────────────────────────────────────
export {
  COCKPIT_NODE_ID,
  COCKPIT_EMBED_PARAM,
  COCKPIT_EMBED_VALUE,
  COCKPIT_CODE_HASH_KEY,
  COCKPIT_TOKEN_STORAGE_KEY,
  CockpitHandoffExchangeRequestSchema,
  CockpitExchangeResponseSchema,
  OPS_CALL_TOOL_NAME,
  COCKPIT_INITIATOR_KEYS,
  cockpitInitiatorText,
  withCockpitSessionInitiators,
  opsCallProposalOf,
  isCanvasToolName,
  canvasActionOf,
  cockpitProcessActions,
  cockpitActionText,
  placementText,
  maskSecretsInText,
  type CockpitPlacement,
  type CockpitProcessAction,
  type CockpitHandoffExchangeRequest,
  type CockpitExchangeResponse,
  type CockpitSession,
  type OpsCallProposal,
} from './cockpit/embed.js'
export {
  resolveDownloadMirrors,
  type DownloadSourceInfo,
} from './http/download-mirrors.js'
export type { HubGateway } from './gateway.js'
export { createHubGateway } from './factory.js'

// ── 通道 ────────────────────────────────────────────────────────────────────
export {
  WsChannelLink,
  MAX_FRAME_BYTES,
  frameByteLength,
  type ChannelLink,
  type ChannelLinkEvent,
  type ChannelLinkState,
  type WebSocketLike,
  type WsChannelLinkOptions,
} from './channel/link.js'
export {
  WorkspaceController,
  type WorkspaceState,
  type WorkspaceControllerOptions,
  type WorkspaceOutboxOptions,
  type OutboxEntryView,
  type OutboxAttachmentState,
  type ChatEntry,
  type QuestionPrompt,
  type ApprovalRequest,
  type UiError,
  type LinkState,
  type ActionOutcome,
  type DownloadedFile,
} from './channel/workspace.js'
export {
  toolSummary,
  mergeThread,
  collectFiles,
  toolCardFromFrame,
  deliverableFromFrame,
  type ToolCard,
  type DeliverableItem,
  type ThreadItem,
} from './channel/tools.js'
export {
  FileCache,
  FileAssembler,
  FileSequenceError,
  FileDownloadError,
  DEFINITIVE_FILE_ERROR_CODES,
  fileErrorCodeOf,
  fileErrorRetryable,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  formatBytes,
  safeFileName,
  inlineKindOf,
  imagesOf,
  type CachedFile,
  type AssembledFile,
} from './channel/files.js'
export {
  createUploadTask,
  nextUploadChunk,
  uploadView,
  toOutgoingAttachment,
  limitForBackend,
  DEFAULT_UPLOAD_CHUNK_RAW,
  type UploadInput,
  type UploadTask,
  type UploadTaskView,
  type UploadState,
} from './channel/upload.js'
export {
  fileRead,
  fileList,
  uploadBegin,
  uploadChunk,
  uploadAbort,
  rename,
  archive,
  models as modelsFrame,
  setModel,
} from './channel/wire.js'

// ── 缓存与选择 ──────────────────────────────────────────────────────────────
export {
  MemorySessionCache,
  IndexedDbSessionCache,
  type SessionCache,
  type CachedSessionList,
  type CachedConversation,
} from './cache/session-cache.js'
// 产出文件持久缓存（IndexedDB，跨重启）：手机端交付物/正文图片「下载一次、重开秒开」。
export {
  MemoryFileStore,
  IndexedDbFileStore,
  createFileStore,
  fileCacheKeyOf,
  pathOfCacheKey,
  fileNameOfKey,
  DEFAULT_FILE_CACHE_MAX_BYTES,
  type FileStore,
  type StoredFile,
  type StoredFileEntry,
  type StoredFileMediaType,
  type CreateFileStoreOptions,
} from './cache/file-store.js'
// 发送队列持久化（IndexedDB，跨重启）：唤醒/断线期间打的字不会再因为杀 App 丢掉。
export {
  MemoryOutboxStore,
  IndexedDbOutboxStore,
  createOutboxStore,
  type OutboxStore,
  type OutboxRecord,
  type CreateOutboxStoreOptions,
} from './cache/outbox-store.js'
export {
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  indexedDbAvailable,
  openCacheDb,
  registerAccountCachePurger,
  purgeAccountCaches,
  type AccountCachePurger,
} from './cache/db.js'
export {
  SelectionStore,
  MemoryKeyValueStore,
  type KeyValueStore,
  type BackendSelection,
} from './prefs/selection-store.js'

// ── 模型与思考程度（mock 数据驱动，TODO WP40c-1） ───────────────────────────
export {
  EFFORT_LEVELS,
  resolveModelCatalog,
  flattenModelCatalog,
  catalogFromServer,
  dshEffortIdOfTier,
  tierOfDshEffort,
  supportsThinking,
  tierAvailable,
  availableTiers,
  defaultTierOf,
  findModel,
  modelKey,
  parseModelKey,
  selectionFromServer,
  normalizeSelection,
  effortIdForSelection,
  toStoredSelection,
  chipLabel,
  effortLabel,
  type EffortLevel,
  type EffortTierId,
  type CatalogEffort,
  type CatalogModel,
  type BackendModelCatalog,
  type ModelSelection,
} from './models/catalog.js'

// ── mock ────────────────────────────────────────────────────────────────────
export {
  MockHub,
  MOCK_TTS_CAPABILITY,
  MOCK_TTS_VOICES,
  type MockHubOptions,
} from './mock/mock-hub.js'
export { MOCK_REPLY, MOCK_HISTORY, MOCK_TICK_MS } from './mock/content.js'
/** mock 的朗读音频（24kHz WAV）：e2e / 截图脚本也会用它生成「像样」的音频。 */
export { encodeTtsWav, ttsDurationMs, type MockTtsWavOptions } from './mock/tts-wav.js'

// ── Markdown 分块（流式渲染器用：只重解析未闭合的尾块）─────────────────────
export {
  splitMarkdownBlocks,
  stableBlockCount,
  diffBlocks,
  type MarkdownBlock,
  type BlockKind,
  type BlockDiff,
} from './markdown/blocks.js'
