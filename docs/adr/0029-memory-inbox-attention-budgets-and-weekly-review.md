# ADR 0029: Memory inbox, attention budgets, learned approval rules and the weekly review

Date: 2026-09-19
Status: Accepted
Node: `memory-inbox-attention-budgets-and-weekly-review` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-UX-05-A, CRT-UX-06-A, CRT-UX-08-A, CRT-WRT-05-A, CRT-WRT-05-B,
CRT-WRT-06-A.

Recorded before the implementing change, per PRD §0.7 and §46. Paired with
`migrations/0023_memory_inbox_and_weekly_review.sql`: this node's dependency
(`web-shell-labels-today-briefing-and-ask-surface`) landed first as ADR 0027 and
migration 0022, and the commitments and correction-controls node took ADR 0028,
so this record is numbered 0029.

## 1. An ambiguity is read through the Context Broker, never stored twice

PRD §19.2 `BATCH_REVIEW` queues "material, non-urgent ambiguity for grouped
review", and the admission engine records it as a `CANDIDATE` assessment. The
design draws no ambiguity table: `clarification_cards.grouped_ambiguity_ids`
and `interruption_decisions.candidate_ambiguity_id` name objects that already
exist. So an ambiguity is derived on read from a Context Broker packet — the
only memory read path a product surface has — and is one of:

- `UNCONFIRMED_INTERPRETATION`: a belief whose live assessment is `CANDIDATE`
  (what `BATCH_REVIEW` admitted); its id is the proposition id;
- `CONTESTED_BELIEF`: a belief whose live assessment is `CONTESTED`; the
  proposition id;
- `CONFLICTING_VALUES`: a slot the packet reports as a conflict; the slot id.

An unattached owner assertion is not an inbox question: canonicalization owns
attaching it, and asking the owner again what they already said would be the
repetition §19.3 forbids.

## 2. One card per situation

A situation is the memory thread (PRD §33.11, "the situation a set of objects
belongs to") the ambiguous frame belongs to, or the frame instance itself when it
belongs to none. Every ambiguity of one situation is one card, keyed
`thread:<id>` or `frame:<id>` in `situation_key`. A card states its facts, *why
it matters* and, for each choice, *what that choice will change*, all composed
by code from the packet (no model call).

The §37.4 Daniel example is its own template (`REPAYMENT`): a situation holding
a `shared.obligation` with a principal and an unconfirmed
`finance.payment_allocation` gets the choices Confirm repayment, Different
person, Different purpose and Keep uncertain. Every other situation gets the
generic choices (confirm, reject, keep uncertain; or one "confirm value" per
side of a single conflict). The Memory Kernel performs no financial arithmetic
(§16.7): the card names both amounts and says the obligations capability will
recompute the remainder; it never computes one.

## 3. Sensitivity scope

`sensitivity_scope` is `<LIFE_CATEGORY>/<SENSITIVITY>`, for example
`FINANCE/PRIVATE`: the most specific life category the packet derived for the
situation (a category other than `PERSONAL` when there is one) and the most
restrictive sensitivity of the evidence behind it. PRD §30.3 keeps three
levels, and the Permissions surface maps domains onto them; the pair is what
"one proactive clarification per sensitivity scope" is counted over.

## 4. The interruption decision

§19.4 allows a qualitative policy provided its inputs and reason are logged.
Each card is assessed on the five named inputs — error probability,
consequence, irreversibility, urgency, interruption cost — taken as the
strongest over its ambiguities from fixed rules (conflicts and contested
beliefs are likelier errors than candidates; money frames are high consequence
and costly to reverse; a due time within seven days is urgent; a `RESTRICTED`
scope costs more to raise). The decision is one of the design's `ASK`, `BATCH`,
`SUPPRESS`, evaluated in this fixed order:

1. an approved learned rule matching the card: `SUPPRESS`, `LEARNED_RULE_APPLIED`
   (the rule's choice is applied instead of asking; §6);
2. asked, or kept uncertain, within the suppression window and no evidence the
   card had not already been asked with: `SUPPRESS`;
3. value below interruption cost: `BATCH`;
4. the owner's daily card cap reached: `BATCH`;
5. the scope's daily cap reached: `BATCH`;
6. otherwise `ASK` — `REOPENED_BY_MATERIAL_NEW_EVIDENCE` when step 2 was passed
   only because of new evidence, else `WITHIN_ATTENTION_BUDGET`.

One `interruption_decisions` row is written per grouped ambiguity per
evaluation, carrying every input, the budget state it was counted against and
the reason. A card is evaluated at most once per owner-local day unless new
evidence arrives behind it, so reloading the inbox neither spends budget nor
floods the log. Cards are evaluated highest value first, so a cap withholds the
least important questions.

"Material new evidence" is an evidence id behind the card's ambiguities that is
not among the evidence the card was last asked with (`known_evidence_ids`); the
first such id is recorded as `reopened_by_evidence_id`.

## 5. Budgets are per owner, per owner-local day, and configurable

`attention_budgets` holds at most one row per owner scope. No row means the
PRD defaults (3 cards per day, 1 per sensitivity scope per day, 7 suppression
days); `PATCH /v1/settings/attention-budgets` writes the row and the next
evaluation counts against it. The day is the owner-local date of the request's
declared IANA time zone (UTC when none is declared).

## 6. Answering a card is a correction, and a learned rule is its own consent

A card choice runs the correction write path of ADR 0019 under server-chosen
`memory.correct`: the owner's answer becomes one new evidence row, each target
gets an overlay delta and a `memory_operations` row of the choice's kind
(CONFIRM, REJECT or KEEP_UNCERTAIN), a confirmation records a
`USER_CONFIRMATION` claim, and one belief transaction is *proposed* (never
committed here). Keep uncertain proposes nothing and suppresses the card for
the window, as the keep-uncertain control promises.

A learned approval rule (§19.5) is proposed when the owner has made the same
choice on two cards with the same rule signature (for a repayment card: the
transfer's exact memo). It is `PROPOSED` and has no effect; approval is an
explicit owner request that records the approving user and instant; revocation
records its instant and ends every effect from the next evaluation on. Only an
`APPROVED` rule matches a card. Its effect is exactly step 1 of §4: the card is
not asked, and the rule's choice is applied through the same write path with
the rule named on the answer. The rule's history — proposed, approved, applied
to which cards, revoked — is read from its own columns and the cards it
resolved, never from a second history table.

## 7. The weekly review is composed from one persisted packet

`GET /v1/weekly-review` reads one Context Broker packet (answer type
`PATTERN_REVIEW`, world time the end of the owner-local week, the four release
0.1.0 frame types as hints) and composes every statement by code from that
packet. Each statement names the packet objects it rests on. Before anything is
stored, every ground is checked against the manifest of the packet *as
persisted* — read back from `context_packets` and hash-checked, extended with the
packet's frame instances and resolution assertions — and a statement that names
anything else refuses the review (`WEEKLY_REVIEW_UNGROUNDED`). Grounds are the
design's "every statement grounded in the persisted packet manifest".

- **Stated priorities versus calendar allocation.** Until the goal model of the
  P6 goals node exists, a stated priority is the owner's explicit
  `shared.commitment.priority` value (the registry defines it as "only if
  explicitly stated ... never inferred"). Calendar allocation is the scheduled
  minutes of `shared.event_occurrence` intervals inside the week, per life
  category. The comparison names each category holding a high stated priority
  and the share of scheduled time it received.
- **Open commitments versus completed resolutions.** Commitments with no
  accepted fulfilling resolution, those whose due time passed inside the week
  (slipping), and the resolution assertions effective inside the week.
- **Decisions versus outcomes.** `NOT_AVAILABLE_IN_THIS_RELEASE` until the
  decision frame of registry release 0.2.0 exists; no statement is invented.
- **Planned versus observed spending.** Obligations due inside the week against
  payment allocations recorded inside the week, listed with their own amounts
  and currencies; nothing is summed.
- **Material changes.** Values whose valid period closed inside the week
  (a change or a supersession), and values first recorded inside the week, by
  life category.

## 8. Behavioral observations need more than one episode

A postponement episode is one commitment's due time being restated later than
the value it replaced (successive due-time values of one frame ordered by valid
time). An observation is emitted only when the observation window — the 28
days ending with the reviewed week — holds at least two episodes. It records
the supporting episode ids, a counterexample search over the same window
(commitments due inside it that were never postponed, with their ids), the
window, a confidence (episodes over episodes plus counterexamples, two
decimals) and a review date 28 days after the window ends. One episode yields
nothing, whatever else is in memory. The wording states the count and the
window and nothing about the owner's character.

## 9. Purposes and tables

Four route purposes, each on its own surface: `memory.inbox` (inbox read and
card decisions), `approval.rules` (list, approve, revoke), `settings.attention`
(the budget patch), `review.weekly` (the review). Broker reads run under
`memory.read` and the answer write under `memory.correct`, both chosen by
server code, never by a header. The six design tables are forced-RLS,
owner-scoped and purpose-gated; `interruption_decisions`, `weekly_reviews` and
`behavioral_observations` are append-only and immutable; no table takes a
DELETE grant.

## 10. The registry reader takes its locks in snapshot order

Every Context Broker read asks `unai_private.registry_contract_present`
whether a contract is in the pinned release, and the inbox and the review add
many broker reads. Migration 0019's body read `registry_contracts` before
`registry_releases`, which is the opposite of the order a publish writes them
and the order the snapshot suite's refused `TRUNCATE` locks them; a reader
holding the contracts lock while waiting on releases deadlocks against either,
and the full suite failed on it intermittently once these reads were added.
Migration 0023 replaces the body with the same purposes, inputs and answer,
reading releases first. Nothing else about the reader changes.
