# ADR 0027: Commitments, Obligations, Memory inspector, Memory thread and the Correction controls

Date: 2026-09-19
Status: Accepted
Node: `commitments-obligations-inspector-and-correction-controls` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-UX-04-A, CRT-UX-07-A, CRT-UX-10-A, CRT-UX-10-B, CRT-UX-15-A.

Recorded before the implementing change, per PRD §0.7 and §46. ADRs 0001–0026
were read and are retained unchanged.

## 1. Two read routes are added for the drawn screens

The design's Memory inspector screen draws ten states PRD §7.6 lists: current
belief, historical timeline, original evidence, claims with asserting actors,
inferences, conflicts, resolution assertions, connected threads, access history,
and registry and extractor versions, plus the advanced identifier panel and the
per-claim confidences. `GET /v1/memory/propositions/{id}/explain` (ADR 0022)
answers the belief explanation of PRD §35.8 — nine sections, pinned by
CRT-RD-09-A — and carries no inferences, thread memberships, access history,
entity labels or anchor text. Rather than widen a contract another node owns and
tests, the inspector gets its own read:

- `GET /v1/memory/inspector/{objectType}/{id}` under `memory.inspect`. It
  resolves the object a surface showed — a proposition, a claim, a frame
  instance, a resolution assertion or an owner overlay delta — to the belief it
  is about, and answers `{subject, explanation, …}` where `explanation` is
  exactly the ADR 0022 explanation and the other sections are read beside it.
  Accepting every object type Today, Ask, Commitments and Weekly Review cite is
  what makes "inspect any surfaced belief" (CRT-UX-10-B) one link rather than one
  resolver per screen.

The Commitments and Obligations screens read `GET /v1/projections/commitments`
and `/obligations` (ADR 0021) under `projection.read`, which by design reads no
canonical table: a row names its people by entity id and its sources and
resolutions by id. The screens must show people by name, sources, and the
resolution evidence of a resolved item (CRT-UX-04-A). So:

- `GET /v1/memory/frames/related?ids=<uuid>,…` under `memory.inspect`, at most
  100 frame instances, answers per frame the role fillers with their labels, the
  evidence behind its claims (source type, time, anchor text), each resolution
  assertion with the evidence behind its claim and the entity that asserted it,
  its beliefs (so each row can open the inspector), and the threads it belongs
  to.

The page therefore makes two calls under two purposes. Neither route writes
anything except its audit row, and both sit in `@unai/context`, the inspection
read path, with the evidence gate (`unai.data_purpose`, `unai.maximum_sensitivity`)
set from the request exactly as the explain route sets it: withheld evidence is
counted, never shown.

## 2. Access history is read from rows that already exist

No access log table is added. The history of a belief is:

- every `audit_events` row whose `objects_and_fields_accessed` names the
  proposition, one of its claims or its frame instance (JSONB containment on
  `{"id": …}`), newest first, capped at 50 — purpose, result and fields read,
  never payload; and
- every `answer_manifests` row whose `belief_ids` contains the proposition — the
  answers that were given with this belief in context (ADR 0026).

Opening the inspector writes its own audit row, so the next opening shows it.

## 3. Merge and Split persist their own memory operation kinds

`memory_operations` (migration 0014) has `MERGE` and `SPLIT` in its CHECK list
and nothing writes them: the governed merge and split endpoints (ADR 0025)
commit a belief transaction and lineage but record no correction-control
operation. CRT-UX-10-A requires each of the ten controls to produce a different
persisted kind. The four lineage endpoints therefore record, after the commit
and the rebuild, in one owner transaction under the server-chosen purpose
`memory.correct` (the ADR 0025 §4 mechanism; never a header):

1. the owner's statement as a new evidence row (`ingestOwnerStatement`, the
   correction path's function — the reason given, or "Merge"/"Split"), and
2. one `memory_operations` row of kind `MERGE` or `SPLIT` naming the survivor or
   the split parent, that evidence and the committed transaction.

No overlay delta is written for these two kinds. The change is already canonical
when the operation is recorded; a delta attached to the frame would be one no
projection reducer can fold, leaving every projection over it incomplete for a
change that has fully landed. A retry with the same idempotency key finds the
operation already recorded for that transaction and records nothing more. The
endpoints refuse with `503 STORAGE_UNAVAILABLE`, before anything is proposed,
when no evidence store is configured, as the eight correction endpoints do: a
merge the owner asked for is never committed without the record of the request.

The eight other controls keep their own endpoints (ADR 0019): suppress, archive
and delete are `POST /v1/memory/suppressions`, `/archives` and `/deletions`.

## 4. The browser reaches the correction endpoints through the proxy

The same-origin proxy maps `memory/corrections`, `state-changes`,
`confirmations`, `rejections`, `keep-uncertain`, `suppressions`, `archives` and
`deletions` to `memory.correct`, and pins the evidence context those routes
require: `x-data-purpose: PERSONAL_ASSISTANCE` as every other browser write does,
and `x-maximum-sensitivity: PRIVATE`, which is also the sensitivity the owner's
own correction text is stored at. The browser cannot raise either. Merge and
split keep the `memory.govern` mapping ADR 0025 gave them.

## 5. Screens

Five screens, each a props-only component with its page and a loader in
`apps/web/lib/memory.ts` that takes the API call as a parameter (so the
end-to-end tests drive the real API through the same function the page calls):

| Screen | Page |
| --- | --- |
| Commitments | `/commitments` |
| Obligations | `/obligations` |
| Memory inspector | `/memory/inspector/{objectType}/{id}` |
| Memory thread | `/memory/threads/{id}` |
| Correction controls | `/memory/correct/{objectType}/{id}` |

Status is always text and a symbol, never colour alone: overdue, contested,
resolved, partially resolved, pending owner assertion and incomplete projection
each carry their own word. Identifiers appear only in the inspector's advanced
identifier panel (the design's accessibility rule), not in the Commitments or
Obligations reading path.

The Commitments screen's "filtered by thread" state is applied by the loader
over the threads `frames/related` returned, because the projection read may not
read memberships; person and due window are the projection route's own filters.

Every belief a screen shows carries an "Inspect" and a "Correct" link built by one
function, `beliefLinks` in `apps/web/components/BeliefLinks.tsx`, over the object
reference the surface already has. Today, Ask and Weekly Review use the same
function; see §6.

## 6. What this node cannot wire, and says so

CRT-UX-10-B names Today, Ask, Commitments and Weekly Review. In this workspace:

- **Commitments** and **Obligations** link every row's beliefs to the inspector
  and the controls.
- **Today** and **Ask** are drawn by `web-shell-labels-today-briefing-and-ask-surface`,
  a dependency of this node whose delivery has not landed on master; its branch
  is based on an earlier master and conflicts with the landed answer-manifest
  node, so merging it here would mean re-landing another node's work. The API
  half is covered instead: an answer from the landed `POST /v1/ask` names its
  objects, and the inspector route opens and the controls correct each of them.
- **Weekly Review** belongs to `memory-inbox-attention-budgets-and-weekly-review`,
  which is not a dependency of this node in either direction.

Both gaps are submitted as findings rather than closed by drawing screens this
node does not own.
