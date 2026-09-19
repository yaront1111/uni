# ADR 0025: Governed merge and split, lineage, and the surrogate-identity invariant

Date: 2026-09-18
Status: Accepted
Node: `merge-split-lineage-and-uuidv7-identity-invariant` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-MEM-03-A, CRT-MEM-10-A, CRT-MEM-10-B, CRT-MEM-10-C.

Recorded before the implementing change, per PRD §0.7 and §46.

Written as ADR 0023 and renumbered 0025 when master landed ADR 0023 for the
connector capabilities and ADR 0024 for the semantic index; its migration moved
from 0018 to `migrations/0020_merge_split_lineage.sql` for the same reason. That
migration's header still says "ADR 0023" because its bytes were kept unchanged:
it means this record.

## 1. A merge or split is a belief transaction, and the schema refuses anything else

PRD §14 opens with "merge and split are belief transactions, not database
shortcuts". The four endpoints therefore propose, validate and commit an
ordinary `belief_transactions` row of kind `MERGE` or `SPLIT` through
`@unai/belief`, with one `MERGE` or `SPLIT` operation per retired object, and
the write governor applies them inside its commit. The policy decision
(`EvaluateMemoryWrite`), the idempotency key and the stored receipt are the
governor's, unchanged.

The database holds the same line for every principal, including the migration
owner:

- `frame_instance_lineage` and `proposition_lineage` require a
  `transaction_id`, and a trigger requires that transaction to be a `MERGE` or
  `SPLIT` of the same owner that is `COMMITTING` in this very database
  transaction (`unai_private.governing_belief_transaction()`, the marker the
  context-move guard of ADR 0017 already uses).
- `frame_instances` gains its first `UPDATE` grant — `lifecycle` and
  `retired_at` only — and a trigger that refuses a lifecycle change outside a
  belief transaction of the same owner that is committing now, refuses to
  reactivate or re-retire an instance that already left `ACTIVE`, and refuses
  any change to the identity columns.
- Both lineage tables are append-only: no `UPDATE` or `DELETE` grant and a
  trigger that raises `LINEAGE_IMMUTABLE` for any update.

`entity_lineage` keeps its nullable `transaction_id` (ADR 0015, 0017), because
`recordEntityMerge` of the canonical-identity node writes it without one; every
lineage row this node writes names its transaction.

## 2. Old identifiers resolve through lineage; nothing is re-pointed

No id is ever reused or rewritten. A merged or split object keeps its row, its
id and its history; its `lifecycle` moves to `MERGED` or `SPLIT` with
`retired_at`, and lineage says where it went:

| Object | Merge | Split |
| --- | --- | --- |
| frame instance | `MERGED_INTO` survivor | `SPLIT_INTO` each new instance |
| entity | `MERGED_INTO` survivor | `SPLIT_INTO` each new entity |
| proposition | `MERGED_INTO` (equivalent value in a colliding slot) | `SPLIT_INTO` the child's proposition |

`proposition_lineage` adds `SPLIT_INTO` to the design's `EQUIVALENT_TO`,
`CANONICAL_ALIAS_OF`, `MERGED_INTO`. The design names no kind for a split
proposition, and recording one keeps the old proposition id resolvable to the
propositions that replaced it, which is the rule of PRD §14.2 item 5.

`frame_instance_lineage` uses `MERGED_INTO`, `SPLIT_INTO` and `RETIRED_PARENT`,
the same vocabulary `entity_lineage` already has.

A claim's `proposition_id` stays immutable (migration 0012,
`CLAIM_ATTACHMENT_IMMUTABLE`). Re-pointing a claim would rewrite which belief a
source assertion was recorded against. Instead:

- **Merge.** Slots of the merged instance keep their rows and are *rehomed*: a
  new `slot_fingerprints` version whose descriptor names the survivor is
  appended and the previous one closed, so the fingerprint is recomputed and
  the slot id is unchanged (PRD §14.1 items 3–4). A slot whose rehomed
  descriptor equals one already on the survivor is a *newly colliding slot*
  (item 5): each of its propositions is merged into the survivor slot's
  proposition with the same value, or into a new proposition there with that
  value, by `MERGED_INTO` lineage, and the colliding slot is retired `MERGED`
  (item 6). Claims stay attached where they were recorded; readers follow
  `MERGED_INTO` to count them for the survivor.
- **Split.** The parent keeps its slots, propositions and claims as lineage
  history (PRD §14.2 item 5). Each safely assigned claim — one the caller named
  in `claimAssignments` — gets, on the partition's new instance, the slot with
  the same descriptor and the proposition with the same value (created on
  demand, `SPLIT_INTO` lineage from the parent's), and a `belief_support` row
  from the claim to that proposition, written by the split transaction. A
  parent slot whose claims went to two partitions yields a slot per partition:
  the "new slots where one old slot mixed situations" of item 4.
- **Unassignable claims** — every claim of the parent the caller did not assign
  — are moved to `CONTESTED` when their lifecycle allows it and stay attached to
  the retired parent in every case (item 3, CRT-MEM-10-B). The response lists
  both groups.

## 3. Readers follow lineage; projections rebuild

The typed-projection reducers read through lineage rather than through a copy:
`@unai/memory` answers which frames were merged into a survivor and which
survivor an old frame or entity resolves to, and the capability readers
(`readSlotValues`, `readRoles`, `readResolutions`, `readRealizations`,
`readAllocations`, `readOwnerDeltas`, `listScheduledFrameInstanceIds`) and
`frameOutcomeProjection` use it. A merged obligation's principal, allocations,
resolutions and owner deltas therefore land on the survivor's row, and a merged
entity id in a role reads as the survivor. A delta or allocation pointing at a
split parent resolves to no frame and is reported, never silently re-attached.

The rebuild after a merge or split runs in its own owner transaction under
`memory.project`, the only purpose that writes projection rows (ADR 0021 §7).
It first recomputes the affected rows incrementally and removes the rows of
frames that are no longer active, then replays every projection with
`compareWithStored` and records one `projection_rebuild_receipts` row per
projection with trigger `MERGE` or `SPLIT` and the transaction id. A full
replay now also removes rows whose frame it no longer projects, so "rebuild
from canonical memory" holds after a retirement.

Rejected: widening the projection write policies to `memory.govern` so the
rebuild commits with the transaction. It would let the governing purpose write
projection rows, which ADR 0021 deliberately withheld, and the rebuild is
repeatable: a retry of the same request finds the committed transaction, reuses
the receipts already recorded for it, and answers the same body.

## 4. The request purpose is `memory.govern`; the rebuild is server-chosen

The four POST routes map to `memory.govern`, the purpose of every governed
write. The API's `work` helper gains an optional purpose override so the route
can open the rebuild transaction under `memory.project`; the override is chosen
by server code, never by a header, and the session is re-verified exactly as
for every other transaction. The review read (`GET /v1/memory/merge-split/review`,
added for the drawn Merge and split review screen, which the design's API list
does not otherwise serve) maps to `memory.inspect`.

Policies widened, each by replacement: `entities` insert/update, `entity_aliases`
read/insert and `entity_lineage` read/insert admit `memory.govern`;
`slot_fingerprints` close admits `memory.govern`; `belief_support` read admits
`memory.project`; the lineage tables are readable by every purpose that reads
the objects they describe, so a read never fails open or closed on lineage
alone.

## 5. The surrogate-identity invariant is proven, not re-declared

CRT-MEM-03-A covers nine object kinds. Every one is already minted by the
zero-argument `uuidV7()` of `src/kernel/identities.ts`. This node adds no
second generator and no database `CHECK` on id format: existing fixtures across
eleven suites insert v4 ids directly as the privileged principal, and a
format constraint would fail them without making any production path safer.
Instead a database-backed suite creates each of the nine kinds through its
production code path in a scratch database — including a real registry
release published from a Git tag — and asserts that every id is a valid UUIDv7
whose timestamp is the creation time, that two objects with identical content
receive different ids, and that no id equals or is contained in any stored
content hash, packet hash or fingerprint. A static test asserts that every
production module inserting into those nine tables mints ids with `uuidV7()`
and none uses `randomUUID` or a hash for them.
