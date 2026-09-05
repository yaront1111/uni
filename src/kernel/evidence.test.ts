import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SENSITIVITY_LEVELS,
  contentHashOf,
  createEvidenceLedger,
  mintEvidenceId,
  mintSourceAnchorId,
  type EvidenceId,
  type EvidenceRecord,
  type IngestInput,
} from "./evidence.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SCOPE_A = "scope-a";
const SCOPE_B = "scope-b";

function message(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    ownerScopeId: SCOPE_A,
    sourceType: "CONVERSATION",
    connectorId: "connector-chat",
    externalId: "conversation:abc:message:17",
    content: { text: "I paid him back" },
    actorEntityId: null,
    occurredAt: "2026-08-01T09:14:00Z",
    sensitivity: "PRIVATE",
    allowedPurposes: ["PERSONAL_ASSISTANCE"],
    ...overrides,
  };
}

const MINIMUM_FIELDS: readonly (keyof EvidenceRecord)[] = [
  "evidenceId",
  "ownerScopeId",
  "sourceType",
  "sourceConnectorId",
  "sourceExternalId",
  "occurredAt",
  "observedAt",
  "rawObjectRef",
  "contentHash",
  "sensitivity",
  "allowedPurposes",
  "ingestionVersion",
];

describe("evidence record (PRD 11.1)", () => {
  it("crit-record-carries-minimum-fields: ingest() returns every minimum field", () => {
    const ledger = createEvidenceLedger();
    const record = ledger.ingest(message());

    for (const field of MINIMUM_FIELDS) {
      expect(record, `missing ${field}`).toHaveProperty(field);
      expect(record[field], `${field} is undefined`).not.toBeUndefined();
    }
    // The only nullable minimum field.
    expect(record).toHaveProperty("actorEntityId");
    expect(record.actorEntityId).toBeNull();

    expect(record.evidenceId).toMatch(UUID_V7);
    expect(SENSITIVITY_LEVELS).toContain(record.sensitivity);
    expect(SENSITIVITY_LEVELS).toEqual(["NORMAL", "PRIVATE", "RESTRICTED"]);
    expect(record.allowedPurposes).toEqual(["PERSONAL_ASSISTANCE"]);
    expect(record.sourceConnectorId).toBe("connector-chat");
    expect(record.sourceExternalId).toBe("conversation:abc:message:17");
    expect(record.contentHash).toBe(contentHashOf({ text: "I paid him back" }));
    expect(typeof record.ingestionVersion).toBe("string");
    expect(record.ingestionVersion.length).toBeGreaterThan(0);
  });

  it("crit-observed-at-is-ledger-assigned: observedAt is recorded time, not occurredAt", () => {
    const ledger = createEvidenceLedger();
    const before = Date.now();
    const record = ledger.ingest(message({ occurredAt: "2020-01-01T00:00:00Z" }));
    const after = Date.now();

    expect(record.occurredAt).toBe("2020-01-01T00:00:00Z");
    const observed = Date.parse(record.observedAt);
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
    expect(record.observedAt).not.toBe(record.occurredAt);
  });

  it("crit-stored-record-is-frozen: records are frozen and immutable through every read", () => {
    const ledger = createEvidenceLedger();
    const ingested = ledger.ingest(message());
    const read = ledger.getEvidence(ingested.evidenceId);

    expect(Object.isFrozen(ingested)).toBe(true);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(ingested.allowedPurposes)).toBe(true);

    // ES modules run in strict mode: assignment to a frozen field throws.
    expect(() => {
      (ingested as { sensitivity: string }).sensitivity = "NORMAL";
    }).toThrow(TypeError);
    expect(() => {
      (read as unknown as { contentHash: string }).contentHash = "tampered";
    }).toThrow(TypeError);

    const later = ledger.getEvidence(ingested.evidenceId);
    expect(later?.sensitivity).toBe("PRIVATE");
    expect(later?.contentHash).toBe(ingested.contentHash);
    expect(later).toEqual(ingested);
  });
});

describe("idempotent ingestion (PRD 33.2 uniqueness tuple)", () => {
  it("crit-duplicate-ingest-is-one-record: byte-identical input yields one record", () => {
    const ledger = createEvidenceLedger();
    const first = ledger.ingest(message());
    const second = ledger.ingest(message());

    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second).toEqual(first);
    const listed = ledger.listEvidence(SCOPE_A);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.evidenceId).toBe(first.evidenceId);
  });

  it("crit-changed-content-is-a-new-record: same externalId with new content is new evidence", () => {
    const ledger = createEvidenceLedger();
    const v1 = ledger.ingest(message({ content: { text: "I paid him back" } }));
    const v2 = ledger.ingest(message({ content: { text: "I paid him back, 50 ILS" } }));

    expect(v1.sourceExternalId).toBe(v2.sourceExternalId);
    expect(v1.evidenceId).not.toBe(v2.evidenceId);
    expect(v1.contentHash).not.toBe(v2.contentHash);
    expect(ledger.getEvidence(v1.evidenceId)).toEqual(v1);
    expect(ledger.getEvidence(v2.evidenceId)).toEqual(v2);
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(2);
  });

  it("crit-duplicate-ingest-is-one-record: dedupe holds across repeats and interleaving", () => {
    const ledger = createEvidenceLedger();
    const v1 = ledger.ingest(message());
    const v2 = ledger.ingest(message({ content: { text: "edited" } }));
    const v1Again = ledger.ingest(message());

    expect(v1Again.evidenceId).toBe(v1.evidenceId);
    // The repeat returns the stored record untouched — observedAt is not rewritten.
    expect(v1Again).toBe(ledger.getEvidence(v1.evidenceId));
    expect(v1Again.observedAt).toBe(v1.observedAt);
    expect(v2.evidenceId).not.toBe(v1.evidenceId);

    for (let i = 0; i < 5; i += 1) {
      expect(ledger.ingest(message()).evidenceId).toBe(v1.evidenceId);
    }
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(2);
  });

  it("byte-identical content dedupes regardless of how the caller spells it", () => {
    const ledger = createEvidenceLedger();
    const asText = ledger.ingest(message({ content: "I paid him back" }));
    const asBytes = ledger.ingest(message({ content: Buffer.from("I paid him back", "utf8") }));
    // Canonical JSON: key order is not content.
    const reordered = ledger.ingest(message({ content: { b: 2, a: 1 } }));
    const sameShape = ledger.ingest(message({ content: { a: 1, b: 2 } }));

    expect(asBytes.evidenceId).toBe(asText.evidenceId);
    expect(sameShape.evidenceId).toBe(reordered.evidenceId);
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(2);
  });

  it("every component of the 33.2 tuple discriminates", () => {
    const ledger = createEvidenceLedger();
    const base = ledger.ingest(message());
    const variants = [
      ledger.ingest(message({ connectorId: "connector-mail" })),
      ledger.ingest(message({ connectorId: null })),
      ledger.ingest(message({ sourceType: "EMAIL" })),
      ledger.ingest(message({ externalId: "conversation:abc:message:18" })),
      ledger.ingest(message({ content: { text: "different" } })),
    ];

    const ids = new Set([base.evidenceId, ...variants.map((r) => r.evidenceId)]);
    expect(ids.size).toBe(6);
    for (const variant of variants) {
      expect(ledger.getEvidence(variant.evidenceId)).toEqual(variant);
    }
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(6);
  });

  it("fields outside the tuple do not defeat deduplication", () => {
    const ledger = createEvidenceLedger();
    const first = ledger.ingest(message());
    const restated = ledger.ingest(
      message({
        occurredAt: "2026-08-02T11:00:00Z",
        sensitivity: "RESTRICTED",
        actorEntityId: "entity-7",
        allowedPurposes: ["AUDIT"],
      }),
    );

    expect(restated.evidenceId).toBe(first.evidenceId);
    // First write wins: a repeat cannot restate an immutable record (11.1).
    expect(restated.occurredAt).toBe(first.occurredAt);
    expect(restated.sensitivity).toBe("PRIVATE");
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(1);
  });

  it("a key arriving with a deduped repeat binds to that one record", () => {
    const ledger = createEvidenceLedger();
    const first = ledger.ingest(message());
    const keyed = ledger.ingest(message({ idempotencyKey: "client-req-1" }));
    expect(keyed.evidenceId).toBe(first.evidenceId);

    // The same key with new content resolves to the record it was bound to
    // rather than minting a second one.
    const replayed = ledger.ingest(
      message({ idempotencyKey: "client-req-1", content: { text: "retried payload" } }),
    );
    expect(replayed.evidenceId).toBe(first.evidenceId);
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(1);
  });

  it("crit-owner-scope-isolation: identical payloads in two scopes never leak across reads", () => {
    const ledger = createEvidenceLedger();
    const a = ledger.ingest(message({ ownerScopeId: SCOPE_A }));
    const b = ledger.ingest(message({ ownerScopeId: SCOPE_B }));

    expect(a.evidenceId).not.toBe(b.evidenceId);
    expect(a.contentHash).toBe(b.contentHash);

    const scopeA = ledger.listEvidence(SCOPE_A);
    expect(scopeA).toHaveLength(1);
    expect(scopeA[0]?.ownerScopeId).toBe(SCOPE_A);
    expect(scopeA.some((r) => r.evidenceId === b.evidenceId)).toBe(false);

    const scopeB = ledger.listEvidence(SCOPE_B);
    expect(scopeB).toHaveLength(1);
    expect(scopeB[0]?.ownerScopeId).toBe(SCOPE_B);

    // Id-keyed reads are scope-filtered too.
    expect(ledger.getEvidence(b.evidenceId, SCOPE_A)).toBeUndefined();
    expect(ledger.getEvidence(b.evidenceId, SCOPE_B)).toEqual(b);
    expect(ledger.listSourceAnchors(b.evidenceId, SCOPE_A)).toEqual([]);
    expect(ledger.listEvidence("scope-unknown")).toEqual([]);
  });
});

describe("persistence never waits on semantic processing (PRD 11.1, 35.1)", () => {
  it("crit-ingest-persists-before-extraction: a never-settling extractor cannot delay the record", () => {
    const seen: EvidenceRecord[] = [];
    const ledger = createEvidenceLedger({
      extractionHook: (record) => {
        seen.push(record);
        return new Promise<never>(() => {
          /* never settles */
        });
      },
    });

    const record = ledger.ingest(message());
    expect(record.evidenceId).toMatch(UUID_V7);
    // Same tick: no await between ingest and read.
    expect(ledger.getEvidence(record.evidenceId)).toBe(record);
    // The hook ran after the record was already retrievable.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(record);
  });

  it("crit-evidence-survives-throwing-extractor: a throwing extractor removes nothing", () => {
    const ledger = createEvidenceLedger({
      extractionHook: () => {
        throw new Error("extractor exploded");
      },
    });

    let record: EvidenceRecord | undefined;
    expect(() => {
      record = ledger.ingest(message());
    }).not.toThrow();
    expect(record).toBeDefined();
    const stored = ledger.getEvidence((record as EvidenceRecord).evidenceId);
    expect(stored).toEqual(record);
    expect(ledger.listEvidence(SCOPE_A)).toHaveLength(1);
  });

  it("a rejecting async extractor is equally harmless", async () => {
    const ledger = createEvidenceLedger({
      extractionHook: () => Promise.reject(new Error("async extractor failed")),
    });
    const record = ledger.ingest(message());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.getEvidence(record.evidenceId)).toEqual(record);
  });

  it("the hook only runs for freshly persisted records, not for deduped repeats", () => {
    let calls = 0;
    const ledger = createEvidenceLedger({
      extractionHook: () => {
        calls += 1;
      },
    });
    ledger.ingest(message());
    ledger.ingest(message());
    expect(calls).toBe(1);
  });
});

describe("source anchors (PRD 11.2)", () => {
  it("crit-anchor-attaches-to-existing-evidence: anchors attach to known evidence only", () => {
    const ledger = createEvidenceLedger();
    const evidence = ledger.ingest(message());

    const anchor = ledger.addSourceAnchor({
      evidenceId: evidence.evidenceId,
      anchorKind: "MESSAGE_SPAN",
      anchor: { start: 0, end: 15 },
      normalizedText: "I paid him back",
    });

    expect(anchor.sourceAnchorId).toMatch(UUID_V7);
    expect(anchor.evidenceId).toBe(evidence.evidenceId);
    expect(anchor.anchorKind).toBe("MESSAGE_SPAN");
    expect(anchor.anchor).toEqual({ start: 0, end: 15 });
    expect(anchor.normalizedText).toBe("I paid him back");
    expect(Object.isFrozen(anchor)).toBe(true);

    const listed = ledger.listSourceAnchors(evidence.evidenceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(anchor);

    const orphan = mintEvidenceId();
    expect(() =>
      ledger.addSourceAnchor({
        evidenceId: orphan,
        anchorKind: "MESSAGE_SPAN",
        anchor: { start: 0, end: 1 },
      }),
    ).toThrow(/unknown evidenceId/);
    expect(ledger.listSourceAnchors(orphan)).toEqual([]);
  });

  it("crit-many-anchors-per-evidence: one evidence item carries many precise locations", () => {
    const ledger = createEvidenceLedger();
    const evidence = ledger.ingest(
      message({ content: { text: "I paid him back. Also, dinner Friday at 8." } }),
    );

    const first = ledger.addSourceAnchor({
      evidenceId: evidence.evidenceId,
      anchorKind: "MESSAGE_SPAN",
      anchor: { start: 0, end: 16 },
      normalizedText: "I paid him back.",
    });
    const second = ledger.addSourceAnchor({
      evidenceId: evidence.evidenceId,
      anchorKind: "MESSAGE_SPAN",
      anchor: { start: 17, end: 42 },
      normalizedText: "Also, dinner Friday at 8.",
    });

    expect(first.sourceAnchorId).not.toBe(second.sourceAnchorId);
    const ids = ledger.listSourceAnchors(evidence.evidenceId).map((a) => a.sourceAnchorId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.sourceAnchorId);
    expect(ids).toContain(second.sourceAnchorId);
  });
});

describe("identity is never a hash (PRD 13.1, 13.2)", () => {
  it("minting functions take no content input", () => {
    expect(mintEvidenceId.length).toBe(0);
    expect(mintSourceAnchorId.length).toBe(0);
    expect(mintEvidenceId()).toMatch(UUID_V7);
    expect(mintSourceAnchorId()).toMatch(UUID_V7);
    expect(mintEvidenceId()).not.toBe(mintEvidenceId());
  });

  it("contentHashOf is sha256 over canonical bytes and is never the evidenceId", () => {
    expect(contentHashOf("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(contentHashOf(Buffer.from("hello"))).toBe(contentHashOf("hello"));
    // Key order does not change the hash of a structured payload.
    expect(contentHashOf({ a: 1, b: [1, { c: "x" }] })).toBe(
      contentHashOf({ b: [1, { c: "x" }], a: 1 }),
    );
    expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));

    const ledger = createEvidenceLedger();
    const record = ledger.ingest(message());
    expect(record.evidenceId as string).not.toBe(record.contentHash);
    expect(ledger.getEvidence(record.contentHash as EvidenceId)).toBeUndefined();
  });
});
