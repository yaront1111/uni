# Canonicalization, instance matching and bitemporal state

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`canonicalization-instance-matching-and-bitemporal-queries`, and approved
contract-uai-v0/rev-uai-v0-001. This node owns CRT-MEM-06-A, CRT-MEM-06-B,
CRT-MEM-09-A, CRT-MEM-11-A, CRT-MEM-11-C, CRT-PRJ-06-A and CRT-REG-06-A.
ADR 0018 records its decisions; ADRs 0001–0017 and the delivered foundation,
evidence, registry, queue, canonical-identity, model and write-governor slices
were inspected and retained unchanged.

**This node implements no screen.** It delivers the **Memory inspector** screen's
"historical timeline over valid time and recorded time" state — the three query
modes, the versions they read and the correction and change records they show —
for the node that draws that screen.

## Entities

`instance_match_candidates` and `claim_relations`, added by
`migrations/0013_canonicalization_and_bitemporal.sql` with forced RLS,
purpose-gated policies, composite owner foreign keys and an immutability trigger.
Every earlier table is preserved. There are now 37 application tables, 35 of them
owner-scoped and classified in `packages/postgres/src/ownership.ts`.

The bitemporal state itself adds no table: valid time and recorded time already
live on `belief_assessments` (migration 0012), and this migration adds the
composite index the three query modes read through, plus two triggers that keep
recorded time from being written into the future.

## Packages

**`@unai/memory`** gains four modules, all pure functions over a transaction the
caller opened inside the owner boundary:

- **`canonicalize.ts`** — `resolveCanonicalContext`, `classifySourceAttribution`
  and `canonicalizeClaim`: context, then instance, then slot, then proposition,
  then claim, then the match decision the claim belongs to. Context is BASE
  unless an explicit registry or capability rule says otherwise, and never what
  the extractor asked for.
- **`instances.ts`** — `scoreInstanceMatch` (pure), `matchFrameInstance`,
  `resolveFrameInstance`, `mayReuseInstance`, `recordInstanceMatchCandidate` and
  `listInstanceMatchCandidates`: the five outcomes of PRD §13.4 with their score
  components and reasons.
- **`relations.ts`** — `classifyTemporalUpdate` (pure), `recordClaimRelation`,
  `listClaimRelations`, `recordCorrection` and `recordChange`.
- **`bitemporal.ts`** — `queryCurrentState`, `queryCorrectedHistoricalState`,
  `queryHistoricalBeliefState`, the `queryBeliefState` entry point,
  `readBeliefTimeline` and `recordBeliefStateVersion`.

## What holds, and where it is proved

All in `packages/memory/src/canonicalization.test.ts`, over real PostgreSQL
through the real owner boundary, plus the schema-level guards in
`packages/postgres/src/isolation.test.ts`.

| Criterion | Where |
| --- | --- |
| CRT-REG-06-A "Daniel says" and "Daniel believes" both canonicalize into the BASE slot with source attribution; extractor-selected context is rejected | "CRT-REG-06-A": one slot, one proposition, two claims with their attribution; no QUOTED context space exists; three refusal paths |
| CRT-MEM-11-A "another ILS 50" after an ILS 50 obligation with Daniel creates a separate candidate instance | "CRT-MEM-11-A": second instance, second slot, a recorded `CONFIRMED_DISTINCT` decision naming the first instance |
| CRT-MEM-11-C PROBABLE or POSSIBLE never reuses an instance for a material accepted update | "CRT-MEM-11-C": both outcomes create new instances, `recordInstanceMatchCandidate` refuses the reuse, the schema check refuses it for any principal (`isolation.test.ts`), and a CONFIRMED_MATCH control does reuse |
| CRT-PRJ-06-A "Actually, it was ILS 60" leaves one slot with two propositions and the original claim retrievable | "CRT-PRJ-06-A": two propositions in one slot, the ILS 50 claim read back unchanged, one `CORRECTS` relation |
| CRT-MEM-09-A correction over one interval versus change into two non-overlapping periods | "CRT-MEM-09-A": both representations asserted field by field, compared, and required to differ; the two answer differently for the same date; the schema refuses the wrong pairing (`isolation.test.ts`) |
| CRT-MEM-06-A the §44.10 fixture answers August 7 with the new state under the corrected-historical query and the old state under the historical-belief query | "CRT-MEM-06-A and CRT-MEM-06-B" |
| CRT-MEM-06-B the current-state query returns the latest-valid, latest-known state for the same fixture | same test |

`pnpm test` (44 files, 432 tests) is the gate and passes; `pnpm typecheck` and
`pnpm validate:registry` also pass.

Three behaviours are worth stating because they are easy to assume the other way:

- **The three query modes refuse each other's arguments.** A world time on a
  current-state query, or a knowledge time on a corrected-historical one, is
  refused rather than ignored: the arguments a mode does not take are what makes
  it a different question.
- **A change does not make the earlier belief wrong.** It stays `ACCEPTED` over
  the period that ended. Only a correction supersedes, because only a correction
  says the interval was described wrongly.
- **Claims are never edited.** A correction and a change both append a claim, a
  proposition and new assessment versions. The valid periods live on the
  assessments; the January assertion still says what it said in January.

## What this node does not claim

- **No HTTP route and no web page.** The Memory inspector, its timeline control
  and the correction controls belong to
  `commitments-obligations-inspector-and-correction-controls`; the browser proxy
  is untouched.
- **No merge, split or lineage.** `frame_instance_lineage` and
  `proposition_lineage` are `merge-split-lineage-and-uuidv7-identity-invariant`'s
  deliverables. A PROBABLE or POSSIBLE match leaves two instances and a
  reviewable candidate row here; merging them is that node's transaction.
- **No projection.** A correction or a change writes canonical rows only; the
  obligations and commitments projections and their rebuild receipts are the
  typed-projection node's.
- **No registry loading and no registry validation.** The context rule and the
  identity-anchor roles are inputs from the caller that loaded the pinned
  release. Refusing an ACCEPTED belief over an unregistered predicate stays the
  write governor's validation (CRT-MEM-01-A).
- **No extractor and no model call.** `canonicalizeClaim` consumes extractor
  output; producing it is `@unai/extraction`'s work.
- **No owner overlay, resolution assertion or memory link.** Those are
  `owner-sequence-overlay-deltas-and-correction-endpoints` and
  `resolution-assertions-links-and-outcome-projection`.

## Configuration

No new environment variable and no new purpose. The two new tables are read under
`memory.canonicalize`, `memory.govern` and `memory.inspect` and written under
`memory.canonicalize` and `memory.govern`; a session holding any other purpose
reads none of them, and the policies fail closed when the setting is absent.
