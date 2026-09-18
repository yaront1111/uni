# packages/model

`@unai/model` owns the provider-independent LLM gateway and its provider
adapters, and nothing else: no prompt library, no extraction logic, no
scheduling, no database credential of its own. Schema lives in
`migrations/0011_triage_extraction_and_model_calls.sql` (`model_call_records`);
the decisions behind it are ADR 0016 §6 and the delivery report is
`docs/model-path-and-extraction.md`.

## Surface and consumers

- `createModelGateway({provider, recordCall, clock?})` returns the one entry
  point for a model call. `invoke` takes the caller's Zod schema and returns
  parsed data or throws; it never returns unvalidated text.
- `recordCall` is a transaction opener the caller supplies, and it must open
  under `model.call` — the only purpose the `model_call_records` insert policy
  admits. It is deliberately *not* the caller's own transaction: a call that
  failed or was rejected still spent money, and its row must survive the rollback
  of the work it was serving.
- `resolveConfiguredModelProvider({secrets, env})` builds the configured adapter.
  Configuration is `UNAI_MODEL_PROVIDER`, `UNAI_MODEL_ENDPOINT`, `UNAI_MODEL_ID`,
  `UNAI_MODEL_API_KEY` (a `secret://` handle, ADR 0013),
  `UNAI_MODEL_INPUT_MICROUNITS_PER_1K` and `UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K`.
- Runtime dependencies are `zod`, `@unai/domain` and `@unai/secrets`. `uuidV7`
  comes from `../../../src/kernel/identities.js`, as elsewhere.

## Invariants a change must keep

- **Nothing provider-specific leaves this package.** Endpoints, request bodies,
  response shapes, header names and pricing live in `providers.ts` and nowhere
  else. `gateway.test.ts` parses every file in `packages/domain/src` and fails if
  one names a provider, a model or an SDK (CRT-NFR-06-A).
- **Every call is recorded, in all three outcomes.** `SUCCEEDED`,
  `OUTPUT_REJECTED` and `PROVIDER_FAILED` each write a row with model, prompt
  version, cost, latency and correlation id. Never skip the row on a failure
  path; that is the path that most needs it.
- **A row carries accounting only.** No prompt, no response, no provider message,
  no credential, no owner content. A provider error is reduced to a stable code
  before it crosses this boundary, because an error body can quote the prompt.
- **Invalid output is rejected whole.** Never harvest the valid half of a
  response that violated its schema, and never repair one.
- **The cost budget is a ceiling, not an estimate.** `maxCostMicrounits` must be
  positive; an overspend is recorded and then refused, so the money is on the
  books even when the answer is discarded.
- An endpoint that is not HTTPS is refused at construction: a prompt carries
  owner content.

## Running these tests

`gateway.test.ts` needs the harness — run `pnpm test`, or export
`UNAI_TEST_DATABASE_URL` for a throwaway, already-migrated pgvector server. It
creates the `model_test_app` LOGIN role when absent. No `UNAI_TEST_S3_*` and no
network: the adapter tests inject `fetch`, and the gateway tests use in-test
provider doubles.

## Traps

- `registerModelProvider` refuses an id that already exists, so a deployment
  adapter can never shadow a delivered one. It mutates a module-level registry;
  a test that registers an id cannot register it again in the same process.
- Adding a purpose that may write `model_call_records` needs a new migration:
  the policy's purpose list is a literal inside an applied file.
