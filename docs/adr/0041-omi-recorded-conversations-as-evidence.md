# ADR 0041: Omi recorded conversations as an evidence source

Date: 2026-11-02
Status: Accepted
Epic: epic-8d6f813adaf54bb4891d0e6152dce7bb (Omi wearable). Task: task-c77246b7d4aa40cb979c1d4c39c9d3a5.

This record comes before any implementing change, as PRD §0 rule 7 requires,
because Omi is not one of the §27.5 V0 connectors. Every later task of the epic
cites the decision it implements (D1–D10). The epic's architecture notes
recommend an evidence model. Where a decision here departs from it, the decision
says why, and later tasks follow this record, not the notes. ADR 0042 is
reserved for the inbound-webhook spike (D10).

## Context

### What the Omi Developer API provides (verified 2026-11-02)

Sources, all read on 2026-11-02:

- the developer overview at docs.omi.me/doc/developer/api/overview;
- the OpenAPI document at docs.omi.me/api-reference/openapi.json;
- the github.com/BasedHardware/omi backend files `backend/routers/developer.py`,
  `backend/database/conversations.py`, `backend/models/developer_transcript.py`,
  `backend/utils/speakers/display.py`, `backend/utils/mcp_server/helpers.py`,
  `backend/utils/external_read_contract.py` and
  `backend/utils/other/list_budget.py`.

What they establish:

- **OMI-1, base and authentication.** The base URL is `https://api.omi.me/v1/dev`
  and the header is `Authorization: Bearer omi_dev_...`. `api.omiapi.com` is the
  mobile-app backend and must not be used with developer keys.
- **OMI-2, keys and scopes.** Keys are created at app.omi.me/developers, and their
  scopes are fixed when the key is created. The scopes are `conversations:read`,
  `conversations:write`, `memories:read`, `memories:write`, `action_items:read`,
  `action_items:write`, `goals:read`, `goals:write`, `people:read`,
  `profile:read` and `screen_activity:read`. Key management (`GET`/`POST
  /v1/dev/keys`, `DELETE /v1/dev/keys/{key_id}`) needs a Firebase ID token, so a
  developer key cannot manage or revoke keys. Omi's docs say to revoke a
  compromised key in the Omi app under Settings > Developer. `GET /v1/dev/key`
  returns the calling key's metadata and its effective scopes.
- **OMI-3, the list endpoint.** `GET /v1/dev/user/conversations` takes these
  query parameters:
  - `start_date` and `end_date` (date-time; the backend filters
    `created_at >=` and `<=`);
  - `categories`;
  - `limit` (default 25, clamped to 200) and `offset` (default 0);
  - `include_transcript` (default false; when false, `transcript_segments` is
    removed);
  - `folder_id` and `starred`;
  - `cursor`, which answers HTTP 400 unless `include_transcript=false` and no
    folder or starred filter is set.

  With `include_transcript=true` the backend queries `discarded == false AND
  status == 'completed'`, orders by `created_at` descending, pages by offset
  and drops locked conversations. The 200 body is a JSON array of
  `DeveloperConversation`.
- **OMI-4, paging headers.** List responses carry `X-Omi-Effective-Limit` and
  `X-Omi-Has-More` (`true|false`). They also carry `X-Omi-Next-Offset` (only
  when more pages exist), `X-Omi-Next-Cursor` (cursor mode only) and
  `X-Omi-List-Truncated: true` when a read budget cut the page short. A
  truncated page reports `has_more` true and may be empty. Omi's docs say never
  to read an empty or short truncated page as the end. None of these headers is
  in the OpenAPI document. A list response may be cached for up to 10 s per
  credential and query.
- **OMI-5, the conversation.** `DeveloperConversation` has these required fields:
  - `id` (string) and `created_at` (date-time);
  - `started_at` and `finished_at` (date-time or null);
  - `structured`, holding `title`, `overview`, `category` (enum), `emoji`,
    `action_items[]` and `events[]`. Each action item has `description`,
    `completed`, `created_at`, `updated_at`, `due_at`, `completed_at` and
    `conversation_id`. Each event has `title`, `description`, `start`,
    `duration` (integer minutes, default 30) and `created`.

  The optional fields are `language`, `source` (the capture source, such as
  `omi`, `phone` or `sdcard`), `geolocation`, `folder_id`, `folder_name`,
  `transcript_included`, `transcript_segments` (array or null),
  `participants_included` (boolean), `participants` (list of objects) and
  `person_ids`. There is no `discarded` or `status` field.
- **OMI-6, the transcript segment.** `DeveloperTranscriptSegment` (backend
  `SimpleTranscriptSegment`) has these fields:
  - `id?`;
  - `text`;
  - `original_text?`, serialized only when the text was corrected;
  - `speaker_id?` (integer);
  - `speaker_name?`;
  - `start` and `end` (seconds, float).

  It has **no** `is_user`, `speaker` or `person_id`. Those fields exist only on
  the memory-creation webhook payload and the from-segments write request.
  `speaker_name` (`developer_speaker_names`) is one of these labels: the account
  holder's name or `User` for owner segments, a saved person's name, a
  per-conversation `Speaker ...` label, or `Unknown speaker`.
- **OMI-7, who is the owner.** Owner identity is exposed per conversation, not
  per segment. The list handler adds
  `conversation_participants(conv, include_display=False)`. It sets
  `participants_included` true and gives `participants` one
  `{speaker_id, person_id, is_user}` object per distinct combination in the
  stored transcript. A segment with no `speaker_id`, no `person_id` and
  `is_user` false is not listed. The handler also adds `person_ids`. Locked
  conversations get `participants_included` false.
- **OMI-8, rate limits and webhooks.** Limits apply per key per hour, counted
  from the first request in the window:
  - conversation reads: 60, shared across the list, detail and transcript reads;
  - list: 60;
  - detail: 60;
  - transcript fetch: 25.

  A list call with `include_transcript=true` is also charged to the transcript
  bucket, so at most 25 transcript pages can be read per hour. A 429 carries
  `Retry-After` in seconds (example 1800). Omi's webhooks (memory creation,
  real-time transcript, audio bytes, day summary) are unsigned POSTs that carry
  a `uid` query parameter and an `Idempotency-Key` header.

The epic's grounding says the read payload has the shape of the memory-creation
webhook, with per-segment `is_user`, `speaker` and `speakerId`. That does not
hold for the Developer API read (OMI-6, OMI-7). The decisions below are built on
what the read actually returns.

### Where Uai meets it

- **SEAM-1** `packages/domain/src/sources.ts`:
  - `sourceAnchorKindSchema` has five kinds.
  - `parsedSourceItemSchema` takes an `actorRef` `{type: USER|ASSISTANT|EXTERNAL,
    id}` or null, at most 2048 anchors and an `externalId` of at most 512
    characters.
  - `parsedSourceTypeSchema` comes with its `parsers` record.
  - `span()` truncates `normalizedText` to 8192 characters.
  - `instant()` parses an offsetless string in the process's local zone.

  `packages/domain/src/connectors.ts` has `connectorTypeSchema`,
  `connectorManifestSchema`, `connectorCursorSchema` (`position` ≤ 512,
  `providerToken` ≤ 2048 or null) and `disconnectResultSchema` (a
  `strictObject`).
- **SEAM-2** Two SQL constraints enumerate these vocabularies.
  `migrations/0008_evidence_object_keys_and_anchors.sql` names the anchor CHECK
  `source_anchors_kind`. `migrations/0024_governed_action_and_data_control.sql`
  has an unnamed column CHECK
  `domain_sensitivity_settings.source_type IN ('CONVERSATION','GMAIL',
  'GOOGLE_CALENDAR','GITHUB','DOCUMENT')`. No other SQL enumerates anchor kinds
  or source/connector types. `migrations/0004_evidence.sql` fixes
  `ingestion_version = 'evidence-json-v1'`.
- **SEAM-3** `packages/api/src/evidence.ts` `importSource` works as follows:
  - It hashes `canonical(item.content)` into the content hash, which together
    with owner, connector, source type and `externalId` is the item's
    identity.
  - It turns a null `actorRef` into `{type:'USER', id: <submitting actor>}`.
  - It does not hash `deterministicMetadata`; the first write wins.
  - A parse failure throws `SourcePayloadInvalid`. The sync route does not catch
    that as a `ConnectorError`, so the whole sync answers 500.
- **SEAM-4** Three belief paths depend on the actor:
  - `canonicalizeProcessingClaims`
    (`packages/api/src/processing-canonicalization.ts`) makes the owner the
    asserting entity (promisor) for a USER actor. For an EXTERNAL actor on
    GMAIL it resolves an entity by email. Anything else stays unresolved.
  - `independenceGroupKey` (`packages/belief/src/support.ts`) keys on the
    asserting entity, else on a digest of connector plus `actorRef`.
  - `anchoredInAssistantEvidence` (`packages/belief/src/transactions.ts`) counts
    a claim anchored in ASSISTANT evidence as `MODEL_INFERENCE`, and such a
    claim is never accepted.
- **SEAM-5** `packages/extraction/src/triage.ts`:
  - `parseTier0` has per-type branches. Unknown types read only
    `content.body`/`subject`/`title`, and it adds `actorRef.id` to the
    participants whenever the actor is not USER.
  - `routeTier1` routes an ASSISTANT actor `SOURCE_ONLY`/`ASSISTANT_AUTHORED`.

  In `packages/extraction/src/runs.ts`, `resolveExtractedSpan` returns a claim
  anchor `{...parent.anchor, start, end}` with character offsets, and
  `buildExtractionInput` sends every anchor's JSON and text to the model.
- **SEAM-6** `packages/connectors/src/manifests.ts` has `MANIFEST_LIST`, the
  context profiles, `WRITE_SCOPE_PATTERNS` (including
  `/(^|[.:])write([:.]|$)/`) and `WRITE_CAPABILITIES`.
  `packages/connectors/src/providers.ts` has `ConnectorPage {payloads,
  nextCursor}` and `getJson`, which maps 401/403 to `CONNECTOR_TOKEN_REVOKED`,
  other non-2xx to `CONNECTOR_PROVIDER_UNAVAILABLE` and bad JSON to
  `CONNECTOR_PROVIDER_RESPONSE_INVALID`, keeping the status only. It also has
  `createConnectorClient`, and `createTokenRevoker`, which throws
  `CONNECTOR_REVOCATION_UNAVAILABLE` for an unknown type.
- **SEAM-7** `packages/connectors/src/sync.ts`:
  - `prepareForCapabilities` returns the connector type as the source type, or a
    per-item refusal.
  - `runConnectorSync` loops up to `maxPages` inside one `connector.sync`
    transaction. It stops on a null `nextCursor` or an empty page, and persists
    the cursor only when it is non-null.
  - `recordSyncFailure` stores the code as a retryable `SYNC_FAILED`.

  The sync route reads the owner's floor with `readSensitivityFloor(tx,
  connectorType)` (`packages/control/src/permissions.ts`).
  `disconnectConnector` (`packages/connectors/src/grants.ts`) refuses a
  credentialed connector without a revoker (`CONNECTOR_REVOCATION_UNAVAILABLE`)
  and a revoker answering `revoked: false` (`CONNECTOR_REVOCATION_FAILED`).
  `@unai/secrets` resolves handles and has no delete.
- **SEAM-8** `docs/adr/INDEX.md` lists the ADRs. `src/operations/report.ts`
  reads each ADR's first-line title and `Date:` line.
  `docs/operations/connector-revocation.md` says a failed provider revocation is
  not a completed disconnect.

## Decision

### D1: Connector type and source type OMI

**Rule.** `connectorTypeSchema` and `parsedSourceTypeSchema` gain `OMI`, and both
items of D3 carry sourceType `OMI`. The manifest id is `connector.omi`. The
manifest's `sources` is `['OMI_CONVERSATION']`, the descriptive §27.2 label, just
as Gmail's manifest says `EMAIL_THREAD` for `GMAIL` items. Capability ids start
with `omi.`.

**Why one value for both.** Every existing connector uses one value for both.
`prepareForCapabilities` (`packages/connectors/src/sync.ts`) returns the
connector type as the source type. The sync also reads the owner's Permissions
setting with `readSensitivityFloor(tx, connectorType)`
(`packages/control/src/permissions.ts`) from `domain_sensitivity_settings`, which
is keyed by `source_type`. A different value would silently ignore the owner's
setting (§7.8, §30.3).

**References.** §0 rule 7, §27.2, §27.5.

### D2: Ingestion unit: one completed conversation, read-only

**Rule.** The ingestion unit is one conversation, as returned by
`GET https://api.omi.me/v1/dev/user/conversations?include_transcript=true`. With
transcripts, the provider returns only completed, non-discarded conversations
(OMI-3). Segments are never items: a conversation is ingested as a whole, like a
Gmail thread update (§20.5).

**The only request.** The connector makes that one GET, with the query keys
`include_transcript`, `limit`, `offset`, `start_date` and `end_date` (D7), and
`redirect: 'error'`.

**Never requested.** `/conversations/{id}`, `/search`, memories, action items,
goals, daily summaries, people, profile, any key endpoint, any POST, PATCH or
DELETE, the `/v2/integrations` import API, or `api.omiapi.com`. §27.5 excludes
external writes, and invariant 41 forbids them. No live transcript and no audio
bytes are read.

**Changes in Omi.** A conversation can change in Omi (corrected text, reassigned
speakers, a regenerated summary). Read again, it has a new content hash, so it
becomes a new evidence row with the same `externalId`, never an edit (ADR 0023
§6). An unchanged conversation is the same row (invariant 5). A conversation
deleted in Omi stays in Uai until the owner deletes it in Uai (§30.7).

### D3: Evidence shape: two items per conversation

**Raw schema.** `omiConversationSchema` is a bounded, **non-strict** `z.object`.
Unknown fields (such as `geolocation`, `folder_id`, `folder_name`, `person_ids`,
`emoji` and `transcript_included`) are stripped and never stored. Fields:

- `id`: matches `/^[A-Za-z0-9._-]{1,256}$/`. It has no `:`, so two `externalId`s
  cannot collide.
- `created_at`: string ≤ 64.
- `started_at`, `finished_at`: string ≤ 64, nullish.
- `language`: ≤ 32, nullish.
- `source`: ≤ 64, nullish.
- `structured` (optional):
  - `title` ≤ 4096, `overview` ≤ 20000, `category` ≤ 64;
  - `action_items`: ≤ 256 × `{description ≤ 4096, due_at ≤ 64 nullish}`;
  - `events`: ≤ 64 × `{title ≤ 4096, start ≤ 64 nullish, duration int nullish}`.
- `transcript_segments`: a nullish array of ≤ 2048 segments, each:
  - `id` ≤ 256, nullish;
  - `text` ≤ 8192;
  - `original_text` ≤ 8192, nullish;
  - `speaker_id`: int or string ≤ 64, nullish;
  - `speaker_name` ≤ 256, nullish;
  - `start` and `end`: finite numbers ≥ 0.
- `participants` (optional): an array of ≤ 64 entries, each
  `{speaker_id int or string ≤ 64 nullish, person_id ≤ 256 nullish,
  is_user boolean optional}`.
- `participants_included`: boolean, optional.

The bounds come from Uai's own caps. 2048 is the anchors cap of
`parsedSourceItemSchema`, since each segment gets one anchor. 8192 is `span()`'s
`normalizedText` cap, so every segment anchor holds its whole text.

**Times.** A timestamp becomes ISO only when it carries an explicit offset (`Z`
or `+hh:mm`/`-hh:mm`). An offsetless or unparseable time gives null. Times are
never parsed in the local zone and never taken from the clock (§12.9; parser
purity). The existing `instant()` parses offsetless strings in the local zone,
so the Omi parser needs a variant that requires an offset.

**Transcript item.** It is always emitted, also when there are no segments.

- `externalId`: `omi:conversation:<id>`.
- `parentExternalId`: null.
- `actorRef`: `{type:'EXTERNAL', id:'omi:transcript'}` (D4 says why).
- `occurredAt`: `started_at`, or null when it is absent.
- `content` (hashed, so it is the item's identity), exactly these keys:
  - `kind`: `'OMI_TRANSCRIPT'`.
  - `conversationExternalId`: the Omi id verbatim, as Gmail content keeps
    Gmail's own `messageExternalId`. Wherever this record says
    `conversationExternalId` it means this same value.
  - `startedAt`, `finishedAt`: ISO or null.
  - `language`: string or null.
  - `participantsIncluded`: `participants_included === true`.
  - `participants`: `[{speakerId: String(speaker_id) or null, personId or null,
    isUser: is_user === true}]` in payload order; `[]` when
    `participantsIncluded` is false.
  - `segments`: `[{index, segmentId or null, speakerId: String(speaker_id) or
    null, speakerName or null, startSeconds, endSeconds, text, originalText or
    null}]` in payload order. `index` is the segment's position in
    `transcript_segments`.

  Content holds the facts the speaker role is derived from, not the role, so a
  change to the derivation never changes identity (packages/domain/CLAUDE.md).
- `deterministicMetadata` (not hashed; the first write wins):
  - `conversationExternalId`;
  - `threadExternalId`: `omi:conversation:<id>`;
  - `createdAt`: Omi's `created_at` verbatim, the basis of the cursor (D7);
  - `captureSource`: Omi's `source`, or null;
  - `providerApi`: `'omi-developer-api-v1'` (D9);
  - `segmentCount`;
  - `segmentSpeakerRoles`: an array of D4 roles aligned with `content.segments`
    by index. Triage reads it, so the derivation rule lives only in the parser.
  - `ownerSegmentCount`, `otherSegmentCount`, `unknownSegmentCount`;
  - `speakerRoleBasis`: `'PARTICIPANTS'` or `'UNAVAILABLE'`;
  - `durationSeconds`: the largest `endSeconds` minus the smallest
    `startSeconds`; null when there are no segments.
- `anchors`: one `TRANSCRIPT_SEGMENT` per segment (D5).

**Structured item.** It is emitted when `structured` is present.

- `externalId`: `omi:conversation:<id>:structured`.
- `parentExternalId`: `omi:conversation:<id>`. A model summary keeps its lineage
  (§12.9, §15.4).
- `actorRef`: `{type:'ASSISTANT', id:'omi:structured'}`.
- `occurredAt`: null, because Omi generates the summary, and may regenerate it,
  at a time it does not record.
- `content`:
  - `kind`: `'OMI_STRUCTURED_SUMMARY'`;
  - `conversationExternalId`;
  - `title`, `overview`, `category`;
  - `actionItems`: `[{description, dueAt: ISO or null}]`;
  - `events`: `[{title, start: ISO or null, durationMinutes: int or null}]`.

  Left out on purpose: `emoji`, which is presentation, and the action items'
  `completed`, `completed_at`, `created_at` and `updated_at`. Those record the
  owner's task state in Omi, not model output, and they change every time the
  owner ticks an item off.
- `deterministicMetadata`: `conversationExternalId`, `threadExternalId`,
  `providerApi`, `actionItemCount`, `eventCount`.
- `anchors`: `CONNECTOR_JSON_PATH` (an existing kind, so no migration):
  - `{path:'$.structured.title'}`;
  - `{path:'$.structured.overview'}`;
  - `{path:'$.structured.action_items[<i>].description'}` for each action item.

**Never support.** The structured item can never become claim support (§24.2,
invariant 3):

- Tier-1 routes ASSISTANT items `SOURCE_ONLY` (`ASSISTANT_AUTHORED`,
  `packages/extraction/src/triage.ts`).
- Extraction refuses that route.
- Belief admission counts a claim anchored in ASSISTANT evidence as
  `MODEL_INFERENCE` (`anchoredInAssistantEvidence`,
  `packages/belief/src/transactions.ts`).

**Departures from the epic notes.**

- The content keys are extended and renamed: `kind`, `participants`,
  `participantsIncluded`, `segmentId`, `speakerName`,
  `startSeconds`/`endSeconds` and `originalText`. The reasons:
  - The read API has no per-segment `is_user` (OMI-6, OMI-7).
  - D5 keeps seconds out of keys named `start`/`end`.
- `occurredAt` has no `created_at` fallback, because `created_at` is Omi's
  record time, not when the conversation happened.

Each new conversation therefore stores two items.

### D4: Speaker attribution, Tier-0 text and the extraction size bound

**The item's actor.** The transcript item's `actorRef` is
`{type:'EXTERNAL', id:'omi:transcript'}`. It is a provenance label for a
multi-party recording; it names neither the owner nor a person. Rejected
alternatives:

- *null or USER.* `importSource` (`packages/api/src/evidence.ts`) turns a null
  `actorRef` into the submitting owner. `canonicalizeProcessingClaims`
  (`packages/api/src/processing-canonicalization.ts`) then makes the owner the
  promisor of every commitment claim on a USER-actor item. A bystander's "I will
  pay you back on Friday" would become the owner's commitment, while §15.5 gives
  user authority only to the user's own statements. With EXTERNAL on a non-GMAIL
  source, that path leaves Omi claims unresolved.
- *ASSISTANT.* The words are human speech, and an ASSISTANT actor would route
  the transcript `SOURCE_ONLY`.
- *A per-conversation actor id.* One constant id keeps unresolved Omi claims in
  one independence group per connector (`independenceGroupKey`,
  `packages/belief/src/support.ts`). A fact repeated across recordings is then
  not counted as several independent sources (§15.4).

**Segment role.** Only the parser derives it, and it is one of `OWNER`, `OTHER`
or `UNKNOWN`:

- `UNKNOWN` when `participantsIncluded` is false or the segment's `speakerId` is
  null.
- Otherwise let M be the `participants` entries whose `speakerId` equals the
  segment's, compared as strings (a null `speakerId` never matches):
  - `OWNER` when M is non-empty and every entry has `isUser` true;
  - `OTHER` when M is non-empty and every entry has `isUser` false;
  - `UNKNOWN` otherwise: no entry, or a speaker marked both ways.

The role is never derived from `speaker_name` or from a speaker number.
`speaker_name` is a display label that follows the account name and can equal a
saved person's name. Departure from the epic notes, which have a boolean
`isUser`: the API has no per-segment flag, and a boolean would turn "Omi did not
say" into a guess.

**What OWNER means.** Omi's voice identification, which is third-party model
output, says the owner spoke. That is enough for routing and for the Tier-0
label. Tier-1's `USER_AUTHORED` signal comes from `ownerSegmentCount > 0` in the
parse, never from `actorRef`. It is not the owner's typed statement.

**Claims.** An Omi claim's asserting speaker is the one its
`TRANSCRIPT_SEGMENT` anchor names (`speakerRole`, `speakerName`, `speakerId`,
`segmentIndex`), and the claim's narrowed anchor keeps those keys (D5). A claim
on an `OTHER` or `UNKNOWN` segment is that speaker's source assertion (§15.1,
with `EXTERNAL_PERSON_ASSERTION` semantics), never the owner's statement:
`claims.asserted_by_entity_id` is never the owner's entity for it. In this epic
no Omi claim receives an asserting entity at all (D10).

**Tier-0 labels** (for the triage task). Tier-0 builds one line per segment,
`<label>: <text>`. The label is `Owner` for an `OWNER` segment, else
`speakerName` when not null, else `Speaker <speakerId>` when not null, else
`Unknown speaker`. Tier-0 participants are the distinct labels of the non-`OWNER`
segments. The actor id `omi:transcript` is never a participant. `parseTier0`
adds `actorRef.id` for non-USER actors today, so the OMI branch must not.

**No quoted-history cut** (for the triage task). The OMI branch builds `newText`
itself and skips `splitQuotedHistory`. A transcript quotes nothing, and that
function's line rules (`>` prefixes, an `On ... wrote:` line, a `--` line) could
cut real speech. `quotedTextLength` is 0.

**Extraction size bound.** This was added after the governor's critique of
2026-11-02. The triage task, task-d3956af093fa4f3eafdecb1fb24d72f2, implements
it in `packages/extraction` and `packages/domain`. It is three rules.

1. **One copy of each word.** Today `buildExtractionInput`
   (`packages/extraction/src/runs.ts`) sends Tier-0 `newText` and also every
   anchor's text with its anchor JSON. Every OMI segment is a
   `TRANSCRIPT_SEGMENT` anchor that carries its text and speaker (D5). So for
   sourceType `OMI`, `buildExtractionInput` sends `newText: null` and orders the
   `TRANSCRIPT_SEGMENT` anchors by the anchor's `segmentIndex`, then `start`.
   Its output for every other source type stays byte-identical.

   The sort is required. `loadAnchors` reads `ORDER BY anchor_kind, id`.
   `writeAnchors` (`packages/api/src/evidence.ts`) gives each anchor a fresh
   `uuidV7`, which is random after its millisecond prefix
   (`src/kernel/identities.ts`). One transcript's anchors are written within a
   few milliseconds, so row order is not speech order.

   Tier-0 `newText` stays the labelled transcript, because `routeTier1` scans
   only `subject` and `newText` for its signals. Rejected: an OMI `newText`
   without the segment text, because Tier-1 would see no content and route every
   transcript `SOURCE_ONLY`. Also rejected: anchors without text, because
   `resolveExtractedSpan` checks each quote against the stored anchor text.
2. **The estimate.** For an OMI transcript, Tier-1 computes, purely
   (`Buffer.byteLength` or `TextEncoder`; no clock, no I/O):

   `inputEstimateBytes = UTF-8 bytes of Tier-0 newText + 320 × structuredFields.segmentCount + 2,048`

   - `newText`'s bytes stand for each segment's text plus its speaker label.
   - 320 per segment covers the rest of the segment's anchor entry. It was
     measured on 2026-11-02 at 265 bytes for a 36-character Omi id, a
     four-digit index, two times and a one-character speaker id, then rounded up
     for longer values and JSON escaping.
   - 2,048 covers the 758-byte `SYSTEM_PROMPT` of `runs.ts` and the input's
     other fields.
3. **The bound.** Tier-1 first picks the route R by its usual rules
   (`USER_AUTHORED` from `ownerSegmentCount`, the material signals,
   `PARTICIPANTS_ONLY`). Suppose R is `ENTITY_EXTRACTION` or `FULL_EXTRACTION`
   and `inputEstimateBytes` exceeds the input bound that
   task-9436f4840ca04fc0afbe2bdc2be6fd42 enforces for R before any model call.
   That bound is the task's planned `ROUTE_EXTRACTION_LIMITS[R].maxInputBytes` in
   `packages/extraction/src/triage.ts`: 32,768 for `FULL_EXTRACTION` and 8,192
   for `ENTITY_EXTRACTION` in its plan of 2026-11-02. Read the constant; never
   copy the number. The transcript then routes `DEFER_UNTIL_RELEVANT` instead,
   with:
   - reason code `EXTRACTION_INPUT_OVER_BOUND`;
   - negative signal `OVER_INPUT_BOUND`;
   - its positive signals kept;
   - budget 0, like every non-deep route (migration 0011's
     `triage_decisions_budget_matches_route` CHECK).

   Both values are new in `packages/domain/src/extraction.ts`
   (`routingReasonSchema` code and `tier1SignalSchema`). No migration is needed,
   because the SQL checks only that a code is a string. If task-9436 lands
   without per-route input bounds, the triage task uses 32,768 and 8,192 as named
   constants. This rule applies only to OMI transcripts.

**Why the bound.** Task-9436 owns three things: the ceilings, its planned
pre-call check (`EXTRACTION_INPUT_TOO_LARGE`, refused before any spend) and,
through task-2c05639a7dc14766a22f3bc09108c371, the end of retries for
deterministic refusals. Without this bound, every long conversation would still
get a scheduled run that is certain to be refused.

The pre-call check stays the guarantee, for two reasons. The estimate covers a
first run only: a later run also re-sends the claim anchors earlier runs added.
And an unusual id, name or escaping can exceed 320 bytes.

**Coverage.** Before this rule, a transcript sent each word twice plus about 285
bytes per segment, so about eight minutes of speech filled FULL's 32 KiB. Now a
FULL route takes about nine minutes of conversation at ~120-byte segments and
~900 bytes of speech a minute, roughly five to fifteen minutes depending on how
Omi cuts segments. ENTITY takes about two minutes.

**What happens to a deferred transcript.** It stays evidence, searchable and
inspectable. Only a `TARGETED` run reaches it (`openRun`), with FULL's limits,
so a transcript estimated over 32,768 bytes is not extracted until windowed
extraction exists (D10). Nothing in this epic requests a `TARGETED` run for an
OMI item: `requestDocumentProcessing` (`packages/api/src/processing-store.ts`)
serves documents.

**Rejected:**

- Truncating a transcript to fit, which would produce claims from a silently
  partial conversation.
- A larger bound for Omi. The owner chose FULL's 32 KiB in task-9436
  (comment-4a1f737728304f3caec7abc91fc08427).

References: §20, §20.2, §20.5, §20.6.

**Bystanders.** `OTHER` and `UNKNOWN` speech is third-party data (§30.8). It is
stored at the PRIVATE floor (D6) and never presented or exported as the owner's
own words.

References: §15.1, §15.4, §15.5, §30.8, invariants 2 and 3.

### D5: Anchor kind TRANSCRIPT_SEGMENT and its migration

**Rule.** `sourceAnchorKindSchema` gains `TRANSCRIPT_SEGMENT`. A NEW migration
makes two changes:

1. It drops the constraint `source_anchors_kind` and re-adds it with the six
   kinds. The constraint is named in
   `migrations/0008_evidence_object_keys_and_anchors.sql`; it is not
   auto-named.
2. It drops the unnamed column CHECK on `domain_sensitivity_settings.source_type`
   (`migrations/0024_governed_action_and_data_control.sql`) and re-adds it with
   `OMI`. PostgreSQL's default name for it is
   `domain_sensitivity_settings_source_type_check`; the migration task reads the
   real name from `pg_constraint`.

The migration takes the next free four-digit number when it is written. This
record does not pin the number, because other epics add migrations. Applied
files are immutable, and the ledger stores their digests.

Nothing else in SQL enumerates these vocabularies (SEAM-2). No table is added, so
nothing changes for ownership or isolation.

**Anchor JSON.** There is one anchor per segment, in index order, with exactly
these keys:

`{conversationExternalId, segmentIndex, speakerId, speakerName, speakerRole, startSeconds, endSeconds, start: 0, end: <text length>}`

`normalizedText` is the whole segment text, at most 8192 characters by D3.
`start` and `end` are **character** offsets, as in `MESSAGE_SPAN` and
`DOCUMENT_RANGE`. Row order is not segment order (D4, extraction size bound): a
reader that needs speech order sorts by `segmentIndex`.

**Departure from the epic notes**, which have
`{segmentIndex, speakerId, isUser, start, end}` with seconds in `start`/`end`.
`resolveExtractedSpan` (`packages/extraction/src/runs.ts`) builds a claim's
anchor as `{...parent.anchor, start, end}` with the claim's character offsets.
That would silently overwrite time values stored under those names. With
`startSeconds`/`endSeconds`, the claim anchor keeps the segment, the time and the
speaker.

**Re-imports.** Anchors deduplicate on `(owner_scope_id, source_item_id,
anchor_kind, anchor)` (`source_anchors_identity`), and they are a pure function
of the item content, so a re-import adds none.

References: §11.2, §20.1.

### D6: The connector.omi manifest

**Manifest fields.**

- `id`: `'connector.omi'`.
- `connectorType`: `'OMI'`.
- `version`: `MANIFEST_VERSION`.
- `displayName`: `'Omi wearable (read-only)'`.
- `sources`: `['OMI_CONVERSATION']`.
- `emits`: `['SOURCE_ITEM']`.
- `sensitivity`: `{default:'PRIVATE'}`. This is a floor: a request may raise it,
  and only the owner's explicit Permissions setting may lower it (ADR 0023 §8,
  ADR 0030 §7).
- `retention`: `{raw:'USER_CONFIGURABLE'}`.
- `requiredSecrets`: `['developer_api_key']`.
- `promptInjectionRisk`: `'HIGH'`, because anyone near the wearer can speak
  instructions into the recording.
- `minimumSyncCapability`: `'omi.read_conversations'`.

**The one capability**, `omi.read_conversations`:

- `access`: `READ`;
- `riskClass`: `HIGH`;
- `scopes`: `['conversations:read']`;
- description: `'Read the conversations your Omi recorded, as transcripts with
  speakers. Nothing is written to Omi.'`

Departure from the epic notes, which suggested MEDIUM: `riskClass` is HIGH.
Ambient recordings carry third parties' speech and health, family and money talk
verbatim, which is broader than `gmail.read_content` (MEDIUM).

**Context profile.** `OMI_PROFILE` is:

`{purpose: 'PERSONAL_ASSISTANCE', lifeCategory: null, excludedLifeCategories: ['HEALTH','FAMILY','FINANCE'], maximumSensitivity: 'NORMAL', tokenBudget: 256}`

It is the smallest profile the schema admits, because the connector's only
operation reads from Omi and needs no Uai context (§27.3). Departure: the epic
suggested PRIVATE.

**Writes refused by name.** `WRITE_CAPABILITIES` gains `omi.write_conversations`
and `omi.write_memories`, so a request for either is refused by name.
`WRITE_SCOPE_PATTERNS` already classifies every Omi write scope
(`conversations:write`, `memories:write`, `action_items:write`, `goals:write`)
through `/(^|[.:])write([:.]|$)/`.

**The key.** The connector row holds only a `secret://` handle, which
`@unai/secrets` resolves (ADR 0013). The `omi_dev_` value never appears in logs,
prompts, spans, fixtures, tests or error records (§30.5, FR-104). The owner
creates the key at app.omi.me/developers with `conversations:read` only.

**The account label.** `externalAccountRef` is an owner-chosen label for the Omi
account, for example its email. It is used for display and for per-type
uniqueness, and it is never sent to Omi; the key alone selects the account.

References: §27.1, §27.2, §27.3, §30.3, §30.5.

### D7: Cursor, paging and rate limits

**Requests.** The client sends `GET https://api.omi.me/v1/dev/user/conversations`
with:

- `include_transcript=true`;
- `limit`: what `runConnectorSync` passes, 50 today;
- `offset`;
- `start_date` and `end_date`, when set.

The query is built with `URLSearchParams`, because a `+` in an offset must be
percent-encoded. Omi's `cursor` parameter is not used: the API refuses it when
transcripts are included (OMI-3). Paging is keyset on `created_at`, newest first,
rather than deep offsets. Omi charges skipped rows to a read budget and answers
an exhausted budget with an empty truncated page.

**Cursor.** The cursor fits `connectorCursorSchema`.

`providerToken` is a JSON object with these keys, each null where unset:

- `v`: 1.
- `hwm` and `hwmId`: the `created_at` and id of the newest conversation of the
  last completed window.
- `top` and `topId`: the same for the window in progress.
- `before`: the `end_date` of the window's next page.
- `offset`: a tie skip, normally 0.

`position` is
`omi:hwm=<hwm or none>/<hwmId or none>;before=<before or none>;offset=<n>`. It
is the human-readable progress that the Connected sources screen shows. Omi's
`created_at` strings are stored and sent back verbatim, microseconds kept.

**Algorithm.**

1. *Opening a window* (none in progress):
   - `start_date` is `hwm` minus 24 hours when `hwm` is set. The lookback
     re-reads a conversation that was still processing when the last window
     closed: its `created_at` is older than ones already read.
   - There is no `start_date` on the first sync or a BACKFILL (cursor null), and
     no `end_date`.
   - The first item of the first page becomes `top`.
2. *Continuing a window*: the same `start_date`, `end_date = before`, and the
   stored `offset`.
3. *After a page*, more pages exist when `X-Omi-Has-More` is `'true'` or
   `X-Omi-List-Truncated` is `'true'`. Only when neither header is present does
   a full page mean more pages.
   - If there are more pages, `before` becomes the oldest `created_at` on the
     page and `offset` becomes 0. When that would not move `before`, `before` is
     kept and the page length is added to `offset`.
   - Otherwise the window closes: `hwm`/`hwmId` become `top`/`topId`, and the
     window state is cleared. An empty, untruncated page closes the window
     without moving `hwm`.
4. *An empty truncated page is never the end*: the state is kept and the run
   stops.
5. *What the client returns*: a non-null `nextCursor` after every successful
   page, or the input cursor (possibly null) when nothing at all was read. On
   the page that closes a window, the client also sets `exhausted: true`. That
   is a NEW optional `ConnectorPage` field: after it, `runConnectorSync` stops
   paging and still persists that cursor, so one run never reopens a window it
   just closed. Other clients never set it.

**Duplicates and edits.**

- Duplicates at window edges and in the lookback are suppressed by content-hash
  identity (D2).
- A conversation edited within the lookback becomes a new row.
- A conversation completed or edited more than 24 hours after its `created_at`
  is read again only by a BACKFILL.

**Errors.** The client keeps only the status and `Retry-After`, never a provider
body (FR-104).

- 401/403 → `CONNECTOR_TOKEN_REVOKED {status}`.
- 429 → `CONNECTOR_RATE_LIMITED {status: 429, retryAfterSeconds}`.
  `retryAfterSeconds` is the integer seconds from `Retry-After`, or null when
  the header is absent or an HTTP date.
- Any other non-2xx → `CONNECTOR_PROVIDER_UNAVAILABLE {status}`.
- Unparseable JSON or a non-array body → `CONNECTOR_PROVIDER_RESPONSE_INVALID`.

**Every client (added 2026-11-07, task-81921e9be4ee40ca824253e6cdbf75c9).** The
mapping above is now the one mapping for every provider client's resource
requests: `providerFailure` in `packages/connectors/src/http.ts`, used by Omi's
list and by the Gmail, Google Calendar and GitHub GETs (`getJson`). That changes
two things for those three clients:

- An unread error body is now cancelled, so only the status and `Retry-After`
  survive (FR-104). Before, it was left unconsumed.
- A 429 is now `CONNECTOR_RATE_LIMITED {status: 429, retryAfterSeconds}`. Before,
  it was `CONNECTOR_PROVIDER_UNAVAILABLE {status: 429}`. The sync route therefore
  answers 429 with `retryAfterSeconds` instead of 502, and the web names the
  wait. The `connector.sync` job dead-letters the attempt (the terminal code
  below) instead of re-running the whole sync at the worker's next poll, inside
  the provider's limit. The retry is the scheduler's next window, at least 5
  minutes for these types (`MINIMUM_INTERVAL_BY_TYPE`,
  `packages/api/src/connector-sync-scheduler.ts`).

Why: a 429 is the provider's explicit rate-limit answer (RFC 6585), so "provider
unavailable" misnames it, and both Google and GitHub ask clients to back off after
one. Unchanged on purpose: the Google token exchange keeps its own mapping,
because it reads its body for `invalid_grant`, and its 401 `invalid_client` and
its 429 are deployment or OAuth-client failures, `CONNECTOR_PROVIDER_UNAVAILABLE`
and never a revocation (providers.test.ts T6). A 403 stays
`CONNECTOR_TOKEN_REVOKED {status: 403}` and never revokes (`credentialRevoked`),
although Google and GitHub also answer some rate limits with 403: telling them
apart needs the body or GitHub's `x-ratelimit-*` headers, and neither is read.
The token revoker still keeps only the status; it now cancels the body it never
reads.

**Rate limits.** The client never sleeps and never retries: a rate-limited run
fails at once.

- The sync route records the failure through `recordSyncFailure`
  (`SYNC_FAILED`, `last_sync_error` `CONNECTOR_RATE_LIMITED`, retryable).
- It answers HTTP 429 with `retryAfterSeconds` in the body. `REFUSAL_STATUS` in
  `packages/api/src/connectors.ts` gains the code.
- The run's transaction rolls back, so the stored cursor is unchanged.
- The next sync after the wait resumes from that cursor. Pages read earlier in
  the failed run are read again and suppressed as duplicates.
- The `connector.sync` job records the same failure and never retries it (added
  2026-11-06, task-9e3a6eba8b30449a9259a1115ca338d2). A FAILED job is claimable
  again at the worker's next poll, with no backoff, so every retry would land
  inside the wait and spend the budget below. `CONNECTOR_RATE_LIMITED` is
  therefore the only code in `TERMINAL_CONNECTOR_SYNC_ERROR_CODES`
  (`packages/api/src/connector-sync-job.ts`; ADR 0012 terminal codes), whatever
  `retryAfterSeconds` says, null included. The job dead-letters on that attempt,
  and the connector scheduler's next window is the next sync. When `Retry-After`
  is longer than the window (15 minutes for OMI), that sync can meet a 429 again
  and fails the same way: one list call per window, at most 4 an hour, within
  the budget.

**Budget.** With transcripts, Omi allows 25 list calls per key per hour, one per
page. A run uses at most `maxPages` pages (default 1).

**Poison pill.** A conversation that fails D3's raw schema must not block the
cursor. The OMI branch of `prepareForCapabilities` validates each payload against
`omiConversationSchema` (exported by `@unai/domain`) and refuses a failing
payload on its own. The refusal is a `refusals[]` entry:

- `externalRef`: `omi:conversation:<id>` when the payload has a string id, else
  `omi:conversation`;
- `code`: `SOURCE_PAYLOAD_INVALID`;
- `capabilityId`: null.

The rest of the page is stored and the window moves on. Today a payload that
fails parsing throws a non-connector error, so the sync answers 500 and the
cursor never advances (SEAM-3).

References: §43.6, §20.5, §11.1, invariant 5.

### D8: Disconnect without provider revocation (code CONNECTOR_REVOCATION_MANUAL_REQUIRED)

**The constraint.** Omi does not let a developer key revoke itself.
`DELETE /v1/dev/keys/{key_id}` needs a Firebase ID token, which Uai does not
hold and must not hold (OMI-2).

**Rule.**

1. `createTokenRevoker` (`packages/connectors/src/providers.ts`) gets an OMI
   branch that makes no request and resolves no secret. It answers
   `{revoked: false, manualRevocationRequired: true}`. Without the branch, an
   unknown type throws `CONNECTOR_REVOCATION_UNAVAILABLE`, and an Omi connector
   could never be disconnected.
2. The `TokenRevoker` answer type (`packages/connectors/src/grants.ts`) becomes
   `{revoked: boolean; manualRevocationRequired?: boolean}`.
   `disconnectConnector` treats that answer as success with a notice:
   - every grant is revoked;
   - the status becomes `DISCONNECTED`;
   - `secret_ref` becomes NULL;
   - the cursor is cleared.

   Ingestion therefore stops exactly as for any connector (the trigger in
   migration 0018, ADR 0023 §3).
3. `disconnectResultSchema`, still a `strictObject`, gains
   `providerRevocationNotice`. Its value is
   `'CONNECTOR_REVOCATION_MANUAL_REQUIRED'` for Omi and null for every other
   connector. An Omi receipt is HTTP 200 with:
   - `tokensRevokedAtProvider: false`;
   - `secretReferenceDestroyed: true`;
   - `providerRevocationNotice: 'CONNECTOR_REVOCATION_MANUAL_REQUIRED'`.

   The code is a notice on a successful receipt, not a refusal.

**What the owner sees.** The web shows the notice as: "Uai has stopped using this
key and forgotten its handle. Omi does not let apps revoke developer keys: revoke
it in the Omi app under Settings > Developer."

**What `secretReferenceDestroyed` means.** Uai's row no longer names the handle.
`@unai/secrets` has no delete, so the value stays in the deployment's secret
store until the operator removes it. It also stays valid at Omi until the owner
revokes it.

**The runbook.** The connector-revocation runbook
(`docs/operations/connector-revocation.md`) gains an Omi section. The epic's
final task writes it; this task does not. The section tells the owner to:

1. revoke the key in the Omi app;
2. remove the stored secret;
3. read `tokensRevokedAtProvider: false` with this notice as expected, not as a
   failed revocation.

**Rejected: refusing the disconnect.** Stopping ingestion is the owner's control
and must not depend on a provider (§7.8, §30.7). A refusal would leave an active
connector able to read the owner's conversations. ADR 0023's rule that a failed
revocation is not a completed disconnect still holds for Gmail, Calendar and
GitHub, whose revokers either revoke or fail.

References: §7.8, §30.5, §30.7, §54 item 16.

### D9: Provenance limits

**What the evidence is.** The transcript is Omi's cloud speech-to-text, with
Omi's diarization and voice identification (model output). The owner may have
corrected it in the Omi app: `text` is the current text, and `originalText` is
the captured text when Omi reports a correction. Uai never receives or stores
audio (D2, D10), so a transcript cannot be re-checked against the recording,
and anchors point into text only.

**Times.**

- `startedAt` and `finishedAt` are Omi's.
- `startSeconds` and `endSeconds` are offsets in seconds from the start of the
  recording, as Omi reports them.
- `created_at` is Omi's record time, kept only as metadata and as the cursor
  basis.
- Offsetless or missing times stay null (§12.9).

Re-reading an unchanged conversation is a suppressed duplicate and refreshes
nothing (§12.9, invariant 44).

**Version.** `source_items.ingestion_version` stays `'evidence-json-v1'`. It
versions Uai's evidence format, not the provider's API: `migrations/0004_evidence.sql`
fixes it by CHECK, and `publicEvidenceSchema` declares it a literal. The provider
surface is recorded per item as
`deterministicMetadata.providerApi = 'omi-developer-api-v1'`. This departs from
the task text, which proposed `ingestionVersion`.

**Not retained.** Geolocation, folders, person-id lists beyond `participants`,
`emoji`, and the action items' completion state (D3). Locked conversations never
arrive.

**Drift.** The Context facts were verified on 2026-11-02, and Omi publishes no
versioning or deprecation policy. The protection against drift is twofold: the
raw schema strips unknown fields, and D7 falls back to the page size when the
paging headers are absent. A payload that no longer fits D3 is refused by name
(D7).

References: §11.1, §12.9, §24.2, invariants 2, 3 and 44.

### D10: Deferred, with reasons

**(a) Inbound webhooks** (memory creation, real-time transcript, audio bytes,
day summary). They are unsigned POSTs carrying only a `uid` and an
`Idempotency-Key`. Uai's boundary (`packages/api/src/index.ts`, the
`preParsing` hook) refuses any request without TLS, the session cookie and the
owner headers. A webhook would therefore be a new unauthenticated surface. The
spike recorded in ADR 0042 decides it, not this record (§27.4, invariant 41).

**(b) Omi memories, action items, goals and daily summaries.** They are
third-party model output (§24.2), and the transcripts already carry their
information. Reading them would widen the key's scopes.

**(c) Scheduled or automatic syncs.** The production epic owns them. This epic
syncs only when the owner asks.

**(d) Resolving Omi speakers to entities**, and so canonicalizing Omi
commitments. That would mean the owner's entity for `OWNER` segments, with an
entity-resolution confidence below 1, and a person entity for a named bystander.
It turns a third party's voice identification into identity (§15.3; §31, entity
mismerge) and needs its own decision. Until then, Omi claims stay unresolved
candidates.

**(e) Checking the key's effective scopes** with `GET /v1/dev/key`, and refusing
a key that holds a write scope. That is a least-privilege nudge, not a read-only
guarantee: D2 already limits Uai to one GET.

**(f) Splitting a conversation longer than 2048 segments into several items.**
Such a conversation is refused by name today (D7).

**(g) Windowed extraction**: several extraction runs over segment ranges of one
conversation, with per-window idempotency and processing keys in
`packages/extraction/src/runs.ts` and `packages/api/src/processing-store.ts`.
It would let a transcript over D4's size bound reach extraction. Until it
exists, such a transcript stays `DEFER_UNTIL_RELEVANT` evidence. The owner was
asked on 2026-11-02, in the planning session, how to handle conversations over
the bound, and chose "Defer, record in ADR (Recommended)".

## Consequences

- Each new conversation stores two evidence rows.
- Omi allows at most 25 transcript pages per key per hour. A first full sync of
  N conversations takes ceil(N/50) pages, at ≤ 25 pages per hour.
- Owner-spoken commitments, amounts, deadlines and decisions reach extraction and
  are inspectable with their segment and speaker. They stay unresolved
  candidates, not canonical commitments, until D10(d).
- An Omi disconnect completes with a manual step (D8).
- **Coverage.** With task-9436's 32 KiB FULL input bound, conversations longer
  than roughly five to fifteen minutes (about nine at typical segments) route
  `DEFER_UNTIL_RELEVANT` and are not extracted in this epic. Their evidence
  stays searchable and inspectable (D4, D10(g)).
- **Epic notes superseded by this record.** Several sibling task descriptions
  still quote the epic's shape; they follow this record instead:
  - per-segment `is_user`, `speaker` and `speakerId` (D3, D4);
  - anchor `start`/`end` in seconds (D5);
  - `ingestionVersion` for the provider version (D9);
  - `riskClass` MEDIUM (D6);
  - a PRIVATE context profile (D6);
  - `X-Omi-List-Truncated` as the only paging signal (D7);
  - "list 60/h": a transcript list is 25/h (D7).
- **Decision map of the epic's tasks:**
  - `@unai/domain` parser, task-c44efb1a92244064aa4700d6fbcd0ec3: D1, D3, D4,
    D5.
  - Migration, task-195eaa196f494bb5b9a09e341200e8ad: D5.
  - Held-out acceptance tests, task-9fd2751b432d479b9ad9dc0fd9afff2a: D2, D3,
    D6, D7, D8.
  - Triage, task-d3956af093fa4f3eafdecb1fb24d72f2: D3 and D4, including the size
    bound in `packages/extraction/src/triage.ts`, `buildExtractionInput` in
    `packages/extraction/src/runs.ts`, and the two vocabulary values in
    `packages/domain/src/extraction.ts`. It follows
    task-9436f4840ca04fc0afbe2bdc2be6fd42.
  - Manifest, task-e209d7f635ab470e872bf1c2a4c4b931: D6.
  - Client, task-4369924daf374995a41fd86e303177cd: D2, D7.
  - Disconnect, task-359a705a7e77409688962c384190cc38: D8.
  - Web, task-f4da64ffef49431f8975368870169986: D6, D8.
  - Sync integration, task-8e528f0cad59476695b2b1a1dfb945b6: D2, D6, D7.
  - Webhook spike, task-f4c97813333c4425a14de32d675d08a5: D10.
  - Live suite, task-e269cdce413740b6bccab479e5127604: D2, D6, D7.
  - Integration and hardening, task-2d70aa23cdd54252b45303071d5b6a5e: all.

## PRD references

§0 rule 7; §7.8; §11.1; §11.2; §12.9; §15.1; §15.3; §15.4; §15.5; §20; §20.1;
§20.2; §20.5; §20.6; §24.2; §27.1–§27.5; §30.3; §30.5; §30.7; §30.8; §31; §42
invariants 1, 2, 3, 5, 27, 41 and 44; §43.6; §54 items 1 and 16; FR-103; FR-104.

## Tests that will prove it

These tests are PLANNED. None exists when this record is written; the epic's
tasks deliver them.

- `packages/domain/src/sources.test.ts` with `fixtures/sources/omi-conversation.json`:
  D1, D3, D4, D5.
- `packages/postgres/src/omi-constraints.test.ts`: D5.
- `packages/extraction/src/triage.test.ts` and a pure `buildExtractionInput`
  test: D3, and D4 with the size bound.
- `packages/connectors/src/manifests.test.ts`: D6.
- `packages/connectors/src/providers.test.ts`: D2, D7, D8.
- `packages/api/src/omi-connector.test.ts`: D2, D3, D6, D7, D8.
- `packages/api/src/connector-sync-job.test.ts`: D7 (a rate-limited
  `connector.sync` job).
- `packages/api/src/omi-pipeline.test.ts` and `packages/api/src/security.test.ts`:
  D3, D4 and the transcript prompt-injection case.
- The OMI case of `packages/api/src/connectors.live.test.ts`: SKIPPED without
  `UNAI_LIVE_OMI_SECRET` and recorded UNVERIFIED, never waived (§54 item 1).
