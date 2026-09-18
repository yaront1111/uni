# The connectors, their permission model and the connector lifecycle

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494, node key
`connector-capabilities-required-connectors-and-lifecycle`. This node owns
CRT-CON-01-A, CRT-CON-02-A, CRT-CON-03-A, CRT-CON-04-A, CRT-CON-05-A,
CRT-CON-06-A, CRT-CON-07-A and CRT-SEC-03-A. ADR 0023 records its decisions
before the code; ADRs 0001–0022 and every delivered slice before it were
inspected and retained, except the three assertions ADR 0023 §9 names.

## Design entities implemented here

**`connector_capability_grants`**, added by
`migrations/0018_connector_capabilities_and_lifecycle.sql`, and the connector
lifecycle columns of **`connectors`** (`secret_ref`, `manifest_version`,
`cursor_updated_at`, `disconnected_at`, `last_sync_error`, `updated_at`) with the
status vocabulary, the write-path policies, the identity and update-guard
triggers, and the trigger that refuses an evidence row naming a connector that is
not `ACTIVE`. **`source_items`**, **`source_anchors`**, **`evidence_object_keys`**
and **`triage_decisions`** gain one INSERT policy each for the sync purpose and
are otherwise untouched. There are now 50 application tables, 48 of them
owner-scoped and classified in `packages/postgres/src/ownership.ts`.

No other entity is implemented here. `memory_embeddings`, `memory_summaries` and
`extraction_runs` in particular are **not**: document search in this slice is
lexical over stored anchors, and the semantic index belongs to
`current-state-selector-semantic-index-and-ask-pipeline`.

## Design screens this node implements

| Screen and state (design) | What serves it |
| --- | --- |
| Connected sources: no sources connected | `Connectors.tsx` empty state over `GET /v1/connectors` |
| Connected sources: list with status, granted capabilities, last stored cursor | the same list; `cursor.position` is rendered verbatim |
| Connected sources: initial sync running | `state="SYNCING"` |
| Connected sources: second sync resumed from the stored cursor | the "Last sync" card's `resumedFromCursor` |
| Connected sources: redelivered items discarded | the same card's `duplicatesSuppressed` |
| Connected sources: sync failed with a named reason | `connectors.last_sync_error`, written by `recordSyncFailure` |
| Connected sources: token revoked, reauthorization required | status `TOKEN_REVOKED` |
| Connected sources: disconnected, tokens revoked, ingestion stopped | status `DISCONNECTED` after `POST /v1/connectors/{id}/disconnect` |
| Grant connector capabilities: manifest list with independent toggle and risk class | `CapabilityGrants`, one control per `connector_capability_grants` row |
| Grant connector capabilities: read-only consent handoff | `requestedScopes`, derived from the granted capabilities only |
| Grant connector capabilities: partial grant honoured | metadata granted while content stays denied, as two rows |
| Grant connector capabilities: write scope refused with the reason | `CONNECTOR_WRITE_SCOPE_REFUSED` rendered in `role="alert"` |
| Grant connector capabilities: draft capability granted / withheld | drawn as a write capability V0 refuses through a connector grant; the granting path itself is the drafts slice's (CRT-CON-08-A) |
| Upload a document: empty, uploading | the upload form and its `role="status"` |
| Upload a document: stored, immediately searchable, extraction deferred | the receipt's `indexedAnchors`, `searchable` and `DEFERRED` plan |
| Upload a document: full extraction because the user asked | `extractionPlanReason: USER_REQUESTED` |
| Upload a document: full extraction because workflow-related, deadline-bearing or high-value | the other three reasons |
| Upload a document: extraction failed, document still retrievable | `extractionFailed` beside the unchanged receipt |
| Upload a document: unsupported format stored as source-only evidence | `UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY` |

`Sign in and owner scope`, `Permissions and integrations` and `Export and delete
my data` are **not** implemented here; the first was delivered earlier and the
other two belong to `drafts-actions-permissions-export-and-deletion-workflow`.

## HTTP surface

| Route | Purpose | Answer |
| --- | --- | --- |
| `GET /v1/connectors` | `connector.read` | every connected source with status, grants, scopes and cursor |
| `POST /v1/connectors` | `connector.manage` | `201` with the connector; `403 CONNECTOR_WRITE_SCOPE_REFUSED`; `409 CONNECTOR_ALREADY_CONNECTED` |
| `GET /v1/connectors/{id}/capabilities` | `connector.read` | one row per manifest capability with its risk class |
| `POST /v1/connectors/{id}/capabilities` | `connector.manage` | the resulting grant set; `403` for a write scope or an unknown capability |
| `POST /v1/connectors/{id}/sync` | `connector.sync` | run id, resumed cursor, requested and stored sensitivity, items ingested, duplicates suppressed, episodes aggregated, new cursor; `409 CONNECTOR_INGESTION_STOPPED`; `403 CONNECTOR_SENSITIVITY_CEILING_TOO_LOW` |
| `POST /v1/connectors/{id}/disconnect` | `connector.manage` | tokens revoked, secret destroyed, ingestion stopped, retained-evidence options |
| `POST /v1/documents` | `evidence.ingest` | `201` with the stored, indexed receipt and the extraction plan with its reason |
| `GET /v1/documents/search?q=` | `evidence.read` | bounded lexical hits over the owner's stored documents |

`GET /v1/connectors/{id}` (the evidence slice's connector detail) is unchanged.
The web proxy gains the connector and document write paths and pins
`x-data-purpose` and `x-maximum-sensitivity` for every path that stores evidence.

`POST /v1/documents` takes the repository's established JSON base64 envelope
rather than a multipart file: the API boundary is a 1 MiB JSON boundary and
`docs/evidence-runtime.md` already fixed that convention for binary uploads
(ADR 0023 §7). `GET /v1/documents/search` is deliberately **lexical only** — the
pgvector semantic index belongs to
`current-state-selector-semantic-index-and-ask-pipeline` — and it exists so the
drawn screen state "stored and immediately searchable with full extraction
deferred" is observable at all.

**The lexical index is a searchable derivative, so the deletion slice must erase
it too** (PRD §30.7, §34 invariant 10): deleting a document has to remove its
`source_anchors` text, not only the `source_items` row and the object, or the
deleted document stays findable through `GET /v1/documents/search`. That erasure
belongs to `drafts-actions-permissions-export-and-deletion-workflow`
(CRT-SEC-11-A), which owns the export-and-deletion workflow; this node records the
obligation rather than implementing it.

## How each acceptance criterion is met

- **CRT-CON-01-A** — the `CONVERSATION` parser emits one item per message with the
  message's own external id; a user message is attributed to the authenticated
  owner and an assistant message to the assistant, so model output is evidence and
  never the owner's statement. The API test ingests a four-message conversation and
  asserts four `source_items` rows, their ids, their roles and that no proposition
  exists.
- **CRT-CON-02-A** — the Gmail manifest offers three read capabilities and no write
  one; the granted set decides the requested scopes, and every one of them is
  read-only. A request naming `gmail.send` is refused `CONNECTOR_WRITE_SCOPE_REFUSED`
  and changes no grant row. A sync ingests a thread as one item per message. *The
  real test account is not exercised* — see "What this node does not claim".
- **CRT-CON-03-A** — `calendar.read` is the only capability, its scope is
  `calendar.readonly`, and each ingested occurrence carries `start`, `end`,
  `recurrenceId` and the payload's own `recurrence` array, with a `CALENDAR_FIELD`
  anchor for each of the three. Nothing is inferred from text.
- **CRT-CON-04-A** — seven commits and five CI runs on one pull request become one
  episode item with one triage decision and twelve anchors; the parser is pure, so a
  redelivery re-derives the same hash. A pull-request payload without
  `github.read_pull_requests` is refused by capability name.
- **CRT-CON-05-A** — an upload is stored, its pages anchored and its text findable
  through `GET /v1/documents/search` in the same request, with **no job queued**.
  Each of the four triggers queues an `evidence.extract` job with its reason named;
  a format with no readable text is stored as source-only evidence and stays
  retrievable.
- **CRT-CON-06-A** — the first sync stores the provider's cursor, the second resumes
  from it (asserted on the fetch the client received) and reports three duplicates
  suppressed with the row count unchanged; a backfill ignores the cursor and still
  creates nothing. Disconnect calls the revoker, nulls `secret_ref`, revokes every
  grant and moves the status, after which a sync is refused and the schema itself
  refuses an evidence insert for that connector. A *failed* sync is the one state
  that is retryable: the retry clears `SYNC_FAILED`, resumes from the stored
  cursor and suppresses the redelivered items, so one provider outage does not
  leave a connector that can never sync again.
- **CRT-CON-07-A** — every required connector ships a manifest of discrete
  capabilities with independent risk classes; grants are one row each; an ungranted
  capability is refused `CONNECTOR_CAPABILITY_NOT_GRANTED` at the operation, and a
  partial Gmail grant stores no message body anywhere in the object store.
- **CRT-SEC-03-A** — a work-email operation receives a bundle with none of the
  owner's health, family or financial objects, including the work frame whose
  evidence also admits `PERSONAL_FINANCE`; the excluded objects are listed in
  `withheld`, and the owner's five propositions are all still there.

## Stored sensitivity

Each manifest's `sensitivity.default` is a **floor**, not a suggestion: a sync or
an upload stores at the stricter of that default and what the request asked for,
so a caller cannot store Gmail content at `NORMAL` by asking. Raising above the
default is allowed, and both levels appear on the receipt
(`requestedSensitivity`, `storedSensitivity`) so a raised level is visible. A
request whose declared `x-maximum-sensitivity` ceiling is *below* the floor is
refused `CONNECTOR_SENSITIVITY_CEILING_TOO_LOW` rather than served by lowering
the floor.

**Every V0 source type defaults to `PRIVATE`**: Gmail (PRD §27.2), conversation,
Calendar, uploaded documents and GitHub. Financial imports are not a V0 connector;
when they arrive they default to `RESTRICTED`. The owner may lower a connector
below its default only through an explicit per-connector consent action on the
Permission management surface (PRD §7.8, Phase 4), audited per §30.6 and effective
only for items stored after the change — it never rewrites a stored row (§42). No
request header or body field lowers the floor. That consent path belongs to
`drafts-actions-permissions-export-and-deletion-workflow`, not to this node.

## What this node does not claim

- **No live provider account was exercised.** `packages/connectors/src/providers.ts`
  holds the real read-only Gmail, Calendar and GitHub clients and the real token
  revocation calls, and the sync path is identical for them; but the suite drives a
  recorded double over the committed fixtures, because a live account needs
  operator credentials this environment does not hold. CRT-CON-02-A, CRT-CON-03-A
  and CRT-CON-04-A each also require a real test account, and that half is
  unverified here. It is reported as a finding on this node.
- **No belief.** This package imports no belief-transaction code and writes no
  canonical row. A connector produces evidence; admitting a belief is the governor's.
- **No semantic search.** Document search is lexical `ILIKE` over stored anchors,
  bounded to 50 hits, with no ranking and no embeddings.
- **No OAuth ceremony.** The consent handoff is drawn and the scopes are computed,
  but obtaining the token and writing the `secret://` handle is deployment work;
  the routes accept a handle and never a credential.
- **No draft, and no external write of any kind.** The draft capability is drawn as
  refused through a connector grant; `CRT-CON-08-A` and the action path belong to
  `drafts-actions-permissions-export-and-deletion-workflow`.
- **No prompt-injection defence beyond treating payloads as data.** Connector
  content is parsed, never interpreted; the boundary component the design lists
  under P4 is not implemented here.
- **The life-category catalog is the Context Broker's** (`categories.ts`), and the
  bundle's exclusions are read from it. A category the catalog does not know is a
  category the bundle cannot exclude.

## The live-account path

`createConnectorRuntime(secrets)` in `packages/api/src/connectors.ts` is the
production composition — the read-only Gmail, Calendar and GitHub clients and the
real revocation call, both built from the deployment's secrets manager — and
`packages/api/src/server.ts` wires it into the platform API. Before it, a
deployment held those clients in the package but could reach neither: a sync
answered `CONNECTOR_CLIENT_UNSUPPORTED` and a disconnect of a credentialed
connector `CONNECTOR_REVOCATION_UNAVAILABLE`. Constructing a client resolves no
secret and sends no request, so the wiring is asserted without a network call.

`packages/api/src/connectors.live.test.ts` is the integration suite against real
test accounts. It drives the same routes through that same composition, with no
double in the path, and it is **skipped** unless an operator supplies read-only
credentials as `secret://` handles:

```
UNAI_SECRETS_MOUNT            directory the secrets manager reads
UNAI_LIVE_GMAIL_ACCOUNT       / UNAI_LIVE_GMAIL_SECRET
UNAI_LIVE_CALENDAR_ACCOUNT    / UNAI_LIVE_CALENDAR_SECRET
UNAI_LIVE_GITHUB_REPOSITORY   / UNAI_LIVE_GITHUB_SECRET
```

Every provider call it makes is a GET. The disconnect case really revokes the
operator's token, so it needs `UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION=true` beyond
the credentials and is skipped even when they are present.

A skipped case is not evidence. While these are skipped, the live half of
CRT-CON-02-A, CRT-CON-03-A and CRT-CON-04-A stays unverified, and that is still
reported as a finding; what changed is that supplying credentials is now the
whole remaining work, with no code change left to make.

**Where that run is recorded.** PRD 43.6 accepts "test accounts or fixtures" for
the connector integration tests, so the committed fixtures close 43.6 and the
code half of CRT-CON-02-A, -03-A, -04-A and -06-A. The live run answers a
different question: PRD 54 item 1, "all required connectors ingest real data
read-only", which is a Definition-of-V0-done gate rather than a per-node delivery
criterion. When an operator sets the handles above and reruns `pnpm test`, the
result of that run must be recorded against the PRD 54 gate. Until it runs, the
live half is recorded UNVERIFIED — not satisfied, and not waived. No credential,
token or captured real content is ever committed (PRD 46 exit: the private corpus
cannot be committed accidentally).

## Verification

`pnpm test` exited 0: 537 passed and 4 skipped across 58 files, over disposable
pgvector with all eighteen migrations applied and disposable TLS/KMS object
storage. The four skipped are the live-account suite above, which this
environment holds no credentials for. `pnpm typecheck` and `pnpm validate:registry`
passed. A red check was run for CRT-SEC-03-A: with the bundle's category filter
removed, the health, family and financial objects arrive and the test fails. The
daemon's independent verifier is authoritative.
