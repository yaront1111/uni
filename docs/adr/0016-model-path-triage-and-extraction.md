# ADR 0016: The model path — a provider-independent gateway, deterministic triage, and bounded extraction

Date: 2026-09-18
Status: Accepted. Implementation choices recorded before code.

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1 — entities
`triage_decisions`, `extraction_runs`, `model_call_records`; components
"llm-gateway-provider-independent-schema-validated-and-cost-recorded",
"triage-service-tier0-deterministic-parse-and-tier1-routing-with-recorded-reason"
and "extraction-service-surface-frames-with-span-grounding-and-no-canonical-commit";
`GET /v1/evidence/{id}` returning "triage route with reason";
contract-uai-v0/rev-uai-v0-001 CRT-EVD-05-A, CRT-EVD-06-A, CRT-NFR-06-A,
CRT-WRT-07-A, CRT-WRT-07-B, CRT-WRT-08-A; PRD §11.1, §19.2, §20, §22.1, §33.2,
§35.1, §36.2, §36.3, §42. Extends ADR 0004 (applied migrations are immutable),
ADR 0010 (evidence persistence is synchronous), ADR 0011 (the registry snapshot
is a global immutable table), ADR 0012 (the durable job queue) and ADR 0015
(placeholder references and the release pin).

This node implements no screen. Six decisions below are where the code chooses
among readings the PRD and the design leave open, or departs from a literal
column list.

## 1. Tier 1 is deterministic rules, not a classifier

The design records this as an open decision: "The Tier-1 memory-worthiness router
may be rules or a low-cost classifier. Not decided here; the choice affects cost
metrics and the routing-reason shape, and needs an ADR before P1 closes."

Decision: **rules**. `routeTier1` is a pure function of the Tier-0 parse — no
model call, no clock, no network, no random value. Three consequences follow, and
they are the reason for the choice:

- Routing costs nothing, so it can run for *every* ingested item rather than for
  a sampled subset, which is what CRT-WRT-07-A asks for.
- The routing reason is an enumerated `code` plus the exact signals that fired,
  not a score. A reader can reconstruct why a newsletter was held back.
- The router cannot be the thing that makes triage expensive, so "extraction cost
  is bounded by Tier-1 routing" stays true instead of circular.

A later low-cost classifier remains possible: `routing_reason.routerVersion`
records which router decided, so a change of router is visible per row rather
than retroactive.

## 2. Triage is recorded inside the ingest transaction; deep extraction is not

PRD §35.1 requires evidence to be returned before semantic processing, and §0
rule 5 requires raw evidence to stay durable when later processing fails. Those
constraints bind *deep* extraction, which is the model path. Tier-0 parsing and
Tier-1 routing are neither: they are deterministic reads of bytes already in
hand.

Decision: `recordTriageDecision` runs in the same transaction as the evidence
insert, so an ingested item cannot exist without a recorded route, and the
`UNIQUE(owner_scope_id, source_item_id)` index makes a repeat ingestion a no-op
rather than a second decision. Deep extraction runs only on the durable queue
(ADR 0012), never in the ingest path.

Durability is protected explicitly rather than assumed: the Tier-0/Tier-1
computation is wrapped so that a router defect degrades to
`SOURCE_ONLY` with reason `TIER1_ROUTER_UNAVAILABLE` instead of failing the
ingest transaction. Evidence outranks its classification.

## 3. `registry_release_id` on `extraction_runs` is pinned without a foreign key

The design lists `registry_release_id` as a required, non-nullable field of
`extraction_runs`. ADR 0011 gives `registry_releases` to the registry migration
alone, and ADR 0015 §2 already recorded what a reference from owner-scoped data
does to the snapshot's own immutability guard.

Decision: `registry_release_id uuid NOT NULL` with no foreign key, matching the
precedent in ADR 0015 §2. The runtime obtains the id from the loaded snapshot and
passes it in; `unai_app` holds no read privilege on `registry_releases`, so the
pin is supplied by the caller rather than looked up here. Every other version
recorded on a run — normalization, entity resolver, temporal resolver, prompt —
is `NOT NULL` and pattern-constrained.

## 4. A succeeded run must carry its model, cost and latency; a failed one must carry an error code

The design marks `model_provider`, `model_id`, `prompt_version`,
`cost_microunits` and `latency_ms` nullable, because a run may fail before the
model is reached. CRT-WRT-08-A requires every row to *record* them.

Decision: keep the columns nullable and constrain them by status —
`status='SUCCEEDED'` requires all five plus `completed_at`, `status='FAILED'`
requires `error_code`, and `status='RUNNING'` requires `completed_at IS NULL`. A
run that succeeded without recording what it cost is unrepresentable rather than
merely discouraged.

## 5. Extraction writes its own narrow span anchors under `memory.canonicalize`

Claims must reference a `source_anchor` whose anchor resolves to a span present
in the source item (CRT-EVD-06-A). The parsers' anchors cover whole bodies,
fields and pages; a claim about one sentence should not point at the whole
message.

Decision: the extraction service derives a narrower anchor for each extracted
claim, inside the parent anchor it was cut from, and inserts it under the
existing identity index so re-extraction reuses the same anchor row. That needs
an INSERT path for `source_anchors` under `memory.canonicalize`; migration 0011
**adds** a second policy rather than altering the delivered
`evidence.ingest` one. The existing policy is unchanged, and the new one carries
the same owner-access and existing-source-item conditions, so this widens who may
anchor and weakens nothing. A span that does not lie inside a stored parent
anchor is refused, and no claim is written for it.

## 6. Schema-invalid model output is rejected whole, and the call is still recorded

CRT-NFR-06-A requires schema-invalid extraction output to be rejected rather than
stored as claims, and every model call to carry model, prompt version, cost,
latency and correlation id.

Decision: the gateway validates provider output against a caller-supplied Zod
schema *before* returning it, and rejects the whole response — no partial
harvest of the claims that happened to parse, because a response that violates
its contract is not evidence of which half was trustworthy. The
`model_call_records` row is written for all three outcomes (`SUCCEEDED`,
`OUTPUT_REJECTED`, `PROVIDER_FAILED`) in its own transaction, so a rejected or
failed call still accounts for the money it spent. No prompt text, no provider
message and no credential is recorded on the row; a provider error is reduced to
a stable code.

Provider independence is structural: `@unai/domain` holds the extraction
*schemas* and names no provider, no model and no SDK, and the gateway takes a
`ModelProvider` chosen by configuration. Swapping providers is an environment
change plus an adapter in `@unai/model`, and touches no domain file — which
`packages/model/src/gateway.test.ts` checks by parsing every domain source.

## 7. Extraction passes the evidence gate rather than around it

Extraction reads evidence: the source item, its anchors and their text. Those
rows are gated by `unai_private.evidence_access`, which admitted only
`evidence.ingest`, `evidence.read` and `connector.read`, so a transaction under
`memory.extract` or `memory.canonicalize` read none of them. Two ways out were
available: give the extraction tables a private read path around the gate, or
put extraction inside it.

Decision: put it inside. Migration 0011 adds `memory.extract` and
`memory.canonicalize` to the *request purposes* that function admits, and changes
nothing else about it — the declared data purpose must still be one of the item's
allowed purposes, and the declared maximum sensitivity must still be at or above
the item's own. `runExtraction` therefore takes `dataPurpose` and
`maximumSensitivity`, sets both as transaction-local settings, and carries them
on the job so a retry reads under exactly the gate the first attempt did. An item
whose allowed purposes exclude the run's purpose is not extracted, and a
transaction that declares neither still reads nothing, because an unset setting
is NULL and the comparison fails closed.

`triage_decisions` keeps the same gate for the same reason: `tier0_parsed` holds
text taken from the item, so a session that may not read the source item reads no
route derived from it either. This is why the route arrives on the evidence read
(under `evidence.read`) rather than through a separate triage endpoint.
