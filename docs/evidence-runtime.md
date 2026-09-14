# Evidence runtime delivery

Authority: goal-aa27afc9-5409-408d-961d-b9c20954d16c design v1 and approved
contract-uai-v0/rev-uai-v0-001 (digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339).
ADR 0010 records decisions before implementation. ADRs 0001–0008 and the existing
authentication implementation were inspected and retained; ADR 0009 remains an
unimplemented rejected proposal. docs/foundation.md describes the earlier node,
not this successor graph's acceptance ownership.

## Implemented scope

Screens: preserved Sign-in and device registration; common responsive navigation;
the durable-storage portion of Document upload and connector source detail at
/sources. The screen provides a labeled file input, explicit sensitivity and
personal-assistance purpose, pending storage, stored, unavailable and retry states.
It does not label storage as successful extraction or searchable semantic memory.
File selection starts a new upload identity; retries of that selection retain the
same key. The server derives owner and USER actor from the session.

Entities: users, owner_scopes, owner_scope_members, devices and audit_events are
preserved; migrations add connectors, source_items and source_anchors with forced
RLS and composite owner foreign keys. source_anchors is the immutable storage
boundary for the identity/extraction node, not a claim that extraction exists.
evidence_ingestion_receipts is append-only idempotency infrastructure. There are
11 classified application tables, including existing auth infrastructure.

POST /v1/evidence has no queue, extraction, registry or LLM dependency. The service
locks the live session, stores immutable metadata, awaits an encrypted object
receipt, appends audit and verifies PostgreSQL's COMMIT command tag before
returning {evidenceId, ingestionStatus: "STORED"}. Null and non-null connectors
share the exact specified UNIQUE NULLS NOT DISTINCT constraint. Concurrent
duplicates return one ID. New content creates a new item; first-write metadata
is retained on duplicates. Reused keys cannot change identity, even when the
first request for that key deduplicated an earlier submission.

Content is canonical UTF-8 JSON: recursively sorted object keys, original array
order. SHA-256 covers those exact bytes. Binary uploads use a base64 envelope
with fileName and mediaType, preserving the original bytes. The 512 KB web limit
fits the API's 1 MB JSON body limit. No content is interpreted as instructions.
Public evidence IDs and rawObjectRef UUIDs are independent of hashes and random
private raw_object_ref keys. Public DTOs never contain those keys. S3 conditional
PUT forbids overwriting an existing key. The transaction-bound object resolver
checks actor/owner/purpose and queries RLS-protected source metadata.

Actor attribution (actorRef) is distinct from authenticated submitted_by_user_id.
USER attribution must match the session. Other source attribution does not confer
connector or canonical authority. actor_entity_id is constrained null until the
identity node introduces the governed entity relationship. Connector provisioning,
consent, sync cursors and revocation remain with the connector owner; this API
accepts only an existing active owner-local connector and grants no provisioning
or connector mutation route.

## API and configuration

All routes require the Secure session cookie, x-owner-scope-id, x-purpose and
UUID x-correlation-id. Evidence routes additionally require x-data-purpose (for
example PERSONAL_ASSISTANCE) and x-maximum-sensitivity (NORMAL/PRIVATE/RESTRICTED).
Application checks and SQL policy both enforce these before data is returned.
These are direct authenticated owner operations; they give no LLM or plugin a
database credential or read path.

| Route | x-purpose | Behavior |
| --- | --- | --- |
| POST /v1/evidence | evidence.ingest | Durable storage; body follows evidenceInputSchema; idempotency-key header must equal body idempotencyKey |
| GET /v1/evidence/:id | evidence.read | Every retained metadata field through publicEvidenceSchema |
| GET /v1/connectors/:id | connector.read | Public connection status plus up to 50 latest permitted source metadata records |

The POST schema requires ownerScopeId, sourceType, externalId, actorRef,
occurredAt (nullable), content, sensitivity, allowedPurposes and idempotencyKey.
connectorId and parentExternalId default null; deterministicMetadata defaults {}.
observedAt, contentHash, ingestionVersion and public/raw identifiers are derived.
Metadata errors produce fixed codes without provider messages. Failed operations
roll back material work and append a separate failure/refusal audit when the
authenticated owner transaction is still available. Existing append-only audit
and OpenTelemetry API/owner-transaction spans provide correlated primitives for
later pipeline consumers, without payloads, cookies or private keys.

In addition to docs/foundation.md's PostgreSQL/Auth.js/TLS configuration, set:
UNAI_S3_ENDPOINT (HTTPS), UNAI_S3_REGION, UNAI_S3_BUCKET and UNAI_S3_KMS_KEY_ID.
The KMS value must exactly match both bucket settings and returned encryption
receipts (use the provider's canonical key ARN). SDK credentials come from the
deployment identity chain. Startup refuses an incorrectly encrypted bucket.
Apply migrations using pnpm db:migrate with the documented privileged migration
principal; runtime roles remain unai_app and unai_auth with no bypass authority.

An object can survive a failed database commit as an inaccessible orphan. Do not
delete objects after an ambiguous commit receipt. Deployment reconciliation must
compare private object keys to durable rows after a conservative grace period.
Production encryption of database volumes/backups, KMS access and bucket denial
policies still need deployment evidence; local tests do not establish it.

## Verification and graph boundaries

pnpm test now starts disposable real PostgreSQL/pgvector and pinned MinIO with
verified HTTPS, random test-only credentials and a random static KMS key. OpenSSL
is required (the harness also finds Git for Windows' bundled binary). Containers
use temporary storage and are stopped after testing; generated TLS keys are
removed from the checked temporary directory. No production mocks are introduced.

Observed red/green checks: initially six evidence tests failed due to absent
routes/tables while the original 186 passed; retry-alias and conditional-PUT
regressions were also observed failing before their fixes. The real S3 test
retrieves exact bytes through the production resolver and validates SHA-256;
missing purpose/sensitivity is refused. Direct SQL duplicate tests exercise both
null and non-null connectors. Owner isolation fixtures query every classified
table without application WHERE filters. Existing auth/session, audit mutation,
migration history and aborted-COMMIT tests remain enabled.

Latest verification: pnpm test exited 0 (198 tests, 22 files); pnpm typecheck and
pnpm build passed. pnpm validate:registry exited 1 with REGISTRY_RELEASE_MISSING.
The configured CI command remains intact and the daemon verifier is authoritative.

This node owns CRT-EVD-01-A, CRT-EVD-02-A, CRT-EVD-02-B and CRT-EVD-03-A.
It does not own phase exit. In sealed graph
4fe8879293f729d0f86604944f5ddaf78cf10624e2b501ff422eb610e12c8f92,
CRT-NFR-07-A belongs to uai-r2-foundation-check, which depends on
uai-r2-evidence-runtime, uai-r2-durable-workers, uai-r2-gmail-corpus and
uai-r2-registry-release. Registry release criteria CRT-REG-01-A/B, CRT-REG-03-A,
CRT-REG-07-A and CRT-OUT-01-A belong to uai-r2-registry-release. Real corpus
CRT-QA-02-A and Gmail CRT-EVD-02-C/04-A belong to uai-r2-gmail-corpus, which depends
on this node and registry-release. No assigned criterion requires a descendant's
deliverable; no contradictory assignment was found and no criterion was moved.
Search, lazy extraction, source excerpts, sync results and real connector consent
are downstream portions of the shared screen, not completed by durable storage.
