# Durable processing runtime

ADR 0038 joins acknowledged evidence to the existing extractor, canonicalization services, governor, projections, and Ask. An eligible source and its processing intent commit together. The API may acknowledge before a worker is available; the next worker dispatch recovers the durable intent.

Run migrations and publish the selected immutable registry release before starting the API and worker. Both use `UNAI_REGISTRY_RELEASE_ID` and `UNAI_REGISTRY_RELEASE`. `pnpm start:worker -- --check` validates configuration, database encryption, membership, and the pinned release without processing a job. `pnpm start:worker` runs the bounded owner-scoped loop; supervise that process with the deployment's normal service manager.

The worker requires:

- `UNAI_PROCESSING_OWNER_SCOPE_ID` and `UNAI_PROCESSING_ACTOR_ID`, naming an existing owner membership.
- `UNAI_PROCESSING_DATA_PURPOSE` and `UNAI_PROCESSING_MAXIMUM_SENSITIVITY`, explicitly limiting source access.
- `UNAI_APP_DATABASE_URL`, as a configured `secret://` handle, and `UNAI_DATABASE_CA_FILE` for verified database TLS.
- `UNAI_MODEL_PROVIDER`, `UNAI_MODEL_ENDPOINT`, `UNAI_MODEL_ID`, `UNAI_MODEL_API_KEY` as a secret handle, and the input/output microunit cost rates required by the existing gateway. There is no fallback model double.
- Optional `UNAI_PROCESSING_POLL_MS` (100–60000, default 1000).

Source timestamps and declared time zones remain separate from receipt, job, extraction, and projection times. An undated upload does not acquire today's assertion time. A relative deadline without a qualified original instant and zone stays unresolved. Re-reading, replaying, and retrying do not refresh a claim.

The first canonical path handles directly anchored first-person commitments. Model output remains provisional, with its source and extraction origin preserved. Unsupported frame types, ambiguous identity/instance matches, document authorship, clipped source text, and unresolved temporal expressions produce `NEEDS_REVIEW`; the source and extracted candidates remain available. A successful processing job means its durable stages completed, not that every extracted assertion is accepted or every source is understood.

Single-source evidence reads expose the processing stage, unresolved count, stable error code, and completion time. The operations queue exposes retries and dead letters. Three failed attempts require an explicit dead-letter retry through the existing operations API. Stage checkpoints and successful extraction reuse prevent retries from duplicating claims, model calls, governor commits, and projection receipts.

The API and worker are separate processes. No production service activation, private account access, or model-provider call is implied by the disposable API journey tests. Those tests replace only the model port and use the actual queue, database policies, encrypted object store, governor, projections, and Ask composition.

The same worker evaluates enabled initiative settings. The `/initiative` screen sets the owner's daily local time and time zone, selects a readable scheduled item and prerequisite, and manages notices and snoozed or disabled watches. The worker also checks authorized new evidence and deadline thresholds. Settings cannot exceed the worker's configured purpose or sensitivity ceiling. API settings use `settings.attention`; watch writes use `memory.correct`; watch and notice reads use `memory.read`, with an explicit data purpose and sensitivity ceiling.

Draft preparation needs the owner setting, a live `gmail.create_draft` permission, settled source support, and the existing action-policy ALLOW. Draft bodies are generic requests without copied private text or recipients. V0 sends nothing externally. Current notice reads discard completed, rescheduled, disabled, or snoozed situations; unchanged notices are not repeated, and budget-withheld items may return on a later owner-local day. Daily attention counts are shared with Inbox and Mentor, but simultaneous distinct requests can race that count. Duplicate initiative situations are serialized per owner; the cross-surface daily target is not an atomic quota.

On upgrade, migration 0031 recovers pending explicit document jobs already queued by older APIs. It preserves each job and its original permission/release context while restoring original evidence time and the extraction mode required by its triage route. It neither schedules unrequested documents nor refreshes undated documents from an old upload-time fallback.

## Items from connector syncs

ADR 0038 holds for connector syncs exactly as written. The owner confirmed this on 2026-11-06 (task-b00c772f): the ADR is not amended, and an opt-in per connector type was declined. Migration 0031's `triage_processing_intent` trigger fires on every triage decision recorded under the purpose `evidence.ingest` or `connector.sync`, so a synced item gets its intent in the same transaction that stored it. That is true of Sync now (`POST /v1/connectors/{id}/sync`) and of the worker's scheduled `connector.sync` job alike. Model spend per synced item is therefore the route budget below, with nothing further to opt into.

- **Gets an intent.** Any item triage routes `FULL_EXTRACTION` or `ENTITY_EXTRACTION`. The recorded row is `PENDING`, `run_kind` `FULL`, with no job and no run yet. Whether an item reaches either route is triage's rule (`docs/model-path-and-extraction.md`); a Gmail message with a first-person commitment (FULL), a Gmail message whose only signal is a known participant (ENTITY) and an Omi transcript within the ADR 0041 D4 size bound (FULL) are the cases the tests exercise.
- **Never gets one, so is never extracted automatically.** `SOURCE_ONLY` (a message that is only quoted history or empty), `INDEX_ONLY` (newsletters, routine CI notices), `DEFER_UNTIL_RELEVANT` (an Omi transcript over the D4 bound is one; only a document upload has a targeted trigger), anything authored by the ASSISTANT actor (Omi's structured summary), and `DOCUMENT` items, which have their own request path. Their evidence reads show `processing: null`, except a document whose upload requested extraction.

**When.** On a later worker turn, never in the sync request. Each turn first enqueues up to 20 pending intents, oldest first, then runs one `evidence.extract` job, and the loop sleeps `UNAI_PROCESSING_POLL_MS` (default 1000) before the next turn. A backlog therefore drains at roughly one job per turn.

- Only intents whose data purpose equals `UNAI_PROCESSING_DATA_PURPOSE` are dispatched, and only for items readable under that purpose and `UNAI_PROCESSING_MAXIMUM_SENSITIVITY` (`unai_private.evidence_access`, last replaced by migration 0021). Any other intent stays `PENDING` with no error and no job.
- Sync now records the web's pinned `PERSONAL_ASSISTANCE` purpose with a `RESTRICTED` ceiling (the platform proxy in `apps/web/pages/api/platform/[...path].ts`). A scheduled sync records the worker's own purpose and ceiling (`sync` in `packages/api/src/connector-sync-job.ts`). A worker whose purpose is not `PERSONAL_ASSISTANCE` therefore never extracts the items the owner pulled with Sync now.
- Synced items are stored at their connector's floor, `PRIVATE` unless the owner raised it (`docs/connectors.md`, Stored sensitivity). A worker with a `NORMAL` ceiling cannot read them and leaves their intents `PENDING`.
- Spend per run is bounded by the route: `ROUTE_COST_BUDGET_MICROUNITS` in `packages/extraction/src/triage.ts` (30,000 microunits for `ENTITY_EXTRACTION`, 110,000 for `FULL_EXTRACTION`) and `ROUTE_EXTRACTION_LIMITS` (input 8,192 and 32,768 bytes, output 1,024 and 4,096 tokens), under the model gateway's cost ceiling.

**Expected outcome per source.** Canonicalization turns a claim into a belief only when it is a first-person commitment (`I will ...`) and its asserting actor can be resolved: the owner for owner-authored items, or the sender of a Gmail message. Anything else stays an unresolved candidate claim and the item ends `NEEDS_REVIEW`; the job still ends `SUCCEEDED`.

- **Gmail.** A first-person commitment from the sender reaches `SUCCEEDED` with a `PROVISIONAL` proposition. A message routed `ENTITY_EXTRACTION` ends `SUCCEEDED` when it yields no unresolved claim.
- **Omi.** A transcript always ends `NEEDS_REVIEW`: its actor is the EXTERNAL `omi:transcript`, so no Omi claim gets an asserting entity (ADR 0041 D4), and the claim is anchored to its `TRANSCRIPT_SEGMENT`. The structured summary is never extracted (PRD §24.2).
- **Google Calendar and GitHub.** They take the same intent rule, but their actors are not resolved by canonicalization, so any claim they yield ends `NEEDS_REVIEW`. No test here syncs them.

**Proof.** Two database-backed cases in `packages/api/src/processing-runtime.test.ts` drive the web's exact Sync now request through the real connector runtime, with only the provider endpoints and the model as doubles: "Sync now records a PENDING intent in the sync transaction for every FULL or ENTITY item and none for SOURCE_ONLY or INDEX_ONLY items", and "the worker extracts synced Gmail and Omi items only under the data purpose the sync recorded". The first compares each intent's transaction with its triage decision's; the second runs the worker with another purpose (it claims nothing) and then the matching one.
