# ADR 0018 — Canonicalization, frame-instance matching and the bitemporal query modes

Status: accepted.
Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`canonicalization-instance-matching-and-bitemporal-queries`, and approved
contract-uai-v0/rev-uai-v0-001. Criteria: CRT-MEM-06-A, CRT-MEM-06-B,
CRT-MEM-09-A, CRT-MEM-11-A, CRT-MEM-11-C, CRT-PRJ-06-A, CRT-REG-06-A.
ADRs 0001–0017 were read and are retained unchanged.

## 1. Two new tables, and no third

`migrations/0013_canonicalization_and_bitemporal.sql` adds
`instance_match_candidates` and `claim_relations` — the two design entities this
node owns — and nothing else. `proposition_lineage` and `frame_instance_lineage`
are left to `merge-split-lineage-and-uuidv7-identity-invariant`: both exist to
carry survivorship across a governed merge or split, and a table written by this
node with no merge to record would be a shape that node must then reconcile.

## 2. Bitemporal state needs no table of its own

PRD §12.3 asks for three query modes, not three storages. Valid time already
lives on `belief_assessments.valid_from`/`valid_to` and recorded time on
`recorded_at`/`superseded_recorded_at` (migration 0012), and an assessment is
append-only there. So the three modes are three *selections* over one append-only
history, and this migration adds only the composite index they read through.

A second store of "current state" would have to be kept consistent with the
history, and the first divergence between them would be unanswerable.

## 3. Both time axes are half-open

`[valid_from, valid_to)` and `[recorded_at, superseded_recorded_at)`. A value
whose period ends on August 5 and one whose period begins on August 5 therefore
never both answer for August 5, which is what makes "two non-overlapping valid
periods" (PRD §57) a property a test can assert rather than a description.

## 4. Extractor-selected context is refused, not ignored

PRD §11.6 rule 2 says extractors must not choose the context kind, and
CRT-REG-06-A allows the output to be "ignored or rejected". `canonicalizeClaim`
and `resolveCanonicalContext` reject it with
`EXTRACTOR_CONTEXT_SELECTION_REFUSED`, and the fields exist on the request type
purely so that the refusal is typed and explicit.

Silently ignoring would be correct for the row that gets written and wrong for
everything else: the one run where an extractor tried to split a slot by phrasing
would look identical to every run where it did not, and the model-behaviour
regression would be invisible.

## 5. A rule may select QUOTED; nothing here creates a QUOTED context space

`QUOTED` is created only by an explicit registry rule or capability decision
(PRD §11.6 rule 4), and release 0.1.0 states in every frame contract that no rule
in it creates one. A caller may therefore pass a `ContextRule`, and the resolver
will use an *existing* active context space of that kind — but migration 0009
grants the application no INSERT on `context_spaces` at all, so a rule cannot
bring a quoted world into existence as a side effect of canonicalizing a
sentence. Absent one, the resolver answers `QUOTED_CONTEXT_SPACE_UNAVAILABLE`.

The registry is not read at canonicalization time. The runtime has no registry
service (ADR 0011, ADR 0014) and the snapshot answers only the boolean
`registry_contract_present`, so the rule is an input from the caller that loaded
the pinned release, exactly as the frame type and predicate ids already are.

## 6. Reported speech is attribution, not a world

"Daniel says I owe ILS 50" and "Daniel believes I owe ILS 50" reach the same BASE
slot as "I owe Daniel ILS 50" would. What differs is `claims.asserted_by_entity_id`
and a `sourceAttribution` record in the claim metadata, which is where the
reporting verb is kept. Splitting slots by phrasing would leave one obligation
with two disconnected amounts that can never contradict each other, and the
conflict surfaces of PRD §44.11 would have nothing to show.

## 7. Only a CONFIRMED_MATCH reuses an instance — in three places

PRD §13.4 restricts automatic reuse for a material accepted update. The rule is
carried by:

1. `mayReuseInstance`, which answers `false` for everything but
   `CONFIRMED_MATCH` — *including* for a non-material update, which is stricter
   than the sentence, because a duplicate instance is a merge a person can
   perform and a wrong reuse silently rewrites somebody's debt;
2. `recordInstanceMatchCandidate`, which refuses to record such a reuse with
   `INSTANCE_MATCH_REUSE_REFUSED`;
3. the schema check `instance_match_reuse_confirmed`, which keeps PRD's exact
   boundary so no principal — the application role or the migration owner — can
   record a PROBABLE or POSSIBLE reuse for a material accepted update.

A candidate is only a candidate when something of its own ties it to the
extraction: a shared role filler or an external identifier. Discourse-level
signals ("another", thread continuity) are applied to tied candidates and never
turn every unrelated instance of the frame type into a recorded decision.

## 8. A correction and a change cannot collapse into one representation

`claim_relations.temporal_effect` records which was meant, and the schema refuses
`CORRECTS` with a new period and `SUPERSEDES` with the old interval. Above that:

- a correction restates the interval the corrected claim already covered; the
  corrected value becomes `SUPERSEDED` over that same interval and the new value
  is `ACCEPTED` over it;
- a change closes the earlier period at the change instant, leaving the earlier
  value `ACCEPTED` — it was true — and accepts the new value from that instant.

Claims themselves are never edited. An assertion made in January still says what
it said; the periods live on the assessments, which are versioned in recorded
time. `classifyTemporalUpdate` reads the explicit language of PRD §57 and answers
`AMBIGUOUS` rather than guessing, because the PRD requires the product to ask
when the distinction is material.

## 9. A stated knowledge time, bounded in both directions

`recordBeliefStateVersion` accepts a `knowledgeTime`. Without it, PRD §44.10 —
"Uai learns on August 10 that a state changed on August 5" — is not expressible
at all: every version would carry the wall clock of the run, and the historical
belief query would have no earlier knowledge to answer from.

It is bounded so that the axis stays monotone and nothing already recorded is
disturbed: a knowledge time in the future is refused (`KNOWLEDGE_TIME_IN_FUTURE`,
by the service and by two database triggers), one earlier than what is already
recorded for the proposition is refused (`KNOWLEDGE_TIME_NOT_MONOTONIC`), and the
only write to an existing row remains closing its recorded-time window — the one
update migration 0012 already permits. The default is still `now()`.

## 10. The services live in `@unai/memory`

Canonicalization, matching, claim relations and the query operators are modules
of `@unai/memory`, over the `MemoryTransaction` the caller already opened. They
are the canonical-identity layer's own work and they read the tables that layer
owns.

`recordBeliefStateVersion` repeats the close-and-append shape of the write
governor's `recordBeliefAssessment` rather than importing it: `@unai/belief`
depends on `@unai/memory`, so the reverse import would be a cycle. The governor's
function is untouched and remains the `now()` path every commit uses.

## 11. What this node does not add

No HTTP route, no web page, no projection, no merge or split, no proposition
lineage and no registry loading. The Memory inspector screen is another node's;
this node delivers the historical-timeline state behind it.
