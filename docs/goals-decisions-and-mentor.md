# Goals, decisions, the prediction review and the mentor

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node
`goals-decisions-prediction-review-and-mentor`. Decisions:
`docs/adr/0029-goals-decisions-prediction-review-and-mentor.md`.

## Delivered

| Design item | Where |
|---|---|
| Entities `goals`, `goal_priority_history`, `decision_projection` (plus `mentor_cards`, ADR 0029 §7) | `migrations/0024_goals_decisions_and_mentor.sql` |
| Registry release 0.2.0: `shared.decision`, `shared.decision.prediction_review`, `shared.decision.realization` | `registry/releases/0.2.0/` |
| `GET /v1/goals`, `POST /v1/goals`, `PATCH /v1/goals/{id}/priority` | `packages/api/src/decisions.ts` (purposes `goals.read`, `goals.manage`) |
| `POST /v1/decisions`, `GET /v1/decisions/{id}`, `POST /v1/decisions/{id}/review` | same (purposes `decisions.record`, `decisions.read`) |
| `GET /v1/projections/decisions` | same (purpose `projection.read`) |
| `GET /v1/mentor/contradictions` | same (purpose `mentor.advise`) |
| Screens Goals, Decisions workspace, Mentor contradiction card | `apps/web/pages/goals.tsx`, `pages/decisions.tsx`, `pages/mentor.tsx` |

## The screens

- **Goals** lists each goal with its stated priority and the priority that
  applies now, and the whole priority history as a table, oldest first: a change
  adds a row and the earlier ones stay. A temporary override shows its end date
  and reason and says the mentor respects it. A goal the mentor found at odds
  with the calendar is flagged, with a link to the mentor card (or a note that
  the card was withheld by the budget). Adding a goal and changing a priority go
  through the write proxy under `goals.manage`; the proxy forwards the priority
  change as the `PATCH` the API expects.
- **Decisions workspace** lists the rows of `decision_projection` with where each
  stands (awaiting its review date, review due, reviewed, no recorded outcome
  yet). `/decisions?id=` opens one decision: question, options, assumptions (with
  how many sources were cited), cross-domain consequences by area of life,
  recommendation, the owner's choice, expected result, review date and actual
  outcome, read from its projection row; "Why did I make this decision?"
  answered from the recorded choice, reason and assumptions, each with the
  anchored words it came from and any source the owner cited; and every
  prediction review as predicted versus actual with its resolution code, saying
  that the prediction is kept as stated. Recording a decision and reviewing a
  prediction go through the proxy under `decisions.record`, with the pinned
  evidence context, because both store the owner's words as evidence.
- **Mentor contradiction card** shows today's emitted cards, each with three
  separately headed and separately labelled parts: evidence (what the records
  show), inference (what Uai concludes, with its confidence and counterexample
  search) and recommendation (a suggestion). The shared budget with the Memory
  inbox is stated in words; cards the budget withheld are named with their
  reason and not shown; goals under a temporary override are listed as not
  raised.

Identifiers appear only in each screen's advanced inspector.

## Acceptance evidence

- **CRT-DEC-01-A** — `packages/api/src/decisions.test.ts` "appends a history row
  for every priority change and overwrites nothing" (three statements retained,
  the first byte-for-byte, an UPDATE refused `GOAL_PRIORITY_HISTORY_IMMUTABLE`)
  and "shows question, options, assumptions, cross-domain consequences,
  recommendation, choice, expected result, review date and actual outcome from a
  decision_projection row". The screens: `apps/web/components/Goals.test.ts`
  (history kept, override respected, contradiction flagged) and
  `Decisions.test.ts` (every designed field of the detail, the list states).
- **CRT-DEC-02-A** — `decisions.test.ts` "answers with the recorded rationale and
  assumptions, each with its sources" and "reviews a prediction as CONFIRMED,
  REFUTED or PARTIALLY_CONFIRMED … and leaves the PREDICTED proposition and its
  claims intact"; `Decisions.test.ts` renders both.
- **CRT-DEC-03-A** — `decisions.test.ts` "surfaces a goal the calendar
  contradicts, with evidence, inference and recommendation labelled distinctly",
  "emits no more proactive items than the budget allows …" and "shares one budget
  with the Memory inbox …"; `apps/web/components/Mentor.test.ts` renders the three
  parts under their own headings and labels and a withheld card by name only.
