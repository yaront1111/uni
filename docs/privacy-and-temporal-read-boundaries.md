# Privacy and temporal read boundaries

Date: 2026-09-19. First implementation tranche of [Task A](plans/2026-09-19-evolving-understanding.md).

## Behavior

The Context Broker filters owner assertions and their independent verification by source authorization and knowledge time before assembling or storing a packet. Later-recorded claims, assessments, and resolutions cannot introduce their values into earlier context. ACTUAL values with a future valid-from date do not become current values through a missing assessment interval. The selector uses the same claim-interval fallback as the broker.

Source-object redaction applies to selected citations and semantic matches even when a proposition has other readable support. Resolution assertions require readable supporting evidence, applicable recorded/effective times, and no object redaction. Projection fragments carry only authorized pending text. Thread summaries are attached only through frames whose values were supplied.

Today derives candidates, descriptions, amounts, deadlines, conflicts, pending labels, and outcomes from its persisted authorized packet. It no longer uses an owner-wide projection read to supply those fields. Participant names require a sourced role and a readable alias; unsourced canonical labels are not display authority. A partial fulfillment remains open, a final outcome settles its source frame, and different final outcomes remain contested.

Why/source panels and thread values, outcomes, pending text, and names check supporting source access. An unreadable subject yields a content-free unknown panel. A readable assertion about an unnamed person keeps its person attribution rather than being attributed to the owner.

Suppression and deletion controls remain effective even when their explanation is unreadable, including historical queries. The broker reads their target identifiers independently of the explanation. Frame/slot controls also exclude their propositions; outcome links cannot reveal a removed frame through a visible endpoint. Archival excludes default current/Today context while allowing explicit history, decision reconstruction, episode recall, causal explanation, source lookup, pattern review, and prediction/outcome comparison.

No applied migrations, immutable registry releases, or external action permissions changed. Broker/selector versions distinguish newly assembled packets from earlier behavior.

## Verification

Regression tests use the real PostgreSQL owner boundary, accepted registry fixtures where selection requires them, and the API/Ask/Today paths. Negative assertions retain independent permitted controls and authorized positive reads. They inspect returned and stored packets/briefings where applicable.

Failures were observed before fixes for restricted/purpose-forbidden overlay text, later-known claims/deltas/outcomes, future-effective accepted selections, mixed-support citation redaction, resolution redaction, Today field/time/state leaks, Why/thread source and name leaks, suppression revival, archive history loss, and resolution links crossing a removed frame. Invalid fixture setup was corrected before treating a failure as product evidence.

The deletion regression erases evidence through the API, checks invalidation of an earlier packet and Why subject, and verifies current/historical Ask cannot recall its marker while unrelated context remains usable. Retained conversation history is not treated as canonical support.

Integrated with Moe's `master` at `3bea9ec` in the isolated worktree (`0c0c3fe`), then verified:

| Check | Result |
| --- | --- |
| `pnpm test` | 898 passed, 4 existing skips; 105 files passed, 1 skipped. Disposable PostgreSQL/object-storage harness. |
| `pnpm typecheck` | Root and web passed. |
| `pnpm build` | Next.js production build passed. |
| `pnpm validate:registry` | Releases 0.1.0 and 0.2.0 passed. |
| `pnpm uai registry test` | 736 contract cases passed. |
| `pnpm uai registry shadow-diff --sample corpus:synthetic` | Passed; zero changed semantic outcomes. |
| `pnpm uai corpus run --corpus synthetic` | 12 threads passed identity thresholds. |

The free-agent changes add 43 tests over the initial 824-test baseline. Before integration, the branch passed 867 tests; the additional integrated tests came from Moe's accessibility/audit/security delivery. Reports and harness logs were written to the local temporary directory. The owner-local real-corpus gate was not run.

## Remaining work

- This is not the complete Task A exit or an audit of every memory reader. Advanced inspector output, complete historical replay of mutable graph/lifecycle state, and multi-input derived-value erasure need further focused review. Projection completeness/watermarks remain conservative current operational metadata, not a reconstructed historical snapshot.
- Semantic matches withheld by an explicit policy verdict are removed after the existing search. Moving all policy exclusions before relevance budgeting belongs with the retrieval work; this change does not claim to fix the existing 100-frame candidate limit.
- Explicit aging policies/provenance, old-commitment retrieval, the processing worker, and scheduled initiative remain subsequent tasks. No model-backed production ingestion journey or deployment is claimed.
- The owner-local real corpus gate still requires actual owner data; synthetic fixtures do not satisfy it.
