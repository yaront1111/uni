# ADR 0019 — The owner sequence allocator, overlay deltas and the correction write paths

Status: accepted.
Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`owner-sequence-overlay-deltas-and-correction-endpoints`, and approved
contract-uai-v0/rev-uai-v0-001. Criteria: CRT-AI-03-A, CRT-MEM-15-A,
CRT-RYW-01-A, CRT-RYW-02-A, CRT-RYW-02-B, CRT-RYW-06-A.
ADRs 0001–0018 were read and are retained unchanged.

## 1. The sequence is allocated by the database, inside the caller's transaction

`unai_private.allocate_owner_sequence` is one
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` against a single
`owner_sequences` row. That statement is atomic and takes the row's write lock,
so a second writer for the same owner blocks until the first transaction ends.
The consequence is the property CRT-RYW-01-A asks for and the reason no sequence
generator was used: a PostgreSQL sequence is monotonic but *not* gap-free and
hands out numbers in statement order, so two overlapping writes could commit in
the opposite order to their numbers. Here the allocation point is also the
serialization point, so the numbers increase in commit order.

The function is deliberately not `SECURITY DEFINER`. It runs as the caller, so
the owner policy and the column grants on `owner_sequences` decide whether it may
run; a definer here would have been a way around the boundary rather than a use
of it.

## 2. A new purpose, `memory.correct`, rather than reusing `evidence.ingest` or `memory.govern`

A correction control genuinely does three things at once: it writes evidence, it
writes the overlay, and it proposes a governed transaction. Reusing
`evidence.ingest` would have let an ingestion route write overlay deltas;
reusing `memory.govern` would have let the governor write evidence. Neither is
true, and both would have widened an existing purpose past what its routes do.

So migration 0014 adds `memory.correct` and extends exactly the policies the
correction path needs, leaving every other condition of each policy — the owner,
the actor binding, the data purpose, the sensitivity ceiling, the evidence
parent check — untouched. The purpose is pinned by the URL mapping in
`platform.ts` like every other one, and `@unai/belief`'s runner is bound to it in
`corrections.ts`, so the correction path cannot widen its own request.

What was deliberately *not* opened to `memory.correct`: `belief_assessments`,
`belief_support` and `belief_slots` writes. A correction proposes; it accepts
nothing. The single canonical row any control writes is the USER_CONFIRMATION
claim of §4.

## 3. The overlay is scoped to the owner, and the device is audit only

`owner_overlay_deltas.source_device_id` and `source_session_id` are recorded and
never read by a policy or a query filter. Every read is by `owner_scope_id`
alone. This is what makes CRT-RYW-02-A and CRT-RYW-02-B structural rather than
behavioural: there is no code path on which one device's write could fail to
reach another device's read, because no read narrows by device.

`readOwnerOverlay` returns suppressed, archived and deleted targets as three
separate lists rather than one "hidden" set. Suppress, archive and delete are
three different promises to the owner (PRD §20.2), and a reader that collapsed
them could not honour the one it was actually given.

## 4. Confirmation writes a claim; every other control writes none

CRT-AI-03-A requires a new claim with origin `USER_CONFIRMATION`, and a claim is
evidence-level, not an accepted belief — the claim store is reached directly by
extraction today for the same reason. So `POST /v1/memory/confirmations` records
the claim and proposes support for it; the confirmed claim's own row, including
its `claim_origin`, is never read for update.

The other controls write no claim at all. A correction proposes an `ADD_CLAIM`
operation and lets the governor create it on commit, so a correction that is
never committed leaves no claim behind.

## 5. Re-extraction may contest a delta and no more

CRT-MEM-15-A is carried in two places, because one would have been a convention.
`contestOverlayDelta` is the only write the extraction path has over a delta, and
`unai_private.overlay_delta_transition` refuses a move to
`REJECTED_AS_INTERPRETATION`, `SUPERSEDED` or `WITHDRAWN` under any purpose but
`memory.correct` — binding the privileged migration owner too. The same trigger
refuses a change to the kind, the text, the evidence, the target or the sequence,
so a contested delta still says exactly what the owner said.

`contestOverlayDelta` checks the updated row count. A row-level security policy
that filters a row out answers zero rows rather than an error, and reporting a
contest that never happened would hide the conflict in precisely the place
CRT-RYW-05-A requires it recorded.

## 6. What this node does not deliver, and why

- The **deletion cascade** (raw object, parsed content, anchors, claims,
  unsupported derived beliefs, embeddings, summaries, indexes, projection rows,
  plugin caches) belongs to `drafts-actions-permissions-export-and-deletion-workflow`
  under CRT-SEC-11-A. `POST /v1/memory/deletions` therefore records the
  acknowledged request — the delta that removes the object from every device's
  next read, and a `DELETE` operation row — and claims no cascade it did not run.
- The **canonical ARCHIVE, MERGE and SPLIT operations** are refused by the
  governor as `BELIEF_OPERATION_NOT_DELIVERED` (ADR 0017) and owned by
  `merge-split-lineage-and-uuidv7-identity-invariant`. `POST /v1/memory/archives`
  records the overlay delta and the operation and proposes no canonical change.
  `memory_operations` still carries `MERGE` and `SPLIT` in its CHECK list, so that
  node has the row shape to write into rather than a migration to add.
- **`GET /v1/memory/overlay-deltas`** is the read surface this node adds for its
  own criteria. The design draws the overlay being read through the Context
  Broker's `POST /v1/memory/context`, which
  `context-broker-packets-explain-and-memory-threads` owns; that node consumes
  `readOwnerOverlay` from `@unai/memory` rather than re-deriving the overlay.
  Without a read of its own, CRT-RYW-02-A and CRT-RYW-02-B would not be
  verifiable over the boundary at this node.
