# ADR 0015: Canonical identity schema — placeholder references, the release pin and under-merge strength

Date: 2026-09-18
Status: Accepted. Implementation choices recorded before code.

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1 — entities
`entities`, `entity_aliases`, `entity_lineage`, `frame_instances`,
`frame_instance_roles`, `belief_slots`, `slot_fingerprints`, `propositions`,
`proposition_fingerprints`, `claims`; screens "Memory inspector" (advanced
identifier panel, separate-confidence state) and "Merge and split review"
(two same-name people kept separate); contract-uai-v0/rev-uai-v0-001
CRT-MEM-04-A, CRT-MEM-04-B, CRT-MEM-05-A, CRT-MEM-07-A, CRT-MEM-11-B,
CRT-MEM-14-A; PRD §11.3, §11.5, §11.8–§11.10, §12.5, §13, §15, §33.4, §33.6,
§36.4, §36.5, §47. Extends ADR 0004 (applied migrations are immutable) and
ADR 0011 (the registry snapshot is a global immutable table).

PRD §33 states that "the final SQL may vary, but these logical tables and
relationships are required". The four decisions below are where migration
`0010_canonical_identity.sql` departs from the literal column list, and why.

## 1. A reference whose table does not exist yet is constrained null, not dangling

`entity_lineage.transaction_id`, `frame_instances.created_by_transaction_id` and
`claims.extraction_run_id` name tables — `belief_transactions`, `extraction_runs`
— that later nodes of this plan deliver. Writing a foreign key to a table that
does not exist is impossible; writing an unconstrained uuid column would let a
row record a reference nothing can resolve.

Decision: declare the column and constrain it `CHECK(<column> IS NULL)`, so the
shape is present and unusable rather than present and unverifiable. The node that
delivers the referenced table drops the check and adds its foreign key in a new
migration. This is the pattern the operator approved for
`source_items.actor_entity_id` (approval
32829070817ae33f2f3ef7de29f64f0df84fcbba7c3a4baccbf83515dddb7a65), and this
migration completes that specific handoff: the placeholder check is dropped and
replaced by `FOREIGN KEY(owner_scope_id, actor_entity_id) REFERENCES
entities(owner_scope_id, id)`. No value is backfilled — filling the column from
the retained `actor_ref` is runtime work for the entity service, and `actor_ref`,
`content_hash` and `raw_object_ref` are untouched.

## 2. The fingerprint's registry release pin carries no foreign key

`slot_fingerprints.registry_release_id` and
`proposition_fingerprints.registry_release_id` record which pinned release a
descriptor was normalized under. `registry_releases` exists, so a foreign key was
the first choice and was implemented — and it changed the behaviour of the
snapshot's own immutability guard: `TRUNCATE registry_contracts,
registry_releases` then fails as a foreign-key violation before
`REGISTRY_SNAPSHOT_IMMUTABLE` can refuse it, which is exactly what
`packages/registry/src/snapshot.test.ts` proves.

Decision: record the pin without a foreign key, and leave it nullable for a
deployment that has not materialized a release snapshot yet. ADR 0011 gives the
snapshot tables to the registry migration alone; a reference from owner-scoped
data would take part of that ownership and weaken a delivered check. What
actually versions this index is `normalization_version`, which is `NOT NULL` and
pattern-constrained on both tables. The alternative — keeping the foreign key and
relaxing the snapshot test — was rejected: an existing check may not be weakened
to fit a new table.

## 3. Alias strength, not a score, is what makes evidence "sufficient"

CRT-MEM-11-B requires two people named Daniel to stay separate "unless sufficient
evidence or a user merge establishes identity", and PRD §11.3 forbids automatic
same-name merging. The PRD does not define the threshold.

Decision: sufficiency is a property of the alias *type*, not of a tuned number.
`EMAIL`, `HANDLE`, `PHONE` and `EXTERNAL_ID` identify one account or mailbox; an
exact, unambiguous match on one of them is `CONFIRMED_MATCH` and reuses the
entity. `DISPLAY_NAME`, `GIVEN_NAME`, `FULL_NAME` and `NICKNAME` describe a person
and are shared by design, so they can only produce `PROBABLE_MATCH` or
`POSSIBLE_MATCH` — neither of which reuses anything. Two entities answering to one
strong alias is a conflict for a human, not stronger evidence, so it also stays
under-merged. A stored `confidence` on an alias is retained as evidence for the
Merge and split review screen and is deliberately not an input to this decision:
a threshold on an extractor's own number is exactly the silent false merge PRD
§55 warns about. A scoring matcher may replace this later through a governed
registry change; until then the rule is legible and the failure mode is a
duplicate, which the user can see and merge.

## 4. A belief slot has no value column, and no unique key over its descriptor

PRD §11.8 excludes the value from the slot descriptor and §13.5 requires a slot
collision to trigger semantic comparison rather than establish identity.

Decision: `belief_slots` has no value column at all — the value lives only on
`propositions` — and there is no unique index over
`(frame_instance_id, predicate_id, context_space_id, modality, qualifiers)` nor
over any `fingerprint` column. Two slots may therefore carry one descriptor and
one fingerprint, which is what makes CRT-MEM-04-B's "returns both candidates"
representable instead of refused by the database. Identity is established by the
application comparing descriptors, and only when exactly one candidate matches.
The cost is that a duplicate slot is possible; that is the intended direction of
error, and `frame_instance_lineage`, the instance matcher and the merge and split
transactions that reconcile duplicates belong to later nodes of this plan.
