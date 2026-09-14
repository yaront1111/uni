# ADR 0010: Synchronous evidence persistence

Date: 2026-09-14
Status: Implementation decisions recorded before code

Authority: goal-aa27afc9-5409-408d-961d-b9c20954d16c design v1,
contract-uai-v0/rev-uai-v0-001, CRT-EVD-01-A, CRT-EVD-02-A/B,
CRT-EVD-03-A. All pinned contract and design pages were read. Retain ADR 0008's
recorded operator approval and inspected Google/Auth.js, hashed opaque session,
revocation and device implementation. Do not implement rejected ADR 0009.

Use PostgreSQL NULLS NOT DISTINCT uniqueness for the specified evidence tuple.
Allocate public UUIDv7 identifiers independently of SHA-256 content hashes and
random private object keys. Store a public raw-object UUID separately from its
internal key. Canonical JSON content (sorted object keys, array order preserved)
defines the bytes and SHA-256; binary documents use a base64 content envelope.
Preserve original first-write metadata on duplicates; changed content produces a
new evidence version. A reused idempotency key for different identity is refused.
An append-only evidence_ingestion_receipts infrastructure table binds every
accepted retry key, including keys attached to duplicate submissions, to the
original item. It has explicit owner RLS and a composite evidence FK. It is not a
product entity. S3 PUT uses If-None-Match so no application upload overwrites an
existing private object key. The service never acknowledges an ambiguous PUT.

Local CI additionally runs a disposable pinned MinIO server with verified TLS and
a random test-only static KMS key; this is real encrypted object storage, not an
S3 emulator. It is not evidence of production bucket policy or encrypted database
volumes. The key configuration follows the upstream development setup:
https://github.com/minio/minio/blob/master/docs/kms/IAM.md .

Within one authenticated owner transaction, lock the session, insert the source
row with ON CONFLICT DO NOTHING, resolve its private object key through that same
transaction, await encrypted S3 PUT, append audit, and require the COMMIT receipt.
No extraction, registry, queue or model dependency is involved. Failed PUT rolls
back the row. An object written before a failed database commit may be orphaned;
it is never publicly resolvable. Do not delete on ambiguous commit outcomes.
Deployment must reconcile unreferenced objects conservatively with a grace period.

Keep actorRef (source attribution) distinct from authenticated submitted_by_user_id
and from future resolved actor_entity_id (null until the identity node owns it).
Owner and USER actor input must match the authenticated session. Connector data
requires an owner-local active connector; connector provisioning/consent is owned
by the real-connectors node and has no new public write endpoint here.

Specify GET /v1/evidence/:id and GET /v1/connectors/:id for the designed source
detail. These return authorized public identifiers and stored metadata, never
keys or credentials. POST uses evidence.ingest; GET uses evidence.read or
connector.read. A separate x-data-purpose declares the allowed-purpose token,
and x-maximum-sensitivity declares NORMAL/PRIVATE/RESTRICTED for evidence reads.
Both application checks and RLS enforce the declared purpose and sensitivity.
These are direct owner access paths, not grants to a model/plugin or a broker
bypass. The web chooses PERSONAL_ASSISTANCE explicitly in its labeled upload form.

Source anchors carry explicit owner scope with a composite evidence foreign key.
All original evidence/anchor metadata is immutable to runtime credentials; future
deletion and extraction paths must add their own reviewed authorities. No new
registry, matching, extraction, retention or product outcome semantics are chosen.

Scope boundary: durable-storage portion of Document upload and connector source
detail plus preserved Sign-in/device registration and common responsive navigation.
Foundation exit CRT-NFR-07-A belongs to uai-r2-foundation-check, which depends on
this node, durable-workers, gmail-corpus and registry-release. Their completion is
not inferred. The four assigned evidence criteria have no descendant dependency.
