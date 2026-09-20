# Conversation records

This delivery implements `ConversationService`, `Conversation`, and `ConversationTurn`
for the designed **Conversation list and lifecycle /chat**, **Chat thread and composer /chat**,
and **Talk transcript and push-to-talk /talk**. It implements their persistence and
data lifecycle, not their downstream screens or answer-provenance adapter.

## Service contract

`ConversationService` is exported by `@unai/control`. Construct it with a live
`withOwnerTransaction` transaction derived from the authenticated owner. It cannot
accept an owner override. `conversation.read` permits `list()` and `get(id)`;
`conversation.write` permits `create({title})`, `rename(id,title)`,
`appendTurn(id,{speaker,text,status})`, and `updateTurn(id,turnId,{text,status})`.
The caller owns transaction commit and read/write auditing, as on existing control
services. Deletion records its content-free audit in the database eraser itself.

The `Conversation` projection exposes `id`, `ownerScopeId`, `title`, `createdAt`,
and `lastActivityAt`: the design's owner scope, creation time, and activity time.
`get` returns `{conversation,turns}` from one database snapshot. The list is newest
activity first, with an ID tie-break. Turn fields are `id`, `ownerScopeId`,
`conversationId`, `storedOrder`, `speaker`, `text`, `status`, and `createdAt`.
Speakers are `owner` and `assistant`; statuses are `pending`, `accepted`, `unable`,
`refused`, and `failed`. Non-accepted turns have null text, so failed/refused
candidate text cannot enter this transcript. The subsequent provenance node owns
the grounded-answer adapter that authorizes accepted assistant text and associates
the engine manifest, grounding result, and answer audit with the turn.

A database counter serializes concurrent appends per conversation. Positions start
at zero, are unique, and are never renumbered or reused after turn removal. Parent
locks serialize appends, turn updates, and erasure. Identity, owner, speaker,
creation time, and stored order cannot be updated by the application role.
Conversation operations do not ingest evidence or create memories or proposals.

Migration `0036_conversations.sql` follows the existing highest migration, `0035`.
Both tables have forced RLS, owner membership checks, purpose checks, and composite
owner/parent foreign keys. The application has no direct DELETE privilege.
Ownership coverage and the projection-replay rebuild fixture include both tables.
Recheck the next free migration prefix at integration if another migration lands
before this worktree.

## Existing data controls

- `POST /v1/export` retains its HTTP 201 response and `{requestId,status,bundle}`
  envelope. The bundle adds `conversations`, `conversationTurns`, and their counts;
  eligibility is live data in the authenticated owner scope. These records are
  separate from `canonicalMemory` and evidence. Turns export in stored order.
- `POST /v1/data/deletions/preview` and `POST /v1/data/deletions` accept optional
  `conversationIds` alongside the existing `evidenceIds`. At least one selected ID
  is required, and commit still requires `confirmation: "DELETE"`. Receipts add
  `conversationIds`, `cascade.conversations`, and `cascade.conversationTurns`.
  Preview executes the real cascade and rolls back, including erasure audit and
  request rows. Conversation-only deletion needs no object store or memory rebuild.
- `delete(id)` and `deleteTurn(id,turnId)` use `data.delete`. The bounded SQL eraser
  rechecks membership, locks the parent, physically removes the selected records,
  and writes an atomic identifier-only audit. The service records the existing
  retention/deletion request receipt in the same transaction. Removed records are
  absent from later reads and exports; failure rolls back records and receipts.
- `POST /v1/data/retention/cleanup` calls `applyRetention(asOf)` and adds
  `conversationsDeleted` receipts. The existing retention setting with source type
  `CONVERSATION` and `rawRetentionDays` expires whole inactive conversations, using
  `lastActivityAt` strictly before the cutoff. A null or absent rule retains them.
  Each cleanup handles up to 200 eligible conversations and skips locked threads
  for a subsequent cleanup. Derived retention retains its existing memory meaning;
  transcripts are primary application records, not regenerable derivatives.

## Assigned acceptance

The mandatory service-level tests live in `packages/api/src/conversations.test.ts`
and retain these complete criteria:

- **verify-a1-lifecycle:** An export includes eligible conversations and turns, retention applies to them, and deleted conversations do not appear in subsequent export.
- **verify-a1-metadata:** Persisted conversations expose each required field and reload turns in their stored order.
- **verify-a1-storage:** Reload retrieves a conversation for its owner while a different owner scope cannot read or mutate it.

They run on real PostgreSQL through a non-owner application role. Additional tests
exercise the existing data-control routes, preview rollback, rejected text,
immutable order, wrong-purpose refusal, cross-owner definer calls, and rollback of
erasure with its audit. `packages/postgres/src/isolation.test.ts` includes
unfiltered foreign-owner and missing-context reads for both new tables.

The required gate for this node is **`pnpm test`**. Product-wide UI, speech,
accessibility, launch, provenance, and other nodes' acceptance remain assigned to
their sealed-plan owners; this report does not claim those checks.

Grounded answer integration is now described in [Conversation provenance](conversation-provenance.md).
It adds an optional `answerManifestId` to answered turns and purpose/sensitivity
scopes to newly grounded transcript rows. Set `unai.data_purpose` and
`unai.maximum_sensitivity` in the transaction before reading those turns.
