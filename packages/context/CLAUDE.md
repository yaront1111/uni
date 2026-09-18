# @unai/context

The Context Broker, the belief explanation and the memory thread service (PRD
§21.4, §23, §33.11, §35.7, §35.8, §36.11, §50). Report: `docs/context-broker.md`;
decisions: `docs/adr/0022-context-broker-packets-explain-and-memory-threads.md`.

This is the only memory read path for models and plugins (FR-060).

## Local invariants

- **Everything here is a read.** `memory.read` appears in no INSERT, UPDATE or
  DELETE policy on any canonical table (migration 0017). The only rows this
  package writes are `context_packets`, `memory_threads`,
  `memory_thread_members` and `policy_decisions`. If a change here needs to write
  canonical memory, it belongs in `@unai/memory` or `@unai/belief` instead.
- **No transaction, no connection, no network.** Every function takes a
  `MemoryTransaction` the caller opened inside the owner boundary, exactly as
  `@unai/memory`, `@unai/belief` and `@unai/capabilities` do. The one exception is
  `readContextPacket`, which takes a *runner* and uses two transactions on
  purpose — see below.
- **No model call.** `classifyAnswerType` is deterministic string matching over
  the thirteen query modes of PRD §23.3. This package depends on no gateway.
- **No life-category column.** Categories are derived on read in `categories.ts`
  from the evidence's allowed purposes and the frame's registry namespace. Adding
  a category means adding a rule there — never a migration, never a second copy
  of the data (CRT-MEM-02-A).

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
- **A thread owns nothing.** `memory_thread_members` carries no evidence column.
  Attaching an object to a second thread writes one row naming a row that already
  exists; if a change here starts creating evidence, claims or propositions,
  CRT-RD-10-A is broken.
