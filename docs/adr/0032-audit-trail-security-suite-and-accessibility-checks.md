# ADR 0032: The audit trail, the CI security suite and the accessibility checks

Date: 2026-09-19
Status: Accepted
Node: `accessibility-audit-trail-and-security-test-suite` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-SEC-04-A, CRT-SEC-05-A, CRT-SEC-07-A, CRT-SEC-08-A, CRT-SEC-10-A,
CRT-UX-14-A.

Recorded before the implementing change, per PRD §0.7. The branch carries master
through the goals, decisions and mentor node (migration 0026, ADR 0031), so this
ADR is 0032 and its migration is 0027.

## 1. `audit_events` gains its kind and its decision reference, and refuses change for every role

The design draws `audit_events` with `event_kind` (read, write, projection
rebuild, export, deletion, external action) and `policy_decision_id`. Migration
0001 created the table without either and made it append-only by grant alone.

Migration 0027 adds both columns. Existing rows are backfilled from their
purpose; `event_kind` is then `NOT NULL` with a `CHECK`, and `policy_decision_id`
references `policy_decisions(owner_scope_id,id)`. The kind is named on every row
the owner transaction appends: a route may state it, otherwise the API boundary
derives it from the purpose and the HTTP method (`auditEventKindFor` in
`@unai/domain`). Four purposes fix their kind outright (`memory.project`,
`data.export`, `data.delete`, `action.execute`); a GET is a read; otherwise a
listed read purpose (the Context Broker, Ask, inspection) is a read and the rest
write. A row a definer function appends (sign-in, sign-out) gets the kind from a
`BEFORE INSERT` trigger running the same rule in SQL
(`unai_private.audit_event_kind`); a test asserts the two rules agree on every
purpose the platform admits.

A `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger
raise `AUDIT_EVENT_IMMUTABLE` (SQLSTATE 55000) for every role, the migration
principal included. `unai_app` is still refused earlier by privilege (42501), which
the isolation suite already asserts. Dropping or adding a column is DDL and is not
governed by the row trigger, which keeps the projection replay test's teardown
possible.

Rejected: a new `audit_events_v2` table (history would split across two tables);
making `eventKind` a required field of every `tx.audit` call (94 call sites would
restate what the purpose and method already say, and a missed one would be a
compile error far from the rule).

## 2. Projection rebuilds are audited where they are run

`@unai/memory` and `@unai/capabilities` never audit on their own behalf (their
`MemoryTransaction` has no `audit`). The API audits each rebuild it runs, under
the rebuild's own purpose `memory.project`: the typed-projection replay after a
deletion, the rebuild after a merge or split, and the decision projection write.
The `uai registry projection-replay` CLI already audited its replay. Each event
names the `projection_rebuild_receipts` (or `decision_projection` rows) and the
reducer version as its code version.

## 3. The Audit log is read-only in the application, and an attempt to change it is itself recorded

`GET /v1/audit-events` (purpose `audit.read`) filters by object (type and id
together, by JSONB containment), actor, purpose, kind and time window, newest
first, with a `createdAt|id` cursor at microsecond precision. Reading the log is
itself audited as a read of the events it listed.

`PUT`, `PATCH` and `DELETE` on `/v1/audit-events/{id}`, and every non-GET method
on the collection, exist only to refuse: 405 `AUDIT_EVENT_IMMUTABLE`, `Allow:
GET`, and a REFUSED/DENY event (kind WRITE, or DELETION for a DELETE) that names
the targeted event when this owner can see it. They run under `audit.modify`, a
purpose admitted at the boundary for that reason alone. This is how the design's
state "Attempted update or delete of an audit event refused by the application"
exists: as a recorded fact the Audit log shows, not as a control on the screen.

## 4. Encryption at rest is enforced as configuration the runtime refuses to start without

PostgreSQL cannot observe whether its volume or managed service is encrypted.
The deployment declares it on the database, as the operator who provisioned the
encrypted storage (`ALTER DATABASE … SET unai.encryption_at_rest =
'volume-kms:<key reference>'`; also `tde:` or `managed:`), and the API refuses to
start (`DATABASE_ENCRYPTION_AT_REST_REQUIRED`) against a database that declares
nothing recognisable. This is a guard against deploying onto an unencrypted
database by mistake, not proof of encryption; ADR 0002's requirement for provider
evidence stands. The object store needs no declaration: `@unai/storage` already
verifies the bucket's SSE-KMS default at startup and the encryption receipt of
every read and write (ADR 0005); the suite adds an independent `HeadObject` check.

## 5. The security suite is three database-backed files in the one CI run

`packages/api/src/security.test.ts` holds one test per case CRT-SEC-10-A names,
`transport.test.ts` holds CRT-SEC-08-A and `audit.test.ts` CRT-SEC-07-A. They run in
`pnpm test` like every other database suite, over the real boundary, owner
transaction, row-level security, Context Broker, grounding validator, connector
runtime, secrets manager and Gmail client. The only doubles are the provider's HTTP
endpoint (a stubbed `fetch` serving Gmail's two read endpoints) and the models.

The injection scenarios use models that *obey* the injected instruction -- an
extractor answering with tool calls, grants and deletions, an answer phraser
asserting the financial context -- because a well-behaved model proves nothing.
What must hold is that nothing they say is acted on or shown. The obeying
phraser's refused words are still stored as the owner's own assistant conversation
evidence (ADR 0026, CRT-AI-01-A), marked with the grounding outcome that refused
them; the suite asserts that this record is the only place they exist.

Raw object keys are checked by sweeping every GET route the API registers,
discovered from the route modules' source so a later route is swept without
editing the test, plus the writes that answer with evidence. The route-to-purpose
chain moved out of the preHandler into the exported `routePurpose` so the sweep
declares exactly the purpose each route admits.

Scope note: an export's declared sensitivity ceiling binds its evidence (ADR 0030);
canonical memory is exported whole to its owner. The cross-scope test asserts the
former and does not claim the latter.

## 6. Accessibility is checked in a real DOM with axe-core and a keyboard-only user

The web app has no browser in its test setup (`renderToStaticMarkup` only). The
accessibility suite adds two development dependencies, `axe-core` and `jsdom`, and
renders each core view with React's client renderer into a jsdom document (the
vitest `jsdom` environment for that one file). axe-core runs all its WCAG 2 A/AA
and best-practice rules except colour contrast, which needs a layout engine; a
critical or serious violation fails the suite.

The keyboard-only walkthrough is a modelled user (`components/testing/keyboard.ts`)
with no pointer: sequential focus order as a browser computes it, typing, and
Enter/Space/Arrow Down with each element's native default action. A control only a
mouse can reach is unreachable to it. Each core task of Today, Ask, Commitments,
Weekly Review, Memory Inspector and Memory Inbox (and the Audit log) is completed
this way; the transcript and the axe summary are written to
`test-results/accessibility/`, which CI uploads as the required artifact.

Rejected: Playwright with a real browser. It would need a browser download in CI
and in the daemon's verifier, and a running TLS web server with a signed-in
session against the API; the modelled user covers the same keyboard semantics for
server-rendered pages whose interactive elements are all native controls, which a
static check of the component sources also enforces.

`pages/_document.tsx` is added so the served document declares `lang="en"`
(WCAG 3.1.1); the suite reads the language from that file rather than assuming it.
