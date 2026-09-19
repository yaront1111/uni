# Governed merge and split, lineage, and the surrogate-identity invariant

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`merge-split-lineage-and-uuidv7-identity-invariant`, and approved
contract-uai-v0/rev-uai-v0-001. This node owns CRT-MEM-03-A, CRT-MEM-10-A,
CRT-MEM-10-B and CRT-MEM-10-C. ADR 0025 records its decisions; the earlier
slices were inspected and retained, with the changes listed under "What changed
in earlier slices".

## Design entities implemented here

**`frame_instance_lineage`** and **`proposition_lineage`**, added by
`migrations/0020_merge_split_lineage.sql` with forced RLS, purpose-gated
policies, composite owner foreign keys, a governed-insert trigger and an
append-only trigger. **`entity_lineage`** (migration 0010) is now written by the
governed entity merge and split and gains the same append-only trigger and a
governed-insert check for any row that names a transaction. There are now 53
application tables (with the connector grants and the semantic index), 51 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

The node also writes, through the stores that own them, `frame_instances`,
`frame_instance_roles`, `belief_slots`, `slot_fingerprints`, `propositions`,
`belief_support`, `belief_assessments`, `claims` (lifecycle only), `entities`,
`entity_aliases`, `belief_transactions`, `belief_transaction_operations`,
`policy_decisions` and `projection_rebuild_receipts`, and rebuilds
`open_commitments_projection`, `obligations_projection` and
`schedule_projection`.

## Design screen implemented here

**Merge and split review** (`apps/web/pages/memory/merge-split.tsx`,
`apps/web/components/MergeSplit.tsx`), with every state the design draws:
candidate pairs with match outcome and score components; PROBABLE_MATCH or
POSSIBLE_MATCH kept separate and never reused for a material accepted update;
two same-name people kept as separate entities; a merge preview naming the
survivor and the lineage to be written; a merge receipt with lineage records
and projection rebuild receipts; a split preview; claims that cannot be safely
assigned left contested or attached to the retired parent; an old identifier
still resolving to the survivor and never repurposed. The screen reads
`GET /v1/memory/merge-split/review` and writes through the same-origin proxy,
which maps the four routes below to `memory.govern` and pins the evidence gate
as it does for evidence ingest. No other screen is drawn here: the Merge and
Split controls inside the Correction controls screen belong to
`commitments-obligations-inspector-and-correction-controls`.

## HTTP surface

| Route | Purpose | Answer |
| --- | --- | --- |
| `POST /v1/memory/frame-instances/merge` | `memory.govern` | survivor, lineage, rehomed slots and fingerprints, colliding slots, proposition lineage, assessments, conflicts, rebuild receipts, resolution |
| `POST /v1/memory/frame-instances/{id}/split` | `memory.govern` | new instances, reassigned claims, contested and retained claims, new slots, lineage, rebuild receipts, resolution |
| `POST /v1/memory/entities/merge` | `memory.govern` | survivor, lineage, alias records, affected frames, rebuild receipts, resolution |
| `POST /v1/memory/entities/{id}/split` | `memory.govern` | new entities, lineage, assigned and ambiguous aliases, roles left on the parent, rebuild receipts, resolution |
| `GET /v1/memory/merge-split/review` | `memory.inspect` | the review screen's read (added for the drawn screen; ADR 0025 §4) |

Each POST proposes and commits a `MERGE` or `SPLIT` belief transaction through
`@unai/belief` (policy decision, idempotency key and stored receipt are the
governor's), then rebuilds every typed projection in a second owner
transaction under `memory.project` and records one receipt per projection with
the trigger and the transaction id. A retry with the same idempotency key is
answered from the committed transaction and the receipts already recorded for
it; a key already used for another kind is refused `IDEMPOTENCY_KEY_REUSED`.

## How each acceptance criterion is met

- **CRT-MEM-10-A** — `packages/api/src/lineage.test.ts` merges two obligation
  instances through the endpoint. The merged id gets a `MERGED_INTO` lineage row
  naming the committed MERGE transaction, keeps its row with lifecycle `MERGED`,
  resolves to the survivor (`resolution`, `resolveIdentity`), and names exactly
  one row in every `uuid`-keyed table of the schema. Merging it again is refused
  `FRAME_INSTANCE_NOT_ACTIVE`, the database refuses reactivation
  (`FRAME_INSTANCE_ALREADY_RETIRED`) and a second survivor (unique index), so the
  id is never repurposed. Three rebuild receipts with trigger `MERGE` are
  returned and stored, and the rebuilt obligations projection holds one row
  under the survivor carrying both statements' claims. A second case shows the
  merged instance's non-colliding slot (due time), its allocation and a
  differing amount landing on the survivor, the two accepted values contested
  rather than one chosen; a third survives into a new canonical instance.
- **CRT-MEM-10-B** — the same file splits one combined obligation into two.
  Only the assigned claims are reassigned (a support row from the split
  transaction to the new instance's proposition; no claim is re-pointed). The
  unassigned claims are `CONTESTED` and still attached to the parent's
  propositions, whose frame is the retired parent (`SPLIT`), which keeps its
  slots and resolves to both halves. The mixed principal slot becomes one slot
  per partition, and three receipts with trigger `SPLIT` accompany rebuilt rows:
  the parent's is gone, each half has its own with only its own claim.
- **CRT-MEM-10-C** — the same file merges two same-name people (shown first as
  a review candidate kept apart) and splits one person into two. Both endpoints
  return lineage records and three rebuild receipts; the merged entity id
  resolves to the survivor through `resolveEntityReference` and the answer's
  `resolution`, keeps its row, and its mailbox now finds the survivor; the
  obligation that named it projects the survivor as creditor.
- **CRT-MEM-03-A** — `packages/capabilities/src/identity-invariant.test.ts`
  creates frame instances, belief slots, propositions, claims, resolution
  assertions, a registry release (published from a Git tag in a database of the
  file's own), belief transactions, overlay deltas and projection versions
  through their production paths, two of each from identical content. Every id
  is a valid UUIDv7 whose timestamp is its creation time; identical content
  never yields the same id; no id equals or appears in any stored content hash,
  fingerprint or packet hash. A static test asserts that every production module
  inserting into those tables mints with the zero-argument `uuidV7()` and never
  with `randomUUID`, and that the reducer mints `projectionVersion` the same way.

## What changed in earlier slices

- `@unai/belief`: `MERGE` and `SPLIT` operations are delivered (`lineage.ts`,
  applied inside the commit); `ARCHIVE` and `DELETE` are still refused
  `BELIEF_OPERATION_NOT_DELIVERED`, and a MERGE or SPLIT operation is refused
  `BELIEF_OPERATION_KIND_MISMATCH` outside a transaction of its own kind. The
  governor test and the API memory test that used MERGE as the example of an
  undelivered kind now use ARCHIVE.
- `@unai/capabilities`: the canonical readers follow lineage (a merged frame's
  slots, roles, resolutions, realizations and allocations read for its
  survivor; a merged proposition's claims count for the proposition it merged
  into; a split-assigned claim counts for the new proposition; a merged entity
  reads as its survivor; an owner delta about a split frame is reported as
  unattached). A full replay now removes rows of frames it no longer projects.
  With no lineage every reader answers exactly as before.
- `@unai/memory`: `frameOutcomeProjection` counts resolutions asserted against
  frames merged into the one asked about.
- `packages/capabilities/src/projection-replay.test.ts` re-applies every
  migration from 0016 onward, so it now also removes 0018's objects before the
  re-application, as it already did for 0017's.
- `@unai/api`: `deviceWork` accepts a server-chosen purpose for one transaction
  (the rebuild under `memory.project`); no route reads it from a header.

## What this node does not claim

- It does not **detect** merge candidates. The matcher of
  `canonicalization-instance-matching-and-bitemporal-queries` records them and
  the review lists them; a merge happens only when the owner confirms one.
- It does not **re-point** anything. Old ids, claims, roles and aliases stay
  where they were recorded; lineage and support rows carry their meaning.
- An **entity split** reassigns aliases only. Roles that named the split entity
  keep naming it (listed as `rolesOnRetiredParent`), because which new entity a
  role meant is what a split cannot know; reassigning them is a later governed
  correction.
- The **UUIDv7 invariant is proven by tests, not by a schema constraint**
  (ADR 0025 §5): fixtures across the suite still insert v4 ids directly as the
  privileged principal, and a format `CHECK` would fail them without making any
  production path safer.
- The **Merge and Split controls** of the Correction controls screen, and their
  `memory_operations` record, belong to
  `commitments-obligations-inspector-and-correction-controls` (CRT-UX-10-A).
