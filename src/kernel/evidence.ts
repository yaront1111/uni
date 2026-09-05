// Uai memory kernel — Phase 1 (PRD section 47): the evidence ledger.
//
// PRD section 11.1: evidence is an immutable representation of something that
// entered Uai. It answers "what entered the system, from where, by whom, and
// when?" — never "was the content true?". Evidence MUST remain durable even if
// semantic processing fails.
//
// PRD section 11.2: a source anchor is a precise location inside evidence. One
// evidence item may carry many anchors.
//
// PRD sections 13.1 / 13.2: identity is a surrogate UUIDv7; the content hash is
// only a lookup index / duplicate-detection key (section 33.2 uniqueness tuple),
// never the identity.
//
// PRD section 35.1: the ingest path returns the evidence id BEFORE semantic
// processing. Extraction is not part of this slice; an optional injected hook
// exists solely as a test seam proving that persistence never waits on it.

import { createHash } from "node:crypto";
import { uuidV7, type SurrogateId } from "./identities.ts";

// ---------------------------------------------------------------------------
// Surrogate identifiers (section 13.1)
// ---------------------------------------------------------------------------

export type EvidenceId = SurrogateId<"EvidenceId">;
export type SourceAnchorId = SurrogateId<"SourceAnchorId">;

/** Takes no content input: an evidence id can never be re-derived from bytes. */
export function mintEvidenceId(): EvidenceId {
  return uuidV7() as EvidenceId;
}
export function mintSourceAnchorId(): SourceAnchorId {
  return uuidV7() as SourceAnchorId;
}

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Sensitivity levels (PRD section 30.3). V0 keeps this hierarchy small. */
export const SENSITIVITY_LEVELS = ["NORMAL", "PRIVATE", "RESTRICTED"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Version stamp written into every record produced by this ledger. */
export const INGESTION_VERSION = "evidence-ledger/0.1.0";

// ---------------------------------------------------------------------------
// Content hashing (section 13.2: a lookup index, never an identity)
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Raw bytes, raw text, or a structured connector payload. */
export type EvidenceContent = string | Uint8Array | JsonValue;

/** Canonical JSON: object keys sorted so equal payloads hash equally. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v as JsonValue)).join(",") + "]";
  }
  const record = value as { readonly [key: string]: JsonValue };
  const entries = Object.keys(record)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k] as JsonValue));
  return "{" + entries.join(",") + "}";
}

function contentBytes(content: EvidenceContent): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return Buffer.from(canonicalJson(content), "utf8");
}

/** sha256 hex of the content. Byte-identical content → identical hash. */
export function contentHashOf(content: EvidenceContent): string {
  return createHash("sha256").update(contentBytes(content)).digest("hex");
}

// ---------------------------------------------------------------------------
// 11.1 Evidence record
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  readonly evidenceId: EvidenceId;
  readonly ownerScopeId: string;
  readonly sourceType: string;
  /** Connector that produced the item; null for direct writes (section 33.2). */
  readonly sourceConnectorId: string | null;
  readonly sourceExternalId: string;
  readonly actorEntityId: string | null;
  /** Caller-supplied valid time (section 12.1). */
  readonly occurredAt: string;
  /** Ledger-assigned recorded time (section 12.2): when Uai learned of it. */
  readonly observedAt: string;
  readonly rawObjectRef: string;
  readonly contentHash: string;
  readonly sensitivity: Sensitivity;
  readonly allowedPurposes: readonly string[];
  readonly ingestionVersion: string;
}

export interface IngestInput {
  readonly ownerScopeId: string;
  readonly sourceType: string;
  /** Defaults to null (direct write without a connector). */
  readonly connectorId?: string | null;
  readonly externalId: string;
  readonly content: EvidenceContent;
  readonly actorEntityId?: string | null;
  readonly occurredAt: string;
  /** Defaults to PRIVATE: personal memory is private unless declared otherwise. */
  readonly sensitivity?: Sensitivity;
  readonly allowedPurposes?: readonly string[];
  /**
   * Optional client idempotency key (section 35.1). When repeated within an
   * owner scope it returns the previously persisted record.
   */
  readonly idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// 11.2 Source anchor
// ---------------------------------------------------------------------------

export interface SourceAnchor {
  readonly sourceAnchorId: SourceAnchorId;
  readonly evidenceId: EvidenceId;
  readonly ownerScopeId: string;
  /** e.g. "MESSAGE_SPAN", "EMAIL_PARAGRAPH", "JSON_PATH", "CALENDAR_FIELD". */
  readonly anchorKind: string;
  /** Precise location payload, e.g. { start: 0, end: 12 } or { path: "$.a" }. */
  readonly anchor: JsonValue;
  readonly normalizedText: string | null;
  readonly createdAt: string;
}

export interface AddSourceAnchorInput {
  readonly evidenceId: EvidenceId;
  readonly anchorKind: string;
  readonly anchor: JsonValue;
  readonly normalizedText?: string | null;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Test seam only. Invoked AFTER a fresh record is persisted. Whatever it does —
 * throw, reject, or never settle — cannot affect the persisted record.
 */
export type ExtractionHook = (record: EvidenceRecord) => unknown;

export interface EvidenceLedgerOptions {
  readonly extractionHook?: ExtractionHook;
}

export interface EvidenceLedger {
  /** Persists synchronously and returns the record before any extraction runs. */
  ingest(input: IngestInput): EvidenceRecord;
  /**
   * Reads one record. When `ownerScopeId` is given, a record belonging to a
   * different scope is invisible (undefined). Without it the read is bound to
   * the scope the record was ingested under.
   */
  getEvidence(evidenceId: EvidenceId, ownerScopeId?: string): EvidenceRecord | undefined;
  /** All records of one owner scope, in ingest order. Never crosses scopes. */
  listEvidence(ownerScopeId: string): readonly EvidenceRecord[];
  /** Attaches an anchor to existing evidence; throws for an unknown evidenceId. */
  addSourceAnchor(input: AddSourceAnchorInput): SourceAnchor;
  listSourceAnchors(evidenceId: EvidenceId, ownerScopeId?: string): readonly SourceAnchor[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Section 33.2 uniqueness tuple — a lookup index, never an identity. */
function dedupeKeyOf(
  ownerScopeId: string,
  connectorId: string | null,
  sourceType: string,
  externalId: string,
  contentHash: string,
): string {
  return JSON.stringify([ownerScopeId, connectorId, sourceType, externalId, contentHash]);
}

export function createEvidenceLedger(options: EvidenceLedgerOptions = {}): EvidenceLedger {
  const hook = options.extractionHook;

  // Storage is partitioned by owner scope so no read can cross a scope.
  const byScope = new Map<string, Map<EvidenceId, EvidenceRecord>>();
  const scopeOfEvidence = new Map<EvidenceId, string>();
  const byDedupeKey = new Map<string, EvidenceRecord>();
  const byIdempotencyKey = new Map<string, EvidenceRecord>();
  const anchorsByEvidence = new Map<EvidenceId, SourceAnchor[]>();

  function scopeStore(ownerScopeId: string): Map<EvidenceId, EvidenceRecord> {
    let store = byScope.get(ownerScopeId);
    if (store === undefined) {
      store = new Map();
      byScope.set(ownerScopeId, store);
    }
    return store;
  }

  function resolve(evidenceId: EvidenceId, ownerScopeId?: string): EvidenceRecord | undefined {
    const scope = ownerScopeId ?? scopeOfEvidence.get(evidenceId);
    if (scope === undefined) return undefined;
    return byScope.get(scope)?.get(evidenceId);
  }

  function runHookIsolated(record: EvidenceRecord): void {
    if (hook === undefined) return;
    try {
      const result = hook(record);
      if (result !== null && typeof result === "object" && "then" in result) {
        // A rejected promise must not surface as an unhandled rejection; a
        // never-settling one is simply never awaited. Persistence is done.
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // A failed extraction removes nothing and invalidates nothing (11.1).
    }
  }

  function idempotencyKeyOf(ownerScopeId: string, key: string): string {
    return JSON.stringify([ownerScopeId, key]);
  }

  /** Binds a client key to whichever record the ingest resolved to, fresh or not. */
  function rememberIdempotencyKey(input: IngestInput, record: EvidenceRecord): void {
    if (input.idempotencyKey === undefined) return;
    byIdempotencyKey.set(idempotencyKeyOf(input.ownerScopeId, input.idempotencyKey), record);
  }

  function ingest(input: IngestInput): EvidenceRecord {
    const connectorId = input.connectorId ?? null;
    const contentHash = contentHashOf(input.content);

    if (input.idempotencyKey !== undefined) {
      const seen = byIdempotencyKey.get(idempotencyKeyOf(input.ownerScopeId, input.idempotencyKey));
      if (seen !== undefined) return seen;
    }

    const dedupeKey = dedupeKeyOf(
      input.ownerScopeId,
      connectorId,
      input.sourceType,
      input.externalId,
      contentHash,
    );
    const existing = byDedupeKey.get(dedupeKey);
    if (existing !== undefined) {
      // The tuple already names a record; a key arriving with this repeat binds
      // to it, so the same key can never later mint a second record.
      rememberIdempotencyKey(input, existing);
      return existing;
    }

    const evidenceId = mintEvidenceId();
    const record: EvidenceRecord = deepFreeze({
      evidenceId,
      ownerScopeId: input.ownerScopeId,
      sourceType: input.sourceType,
      sourceConnectorId: connectorId,
      sourceExternalId: input.externalId,
      actorEntityId: input.actorEntityId ?? null,
      occurredAt: input.occurredAt,
      observedAt: new Date().toISOString(),
      rawObjectRef: `evidence/${input.ownerScopeId}/${evidenceId}`,
      contentHash,
      sensitivity: input.sensitivity ?? "PRIVATE",
      allowedPurposes: [...(input.allowedPurposes ?? ["PERSONAL_ASSISTANCE"])],
      ingestionVersion: INGESTION_VERSION,
    });

    // Persist first — synchronously and completely.
    scopeStore(record.ownerScopeId).set(evidenceId, record);
    scopeOfEvidence.set(evidenceId, record.ownerScopeId);
    byDedupeKey.set(dedupeKey, record);
    rememberIdempotencyKey(input, record);
    anchorsByEvidence.set(evidenceId, []);

    // Only then let semantic processing see it. Its fate is irrelevant here.
    runHookIsolated(record);
    return record;
  }

  function getEvidence(evidenceId: EvidenceId, ownerScopeId?: string): EvidenceRecord | undefined {
    return resolve(evidenceId, ownerScopeId);
  }

  function listEvidence(ownerScopeId: string): readonly EvidenceRecord[] {
    return Object.freeze([...(byScope.get(ownerScopeId)?.values() ?? [])]);
  }

  function addSourceAnchor(input: AddSourceAnchorInput): SourceAnchor {
    const evidence = resolve(input.evidenceId);
    if (evidence === undefined) {
      throw new Error(
        `addSourceAnchor: unknown evidenceId ${String(input.evidenceId)} - anchors cannot be orphaned`,
      );
    }
    const anchor: SourceAnchor = deepFreeze({
      sourceAnchorId: mintSourceAnchorId(),
      evidenceId: evidence.evidenceId,
      ownerScopeId: evidence.ownerScopeId,
      anchorKind: input.anchorKind,
      anchor: structuredClone(input.anchor) as JsonValue,
      normalizedText: input.normalizedText ?? null,
      createdAt: new Date().toISOString(),
    });
    const list = anchorsByEvidence.get(evidence.evidenceId);
    if (list === undefined) {
      anchorsByEvidence.set(evidence.evidenceId, [anchor]);
    } else {
      list.push(anchor);
    }
    return anchor;
  }

  function listSourceAnchors(
    evidenceId: EvidenceId,
    ownerScopeId?: string,
  ): readonly SourceAnchor[] {
    const evidence = resolve(evidenceId, ownerScopeId);
    if (evidence === undefined) return Object.freeze([]);
    return Object.freeze([...(anchorsByEvidence.get(evidence.evidenceId) ?? [])]);
  }

  return Object.freeze({ ingest, getEvidence, listEvidence, addSourceAnchor, listSourceAnchors });
}
