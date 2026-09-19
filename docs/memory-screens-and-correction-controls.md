# Commitments, Obligations, Memory inspector, Memory thread and the Correction controls

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`commitments-obligations-inspector-and-correction-controls`. This node owns
CRT-UX-04-A, CRT-UX-07-A, CRT-UX-10-A, CRT-UX-10-B and CRT-UX-15-A. ADR 0028
records its decisions; ADRs 0001–0027 were read and retained unchanged.

The branch was brought up to master (merge-split lineage, connectors, semantic
index, answer manifests) before this work, and again once the web shell, Today
and Ask node (ADR 0027) landed, so Today and Ask link their beliefs here too.

## Design screens implemented here

| Screen | Page | Component |
| --- | --- | --- |
| Commitments | `/commitments` | `apps/web/components/Commitments.tsx` |
| Obligations | `/obligations` | `apps/web/components/Obligations.tsx` |
| Memory inspector | `/memory/inspector/{objectType}/{id}` | `apps/web/components/MemoryInspector.tsx` |
| Memory thread | `/memory/threads/{id}` | `apps/web/components/MemoryThread.tsx` |
| Correction controls | `/memory/correct/{objectType}/{id}` | `apps/web/components/CorrectionControls.tsx` |

Every designed state is reachable from props: Commitments (loading, empty, open
with due dates, people and sources, overdue set by the clock with no FAILED or
MISSED, resolved with its resolution evidence, partially resolved, contested
marked distinctly, pending owner correction applied, incomplete read with the
pending assertion and high-risk actions blocked, completeness flag and overlay
watermark, filtered by person, thread or due window); Obligations (typed amount,
currency and due time, canonical allocated total with the capability-derived
remainder, advisory coverage labelled advisory, unallocated remainder shown as
unknown, two conflicting amounts both kept, separate obligations kept separate,
fulfilled by an accepted resolution); Memory inspector (all fourteen design
states, including the advanced identifier panel, an UNSUPPORTED derived belief,
four separate claim confidences and an assistant-only fact that is not a
belief); Memory thread (all eight states); Correction controls (the ten
controls, each stating what it will change, the acknowledged write with its
owner sequence, the next read from another device, a contested delta with its
reason, conflicting evidence, affected projections and containing manifests,
and re-extraction shown as contested and never as reversed).

Status is text plus a decorative symbol (`Status` in `MemoryChrome.tsx`), never
colour. Identifiers appear only in link targets and the inspector's Advanced
panel.

## Design entities

No table is added. The node writes **`memory_operations`** rows of kind `MERGE`
and `SPLIT` (the lineage endpoints now record them, ADR 0028 §3) and reads
`open_commitments_projection`, `obligations_projection`, `memory_threads`,
`memory_thread_members`, `memory_operations`, `owner_overlay_deltas`,
`derived_proposition_dependencies`, `resolution_assertions`, `answer_manifests`
and `audit_events` through the existing row policies.

## HTTP surface added

| Route | Purpose | Answer |
| --- | --- | --- |
| `GET /v1/memory/inspector/{objectType}/{id}` | `memory.inspect` | the explanation plus asserting actors, per-claim confidences, original evidence with anchor text (withheld items counted), inferences both ways, connected threads, access history, memory operations; `400 INSPECTOR_REQUEST_INVALID`, `404 INSPECTOR_TARGET_NOT_FOUND` |
| `GET /v1/memory/frames/related?ids=…` | `memory.inspect` | per frame: people with roles, sources, resolutions with their evidence and asserting entity, beliefs, threads; `400 RELATED_FRAMES_REQUEST_INVALID` |

`objectType` is one of `proposition`, `claim`, `frame_instance`,
`resolution_assertion`, `owner_overlay_delta` — every object Today, Ask,
Commitments and Weekly Review name. The four merge and split endpoints now also
answer `memoryOperationId`, and refuse `503 STORAGE_UNAVAILABLE` when no evidence
store is configured. The same-origin proxy maps the eight correction endpoints to
`memory.correct` and pins `PERSONAL_ASSISTANCE` / `PRIVATE`.

## How each acceptance criterion is met

All in `apps/web/e2e/memory.test.ts`, which drives the real platform API, the
real owner boundary and row policies through the loaders the pages call
(`apps/web/lib/memory.ts`) and renders each screen from the answer; states the
fixture does not reach are in the component tests.

- **CRT-UX-04-A** — the Commitments view shows an open commitment with its due
  date, the people (“Promised to: Daniel”) and the source excerpt; the overdue
  flag in words, with no FAILED or MISSED assertion anywhere; a resolved
  commitment with its resolution evidence; a contested commitment (two accepted,
  different settling outcomes) marked in words and by class; the completeness
  flag and owner sequence. The Obligations view shows the allocation total, the
  remainder the capability derived, the advisory coverage labelled “Advisory
  only”, and both conflicting amounts.
- **CRT-UX-07-A** — the inspector for the Daniel loan principal shows the current
  belief, the timeline, the original evidence text, the claim asserted by “Me”
  with its origin and confidences, the inference it is an input to, the competing
  value, the partial resolution, both threads, its own earlier opening in the
  access history, and the registry and extractor versions.
- **CRT-UX-10-A** — the ten controls have ten labels, ten buttons, ten endpoints
  and ten operation kinds; each is posted to the real API with the request the
  screen builds and exactly the headers the proxy sets, and the ten
  `memory_operations` rows carry ten different kinds. Suppress, archive and
  delete are `/suppressions`, `/archives` and `/deletions`.
- **CRT-UX-10-B** — the Commitments, Today and Ask screens are each loaded
  through the loader their page calls (Today with its clock pinned to the
  fixture's week) and rendered; every Inspect link on each opens a ready
  inspector, every Correct link opens the Correction controls, whose Keep
  uncertain control is posted and persists a `KEEP_UNCERTAIN` operation, and the
  two sets of links match. Every Today item links its primary source; the Ask
  conflict statement links both competing principal amounts. A confirmation
  posted from a commitment row lands on the belief that row showed. Weekly
  Review: see the limits below.
- **CRT-UX-15-A** — the Daniel payment thread shows its obligations projection
  fragment, a timeline, the promise as a plan, the principal as an actual event,
  the partial repayment as a resolution link, Daniel's different figure as an
  open uncertainty, Daniel and Me as people and the bank transfer receipt as a
  document; the same obligation in a second thread carries identical evidence.

`pnpm test` (78 files passed and 1 skipped; 682 tests passed and 4 skipped), `pnpm typecheck`
and `pnpm build` pass.

One change outside this node's files keeps `pnpm test` stable: the registry
snapshot test (`packages/registry/src/snapshot.test.ts`) now takes both registry
locks `NOWAIT` before its refused TRUNCATE. It used to wait for its second lock
while holding the first, and a belief transaction reading contracts joined to
releases in parallel could be chosen as the deadlock victim. The assertion that
the TRUNCATE is refused with `REGISTRY_SNAPSHOT_IMMUTABLE` is unchanged.

## What this node does not claim

- **Weekly Review** belongs to `memory-inbox-attention-budgets-and-weekly-review`,
  which is neither an ancestor nor a descendant of this node and has not landed:
  no Weekly Review screen or route exists. `BeliefRefLinks` is the one function
  it needs to link its beliefs. Submitted as a finding against CRT-UX-10-B.
- **No deletion cascade, no canonical archive.** The Delete and Archive controls
  record their requests exactly as ADR 0019 delivered them.
- **Entity split from this screen** is not offered: it needs alias assignments
  the inspector does not carry; the screen links to Merge and split review, which
  offers it.
- **No keyboard walkthrough artifact or automated accessibility check in CI**;
  those are `accessibility-audit-trail-and-security-test-suite`'s (CRT-UX-14-A).
