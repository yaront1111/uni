# Evolving understanding verification

Recorded 2026-09-19. Validated implementation commit:
`9cbfa474ca8e8eb844d45f48b38ccd2a4a0bab46`, including master `e0671ee`.
The following documentation-only commit records these results.

| Check | Result |
| --- | --- |
| Root and web typecheck | PASS |
| Full disposable PostgreSQL/storage suite | 1,114 passed; four live-provider tests skipped |
| Existing acceptance harness | 20/20 scenarios passed |
| Coordinated database/object recovery | 84 tables, 156 live objects, and 20 fresh Today/Ask/Why read pairs matched |
| Erasure during recovery | One real-store deleted object verified absent; inconsistent tombstones or retained bytes refuse backup |
| Production web build | PASS on merged application sources; subsequent changes concern tests and recovery tooling |
| Registry lint | PASS for immutable releases 0.1.0, 0.2.0 and 0.3.0 |
| Registry contracts | 1,177 cases passed |
| Synthetic corpus | 12 threads passed configured thresholds |
| Real corpus | NOT MET: `REAL_CORPUS_EVALUATION_REQUIRED`, `REAL_RESULTS_MISSING` |

`pnpm check:phase-exit` therefore exits nonzero at its final real-corpus check.
The existing 20-scenario acceptance harness is not a claim that every new PRD
exit condition has independently acquired a numbered harness scenario. Added
behavioral tests exercise contextual aging and original-source time, historical
lifecycle and read authority, old unfinished retrieval among populated completed
and unreadable frames, decision rationale, current goals, durable processing,
source-bound initiative, current reminder state, draft permission and retries.

The post-integration fixes preserve the existing recovery guarantees: recovery
callers declare source purpose and sensitivity for each transaction, live
objects retain exact hash checks, and erased objects cannot enter the archive.
Restored answer comparisons use persisted fixtures without reseeding them.

This is repository implementation and automated verification, not production
activation or a real-provider journey. Deployments still require migrations,
an explicitly published/pinned registry release, and configured API/worker
processes. Registry 0.3.0 does not add the complete birthdate, employment, salary,
health or preference ontology. Unsupported extraction stays `NEEDS_REVIEW`;
grounded model commitments remain provisional until governed acceptance.

Initiative uses explicit watches and generic drafts, with no external execution.
Unchanged situations are deduplicated. Inbox, Mentor and initiative share daily
attention counts, but simultaneous distinct requests can race that count; it is
not an atomic cross-surface quota. Relative Ask change windows state UTC bounds;
initiative schedules use the owner's configured time zone. A signed-in browser
walkthrough and measured improvement in owner effort are not claimed.

See [memory aging](memory-aging.md), [worker setup](processing-runtime.md), and
the [implementation plan](plans/2026-09-19-evolving-understanding.md).
