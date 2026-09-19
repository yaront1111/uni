# ADR 0029: Goals, decisions, prediction review and the mentor

Date: 2026-09-19
Status: Accepted
Node: `goals-decisions-prediction-review-and-mentor` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-DEC-01-A, CRT-DEC-02-A, CRT-DEC-03-A.

Recorded before the implementing change, per PRD §0.7 and §46. Paired with
`migrations/0024_goals_decisions_and_mentor.sql` and registry release 0.2.0.

## 1. Registry release 0.2.0 adds `shared.decision` and changes nothing else

The design's open decision reads: "shared.decision ships in a later immutable
release, drawn as registry release 0.2.0 in P6, leaving 0.1.0 unchanged." That
reading is taken. Release 0.2.0 is a complete set (the registry refuses deltas):
every 0.1.0 contract is copied byte for byte except its `version` line, and three
contracts are added:

- `shared.decision` (FRAME). Roles `decider` (required), `related_goal`,
  `related_entity`, `related_document`. Predicates, each with the modality the
  design's field implies:

  | Predicate | Cardinality | Modality | Design field |
  | --- | --- | --- | --- |
  | `question` | FUNCTIONAL, required | ACTUAL | question |
  | `option` | SET, required | ACTUAL | alternatives / options |
  | `assumption` | SET | EXPECTED | assumptions |
  | `consequence` | SET | EXPECTED | cross-domain consequences (value carries its life domain) |
  | `recommendation` | FUNCTIONAL | RECOMMENDED | recommendation |
  | `choice` | FUNCTIONAL | ACTUAL | user choice |
  | `rationale` | FUNCTIONAL | ACTUAL | why the choice was made |
  | `expected_result` | FUNCTIONAL | PREDICTED | expected result / predicted outcome |
  | `review_date` | FUNCTIONAL | INTENDED | review date |
  | `observed_result` | FUNCTIONAL | ACTUAL | actual outcome |

  No predicate names an outcome or a status (CRT-OUT-01-A still holds for the
  new frame): what happened is `observed_result`, in its own ACTUAL slot beside
  the PREDICTED `expected_result`, and whether the prediction held is a
  resolution assertion.
- `shared.decision.prediction_review` (TRANSITION, RESOLVES): source
  `shared.decision`, optional target `shared.event_occurrence`, outcomes
  `CONFIRMED`, `REFUTED`, `PARTIALLY_CONFIRMED`.
- `shared.decision.realization` (TRANSITION, REALIZES): an actual
  `shared.event_occurrence` realizes the decision; no outcome code.

The change class is **additive**: no existing frame, predicate, identity strategy
or transition changes, so no existing slot, fingerprint or projection moves and
the migration evidence CI requires of identity-, transition-affecting and
breaking changes (CRT-REG-05-A, owned by
`architecture-boundaries-corpus-shadow-eval-and-metrics`) does not apply. The
`registry-v0.2.0` tag is the operator's step after merge, as for 0.1.0.

## 2. Goals and their priority history

`goals` and `goal_priority_history` are product records, not canonical memory:
a goal is the owner's declared intention about their own attention, not a
belief about the world, so it needs no registry predicate, slot or assessment
(the design draws both as plain entities).

- **History is append-only.** `goal_priority_history` has no UPDATE or DELETE
  grant and a trigger refuses both for every principal, the migration owner
  included (`GOAL_PRIORITY_HISTORY_IMMUTABLE`). A row is `INITIAL`, `CHANGE` or
  `TEMPORARY_OVERRIDE` and carries its priority, reason, `valid_from`, optional
  `valid_to` and `recorded_at`.
- **`goals.current_priority` is a cache of the history, never an edit of it.**
  A trigger refuses an UPDATE that changes `current_priority` unless the same
  transaction appended a `CHANGE` row with that priority, and one that changes
  `temporary_override` unless it appended the `TEMPORARY_OVERRIDE` row it
  names (or is clearing an expired one). Title, domain, owner and creation time
  never change. A priority change therefore appends history and overwrites
  nothing (CRT-DEC-01-A).
- **Temporary overrides** (PRD §37.7 "respect explicit temporary overrides") are
  a `TEMPORARY_OVERRIDE` row with a `valid_to`; the stated priority is unchanged
  and the effective priority at an instant is the override while it is valid.
- Priorities are `HIGH`, `MEDIUM`, `LOW`, `PAUSED`; a goal's domain is one of the
  six life categories the Context Broker derives (`FINANCE`, `FAMILY`, `WORK`,
  `HEALTH`, `ADMIN`, `PERSONAL`), so a goal and a calendar event are compared in
  the same vocabulary.

## 3. A decision is canonical memory the owner states

`POST /v1/decisions` records the owner's decision the way the correction path
records any owner statement, then canonicalizes it the way the commitments
capability canonicalizes an undertaking:

1. Under `memory.correct`, one evidence row holds the owner's decision as text,
   anchored as a whole and field by field (one `MESSAGE_SPAN` per stated value),
   so every claim points at the exact words it rests on.
2. Under `memory.canonicalize`, `@unai/capabilities` creates the
   `shared.decision` frame, its roles, one slot per predicate and modality, one
   proposition per value and one `USER_STATEMENT` claim per proposition
   (lifecycle `CANDIDATE`). A cited source for an assumption is recorded as a
   `REFERENCES` memory link from the assumption's proposition to that evidence
   item after the item is shown to be readable under the request's own evidence
   context; it is linked, never copied, and never counted as support.
3. Nothing is accepted. Accepting a belief remains the write governor's decision
   through a belief transaction (PRD §19.1), exactly as for commitments.

A retry under the same idempotency key finds the evidence row it already wrote
and answers the decision frame canonicalized from it instead of creating a
second one.

## 4. `decision_projection` is a typed projection with its own reducer

The table has typed columns for every design field (question, alternatives,
assumptions, cross-domain consequences, recommendation, user choice, expected
result, review date, predicted outcome proposition ids, actual resolution ids)
plus the rationale, the actual outcome, the latest review code, the outcome
state, `review_due` and the related goal, and the nine PRD §33.12 metadata
columns, so CRT-PRJ-03-A's catalog-driven check covers it on its own.

It is reduced by `@unai/capabilities/src/decisions.ts`, which follows the rules
of ADR 0021 (one reducer for apply and replay, no clock, inputs recorded in
`source_manifest`, reads fold the owner overlay in memory, rebuild receipts in
`projection_rebuild_receipts`). It is deliberately **not** added to
`PROJECTION_NAMES`: that list drives the Context Broker's projection fragments,
the merge/split rebuild and the replay CLI default, and each of those has tests
pinned to the three V0 projections. Adding the decision projection there is a
separate change with its own review; here the receipts table's
`projection_name` CHECK is widened so a decision replay is recorded like any
other.

## 5. "Why did I make this decision?" is answered through the Context Broker

`GET /v1/decisions/{id}` classifies the question with the Ask classifier (it
reads `CAUSAL_EXPLANATION` / `DECISION_RECONSTRUCTION`) and reads a Context
Broker packet under `memory.read` planned as `DECISION_RECONSTRUCTION` with the
`shared.decision` frame type hint. The rationale is composed by code from that
packet's statements about the decision frame — the recorded rationale, choice,
options and assumptions — and each statement lists its sources: the evidence the
packet names for it, with the anchored excerpt read under `memory.inspect`, and
the sources cited for an assumption (the `REFERENCES` links). Nothing is
generated by a model and nothing outside the packet is stated. The packet id is
returned so the answer is auditable.

## 6. A prediction review is a resolution assertion beside an intact prediction

`POST /v1/decisions/{id}/review` takes the actual outcome as text, as a cited
evidence item, or both, the owner's reviewed outcome code and the transition
contract id. It:

1. stores the review statement as evidence (`memory.correct`);
2. records the actual outcome as a proposition in the decision's
   `observed_result` ACTUAL slot with its own claim, and links a cited evidence
   item with `REFERENCES`;
3. records a **proposed** resolution assertion on the decision frame whose
   source proposition is the PREDICTED `expected_result`, target-less, with the
   outcome code validated by `validateTransition` against the pinned release's
   transition contracts — so `FULFILLED`, an unknown contract or a missing one
   is refused;
4. re-reduces the decision projection.

The PREDICTED proposition, its slot and its claims are written by nothing in
this path (CRT-OUT-05-A's rule, re-proved here for decisions). The response
carries the predicted-versus-actual comparison: both propositions, both texts,
their modalities, their evidence and the resolution code. Accepting the review
stays a governed decision (§3).

The transition contracts come from the pinned release: a deployment passes them
to `createPlatformApi({ transitionContracts })`, and without them the route
reads the transition contracts of the newest published release from the
database snapshot through `unai_private.registry_transition_contracts()`, a
definer function in the style of `registry_snapshot()` that returns contract
content only for `decisions.record`. With neither, the review is refused
(`TRANSITION_CONTRACT_UNKNOWN`), never waved through.

## 7. The mentor surfaces goal-versus-calendar contradictions within the budget

The design draws the **Mentor contradiction card** screen but no mentor route
and no mentor entity. Two additions are recorded here as deliberate:

- **Route `GET /v1/mentor/contradictions`** under a new purpose
  `mentor.advise`.
- **Table `mentor_cards`**: every evaluation of a card, append-only, with its
  labelled evidence, inference and recommendation, the Context Broker packet it
  was composed from, and the interruption decision (ASK, BATCH or SUPPRESS), its
  reason and its logged policy inputs. The budget cannot be enforced without a
  record of what was already emitted, and no drawn entity can hold it:
  `interruption_decisions` requires a clarification card and
  `recommendation_artifacts` belongs to the draft and action workflow.

The rule (`mentor-contradictions-0.1.0`) is deliberately narrow and
evidence-proportional (PRD §4.9, §36.13, §37.7):

- **Evidence** is what the record shows: the goal as the owner stated it (with
  its priority history row) and the scheduled or attended calendar time in the
  observation window (28 days to now), read from a Context Broker packet and
  grouped by the life category the broker derives. Each evidence item names the
  packet objects it rests on.
- **Inference** is labelled as one: a goal whose effective priority is `HIGH`
  received less than 10% of the scheduled time while at least two calendar
  events were in the window (one event never supports a pattern). It carries
  its confidence and a counterexample search (the events that did fall in the
  goal's domain).
- **Recommendation** is labelled as one, proportional and non-coercive: make
  time for the goal or change its stated priority. It is never stored as an
  intent or an action.
- A temporary override that lowers the goal's priority is respected: no card.
- Every candidate goes through `@unai/review`'s `decideInterruption`, the same
  policy the Memory inbox uses, against **one shared budget**: the day's asked
  clarification cards and emitted mentor cards are counted together, per owner
  and per sensitivity scope (`<DOMAIN>/PRIVATE`), in both directions — the
  inbox now counts emitted mentor cards too. A goal is evaluated once per
  owner-local day (again only when the budget changes), so reloading spends no
  budget. Cards the budget withholds are recorded with their reason and shown
  as withheld, never emitted.

## 8. Purposes

`goals.read` (GET /v1/goals), `goals.manage` (POST /v1/goals,
PATCH /v1/goals/{id}/priority), `decisions.read` (GET /v1/decisions/{id}),
`decisions.record` (POST /v1/decisions, POST /v1/decisions/{id}/review),
`mentor.advise` (GET /v1/mentor/contradictions); GET /v1/projections/decisions
stays under `projection.read`. Memory is read through the broker under
`memory.read` and written under `memory.correct`, `memory.canonicalize` and
`memory.project`, each opened by server code, never from a header. The browser
reaches the three writes through the same-origin proxy; the priority change is
forwarded as the PATCH the API expects.

## 9. Not decided here

- Automatic acceptance of a decision or a review (governed transaction).
- Adding `decision_projection` to the broker's projection fragments, the lineage
  rebuild and the replay CLI default (§4).
- Spending-versus-goal contradictions: V0 has no required financial connector
  (design open decision), so the mentor reads calendar time only.
- The weekly review's "decisions versus outcomes" section still reports
  `NOT_AVAILABLE_IN_THIS_RELEASE`; it belongs to the weekly review node.
