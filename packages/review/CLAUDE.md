# @unai/review

Proactive clarification and the weekly review (PRD §7.5, §7.7, §19.3-§19.5,
§37.4, §39). Report: `docs/memory-inbox-and-weekly-review.md`; decisions:
`docs/adr/0029-memory-inbox-attention-budgets-and-weekly-review.md`. Routes live
in `packages/api/src/review.ts`; screens in `apps/web/components/MemoryInbox.tsx`,
`ApprovalRules.tsx` and `WeeklyReview.tsx`.

## Surface

- `ambiguities.ts` (pure): `collectAmbiguities(packet)` and
  `composeCards(packet, {ambiguities, situations, now, suppressionDays})` — one
  card per situation (memory thread, else frame), with facts, why it matters and
  what each choice will change. The §37.4 repayment template lives here.
- `interruption.ts` (pure): `decideInterruption(state)` — the fixed check order of
  ADR 0029 §4 and the logged `policyInputs`.
- `budgets.ts`, `rules.ts`, `inbox.ts`: the `attention_budgets`,
  `learned_approval_rules`, `clarification_cards` and `interruption_decisions`
  stores. `evaluateInbox` decides and logs; `readInbox` answers the screen.
- `weekly.ts`, `observations.ts` (pure): the review sections and the
  postponement observation; `weekly-store.ts` records them under `review.weekly`
  after `ungroundedStatements` finds nothing.

## Local invariants

- **Memory is read only through a Context Broker packet the caller supplies.**
  Nothing here selects from a canonical table. `readSituations` reads thread
  membership (under `memory.read`), which is a grouping, not memory.
- **Memory is written only by the API's correction path.** A card answer is
  evidence, overlay deltas, memory operations and a *proposed* transaction under
  `memory.correct`; this package records only the card's answer.
- **No arithmetic on money.** Amounts are described as recorded
  (`describeValue`); the obligations capability owns remainders.
- **A learned rule has effect only while `APPROVED`.** `approvedRuleFor` is the
  only matcher and filters on status; the database lets the inbox insert
  `PROPOSED` rules only.
- **No observation from one episode.** `MINIMUM_SUPPORTING_EPISODES` is 2, and
  migration 0023 refuses a row with fewer.
- Every function takes the transaction and the instant as parameters: no clock.

## Traps

- **Knowledge time.** The broker filters on `recorded_at <= knowledgeTime`. Tests
  that move the inbox clock must keep it ahead of the fixtures' recorded time
  (`packages/api/src/inbox.test.ts` starts tomorrow).
- **Per-day evaluation.** A card is evaluated once per owner-local day unless new
  evidence arrives or the budget it was counted against changes; a test expecting
  a second decision the same day must change one of those.
- **Commitment predicates are COMMITTED modality**, so they arrive as packet
  `futureClaims` without an assessment: they can be reviewed, but a candidate
  commitment due time is not an inbox ambiguity.
- `date` columns are selected `::text` so the session zone cannot move a day.

## Tests

`pnpm exec vitest run packages/review` (pure). The database halves run in the full
`pnpm test`: `packages/api/src/inbox.test.ts`, `packages/api/src/weekly-review.test.ts`
and the 0023 case of `packages/postgres/src/isolation.test.ts`.
