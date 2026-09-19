# ADR 0038: Durable evidence processing and owner-scoped workers

Status: Accepted for implementation, 2026-09-19

## Decision

Evidence ingestion records a content-free processing intent in the same database
transaction as its deterministic triage decision. An eligible source therefore
survives a crash before queue dispatch. Deferred documents acquire an intent in
the upload transaction only when an explicit full-extraction trigger applies.
SOURCE_ONLY and INDEX_ONLY evidence never acquires a deep-extraction intent.
An upgrade also recovers explicit document extraction jobs already in the durable
queue. Their queue identities and payloads stay immutable; the ledger recovers
the evidence's original time and the targeted mode required by a deferred route.
An unrequested document or completed legacy job is not newly scheduled.

The existing PostgreSQL queue provides bounded attempts, expiring leases and
manual dead-letter retry. A processing ledger pins the registry release and
records the successful extraction run, canonicalization result, governed
transaction and projection completion. Source/run/stage keys make replay safe;
completed extraction and committed governor receipts are reused after a crash.
Source permissions and live owner membership are checked on every attempt.

The API and worker use the same composition. The worker is explicitly configured
for one owner and actor, a published immutable registry release, source data
purpose and sensitivity ceiling, and a real configured model provider. Missing
configuration fails startup. It holds an application database login, never a
migration login. Credentials use the existing secrets manager. No model mock or
silent fallback is permitted outside tests.

Source assertion time and timezone travel separately from ingestion, extraction
and access timestamps. Missing source time or timezone stays unknown. Relative
phrases are resolved only with both original reference time and justified zone;
explicit instants remain resolvable without inventing either. No successful
processing stage refreshes an old assertion.

Extraction creates grounded candidate claims. The first complete semantic path
is the existing commitment capability, using the exact checked source span,
resolved source actor and original temporal interpretation. Other frame types,
unresolved identity, consideration language and unsupported semantics remain
candidate claims with an explicit NEEDS_REVIEW processing result. The worker
never reports these sources as fully understood. Model-derived statements remain
PROVISIONAL under the existing governor; only the governor may authorize stronger
belief. Canonicalization and projection writes retain their existing purposes.

The ledger stores identifiers, versions, timestamps, counts and stable error
codes, never source text, model responses, credentials or inferred prose. Its
read surface is source-gated and owner-scoped. Source deletion prevents further
processing; derived content continues through the existing erasure cascade.

## Initiative boundary

Scheduled initiative uses the same durable queue and owner-scoped runtime. Its
persisted trigger records distinguish a local schedule/deadline threshold from
material memory state. Each attempt reads current permission and attention
settings and broker-authorized context. Repeated scheduling, lease recovery and
another device do not authorize duplicate reminders or drafts. The runtime may
prepare an enabled governed draft; it has no external execution authority.

## Verification

API journey tests ingest real evidence through the delivered storage and owner
boundary, run the production composition with only the model provider replaced,
then read Ask and owner corrections. They cover original/unknown time, source-only
routing, durable dispatch, retry after extraction and governance, revoked source
access, model failure, dead letters and manual retry. Ownership tests cover every
new table. Automated fixture evidence, private real-corpus validation and observed
deployment are reported separately.
