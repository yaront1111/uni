# The web shell, the uncertainty labels, the Today briefing and the Ask screen

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`web-shell-labels-today-briefing-and-ask-surface`. This node owns CRT-UX-01-A,
CRT-UX-01-B, CRT-UX-02-A, CRT-UX-03-A, CRT-UX-11-A and CRT-UX-12-A. ADR 0026
records its decisions; ADRs 0001–0025 and every delivered slice before it were
inspected and retained.

The branch was cut before its dependency chain landed, so it first merges the
selection/Ask node (which carries master's connector capabilities) and the
answer-manifests node; the latter's migration becomes
`0020_answer_manifests_and_reconsideration.sql` and its ADR 0025, unchanged in
content (ADR 0026 §preamble).

## Design entities implemented here

**`briefing_editions`** and **`briefing_items`**, added by
`migrations/0021_today_briefing.sql`: forced RLS, owner policies gated on
`memory.read` (write and read) and `memory.inspect` (read), composite owner
foreign keys (an edition to its `context_packets` row and to the session member,
an item to its edition), immutability triggers and no DELETE grant. Beside the
design's fields an edition carries its UTC offset, the instant it was generated
for, the packet hash and **packet manifest**, its recommendations and withheld
recommendations, the projection completeness it was built over and the ranking
version; an item carries its headline, score, priority, target time, whether its
target passed, its outcome state, its **material fingerprint** (what "unchanged"
means for repeat suppression), its Why? / Sources references and whether it was
shown, suppressed as an unchanged repeat, or deferred by the attention budget.
There are now 55 application tables, 53 of them owner-scoped.

No other design entity is implemented here. `recommendation_artifacts` belongs to
the Recommendation detail screen, which this node does not draw; a briefing's
recommendations are recorded on its edition with RECOMMENDED semantics.

## Design screens implemented here

| Screen (design) | State | Where |
| --- | --- | --- |
| Today briefing | Loading | `Today` `state:'loading'` in the live region; also while the browser's timezone is learned |
| | Empty day with nothing material to report | `isEmpty` → "Nothing material today" |
| | Owner-local date and timezone header for a non-UTC owner | `h1` is the owner-local date; "Your local date in Asia/Tokyo (UTC+09:00)" |
| | Ranked domain sections holding only a small set of high-impact items | ≤3 items per Work / Personal / Finance section, ≤7 in all, API rank order |
| | Item expanded to show why it was surfaced | "Why is this here?" disclosure: the reason and the seven rank components |
| | An older high-consequence urgent item ranked above a newer low-consequence item | rank order; no component is a recording time |
| | Unresolved planned outcome whose target time has passed | `pastTarget`, "Overdue, no resolution recorded" / "Past its planned time, no outcome recorded" |
| | Decision-affecting source conflict surfaced | CONTESTED label, "Sources disagree", a disputed amount stated as the dispute |
| | Uai recommends block offering at most a few recommendations | ≤3, RECOMMENDED label, "Suggestions only" |
| | Unchanged low-priority item suppressed because it was shown yesterday | "Not shown today" disclosure with the date it was shown |
| | Scheduled event worded as scheduled and never as having happened | "Scheduled, not yet happened: …" / "Planned for …: … Nothing recorded says whether it took place." |
| | Incomplete projection notice with the pending owner assertion shown | "Schedule is incomplete" with the owner's pending words |
| | High-risk recommendation withheld because supporting memory is provisional, contested, or incomplete | "A high-risk suggestion … was withheld because …" |
| | Context packet manifest persisted for this edition | advanced inspector: edition id, packet id and hash, what was supplied |
| Why? / Sources panel | Closed | a native `details`, closed until activated |
| | Confirmed belief with claiming actor, source excerpt, effective time, and confidence | "Who claimed it", "What the source says", "When it holds", "How confident" |
| | Reported external person assertion | REPORTED, "another person said it" |
| | Inferred statement with its derivation path | "How it was derived": recorded derivation steps and model claims |
| | Contested statement showing both competing values and the conflict status | "Conflict" with each competing value |
| | Pending owner assertion not yet canonicalized | the overlay assertion itself, "not yet independently verified" |
| | Scheduled or planned item | SCHEDULED |
| | Resolved item linked to its resolution assertion | RESOLVED, "Outcome" |
| | Label set remaining distinguishable in a grayscale rendering and never conveyed by colour alone | words + glyph + border pattern, black/grey/white only |
| | Source excerpt withheld as a listed redaction | "1 source is withheld: …", never quoted |
| Ask | Empty prompt with example questions | `state:'empty'` |
| | Classifying the requested answer type | announced in the live region on submit |
| | Answers of each type with per-statement certainty labels and source links | the answer the Ask pipeline returns, each statement labelled, linked and with its Why? / Sources |
| | Candidate answer blocked / downgraded / regenerated by the grounding validator | fixed notices from `grounding.action` |
| | Unknown or uncertain answer that declines to assert | `declinesToAssert` notice |
| | Refused because the request declared no purpose or an unpermitted purpose | fixed sentences for `ASK_REQUEST_INCOMPLETE` / `CONTEXT_READ_DENIED` |

The Ask state "Just-in-time clarification requested" is not drawn here: raising a
clarification card belongs to `memory-inbox-attention-budgets-and-weekly-review`.

## HTTP surface

| Route | Purpose | Answer |
| --- | --- | --- |
| `GET /v1/today?timeZone=&date=` | `memory.read` | `200` briefing; `400 TODAY_REQUEST_INCOMPLETE` (no `x-data-purpose` / `x-maximum-sensitivity`), `TODAY_REQUEST_INVALID`, `TODAY_TIME_ZONE_REQUIRED`, `TODAY_TIME_ZONE_INVALID`; `409 TODAY_DATE_NOT_CURRENT`; `403 CONTEXT_READ_DENIED` |
| `GET /v1/memory/why/{propositions\|owner_overlay_deltas\|resolution_assertions}/{id}` | `memory.inspect` | `200` panel; `400 WHY_REQUEST_INVALID`; `404 WHY_OBJECT_NOT_FOUND` |

Web: `/today` and `/ask` (server-rendered through `apps/web/lib/screens.ts`). The
POST-only write proxy is not extended.

## How each acceptance criterion is met

- **CRT-UX-01-A** — `packages/api/src/today.test.ts` builds a fixture owner in
  Asia/Tokyo at 20:00 UTC (05:00 the next day locally) over the real broker,
  projection reducers and pinned release 0.1.0. It asserts the edition's
  `owner_local_date` is the Tokyo date and not the UTC date, the `+09:00` offset,
  due times shown in Tokyo time; that the items shown are exactly the current or
  imminent ones (not one due in a month, not a fulfilled one, not a RESTRICTED one
  under a PRIVATE ceiling); an overdue commitment and a planning call past its
  time, both unresolved; a reason and a label on every item; at most three
  recommendations, with the contested HIGH-risk one withheld; and that the
  edition's `context_packet_id` is the broker's own packet row and its persisted
  manifest names every belief the items rest on.
  `packages/context/src/ranking.test.ts` pins the rules without a database.
- **CRT-UX-01-B** — the same fixture briefed again 24 hours later suppresses the
  unchanged LOW-priority commitment shown the day before (recorded
  `suppressed_as_unchanged`, listed with `lastShownOn`) while still showing the
  high-consequence one; every scheduled event's headline, once the negated forms
  are removed, says nothing happened. The ranking test shows a changed fingerprint
  or an older showing brings the item back.
- **CRT-UX-02-A** — the older (created ten days earlier), urgent, high-priority
  commitment ranks above the newer low-priority one, with higher consequence and
  urgency, and the whole order is by score; the ranking test shows the same for
  both input orders with no timestamp in the input at all.
- **CRT-UX-03-A** — `apps/web/e2e/ask.test.ts` asks "What did I promise Daniel?"
  through the Ask screen's own loader against the real platform API in process,
  renders the screen, and asserts the promise, its source link, and that the
  answer's packet is the Context Broker's persisted `context_packets` row read for
  `PERSONAL_ASSISTANCE` by the session's actor, with the answer manifest over it.
- **CRT-UX-11-A** — the Today test opens the panel on a confirmed item (actor,
  excerpt, effective time, confidence, no conflict), a contested one (both values,
  CONTESTED), an inferred one (derivation back to the email claim a model read),
  a pending owner assertion (the overlay assertion itself), a scheduled one and a
  resolution assertion; a RESTRICTED source under a PRIVATE ceiling is listed as
  withheld and not quoted. The Ask end-to-end test opens it on the answer's
  statements, including the derivation path of the inferred promise.
- **CRT-UX-12-A** — `apps/web/components/Labels.test.ts` renders the seven states
  and asserts distinct words, glyphs and border patterns; that what survives a
  grayscale rendering (words and glyph, every attribute dropped) is still pairwise
  distinct; that no badge carries a colour; and that every `.label` rule in the
  stylesheet uses only grey-axis colours. The Today and Ask screen tests assert no
  identifier appears outside the advanced inspector.

## What this node does not claim

- **No goal model**: goal relevance is a recorded constant until
  `goals-decisions-prediction-review-and-mentor` exists.
- **One data purpose per edition** (ADR 0026, Consequences).
- **No keyboard-walkthrough CI artifact or automated accessibility scan**: the
  screens use native landmarks, labelled controls, native disclosures and a live
  region, but the CI accessibility checks belong to
  `accessibility-audit-trail-and-security-test-suite` (CRT-UX-14-A).
- **No Recommendation detail screen** and no `recommendation_artifacts` rows.
