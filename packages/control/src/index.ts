/**
 * `@unai/control`: governed action and the data-control surface (ADR 0030).
 * Pure functions over an owner transaction the caller opened; no route, no pool.
 */
export { ControlError, type ControlTransaction } from './transaction.js';
export { PLUGIN_CAPABILITIES, pluginCapabilityOf, capabilityForAction, type PluginCapability } from './catalog.js';
export { PERMISSIONS_READ_PURPOSE, PERMISSIONS_MANAGE_PURPOSE, listPluginCapabilities,
  pluginCapabilityGranted, setPluginCapabilities,
  readRetention, updateRetention, readDomainSensitivity, updateDomainSensitivity, readSensitivityFloor,
  listDataRequests, permissionsView, type Sensitivity } from './permissions.js';
export { ACTION_READ_PURPOSE, ACTION_DRAFT_PURPOSE, ACTION_EXECUTE_PURPOSE, ACTION_RECOMMEND_PURPOSE,
  ACTION_RECEIPT_PURPOSE, ACTION_POLICY_PURPOSE, TOOL_RECEIPT_SOURCE_TYPE, appendActionHistory, listActionHistory,
  evaluateActionBasis, evaluateExternalAction, insertDraft, listDrafts, readDraft, decideDraft, insertRecommendation,
  readRecommendation, listRecommendations, respondToRecommendation, recordReceiptEntry, recordObservedAction,
  type BasisVerdict } from './actions.js';
export { DATA_DELETE_PURPOSE, DATA_EXPORT_PURPOSE, liveEvidenceExists, eraseEvidence, cascadeCounts,
  recordDataRequest, listExpiredEvidence, expireDerivedData, type ErasedEvidence } from './erasure.js';
export { buildExportBundle } from './export.js';
export { ConversationService, CONVERSATION_READ_PURPOSE, CONVERSATION_WRITE_PURPOSE } from './conversations.js';
export { MEMORY_REINDEX_PURPOSE, MEMORY_GOVERN_PURPOSE, dropSemanticIndex, regenerateSemanticIndex } from './reindex.js';
export { resolveConversationReference, conversationReferenceQuery } from './conversation-references.js';
export {readVoiceSettings,updateVoiceSettings} from './voice.js';
