# ADR 0011: Git registry release 0.1.0, loader, lint and snapshot

Date: 2026-09-16
Status: Accepted. Implementation choices recorded before code. The registry
review of record (operator guidance, node review version 5, approval
a07bd42d8e7832400a23ac526ab28b2c9fc91885e93b05a0cbc4b0f43a6af118) decided the
obligation description cardinality: SET. No further registry review is pending
for release 0.1.0.

Authority: goal-aa27afc9-5409-408d-961d-b9c20954d16c design v1 (screen
"CLI/CI: registry and projection replay", entities registry_releases and
registry_contracts), contract-uai-v0/rev-uai-v0-001, CRT-OUT-01-A, CRT-REG-01-A,
CRT-REG-01-B, CRT-REG-03-A, CRT-REG-07-A; PRD §16, §17, §26, §33.3, §35.14, §36.6.
All pinned contract and design pages were read.

## Source of truth and immutability

Contracts are YAML files under `registry/releases/<version>/` with a
`manifest.yaml`. `registry/releases.yaml` records, per version, the Git tag
`registry-v<version>` and a SHA-256 content hash. The content hash is SHA-256
over sorted lines `<relative path>\n<sha256(file bytes)>\n` for every file in
the release directory; unlisted, missing, non-regular and oversized files are
refused. `.gitattributes` marks release files `-text` so Git stores and checks
out identical bytes on every platform.

The runtime loader reads by tag only: it resolves `refs/tags/registry-v<version>`
to a commit and reads blobs from Git objects, never the working tree. It refuses
an unrecorded version, a missing tag, a symlink or submodule entry, and any
content hash differing from the recorded hash. A moved tag therefore cannot
change content. CI lint verifies the checkout against the same recorded hash, so
editing a recorded release fails `pnpm test` and `uai registry lint`. The tag is
created by the operator on the commit that lands this release, after review;
release bytes may change only before that tag exists.

## Contract model

Kinds: FRAME (with inline predicate contracts) and TRANSITION. Every §17.3 frame
field is a required key: id, version, description, contextPolicy,
identityStrategy, identityAnchors, roles, predicates, allowedModalities,
slotQualifiers, authorityRules, mergePolicy, splitPolicy, transitionContracts,
projectionConsumers, invariants, acceptanceTests. §17.3 "cardinality" and
"value types and normalization" are required on each predicate, because the
slot semantics are per predicate. Every §17.4 predicate field is required: id,
frameType, valueType, cardinality, normalization, allowedModalities,
slotQualifiers, temporalBehavior, conflictBehavior, supersessionBehavior,
sourceAuthorityPolicy, projectionContracts. Empty lists are explicit values;
absent keys are lint failures. Unknown keys are refused.

Closed sets: cardinality FUNCTIONAL, SET, EVENT; context kinds BASE, QUOTED,
TEST (BASE default, QUOTED only by registry rule); the eight §11.7 modalities;
the twelve §16.5 outcome codes; link kinds RESOLVES and REALIZES; value types
MONEY, TEXT, TIMESTAMP, TIME_OR_INTERVAL, ENTITY, FRAME_REFERENCE,
EXTERNAL_REFERENCE, ACTION.

Lint rules beyond the schema: unique contract IDs; predicate IDs prefixed by and
frameType equal to their frame; predicate modalities within frame modalities;
referenced transitions exist and name the frame; RESOLVES declares at least one
outcome and REALIZES none; target-required transitions name target types.
Outcome authority (§16.1): a predicate whose local name contains an outcome or
status token (status, state, outcome, resolution, resolved, settled, fulfilled,
fulfillment, completed, completion, cancelled, canceled, done, closed, paid,
open, lifecycle) is refused with OUTCOME_STATUS_PREDICATE_FORBIDDEN; outcome
codes are not a value type. Monetary obligation (§26.1): shared.obligation must
define a required FUNCTIONAL ACTUAL `principal_amount` of type MONEY, and every
amount or principal predicate in it must be MONEY. MONEY values are
`{amount: positive decimal string, currency: ISO 4217 upper-case code}`; the
library refuses any other principal value. No arithmetic is performed.

## Release 0.1.0 content

Frames shared.obligation, shared.commitment, shared.event_occurrence and
finance.payment_allocation, with the §26 roles and predicates. Transitions:
shared.obligation.resolution (RESOLVES; target optional: payment allocation;
FULFILLED, PARTIALLY_FULFILLED, WAIVED, CANCELLED), shared.commitment.resolution
(RESOLVES; target optional: event occurrence; FULFILLED, PARTIALLY_FULFILLED,
WITHDRAWN, CANCELLED, FAILED), shared.event_occurrence.resolution (RESOLVES;
target optional: event occurrence; OCCURRED, OCCURRED_MODIFIED, CANCELLED,
MISSED) and shared.event_occurrence.realization (REALIZES; actual occurrence
realizes a scheduled occurrence or commitment; no outcome). Scheduled calendar
events use shared.event_occurrence with SCHEDULED modality, since no separate
scheduled frame exists in the four required contracts. No contract defines a
status predicate. Expiry creates no resolution (no expiry rule is defined).
Unstated predicate cardinalities follow one value per slot (FUNCTIONAL), except
event participants and event description (SET, the latter for the same reason
as the obligation description decision below). No 0.1.0 predicate needs EVENT;
lint accepts it. These outcome sets and cardinalities come from PRD text and are
covered by the registry review of record below.

### Registry decision: obligation description cardinality

Question (PRD §26.1, design open decision 3): is `shared.obligation.description`
FUNCTIONAL or SET? ADR 0011 proposed SET before code.

Decision (registry review of record, 2026-09-16): **SET**. The same obligation
reaches the registry paraphrased by different sources ("dinner money", "for the
dinner"). FUNCTIONAL would report those paraphrases as conflicting values
instead of one obligation with several descriptions. SET is the lossless
choice: a later release can narrow SET to FUNCTIONAL, but descriptions
collapsed under FUNCTIONAL cannot be recovered. Description is not
identity-defining; principal amount remains FUNCTIONAL.

The decision is recorded in this ADR, in a comment on the predicate in
`registry/releases/0.1.0/shared.obligation.yaml`, and in `docs/registry.md`.
Recording it changed that file's bytes before any tag existed, so the recorded
0.1.0 content hash in `registry/releases.yaml` was updated once to
`6fec376b01ada0e5384374de58661b62ddf8816f797566dcd2b0be5e7218f6d5`. From tag
`registry-v0.1.0` on, the bytes and hash are immutable.

## Runtime snapshot and audit

Migration 0006 adds registry_releases and registry_contracts (one row per frame,
predicate and transition contract, canonical JSON content and SHA-256). Both are
global deployment reference data, not owner data: RLS is enabled and forced, and
unai_app receives no privileges until a reviewed runtime reader needs them.
Triggers refuse UPDATE, DELETE and TRUNCATE. IDs are UUIDv7, independent of
hashes. `uai registry publish --tag` runs with the migration principal over
verified TLS, loads by tag, verifies the hash and inserts atomically. Repeating
the same tag and commit is idempotent; a different hash or commit for a
published version is refused.

Deviation: shared audit_events requires an owner scope and user actor, which a
global deployment operation lacks. Publication audit is the immutable release
row itself (git tag/commit, content hash, database principal `published_by`,
`correlation_id`, `released_at`) plus a structured log line and OpenTelemetry
span with correlation ID, version, result and no contract content.

## No runtime registry service

No HTTP route, web proxy path or API import of the registry package exists.
An architecture test builds the production Fastify composition and inspects
routes and imports (CRT-REG-01-B). CLI only: `uai registry lint` and
`uai registry publish`. The test, shadow-diff and projection-replay commands
belong to uai-r2-registry-replay-check (CRT-REG-02-A, CRT-REG-05-A).
