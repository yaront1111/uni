Agreed. All five seams are real, and I’ve folded them into a **leaner, buildable V0 registry bundle** rather than extending the abstract kernel specification again.
Yes. These are structural holes, not edge cases. One correction to invariant 29: **surrogate identifiers and their lineage must survive; fingerprints are allowed to change.** A merged or split object must never disappear or be silently repurposed.

The specification below folds in all five points and should replace the identity, modality-transition, registry-governance, and session-overlay portions of the earlier PRD.

# Uai Canonical Proposition and Belief-Key Specification

**Document type:** Technical architecture specification
**Version:** 0.1
**Status:** Proposed canonical design
**Date:** August 13, 2026
**Product:** Uai
**Component:** Memory Kernel
**Depends on:** Uai Universal Memory System PRD
**Supersedes:** Earlier proposition-key, semantic-context, modality-transition, instance-merge, and session-overlay definitions

---

## 1. Purpose

This specification defines how Uai determines:

* Whether two extractions describe the same real-world situation.
* Whether two claims express the same proposition.
* Whether two propositions compete for the same belief slot.
* How future, intended, scheduled, predicted, and actual claims relate.
* How instance merges and splits affect downstream memory.
* How canonical predicates enter and evolve within the registry.
* How user corrections become visible immediately across devices.
* How typed projections preserve read-your-writes consistency.
* How evidence extracted under old models or registry versions is reconsidered.

The fundamental design decision is:

> **Natural-language extraction may remain open-ended, but accepted belief identity must be governed by a versioned semantic registry.**

The kernel does not attempt to solve unrestricted semantic equivalence.

It solves a narrower engineering problem:

```text
Can this surface extraction be normalized into a registered frame,
registered predicate, stable context space, and deterministic identity rule?
```

When the answer is no, Uai preserves the evidence without forcing a false canonical identity.

---

## 2. Architectural boundary

Uai has three semantic layers.

### 2.1 Open evidence layer

Contains:

* Raw emails.
* Conversations.
* Calendar events.
* Transactions.
* Documents.
* GitHub events.
* Surface predicates.
* Extracted phrases.
* Alternative extraction runs.

This layer may contain inconsistent vocabulary:

```text
owe
debt_to
borrowed_from
must_repay
money_for_dinner
```

No deterministic current-state behavior is expected from this layer.

### 2.2 Canonical belief layer

Contains only registered semantic structures:

```text
shared.obligation
shared.obligation.debtor
shared.obligation.creditor
shared.obligation.principal_amount
```

Only this layer may participate in:

* Current-state selection.
* Proposition collision.
* Conflict detection.
* Supersession.
* Cross-modality resolution.
* Typed projection updates.
* Governed external actions.

### 2.3 Capability projection layer

Contains rebuildable typed views such as:

```text
open_commitments_projection
financial_transactions_projection
obligations_projection
calendar_occurrences_projection
project_work_items_projection
```

These projections are not independent truth stores.

They are derived from:

* Canonical propositions.
* Belief status.
* Resolution links.
* Valid time.
* User overlay deltas.

The complete boundary is:

```text
Open evidence
    ↓
Canonical registry normalization
    ↓
Transactional belief graph
    ↓
Typed capability projections
```

---

## 3. Identity is never a hash

Every durable memory object uses a surrogate identifier.

Recommended format:

```text
UUIDv7
```

This applies to:

* Frame instances.
* Context spaces.
* Belief slots.
* Propositions.
* Claims.
* Resolution links.
* Registry entries.
* Registry releases.
* Belief transactions.
* Projection versions.

Hashes are used only as:

* Candidate lookup indexes.
* Duplicate-detection hints.
* Cache keys.
* Migration comparison tools.

A hash must never be the authoritative identity of a proposition or slot.

### 3.1 Reason

A semantic fingerprint can change when:

* Two frame instances are merged.
* One frame instance is split.
* A predicate is normalized differently.
* A registry keying rule changes.
* An entity alias is resolved.
* A unit is normalized.
* A context branch is corrected.
* A role moves from optional to identity-defining.

If the hash were the object identity, those changes would invalidate all downstream references.

### 3.2 Required invariant

> A semantic object may be aliased, rehomed, merged, split, or retired, but its identifier must remain resolvable through lineage.

An identifier must never silently begin referring to a different proposition.

---

## 4. Core memory identities

Uai uses five distinct identity levels.

### 4.1 Frame type

A registered class of situation.

Examples:

```text
shared.obligation
shared.transaction
shared.scheduled_event
shared.commitment
work.pull_request
finance.account
```

A frame type defines:

* Roles.
* Identity strategy.
* Allowed predicates.
* Temporal behavior.
* Valid modality transitions.
* Merge and split policy.

### 4.2 Frame instance

A particular real-world situation.

Examples:

```text
The specific ₪50 obligation involving Yaron and Daniel.
A specific bank transaction.
A particular calendar occurrence.
A specific employment relationship.
One GitHub pull request.
```

A frame instance has a surrogate `frame_instance_id`.

It is not derived from the participants alone.

Two obligations may involve the same people and amount while remaining separate instances.

### 4.3 Belief slot

A governed location in which compatible values may:

* Agree.
* Conflict.
* Correct one another.
* Supersede one another over time.

Example:

```text
Frame instance: obligation O1
Predicate: principal_amount
Context space: base world
Modality: actual
Qualifiers: none
```

The slot excludes the value.

Therefore:

```text
O1 principal amount = ₪50
O1 principal amount = ₪60
```

occupy the same slot.

### 4.4 Proposition

One exact normalized candidate value within a slot.

Examples:

```text
O1 principal amount = 50 ILS
O1 principal amount = 60 ILS
```

Each has a surrogate `proposition_id`.

### 4.5 Claim

A specific source assertion or observation supporting, contradicting, or otherwise relating to a proposition.

Examples:

```text
Yaron stated that O1 was ₪50.
Daniel stated that O1 was ₪70.
A document extracted under model version X stated ₪50.
```

Claims remain distinct even when they refer to the same proposition.

---

## 5. Closed semantic dimensions

The earlier field `semantic_context` is removed.

It is replaced by two explicit, closed dimensions:

1. `context_space_id`
2. `modality`

Neither may contain extractor-generated free text.

---

## 6. Context spaces

A context space determines which conceptual world a proposition belongs to.

Every context space has:

```text
context_space_id
context_kind
owner_scope
parent_context_space_id
creation_transaction_id
lifecycle_status
```

### 6.1 Closed context kinds

Initial kernel-supported values:

| Context kind     | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `BASE`           | Normal claims about the user’s real world                   |
| `SCENARIO`       | A possible future or decision scenario                      |
| `COUNTERFACTUAL` | An alternative to what actually happened                    |
| `QUOTED`         | Nested content inside a quoted or attributed representation |
| `SIMULATION`     | Tool-generated or model-generated sandbox world             |
| `TEST`           | Evaluation-only context                                     |

The extractor cannot invent new context kinds.

A registry migration is required to add one.

### 6.2 Base-world behavior

Normal personal memory uses one base-world context per ownership scope.

A third-party assertion such as:

```text
Daniel says Yaron owes ₪50.
```

does not automatically require a separate `QUOTED` context.

It is normally represented as:

```text
Proposition:
The obligation is ₪50 in the base world.

Claim:
Daniel asserted the proposition.

Belief status:
Provisional, accepted, or contested depending on authority and support.
```

The source assertion and accepted truth remain separate.

### 6.3 Quoted context

`QUOTED` is used only when Uai needs to model nested content as its own internal world.

Example:

```text
Daniel believes that Yaron still owes him.
```

A quoted context may preserve Daniel’s represented belief without promoting it into the base world.

No proposition may move from a quoted, simulated, counterfactual, or scenario context into the base world without an explicit governed bridge transaction.

### 6.4 Keying requirement

The belief slot uses `context_space_id`, not a free-text context label.

Two extractor runs cannot silently create different context values for the same base-world proposition.

---

## 7. Modalities

Modality describes how a proposition relates to actuality.

Initial canonical modalities:

| Modality      | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `ACTUAL`      | Asserted to currently or historically exist or occur      |
| `SCHEDULED`   | Placed on a schedule but not yet proven to occur          |
| `INTENDED`    | Planned by an actor                                       |
| `COMMITTED`   | Promised or undertaken as an obligation                   |
| `EXPECTED`    | Anticipated without a formal prediction model             |
| `PREDICTED`   | Forecast with an implied or explicit evaluation criterion |
| `RECOMMENDED` | Proposed as an advisable action                           |
| `CONDITIONAL` | Applicable only if a stated condition becomes true        |

The following are not modalities:

```text
Reported
Accepted
Provisional
User-confirmed
Inferred
Contested
```

Those belong to claim origin or belief status.

### 7.1 Time and modality are independent

A proposition with a future valid time is not necessarily a prediction.

Examples:

```text
Scheduled meeting tomorrow:
Modality = SCHEDULED

User promises to pay tomorrow:
Modality = COMMITTED

Uai estimates payment will happen tomorrow:
Modality = PREDICTED
```

All three refer to the future but represent different semantics.

---

## 8. Registry contract

The canonical registry contains three major contract types:

1. Frame contracts.
2. Predicate contracts.
3. Transition contracts.

---

## 9. Frame contract

Every active frame type must define:

```text
frame_type_id
canonical_name
namespace
owning_team
semantic_description
role_schema
identity_strategy
identity_roles
identity_qualifiers
temporal_shape
merge_policy
split_policy
allowed_predicates
registry_version
lifecycle_status
```

### 9.1 Identity strategies

Supported initial strategies:

| Strategy             | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `EXTERNAL_KEY`       | External system provides a stable identifier                          |
| `SINGLETON_ROLE_SET` | One instance exists for a governed role combination                   |
| `EVENT_OCCURRENCE`   | Instance is identified by event series, time, and occurrence identity |
| `EXPLICIT_INSTANCE`  | Source explicitly indicates a new instance                            |
| `LATENT_CLUSTER`     | Instance must be inferred from contextual evidence                    |
| `DOCUMENT_ANCHOR`    | Instance is anchored to a stable document section or record           |

Examples:

```text
GitHub PR:
EXTERNAL_KEY using repository + PR number.

Calendar occurrence:
EVENT_OCCURRENCE using calendar event ID + recurrence instance.

Date of birth:
SINGLETON_ROLE_SET for one person.

Daniel obligation:
LATENT_CLUSTER unless a formal invoice or transaction ID exists.
```

### 9.2 Identity roles versus descriptive roles

Identity roles determine whether two extractions may describe the same instance.

Descriptive roles do not.

For an obligation:

```text
Potential identity roles:
debtor
creditor
origin event
external reference
creation period

Descriptive roles:
current amount
due date
reminder count
status
```

The amount should normally not define the instance because it may later be corrected.

---

## 10. Predicate contract

Every active predicate must define:

```text
predicate_id
canonical_name
namespace
frame_type_id
value_type
unit_normalizer
cardinality
slot_qualifiers
temporal_behavior
conflict_behavior
supersession_behavior
authority_policy
projection_contracts
registry_version
lifecycle_status
```

### 10.1 Cardinality

Initial values:

| Cardinality    | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `FUNCTIONAL`   | At most one accepted value for an overlapping valid period |
| `SET`          | Several values may coexist                                 |
| `ORDERED_SET`  | Several ordered values may coexist                         |
| `EVENT`        | Every occurrence is distinct                               |
| `ACCUMULATIVE` | Values contribute to an aggregate                          |
| `DERIVED`      | Value is computed from other propositions                  |

`WITHOUT OVERLAPS` or equivalent temporal constraints may only be applied to predicates explicitly declared `FUNCTIONAL`.

### 10.2 Slot qualifiers

Slot qualifiers distinguish values that share a predicate but apply under different governed dimensions.

Example:

```text
Employment compensation
qualifier: compensation_type

base_salary
bonus_target
equity_grant
```

Qualifiers are:

* Registry-declared.
* Typed.
* Canonically normalized.
* Never free-text extractor output.

### 10.3 Value normalization

The registry must define exact normalization rules.

Examples:

```text
₪50 → 50 ILS
50 shekels → 50 ILS
2026-08-13 Europe/Jerusalem → canonical UTC instant plus original timezone
“Yaron” → entity UUID after entity resolution
```

A normalized value must preserve its original representation in provenance.

---

## 11. Belief-slot identity

A belief slot has a stable surrogate `belief_slot_id`.

Its current descriptor is:

```json
{
  "frame_instance_id": "uuid",
  "predicate_id": "uuid",
  "context_space_id": "uuid",
  "modality": "ACTUAL",
  "qualifiers": {}
}
```

The slot value is deliberately excluded.

### 11.1 Slot lookup fingerprint

A versioned lookup fingerprint may be calculated as:

```text
H(
  registry_release_id,
  canonical_frame_instance_reference,
  predicate_id,
  context_space_id,
  modality,
  canonical_qualifiers
)
```

This fingerprint:

* Finds potential matching slots.
* Does not establish identity.
* May change after merge, split, or registry migration.
* Must store the registry and normalization versions used.
* May return several candidates.

A fingerprint collision triggers comparison, not automatic merge.

### 11.2 Slot creation outcomes

Canonicalization returns:

```text
MATCH_EXISTING_SLOT
CREATE_NEW_SLOT
POSSIBLE_SLOT_MATCH
BLOCK_CANONICALIZATION
```

`POSSIBLE_SLOT_MATCH` must preserve ambiguity.

It may not silently choose a slot merely to avoid duplication.

---

## 12. Proposition identity

A proposition has a stable surrogate `proposition_id`.

Its semantic descriptor is:

```json
{
  "belief_slot_id": "uuid",
  "normalized_value": {},
  "polarity": "POSITIVE"
}
```

### 12.1 Proposition lookup fingerprint

A versioned fingerprint may use:

```text
H(
  current_slot_semantic_descriptor,
  normalized_value,
  polarity,
  normalization_version
)
```

It is used for:

* Candidate duplicate detection.
* Support aggregation.
* Migration comparison.
* Re-extraction diffs.

It is not the proposition’s primary identity.

### 12.2 Equivalent propositions

Two propositions may become recognized as equivalent after:

* Unit normalization.
* Entity merge.
* Frame-instance merge.
* Predicate migration.
* Value canonicalization.

Uai may create:

```text
equivalent_to
canonical_alias_of
merged_into
```

relationships between propositions.

The original proposition IDs remain resolvable.

---

## 13. Claim identity

A claim records one specific interpretation of one source anchor.

It includes:

```text
claim_id
source_item_id
source_anchor
extraction_run_id
asserted_by
proposition_id
claim_origin
valid_time
recorded_time
extraction_confidence
entity_resolution_confidence
temporal_resolution_confidence
lifecycle_status
```

### 13.1 Re-extraction

Re-extracting the same evidence under a newer model creates a new claim.

It does not mutate the old claim.

The claims are related through:

```text
alternative_interpretation_of
supersedes_interpretation
compatible_with
contradicts_interpretation
```

A claim is an interpretation of evidence, not the evidence itself.

---

## 14. Frame-instance matching

Frame-instance identity is the hardest unresolved inference problem in the system.

The kernel does not pretend it can eliminate that uncertainty.

It provides governed matching outcomes.

### 14.1 Matching signals

A matcher may consider:

* External identifiers.
* Shared entities.
* Explicit linguistic references.
* Temporal compatibility.
* Shared conversation or thread.
* Shared source document.
* Shared origin event.
* Semantic similarity.
* Previously accepted links.
* Amount and unit compatibility.
* Terms such as “another,” “same,” “that one,” or “the remaining.”
* Capability-specific matching rules.

### 14.2 Matching outcomes

```text
CONFIRMED_MATCH
PROBABLE_MATCH
POSSIBLE_MATCH
CONFIRMED_DISTINCT
NEW_INSTANCE
```

Only `CONFIRMED_MATCH` may automatically reuse an instance for material state changes.

`PROBABLE_MATCH` may:

* Attach a provisional claim.
* Create a proposed link.
* Enter batch review.
* Wait until query time.

### 14.3 Under-merge default

> When Uai cannot safely determine that two frame extractions describe the same instance, it keeps them separate.

Temporary duplication is preferable to silently combining unrelated obligations, people, decisions, or transactions.

---

## 15. Governed instance merge

An instance merge is a belief transaction.

It must never be an in-place database shortcut.

### 15.1 Merge transaction

The transaction contains:

```text
source_instance_ids
surviving_or_new_instance_id
reason
supporting_claims
requested_by
registry_version
affected_slots
affected_propositions
affected_projections
```

### 15.2 Merge procedure

1. Select an existing survivor or create a new canonical instance.
2. Mark source instances as lineage members of the canonical instance.
3. Rehome slot descriptor versions to the canonical instance.
4. Recompute slot lookup fingerprints.
5. Detect newly colliding slots.
6. Merge or alias equivalent slots through separate governed operations.
7. Detect duplicate propositions.
8. Alias equivalent propositions while preserving their claims.
9. Recalculate support, conflict, and current-state projections.
10. Rebuild affected typed capability projections.
11. Preserve all original identifiers and lineage.

### 15.3 No silent repurposing

If two objects are merged, their old IDs may resolve to the new canonical object.

They must not be reused for another meaning.

---

## 16. Governed instance split

A split is also a belief transaction.

Example:

```text
Uai believed two Daniel obligations were one.
The user clarifies that they were separate.
```

### 16.1 Split procedure

1. Create the required new frame instances.
2. Identify which claims and evidence support each instance.
3. Reassign proposition and slot descriptor versions where semantically safe.
4. Create new slots where one old slot contained values from different situations.
5. Preserve the old instance as a lineage parent or retired mistaken cluster.
6. Mark ambiguous claims as contested rather than assigning them arbitrarily.
7. Recalculate beliefs.
8. Rebuild all affected projections.

### 16.2 Stable-reference requirement

A split may require an old slot or proposition to become:

```text
retired
ambiguous_parent
split_into
```

Its identifier remains resolvable and explains what happened.

The system must never make the ID disappear.

---

## 17. Cross-modality resolution

Cross-modality resolution is a kernel primitive.

It is not left entirely to each capability.

The kernel defines two protocol-level links:

1. `REALIZES`
2. `RESOLVES`

---

## 18. `REALIZES` link

`REALIZES` states that a target proposition or frame instance is a real-world manifestation of a prior non-actual proposition.

Examples:

```text
Actual meeting occurrence REALIZES scheduled meeting.
Actual payment REALIZES intended payment.
Actual document submission REALIZES committed submission.
```

### 18.1 Semantics

`REALIZES`:

* Connects source and outcome.
* Does not rewrite the source proposition.
* Does not automatically mark the source fulfilled.
* May be partial.
* May be one-to-many.
* May be many-to-one.
* Requires provenance.
* Must obey a registry transition contract.

A scheduled meeting remains historically scheduled even after it occurs.

---

## 19. `RESOLVES` link

`RESOLVES` states that the target establishes an outcome for the source proposition or frame.

Examples:

```text
Payment resolves obligation as fulfilled.
Cancellation resolves scheduled event as cancelled.
Actual result resolves prediction as confirmed or refuted.
Completed pull request resolves commitment as fulfilled.
```

### 19.1 Resolution record

```json
{
  "resolution_link_id": "uuid",
  "source_proposition_id": "uuid",
  "target_proposition_id": "uuid",
  "link_kind": "RESOLVES",
  "outcome_code": "FULFILLED",
  "coverage": 1.0,
  "effective_at": "timestamp",
  "status": "ACCEPTED",
  "transition_contract_id": "uuid",
  "supporting_claim_ids": [],
  "creation_transaction_id": "uuid"
}
```

### 19.2 Initial protocol outcome classes

Registry entries may select from or extend these governed classes:

```text
FULFILLED
PARTIALLY_FULFILLED
OCCURRED
OCCURRED_MODIFIED
CANCELLED
FAILED
MISSED
EXPIRED_UNRESOLVED
CONFIRMED
REFUTED
PARTIALLY_CONFIRMED
SUPERSEDED_BY_OUTCOME
```

The concrete allowed outcomes are defined per transition contract.

### 19.3 Resolution state

The source proposition’s outcome state is a derived projection:

```text
UNRESOLVED
PARTIALLY_RESOLVED
RESOLVED
CONTESTED
```

The proposition itself is not changed.

### 19.4 Conflicting outcomes

Two sources may disagree about the outcome.

Example:

```text
Calendar suggests meeting occurred.
User says it was cancelled.
```

Both resolution claims remain.

The outcome state becomes `CONTESTED` until resolution.

---

## 20. Transition contracts

Every valid automatic or governed transition must be registered.

A transition contract contains:

```text
transition_contract_id
source_frame_type
source_predicate_or_frame
source_modality
target_frame_type
target_predicate_or_frame
target_modality
allowed_link_kind
allowed_outcome_codes
coverage_behavior
temporal_constraints
authority_requirements
evaluator_capability
closure_behavior
registry_version
lifecycle_status
```

### 20.1 Examples

#### Scheduled event to actual occurrence

```text
Source:
shared.scheduled_event
SCHEDULED

Target:
shared.event_occurrence
ACTUAL

Link:
REALIZES

Resolution:
OCCURRED, OCCURRED_MODIFIED, CANCELLED, MISSED
```

#### Prediction to actual measurement

```text
Source:
shared.prediction
PREDICTED

Target:
shared.measurement
ACTUAL

Link:
RESOLVES

Resolution:
CONFIRMED, REFUTED, PARTIALLY_CONFIRMED
```

#### Commitment to completed action

```text
Source:
shared.commitment
COMMITTED

Target:
shared.event_occurrence
ACTUAL

Links:
REALIZES and RESOLVES

Resolution:
FULFILLED, PARTIALLY_FULFILLED, FAILED, EXPIRED_UNRESOLVED
```

#### Payment to obligation

```text
Source:
shared.obligation
ACTUAL

Target:
shared.transaction
ACTUAL

Link:
RESOLVES

Resolution:
FULFILLED, PARTIALLY_FULFILLED
```

This last transition is cross-frame even though both propositions use `ACTUAL`.

Therefore resolution is broader than modality transition alone.

### 20.2 Capability responsibility

The kernel validates the contract and stores the link.

The capability determines domain-specific correspondence.

Example:

```text
The kernel understands that a resolution link is allowed.

The financial capability determines whether:
- the payment belongs to this obligation,
- the amount covers it,
- the extra amount is unallocated,
- the settlement is partial or complete.
```

---

## 21. Registry namespaces and ownership

The registry is a product subsystem, not a static configuration file.

Initial namespace model:

| Namespace     | Owner                                |
| ------------- | ------------------------------------ |
| `core.*`      | Memory kernel                        |
| `shared.*`    | Cross-capability semantic governance |
| `finance.*`   | Financial capability                 |
| `work.*`      | Work capability                      |
| `family.*`    | Family capability                    |
| `health.*`    | Health capability                    |
| `connector.*` | Source-specific representations      |

### 21.1 Shared concept rule

A concept used by more than one capability must be promoted into `shared.*`.

For example:

```text
obligation
commitment
person
organization
scheduled_event
document_requirement
```

Finance and commitments may both use `shared.obligation`.

Neither may create competing canonical definitions merely for local convenience.

### 21.2 Capability-local predicates

A capability may maintain specialized predicates in its namespace.

Example:

```text
finance.obligation.tax_treatment
work.commitment.review_required
```

These may reference shared frames while remaining capability-owned.

### 21.3 Ownership collision

When two capabilities propose overlapping semantics:

1. Registry linter detects structural overlap.
2. Both entries remain in shadow state.
3. A shared semantic contract is proposed.
4. Existing capability predicates become aliases or specializations.
5. A migration plan is required before activation.

---

## 22. Registry lifecycle

Every registry entry follows a governed lifecycle.

```text
OBSERVED
    ↓
CANDIDATE
    ↓
PROPOSED
    ↓
SHADOW
    ↓
ACTIVE
    ↓
DEPRECATED
    ↓
RETIRED
```

### 22.1 Observed unknown

An unknown surface structure has appeared in evidence.

It remains searchable but non-canonical.

### 22.2 Candidate

Uai detects repeated stable structure.

Candidate signals may include:

* Appears across several sources.
* Uses consistent roles.
* Is repeatedly retrieved.
* Produces user corrections.
* Blocks useful current-state reasoning.
* Is used by more than one capability.
* Has low surface ambiguity.

### 22.3 Proposed

A complete semantic contract is authored:

* Stable name.
* Frame family.
* Roles.
* Identity rules.
* Slot key rules.
* Value schema.
* Temporal behavior.
* Transition rules.
* Source authority.
* Projection consumers.
* Tests.

### 22.4 Shadow

The proposed entry operates in parallel.

It may:

* Normalize new evidence.
* Reprocess a sample of old evidence.
* Calculate candidate collisions.
* Produce projection diffs.
* Measure false merges and splits.

It may not alter accepted current state or authorize actions.

### 22.5 Active

The entry becomes canonical after passing tests and review.

### 22.6 Deprecated

New extraction no longer uses the entry, but old references remain valid.

### 22.7 Retired

The entry is historical only.

Its identifier is never reused.

---

## 23. Registry versioning and migrations

A registry release is immutable.

Changes are classified as:

| Change class          | Example                                              |
| --------------------- | ---------------------------------------------------- |
| Additive              | Add a surface alias                                  |
| Compatible behavioral | Improve normalization without changing slot identity |
| Identity-affecting    | Change identity roles or slot qualifiers             |
| Transition-affecting  | Change allowed resolution behavior                   |
| Breaking              | Split or merge canonical semantic concepts           |

Identity-affecting and breaking changes require:

* Shadow evaluation.
* Migration plan.
* Re-extraction policy.
* Slot and proposition diff.
* Projection rebuild.
* Rollback strategy.
* Registry-version pinning in tests.

### 23.1 Unknown-predicate promotion

Unknown predicates must have a measurable promotion path.

The system should track:

```text
occurrence count
distinct source count
distinct user count
retrieval count
manual correction count
stable role-shape score
candidate canonical matches
capability demand
```

This prevents unknown concepts from remaining permanently second-class merely because a developer has not noticed them.

---

## 24. Per-user causal overlay

The prior session-only ledger is replaced by a **User Causal Overlay**.

The scope is:

```text
memory principal / owner
```

not browser session or device.

For an individual user, phone and desktop share one overlay.

Shared family or team spaces receive their own owner-scoped overlay.

### 24.1 Sequence model

Every direct user write receives a monotonic owner sequence:

```text
owner_scope_id
owner_sequence
source_session_id
source_device_id
source_evidence_id
```

Session and device IDs remain audit metadata only.

They do not define visibility.

### 24.2 Overlay statuses

```text
RECEIVED
USER_ASSERTED
CANONICALIZATION_PENDING
COMMITTED
CONTESTED
REJECTED_AS_INTERPRETATION
WITHDRAWN
SUPERSEDED
```

### 24.3 Immediate guarantee

> Once Uai acknowledges a direct user assertion, correction, confirmation, or deletion request, all subsequent reads for that owner must observe it.

This is a causal read-your-writes guarantee.

It applies across:

* Conversations.
* Devices.
* Context Broker calls.
* Typed projection reads.
* Mentor reviews.
* Draft generation.

### 24.4 What is immediately trusted

The system can immediately trust:

```text
The user made this assertion.
```

It may not yet trust:

```text
The asserted world-state is independently verified.
```

Example:

```text
User:
“My salary changed to ₪55,000.”
```

The overlay immediately contains:

```text
Yaron directly asserted that salary is now ₪55,000.
```

The next answer must use or acknowledge that assertion.

Canonical validation may later discover conflicting payroll evidence.

---

## 25. Overlay application to projections

Applying the overlay only to graph retrieval is insufficient.

Each typed projection has a canonical watermark:

```text
projection_version
canonical_transaction_sequence
owner_overlay_sequence
reducer_version
```

The effective read is:

```text
Effective projection =
persisted projection snapshot
+ committed canonical transactions after snapshot watermark
+ applicable owner overlay deltas after overlay watermark
- retractions and supersessions
```

### 25.1 Capability requirement

Every capability projection must provide one of:

1. An incremental `apply_delta` reducer.
2. A bounded replay method.
3. An explicit declaration that it cannot safely apply pending overlays.

### 25.2 Unsupported pending delta

When a projection cannot apply a pending delta:

* It must not silently return stale state.
* It returns its persisted state plus the relevant pending assertion.
* It marks the projection as incomplete.
* High-risk actions are blocked.
* Conversational answers explain the temporary conflict where material.

Example:

```text
Projection:
Open obligation to Daniel: ₪50

Pending user overlay:
User says it was paid today.

Effective answer:
“You just told me it was paid. The obligations projection has not yet
incorporated that update, so I’ll treat it as paid for this conversation
but not as independently reconciled.”
```

---

## 26. Failed overlay validation

A user-visible delta may later fail canonical validation.

It must not silently disappear.

### 26.1 Required transition

```text
CANONICALIZATION_PENDING
    ↓
CONTESTED
```

The system records:

* Why validation failed.
* Which evidence conflicts.
* Which prior answers used the delta.
* Whether user attention is required.
* Which projections are affected.

### 26.2 Example

```text
User:
“I paid Daniel ₪60.”

Later bank reconciliation:
No matching transaction exists, and Daniel says payment was not received.
```

Uai must retain:

```text
Yaron reported paying Daniel.
```

The accepted base-world belief may become contested.

Uai should not erase the statement or pretend it was never used.

### 26.3 Answer lineage

Answers based on pending or contested deltas should retain internal lineage:

```text
answer_id
belief_ids
overlay_delta_ids
projection_versions
```

This allows Uai to identify which previous conclusions may need reconsideration.

---

## 27. Re-extraction policy

Evidence is immutable.

Interpretation is versioned.

Every extraction run records:

```text
extractor_model_version
prompt_version
registry_release_id
normalization_version
entity_resolver_version
temporal_resolver_version
run_timestamp
```

### 27.1 Re-extraction outcomes

A new run may produce:

```text
same canonical proposition
new supporting claim
alternative proposition
new frame-instance candidate
new slot candidate
registry-unknown surface frame
```

It may not silently overwrite the earlier claim.

### 27.2 Registry-driven re-extraction

Registry activation may trigger:

* Lazy re-extraction on read.
* Targeted backfill for active worldlines.
* Targeted backfill for affected predicates.
* Shadow re-extraction over a sample.
* Full backfill only for structural migrations.

### 27.3 User-confirmed anchors

A user-confirmed correction is a protected evidence anchor.

A new extractor may:

* Support it.
* Conflict with it.
* Propose a different interpretation.

It may not silently reverse it.

---

## 28. Worked example: Daniel obligation

### 28.1 First statement

```text
“I owe Daniel ₪50.”
```

Open extraction:

```text
surface predicate: owe
roles:
  person_owing: Yaron
  person_owed: Daniel
  amount: 50 shekels
```

Canonicalization:

```text
frame type:
shared.obligation

frame instance:
O1

roles:
debtor = Yaron
creditor = Daniel

slot:
O1 / shared.obligation.principal_amount / BASE / ACTUAL

proposition:
50 ILS
```

The user claim supports the proposition.

### 28.2 Alternative wording

```text
“I borrowed ₪50 from Daniel.”
```

Surface predicate:

```text
borrowed_from
```

Registry normalization maps it to the same frame family and roles.

Instance matching considers:

* Same people.
* Same amount.
* Same active conversation.
* No “another” signal.
* Compatible valid time.

Possible result:

```text
CONFIRMED_MATCH to O1
```

The new claim supports the existing proposition.

### 28.3 Second obligation

```text
“Daniel lent me another ₪50 yesterday.”
```

The word “another” and separate time signal a new instance:

```text
O2
```

The proposition has the same normalized amount but a different frame instance and slot.

No collision occurs.

### 28.4 Reminder

Daniel sends:

```text
“Don’t forget the ₪50.”
```

The email proves:

```text
Daniel asserted that payment remains expected.
```

It may provisionally support the unresolved status of O1.

It does not change the principal amount.

### 28.5 Payment

A bank transaction shows:

```text
₪60 sent to a Daniel-like counterparty.
```

Canonical transaction proposition:

```text
Transaction T1 amount = 60 ILS
Transaction T1 occurred = actual
```

Candidate semantic link:

```text
T1 may relate to O1.
```

No resolution is committed because:

* Counterparty identity is not fully confirmed.
* Purpose is unknown.
* Amount differs.
* O2 may also exist.

### 28.6 User confirmation

```text
“Yes, that was repayment of the first debt.”
```

The user overlay immediately records the assertion across devices.

Canonical processing creates:

```text
T1 allocated amount to O1 = 50 ILS
T1 RESOLVES O1 as FULFILLED
coverage = 1.0
```

The extra ₪10 remains unclassified.

It is not automatically assigned to:

* Interest.
* Gift.
* O2.
* Credit balance.

### 28.7 Later instance merge

Suppose O2 was mistakenly created and the user says:

```text
“There was only one debt. Both messages referred to the same one.”
```

A governed merge transaction:

1. Merges O2 into O1.
2. Preserves both instance IDs through lineage.
3. Rehomes O2 slots.
4. Detects equivalent amount propositions.
5. Aliases duplicates.
6. Recalculates support.
7. Rebuilds obligation projections.
8. Keeps all earlier answers explainable.

No primary identifier is recalculated from a hash.

---

## 29. Worked example: scheduled meeting

### 29.1 Calendar event

```text
Meeting scheduled for Friday at 10:00.
```

Stored as:

```text
Frame: scheduled event S1
Modality: SCHEDULED
```

### 29.2 Meeting occurs

A transcript or user confirmation establishes:

```text
Event occurrence E1 happened Friday at 10:03.
```

Links:

```text
E1 REALIZES S1
E1 RESOLVES S1 with OCCURRED
```

The schedule remains historically scheduled.

It is not rewritten into an actual event.

### 29.3 Meeting cancelled

Instead, an email may establish cancellation.

```text
Cancellation proposition C1
C1 RESOLVES S1 with CANCELLED
```

No actual occurrence is created.

### 29.4 Conflict

Calendar metadata suggests the event remained scheduled, but the user says it was cancelled.

The calendar proves scheduling, not occurrence.

The user assertion may resolve the outcome as cancelled.

No contradiction exists merely because the event remained on the calendar.

---

## 30. Worked example: prediction

### 30.1 Prediction

```text
“Project X will probably ship by September 30.”
```

Stored as:

```text
Frame: prediction P1
Modality: PREDICTED
Evaluation date: September 30
```

### 30.2 Actual result

A release event occurs October 12.

```text
Actual release R1
```

The project capability evaluates the prediction under its registered rule.

```text
R1 RESOLVES P1 with REFUTED
```

The original prediction remains intact.

Uai can later compare:

```text
What was predicted
What happened
Why the prediction failed
```

---

## 31. Build order

### Phase 0: Real-data acceptance harness

Before freezing keying rules, ingest a narrow read-only slice from one real connector.

Recommended first connector:

```text
Gmail
```

Reason:

* Messy language.
* Repeated statements.
* Quoted history.
* Corrections.
* Deadlines.
* Multiple people with similar names.
* Thread continuity.
* Commitments.
* Ambiguous references.

Initial dataset:

* A bounded sample of user-selected or recent threads.
* Tier-0 metadata extraction.
* Tier-1 memory-worthiness routing.
* Manual gold labels for a subset.
* No external actions.
* Strong privacy controls.

Acceptance cases should include:

* Same proposition expressed with different verbs.
* Same people involved in multiple separate situations.
* Forwarded or quoted text.
* A corrected amount.
* A changed deadline.
* A reminder that does not change state.
* A planned action later completed.
* A thread discussing a hypothetical scenario.
* An ambiguous pronoun.
* Two people sharing the same first name.

Synthetic tests remain useful, but no identity or collision rule may be accepted solely on synthetic sentences.

### Phase 1: Registry and identity kernel

Build:

* Frame registry.
* Predicate registry.
* Context spaces.
* Closed modalities.
* Frame-instance matcher.
* Surrogate slots.
* Surrogate propositions.
* Versioned fingerprints.
* Merge and split transactions.

### Phase 2: Resolution protocol

Build:

* `REALIZES`.
* `RESOLVES`.
* Transition contracts.
* Outcome state.
* Conflicting resolution handling.

### Phase 3: User causal overlay

Build:

* Owner-scoped sequence.
* Cross-device visibility.
* Overlay status lifecycle.
* Context Broker merge.
* Projection delta application.
* Contested failure path.
* Answer lineage.

### Phase 4: Initial typed capabilities

Build:

1. Commitments and deadlines.
2. Transactions and obligations.

These expose:

* Cross-modality transitions.
* Partial fulfillment.
* Amount allocation.
* Current and future state.
* Entity ambiguity.
* Corrections.
* Same-user cross-device writes.

### Phase 5: Registry lifecycle

Build:

* Unknown-pattern telemetry.
* Candidate registry proposals.
* Shadow normalization.
* Ownership review.
* Registry migrations.
* Targeted re-extraction.

---

## 32. Acceptance criteria

The specification is implemented correctly when:

1. `owe`, `debt_to`, and `borrowed_from` can normalize into the same registered structure.
2. “Another loan” creates a separate frame instance.
3. Same-value propositions in different instances do not collide.
4. Competing values in the same slot do collide.
5. Hash changes do not invalidate object references.
6. Instance merges preserve lineage and rebuild projections.
7. Instance splits do not silently move ambiguous claims.
8. Context space is never extractor-generated free text.
9. Scheduled, intended, predicted, and actual propositions remain separate.
10. Actual outcomes connect through explicit resolution links.
11. A realized action does not rewrite the original plan.
12. Registry-unknown predicates cannot supersede accepted beliefs.
13. Unknown predicates have a measurable promotion pipeline.
14. Registry ownership collisions are detected before activation.
15. A correction made on phone is visible immediately on desktop.
16. Typed projections include pending owner deltas.
17. A failed pending delta becomes contested rather than disappearing.
18. Previous answers can identify which pending deltas they relied on.
19. Extractor upgrades create new claims rather than overwriting old interpretations.
20. Keying rules pass both synthetic and real-connector tests.

---

## 33. Revised architectural invariants

1. Evidence is not belief.
2. A source assertion is not automatically truth.
3. An AI inference is not independent evidence.
4. Categories are views, not containers.
5. Accepted beliefs require canonical registry membership.
6. Open predicates remain below the canonical belief boundary.
7. Frame identity, slot identity, proposition identity, and claim identity are separate.
8. A frame instance is not defined solely by its participants.
9. A belief slot excludes the candidate value.
10. Proposition identity includes the normalized value.
11. Context space is a closed, registry-governed dimension.
12. Modality is distinct from belief status and source origin.
13. Past state is not destroyed by current state.
14. Future claims do not become outcomes automatically.
15. Current state is a deterministic temporal projection.
16. Contradictions are preserved.
17. Belief changes are transactional.
18. Derived beliefs retain dependencies.
19. Unknown predicates cannot silently supersede canonical beliefs.
20. Hashes are lookup indexes, never semantic identities.
21. Merge and split are governed transactions.
22. Stable identifiers remain resolvable through lineage.
23. Identifiers are never silently repurposed.
24. Typed projections are rebuildable and not independent truth stores.
25. User confirmation is a scarce resource.
26. Ambiguity is resolved just in time unless immediate resolution is materially valuable.
27. Direct user writes have owner-scoped causal visibility across devices.
28. **Modality and outcome transitions are explicit resolution links, never rewrites.**
29. **Proposition and slot identity is surrogate and lineage-preserving; fingerprints may change under merge, split, or migration.**
30. Pending overlay deltas apply to typed projections as well as graph retrieval.
31. A pending delta that fails validation becomes contested rather than vanishing.
32. Registry entries have ownership, lifecycle, shadow evaluation, and migration policy.
33. Registry-unknown concepts have a measurable promotion path.
34. User-confirmed corrections are protected evidence anchors.
35. No canonical keying rule is approved solely from synthetic data.

---

## 34. Final design statement

The Uai belief system will not attempt to make natural-language semantics globally canonical.

It will instead provide:

```text
Open evidence
+ governed semantic registry
+ stable surrogate identity
+ versioned lookup fingerprints
+ explicit context spaces
+ explicit modalities
+ explicit resolution links
+ transactional merge and split
+ owner-scoped causal overlays
+ rebuildable typed projections
```

The identity rule is:

> **Identifiers are permanent references; semantic descriptors are versioned interpretations.**

The transition rule is:

> **Plans, schedules, commitments, expectations, and predictions remain historically intact. Outcomes connect to them through explicit realization and resolution links.**

The consistency rule is:

> **A direct user correction becomes visible across the user’s devices immediately, including in typed projections; later validation may contest it but may never silently erase it.**

The governance rule is:

> **Unknown language remains safe evidence until it earns canonical registry membership through observed use, explicit contract design, shadow evaluation, and migration.**

## Strategic decision: Uai stays independent of Cordum


The clean boundary is:

> **Uai owns memory semantics. Cordum may govern memory operations. CAP may transport governance messages.**

Uai’s Memory Kernel should independently own:

* Evidence and provenance.
* Canonicalization.
* Frame, slot, proposition, and claim identity.
* Temporal belief state.
* Resolution assertions.
* Instance merge/split lineage.
* Owner-wide causal overlays.
* Typed projections.
* Context-packet construction.

Cordum should eventually plug into three narrow policy ports:

```text
EvaluateMemoryWrite(request)
    → ALLOW | STAGE | REQUIRE_CONFIRMATION | DENY

EvaluateMemoryRead(request)
    → ALLOW | REDACT | DENY

EvaluateMemoryAction(request)
    → ALLOW | REQUIRE_CONFIRMATION | DENY
```

For V0, those ports use a local implementation. This avoids making two immature systems depend on each other.

Later, CAP can define a **memory-governance profile** carrying:

```text
memory.write.proposed
memory.write.decided
memory.write.committed
memory.read.requested
memory.context.issued
memory.action.requested
memory.action.decided
```

But CAP should **not** define Uai’s predicates, proposition identity, slot keying, migrations, or projection schemas. That would put semantic memory logic into the wrong layer.

## The important corrections now encoded

### Outcome state has exactly one authority

There is no canonical `status` predicate.

Statements such as:

```text
“It is settled.”
“I completed it.”
“The meeting was cancelled.”
```

create **resolution assertions**.

A resolution assertion may have:

* A target transaction or occurrence.
* No target, when the outcome is directly asserted.

The current outcome is derived only from accepted resolution assertions.

Operational concepts such as:

```text
overdue
due soon
unresolved
```

exist only in projections. They are not competing canonical status memories.

### Allocation is canonical; coverage is not

For obligations:

```text
Payment transaction
        ↓
finance.payment_allocation
        ↓
Resolution evaluator
        ↓
FULFILLED / PARTIALLY_FULFILLED
```

The allocation frame stores the defensible amount.

A resolution link may cache `advisoryCoverage`, but the kernel cannot treat it as truth or perform the arithmetic itself.

### Unattached user writes remain visible

The owner-wide overlay now supports:

```text
AWAITING_INSTANCE_RESOLUTION
```

A delta such as:

```text
“I paid him back.”
```

may temporarily contain:

```text
raw text
candidate entities
candidate worldlines
candidate frame types
discourse anchor
temporal hints
semantic embedding reference
```

The Context Broker retrieves it through entity intersection, worldline intersection, discourse context, frame compatibility, bounded semantic matching, and a bounded recent-write fallback.

This preserves read-your-writes even before the system knows exactly which obligation the user meant.

### Answer lineage is described honestly

Uai stores a **Context Packet Manifest**:

```text
belief IDs
claim IDs
overlay delta IDs
projection versions
watermarks
registry release
packet hash
```

It means:

> “These were supplied to the model.”

It does not claim:

> “The model internally used these exact items.”

Reconsideration is intentionally over-inclusive.

### Context selection is not an extraction decision

The extractor cannot choose `BASE`, `QUOTED`, or `TEST`.

V0 defaults to:

```text
BASE
```

with source attribution.

`QUOTED` can only be activated by an explicit registry rule or capability opt-in. This prevents identical claims from splitting into different slots merely because two extraction runs handled “Daniel says” and “Daniel believes” differently.

### Registry governance is Git-native

There is no V0 registry service, owning-team hierarchy, or runtime promotion workflow.

Instead:

```text
Contract YAML
    ↓
Pull request
    ↓
Structural lint
    ↓
Gold-corpus tests
    ↓
CI shadow normalization
    ↓
Collision and projection diff
    ↓
Immutable Git release tag
```

Unknown predicates remain source evidence until promoted through a reviewed contract and tests.

## Concrete bundle

I created the complete V0 contract bundle:

* Registry release manifest.
* Structural JSON Schema.
* `shared.obligation` contract.
* `shared.commitment` contract.
* `finance.payment_allocation` supporting contract.
* `shared.event_occurrence` supporting contract.
* Resolution-assertion protocol.
* Owner-wide causal-overlay protocol.
* Obligation acceptance tests.
* Commitment acceptance tests.
* Cordum/CAP architecture decision record.
* Executable registry linter.

The included linter passes.

[Download the Uai Memory Registry V0 bundle](sandbox:/mnt/data/uai-memory-registry-v0.1.0.zip)

### Included structure

```text
uai_registry_v0/
├── README.md
├── docs/
│   └── adr/
│       └── ADR-0001-cordum-cap-boundary.md
├── registry/
│   ├── release.v0.1.0.yaml
│   ├── schema/
│   │   └── frame-contract.schema.json
│   ├── protocol/
│   │   ├── resolution-assertion.v0.yaml
│   │   └── user-causal-overlay.v0.yaml
│   ├── contracts/
│   │   ├── shared/
│   │   │   ├── obligation.v0.yaml
│   │   │   ├── commitment.v0.yaml
│   │   │   └── event-occurrence.v0.yaml
│   │   └── finance/
│   │       └── payment-allocation.v0.yaml
│   └── tests/
│       ├── obligation.v0.cases.yaml
│       └── commitment.v0.cases.yaml
└── tools/
    └── lint_registry.py
```

One intentional limitation remains: `shared.obligation` V0 supports **monetary obligations only**. Generalizing it now to duties, services, returned objects, legal obligations, and social obligations would bring the abstraction explosion back before we have real data.

The next build step should be the Phase-0 Gmail corpus harness: select a small private set of messy real threads, manually establish expected instances, slots, propositions, commitments, and resolutions, then run these contracts against them before designing the final PostgreSQL schema.
