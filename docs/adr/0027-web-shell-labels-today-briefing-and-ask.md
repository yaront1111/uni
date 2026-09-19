# ADR 0027: The web shell, the uncertainty labels, the Today briefing and the Ask screen

Date: 2026-09-19
Status: Accepted
Node: `web-shell-labels-today-briefing-and-ask-surface` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-UX-01-A, CRT-UX-01-B, CRT-UX-02-A, CRT-UX-03-A, CRT-UX-11-A,
CRT-UX-12-A.

Recorded before the implementing change, per PRD §0.7 and §46. It builds on the
Context Broker (ADR 0022), the Ask pipeline (ADR 0024) and answer provenance
(ADR 0026). This node's branch was cut before those nodes landed, so it merged
their delivered branches (and master's connector capabilities) first. Written as
ADR 0026 over migration 0021; renumbered 0027 over
`migrations/0022_today_briefing.sql` when master landed governed merge and split
(ADR 0025, migration 0020) and answer provenance (ADR 0026, migration 0021).
Master's landed migrations are taken byte for byte; this node's migration had
never landed under the old number.

## 1. The briefing's only memory read is a Context Broker packet

The design's open decisions require that "no product surface reads memory except
through the Context Broker and no projection is read without its completeness
flag and overlay watermark". `GET /v1/today` therefore:

1. asks `readContextPacket` for a packet over the owner's `shared.commitment`,
   `shared.obligation` and `shared.event_occurrence` frames, under the request's
   declared data purpose and sensitivity ceiling (`x-data-purpose`,
   `x-maximum-sensitivity`, as the inspection routes carry them), at world time
   *now* and knowledge time *latest*, planned as `OPEN_COMMITMENTS`;
2. reads that packet back as persisted, hash checked (`readPersistedPacket`), and
   the typed projection rows **for the frames the packet supplied and no
   others**, with their completeness flags;
3. ranks (pure, `ranking.ts`) and persists the edition in the same transaction.

A frame the packet did not supply — above the ceiling, outside the purpose —
cannot appear, because the projection rows are joined to the packet and not the
other way round. The route runs under `memory.read`, the broker's own purpose;
like `context_packets`, the edition is a record of a read and no canonical table
gains a policy.

## 2. The owner's timezone is declared, then remembered

No table records an owner's timezone and the design adds none; `briefing_editions`
carries `timezone`. The request declares it (`?timeZone=` IANA name, checked with
`Intl`); a request without one uses the owner's most recent edition's zone; a
first request with neither is refused `TODAY_TIME_ZONE_REQUIRED`. The web screen
learns the zone from the browser (`Intl.DateTimeFormat().resolvedOptions()`),
keeps it in the `unai-tz` cookie and reloads, showing the design's Loading state
meanwhile. The owner-local date is computed with `Intl` in that zone, never from
the server's clock zone, and a caller-declared `date` that is not the owner's
current local date is refused `TODAY_DATE_NOT_CURRENT` rather than silently
replaced.

## 3. What is material, and how it ranks

- **Current or imminent**: unresolved, and due or starting within 48 hours, or
  past its target within the last 14 days, or carrying a decision-affecting
  conflict. Resolved items, items weeks away and items with no time and no
  dispute are not material today. The owner's recent unattached statements
  (seven days) are surfaced as pending.
- **Seven components**, each in [0,1] and recorded on `briefing_items`:
  consequence (kind, stated priority, dispute), urgency (past target, within
  24 h, within 48 h), goal relevance, confidence (from the label), effort,
  reversibility and attention budget (a repeat costs attention already spent).
  The score is a fixed weighted sum. **No component is a recording time**, so an
  older urgent high-consequence item outranks a newer low-consequence one
  (CRT-UX-02-A). Ties break by past-target, then the sooner target, then id.
- **Goal relevance is a constant 0.5** until the goal model exists (P6,
  `goals-decisions-prediction-review-and-mentor`). It is recorded as such rather
  than invented.
- **A small set**: at most three items per domain section (work, personal,
  finance — derived from the life categories the broker already derives) and
  seven in all; the rest are counted as deferred to their own views. At most
  three recommendations, labelled RECOMMENDED and stored on the edition, never as
  intent. A HIGH-risk recommendation (money) is withheld, with its reason, when
  its support is contested, provisional or from an incomplete projection.

## 4. Repeat suppression is a property of the edition history

An item is suppressed when it is LOW priority (low consequence, not past target,
not disputed) **and** it was shown on one of the previous seven owner-local dates
**with the same material fingerprint** — a hash of its kind, outcome state,
target time, label, dispute, pending state, stated values and whether its time
has passed, and nothing that depends on the day's wording. A change to any of
those, or a rise out of LOW priority, shows it again. Because the history decides
what is suppressed, `briefing_editions` and `briefing_items` are immutable and
grant no DELETE (migration 0022).

## 5. Scheduled is never "happened"

A calendar event is SCHEDULED until an accepted resolution assertion says
otherwise; a realization link alone does not make it "happened". The briefing
words a future event "Scheduled, not yet happened: …" and a past one "Planned for
…: … Nothing recorded says whether it took place." A resolved one is not material.

## 6. The Why? / Sources panel is its own read

`GET /v1/memory/why/{propositions|owner_overlay_deltas|resolution_assertions}/{id}`
(purpose `memory.inspect`) builds on `explainProposition` and adds what the
explanation does not carry: the claiming actor in words (the asserting entity's
label, else the claim origin), the anchored source excerpt (read through the
evidence policies, so a source above the ceiling is listed as a redaction, never
quoted), the weakest recorded confidence of each kind, the competing values of a
dispute, and the derivation path (recorded `derived_proposition_dependencies` and
DERIVATION support) of an inferred value. The design draws the panel but names
no route for it; the inspector's explain route is kept unchanged.

## 7. The web shell, labels and screens

- **Shell**: skip link, banner, main navigation, one focusable `main`, footer, and
  a polite live region for asynchronous states. Today and Ask become real
  navigation destinations; the other undelivered ones stay `aria-disabled`.
- **Labels**: the display vocabulary `memoryLabelSchema` (CONFIRMED, REPORTED,
  INFERRED, CONTESTED, PENDING_OWNER_ASSERTION, SCHEDULED, RESOLVED, plus the
  remaining certainty labels) is drawn with distinct words, a distinct glyph and
  a distinct border pattern, in black, grey and white only — so a grayscale
  rendering is the same rendering. An Ask statement's CONFLICTING reads
  CONTESTED, its pending owner assertion reads PENDING_OWNER_ASSERTION and an
  accepted RESOLUTION reads RESOLVED.
- **Identifiers** appear only inside "Advanced inspector" disclosures; a value
  that carries one is shown without it.
- **Reads, not writes**: Today and Ask are server-rendered through one loader
  module (`apps/web/lib/screens.ts`) over an injected API call. Ask is a GET form
  (`/ask?q=`) whose server render asks `POST /v1/ask`; the POST-only write proxy
  is not extended, because asking records an answer but changes no memory the
  owner controls. The end-to-end test drives that same loader against the real
  API in process.

## Consequences

- Two owner-scoped tables (57 forced-RLS tables in all), classified in
  `ownership.ts` with cross-owner fixtures in `isolation.test.ts`.
- The projection replay test tears down and re-expects migration 0022.
- Open: a briefing reads one data purpose per edition. An owner whose evidence
  admits only domain purposes (`PERSONAL_FINANCE`, `WORK_ASSISTANCE`) and not
  `PERSONAL_ASSISTANCE` gets those items only from a request declaring that
  purpose; a multi-purpose edition would need one packet per purpose.
