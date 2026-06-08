/**
 * localDb.js — Re-export layer for backward compatibility.
 *
 * All 27+ consumer files import from "@/lib/localDb".
 * This thin layer re-exports everything from the domain-specific DB modules,
 * so zero consumer changes are needed.
 */

export {
  // Provider Connections
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
  deleteProviderConnections,
  deleteProviderConnectionsByProvider,
  reorderProviderConnections,
  cleanupProviderConnections,

  // Provider Nodes
  getProviderNodes,
  getProviderNodeById,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,

  // T05: Rate-limit DB persistence (survives token refresh)
  setConnectionRateLimitUntil,
  isConnectionRateLimited,
  getRateLimitedConnections,

  // T13: Stale quota display fix (zero out usage after window resets)
  getEffectiveQuotaUsage,
  formatResetCountdown,
} from "./db/providers";

export {
  // Model Aliases
  getModelAliases,
  setModelAlias,
  deleteModelAlias,

  // MITM Alias
  getMitmAlias,
  setMitmAliasAll,

  // Custom Models
  getCustomModels,
  getAllCustomModels,
  addCustomModel,
  replaceCustomModels,
  removeCustomModel,
  updateCustomModel,
  getModelCompatOverrides,
  mergeModelCompatOverride,
  removeModelCompatOverride,
  getModelNormalizeToolCallId,
  getModelPreserveOpenAIDeveloperRole,
  getModelUpstreamExtraHeaders,
  getModelIsHidden,
  buildModelHiddenChecker,

  // Synced Available Models
  getSyncedAvailableModels,
  getAllSyncedAvailableModels,
  replaceSyncedAvailableModelsForConnection,
  deleteSyncedAvailableModelsForConnection,
  deleteSyncedAvailableModelsForProvider,
} from "./db/models";

export type { ModelCompatPerProtocol, ModelCompatPatch, SyncedAvailableModel } from "./db/models";

export {
  // Combos
  getCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  reorderCombos,
  deleteCombo,
} from "./db/combos";

export * from "./db/compressionCacheStats";
export * from "./db/compressionCombos";

export {
  // API Keys
  getApiKeys,
  getApiKeyById,
  createApiKey,
  deleteApiKey,
  validateApiKey,
  getApiKeyMetadata,
  updateApiKeyPermissions,
  regenerateApiKey,
  isModelAllowedForKey,
  clearApiKeyCaches,
  resetApiKeyState,
} from "./db/apiKeys";

export {
  // Evals
  saveEvalRun,
  listEvalRuns,
  getEvalScorecard,
  listCustomEvalSuites,
  getCustomEvalSuite,
  saveCustomEvalSuite,
  deleteCustomEvalSuite,
  serializeEvalTargetKey,
} from "./db/evals";

export type {
  EvalCaseRecord,
  EvalSuiteRecord,
  EvalTargetType,
  EvalTargetDescriptor,
  EvalRunSummary,
  PersistedEvalRun,
} from "./db/evals";

export {
  // Settings
  getSettings,
  updateSettings,
  isCloudEnabled,

  // LKGP (Last Known Good Provider) (#919)
  getLKGP,
  setLKGP,

  // Pricing
  getPricing,
  getPricingWithSources,
  getPricingForModel,
  updatePricing,
  resetPricing,
  resetAllPricing,

  // Proxy Config
  getProxyConfig,
  getProxyForLevel,
  setProxyForLevel,
  deleteProxyForLevel,
  resolveProxyForConnection,
  setProxyConfig,
} from "./db/settings";

export type { PricingSource, PricingSourceMap } from "./db/settings";

export {
  getDatabaseSettings,
  getUserDatabaseSettings,
  updateDatabaseSettings,
} from "./db/databaseSettings";

export type { UserDatabaseSettings } from "./db/databaseSettings";

export {
  // Backup Management
  backupDbFile,
  cleanupDbBackups,
  getDbBackupMaxFiles,
  getDbBackupRetentionDays,
  listDbBackups,
  restoreDbBackup,
} from "./db/backup";

export {
  // Read Cache (cached wrappers for hot-read paths)
  getCachedSettings,
  getCachedPricing,
  getCachedProviderConnections,
  getCachedLKGP,
  setCachedLKGP,
  invalidateDbCache,
} from "./db/readCache";

export {
  // Registered Keys Provisioning (#464)
  issueRegisteredKey,
  getRegisteredKey,
  listRegisteredKeys,
  revokeRegisteredKey,
  validateRegisteredKey,
  incrementRegisteredKeyUsage,
  checkQuota,
  setProviderKeyLimit,
  setAccountKeyLimit,
  getProviderKeyLimit,
  getAccountKeyLimit,
} from "./db/registeredKeys";

export type {
  RegisteredKey,
  RegisteredKeyWithSecret,
  ProviderKeyLimit,
  AccountKeyLimit,
  QuotaCheckResult,
  IssueKeyParams,
} from "./db/registeredKeys";

export {
  // Model-Combo Mappings (#563)
  getModelComboMappings,
  getModelComboMappingById,
  createModelComboMapping,
  updateModelComboMapping,
  deleteModelComboMapping,
  resolveComboForModel,
} from "./db/modelComboMappings";

export {
  // Files
  createFile,
  getFile,
  getFileContent,
  listFiles,
  countFiles,
  formatFileResponse,
  deleteFile,
} from "./db/files";

export type { FileRecord } from "./db/files";

export type { ModelComboMapping } from "./db/modelComboMappings";

// Webhook subsystem removed — see Wave 1 cleanup
export * from "./db/sessionAccountAffinity";

// versionManager subsystem removed — dead CLI-tool state management

export {
  listSyncTokens,
  getSyncTokenById,
  getSyncTokenByHash,
  createSyncTokenRecord,
  revokeSyncToken,
  touchSyncTokenLastUsed,
} from "./db/syncTokens";

export {
  getProviderLimitsCache,
  getAllProviderLimitsCache,
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  deleteProviderLimitsCache,
} from "./db/providerLimits";

export type { ProviderLimitsCacheEntry } from "./db/providerLimits";

export {
  getPersistedCreditBalance,
  getAllPersistedCreditBalances,
  persistCreditBalance,
} from "./db/creditBalance";

export {
  insertCompressionAnalyticsRow,
  getCompressionAnalyticsSummary,
} from "./db/compressionAnalytics";

export type {
  CompressionAnalyticsRow,
  CompressionAnalyticsSummary,
} from "./db/compressionAnalytics";

export {
  // Reasoning Replay Cache (#1628)
  setReasoningCache,
  getReasoningCache,
  deleteReasoningCache,
  clearAllReasoningCache,
} from "./db/reasoningCache";

export type { ReasoningCacheEntry, ReasoningCacheStats } from "./db/reasoningCache";


export {
  getSessionAccountAffinity,
  upsertSessionAccountAffinity,
  touchSessionAccountAffinity,
  deleteSessionAccountAffinity,
  cleanupStaleSessionAccountAffinities,
  startSessionAccountAffinityCleanup,
  stopSessionAccountAffinityCleanupForTests,
} from "./db/sessionAccountAffinity";


export * from "./db/featureFlags";

export {
  upsertHandoff,
  getHandoff,
  deleteHandoff,
  cleanupExpiredHandoffs,
  hasActiveHandoff,
  recordSessionModelUsage,
  getLastSessionModel,
} from "./db/contextHandoffs";

export type { HandoffPayload } from "./db/contextHandoffs";

export {
  getAllMiddlewareHooks,
  getEnabledMiddlewareHooks,
  getComboMiddlewareHooks,
  getMiddlewareHook,
  createMiddlewareHook,
  updateMiddlewareHook,
  deleteMiddlewareHook,
  recordHookExecution,
  insertHookLog,
  getHookLogs,
  cleanupHookLogs,
} from "./db/middleware";

export {
  getAllKeyGroups,
  getKeyGroup,
  getKeyGroupWithPermissions,
  createKeyGroup,
  updateKeyGroup,
  deleteKeyGroup,
  getGroupPermissions,
  addGroupPermission,
  removeGroupPermission,
  clearGroupPermissions,
  getGroupMembers,
  getKeyGroupsForApiKey,
  addKeyToGroup,
  removeKeyFromGroup,
  checkKeyModelAccess,
} from "./db/apiKeyGroups";

export {
  createRelayToken,
  getRelayTokens,
  getRelayToken,
  getRelayTokenByHash,
  updateRelayToken,
  deleteRelayToken,
  toggleRelayToken,
  checkRateLimit,
  recordRelayUsage,
  getRelayUsage,
  getRelayLogs,
} from "./db/relayProxies";

export type {
  RelayToken,
  RelayTokenRow,
  RelayLogRow,
  CreateRelayTokenInput,
  RelayTokenWithSecret,
} from "./db/relayProxies";


export {
  // Per-API-Key Token Limits (migration 073)
  upsertTokenLimit,
  listTokenLimits,
  getTokenLimitsForRequest,
  deleteTokenLimit,
  getWindowUsage,
  incrementWindowTokens,
  resetWindowIfElapsed,
  logTokenLimitReset,
} from "./db/tokenLimits";

export type {
  TokenLimit,
  TokenLimitScopeType,
  UpsertTokenLimitInput,
  TokenWindowState,
} from "./db/tokenLimits";

// ── Proxy subsystem removed (GigaChat fork) ──────────────────────────────────
// The proxy/1proxy/upstream-proxy registry was deleted. These stubs preserve the
// call signatures of the old DB helpers so the many upstream-fetch call sites
// keep compiling; with no proxy configured they all resolve to a direct
// connection (null). Outbound proxying, if needed, is handled by HTTPS_PROXY env
// in open-sse/utils/proxyFetch.
export async function resolveProxyForProvider(_provider?: string): Promise<null> {
  return null;
}
export async function getUpstreamProxyConfig(
  _providerId?: string
): Promise<Record<string, unknown> | null> {
  return null;
}
export async function getUpstreamProxyConfigs(): Promise<Record<string, unknown>[]> {
  return [];
}
export async function upsertUpstreamProxyConfig(_cfg?: unknown): Promise<void> {
  /* no-op: upstream-proxy registry removed */
}
export function validateProxyUrl(_url?: string): { valid: boolean; error?: string } {
  return { valid: true };
}
