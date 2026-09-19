# @unai/context

The Context Broker, the belief explanation and the memory thread service (PRD
§21.4, §23, §33.11, §35.7, §35.8, §36.11, §50). Report: `docs/context-broker.md`;
decisions: `docs/adr/0022-context-broker-packets-explain-and-memory-threads.md`.

This is the only memory read path for models and plugins (FR-060).

It also holds deterministic selection (`selector.ts`), the eight-type question
classifier (`question.ts`) and the Ask pipeline (`ask.ts`, route
`packages/api/src/ask.ts`). Report: `docs/semantic-index-and-ask.md`;
decisions: `docs/adr/0024-deterministic-selection-semantic-index-and-ask.md`.

It also holds answer provenance: the grounding validator (`grounding.ts`), the
answer manifests and reconsideration read (`manifests.ts`) and the shared
statement wording (`wording.ts`). Report: `docs/answer-provenance.md`;
decisions: `docs/adr/0026-answer-manifests-grounding-and-reconsideration.md`.

It also holds the Today briefing (`today.ts`, route `packages/api/src/today.ts`),
its pure ranking (`ranking.ts`) and the Why? / Sources panel read (`why.ts`).
Report: `docs/today-and-ask.md`; decisions:
`docs/adr/0027-web-shell-labels-today-briefing-and-ask.md`.

## Local invariants

- **Everything here is a read.** `memory.read` appears in no INSERT, UPDATE or
  DELETE policy on any canonical table (migration 0017). The only rows this
  package writes are `context_packets`, `memory_threads`,
  `memory_thread_members`, `policy_decisions` and — under `answer.record` only —
  `answer_manifests`. If a change here needs to write canonical memory, it
  belongs in `@unai/memory` or `@unai/belief` instead.
- **A manifest says "supplied", never "used".** It is derived by
  `suppliedContextOf` from the packet read back from `context_packets` and
  checked against its hash — never from the in-memory packet or a second
  retrieval. What the packet names only as withheld (redactions, unknowns, the
  read-policy step's exclusions) is not supplied. No field or label may name
  which item the model used (CRT-RD-07-A); a test walks every key for it.
- **No transaction, no connection, no network.** Every function takes a
  `MemoryTransaction` the caller opened inside the owner boundary, exactly as
  `@unai/memory`, `@unai/belief` and `@unai/capabilities` do. The one exception is
  `readContextPacket`, which takes a *runner* and uses two transactions on
  purpose — see below.
- **No model call.** `classifyAnswerType` is deterministic string matching over
  the thirteen query modes of PRD §23.3. This package depends on no gateway: a
  phrasing model reaches it only through the `AnswerPhraser` port the API fills
  (`createGatewayAnswerPhraser`).
- **Selection is a pure function.** `selectSlotState` reads no clock, random
  source, model or network, compares only the request's world and knowledge
  instants, and sorts every list it returns. `selectionsDigest` over its output
  must be identical on repeated runs (CRT-RD-03-A). Anything that makes it depend
  on row order or on `new Date()` breaks that. It never picks between two standing
  values (`CONTESTED` has no selected proposition), never selects under an
  unregistered contract, and fails closed when no registry release is pinned.
- **The Ask composer calls no model.** Statements are built from the packet by
  code; each names the packet objects it rests on and links only evidence the
  packet carries, never an assistant's own message.
- **Nothing is presented unvalidated.** Every candidate — a model's or the
  composer's — goes through `validateGrounding` first (CRT-RD-08-A). The
  validator is pure; the strongest action wins (block, regenerate, downgrade).
- **No life-category column.** Categories are derived on read in `categories.ts`
  from the evidence's allowed purposes and the frame's registry namespace. Adding
  a category means adding a rule there — never a migration, never a second copy
  of the data (CRT-MEM-02-A).

- **The only memory read path for models and plugins.** `src/boundaries.test.ts`
  stops its walk at this package, so a narrow read a plugin needs (such as
  `listOpenThreadIds` for `@unai/connectors`) is added here rather than in the
  plugin runtime (CRT-RD-01-A, ADR 0031 §2).
- **A briefing surfaces only what its packet supplied.** `buildTodayBriefing`
  reads the typed projection rows *for the frames the packet carries* and no
  others; reading the projections first and the packet second would let a frame
  above the ceiling into Today. The edition and its items are written under
  `memory.read`, like the packet, and are immutable: the history decides what is
  suppressed tomorrow.
- **Ranking never sees a recording time.** `rankBriefing` is pure and its seven
  components carry no timestamp; tie-breaks are past-target, then the sooner
  target, then the id. Adding `created_at` or `lastMaterialUpdate` to the score
  would reintroduce "newest first" (CRT-UX-02-A).

## Traps

- **A denial must outlive its refusal.** `recordPolicyDecision` runs inside the
  transaction, so raising the refusal in that same transaction rolls the record
  back. `readContextPacket` authorizes in one transaction and assembles in the
  next; `assembleContextPacket` accepts the recorded `authorization` so the port
  is not asked twice. A route that calls `assembleContextPacket` directly refuses
  correctly but keeps no record (CRT-SEC-02-A). The same holds for a refused
  *action*: `assemble` returns the denial as a value so its transaction commits,
  and only the caller raises it. Turning that return into a `throw` would put the
  `EvaluateMemoryAction` verdict back on the rollback path.
- **An action is gated after retrieval, not before it.** The evidence an action is
  bound by is the evidence *this packet rests on*, which is not known until the
  beliefs are assembled. `intendedAction` is therefore evaluated at the end of
  `assemble` and the purpose must be admitted by every one of those items
  (ADR 0022 §10, CRT-SEC-02-A).
- **Transaction-local settings do not cross transactions.** `unai.data_purpose`
  and `unai.maximum_sensitivity` are re-declared at the top of every entry point.
- **A redaction has three places to escape.** A value is stated on the belief, on
  the future claim and on the conflict position. `withoutFields` must run over all
  three, or a REDACT verdict only moves the value (CRT-WRT-03-B).
- **Knowledge time filters on `recorded_at`.** A fixture that lets `recorded_at`
  default to the wall clock while pinning `knowledgeTime` to a past instant will
  retrieve nothing and look like a broken query. Set it explicitly.
- **`evidence_labels` is the only thing that sees above the ceiling**, and it
  returns id, sensitivity and allowed purposes and nothing else. Do not widen it
  to carry text, an object key or an anchor: the point is to be able to *list* a
  withheld item, not to read it (CRT-SEC-09-A).
- **Assessment validity decides current versus historical.** A change closes the
  earlier value's period on its *assessment*, not on its claim, so the belief
  rows read the version live at the knowledge time and prefer its interval to the
  claims'. Reading only claim intervals reports a change over time as a live
  conflict.
- **Overlay authorization applies before packet assembly.** The broker binds
  deltas and their independent verification to the requested knowledge time and
  authorized source evidence. Projection pending text must obey those same
  bounds. Pin fixture `created_at` and `recorded_at` explicitly when the test
  clock is fixed; never widen a production read to accommodate a fixture clock.
- **A suppression fingerprint must not contain the day.** `materialFingerprintOf`
  hashes the material state only. Putting the headline (which says "due in
  20 hours") or the rank score in it makes every item look changed every day,
  and nothing is ever suppressed.
- **The Why? panel's excerpt is evidence.** It is read from `source_anchors`
  through the evidence policies, so the route must declare `unai.data_purpose`
  and `unai.maximum_sensitivity` first; without them every excerpt reads as
  withheld.
- **A thread owns nothing.** `memory_thread_members` carries no evidence column.
  Attaching an object to a second thread writes one row naming a row that already
  exists; if a change here starts creating evidence, claims or propositions,
  CRT-RD-10-A is broken.
