# The model path and bounded extraction

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`llm-gateway-triage-and-extraction-with-run-records`, and approved
contract-uai-v0/rev-uai-v0-001 (digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339). This node owns
CRT-EVD-05-A, CRT-EVD-06-A, CRT-NFR-06-A, CRT-WRT-07-A, CRT-WRT-07-B and
CRT-WRT-08-A. ADR 0016 records its decisions before the code; ADRs 0001–0015 and
the delivered foundation, evidence, registry, queue and canonical-identity slices
were inspected and retained.

**This node implements no screen.** It underlies states of screens other nodes
draw — "Upload a document" (stored and immediately searchable with full
extraction deferred; extraction failed while the document stays retrievable),
"Jobs and dead letter" (evidence intact with an unchanged content hash after a
worker was killed mid-job), "Metrics and cost" (tier routing distribution, model
cost) and "Memory inspector" (registry release and extractor versions) — and adds
no view, page or route of its own beyond the field the evidence read was already
specified to carry.

## Entities

`triage_decisions`, `extraction_runs` and `model_call_records`, added by
`migrations/0011_triage_extraction_and_model_calls.sql` with forced RLS,
purpose-gated policies and composite owner foreign keys. Every earlier table is
preserved. There are now 29 application tables, 27 of them owner-scoped and
classified in `packages/postgres/src/ownership.ts`.

The migration also completes the handoff ADR 0015 §1 recorded: `claims`
`extraction_run_id` loses its placeholder `CHECK(... IS NULL)` and gains the
composite owner foreign key to `extraction_runs`. No claim row is altered; the
column is null on every existing row and stays null there.

## Packages

- **`@unai/model`** — the provider-independent gateway. `invoke` validates the
  provider's output against the caller's Zod schema before returning anything,
  writes a `model_call_records` row for every call in its own `model.call`
  transaction, and enforces the caller's cost ceiling. Two HTTPS adapters ship
  (Anthropic Messages, OpenAI Responses), built from configuration with a
  `secret://` credential handle; `registerModelProvider` is the seam for a
  deployment's own.
- **`@unai/extraction`** — triage (`parseTier0`, `routeTier1`, `triage`,
  `recordTriageDecision`) and extraction (`runExtraction`, `readExtractionRun`,
  `createExtractionJobHandler`).
- **`@unai/api`** — the ingest path records the triage decision in the same
  transaction as the evidence insert, and `GET /v1/evidence/{id}` now returns
  `triage` with the route, its reason and when it was decided.

## What holds, and where it is proved

| Criterion | Where |
| --- | --- |
| CRT-EVD-05-A gateway failure or killed worker: evidence intact, job retried or dead-lettered | `packages/api/src/extraction-pipeline.test.ts` (two cases), `packages/model/src/gateway.test.ts` |
| CRT-EVD-06-A every text-sourced claim resolves to a span in its source item | `packages/api/src/extraction-pipeline.test.ts` (corpus sweep, plus three refusal cases) |
| CRT-NFR-06-A provider swap, complete call records, schema-invalid output rejected | `packages/model/src/gateway.test.ts`, `packages/api/src/extraction-pipeline.test.ts` |
| CRT-WRT-07-A every item routed with a reason; newsletter and CI not FULL_EXTRACTION | `packages/extraction/src/triage.test.ts`, `packages/api/src/extraction-pipeline.test.ts` |
| CRT-WRT-07-B a quoted thread update costs one deep extraction | `packages/extraction/src/triage.test.ts`, `packages/api/src/extraction-pipeline.test.ts` |
| CRT-WRT-08-A run records every version, time and cost; re-extraction leaves prior claims byte-identical | `packages/api/src/extraction-pipeline.test.ts` |

Six behaviours are worth stating because they are easy to assume the other way:

- **Triage runs in the ingest transaction; extraction never does.** Tier 0 and
  Tier 1 are pure functions of bytes already in hand — no model, clock, network or
  random value — so the route is recorded with the evidence and an ingested item
  cannot exist without one. A defect in the router degrades to `SOURCE_ONLY` with
  reason `TIER1_ROUTER_UNAVAILABLE` rather than failing the ingest: evidence
  durability outranks its classification. Deep extraction runs only on the durable
  queue (ADR 0016 §1, §2).
- **Tier 1 is rules, and the design left that open.** The open decision "rules or
  a low-cost classifier" is answered in ADR 0016 §1: rules, version
  `tier1-rules-0.1.0`, recorded per row so a later change of router is visible
  rather than retroactive. The reason carries the named signals that fired, not a
  score.
- **A negative signal outranks a positive one.** The newsletter fixture quotes an
  amount and a deadline and is still routed `INDEX_ONLY` — preserved and
  searchable, with no canonical belief taken from it. The same holds for the two
  `github-actions[bot]` CI comments, while the human pull request in the same
  payload is not treated as noise.
- **Quoted history is cut once, in Tier 0.** The thread-update fixture's newest
  message quotes three earlier ones; its new content is 89 characters and that is
  what is routed and read. A message that is *only* quoted history routes
  `SOURCE_ONLY`, so the update costs one deep extraction and one model call, not
  one per quoted message.
- **A span is checked against stored evidence, not believed.** Every extracted
  claim names a parent anchor, an offset range and the exact quote; the service
  re-reads the stored anchor text and refuses a span that lies outside it or a
  quote that is not the text at that offset. The whole run fails —
  `EXTRACTION_ANCHOR_UNRESOLVED` — rather than storing an ungrounded claim. The
  narrower anchor it writes reuses the existing identity index, so re-extraction
  does not duplicate anchors.
- **Re-extraction appends.** A second run over the same evidence inserts new claim
  rows and leaves the earlier rows identical field for field (the test hashes
  every column of every row before and after). The claim store holds no UPDATE
  grant, and a closed run cannot be reopened or re-versioned: the trigger raises
  `EXTRACTION_RUN_ALREADY_CLOSED` and `EXTRACTION_RUN_IMMUTABLE` even for the
  privileged principal.

## Provider independence, concretely

`@unai/domain` holds the extraction schemas and names no provider, no model and
no SDK — `gateway.test.ts` parses every file in that package and fails if one
does. Swapping providers is `UNAI_MODEL_PROVIDER`, `UNAI_MODEL_ENDPOINT`,
`UNAI_MODEL_ID`, the credential handle and the two pricing variables; the
extraction service, the claim store and every schema are untouched. A call that
was rejected for violating its schema, or that failed at the provider, is still
recorded with model, prompt version, cost, latency and correlation id, because it
still spent money. No prompt text, provider message or credential is recorded:
a provider error becomes a stable code before it crosses the gateway boundary.

## Configuration

New variables, all for the model path: `UNAI_MODEL_PROVIDER` (`anthropic`,
`openai`, or a registered deployment adapter), `UNAI_MODEL_ENDPOINT` (HTTPS
only — a plaintext endpoint is refused at construction, because a prompt carries
owner content), `UNAI_MODEL_ID`, `UNAI_MODEL_API_KEY` (a `secret://` handle; a
literal key is refused, ADR 0013), `UNAI_MODEL_INPUT_MICROUNITS_PER_1K` and
`UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K`, and the optional
`UNAI_MODEL_API_VERSION`. Nothing here is required by the API server, which
starts no extraction worker.

Three purposes are new: `memory.extract` (open and close a run), `model.call`
(the gateway's accounting transaction) and — reusing the identity node's —
`memory.canonicalize` for the transaction that writes claims and completes the
run atomically with them. Migration 0011 adds the first two model-path purposes
to `unai_private.evidence_access`'s request-purpose list and changes nothing else
about that function, so an extraction run must still declare a data purpose
within the item's allowed purposes and a sensitivity ceiling at or above the
item's own (ADR 0016 §7). A run over an item whose allowed purposes exclude it
reads nothing and extracts nothing.

## What this node does not claim

- **Nothing enqueues an extraction job yet.** The job kind `evidence.extract`,
  its payload schema and its handler are delivered and exercised against the real
  queue, but no code decides *when* to enqueue: that is the connector sync path's
  decision and belongs to the required-connectors node. The ingest transaction
  cannot enqueue it, because one transaction carries one purpose and the queue
  policy gates on `jobs.enqueue`.
- **No belief, ever.** Extraction writes claims with `claim_origin =
  MODEL_EXTRACTION`, no proposition and lifecycle `CANDIDATE`. Entity resolution,
  instance matching, propositions, belief assessments and the Belief Transaction
  that admits any of them belong to later nodes. The run records the entity- and
  temporal-resolver versions it pinned; only the temporal resolver is actually
  invoked here, on the phrase the extractor hands over verbatim.
- **No Tier-2 registry mapping or instance matching.** A claim carries a
  `candidate_frame_type_id`, not a resolved frame instance.
  `instance_match_candidates` is the frame-instance matcher node's table.
- **No metrics backend.** The rows that make cost per source item, cost per claim
  and tier routing distribution computable are written; the
  `economic_and_quality_metrics` table and the Metrics and cost screen are the
  metrics node's.
- **No connector, no document route, no shadow evaluation.** `run_kind` admits
  `SHADOW`, but `shadow_evaluation_runs` and `uai registry shadow-diff` belong to
  the shadow-evaluation node.
- **No worker process or scheduler.** `runJobAttempt` from `@unai/jobs` drives the
  handler; nothing here runs a loop or owns a lease renewer.

## Verification

`pnpm test` exited 0: 392 tests in 39 files (367 in 36 before this node), over
disposable pgvector with all eleven migrations applied and disposable TLS/KMS
object storage. `pnpm typecheck`, `pnpm build` and `pnpm validate:registry` also
pass; `validate:registry` reports release 0.1.0 with 8 contracts. Observed red
before green: the extraction suite first failed with `EXTRACTION_TRIAGE_REQUIRED`
because a `memory.extract` transaction could not read evidence at all, which is
what produced the evidence-gate decision in ADR 0016 §7 rather than a read path
around the gate; and the deferred-document case failed with
`MODEL_COST_BUDGET_EXCEEDED`, which is why a targeted promotion now takes the
full-extraction ceiling instead of a budget invented at the call site. The
daemon's independent verifier is authoritative.

The attributed finding `evidence-read-omits-triage-route` from
`evidence-ingestion-parsers-anchors-and-idempotency` is closed:
`GET /v1/evidence/{id}` returns `triage` with route, reason and decision time,
and yields `null` when no triage row exists, so evidence stays readable when
later processing has not run or has failed. The pipeline suite asserts both
states, including that the content hash is unchanged in the untriaged case.
