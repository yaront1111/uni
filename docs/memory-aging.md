# Contextual memory aging

Freshness answers whether a record still describes the requested situation. It
does not change the record's historical truth, support confidence, or retention.
Reading, summarizing, embedding, importing, and retrying processing are not new
confirmation.

## Policy by meaning

Registry release `0.3.0` assigns versioned policies to its existing predicates.
Earlier release pins and unsupported predicates return `UNKNOWN`; the system
does not infer a policy from the source type or silently change a release.

| Policy | Applicability |
| --- | --- |
| Stable | Remains applicable unless a governed change or explicit interval says otherwise. |
| Bounded episode | Applies within its recorded interval; outside it, no recovery or replacement state is invented. |
| Last known | Preserves the last assertion, with verification when stale or decision-relevant. |
| Preference | Becomes less suitable as a current assumption without renewed evidence. Historical preference remains available. |
| Unresolved | Passage of time does not fulfill, cancel, or discharge a commitment. A stale item can require an outcome check. |
| Decision history | Preserves what was considered and why; later knowledge does not rewrite the original reasoning. |
| Incidental | Loses default prominence while remaining separately subject to retention policy. |

Review intervals belong to individual semantic policies. There is no universal
decay factor. The evaluator supports these seven kinds; it does not add canonical
birthdate, salary, employer, health, or general preference contracts to V0.

## Dates and provenance

Each assessment carries the exact registry release/hash and policy version, the
requested world and knowledge times, the original evidence basis, eligible claim
and source references, valid interval, and an explicit applicability reason.

An imported year-old assertion uses its original source time. A model extraction
may reuse that basis only when it points to the original assertion; an inference,
quotation, assistant restatement, or transitive operand is not fresh evidence of
the output. Missing source time remains unknown. A later explicit confirmation
can supply a new basis, but cannot appear before its recorded knowledge time.

`CURRENT`, `VERIFY`, `OUTSIDE_INTERVAL`, and `UNKNOWN` describe applicability.
They do not mutate canonical confidence, accept a provisional interpretation, or
delete anything. Last-known answers include their evidence date and uncertainty.
Expired temporary conditions are not described as current or as recovered.

## Retrieval and personal understanding

The Context Broker resolves semantic matches before selecting values, checks
source authority before spending the answer frame budget, and preserves bounded
redaction placeholders separately. Its metadata scan and provenance traversal
have explicit ceilings; reaching them makes the view incomplete.

The personal-understanding view is rebuilt from the authorized packet. It records
current, last-known and historical propositions, explicit versus inferred origins,
recorded transitions, unresolved frames, and sourced links to active goals.
Unknown change motives stay unknown. Decision reconstruction reads recorded
rationale even when its interval ended. Change answers distinguish when Uai
learned a transition from when it took effect and state the date-window basis.

Current source permissions and removal controls apply to historical reads and
saved answers too. Historical lifecycle state comes from an append-only journal;
pre-journal history is unknown rather than reconstructed from today's lifecycle.

## Product and runtime

Today retains overdue and undated unfinished work, shows incomplete memory, and
uses an actual active-goal link for goal relevance. Ask offers the five personal
assistant questions and keeps unavailable evidence explicit.

The [processing worker](processing-runtime.md) records durable progress and
preserves original source context. `/initiative` enables owner-local checks and
explicit prerequisite watches, with snooze, attention limits, and unchanged-state
deduplication. Preparation requires a live draft grant and policy decision.
Drafts remain generic because the existing independently retained draft store is
not an appropriate place to copy private source text. V0 does not execute external
actions.

Automated disposable-database journeys do not establish real-corpus readiness or
service activation. Those remain separate operational gates in the
[implementation plan](plans/2026-09-19-evolving-understanding.md).
