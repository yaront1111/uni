/** `@unai/connectors` — the required V0 connectors and their permission model
 * (PRD §20.5, §27, §33.2).
 *
 * What a connector is allowed to be, in this system, is narrow on purpose: it
 * turns provider payloads into *evidence* and does nothing else. This package
 * therefore holds no belief-transaction import, no projection, no model call and
 * no object-store handle; ingestion and enqueueing are ports the API composition
 * supplies. The permission model is the other half: one grant row per discrete
 * manifest capability, checked by name at every operation, so granting
 * `gmail.read_metadata` never permits `gmail.read_content`.
 */
export { MANIFEST_VERSION, CONNECTOR_MANIFESTS, WRITE_CAPABILITIES, WRITE_SCOPE_PATTERNS,
  ConnectorError, manifestFor, capabilityOf, isWriteScope, requestedScopes,
  storedSensitivity, ceilingAdmits, type StoredSensitivity } from './manifests.js';
export { CONNECTOR_READ_PURPOSE, CONNECTOR_MANAGE_PURPOSE, CONNECTOR_SYNC_PURPOSE,
  createConnector, assertReadOnly, loadConnector, listGrants, grantedCapabilities, requireCapability,
  hasCapability, setCapabilityGrants, readConnector, listConnectors, markTokenRevoked, disconnectConnector,
  type ConnectorTransaction, type TokenRevoker } from './grants.js';
export { prepareForCapabilities, runConnectorSync, recordSyncFailure, type SourceIngest } from './sync.js';
export { createGmailClient, createGoogleCalendarClient, createGithubClient, createConnectorClient,
  createTokenRevoker, type ConnectorClient, type ConnectorPage, type ConnectorFetch } from './providers.js';
export { planExtraction, uploadDocument, searchDocuments,
  type ExtractionPlan, type ExtractionTriggers, type ExtractionEnqueue, type DocumentUploadOptions }
  from './documents.js';
export { buildPluginContextBundle, type PluginBundleRequest } from './bundle.js';
