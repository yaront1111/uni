# Governed action and the data-control surface

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`drafts-actions-permissions-export-and-deletion-workflow`. This node owns
CRT-AI-04-A, CRT-CON-08-A, CRT-NFR-04-A, CRT-SEC-06-A, CRT-SEC-11-A,
CRT-UX-09-A and CRT-UX-13-A. ADR 0027 records its decisions before the code.
The branch was brought up to master `11869e1`, which carries the dependency
`connector-capabilities-required-connectors-and-lifecycle`.

## Design entities implemented here

Added by `migrations/0022_governed_action_and_data_control.sql`, each with forced
row-level security, owner-scoped policies and a classification in
`packages/postgres/src/ownership.ts` (64 application tables now):

- **`drafts`** — a Uai artifact, `CREATED → AWAITING_APPROVAL → APPROVED` or
  `DISCARDED`; no executed status exists. `policy_decision_id` is NOT NULL: a draft
  names the `EvaluateMemoryAction` ALLOW it was created under.
- **`recommendation_artifacts`** — `semantics` is `CHECK(='RECOMMENDED')`; the
  owner's reply is `NONE`, `ACCEPTED_AS_INTENT_TO_PREPARE`, `DISMISSED` or
  `SNOOZED`; a `BLOCKED` one names its reason and cannot be accepted.
- **`action_history`** — one `stage` column with the six labels; append-only;
  `EXECUTED`/`RECEIVED_CONFIRMATION` need a live `TOOL_RECEIPT` evidence row; an
  entry about a draft may only be `DRAFTED` or `REQUESTED_APPROVAL`.
- **`attention_budgets`** — defaults 3 / 1 / 7 when absent.
- **`memory_summaries`** — the derived cache the deletion cascade must reach.
- **`retention_and_deletion_requests`** — export and deletion requests with a
  receipt of counts and identifiers only.

Supporting tables, recorded in ADR 0027: `plugin_capability_grants` (Uai's own
plugin capabilities, one row each; a granted WRITE row is unrepresentable),
`retention_settings` and `domain_sensitivity_settings`.

Also delivered: `source_items.deleted_at` and `evidence_object_keys.deleted_at`
are now written (the tombstone), and object storage gained `delete`.

## Design screens implemented here

| Screen (design) | Page | Component |
| --- | --- | --- |
| Action history | `/actions` | `ActionHistory.tsx` |
| Draft approval | `/actions/drafts` | `DraftApproval.tsx` |
| Recommendation detail | `/recommendations/{id}` | `RecommendationDetail.tsx` |
| Permissions and integrations | `/permissions` | `Permissions.tsx` |
| Export and delete my data | `/data` | `DataControl.tsx` |

Every drawn state is reachable from props and asserted in
`apps/web/components/Control.test.ts`. No other screen is drawn here.

## HTTP surface

| Route | Purpose | Notes |
| --- | --- | --- |
| `GET /v1/permissions` | `permissions.read` | sources with read and write scopes, domain sensitivity, plugin capabilities, attention budget, retention, recent requests |
| `POST /v1/plugin-capabilities` | `permissions.manage` | refused whole, `403 PLUGIN_CAPABILITY_WRITE_REFUSED`, if any entry grants a write |
| `PATCH /v1/settings/attention-budgets` | `permissions.manage` | `400 ATTENTION_BUDGET_INVALID` when the scope cap exceeds the daily cap |
| `PATCH /v1/settings/retention` | `permissions.manage` | a rule with neither limit returns the type to "keep" |
| `PATCH /v1/settings/domain-sensitivity` | `permissions.manage` | replaces the manifest floor for items stored after it |
| `POST /v1/drafts`, `GET /v1/drafts` | `action.draft`, `action.read` | `403 DRAFT_CAPABILITY_NOT_GRANTED`, `403 DRAFT_POLICY_DENIED`, `409 DRAFT_CONFIRMATION_REQUIRED` |
| `POST /v1/drafts/{id}/decision` | `action.draft` | request approval, approve, discard |
| `POST /v1/actions/execute` | `action.execute` | always `403 EXTERNAL_ACTION_REFUSED`, with the recorded decision |
| `GET /v1/action-history` | `action.read` | |
| `POST /v1/recommendations`, `GET /v1/recommendations[/{id}]` | `action.recommend`, `action.read` | |
| `POST /v1/recommendations/{id}/respond` | `action.recommend` | the owner's words are stored as evidence first |
| `POST /v1/actions/receipts` | `action.receipt` | an authoritative tool receipt, stored as `TOOL_RECEIPT` evidence |
| `POST /v1/action-history/observations` | `action.receipt` | an action seen in existing evidence |
| `POST /v1/export` | `data.export` | needs `x-maximum-sensitivity` |
| `POST /v1/data/deletions/preview` | `data.delete` | the real cascade, rolled back |
| `POST /v1/data/deletions` | `data.delete` | `confirmation: "DELETE"` required |
| `POST /v1/data/retention/cleanup` | `data.delete` | applies the saved retention rules now |
| `POST /v1/memory/embeddings/regenerate` | `memory.reindex` | drop, rebuild, or both |

Steps that need another authority run under a purpose chosen by server code:
the Context Broker under `memory.read`, the port's decision under `memory.act`,
evidence under `evidence.ingest`, regeneration under `memory.govern` and the
projection replay after a deletion under `memory.project`.

`POST /v1/memory/deletions` (the correction control of
`owner-sequence-overlay-deltas-and-correction-endpoints`) is unchanged: it records
the owner's deletion request against a memory object and its overlay delta. The
evidence cascade that PRD §30.7 describes is `POST /v1/data/deletions`, because
its target is an evidence item, which the correction targets do not name.

## How each acceptance criterion is met

All in `packages/api/src/control.test.ts` over the real boundary, the real
Context Broker and the real pinned registry release 0.1.0, unless noted.

- **CRT-CON-08-A** — a draft with the capability withheld is refused by name and
  no row exists; with the capability granted but the evidence not admitting the
  draft's purpose, `EvaluateMemoryAction` denies it and its DENY is recorded; with
  both, the draft is created and names an `EvaluateMemoryAction` ALLOW; revoking
  the capability stops the next one. Email send, calendar create, calendar update,
  money movement and trade are each refused with a recorded
  `EXTERNAL_ACTION_REFUSED_IN_V0` DENY, and the five write capabilities cannot be
  granted (also `CHECK` in the schema, asserted in `isolation.test.ts`).
- **CRT-SEC-11-A** — for memory that is only PROVISIONAL, CONTESTED (two live
  values in one slot) or ACCEPTED but under an incomplete projection, a HIGH-risk
  draft is denied `HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY`, a MEDIUM-risk one needs
  confirmation, and a HIGH-risk recommendation is stored `BLOCKED` with that reason
  and cannot be accepted.
- **CRT-AI-04-A** — the §60 recommendation is stored `RECOMMENDED` with a
  SUGGESTED entry; "Yes, prepare the order, but do not submit it." is stored
  verbatim as the owner's evidence and as `ACCEPTED_AS_INTENT_TO_PREPARE`; no claim
  or proposition is created, no EXECUTED entry exists, and submitting is refused.
  Only `POST /v1/actions/receipts` then establishes the execution, as `TOOL_RECEIPT`
  evidence attributed to the tool.
- **CRT-UX-13-A** — the history holds all six labels, every entry exactly one of
  them; entries about drafts are only drafted or requested approval; the schema
  refuses a draft labelled executed even from the migration principal.
- **CRT-UX-09-A** — the view shows a connected Gmail source's read scopes (write
  scopes empty), all five sources' sensitivity, the plugin capabilities with risk
  classes, the default budget and the retention rules. Then each change is shown
  taking effect on the next operation: a new read capability widens the next
  view's scopes; the saved attention budget turns the next clarification decision
  from ASK to BATCH; the next upload is stored RESTRICTED, then NORMAL, while the
  earlier item keeps its level; a cleanup with no rule removes nothing and the next
  one after the rule is saved erases both uploads. Export and deletion are
  triggered from the surface and listed on it.
- **CRT-NFR-04-A** — the export bundle carries each live item's metadata, anchors
  and raw bytes (byte-equal to the stored object) and the canonical memory objects,
  with no object key; a lower ceiling exports no PRIVATE item. Dropping every
  embedding empties semantic search, and regenerating restores the same matches
  with the same distances.
- **CRT-SEC-06-A** — after deleting a document: the raw object is gone from
  storage; `GET /v1/evidence/{id}` is 404; the claim, the proposition it alone
  supported and the belief derived only from that one are gone, and their explain
  reads are 404; no projection row, thread view, context packet, export, lexical
  document search or semantic search carries them or the item's text; anchors,
  parsed content, embeddings, the summary, the alias and the thread membership are
  deleted; the overlay delta that quoted it reads `[erased]`; stored packets that
  carried it read `{"erased":true}`; the evidence row is a tombstone with no
  content. No audit event and no request receipt contains the item's text. The
  same content uploaded again is a new item. The isolation suite adds that the
  cascade refuses another owner and any other purpose, and that `unai_app` still
  cannot `DELETE` from any canonical or evidence table under `data.delete`.

## What this node does not claim

- **The attention budget is enforced by a rule, not yet by an inbox.**
  `admitsClarification` is the rule a clarification decision applies and it reads
  the saved budget; the memory inbox that calls it belongs to
  `memory-inbox-attention-budgets-and-weekly-review`, which is not a dependency of
  this node.
- **No executor exists.** V0 refuses every external write; a port that answered
  ALLOW would still get `EXTERNAL_ACTION_REFUSED`, because there is nothing to call.
- **The web shell's shared chrome.** `web-shell-labels-today-briefing-and-ask-surface`
  had not landed on master; the screens use the delivered `Navigation` and proxy.
- **Exports above 64 MiB through the browser.** The proxy allows the export
  answer up to 64 MiB (every other read keeps the 1 MiB cap); a larger bundle is
  available through the API but would need a streamed download.
- **What is not erased.** An assistant's answer stored as
  `ASSISTANT_CONVERSATION` evidence that quoted the deleted item is a separate item
  and is deleted on its own; a recommendation's text is Uai's and is not rewritten;
  `policy_decisions.request` rows hold identifiers and classifications only. A frame
  instance left with no support stays as structure, and the replayed projection
  holds an empty row for it with none of the deleted values.
- **Derived retention** expires the regenerable derivatives (semantic index
  entries and summaries) of a source type's evidence past its limit; it never
  deletes canonical beliefs, which only raw retention or the owner removes.

## Changes outside this node's feature scope

- **Registry lock order** (`migrations/0022`, last statement). With this node's
  suite added, the full run failed intermittently (4 of 8 runs) with a 500 or 503
  in unrelated suites (`ask`, `memory`, the isolation governor check). The
  PostgreSQL log showed `deadlock detected` between the registry snapshot suite's
  refused `TRUNCATE registry_releases, registry_contracts` and
  `unai_private.registry_contract_present`, which opened `registry_contracts`
  before `registry_releases`. The function is re-declared with the join reversed:
  the same question, answer and purposes as migration 0019. After it, no deadlock
  appeared and four consecutive `pnpm test` runs passed.
- **Projection replay teardown** (`packages/capabilities/src/projection-replay.test.ts`)
  drops what migration 0022 creates and expects it among the re-applied files, as
  every migration since 0017 has done.
- **Isolation suite** (`packages/postgres/src/isolation.test.ts`): the table count
  is 64, and the new tables have their cross-owner fixture; the one TOOL_RECEIPT
  evidence row it needs lives inside a rolled-back transaction so no other
  fixture count moves.

## Verification

`pnpm test` exited 0 on four consecutive runs, each 606 passed and 4 skipped
across 71 files (the skipped four are the connector live-account suite, which
needs operator credentials). `pnpm typecheck`, `pnpm validate:registry` and
`pnpm build` passed. The daemon's independent verifier is authoritative.
