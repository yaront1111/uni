# ADR 0017: The write governor — belief transactions, the support graph, and the local policy ports

Date: 2026-09-18
Status: Accepted. Implementation choices recorded before code.

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1 — entities
`belief_transactions`, `belief_transaction_operations`, `belief_assessments`,
`belief_support`, `derived_proposition_dependencies`, `policy_decisions`;
components "belief-transaction-service-propose-validate-atomic-idempotent-commit-and-receipts",
"belief-assessment-engine-with-append-only-recorded-time-versions",
"support-and-contradiction-graph-with-independence-groups-and-circular-support-rejection",
"derived-proposition-dependency-tracker-with-unsupported-transition",
"local-policy-adapters-evaluate-memory-write-read-and-action" and
"admission-mode-engine-source-only-index-only-auto-claim-auto-accept-auto-provisional-batch-review-and-just-in-time";
`POST /v1/memory/transactions/propose`, `/{id}/validate` and `/{id}/commit`;
contract-uai-v0/rev-uai-v0-001 CRT-AI-02-A, CRT-MEM-01-A, CRT-MEM-12-A,
CRT-MEM-12-B, CRT-MEM-13-A, CRT-REG-06-B, CRT-WRT-02-A, CRT-WRT-02-B,
CRT-WRT-03-A, CRT-WRT-04-A; PRD §14, §15, §19, §29.3, §33.7, §33.9, §42.
Extends ADR 0004 (applied migrations are immutable), ADR 0006 (a commit receipt
is the only durable evidence of work), ADR 0011 and ADR 0014 (the registry
snapshot is global, immutable and reachable only through a reviewed reader),
ADR 0015 (placeholder transaction references, the release pin without a foreign
key) and ADR 0016 §7 (a reader passes the evidence gate rather than around it).

This node implements no screen of its own. It underlies states of the **Memory
inspector** another node draws — "Inferences with their recorded dependencies",
"Derived belief shown as UNSUPPORTED after all its inputs were invalidated",
"Current belief with its assessment status", "Historical timeline over valid time
and recorded time" — and adds the three governed write routes the design already
specifies.

Nine decisions below are where the code chooses among readings the PRD and the
design leave open, or departs from a literal column list.

## 1. Registry presence is answered by a reviewed boolean reader, not by a join

CRT-MEM-01-A requires the governor to refuse an `ACCEPTED` assessment whose
predicate or frame type is absent from the pinned release. The registry snapshot
(`registry_releases`, `registry_contracts`) is global reference data with forced
RLS, no policy and no application privilege — ADR 0011 put it there and ADR 0014
opened exactly one reviewed definer window onto it, returning bounded metadata
under `ops.registry.read`.

Two ways out were available: grant the application a read on the snapshot, or add
a second reviewed window.

Decision: **a second window, narrower than the first.**
`unai_private.registry_contract_present(release_id, contract, kind)` is
`SECURITY DEFINER`, takes the release it is asked about rather than choosing one,
and returns a single `boolean`. It returns no contract id, version, body or hash,
so a caller learns only whether the contract it already named is in the release it
already pinned — it cannot enumerate the registry through it. It fails closed
without an owner context and under any purpose but `memory.govern`,
`memory.canonicalize` and `memory.inspect`.

Consequence: no application role gains any privilege on the snapshot tables, and
`assertOwnershipCoverage`'s global-table rule is untouched.

## 2. Refusal is only for `ACCEPTED`

The criterion names an ACCEPTED assessment, and the governor refuses exactly that.
A `CANDIDATE` or `PROVISIONAL` belief over a predicate the pinned release does not
define is *not* refused: the evidence is real, the owner may inspect it, and
PRD §19.2 has a mode for precisely that case. `selectAdmissionMode` answers
`INDEX_ONLY` for an unregistered predicate, which is the mode whose definition is
"preserve evidence and create search indexes without canonical beliefs".

Widening the refusal to every assessment would delete a legitimate state rather
than protect one.

## 3. Commit is two database transactions, deliberately

CRT-WRT-02-A wants a failing operation to leave nothing visible. CRT-WRT-03-A
wants a denied write's policy decision to be *persisted*. One transaction cannot
do both: rolling the work back would roll the decision back with it.

Decision: **two.** The first re-validates, writes the `policy_decisions` row, and
either marks the transaction `REJECTED` or `VALIDATED` — and commits, so the
refusal and its reason survive whatever happens next. The second applies every
operation in order and writes the receipt; anything that throws inside it rolls
the whole thing back, including the `result_object_refs` of the operations that
had already run. This mirrors the audit discipline of ADR 0006 and of the evidence
routes: refusals are audited in their own transaction, after the rollback.

A transaction already `COMMITTED` short-circuits in the first and never reaches
the second, which is what makes a repeated commit one commit.

## 4. The receipt is stored, not recomputed

CRT-WRT-02-B asks for *identical* receipts, which is stronger than equal ones. A
recomputed receipt would differ by its `committedAt` at best and by a reordered
object list at worst.

Decision: the receipt is serialized onto `belief_transactions.commit_receipt` in
the same transaction that commits the work, and a second commit returns those
bytes unchanged. A trigger refuses any later rewrite of the column
(`BELIEF_TRANSACTION_RECEIPT_IMMUTABLE`), so "identical" is a schema property
rather than a timing coincidence. `idempotency_key` is unique per owner scope, so
a replayed *proposal* also finds the first transaction instead of opening a
second one.

## 5. A context move is governed by a transaction-local marker

CRT-REG-06-B requires that moving a proposition from QUOTED to BASE outside a
governed transaction be refused. A proposition's context is its slot's
`context_space_id`, so the move is an update of `belief_slots`.

Decision: the update is permitted only while a belief transaction of the same
owner scope is in status `COMMITTING`, named by the transaction-local setting
`unai.belief_transaction_id`. The check lives in a `BEFORE UPDATE` trigger that is
**not** `SECURITY DEFINER`, and the `belief_transactions` policies are `TO
unai_app`, so the privileged migration principal finds no matching row either and
is refused exactly as the application is. The setting is transaction-local and the
`COMMITTING` status rolls back with the commit, so no authorisation can outlive
the transaction that granted it.

`QUALIFY` is the operation kind that performs the move. The design's operation
vocabulary has no `MOVE_CONTEXT`, and re-qualifying a slot's governed descriptor
is what `QUALIFY` names.

## 6. An independence group is the asserting party, and nothing else

PRD §15.4 says repeated messages from one source, quoted email history and
model-generated summaries of the same source are not independent evidence.

Decision: `independenceGroupKey` is computed from the asserting party alone —
`claims.asserted_by_entity_id`, falling back to the source item's own actor, and
to the retained actor reference plus channel when identity resolution reached
nobody. It deliberately excludes the message, the anchor, the extraction run and
the model.

All three of the PRD's cases then collapse by construction rather than by a
special rule: three of Daniel's messages name Daniel; Daniel's words quoted inside
Alice's forward still name Daniel as the asserting party even though the anchor
sits in Alice's item; and a model summary names the party whose words it read,
because a model is never an asserting party. Only a genuinely different party
opens a second group.

A support row that names another proposition takes that proposition's own groups:
one group in, the same group out; several, one stable composite. A derivation is
exactly as independent as its inputs and can never inflate the count.

## 7. Circular support is rejected in the application, with the one-step case in the schema

Decision: the one-step cycle (`supporting_proposition_id = proposition_id`) is a
`CHECK` and is therefore unrepresentable for every principal. Longer cycles are
found by `findSupportCycle` over the graph the commit *would* leave behind — the
rows already stored plus the edges the transaction proposes — at validate and
again at commit.

A recursive trigger was rejected: it would run per row on every insert, could not
see the transaction's other pending edges as a set, and would make the refusal a
database error rather than a validation decision the caller can read.

## 8. The governor writes canonical identity through `@unai/memory`, not around it

The commit path calls `createBeliefSlot`, `createProposition`, `recordClaim` and
`recordFrameInstanceRole` rather than issuing its own inserts. A slot the governor
creates therefore carries the same versioned lookup fingerprint one
canonicalization creates, and is found by the same resolver; hand-written inserts
would have left the governed path invisible to fingerprint lookup.

The single exception is `frame_instances`, inserted here so
`created_by_transaction_id` is set at creation — the table takes no `UPDATE`
grant, so it cannot be filled afterwards.

This makes `memory.govern` a *reader and writer* of canonical identity, so
migration 0012 adds it to the read and append policies migration 0010 installed,
replacing each policy rather than weakening it: the owner check, the child
`EXISTS` clauses and the absent `DELETE` privilege are reproduced exactly. For the
same reason `memory.govern` joins the request purposes
`unai_private.evidence_access` admits — computing an independence group means
reading the source item behind a claim's anchor, and ADR 0016 §7 already decided
that such a reader passes the evidence gate rather than around it. The declared
data purpose and sensitivity ceiling still bind, so a governor that declares
neither reads nothing and groups nothing.

## 9. Four operation kinds are refused by name

`belief_transaction_operations.operation_kind` carries the design's full
vocabulary, but `MERGE`, `SPLIT`, `ARCHIVE` and `DELETE` are refused with
`BELIEF_OPERATION_NOT_DELIVERED` at propose and at commit. Merge and split with
lineage belong to `merge-split-lineage-and-uuidv7-identity-invariant`, archive to
the correction-controls node and the deletion cascade to the export-and-deletion
node. Half-implementing them here would have produced rows those nodes must then
reconcile with lineage and cascade receipts that do not exist.

`AUTO_CLAIM` is likewise held to its PRD definition: it commits what the source
directly proves, which is the *claim*. `admittedAssessmentStatus` answers
`CANDIDATE` for it, so `AUTO_ACCEPT` remains the only mode that reaches an
accepted belief — the property CRT-WRT-04-A turns on.
