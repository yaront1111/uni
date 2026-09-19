# Memory inbox, attention budgets, learned approval rules and the weekly review

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node
`memory-inbox-attention-budgets-and-weekly-review`. Decisions:
`docs/adr/0029-memory-inbox-attention-budgets-and-weekly-review.md`.

## Delivered

| Design item | Where |
|---|---|
| Entities `clarification_cards`, `attention_budgets`, `interruption_decisions`, `learned_approval_rules`, `weekly_reviews`, `behavioral_observations` | `migrations/0023_memory_inbox_and_weekly_review.sql` |
| `GET /v1/memory/inbox`, `POST /v1/memory/inbox/cards/{id}/decide` | `packages/api/src/review.ts` (purpose `memory.inbox`) |
| `PATCH /v1/settings/attention-budgets` (and a `GET` of the effective budget) | same (purpose `settings.attention`) |
| `GET /v1/approval-rules`, `POST /v1/approval-rules/{id}/approve`, `.../revoke` | same (purpose `approval.rules`) |
| `GET /v1/weekly-review` | same (purpose `review.weekly`) |
| Screens Memory inbox, Learned approval rules, Weekly review | `apps/web/pages/memory/inbox.tsx`, `pages/memory/approval-rules.tsx`, `pages/weekly-review.tsx` |

## How it works

- The inbox reads one Context Broker packet (`memory.read`), derives the
  ambiguities it holds — `CANDIDATE` beliefs (what `BATCH_REVIEW` queued),
  `CONTESTED` beliefs, reported conflicts — groups them by memory thread (else
  frame) into one card per situation, and evaluates each card once per
  owner-local day against the attention budget. Every evaluation logs one
  `interruption_decisions` row per grouped ambiguity with the five §19.4 inputs,
  the budget state and the reason.
- Answering a card runs the correction write path under `memory.correct`:
  evidence, an overlay delta and a memory operation per target, a
  `USER_CONFIRMATION` claim for a confirmation, and one *proposed* belief
  transaction. Keep uncertain proposes nothing and withholds the card for the
  suppression window.
- Two owner answers with the same choice on cards with the same exact memo
  propose a learned rule. Only an `APPROVED` rule answers a matching card
  (decision `SUPPRESS`, reason `LEARNED_RULE_APPLIED`), through the same write
  path; revoking it ends that.
- The weekly review reads one packet for the owner-local week, composes every
  statement from the packet as persisted, checks each statement's grounds
  against that packet's manifest, and records the review and any behavioral
  observation.
- The Weekly review screen loads through `apps/web/lib/review.ts`, whose loader
  takes the API call as a parameter. Every belief a statement or an observation
  rests on carries Inspect and Correct links (`BeliefRefLinks`), and
  `apps/web/e2e/memory.test.ts` renders the review for a fixture week, follows
  every link into the Memory inspector and persists a correction from each.

## Acceptance evidence

- **CRT-UX-08-A** — `packages/review/src/review.test.ts` ("related ambiguities
  about one situation become one card") and `packages/api/src/inbox.test.ts`
  ("the Daniel card, its answer, and a learned rule"): the §37.4 situation is one
  card, "Possible Daniel repayment", with its four facts, why it matters and
  Confirm repayment / Different person / Different purpose / Keep uncertain, each
  stating what it will change.
- **CRT-WRT-05-A** — `inbox.test.ts` "ten qualifying ambiguities in one
  owner-local day": default budget, ten ambiguities in four scopes → exactly
  three cards in three scopes, seven deferred, ten logged decisions each with its
  inputs and reason; a reload the same day logs nothing new.
- **CRT-WRT-05-B** — `inbox.test.ts`: asked day 0, withheld day 1, re-asked day 3
  on new evidence (`REOPENED_BY_MATERIAL_NEW_EVIDENCE`, `reopened_by_evidence_id`),
  withheld day 9, asked day 10; a 5/2 budget asks five cards with at most two per
  scope, raising to 6 asks one more the same day, lowering to 1/1 asks exactly one.
- **CRT-WRT-06-A** — `inbox.test.ts`: a proposed rule leaves the next card asked;
  after explicit approval the next matching card is answered by the rule (with
  its overlay delta and memory operation naming the rule); the rule's history is
  inspectable; after revocation the next card is asked again and re-approval is
  refused. `isolation.test.ts` shows the inbox purpose cannot approve a rule and
  a revoked rule cannot return.
- **CRT-UX-05-A** — `packages/api/src/weekly-review.test.ts`: the fixture week
  reports stated priorities versus calendar allocation, open commitments versus
  completed resolutions and material changes, and every statement's grounds are
  found in the stored `context_packets` JSON.
- **CRT-UX-06-A** — `weekly-review.test.ts` and `review.test.ts`: one
  postponement produces no observation (and no row); two produce one observation
  with its episodes, counterexample search, window, confidence and review date,
  stored in `behavioral_observations`.

## Not claimed

- **Goals.** "Stated priorities" are the owner's explicit
  `shared.commitment.priority` values until the goal model of
  `goals-decisions-prediction-review-and-mentor` exists (ADR 0029 §7).
- **Decisions versus outcomes** is reported `NOT_AVAILABLE_IN_THIS_RELEASE`: the
  decision frame arrives with registry release 0.2.0.
- **Batch review screen.** Deferred cards are counted and re-evaluated on later
  days; there is no separate weekly batch surface.
- **Budget editor UI.** The attention-budget editor is a state of the
  Permissions screen, which another node draws; this node delivers its API.
- **Unattached owner assertions** are not inbox questions (ADR 0029 §1).
- Time zones are request-declared (`?timeZone=`); the web pages declare UTC
  until an owner time-zone setting exists.
