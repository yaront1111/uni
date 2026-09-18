# The Context Broker, context packets, the belief explanation and memory threads

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`context-broker-packets-explain-and-memory-threads`. This node owns
CRT-MEM-02-A, CRT-RD-02-A, CRT-RD-05-A, CRT-RD-09-A, CRT-RD-10-A, CRT-RYW-03-A,
CRT-SEC-02-A, CRT-SEC-09-A and CRT-WRT-03-B. ADR 0022 records its decisions;
ADRs 0001–0021 and every delivered slice before it were inspected and retained
unchanged.

## Design entities implemented here

**`memory_threads`**, **`memory_thread_members`** and **`context_packets`**,
added by `migrations/0017_context_broker_and_memory_threads.sql` with forced RLS,
purpose-gated policies, composite owner foreign keys, an immutability trigger on
`context_packets` and `memory_thread_members`, and an identity trigger on
`memory_threads`. No earlier table gains a column. There are now 49 application
tables, 47 of them owner-scoped and classified in
`packages/postgres/src/ownership.ts`.

The migration also replaces the SELECT policies of `frame_instances`,
`frame_instance_roles`, `belief_slots`, `propositions`, `claims`, `entities`,
`entity_aliases`, `memory_links`, `resolution_assertions`, `belief_assessments`,
`belief_support`, `claim_relations`, `derived_proposition_dependencies`,
`belief_transactions`, `owner_overlay_deltas`, the three projection tables and
`policy_decisions` so that `memory.read`, `memory.inspect` and `memory.thread`
may read what each needs — and nothing more. It adds one function,
`unai_private.evidence_labels(uuid)`, and widens `unai_private.evidence_access`
with the two read purposes.

`memory_summaries`, `memory_embeddings` and `answer_manifests` are **not**
implemented here. The semantic index belongs to
`current-state-selector-semantic-index-and-ask-pipeline` and the manifests to
`answer-manifests-grounding-validator-and-reconsideration`.

## Design screens this node serves

It draws no screen. It delivers the read path the design's **Memory inspector**
and **Memory thread** screens sit on, and it is the only memory read path for
models and plugins (FR-060).

| Screen state (design) | What answers it |
| --- | --- |
| Memory inspector: current assessment with its policy version and decision reason | `currentAssessment` on `GET /v1/memory/propositions/{id}/explain` |
| Memory inspector: the claims that assert the value, with origin and lifecycle | `claims` |
| Memory inspector: the evidence anchors those claims are grounded in | `evidenceAnchors` |
| Memory inspector: support graph and independence groups | `supportGraph`, `independenceGroups` |
| Memory inspector: contradictions | `contradictions` — competing proposition, claim relation, `CONTRADICTS` memory link, contested overlay delta |
| Memory inspector: history over valid time and recorded time | `temporalHistory` |
| Memory inspector: resolution links | `resolutionLinks` (resolution assertions and protocol links) |
| Memory inspector: the registry and extractor versions everything was pinned to | `registryVersions`, `extractorVersions` |
| Memory inspector: which projections consume this value | `projectionConsumers` |
| Memory thread: members, timeline, plans, actual events, resolutions | `GET /v1/memory/threads/{id}` |
| Memory thread: open uncertainties, related people, documents and decisions | the same read's `openUncertainties`, `relatedPeople`, `relatedDocuments`, `relatedDecisions` |
| Memory thread: one object in two threads | `POST /v1/memory/threads/{id}/members`, twice, one membership row each |

## HTTP surface

| Route | Purpose | Answer |
| --- | --- | --- |
| `POST /v1/memory/context` | `memory.read` | `201` with a context packet; `400 CONTEXT_REQUEST_INCOMPLETE` / `CONTEXT_REQUEST_INVALID`; `403 CONTEXT_READ_DENIED` / `CONTEXT_ACTION_DENIED` |
| `GET /v1/memory/propositions/{id}/explain` | `memory.inspect` | `200` with the explanation; `404 PROPOSITION_NOT_FOUND` |
| `GET /v1/memory/threads/{id}` | `memory.inspect` | `200` with the thread view; `404 MEMORY_THREAD_NOT_FOUND` |
| `POST /v1/memory/threads/{id}/members` | `memory.thread` | `201` on a new membership, `200` when it already existed; `404` for an unknown thread or object |

The web proxy (`apps/web/pages/api/platform/[...path].ts`) is **not** extended.
It is POST-only and maps the paths the screens it already serves need; the screen
nodes that build Memory inspector and Memory thread add their own mapping.

## How each acceptance criterion is met

- **CRT-RD-02-A** — `missingContextFields` is a pure function over the raw body,
  called by the route *before* `work(...)` opens a transaction. A request missing
  purpose, requesting actor, owner scope, world time, knowledge time, maximum
  sensitivity or action risk is answered `400` with the field names, and no
  `context_packets` row and no query happen. Each field is removed on its own in
  both `packages/context/src/context.test.ts` and `packages/api/src/context.test.ts`.
- **CRT-SEC-02-A** — *read half*: the declared data purpose is checked
  against the evidence's `allowed_purposes` and handed to `EvaluateMemoryRead`,
  which answers `DENY / PURPOSE_NOT_IN_ALLOWED_PURPOSES`. `readContextPacket`
  commits that verdict in its own transaction before raising the refusal, so the
  denial is in `policy_decisions` and no packet exists. *Action half*: a request
  may declare an `intendedAction`, and the broker puts it to
  `EvaluateMemoryAction` after retrieval, against the purposes admitted by every
  evidence item the packet rests on. A request declaring no action purpose is
  denied `PURPOSE_NOT_PERMITTED_FOR_ACTION`; one whose purpose that evidence does
  not admit is denied `PURPOSE_NOT_IN_ALLOWED_PURPOSES`, recorded in
  `policy_decisions`, answered `403 CONTEXT_ACTION_DENIED`, and **no packet is
  written**. `MemoryActionRequest` now carries `allowedPurposes`, so the port
  holds a read and an action to one rule (ADR 0022 §10). The gate sits here
  because FR-060 makes this the only memory read path a model or a plugin has,
  and an action founded on memory is founded on a packet. *Open*: which evidence
  an action must satisfy — every item behind the supporting memory, or only those
  behind the values it rests on — is undecided; V0 takes the stricter reading, and
  the question is recorded as a finding on this node.
- **CRT-SEC-09-A** — a request at `PRIVATE` receives no `RESTRICTED` object: the
  item is listed as `ABOVE_MAXIMUM_SENSITIVITY`, the belief whose every support
  was withheld is listed as `SUPPORTING_EVIDENCE_WITHHELD`, both appear in
  `unknowns`, and no field of either is in the packet. The same request at
  `RESTRICTED` receives them, which is what makes the first a decision rather
  than an absence.
- **CRT-WRT-03-B** — a REDACT verdict naming fields removes exactly those keys
  from the belief, the future claim *and* the conflict position, and lists them
  in `redactions`. The test asserts the value appears nowhere in the packet or in
  the stored row.
- **CRT-RD-05-A** — one fixture with a conflict, an unknown, a pending overlay
  and an incomplete projection yields non-empty `conflicts`, `unknowns`,
  `ownerOverlayDeltas`, `projectionFragments` with `isComplete` per projection,
  and `watermarks` carrying the owner overlay watermark, the canonical
  transaction watermark, the projection versions and both times.
- **CRT-RYW-03-A** — the four intersections are four `OR`-ed arms over
  `owner_overlay_deltas`, each tested separately; the test also asserts the other
  three deltas are *not* swept in.
- **CRT-MEM-02-A** — one `source_items` row admitting `PERSONAL_FINANCE` and
  `FAMILY_COORDINATION` and one set of semantic objects appear in the finance
  view and in the family view, with the same `evidenceIds`, and nothing is
  duplicated by being viewed twice.
- **CRT-RD-09-A** — the explanation returns all nine sections for a proposition
  that has a competing value, a `CORRECTS` claim relation and an accepted
  resolution.
- **CRT-RD-10-A** — one frame instance joins two threads through two membership
  rows; both `GET` responses list it with identical `evidenceIds`, and the
  `source_items` and `claims` counts are unchanged.

## What this node does not claim

- It **assembles** a packet; it does not select "the one right value". Competing
  values are reported as conflicts and never resolved here.
- It runs **no model**. `classifyAnswerType` is deterministic string matching
  over the thirteen query modes, not an LLM call, and the package depends on no
  gateway.
- It writes **no canonical memory**. `memory.read` holds no write grant anywhere;
  the only rows this slice writes are `context_packets`, `memory_threads`,
  `memory_thread_members` and `policy_decisions`.
- The **semantic index, the ranked retrieval and the answer manifest** are not
  here. Retrieval is by declared hints and recency within a bounded frame limit;
  `current-state-selector-semantic-index-and-ask-pipeline` and
  `answer-manifests-grounding-validator-and-reconsideration` own the rest.
- The **life-category catalog is V0 and small** (`CATEGORY_RULES` in
  `packages/context/src/categories.ts`). It is a declared rule set, extended by
  editing that file; it is not derived from the registry and it is not learned.
- It **executes** no action. `EvaluateMemoryAction` is called only when a request
  declares an `intendedAction`, and its ALLOW is a permission recorded on the
  packet, not a draft, an email or a calendar write — V0 refuses every external
  action kind but a draft, and creating even that belongs to
  `drafts-actions-permissions-export-and-deletion-workflow`. When a request
  declares nothing, `allowedActions` still only says what the packet's state
  would permit and no port was asked.
