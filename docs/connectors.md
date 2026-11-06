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
| Connected sources: disconnected, ingestion stopped | status `DISCONNECTED` after `POST /v1/connectors/{id}/disconnect`. A successful Disconnect navigates to `/connectors?disconnected=<id>[&notice=CONNECTOR_REVOCATION_MANUAL_REQUIRED]`. The server render keeps that query only for a listed connector that is `DISCONNECTED` and a known notice (`lastDisconnectFrom`, `Connectors.tsx:84-90`). For an OMI connector it adds the ADR 0041 D8 sentence verbatim: "Uai has stopped using this key and forgotten its handle. Omi does not let apps revoke developer keys: revoke it in the Omi app under Settings > Developer." |
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
| `POST /v1/connectors/{id}/sync` | `connector.sync` | run id, resumed cursor, requested and stored sensitivity, items ingested, duplicates suppressed, episodes aggregated, new cursor, per-payload `refusals`; `409 CONNECTOR_INGESTION_STOPPED`; `403 CONNECTOR_SENSITIVITY_CEILING_TOO_LOW`; `429 CONNECTOR_RATE_LIMITED` with `retryAfterSeconds` (recorded `SYNC_FAILED`; the next sync resumes from the stored cursor); `409 CONNECTOR_CURSOR_INVALID` (a `BACKFILL` recovers); `409 CONNECTOR_TOKEN_REVOKED`: a provider 401 on any connector type marks the connector `TOKEN_REVOKED` through the route, as the `connector.sync` job already does, while a 403 stays `SYNC_FAILED` (owner decision of 2026-11-03, comment-138a7813 and comment-2e6f2b1e) |
| `POST /v1/connectors/{id}/disconnect` | `connector.manage` | provider revocation where the provider allows it (`tokensRevokedAtProvider`), secret handle destroyed, ingestion stopped, retained-evidence options, and `providerRevocationNotice`: `CONNECTOR_REVOCATION_MANUAL_REQUIRED` for OMI, null otherwise |
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

## Gmail message bodies

**What is fetched.** The Gmail client lists threads and then calls
`users.threads.get` on each one: with `format=full` when `gmail.read_content` is
granted, and with `format=metadata` otherwise. A metadata-only grant is narrowed
to `payload.body.text: ''` before parsing (`prepareForCapabilities` in
`packages/connectors/src/sync.ts`), so no body reaches the parser.

**Accepted input.** `parseSourcePayload('GMAIL', …)` accepts the Gmail API thread
resource that `users.threads.get` returns with `format=full`. In that resource
each message part's body is `{size, data}` with `data` base64url-encoded, or
`{size: 0}` with the content in nested `parts`. A message's body is:

- `payload.body.text`, when present, unchanged. This is the decoded shape of the
  fixtures and the synthetic corpus, and keeping it untouched keeps every stored
  content hash;
- otherwise, the decoded `data` of the first non-attachment `text/plain` part
  found depth-first (an attachment is a part with a non-empty `filename` or an
  `attachmentId`, and it is skipped with its whole subtree);
- else the first `text/html` part reduced to text: comments and the script, style,
  title, noscript and template elements are dropped in one left-to-right pass,
  tags are stripped, the basic entities are decoded and whitespace is collapsed.
  An element name ends at HTML whitespace (TAB, LF, FF, CR or SPACE), `/` or `>`,
  so a custom element such as `title-bar` is kept. End tags close even with
  attributes or a slash. `<!-->` and `<!--->` are empty comments, and `--!>` also
  ends a comment. A `<script>` inside a comment does not drop the rest of the body;
- else empty.

The bytes are decoded with the charset of the selected part's own
`Content-Type` header when the runtime's `TextDecoder` supports that label
(`ISO-8859-1` decodes as windows-1252, as WHATWG specifies), and as UTF-8
otherwise. The reduction is a fixed text rule, not a renderer: text hidden by CSS
(`display:none` preheaders, white-on-white) survives it. That text is untrusted
evidence like any other; the defence is extraction's untrusted-data framing and
the claims-not-beliefs path, not this reducer.

**Bounds.** Size never refuses a thread. At most 256 parts are visited per
message (the root and attachments count), nothing deeper than depth 16 is read,
at most 1 MiB (1,048,576 characters) of base64url is decoded per part, and a body
longer than 200,000 characters is cut there without splitting a surrogate pair. A
body cut by the 1 MiB or the 200,000-character bound carries
`deterministicMetadata.bodyTruncated: true`; the key is absent otherwise, also
when a part lies beyond the walk bounds and is simply not read. U+0000 becomes
U+FFFD, because a PostgreSQL `text` column refuses it. Only `data` that is not
valid base64url in the selected part refuses the thread, with
`SOURCE_PAYLOAD_INVALID`, echoing nothing.

**Headers.** Names and values are sender-controlled, so their bounds cut instead
of refusing. Only a message's first 256 headers are read; the rest are neither
read nor validated. A header whose name is over 128 UTF-16 code units is ignored.
A value over 8,192 code units keeps its first 8,192, one fewer when the cut would
split a surrogate pair. A message where any of these rules fired carries
`deterministicMetadata.headersTruncated: true`; the key is absent otherwise.
U+0000 in a kept header value becomes U+FFFD. `actorRef` keeps the first 512 code
units of From without splitting a surrogate pair, while the content keeps the
whole bounded From. PostgreSQL `text` refuses U+0000, and `jsonb` refuses both
U+0000 and a lone surrogate. A lone surrogate (an unpaired half of a UTF-16
pair) is not a parse error: it stays in the parsed item, so the stored object,
the content hash and the idempotency key keep it. The ingest writes every
`jsonb` value (`actorRef`, the deterministic metadata, each anchor and the
Tier-0 parse) through `storableJson` in `@unai/domain`, which turns each lone
surrogate into U+FFFD, as node-postgres already does to a `text` parameter such
as `external_id`. A payload that stores today writes the same bytes.

**Corpus import.** `pnpm uai corpus import --source <file>` takes the same JSON:
the `users.threads.get` `format=full` response saved byte for byte. `.eml` files
and Google Takeout `.mbox` files are refused with `CORPUS_SOURCE_INVALID`, and
there is no converter.

**Scopes and format=full.** Google's reference for the `Format` enum says `full`
and `raw` cannot be used when accessing the API with the `gmail.metadata` scope,
and says nothing about a token that carries both scopes. A 2020 field report
shows a token carrying `gmail.metadata` beside `gmail.readonly` refused with 403
"Metadata scope doesn't allow format FULL". `requestedScopes` for
`gmail.read_metadata` plus `gmail.read_content` listed both scopes, and `getJson`
reports every 403 as `CONNECTOR_TOKEN_REVOKED`. Since 2026-11-05
(task-a814e89c), `requestedScopes` drops `gmail.metadata` whenever
`gmail.readonly` is in the set, so a content or search grant asks only for
`gmail.readonly`, which also reads metadata, and `pnpm connect:google` mints that
token. A metadata-only grant still asks for `gmail.metadata`. No live account has
confirmed the 403.

**A payload that does not parse.** During a sync of any connector type, a payload
the parser refuses is listed in the result's `refusals` as
`{externalRef, code: 'SOURCE_PAYLOAD_INVALID', capabilityId: null}`; for Gmail,
`externalRef` is the thread id. That payload is skipped, the rest of the page is
stored and the cursor advances, so an incremental sync does not retry it. A
BACKFILL ignores the cursor and refuses it again. The refusal carries no payload
text. Any other ingest failure, such as the database or object storage, still
fails the whole run with 500 `INTERNAL_ERROR`: the run is rolled back and the
cursor stays where it was. Continuing after a parse refusal is safe because
ingestion parses the whole payload before it writes anything.
The exception is a connector stopped while the run was reading: it refuses with
409 `CONNECTOR_INGESTION_STOPPED`, as described below.

## The Omi connector (OMI)

ADR 0041 and ADR 0042 add Omi, the wearable recorder, as an optional read-only
source beyond PRD §27.5. The delivery report is `docs/omi-connector.md`.

- **Type.** The connector type and the source type are both `OMI`.
- **Manifest.** `connector.omi` has one READ capability, `omi.read_conversations`
  (scope `conversations:read`, risk HIGH). Its context profile excludes HEALTH,
  FAMILY and FINANCE, at a NORMAL ceiling.
- **Sensitivity.** PRIVATE is a floor: a request asking for NORMAL still stores
  PRIVATE.
- **Client.** It only GETs `https://api.omi.me/v1/dev/user/conversations` with
  the developer key, which is resolved from its `secret://` handle for each page.
  D7 paging walks a time window and stops after the page that closes it
  (`exhausted: true`). A 429 fails the run at once with `CONNECTOR_RATE_LIMITED`.
- **Evidence.** Each conversation becomes two items:
  - the transcript, actor EXTERNAL `omi:transcript`, with one `TRANSCRIPT_SEGMENT`
    anchor per segment carrying the speaker and the OWNER/OTHER/UNKNOWN role;
  - Omi's structured summary, actor ASSISTANT `omi:structured`, routed
    SOURCE_ONLY.
- **Disconnect.** Uai cannot revoke an Omi developer key. A disconnect stops
  ingestion, forgets the handle and answers `providerRevocationNotice:
  CONNECTOR_REVOCATION_MANUAL_REQUIRED` (D8). The owner then revokes the key in
  the Omi app (`docs/operations/connector-revocation.md`).

## Concurrent syncs and lifecycle changes

A sync holds no connector-row lock during provider I/O. The exception is a retry
from `SYNC_FAILED`: its initial flip to `ACTIVE` already holds that lock for the
run, so lifecycle changes wait for it.

Every lifecycle writer (`setCapabilityGrants`, `markTokenRevoked`,
`disconnectConnector`) takes the connector row with `FOR NO KEY UPDATE` as its
first read, before its status check, and only then touches grant rows: the lock
order is the connector row first, then grant rows, everywhere. A writer's status
check is therefore never stale when its write lands, and a writer waiting on a
concurrent disconnect refuses `CONNECTOR_DISCONNECTED` once that disconnect
commits instead of overwriting it or re-granting its revoked capabilities.
Disconnect holds this lock across its provider revocation call (the second
accepted lock across provider I/O), so a run's commit point and grant changes
wait for it. `FOR UPDATE` would be wrong here: it conflicts with the `KEY SHARE`
locks evidence inserts hold through their foreign key, so a writer would wait for
a whole in-flight multi-page run and could deadlock with its commit point.

The sync's commit point is a final re-read of the connector under
`FOR NO KEY UPDATE`, even when the provider returns no cursor. It serializes with
lifecycle updates without conflicting with the `KEY SHARE` locks evidence inserts
take through their foreign key. Unlike `FOR UPDATE`, it does not introduce a
deadlock between two syncs that both inserted evidence and then reach this guard.

- A token revocation, disconnect or last-capability revocation committed before
  this point wins. The run refuses with 409 `CONNECTOR_INGESTION_STOPPED` and
  `{connectorId, status}`; its transactional effects (evidence rows, cursor and
  cleared error) roll back, preserving the stop's cursor and error.
- After the status check the commit point re-reads the grants. A partial
  revocation of a capability the run read under, committed before this point or
  in progress when the run reaches it (the commit point then waits for it),
  makes the run refuse with 403 `CONNECTOR_CAPABILITY_NOT_GRANTED` and
  `{connectorId, capabilityId}`. All of the run's evidence and its cursor roll
  back. A capability granted mid-run changes nothing the run read.
- That refusal is not recorded as `SYNC_FAILED`: the owner's consent change
  decided the run, which did not fail. The connector stays `ACTIVE` with its old
  cursor, and the next sync, or the job path's retry, reads under the narrowed
  grant. `recordSyncFailure` records neither that code nor
  `CONNECTOR_INGESTION_STOPPED`, so a stop's status, or a concurrent run's
  `SYNC_FAILED` reason, stands.
- A stop committed before an evidence insert can instead be refused by the
  importer (`CONNECTOR_REFUSED`) or migration 0018's ingestion trigger (SQLSTATE
  `55000`, `CONNECTOR_INGESTION_STOPPED`). Both yield the same 409 code with only
  `{connectorId}`. The trigger aborts the transaction, so the handler must not
  query it again to retrieve a status.
- A stop starting after the commit point waits for the sync's commit and applies
  after it. Failure bookkeeping cannot overwrite a stop: `recordSyncFailure`
  changes only `ACTIVE`/`SYNC_FAILED` rows, and `markTokenRevoked` never changes a
  `DISCONNECTED` row, even when the disconnect commits after its initial read.
- Two syncs of one connector serialize at this point. The later commit's cursor
  wins; redelivered items deduplicate by identity (ADR 0010).

The real-PostgreSQL proof is `packages/api/src/connector-sync-race.test.ts`.

## Extraction of synced items

ADR 0038 holds for syncs as written (owner decision 2026-11-06, task-b00c772f; no
amendment). Migration 0031's `triage_processing_intent` trigger records a `PENDING`
processing intent, in the sync's own transaction, for every synced item that triage
routes `FULL_EXTRACTION` or `ENTITY_EXTRACTION`. Sync now and the scheduled
`connector.sync` job behave alike. The processing worker then extracts it; the full
rules are in `docs/processing-runtime.md`, section "Items from connector syncs".

- **No intent, never extracted automatically:** `SOURCE_ONLY` items (a message that
  is only quoted history), `INDEX_ONLY` items (newsletters, routine CI notices),
  `DEFER_UNTIL_RELEVANT` items (an Omi transcript over the ADR 0041 D4 bound is
  one) and ASSISTANT-authored items (Omi's structured summary).
- **When:** on a later worker turn, never in the sync request. Each turn enqueues up
  to 20 pending intents, oldest first, runs one job, and sleeps
  `UNAI_PROCESSING_POLL_MS` (default 1000). Only intents whose data purpose equals
  `UNAI_PROCESSING_DATA_PURPOSE` are dispatched, and only for items the worker's
  `UNAI_PROCESSING_MAXIMUM_SENSITIVITY` can read; any other intent stays `PENDING`
  without an error. Sync now records `PERSONAL_ASSISTANCE` (the web pins it) with a
  `RESTRICTED` ceiling; a scheduled sync records the worker's own purpose and
  ceiling. Items are stored `PRIVATE` unless the owner raised the connector's
  floor, so a `NORMAL` worker never sees them.
- **Cost:** each run is bounded by its route's budget and limits in
  `packages/extraction/src/triage.ts` (`ROUTE_COST_BUDGET_MICROUNITS`,
  `ROUTE_EXTRACTION_LIMITS`).
- **Outcome by source:**
  - Gmail: a first-person commitment from the sender reaches `SUCCEEDED` with a
    `PROVISIONAL` proposition.
  - Omi: the transcript ends `NEEDS_REVIEW` with its claims unresolved (ADR 0041
    D4); the summary is never extracted.
  - Google Calendar and GitHub: the same intent rule, but canonicalization resolves
    no asserting actor for them, so a claim ends `NEEDS_REVIEW`. Not exercised by
    the tests.

Proof: the two cases named "ADR 0038 for connector syncs" in
`packages/api/src/processing-runtime.test.ts`, which run the web's exact Sync now
request over a synced Gmail account and Omi account against real PostgreSQL.

## What this node does not claim

- **No live provider account was exercised.** `packages/connectors/src/providers.ts`
  holds the real read-only Gmail, Calendar, GitHub and Omi clients and the real token
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
  the routes accept a handle and never a credential. Update 2026-11-05
  (task-a814e89c): `pnpm connect:google --capabilities <ids>` (options
  `--secret-name connectors/google`, `--port <n>`, `--open`, `--replace`) runs
  Google's loopback + PKCE flow with the Uai connectors client named by
  `UNAI_GOOGLE_CONNECTOR_CLIENT` (ADR 0043 D6). That client must be a Desktop app
  OAuth client. The command refuses write capabilities by name and refuses a token
  whose granted scopes differ from the requested ones. It writes only the refresh
  token to `<UNAI_SECRETS_MOUNT>/<name>` (mode 0600, never overwritten without
  `--replace`) and prints the handle and the granted scopes.
  `pnpm secret:put <name>` stores a value piped on stdin, such as a GitHub PAT,
  the same way. On a remote host, forward the port first
  (`ssh -L <n>:127.0.0.1:<n>`). On the ADR 0043 host, install the file into the
  api and worker mounts as `root:unai-<process>` 0640 (`deploy/README.md`,
  task-a620d2e8). The web app still has no consent flow.
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
UNAI_LIVE_OMI_SECRET          an Omi developer key limited to conversations:read
```

`UNAI_LIVE_OMI_SECRET` drives case ADR-0041-LIVE-A. Like the others, it needs
`UNAI_SECRETS_MOUNT`. It has no account variable: a reserved example address fills
`externalAccountRef`. The case makes one INCREMENTAL sync of GETs to
`https://api.omi.me/v1/dev/user/conversations` and never disconnects, because Uai
cannot revoke an Omi key (ADR 0041 D8). Its live half stays UNVERIFIED until an
operator runs it (`docs/omi-connector.md`).

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
