# ADR 0045: Session liveness is re-checked at commit, not locked for the whole request

Date: 2026-11-05

Status: Accepted. Changes the concurrency guarantees of ADR 0008's sessions at
the API's `deviceWork` boundary; recorded before the code (PRD §0 rule 7).

## Context

(a) `deviceWork` (`packages/api/src/platform.ts:189-199` at 477f046) takes
`SELECT id FROM auth_sessions ... FOR UPDATE` as its first statement and holds
it to COMMIT, so every data route of one session runs one at a time.
task-be2a16f3's repro measured 73 waits on that statement: 384 s in total, max
20 s. They turned single slow statements into runs of test timeouts. A caller
that gives up does not stop the handler, so an abandoned request keeps the row
locked too.

(b) Every revocation waits behind those holders. `auth_revoke_session`
(`migrations/0002_authentication.sql:104-116`) and the
`revoke_disabled_sessions` and `revoke_removed_device_sessions` triggers
(`:117-130`) all UPDATE `auth_sessions.revoked_at`.

(c) The same lock lets a sign-out deadlock with in-flight work:

- `auth_revoke_session` locks the user row `FOR UPDATE` (`:111`), then updates
  the session row (`:112`);
- the in-flight request already holds the session row;
- its audit insert needs `FOR KEY SHARE` on the same user row, through
  `audit_events.actor`'s foreign key (`migrations/0001_foundation.sql:50`).

(d) `POST /v1/devices` reads and writes `auth_sessions.device_id` in one
transaction. It relies on per-session serialization so that a retry returns the
device the first attempt bound (`docs/foundation.md:61`).

## Decision

1. Ordinary transactions read the live row twice, with the same predicate
   `id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp()`:
   - a plain read as the first statement (fail fast, no lock);
   - `FOR SHARE` as the last statement before COMMIT.

   Either miss throws `SESSION_EXPIRED` and the transaction rolls back.
2. `FOR SHARE`, never `FOR KEY SHARE`. Every revoking UPDATE takes
   `FOR NO KEY UPDATE` on the row, which conflicts with `FOR SHARE` but not with
   `FOR KEY SHARE`.
   - A revocation that starts inside a commit window waits for that COMMIT.
   - A commit-point check that meets an uncommitted revocation waits for it.
     Under READ COMMITTED it then re-reads the row and finds it revoked.
   - Nothing is locked after the share lock, so it cannot close a lock cycle.
3. `POST /v1/devices` and `POST /v1/devices/{id}/revoke` write their own session
   row: `device_id`, and `revoked_at` through the device trigger when the caller
   removes its own device.
   - They take `FOR NO KEY UPDATE` as their first statement and hold it to
     COMMIT.
   - They skip the commit-point check, which would refuse the caller's own
     removal.
   - A share lock that the same transaction later upgrades would deadlock
     against a concurrent same-session upgrader, such as a registration retry.
     `FOR NO KEY UPDATE` is the lock their UPDATE takes anyway.
4. `SESSION_EXPIRED` reaches the client as 401
   `{code:'SESSION_EXPIRED', correlationId}` instead of 500 `INTERNAL_ERROR`. The
   web proxy already answers that code for a missing session, and
   `apps/web/lib` already treats an API 401 as an expired session.

## Guarantees

- Revocation (sign-out, sign-out-all, user disablement, device removal):
  - No request work under a session commits after that session's revocation
    has committed.
  - In-flight requests are no longer waited for. One that reaches its commit
    point afterwards rolls back with 401 `SESSION_EXPIRED`; one already inside
    its commit window commits first.
  - A revocation now waits only for commit windows and for the two device
    routes.
- Expiry is checked at both points, so a transaction that crosses `expires_at`
  rolls back. Before, it committed.
- Registration is unchanged. It serializes per session, a retry waits and then
  returns the session's existing device, and changed input is refused with 409.
- Same-session requests now run concurrently. Nothing else relied on their
  serialization: two sessions of one owner were always concurrent, so
  owner-level state carries its own locks (the `voice_settings` row, the
  conversation row, belief transaction rows, the evidence advisory lock,
  connector rows).

## Consequences and known limits

1. A request whose session is revoked mid-flight has already done its external
   effects (object write, provider read, model call). Its rows roll back, as on
   any late failure. A reply that a route sends from inside its transaction (a
   4xx) can precede that rollback.
2. Pre-existing and unchanged here: registration or own-device removal racing a
   sign-out of the same user can still deadlock.
   - Those routes hold the session row and then need `FOR KEY SHARE` on the
     user row.
   - `auth_revoke_session` holds the user row `FOR UPDATE` and waits for the
     session row.
   - PostgreSQL aborts one of them after `deadlock_timeout`. Two devices
     removing each other at the same instant can also deadlock.
   - Follow-up candidate: `auth_revoke_session` takes `FOR NO KEY UPDATE` on
     `users`, in a new migration. That lock still conflicts with
     `auth_create_session`'s `FOR UPDATE` and with other revokers, but not with
     a foreign key's `KEY SHARE`.
3. Share lockers do not queue behind a waiting UPDATE, so a revocation also
   waits out every commit window that opens on the session while it waits. Each
   window is one statement and the COMMIT.

## Proof

`packages/api/src/session-concurrency.test.ts`
(task-52fb45936b3348ffbe8512ea2a9d07d5): a held request does not stall a second
one on its session; a sign-out and a device removal each commit while a request
is in flight, which then rolls back with 401 and leaves no rows; a request
reaching its commit point during an uncommitted revocation waits and rolls
back; registration and its retry serialize against same-session reads with one
device and no deadlock.
