# ADR 0020 — Resolution assertions, protocol links and the derived outcome projection

Status: accepted.
Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`resolution-assertions-links-and-outcome-projection`, and approved
contract-uai-v0/rev-uai-v0-001. Criteria: CRT-OUT-01-B, CRT-OUT-02-A,
CRT-OUT-03-A, CRT-OUT-04-A, CRT-OUT-05-A, CRT-OUT-08-A.
ADRs 0001–0019 were read and are retained unchanged.

## 1. Two new tables, and nothing added to an existing one

`migrations/0015_resolution_assertions_and_links.sql` adds `memory_links` and
`resolution_assertions` — the two design entities this node owns — with the
columns PRD §33.7 and §33.8 list. No column is added to `frame_instances`,
`belief_slots`, `propositions` or `claims`, and no existing row is ever written
by this slice.

That is the whole point. PRD §16.1 says resolution assertions are the *sole*
canonical outcome authority and §11.12 says there is no parallel `status`
predicate. Registry lint already refuses a frame contract that defines one
(CRT-OUT-01-A, another node's). If this migration had added a `resolved_at` or an
`outcome` column anywhere, the refusal in the registry would have been decorative:
the outcome would simply live in the schema instead of in a contract, and the two
records could disagree with nothing to arbitrate them.

## 2. Outcome state is derived on read, never stored

`frameOutcomeProjection` computes UNRESOLVED, PARTIALLY_RESOLVED, RESOLVED or
CONTESTED from the accepted `resolution_assertions` rows of one frame, every time
it is asked (PRD §16.6). There is no materialized outcome column and no cache.

A stored outcome would be a second authority again — the same argument as §1, one
level down. The typed projections that *do* materialize state
(`open_commitments_projection`, `obligations_projection`, `schedule_projection`)
belong to `typed-projections-replay-and-commitment-obligation-caps`, which
depends on this node; they will read this function rather than recompute the rule.

**Conflict is between settling codes only.** Two accepted assertions conflict when
they carry two *different* settling outcome codes: an event is not both OCCURRED
and CANCELLED, and an obligation is not both FULFILLED and WAIVED. A partial code
(`PARTIALLY_FULFILLED`, `PARTIALLY_CONFIRMED`) alongside a settling one is read as
a progression, not a contradiction, because "he paid half" followed by "he paid
the rest" is the ordinary history of an obligation and flagging it CONTESTED would
train the owner to ignore the flag. This reading is the deliberate part of
CRT-OUT-08-A and is the one place where the four states needed a judgement.

## 3. The transition contract arrives as data, not as a file read

`validateTransition` takes the pinned release's transition contracts as an
argument. `@unai/memory` does not import `@unai/registry`: that library reads Git,
spawns `git`, parses YAML and lints, and no deployed package imports it
(CRT-REG-01-B). The caller that pinned the release supplies its contracts, and
`transitionContractSchema` in `@unai/domain` is a non-strict object so the
release's own contract can be handed over unmodified — copying six fields out of
it by hand is exactly where the pinned release and the enforced rule would drift
apart.

An empty contract set therefore refuses every transition rather than permitting
one. `TRANSITION_CONTRACT_REQUIRED`, `TRANSITION_CONTRACT_UNKNOWN`,
`TRANSITION_LINK_KIND_REFUSED`, `TRANSITION_SOURCE_FRAME_TYPE_REFUSED`,
`TRANSITION_TARGET_REQUIRED`, `TRANSITION_TARGET_FRAME_TYPE_REFUSED` and
`TRANSITION_OUTCOME_REFUSED` are separate codes because "not allowed" does not
tell a reviewer whether the contract or the caller is wrong.

The schema holds the same line for every principal: `transition_contract_id` is
`NOT NULL` on `resolution_assertions`, and `memory_link_transition_named` makes a
REALIZES or RESOLVES link with no contract unrepresentable (CRT-OUT-04-A).

## 4. Link direction reads as the English does

A `memory_links` row means `from` *link kind* `to`: the actual occurrence REALIZES
the scheduled event, the actual occurrence RESOLVES the scheduled event. The
transition contract's own `sourceFrameTypes`/`targetFrameTypes` name the transition's
roles, not the row's direction — in `shared.event_occurrence.realization` the
*source* is the schedule being realized and the *target* is the actual occurrence.

Both conventions are defensible; mixing them is not. The rule chosen here is the
one CRT-OUT-03-A words directly ("creates an actual event_occurrence with REALIZES
and RESOLVES (OCCURRED) links"), so a reader of the criterion and a reader of the
row see the same arrow. A target-less settlement has no realizing object at all,
so the assertion itself is the `from` endpoint of its RESOLVES link.

## 5. A resolution statement creates no slot, and its claim carries no proposition

`canonicalizeResolutionStatement` shares no step with `canonicalizeClaim`. It
resolves no slot, creates no proposition and records its claim with
`proposition_id` null. "It is settled" is not a value in a slot of the obligation;
it is the assertion that an outcome occurred, and the outcome is the assertion row
(CRT-OUT-01-B, CRT-OUT-02-A).

`classifyResolutionStatement` answers `null` for anything it does not recognise,
and refuses a negated or not-yet-actual phrasing outright: reading "It is not
settled" as FULFILLED or "I will complete it" as a completion would invent the
outcome the sentence denies or defers (PRD §12.6, §58). A caller may pass an
explicit outcome code, but a code that disagrees with the classified statement is
refused rather than silently preferred.

## 6. Time passage is a read, not a write

`sweepElapsedSchedules` reports scheduled frames whose time has passed and creates
nothing: its `occurrencesCreated` and `resolutionsCreated` are typed as the
literal `0`, and the function body contains no `INSERT`. An event left on the
calendar past its date proves only that nobody edited the calendar (PRD §59,
CRT-OUT-03-A), and an expired due time never creates a FAILED or MISSED assertion
(PRD §12.6, CRT-OUT-07-A, which belongs to the projection node).

Writing the invariant as a function that returns zero, instead of leaving it as an
absence somebody has to notice, is what makes it testable.

## 7. Proposing an outcome is not accepting one

`resolution_assertions` is written under `memory.canonicalize`, `memory.govern` or
`memory.correct`, but its lifecycle may only be moved under `memory.govern` or
`memory.correct`, and `ACCEPTED` additionally requires the governed transaction id
(`RESOLUTION_ACCEPTANCE_REQUIRES_TRANSACTION`). A model may propose an outcome; a
model may not decide one (PRD §19.1, FR-040). The derived projection reads only
accepted rows, so a proposal never moves a frame off UNRESOLVED.

## 8. Advisory coverage is a nullable fraction nothing reads

`advisory_coverage` exists because PRD §16.7 allows a resolution link to carry a
capability's cached coverage. It is constrained to `[0,1]` so it cannot be mistaken
for a money amount, it is never summed, compared or defaulted anywhere in this
package, and `toStoredResolution` only converts it for display. The canonical
record stays the typed allocation amount in a `finance.payment_allocation` frame
(CRT-OUT-06-A, the projection node's criterion).

## 9. What a resolution said is immutable

`resolution_assertions_transition` and `memory_links_transition` refuse every
column change except `lifecycle` (and `metadata`), for the privileged migration
owner as well as for `unai_app`. Neither table takes a `DELETE` or `TRUNCATE`
grant. So the source proposition and frame a REALIZES or RESOLVES link speaks
about cannot be rewritten *through* the link either: the only write either table
offers is an append (FR-035, CRT-OUT-03-A, CRT-OUT-05-A).

## 10. Known gap: the pinned release declares no prediction transition

Registry release 0.1.0 contains four frames and four transitions; none of them
allows `CONFIRMED`, `REFUTED` or `PARTIALLY_CONFIRMED`, and no frame in it admits
PREDICTED modality. CRT-OUT-05-A needs a prediction review to be resolvable with
exactly those codes.

Releases are immutable (PRD §42) and the release contents belong to
`registry-loader-lint-release-0-1-0-and-base-contexts`, so this node adds no file
to `registry/releases/0.1.0` and publishes no 0.2.0. The store validates against
whatever contracts the caller pins, and `resolutions.test.ts` supplies a
prediction-review contract in the registry's own shape alongside the release's
real ones — while asserting that the *pinned* contracts refuse those three codes,
so the gap is visible in the suite instead of papered over. It is reported as a
finding for the node that owns the registry contracts.
