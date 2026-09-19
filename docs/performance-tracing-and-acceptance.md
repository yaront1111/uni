# Performance, tracing and acceptance scenarios

Assigned node: `performance-tracing-and-acceptance-scenario-suite`.
Goal: `goal-b2cc3b54-1876-401e-a6a2-527f99b679bc`.

This delivery implements the **performance panel in Metrics and cost** and the
**performance_measurements** entity. It adds no screen. Other pipeline entities
and screens are exercised through their existing services and tests.

## Assigned acceptance

| Criterion | Executable evidence |
| --- | --- |
| CRT-NFR-01-A | `packages/api/src/performance.test.ts`: real PostgreSQL, encrypted S3 storage, authenticated Fastify handlers, durable ingestion acknowledgements, a populated typed obligation projection and nonempty context packets. |
| CRT-NFR-05-A | `packages/api/src/answers.test.ts`, `[AC44.01]`: one correlation ID from ingestion through extraction, canonicalization, governed validation and commit, reduction, projection read, context assembly, answer composition, grounding and recording. The model gateway also emits generation duration and recorded provider cost. |
| CRT-PRJ-05-A | The same `[AC44.01]` test: two independently recorded statements support one proposition; reminder changes neither amount nor outcome; payment alone leaves the obligation unresolved; confirmation produces an accepted ILS 50 allocation and an accepted FULFILLED resolution, with ILS 10 unclassified. The inspector exposes both claims, support and resolution; every original evidence item remains readable. No status, gift, fee, tip or refund predicate is created. |
| CRT-QA-04-A | `scripts/test.mjs` checks the completed Vitest JSON results for every `[AC44.01]` through `[AC44.20]`. Every tagged case must pass; missing, skipped, pending, failed or todo cases fail the command. CI runs this same command and uploads its reports. |

The required command is `pnpm test`. The verified run on 2026-09-19 finished with
**864 passed, four existing optional live-connector skips, and 20/20 acceptance
scenarios passed**. `pnpm typecheck` also exited zero. No assigned acceptance
scenario is skipped. This is local execution of the CI command, not a claim that
a hosted CI run or the daemon's independent verifier has already completed.

## Load method and recorded result

Each operation runs 100 times at concurrency four, including the first request.
Durations use the monotonic clock and nearest-rank P95 (sorted sample 95 of 100).
Every attempt must succeed; failures are not filtered out. The run waits for all
workers to settle, then atomically records all three distributions. No model is
configured for the load run, and the test independently verifies zero model-call
records for its owner. Recording overhead is outside the timed operations.

The three operations use Fastify injection: authentication, authorization,
transactions, queueing on the session lock, encrypted object writes, reducers'
stored data, context policy evaluation and packet persistence are real. These
measurements exclude network transport and TLS handshake time; they do not
represent a WAN benchmark. The ingestion operations create 100 distinct evidence
items rather than replaying one idempotency key.

At 2026-09-19T15:02:33.861Z the recorded P95 values were:

| Operation | P95 | Strict target |
| --- | ---: | ---: |
| Evidence ingestion acknowledgement | 179.16 ms | <1000 ms |
| Typed projection read | 57.68 ms | <500 ms |
| Context packet assembly | 272.59 ms | <1500 ms |

`test-results/performance/load.json` retains the exact measurements and all
samples before the disposable test database is removed. Subsequent test runs
replace this artifact with their own measurements. The migration stores the
design's scenario, P95, sample count, LLM exclusion and timestamp, plus owner,
run ID, concurrency, samples, correlation ID and harness version for provenance.
Forced RLS and purpose-specific grants isolate the records; the immutable-row
trigger forbids updates and deletion. The isolation suite tests unfiltered reads
under two owners. Projection replay recreates the new migration too.

`GET /v1/ops/metrics` reads the latest recorded measurement per scenario inside
the requested window and audits those reads. The panel shows milliseconds,
strict target result, sample count, concurrency and timestamp. Missing data is
shown as not measured; exactly 500 ms fails the 500 ms target.

## Tracing

`@unai/observability` emits OpenTelemetry API spans, a low-cardinality duration
histogram and structured JSON logs. It explicitly constructs metadata fields;
it never spreads a request, response or exception into telemetry. Every stage
contains owner scope, correlation ID, monotonic duration, result, attempt/retry
state, code/component version and registry reference (or NOT_APPLICABLE).
Extraction retries take their attempt number from the durable job; phrasing
retries carry the model attempt. Provider cost is emitted only when available.
Exporter configuration belongs to the deployment's OpenTelemetry provider; the
service also emits its metadata as structured logs with no exporter installed.

The integration test captures spans at the OpenTelemetry provider boundary,
checks all stages and attributes and checks that none of the evidence text
appears in spans or logs. `test-results/performance/trace.json` contains that
metadata-only trace. A separate test checks the failure and retry path without
recording exception text. Telemetry sink failures do not cause committed work
to be retried.

## Twenty-scenario index

Tags identify behavioral tests, not placeholder assertions about file existence.
Some scenarios have multiple cases; the gate requires all of them to pass.

| §44 | Scenario | Test file under packages/ |
| --- | --- | --- |
| 1 | Daniel evolution | api/src/answers.test.ts |
| 2 | Separate obligation | memory/src/canonicalization.test.ts |
| 3 | Corrected amount | memory/src/canonicalization.test.ts |
| 4 | Target-less repayment | memory/src/resolutions.test.ts |
| 5 | Unattached owner write | api/src/corrections.test.ts |
| 6 | Failed overlay validation | api/src/answers.test.ts |
| 7 | Scheduled event | memory/src/resolutions.test.ts |
| 8 | Commitment, consideration, overdue and fulfillment | capabilities/src/projections.test.ts |
| 9 | Prediction resolution | memory/src/resolutions.test.ts |
| 10 | Late-arriving correction | memory/src/canonicalization.test.ts |
| 11 | Source conflict | capabilities/src/projections.test.ts |
| 12 | Entity ambiguity | memory/src/identity.test.ts |
| 13 | Instance merge | api/src/lineage.test.ts |
| 14 | Instance split | api/src/lineage.test.ts |
| 15 | AI hallucination resistance | api/src/answers.test.ts |
| 16 | Quoted-context consistency | memory/src/canonicalization.test.ts |
| 17 | Projection overlay | capabilities/src/projections.test.ts |
| 18 | Deletion cascade | api/src/control.test.ts |
| 19 | Prompt injection | api/src/security.test.ts |
| 20 | Packet lineage | api/src/answers.test.ts |

## Journey coverage and scope boundary

The full suite exercises all nine drawn journeys: J1 through connector, evidence
and control API tests; J2 through Today tests; J3 through Ask and its web journey;
J4–J5 through projections, corrections, lineage and the memory web journey; J6
through inbox and weekly-review tests; J7 through decisions tests; J8 through
control tests; and J9 through operations, metrics, audit and this load suite.
Existing accessibility and security checks remain in the full suite.

This node's acceptance is the four criteria above plus `pnpm test`. Real-account
connector validation, release operations and phase-exit checks remain their
sealed-plan owners' work. No phase-exit or product-release success is claimed,
and no repository check or independent verifier was removed or weakened.
