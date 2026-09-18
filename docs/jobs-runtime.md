# Durable job queue: implementation and remaining verification

Authority: contract-uai-v0 / rev-uai-v0-001, digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339;
design goal-b2cc3b54-1876-401e-a6a2-527f99b679bc@v1, read page by page with its
version and content-hash pins. Decisions are recorded in ADR 0012.

## Delivered surface and entity

The design entity `jobs` is implemented in `migrations/0007_jobs.sql`. The
designed screen "Jobs and dead letter" is implemented at `/ops/jobs`
(`apps/web/pages/ops/jobs.tsx`, `apps/web/components/Jobs.tsx`) with its six
drawn states: queue depth and lease state, a job retrying within its attempt
limit, a job at its attempt limit listed in the dead-letter list with its error,
a manual retry, an expired lease reclaimable by another worker, and evidence left
intact with an unchanged content hash after a worker was killed mid-job. No other
screen is added and no screen the design does not draw is invented.

The "Sign in and owner scope" screen keeps its signed-out, signing-in, expired,
refused, desktop and phone states and now also draws the owner scope selector
state: a labelled selector showing the single active personal owner scope, built
from the verified session with no new endpoint. The owner-sequence part of the
second-device state remains with the node that owns CRT-RYW-01-A and is not
claimed here.

The queue library is `packages/jobs`: `enqueueJob`, `claimJob`, `completeJob`,
`failJob`, `listJobs`, `listDeadLetterJobs`, `retryDeadLetterJob` and
`runJobAttempt`. Every function runs inside an authenticated owner transaction
from `packages/postgres`, so the actor, owner scope, purpose and correlation id
are carried on every statement. `runJobAttempt` separates the claim, the handler
and the outcome into three transactions and emits an OpenTelemetry span and an
attempt counter.

API routes are `packages/api/src/ops.ts`: GET /v1/ops/jobs, GET
/v1/ops/dead-letter and POST /v1/ops/dead-letter/{id}/retry, composed into the
production API in `packages/api/src/platform.ts` under the purposes
`ops.jobs.read`, `ops.dead_letter.read` and `ops.dead_letter.retry`. Read
responses expose queue depth, lease state, attempt counts and the recorded error
code; the job payload is never returned. The retry route requires an idempotency
key like every other write.

## Attempt limits, leases and the dead-letter list

`packages/jobs/src/index.test.ts` runs against real PostgreSQL. It observes a
handler that always fails being retried to its attempt limit and then appearing
in the dead-letter list with its error, a lease that expires being reclaimed by a
second worker while the killed worker can no longer report an outcome, a manual
retry returning a dead-lettered job to the queue where it then succeeds,
idempotent enqueue with a refused conflicting payload, and stored evidence whose
content hash is unchanged after a worker is killed mid-job.
`packages/api/src/ops.test.ts` observes the same behaviour through the HTTP
routes with their purpose, owner-scope, correlation-id and idempotency-key
refusals.

## Owner isolation

`jobs` has forced row-level security, `has_owner_access` on read, insert and
update, and purpose gating in the policy itself; the application role has no
DELETE or TRUNCATE privilege. `packages/postgres/src/isolation.test.ts` queries
`SELECT * FROM jobs` with no application filter under owner A's session and sees
only owner A's rows, sees nothing under an unrelated purpose, and sees nothing
for a non-member actor. `assertOwnershipCoverage` now classifies `jobs`, so a
future table without an ownership classification still fails the check.

## Reference stack

`packages/api/src/reference-stack.test.ts` asserts that no workspace package
declares a graph database, separate vector database or Redis dependency, that the
section 28 components are present (TypeScript monorepo, Fastify, Next.js, Zod,
PostgreSQL, pgvector, PostgreSQL-backed queue, S3-compatible storage, OpenTelemetry),
that every SQL migration is under Git and not ignored, and that ADR 0001 records
the no-graph, no-separate-vector-database decision.

## Not claimed here

No job handler for extraction, projection rebuild, connector sync, export or
deletion exists yet; those belong to the nodes that own those criteria. No
production deployment, worker supervisor process or scheduler is configured: a
deployment must run `runJobAttempt` on its own schedule with a worker identity
and lease duration. Node acceptance, phase exit and whole-product acceptance are
distinct, and the daemon's independent verifier remains authoritative.
