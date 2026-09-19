# ADR 0023: Connector capabilities, the required V0 connectors and the connector lifecycle

Date: 2026-09-18
Status: Accepted
Node: `connector-capabilities-required-connectors-and-lifecycle` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-CON-01-A, CRT-CON-02-A, CRT-CON-03-A, CRT-CON-04-A, CRT-CON-05-A,
CRT-CON-06-A, CRT-CON-07-A, CRT-SEC-03-A.

Recorded before the implementing change, per PRD §0.7 and §46. ADRs 0001–0022 and
every delivered slice before this one were inspected and retained unchanged,
except where section 8 below names an assertion that this slice's delivery makes
false.

## 1. A grant is one row per discrete capability

PRD §27.1 lists capabilities as discrete names with independent permission and
risk classification. The schema takes that literally:
`connector_capability_grants` is unique on
`(owner_scope_id, connector_id, capability_id)`, and `requireCapability` asks for
one capability by name and reads no sibling. There is no "scope level", no
capability hierarchy and no implication rule anywhere, because any of the three
would be a way for `gmail.read_metadata` to end up permitting
`gmail.read_content` (CRT-CON-07-A).

Rejected: a `granted_capabilities text[]` column on `connectors`. An array makes
"which capability was granted when, and which was revoked" unanswerable, and it
puts the revocation history in the same place as the current state.

## 2. V0 is read-only in the schema, not only in the service

`CHECK(NOT(granted AND access_kind='WRITE'))` makes a granted write capability
unrepresentable. The manifests offer no write capability, `assertReadOnly` runs at
every provisioning rather than only in a unit test, and `WRITE_CAPABILITIES`
names the write capabilities that exist in PRD §27.1's vocabulary so a request for
one is refused *as a write scope* with a reason the consent screen can show
(CRT-CON-02-A). `gmail.create_draft` is in that list: draft creation is the one
external write V0 contemplates, and PRD §27.5 puts it behind explicit permission
and `EvaluateMemoryAction` rather than behind a connector grant, which is the
drafts slice's work (CRT-CON-08-A).

## 3. Disconnect stops ingestion through a trigger, not through a code path

`unai_private.connector_ingestion_active()` refuses any `source_items` insert
naming a connector whose status is not `ACTIVE`. A disconnect therefore stops
ingestion even for a caller that already holds a parsed page, and the guarantee
does not depend on every future write path remembering to check
(CRT-CON-06-A). `connector_update_guard()` is the other half: a connector's
identity columns never move, and a `connector.sync` transaction may not change the
credential handle, the permission manifest or the disconnect state — a sync reads
with the authority the owner granted and never changes what that authority is.

## 4. `connector.sync` is its own purpose, and it joins the evidence purposes

A sync stores evidence, so migration 0018 adds `connector.sync` to
`unai_private.evidence_access` and adds one INSERT policy per evidence table,
carrying the same owner-access, writer-binding and existing-item conditions the
delivered `evidence.ingest` policies carry. This is the same widening 0011, 0012,
0014 and 0017 each made for their own purpose, and it weakens nothing: the data
purpose and the sensitivity ceiling still decide.

Rejected: running the sync route under `evidence.ingest`. The route also moves a
cursor, and a purpose that can store evidence *and* write connector state is
wider than either operation needs.

## 5. The GitHub episode is an ingestion unit, decided by the parser

PRD §20.5 says to aggregate around pull requests and not to process every commit
or webhook independently. The aggregation is therefore done in the deterministic
parser, not in a worker: a burst becomes one `source_items` row with one triage
decision and at most one extraction, while every commit and check run remains an
anchor and a content entry on that row (CRT-CON-04-A). The episode's external id
is the pull request's, so a redelivery of the identical burst re-derives the
identical content hash and creates no second row; a *different* burst is a
different content hash and therefore a new episode, which is the honest record of
two different bursts rather than an edit of the first.

## 6. A partial grant narrows the raw payload before it is parsed

Gmail ingested with `gmail.read_metadata` alone stores headers and an empty body,
because the narrowing happens on the raw payload before hashing. The content hash
then describes exactly what was read. The consequence is deliberate: the same
thread ingested later with `gmail.read_content` granted is a *new* evidence row,
not an amendment of the first, which is what PRD §42's "evidence is immutable"
requires. The provider client makes the same distinction upstream — it requests
`format=metadata` unless the content capability is granted — so the narrower grant
also means less data leaves the provider.

## 7. Document upload: JSON envelope, four triggers, lexical index

- The design draws `POST /v1/documents` with a multipart file. The repository's
  API is a JSON boundary with a 1 MiB body limit and an established base64
  envelope for binary uploads (`docs/evidence-runtime.md`), so the route takes
  that envelope: `pages` for extracted text and `base64` for the original bytes.
  Nothing in the PRD requires multipart, and a second body parser would be a
  second place for an upload to be mis-parsed.
- `planExtraction` is a pure function of exactly the four triggers PRD §20.5
  names. With none of them, **no job is enqueued at all**, so "full extraction did
  not run" is observable as an empty queue rather than as a claim about a worker
  (CRT-CON-05-A). The deadline trigger reads the Tier-1 signals ingestion already
  recorded, so the route and triage cannot disagree about what the document says.
- "Searchable immediately" is served by a lexical search over the
  `DOCUMENT_RANGE` anchors the upload transaction wrote, exposed as
  `GET /v1/documents/search` under the existing `evidence.read` purpose. The
  pgvector semantic index belongs to a later slice, and a search that needed
  embeddings could not be available *immediately* after the upload commits. The
  one route beyond the design's list exists because the drawn screen state
  ("stored and immediately searchable") is otherwise unobservable.
- The extraction job is enqueued in its own `jobs.enqueue` transaction after the
  evidence commits. A deployment that cannot queue the run (no registry release
  loaded) answers 503 for the queueing with the document already stored, indexed
  and searchable: evidence durability never waits on later processing (PRD §0
  rule 5, §35.1).

## 8. The manifest default is a sensitivity floor, and a failed sync is retryable

Two decisions the first delivery left open.

- *Floor.* The defaults are now decided: **every V0 source type defaults to
  `PRIVATE`** — Gmail (PRD §27.2), conversation, Calendar, uploaded documents and
  GitHub, whose manifest was raised from `NORMAL` to `PRIVATE`. Financial imports
  are optional and not this node's; when delivered they default to `RESTRICTED`.
  An owner may go below a default only through an explicit per-connector consent
  action on the Permission management surface (PRD §7.8), audited per §30.6,
  effective only for items stored afterwards and never rewriting a stored row
  (§42); no request field lowers the floor. The direction is unchanged:
  `storedSensitivity` returns the stricter of the manifest default and
  the request, so a caller cannot store Gmail content at `NORMAL` by asking for
  it, while raising above the default stays available. Both levels are on the
  sync receipt and the document receipt, so a raised level is visible rather than
  silent. A declared ceiling *below* the floor is refused
  `CONNECTOR_SENSITIVITY_CEILING_TOO_LOW` — lowering the floor to fit the ceiling
  would be exactly the thing the floor prevents, and letting the row policy fail
  would report the wrong reason.
- *Retry.* `SYNC_FAILED` was a terminal state: `runConnectorSync` required
  `ACTIVE` and nothing moved a connector back, so one provider outage left the
  connector unable to ever sync again and CRT-CON-06-A's "a second sync resumes
  from the stored cursor" unreachable after any failure. A failed sync is now
  retryable — the owner's consent and the stored cursor both survive a failure —
  and the retry clears the failure at the *start* of the run, because migration
  0018's `connector_ingestion_active` trigger refuses an evidence row whose
  connector is not `ACTIVE`. `DISCONNECTED` and `TOKEN_REVOKED` are untouched and
  still stop ingestion: a failure is not a revocation, and a revocation is not a
  retryable failure.

## 9. The least-context rule is enforced three times

PRD §27.3 is a security property, so it is not left to the caller: the capability
declares the purpose, the ceiling and the life-category view; the broker answers
under that declaration; and the bundle then drops every object that still carries
an excluded category and lists it in `withheld` (CRT-SEC-03-A). The third step is
the one that matters: a work frame whose evidence also admits `PERSONAL_FINANCE`
passes both of the first two, and a red check (the filter removed) shows the
health, family and financial objects arriving without it.

## 10. Assertions this delivery changes

- `packages/api/src/evidence.test.ts` asserted that the application role holds no
  `UPDATE` on `connectors`, recording that connector provisioning and cursors
  belonged to a later node. That node is this one, so the grant now exists and the
  assertion becomes the narrower truth it was protecting: an `evidence.ingest`
  transaction still changes no connector row, and the identity columns are
  immutable under every purpose.
- `apps/web/components/Evidence.test.ts` pinned the copy "Search and semantic
  extraction are not available". Search is available now; the assertion is
  replaced with the new limits the copy must keep claiming and no more.
- `packages/capabilities/src/projection-replay.test.ts` drops the tables of every
  migration after 0016 before re-applying them. Migration 0018's objects join that
  teardown, exactly as 0017's did.
