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
