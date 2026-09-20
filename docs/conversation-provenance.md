# Conversation-backed answer provenance

Assigned goal: `goal-c3baf994-a368-46e4-9078-bc77a124b430`; node:
`replan-0920c-conversation-provenance`.

This node implements **AnswerProvenance** and the grounded-answer associations of
**Conversation** and **ConversationTurn**. It supplies backend behavior for the
designed **Chat thread and composer /chat**, **Talk transcript and push-to-talk
/talk**, **Answer and Why / sources panel in Chat and Talk**, and **Legacy Ask
entry /ask?q=**. Rendering those downstream screens is outside this node.

## Integration contract

Chat, Talk and legacy Ask use the existing `POST /v1/ask` pipeline. The optional
`conversationId` selects an existing conversation in the authenticated owner
scope. Omit it for legacy Ask or a new thread. An unknown/foreign conversation is
refused before retrieval or model invocation. The normal Ask declarations and
`memory.read` route purpose remain required; no client-supplied actor is accepted.

The response adds `conversationId` and `turnId` alongside `answerManifestId` and
`grounding`. `turnId` names the assistant turn. The adapter appends the owner
question and the assistant turn as one ordered pair, atomically with the manifest,
provenance association, and recording audit. A locked parent counter serializes
concurrent appends and deletion. A recording error returns no answer.

`GroundedTurnAdapter` stores only the validated presentation. `accepted` means
safe to present, not a settled personal fact: UNKNOWN, CONFLICTING, inferred and
other labels retain their existing grounding meaning. A grounding BLOCKED result
stores a `refused` assistant turn with null text and a retrievable grounding
manifest. Rejected candidate bytes are never ingested or projected; attempt
outcomes and violations remain in the existing grounding result. HTTP validation
or authorization refusals before answering do not manufacture answered turns.

`ConversationService.get()` returns `answerManifestId` on answered turns. Use
`GET /v1/answers/{answerManifestId}/manifest` under `memory.inspect`, with the
existing data-purpose and maximum-sensitivity headers, to retrieve the manifest
and grounding result. Its `conversationId` and `turnId` identify the same turn.
The manifest and reconsideration readers preserve the legacy
`conversationMessageId` reference for old evidence-backed manifests; new ones
return null there. Old manifests return null for the new associations.

## Storage and boundaries

Migration `0037_conversation_answer_provenance.sql` leaves applied migrations and
old manifest rows untouched. It makes the legacy evidence FK nullable, adds the
owner-scoped `answer_provenance` association with composite foreign keys and
one-manifest-per-turn uniqueness, and adds data-purpose/sensitivity fields to
newly grounded turns. All new table access uses forced RLS and purpose checks.
Existing unscoped conversation rows keep their original read semantics.

The recorder uses the server-selected `answer.record` purpose. Its obsolete
INSERT policies on evidence, anchors, ingestion receipts, object keys and triage
are removed. Conversation recording needs no evidence object store and creates no
source, extraction, canonical-memory, overlay or proposal rows. Grounding,
Context Broker selection, registry, belief and memory write behavior are unchanged.

New transcript rows require the original data purpose and at least the original
sensitivity ceiling on reads, including exports. Grounded turn text cannot be
edited through the generic conversation update path. The manifest reader also
retains its current packet/source authorization checks. Conversation titles
created by legacy Ask are generic, avoiding an unscoped copy of the question.

Deleting a conversation or its assistant turn cascades its association, while
preserving immutable historical manifests. Such a manifest subsequently refuses
reads with `ANSWER_MANIFEST_SOURCE_WITHHELD`; it cannot restore erased transcript
content. The existing deletion audit/receipt transaction remains in force.

Recording and successful Ask audits include the conversation, assistant turn,
packet and manifest IDs. Manifest reads audit the same conversation and turn.
Audits contain identifiers and field names, not candidate text.

## Assigned acceptance and verification

- **verify-a3-audit: Audit records for each answered turn contain matching conversation id and turn id.**
- **verify-a3-provenance: For every answered turn, its manifest and grounding result are retrievable and belong to that turn.**

`packages/api/src/answers.test.ts` retains these full criterion statements and
exercises real authenticated Ask success and grounding refusal, retrievable
matching manifests/grounding/audits, appending to a thread, legacy manifests,
scoped transcript projections, erasure, immutability and foreign-owner rejection.
Accepted, blocked and regenerated model candidates are each surrounded by complete
before/after snapshots of evidence, extraction, memory and proposal tables:
conversation requests must leave every compared row unchanged.

The existing PostgreSQL isolation and projection-replay fixtures include the new
table and migration. The retained legacy-assistant fixture still proves that an
assistant source cannot support a governed accepted belief. The erased-memory
regression still proves that retained transcript text cannot reconstruct memory.

The node gate is its two assigned criteria and `pnpm test`. Other nodes own their
screen, accessibility, speech and product-boundary criteria. No SOURCE_ONLY
exemption is used. Run `pnpm test` from the workspace root; the harness applies all
migrations and performs its normal isolation, acceptance and recovery checks.
