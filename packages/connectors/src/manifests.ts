import { connectorManifestSchema, type ConnectorManifest, type ConnectorType, type ManifestCapability }
  from '@unai/domain';

/**
 * The V0 connector manifests (PRD §27.1, §27.2, §27.5).
 *
 * Every required connector ships a manifest listing discrete capabilities, each
 * with its own risk classification, its own provider scopes and its own
 * least-context profile. Three properties of this file are the permission model:
 *
 *  1. Capabilities are discrete. `gmail.read_metadata` and `gmail.read_content`
 *     are separate entries with separate scopes, so a grant of one is not a grant
 *     of the other anywhere in the system (CRT-CON-07-A).
 *  2. Every scope of every capability a V0 connector may be granted is a
 *     read-only provider scope. `WRITE_CAPABILITIES` names the write capabilities
 *     that exist in the vocabulary so a request for one can be refused *by name*
 *     rather than ignored (CRT-CON-02-A, CRT-CON-03-A, CRT-CON-04-A).
 *  3. Each capability declares the smallest context its operations need, which
 *     is what makes the least-context rule checkable rather than aspirational
 *     (PRD §27.3, CRT-SEC-03-A).
 */

export const MANIFEST_VERSION = '0.1.0';

/** The Gmail scope that reads headers only, and the one that reads message
 * bodies. Both are read-only: Gmail has no "write" in this list at all. */
const GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** Provider scopes V0 may never request. A capability naming one of these is
 * refused before any consent handoff happens. Read-only GitHub uses fine-grained
 * `<resource>:read` scopes, so the classic all-powerful `repo` scope and every
 * `:write`, `write:` or `admin:` form is a write scope here. */
export const WRITE_SCOPE_PATTERNS: readonly RegExp[] = Object.freeze([
  /gmail\.(send|compose|modify|insert|settings)/, /auth\/gmail$/,
  /calendar\.(events|acls|settings)(?!\.readonly)/, /auth\/calendar$/,
  /^repo$/, /(^|[.:])write([:.]|$)/, /^admin:/, /delete_repo/, /\.write$/,
]);

/**
 * The write capabilities the permission vocabulary knows (PRD §27.1).
 *
 * They are named here and offered by no manifest: the consent screen can say
 * "this is a write scope and V0 refuses it" instead of pretending the capability
 * does not exist. `gmail.create_draft` is in the list because draft creation is
 * the single external write V0 contemplates, and it is governed by
 * `EvaluateMemoryAction` rather than by a connector grant (PRD §27.5); the
 * drafts slice owns that path.
 */
export const WRITE_CAPABILITIES: readonly string[] = Object.freeze([
  'gmail.send', 'gmail.create_draft', 'calendar.create', 'calendar.update',
  'github.write_pull_requests', 'github.write_issues', 'documents.write',
]);

const WORK_PROFILE = {
  purpose: 'WORK_ASSISTANCE',
  lifeCategory: 'WORK' as const,
  // The least-context rule, stated as data: a work-email operation never
  // receives health, family or financial objects, whatever else the assistant
  // can see (PRD §27.3, CRT-SEC-03-A).
  excludedLifeCategories: ['HEALTH', 'FAMILY', 'FINANCE'] as const,
  maximumSensitivity: 'NORMAL' as const,
  tokenBudget: 4000,
};
const SCHEDULE_PROFILE = {
  purpose: 'PERSONAL_ASSISTANCE',
  lifeCategory: null,
  excludedLifeCategories: ['HEALTH', 'FINANCE'] as const,
  maximumSensitivity: 'NORMAL' as const,
  tokenBudget: 4000,
};
const PROJECT_PROFILE = {
  purpose: 'PROJECT_TRACKING',
  lifeCategory: 'WORK' as const,
  excludedLifeCategories: ['HEALTH', 'FAMILY', 'FINANCE'] as const,
  maximumSensitivity: 'NORMAL' as const,
  tokenBudget: 4000,
};
const ASSISTANT_PROFILE = {
  purpose: 'PERSONAL_ASSISTANCE',
  lifeCategory: null,
  excludedLifeCategories: ['HEALTH'] as const,
  maximumSensitivity: 'PRIVATE' as const,
  tokenBudget: 5000,
};

function capability(input: {
  capabilityId: string; description: string; riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  scopes?: readonly string[]; profile: typeof WORK_PROFILE | typeof SCHEDULE_PROFILE
  | typeof PROJECT_PROFILE | typeof ASSISTANT_PROFILE;
}): ManifestCapability {
  return {
    capabilityId: input.capabilityId, description: input.description,
    access: 'READ', riskClass: input.riskClass, scopes: [...(input.scopes ?? [])],
    contextProfile: {
      purpose: input.profile.purpose, lifeCategory: input.profile.lifeCategory,
      excludedLifeCategories: [...input.profile.excludedLifeCategories],
      maximumSensitivity: input.profile.maximumSensitivity, tokenBudget: input.profile.tokenBudget,
    },
  };
}

const MANIFEST_LIST: readonly ConnectorManifest[] = Object.freeze([
  connectorManifestSchema.parse({
    id: 'connector.conversation', connectorType: 'CONVERSATION', version: MANIFEST_VERSION,
    displayName: 'Uai conversation', sources: ['CONVERSATION'], emits: ['SOURCE_ITEM'],
    sensitivity: { default: 'PRIVATE' }, retention: { raw: 'USER_CONFIGURABLE' },
    requiredSecrets: [], promptInjectionRisk: 'MEDIUM',
    minimumSyncCapability: 'conversation.read_user_messages',
    capabilities: [
      capability({ capabilityId: 'conversation.read_user_messages', riskClass: 'LOW', profile: ASSISTANT_PROFILE,
        description: 'Store each message you send to Uai as evidence with its message id.' }),
      capability({ capabilityId: 'conversation.read_assistant_messages', riskClass: 'LOW', profile: ASSISTANT_PROFILE,
        description: "Store each of Uai's own replies as evidence, never as an accepted belief." }),
    ],
  }),
  connectorManifestSchema.parse({
    id: 'connector.gmail', connectorType: 'GMAIL', version: MANIFEST_VERSION,
    displayName: 'Gmail (read-only)', sources: ['EMAIL_THREAD'], emits: ['SOURCE_ITEM'],
    sensitivity: { default: 'PRIVATE' }, retention: { raw: 'USER_CONFIGURABLE' },
    requiredSecrets: ['oauth_refresh_token'], promptInjectionRisk: 'HIGH',
    minimumSyncCapability: 'gmail.read_metadata',
    capabilities: [
      capability({ capabilityId: 'gmail.read_metadata', riskClass: 'LOW', scopes: [GMAIL_METADATA_SCOPE],
        profile: WORK_PROFILE,
        description: 'Read message headers, participants, labels and thread structure. No message body.' }),
      capability({ capabilityId: 'gmail.read_content', riskClass: 'MEDIUM', scopes: [GMAIL_READONLY_SCOPE],
        profile: WORK_PROFILE,
        description: 'Read the body text of the messages in your threads.' }),
      capability({ capabilityId: 'gmail.search', riskClass: 'LOW', scopes: [GMAIL_READONLY_SCOPE],
        profile: WORK_PROFILE,
        description: 'Run read-only Gmail searches to find the threads to ingest.' }),
    ],
  }),
  connectorManifestSchema.parse({
    id: 'connector.google_calendar', connectorType: 'GOOGLE_CALENDAR', version: MANIFEST_VERSION,
    displayName: 'Google Calendar (read-only)', sources: ['CALENDAR_EVENT'], emits: ['SOURCE_ITEM'],
    sensitivity: { default: 'PRIVATE' }, retention: { raw: 'USER_CONFIGURABLE' },
    requiredSecrets: ['oauth_refresh_token'], promptInjectionRisk: 'MEDIUM',
    minimumSyncCapability: 'calendar.read',
    capabilities: [
      capability({ capabilityId: 'calendar.read', riskClass: 'LOW', scopes: [CALENDAR_READONLY_SCOPE],
        profile: SCHEDULE_PROFILE,
        description: 'Read events with their start, end and recurrence fields.' }),
    ],
  }),
  connectorManifestSchema.parse({
    id: 'connector.github', connectorType: 'GITHUB', version: MANIFEST_VERSION,
    displayName: 'GitHub (read-only)', sources: ['GITHUB_ISSUE', 'GITHUB_PULL_REQUEST'], emits: ['SOURCE_ITEM'],
    sensitivity: { default: 'PRIVATE' }, retention: { raw: 'USER_CONFIGURABLE' },
    requiredSecrets: ['oauth_refresh_token'], promptInjectionRisk: 'HIGH',
    minimumSyncCapability: 'github.read_issues',
    capabilities: [
      capability({ capabilityId: 'github.read_pull_requests', riskClass: 'LOW',
        scopes: ['metadata:read', 'pull_requests:read', 'checks:read'],
        profile: PROJECT_PROFILE,
        description: 'Read pull requests, their review threads, commits and CI results.' }),
      capability({ capabilityId: 'github.read_issues', riskClass: 'LOW', scopes: ['metadata:read', 'issues:read'],
        profile: PROJECT_PROFILE,
        description: 'Read issues and their comment threads.' }),
    ],
  }),
  connectorManifestSchema.parse({
    id: 'connector.documents', connectorType: 'DOCUMENT', version: MANIFEST_VERSION,
    displayName: 'Uploaded documents', sources: ['DOCUMENT'], emits: ['SOURCE_ITEM'],
    sensitivity: { default: 'PRIVATE' }, retention: { raw: 'USER_CONFIGURABLE' },
    requiredSecrets: [], promptInjectionRisk: 'HIGH',
    minimumSyncCapability: 'documents.upload',
    capabilities: [
      capability({ capabilityId: 'documents.upload', riskClass: 'LOW', profile: ASSISTANT_PROFILE,
        description: 'Store a document you upload, and index its text immediately.' }),
      capability({ capabilityId: 'documents.read', riskClass: 'LOW', profile: ASSISTANT_PROFILE,
        description: 'Read and search the documents you have uploaded.' }),
    ],
  }),
]);

export const CONNECTOR_MANIFESTS: ReadonlyMap<ConnectorType, ConnectorManifest> = new Map(
  MANIFEST_LIST.map(manifest => [manifest.connectorType, manifest]));

/** The sensitivity levels of PRD §30.3, least to most restricted. */
const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;
export type StoredSensitivity = (typeof SENSITIVITY_ORDER)[number];

/**
 * The sensitivity a connector's evidence is stored at: the stricter of the
 * manifest's declared default and what the request asked for.
 *
 * The manifest default is a *floor*, not a suggestion. PRD §7.8 lets the owner
 * inspect and change domain sensitivity, but the level on a sync or upload
 * request is a caller's parameter, and without the floor a caller could store
 * Gmail content at NORMAL simply by asking for it. Raising above the default is
 * allowed and lowering is not, and the level actually used is reported on the
 * receipt so the difference is visible rather than silent.
 *
 * The defaults themselves are settled for V0: every source type this node ships
 * -- Gmail (PRD §27.2), conversation, Calendar, uploads and GitHub -- defaults to
 * PRIVATE. Financial imports are not a V0 connector; when they arrive they default
 * to RESTRICTED. The owner may lower a connector below its default only through an
 * explicit per-connector consent action on the Permission management surface
 * (PRD §7.8), audited per §30.6 and effective only for items stored after the
 * change; no request header or body field lowers the floor, and no stored row is
 * rewritten (§42). That consent path is the Permissions surface's
 * (`domain_sensitivity_settings`, ADR 0027 §7): `ownerFloor` is the owner's
 * recorded setting, read at the operation, and it replaces the manifest default.
 */
export function storedSensitivity(
  manifest: ConnectorManifest, requested: StoredSensitivity, ownerFloor: StoredSensitivity | null = null,
): StoredSensitivity {
  const floor = ownerFloor ?? manifest.sensitivity.default as StoredSensitivity;
  return SENSITIVITY_ORDER.indexOf(requested) > SENSITIVITY_ORDER.indexOf(floor) ? requested : floor;
}

/** Whether a declared sensitivity ceiling can hold what this connector stores.
 * A ceiling below the floor is refused by name rather than met by lowering the
 * floor, and rather than left to fail as a row-policy error. */
export function ceilingAdmits(ceiling: StoredSensitivity, stored: StoredSensitivity): boolean {
  return SENSITIVITY_ORDER.indexOf(ceiling) >= SENSITIVITY_ORDER.indexOf(stored);
}

export class ConnectorError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code); this.name = 'ConnectorError'; this.detail = detail;
  }
}

export function manifestFor(connectorType: string): ConnectorManifest {
  const manifest = CONNECTOR_MANIFESTS.get(connectorType as ConnectorType);
  if (!manifest) throw new ConnectorError('CONNECTOR_TYPE_UNSUPPORTED', { connectorType });
  return manifest;
}

export function capabilityOf(manifest: ConnectorManifest, capabilityId: string): ManifestCapability {
  const found = manifest.capabilities.find(entry => entry.capabilityId === capabilityId);
  if (!found) {
    // A capability the manifest does not list is refused by name, and a write
    // capability is refused as a write rather than as an unknown string: the
    // consent screen has to be able to say which it was (CRT-CON-02-A).
    if (WRITE_CAPABILITIES.includes(capabilityId)) {
      throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED',
        { capabilityId, connectorType: manifest.connectorType, reason: 'V0_IS_READ_ONLY' });
    }
    throw new ConnectorError('CONNECTOR_CAPABILITY_UNKNOWN', { capabilityId, connectorType: manifest.connectorType });
  }
  return found;
}

/** Whether a provider scope string is a write scope. Used to prove the consent
 * handoff requests read-only scopes and nothing else. */
export function isWriteScope(scope: string): boolean {
  return WRITE_SCOPE_PATTERNS.some(pattern => pattern.test(scope));
}

/** Every scope one grant set asks the provider for, deduplicated and ordered. */
export function requestedScopes(manifest: ConnectorManifest, granted: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const entry of manifest.capabilities) {
    if (granted.includes(entry.capabilityId)) for (const scope of entry.scopes) scopes.add(scope);
  }
  return [...scopes].sort();
}
