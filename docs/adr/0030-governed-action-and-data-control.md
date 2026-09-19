# ADR 0030: Governed action, the Permissions surface, export and the deletion cascade

Date: 2026-09-19
Status: Accepted
Node: `drafts-actions-permissions-export-and-deletion-workflow` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-AI-04-A, CRT-CON-08-A, CRT-NFR-04-A, CRT-SEC-06-A, CRT-SEC-11-A,
CRT-UX-09-A, CRT-UX-13-A.

Recorded before the implementing change, per PRD §0.7 and §46. ADRs 0001–0026
and every delivered slice before this one were inspected and retained. The
branch was brought up to master (`11869e1`), which carries this node's
dependency `connector-capabilities-required-connectors-and-lifecycle`; the other
dependency, `web-shell-labels-today-briefing-and-ask-surface`, had not landed on
master when this work started, so the screens below use the delivered page
conventions (`Navigation`, the same-origin proxy) rather than a shell that did
not yet exist.

## 1. One package, `@unai/control`, owns the new tables

Drafts, recommendations, the action history, plugin capability grants, the
owner's settings, export and erasure are one surface in the design (journeys J1
and J8), and none of them belongs in a package that already has an owner:
`@unai/connectors` produces evidence and nothing else, `@unai/context` writes no
canonical row, and `@unai/api` must not own SQL for another package's tables.
The package follows the others: pure functions over an `OwnerTransaction` the
caller opened, no route, no pool.

## 2. The draft capability is a plugin capability, not a connector scope

ADR 0023 §2 made a granted connector write capability unrepresentable and left
the draft path to this node: "draft creation is the one external write V0
contemplates, and PRD §27.5 puts it behind explicit permission and
`EvaluateMemoryAction` rather than behind a connector grant".

So a new table, `plugin_capability_grants`, holds Uai's own plugin capabilities
(PRD §27.1) one row per discrete capability, exactly as ADR 0023 §1 does for
connectors. The V0 catalog is:

| Capability | Access | Risk | Grantable in V0 |
| --- | --- | --- | --- |
| `gmail.create_draft` | DRAFT | MEDIUM | yes — the one draft |
| `calendar.create_draft` | DRAFT | MEDIUM | yes |
| `gmail.send` | WRITE | HIGH | never |
| `calendar.create` | WRITE | HIGH | never |
| `calendar.update` | WRITE | HIGH | never |
| `finance.move_money` | WRITE | HIGH | never |
| `trading.submit_order` | WRITE | HIGH | never |

`CHECK(NOT(granted AND access_kind='WRITE'))` makes a granted external write
unrepresentable here too, so the Permissions screen can list the write
capabilities with their risk class and say "refused in V0" without any code path
able to grant one. A draft is a Uai artifact: nothing is written to Gmail or
Calendar, and no provider scope is requested.

## 3. A draft exists only when the capability is granted *and* EvaluateMemoryAction allows it

`POST /v1/drafts` reads the grant row first (refused `DRAFT_CAPABILITY_NOT_GRANTED`
with the capability named), then asks the Context Broker for the packet the draft
rests on with `intendedAction = {actionKind: DRAFT, capabilityGranted: true}`.
The broker already evaluates `EvaluateMemoryAction` against the evidence *that
packet* rests on and records the verdict in its own transaction (ADR 0022 §10).
Only an `ALLOW` creates the draft; a `DENY` is `403 DRAFT_POLICY_DENIED` and a
`REQUIRE_CONFIRMATION` is `409 DRAFT_CONFIRMATION_REQUIRED`, each naming the
recorded `policy_decisions` row. "Allows it" is read literally: a confirmation
requirement is not an allowance (CRT-CON-08-A). The `drafts` row names that
decision (`policy_decision_id NOT NULL`), so a draft without a recorded ALLOW is
unrepresentable.

## 4. External actions are refused by the port, every time, with a record

`POST /v1/actions/execute` accepts `EMAIL_SEND`, `CALENDAR_CREATE`,
`CALENDAR_UPDATE`, `MONEY_MOVEMENT` and `TRADE`. Each is put to
`EvaluateMemoryAction` (calendar create and update as `CALENDAR_WRITE`), the
verdict is recorded, and the answer is `403 EXTERNAL_ACTION_REFUSED` with the
port's reason (`EXTERNAL_ACTION_REFUSED_IN_V0` under the local adapter) and the
decision id. No route, job or package here calls a provider write API. The
port is asked with the actor, the action purpose, the declared risk, the kind
and whether a capability for it is granted (never, in V0); its V0 rule refuses
every non-draft kind before support is considered, so no quality of memory can
turn a refusal into an execution.

## 5. The six action-history stages, and why a draft can never be "executed"

`action_history.stage` is one column with the six values of the design, so an
entry is exactly one of them (CRT-UX-13-A). The schema enforces the rest:

- `EXECUTED` and `RECEIVED_CONFIRMATION` require `receipt_evidence_id`, an
  existing evidence row of source type `TOOL_RECEIPT`;
- an entry whose subject is a draft may only be `DRAFTED` or
  `REQUESTED_APPROVAL` — `CHECK(subject_object_type<>'draft' OR stage IN
  ('DRAFTED','REQUESTED_APPROVAL'))` — so no code path, now or later, can label a
  draft executed;
- the table is append-only: the application holds no UPDATE or DELETE grant,
  and a trigger refuses an UPDATE even from the migration principal.

`drafts.status` has no executed value at all: CREATED, AWAITING_APPROVAL,
APPROVED, DISCARDED. Approving a draft records approval and nothing else.

## 6. Recommendations are RECOMMENDED, and "prepare, don't submit" is intent to prepare

`recommendation_artifacts.semantics` is `CHECK(semantics='RECOMMENDED')`; the
row is never a proposition, never a claim and never user intent (PRD §24.2,
§60). The owner's reply is one of `NONE`, `ACCEPTED_AS_INTENT_TO_PREPARE`,
`DISMISSED`, `SNOOZED`. "Yes, prepare the order but do not submit it" is stored
as evidence (the owner's exact words, through the same evidence ingest every
statement uses) and as `ACCEPTED_AS_INTENT_TO_PREPARE`, plus a `SUGGESTED`
history entry for the recommendation and a `REQUESTED_APPROVAL`-free trail:
nothing about the reply creates an `EXECUTED` entry, a claim, or an
executed-order fact.

Only `POST /v1/actions/receipts` creates execution facts: it ingests the tool's
receipt as `TOOL_RECEIPT` evidence (the raw bytes stored and anchored like any
other item) and appends `EXECUTED` and `RECEIVED_CONFIRMATION` entries naming it
(CRT-AI-04-A).

Every recommendation is evaluated at creation through the broker with a DRAFT
declared as its intended action -- preparing is the one step V0 can take on a
recommendation, and a recommendation asks nothing of a plugin, so the capability
question is answered true. At the recommendation's own risk, a DENY (for a
HIGH-risk one, memory that is only PROVISIONAL, CONTESTED or from an incomplete
projection) stores it `BLOCKED` with the reason and the decision id, and it can
then be dismissed but never accepted; a REQUIRE_CONFIRMATION stores it ACTIVE
with `requires_confirmation` set (CRT-SEC-11-A). Declaring the recommended kind
itself would not work: the port refuses every non-draft kind outright, so every
TRADE recommendation would be blocked whatever its memory said.

## 7. The owner's settings are rows, read by the next operation

- `attention_budgets` is the memory inbox's (migration 0023, ADR 0029 §5): the
  Permissions view reads it under `settings.attention` and the screen changes it
  through `PATCH /v1/settings/attention-budgets`. Every interruption decision
  reads it in its own transaction, so a change applies to the next one. (An
  earlier draft of this node created its own table; the merge with master
  replaced it with that one.)
- `retention_settings`: per source type, raw retention days and derived-data
  retention days (null = keep). `POST /v1/data/retention/cleanup` erases every item
  past its source type's raw retention through the same cascade as a deletion,
  so a changed setting is what the next cleanup run applies.
- `domain_sensitivity_settings`: per connector source type, the level stored
  items get. ADR 0023 made the manifest default a floor that a request cannot
  lower and left "an explicit per-connector consent action on the Permission
  management surface" to this node: the setting *replaces* the floor for items
  stored after the change and never rewrites a stored row (§42). Both a sync and
  an upload read it.
- plugin capability grants (§2) and the connector grants of ADR 0023, both
  changed from the same screen.

Every change is audited (PRD §30.6) with field names only.

## 8. Deletion is a tombstone plus erasure, not a row rewrite

PRD §30.7 lists what a permanent deletion must remove *or invalidate*; the
design gives `source_items` and `evidence_object_keys` a `deleted_at`. Deleting
the evidence row outright is impossible without also deleting history that is
not the item's (overlay deltas, memory operations and answer manifests name it
by foreign key). So:

- `source_items` keeps a tombstone: `deleted_at` set, and every content-bearing
  column erased — metadata and actor to `{}`, occurred and parent to null,
  external id, idempotency key and content hash to values derived from the row id
  alone (so a later re-ingest of the same content is a new item, not a hit on the
  tombstone). The row policies already hide `deleted_at IS NOT NULL`, and every
  anchor, triage and object-key policy reads through that row.
- The raw object is deleted from object storage in the same transaction, after
  the database erasure, so a storage failure rolls the erasure back rather than
  leaving a row that promises bytes that are gone. `evidence_object_keys` gets
  `deleted_at` (the cryptographic-deletion target of the design).
- Deleted outright, because they are derivatives of the item: its anchors
  (parsed content and the lexical document index), triage decision, extraction
  runs and their model-call and match-candidate rows, ingestion receipts,
  aliases sourced from it, its claims and everything that names them (support,
  relations, roles, resolution assertions, thread memberships, embeddings), and
  every proposition left with no claim and no support — iterated to a fixpoint,
  so a derived belief whose inputs are all gone goes too, with its assessments,
  fingerprints, lineage, dependencies and embeddings.
- Erased in place, because the row is someone else's history: the overlay
  delta's `raw_text` when it quotes the item, the operation `payload` of any
  belief transaction naming a deleted object, and the `packet`/`request` of any
  stored context packet naming one. The immutability triggers of those tables
  gain one branch each that admits exactly that erasure under `data.delete` and
  nothing else.
- `memory_summaries` (the design entity, created here) rows naming a deleted
  object are deleted.
- The typed projections are replayed from canonical memory after the erasure,
  and the rows of the affected frames are removed first, so no projection row
  outlives its support.

The whole cascade is one SECURITY DEFINER function,
`unai_private.erase_evidence(owner, evidence)`, callable by `unai_app` and
refusing unless the caller has live access to that owner scope and declared the
purpose `data.delete`. It is bounded to one evidence item of one owner, has no
dynamic SQL, and returns counts and identifiers. The request is recorded in
`retention_and_deletion_requests` with a `cascade_receipt` of *counts* only, and
the audit event lists object ids and field names — never a value, excerpt or
object key (CRT-SEC-06-A). Under `data.delete` the application may additionally
*read* `source_items` and `evidence_object_keys` (tombstones included), which is
what the storage resolver needs to delete the raw object after the erasure.

Rejected: purpose-gated DELETE policies on every table the cascade touches (the
pattern `memory.project` uses on the projections, migration 0016). It would have
given `unai_app` a DELETE grant on claims, propositions, anchors and the other
canonical and evidence tables, and the isolation suite asserts — for good reason —
that the application role can delete from none of them under any purpose. ADR
0009 rejected a *broad* definer role; this is one narrow function in the same
shape as the delivered definer readers (`evidence_labels`,
`anchor_evidence_scope`), and the isolation suite asserts it refuses another
owner and any other purpose.

## 9. Export reads everything the owner owns, and embeddings are regenerable

`POST /v1/export` runs under `data.export`, which gets owner-scoped SELECT
policies on the evidence and canonical tables, bounded by the declared
sensitivity ceiling on `source_items`. The bundle holds, per live evidence item,
its metadata, anchors and raw bytes (base64), and the canonical memory objects:
entities, frame instances and roles, slots, propositions, claims, assessments,
support, resolution assertions, links, threads and summaries. It never holds an
object-store key, a session, a secret or a job payload. The request is recorded
with counts and an audit event.

`POST /v1/memory/embeddings/regenerate` optionally deletes the owner's embeddings
(under `memory.reindex`, through the definer `unai_private.drop_semantic_index`,
so `memory_embeddings` stays undeletable by the application role) and then
re-indexes every live claim under `memory.govern` with the pinned embedder of
ADR 0024. Because that embedder is deterministic, regeneration restores the same
vectors and therefore the same semantic search results (CRT-NFR-04-A).

## 10. Screens

Action history, Draft approval, Recommendation detail, Permissions and
integrations, and Export and delete my data — the five screens the design draws
for this node, and no other. The proxy gains the new write paths with their
purposes; the two settings routes are PATCH, as drawn, and the proxy admits
PATCH for exactly those two paths.
