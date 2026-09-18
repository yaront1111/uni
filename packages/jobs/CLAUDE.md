# packages/jobs

`@unai/jobs` owns the durable queue over the `jobs` table (`migrations/0007_jobs.sql`): the functions in `src/index.ts` that move a row through its lease, attempt and dead-letter states, plus the `runJobAttempt` worker turn. It must not own Zod schemas or DTO types (`packages/domain/src/jobs.ts`), HTTP routes (`packages/api/src/ops.ts`), audit rows or job handlers. The one handler lives in `packages/extraction/src/worker.ts` (`createExtractionJobHandler`, job kind `evidence.extract`); no worker process or scheduler exists in the repo yet (`docs/jobs-runtime.md`, "Not claimed here"). Decisions are in `docs/adr/0012-durable-job-queue.md`.

## Surface and consumers

- Every function except `runJobAttempt` takes an `OwnerTransaction` and never opens one; `runJobAttempt` takes the pool and a `RequestContext`. The library never calls `tx.audit`: the caller audits, as `ops.ts` does per route.
- `packages/api/src/ops.ts` is the only production consumer and uses only `listJobs`, `listDeadLetterJobs` and `retryDeadLetterJob`. `enqueueJob`, `claimJob`, `completeJob`, `failJob` and `runJobAttempt` are called only from tests: this package's `src/index.test.ts`, `packages/api/src/ops.test.ts` and `packages/api/src/extraction-pipeline.test.ts`.
- `JOB_PURPOSES` holds the five purpose strings for TypeScript callers, but nothing else imports it outside tests: the same strings are repeated as literals in the `0007` policies, in `packages/api/src/platform.ts` and in `apps/web`. `jobs.enqueue` and `jobs.work` are absent from the `purposes` set in `packages/api/src/platform.ts`, so they cannot arrive over HTTP; only in-process code can enqueue or work a job.
- Job ids come from `uuidV7` through the relative import `../../../src/kernel/identities.js`, one of the few links into the root `src/` lane.

## State machine

- `claimJob` takes the oldest row (`created_at,id`) of the owner that is `PENDING`, `FAILED`, or `RUNNING` with an expired lease, and that has `attempt_count<max_attempts`, using `FOR UPDATE SKIP LOCKED`. The attempt is counted at claim time, not at outcome time.
- `completeJob` and `failJob` go through `reportOutcome`, which matches only `status='RUNNING'`, the same `lease_owner` and a lease still in the future; otherwise it throws `JOB_LEASE_LOST`. `failJob` writes `DEAD_LETTER` when `attempt_count>=max_attempts`, else `FAILED`.
- `retryDeadLetterJob` is the only exit from `DEAD_LETTER`: back to `PENDING` with `attempt_count=0` and `last_error` kept. It returns `null` instead of throwing when the job is not dead-lettered in this owner scope, and `ops.ts` turns that into 404 `DEAD_LETTER_JOB_NOT_FOUND`.
- `SUCCEEDED` is terminal and rows are never deleted: `unai_app` has no DELETE or TRUNCATE on `jobs` (asserted in `packages/postgres/src/isolation.test.ts`).
- A worker that dies on its last attempt leaves the row `RUNNING` with an expired lease and `attempt_count=max_attempts`, which no claim or outcome can match. `claimJob` therefore first retires every such row of the owner scope, whatever kind the caller claims, to `DEAD_LETTER` with `last_error='JOB_LEASE_EXPIRED'`, where `retryDeadLetterJob` reaches it. Until the next claim in that owner scope, the row shows only as `queueDepth.expiredLeases`. That sweep is a plain `UPDATE`, so a concurrent claim waits on it for the length of the other claim transaction.

## Invariants a change must keep

- The CHECKs `jobs_lease_matches_status` and `jobs_lease_deadline` require both lease columns to be set exactly while the status is `RUNNING`. `reportOutcome` appends the lease reset to every outcome; a new transition must do the same. `jobs_dead_letter_is_explained` requires `last_error` and an exhausted budget before `DEAD_LETTER`.
- Every lease comparison uses the database's `statement_timestamp()`, never the worker's clock.
- The `job_update` trigger (function `unai_private.job_update`) raises `JOB_IDENTITY_IMMUTABLE` (SQLSTATE 55000) when id, owner scope, kind, payload, idempotency key or `created_at` change, and it sets `updated_at`. The library never writes `updated_at`, and the dead-letter list orders by it.
- `COLUMNS` excludes `payload`; only `claimJob` returns it, through `claimedJobSchema`. `publicJobSchema` is a strict object, so a new column means a new migration plus `COLUMNS`, `publicJob`, the domain schema and `jobFields` in `ops.ts`. The first test asserts that payload text never appears in the dead-letter list.
- The job kind, worker id, idempotency key and error-code patterns and the `max_attempts` range 1 to 10 exist twice: in `packages/domain/src/jobs.ts` and as CHECKs in `0007`. Changing one needs a new migration for the other.
- Library errors are `JOB_PURPOSE_REFUSED`, `JOB_ENQUEUE_REFUSED`, `JOB_IDEMPOTENCY_CONFLICT`, `JOB_LEASE_INVALID`, `JOB_LEASE_LOST` and `JOB_LIMIT_INVALID` (list limit outside 1 to 200). A malformed worker id, job id or kind surfaces as a raw `ZodError`, not as a code.

## runJobAttempt

It opens two transactions itself, claim and outcome. The handler runs between them with only the `ClaimedJob` and must open its own `withOwnerTransaction` for database work, so a failing handler cannot roll back the lease bookkeeping.

- There is no lease renewal. A handler that outlasts `leaseSeconds` (0 to 3600, else `JOB_LEASE_INVALID`) makes `runJobAttempt` reject with `JOB_LEASE_LOST`, and another worker may already be running the job again, so handlers must tolerate re-execution. `leaseSeconds:0` is legal and is how the tests simulate a killed worker.
- A handler reports a specific failure by throwing `new Error('SOME_CODE')`: the message is stored as `last_error` only when it matches `jobErrorCodeSchema`, and anything else becomes `JOB_HANDLER_FAILED`.
- The counter `unai.jobs.attempts` carries only the attribute `outcome` (`CLAIMED` or the resulting status), and the span `jobs.attempt` carries only the claimed flag, kind, attempt number and outcome status. Never add the payload or error text.

## Purposes

Purpose is checked twice: `requirePurpose` throws `JOB_PURPOSE_REFUSED` before any statement touches `jobs`, and the policies `owner_read`, `owner_enqueue` and `owner_drive` in `0007` call `unai_private.job_purpose`. Under a foreign purpose a SELECT returns no rows and an INSERT fails with 42501. `owner_read` lists all five purposes because enqueue, claim and retry all read rows back (`RETURNING` and the conflict lookup); ADR 0012 names only the two read purposes there, and the SQL is what holds. Adding or renaming a purpose means `JOB_PURPOSES`, a new migration that replaces the affected policies, and the root route checklist if the purpose is reachable over HTTP.

## Tests and traps

- Run `pnpm exec vitest run packages/jobs` from the repo root with `UNAI_TEST_DATABASE_URL` set to a privileged login on a throwaway pgvector server; no S3 is needed. The file applies `migrations/` itself through the cwd-relative `resolve('migrations')`, creates the login role `jobs_test_app` (a member of `unai_app`, because `withOwnerTransaction` refuses the privileged login) and seeds one user and owner scope.
- All tests share that owner scope and the queue is FIFO per owner, so each test uses its own `jobKind` and passes `jobKinds` to every claim that reaches the database (the claims without it are refused before any SQL). The idempotency tests leave a `connector.sync` and a `connector.backfill` job `PENDING`, which an unfiltered claim in a new test would pick up.
- The killed-worker test inserts a raw `source_items` row through the admin pool. A migration that changes `source_items` columns must update that INSERT, as `0008` had to.
- `enqueueJob` detects a conflicting retry in SQL with `payload=$4::jsonb`, never by comparing JSON text: `jsonb` returns keys in its own order, so a text comparison refuses a legitimate multi-key retry. jsonb equality is also numeric, so `1` and `1.0` are the same payload.
- `packages/api/src/reference-stack.test.ts` requires this `package.json` to declare `pg`, `@unai/postgres` and `@opentelemetry/api`, and fails when any workspace manifest declares a dependency whose name matches its graph-database, vector-database or `redis` pattern. Other broker packages are not in that pattern, so the test alone does not guard the no-broker decision of ADR 0012.
