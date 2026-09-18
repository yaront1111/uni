# Owner read-your-writes and the correction write paths

Node `owner-sequence-overlay-deltas-and-correction-endpoints` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc. Criteria: CRT-AI-03-A, CRT-MEM-15-A,
CRT-RYW-01-A, CRT-RYW-02-A, CRT-RYW-02-B, CRT-RYW-06-A. Decisions: ADR 0019.
Schema: `migrations/0014_owner_overlay_and_corrections.sql`.

Design entities implemented here: **`owner_sequences`**, **`owner_overlay_deltas`**,
**`memory_operations`**. Design screen whose API semantics and cross-device states
this serves: **Correction controls**.

## What it does

An owner writing on one device sees that write from another device on the very
next read, before any canonicalization has run. That is the whole shape of this
slice:

1. `unai_private.allocate_owner_sequence` hands out a strictly monotonic number
   per owner scope, inside the caller's transaction (CRT-RYW-01-A).
2. `owner_overlay_deltas` records what the owner said, scoped to the owner and
   never to the device, so every device's read is the same read
   (CRT-RYW-02-A, CRT-RYW-02-B).
3. Eight correction controls each write forward — new evidence, a delta, a
   memory operation, and where it applies a proposed transaction — and update no
   existing claim, proposition or assessment row (CRT-RYW-06-A).

## Surface

`@unai/memory` (`src/overlay.ts`), pure functions over a transaction the caller
opened:

| Function | What it is for |
| --- | --- |
| `allocateOwnerSequence` | The owner's next sequence, allocated not chosen |
| `recordOverlayDelta` | One delta, with its sequence, at lifecycle `RECEIVED` or as stated |
| `attachOverlayDelta` | Bind a delta to the instance, slot and transaction that took it up |
| `contestOverlayDelta` | The only write re-extraction has over a delta (CRT-MEM-15-A) |
| `readOwnerOverlay` | The owner-wide read: deltas, watermark, suppressed/archived/deleted targets |
| `isOverlayRemoved` | Honour an acknowledged suppression, archive or deletion in a reader |
| `recordMemoryOperation`, `listMemoryOperations` | The ten correction control kinds |

`@unai/api` (`src/corrections.ts`), all under purpose `memory.correct`:

`POST /v1/memory/overlay-deltas`, `GET /v1/memory/overlay-deltas`,
`POST /v1/memory/corrections`, `/state-changes`, `/confirmations`, `/rejections`,
`/keep-uncertain`, `/suppressions`, `/archives`, `/deletions`.

Each write answers a receipt with `operationKind`, `evidenceId`,
`overlayDeltaId`, `ownerSequence`, `proposedTransactionId`, `lifecycle`,
`visibilityStatus: OWNER_VISIBLE` and `createdClaimId`.

## The ten operation kinds

`CORRECT`, `CHANGED`, `CONFIRM`, `REJECT`, `KEEP_UNCERTAIN`, `SUPPRESS`,
`ARCHIVE`, `DELETE`, `MERGE`, `SPLIT` — a CHECK list on `memory_operations`, so
there is no generic "edit memory" to fall back to. Eight have an endpoint here.
`MERGE` and `SPLIT` are `merge-split-lineage-and-uuidv7-identity-invariant`'s
endpoints; the row shape is present so that node writes into it rather than
migrating for it.

## What this node explicitly does not claim

- **No deletion cascade.** `POST /v1/memory/deletions` records an acknowledged
  request and the delta that hides the object from every device's next read. The
  cascade to raw object, anchors, claims, embeddings, summaries, indexes and
  projection rows is CRT-SEC-11-A, owned by
  `drafts-actions-permissions-export-and-deletion-workflow`.
- **No canonical archive, merge or split.** Those belief operations are still
  refused by the governor as `BELIEF_OPERATION_NOT_DELIVERED`.
- **No projection or context packet.** `readOwnerOverlay` is the function the
  Context Broker and the projection reducers consume; neither is built here.
  CRT-RYW-03-A (unattached-delta candidate indexes), CRT-RYW-04-A (pending
  correction in a projection read) and CRT-RYW-05-A (the contested lifecycle as a
  broker-visible record) belong to other nodes. The columns and the
  `contestOverlayDelta` write they need exist; the reads over them do not.
- **No UI.** The Correction controls screen is CRT-UX-10-A/CRT-UX-10-B, owned by
  `commitments-obligations-inspector-and-correction-controls`. Nothing was added
  to `apps/web`.
- **Independent verification is narrow on purpose.** A delta is corroborated only
  by an `EXTERNAL_PERSON_ASSERTION`, `STRUCTURED_CONNECTOR_OBSERVATION`,
  `DOCUMENT_ASSERTION` or `TOOL_EXECUTION_RECEIPT` claim on the same proposition
  from evidence other than the owner's own statement. A model reading of the
  owner's message is not verification of it (PRD §15.4). The full independence
  group calculus lives in `@unai/belief` and is not duplicated here.

## Tests

- `packages/memory/src/overlay.test.ts` — the allocator under two genuinely
  concurrent transactions (the second is shown to be *blocked* until the first
  commits, which is what makes "in commit order" a claim rather than a hope), the
  duplicate-pair rejection, the cross-device read with and without independent
  corroboration, suppression and deletion honoured by the other device, the
  CONTESTED ceiling, and all ten operation kinds.
- `packages/api/src/corrections.test.ts` — the same over the real boundary with
  two sessions of one owner. CRT-RYW-06-A compares the `xmin` of every
  `claims`, `propositions`, `belief_assessments`, `belief_slots` and
  `frame_instances` row before and after the correction: an in-place update
  anywhere would change one.
- `packages/postgres/src/isolation.test.ts` — the cross-owner fixture for the
  three new tables, the immutability triggers, and the table count.

Both database suites need the harness: run `pnpm test`.
