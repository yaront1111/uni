# ADR 0034: Coordinated test recovery and bounded evidence references

Date: 2026-09-19
Status: Implementation record; no requirement waived

REQ-NFR-03, REQ-OPS-01 and REQ-SEC-08 require usable recovery evidence.
The test harness takes a quiescent logical snapshot: pg_dump plus every live
object decrypted by the source KMS, sealed together with AES-256-GCM. The backup
key is written to a separate temporary recovery location, the original key
buffer is cleared, and recovery reads that key and the saved archive. Recovery
uses a new empty database and an independent encrypted object store with its
own KMS key. Decrypted object digests and all database rows must match before
fresh Today, Ask, packet and Why reads are compared. No fixture data is seeded
into the restore target. The production runbooks retain deletion watermark,
credential rotation and maintenance requirements.

This record post-dates the existing fallback S3 test server and the first
recovery implementation edits. It does not establish advance ADR compliance.
The fallback server remains test-only, checks credentials rather than full
SigV4 signatures, and is not a production S3 implementation. Its encrypted
storage is already labelled as a test harness in its source. This retrospective
record makes that test-environment choice explicit; it authorizes no production
substitute for the required reference stack or encryption boundaries.

The full fixture state exposed an existing broker failure when a source has more
than 64 anchors. The packet contract already bounds an evidence reference at 64.
Before fixing that failure, record this decision: return the first 64 ordered
anchor IDs and a single EVIDENCE_ANCHOR_LIMIT_REACHED unknown, while preserving
all anchors in storage and their source navigation. Do not enlarge the contract
or truncate facts, claims, source items, selection results or watermarks. This
is enforcement of the existing bounded-packet contract, not a PRD deviation.

The harness limits concurrent Vitest workers to four. Every existing test,
assertion and timeout remains active; this avoids oversubscribing the shared
PostgreSQL server and turning CPU contention into unrelated five-second failures.
