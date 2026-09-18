# Canonical identity delivery

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1 and approved
contract-uai-v0/rev-uai-v0-001 (digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339).
ADR 0015 records this node's schema decisions before the code. ADRs 0001–0014 and
the delivered foundation, evidence, registry and queue slices were inspected and
retained; `docs/evidence-runtime.md` describes the predecessor node, not this
node's acceptance ownership.

## Implemented scope

Entities: `entities`, `entity_aliases`, `entity_lineage`, `frame_instances`,
`frame_instance_roles`, `belief_slots`, `slot_fingerprints`, `propositions`,
`proposition_fingerprints` and `claims`, added by
`migrations/0010_canonical_identity.sql` with forced RLS, purpose-gated policies
and composite owner foreign keys. Every earlier table is preserved. There are now
26 application tables, 24 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

Screens: this node implements storage-side states only. For **Memory inspector**
it delivers the advanced identifier panel's objects (frame instance, slot,
proposition and claim IDs, all UUIDv7) and the "claim shown with separate
extraction, entity-resolution, temporal-resolution and instance-resolution
confidence" state. For **Merge and split review** it delivers the "two same-name
people kept separate" state and the entity lineage that keeps a merged id
resolvable. No view, route or web page is added by this node; the surfaces that
render these states belong to later nodes.

Services (`packages/memory`, `@unai/memory`), all pure functions over a
transaction their caller already opened inside the owner boundary:

- **Entity service** — `resolveEntity` (candidate lookup plus the under-merge
  decision), `findEntityCandidates`, `recordEntityAlias`, `recordEntityMerge`,
  `resolveEntityReference`, `readEntity`.
- **Temporal service** — `resolveTemporalExpression`, pure and clock-free; the
  caller supplies the reference instant, so a resolution is reproducible from its
  recorded resolver version.
- **Slot and proposition store** — `resolveBeliefSlot`, `lookupBeliefSlot`,
  `resolveProposition`, `lookupProposition`, `slotFingerprint`,
  `propositionFingerprint`, `recomputeCanonicalFingerprints`.
- **Claim store** — `recordClaim`, `readClaim`, `listClaimsForProposition`, plus
  `createFrameInstance` and `recordFrameInstanceRole`.

## What holds, and where it is proved

| Criterion | Where |
| --- | --- |
| CRT-MEM-04-A fingerprint recomputation keeps every ID resolving | `packages/memory/src/identity.test.ts` |
| CRT-MEM-04-B a fingerprint matching two slots returns both candidates | `packages/memory/src/identity.test.ts` |
| CRT-MEM-05-A two ILS 50 claims, one proposition; ILS 60 shares the slot | `packages/memory/src/identity.test.ts` |
| CRT-MEM-07-A "last month" is stored with month precision, never an instant | `packages/memory/src/temporal.test.ts`, `identity.test.ts` |
| CRT-MEM-11-B two people named Daniel stay two entities | `packages/memory/src/identity.test.ts` |
| CRT-MEM-14-A four separate confidences on a stored claim | `packages/memory/src/identity.test.ts` |

Three behaviours are worth stating because they are easy to assume the other way:

- **A fingerprint is an index.** Nothing is keyed by one, nothing unique
  constrains one, and no identifier is derived from one. Recomputing under a new
  normalization version appends new index rows and closes the old ones at their
  recorded time; the slot, proposition and claim rows are not touched at all, so
  every identifier issued earlier still names the same object, field for field.
  A `FINGERPRINT_IMMUTABLE` trigger allows only the closing timestamp to move.
- **A lookup returns candidates, not an identity.** One candidate whose stored
  descriptor is identical is a match. Two candidates behind one fingerprint is
  `POSSIBLE_SLOT_MATCH` with both returned, and resolving creates a new slot
  rather than adopting either.
- **The default is under-merge.** Only an exact, unambiguous strong alias
  (mailbox, handle, phone, connector identifier) or an explicit user merge makes
  two mentions one entity. A shared name never does. A merged entity is retired,
  never deleted, and `resolveEntityReference` follows `MERGED_INTO` lineage so the
  old id keeps resolving to the survivor and is never repurposed.

## Evidence actor handoff (closed)

The evidence node delivered `source_items.actor_entity_id` with a placeholder
`CHECK(actor_entity_id IS NULL)` because `entities` did not exist. Migration 0010
drops that check and adds the composite owner foreign key
`(owner_scope_id, actor_entity_id) REFERENCES entities(owner_scope_id, id)`, as
the recorded handoff asked. Nothing is backfilled: filling the column from the
retained `actor_ref` is runtime work for the entity service, and `actor_ref`,
`content_hash` and `raw_object_ref` are unchanged.

## What this node does not claim

- No HTTP route, no web page, no projection and no belief assessment. Storing a
  claim is not accepting a belief: `claims` takes no `UPDATE` privilege here, and
  the lifecycle transitions, `belief_assessments`, `belief_support` and the
  Belief Transaction that governs them belong to the belief-transaction node.
- No frame-instance matcher. `frame_instances` and `frame_instance_roles` exist,
  but `instance_match_candidates`, the five match outcomes and the
  `frame_instance_lineage` merge and split transactions are later nodes'
  deliverables (CRT-MEM-11-A, CRT-MEM-11-C, CRT-MEM-10-A/B/C).
- No `extraction_runs`, `claim_relations` or `proposition_lineage` table; the
  columns that will reference the first are constrained null until its owner
  delivers it (ADR 0015 §1).
- No extractor, no model call and no registry loading. The temporal resolver
  recognises a bounded set of English phrases and ISO forms and answers null for
  anything else — an unrecognised phrase is an unknown, never a guessed instant.
- No entity or instance merge *endpoint*. `recordEntityMerge` writes the lineage
  an owner-stated merge needs; the endpoint, the alias reassignment and the
  projection rebuild receipt of CRT-MEM-10-C are the merge and split node's.

## Configuration

No new environment variable. Two new purposes are admitted by the identity
policies: `memory.canonicalize` for writes and `memory.inspect` for reads. A
session holding any other purpose reads none of these tables, and the policies
fail closed when the setting is absent.
