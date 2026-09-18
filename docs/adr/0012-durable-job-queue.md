# ADR 0012: Durable PostgreSQL job queue, leases and dead letter

Date: 2026-09-17
Status: Implementation decisions recorded before code

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1,
contract-uai-v0/rev-uai-v0-001, CRT-NFR-02-A, CRT-NFR-07-A, CRT-SEC-01-A. All
pinned contract and design pages were read with their revision pins. This ADR
records no deviation from the PRD section 28 reference stack: background work
runs on PostgreSQL, so no broker, no graph database and no separate vector
database is introduced. Earlier ADRs 0001 through 0011 stand unchanged.

The `jobs` entity is owner-scoped and lives in `migrations/0007_jobs.sql` with
forced row-level security, like every other owner table. A job carries its owner
scope, kind, payload, idempotency key, attempt count, attempt limit, lease owner,
lease deadline, status and last error. Uniqueness on (owner scope, job kind,
idempotency key) makes enqueue idempotent: a retried enqueue returns the first
job and writes no second row, and the same key with a different payload is
refused rather than silently reusing the earlier job.

Status is one of PENDING, RUNNING, SUCCEEDED, FAILED and DEAD_LETTER. A failed
attempt with budget left becomes FAILED and is runnable again; an attempt that
exhausts `max_attempts` becomes DEAD_LETTER and stays inspectable. The
application role holds SELECT, INSERT and UPDATE on `jobs` and no DELETE or
TRUNCATE privilege, so a dead-lettered job cannot be discarded through the
runtime credential. Job identity, owner scope, kind, payload and creation time
are immutable after insert, enforced by a trigger.

A claim takes the oldest runnable job with `FOR UPDATE SKIP LOCKED`: never
claimed, failed with attempts remaining, or RUNNING under a lease whose deadline
has passed. Claiming increments the attempt count and writes a new lease owner
and deadline, so a worker that stops mid-job strands nothing: the next worker
reclaims the job when the lease expires. Only the worker still holding a live
lease may report success or failure; a worker whose lease was reclaimed is
refused so it cannot overwrite the new holder's outcome. Stored evidence is
immutable, so a reclaimed attempt restarts from the same bytes and content hash.
An expired lease on a job with no attempt left cannot be reclaimed and its
worker can no longer report, so a claim first moves such rows of the owner
scope to DEAD_LETTER with the error `JOB_LEASE_EXPIRED` (added 2026-09-18);
the manual retry then applies as for any other dead-lettered job.

Claim, handler execution and outcome recording are three separate transactions.
A handler that fails with a database error aborts only its own work and never
takes the lease bookkeeping with it. `last_error` accepts only a stable code
matching `^[A-Z][A-Z0-9_:.-]{0,199}$`; a handler error that is not such a code is
recorded as JOB_HANDLER_FAILED, because provider and database error text can
carry owner content and the operations console must not display it.

Queue access is purpose-bound in row-level security as well as in the
application: reads require `ops.jobs.read` or `ops.dead_letter.read`, enqueue
requires `jobs.enqueue`, driving a job requires `jobs.work`, and a manual retry
requires `ops.dead_letter.retry`. A session under any other purpose sees zero
rows. A query under owner A's session returns none of owner B's jobs even with
the application filter omitted.

The operations surface is GET /v1/ops/jobs, GET /v1/ops/dead-letter and POST
/v1/ops/dead-letter/{id}/retry, each requiring the authenticated session, owner
scope, purpose and correlation id, and an idempotency key for the retry write.
Read responses carry queue depth, lease state, attempt counts and the recorded
error code, never the job payload. A manual retry returns the job to PENDING
with a fresh attempt budget and keeps its recorded error visible; it is refused
with 404 for a job that is not dead-lettered in the caller's owner scope. Every
call appends an audit event.

Scope boundary: this node delivers the queue, its operations routes and the
"Jobs and dead letter" screen. No job handler for extraction, projection rebuild
or connector sync is defined here; those belong to the nodes that own those
criteria, and their absence is not inferred to be complete.
