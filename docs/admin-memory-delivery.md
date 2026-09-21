# Admin memory delivery — 2026-09-22

Assigned node: `replan-0920c-memory-workspace`. Goal: `goal-c3baf994-a368-46e4-9078-bc77a124b430`.

## Implemented design surfaces and entities

This node implements **Memory search and detail /admin/memory**, **Memory actions and merge/split review /admin/memory**, **Proposal inbox /admin/memory**, **Memory deletion preview and receipt /admin/memory**, and **Remember this proposal and confirmation flow** in the shared ConversationThread. It uses the designed ExistingMemoryAndProposal projection and explicitly selected ConversationTurn. No replacement memory tables, registry contracts, connectors or evidence-admission rules were added.

Search uses existing POST `/v1/memory/context` with server-authenticated actor/owner, query, entityHints, worldlineHints, frameTypeHints and timeWindow, then existing related-frame inspection alongside commitments/obligations/schedule projections. The page supports search and person/topic/source-date/kind filters. The production-route fixture test includes a payment allocation outside the original three projections. Retrieval is bounded, not a claim of exhaustive enumeration. Current certainty and exact sources remain the existing inspector's output.

Existing correction and merge/split controls are embedded. Their operation semantics remain in the existing routes. Confirmation, correction, rejection, keep-uncertain, suppression, archive and delete retain purpose, fresh correlation and payload-stable idempotency keys. Delete freezes target/scope in a cancellable preview, then calls `/v1/memory/deletions` once. Its receipt identifies the audited memory operation and owner sequence and explicitly reports a pending deletion workflow. It never expands the target to supporting evidence or claims completed physical erasure. The prior report's completed-cascade requirement was stronger than verify-d3-delete and has been removed.

## Proposal and Remember adapters

`GET /v1/memory/transactions` is an owner-scoped projection of existing PROPOSED/VALIDATED belief_transactions and ordered operations, with exact readable supporting anchors. `POST /v1/memory/transactions/:id/reject` settles only the existing REJECTED terminal workflow state. It checks ownership and the proposal idempotency key, locks the transaction, refuses committed transactions, and records the owner/correlation in the rejection reason plus the normal audit event. Validation and the second commit transaction recheck terminal state under the same row lock. Migration 0012 already grants these settlement columns and enforces immutable terminal state; no permission expansion was needed.

ProposalInbox/BatchReview selects multiple stored proposals and requires a confirmation review. It composes individual existing governor commit calls or the terminal rejection adapter; there is no bulk endpoint. Cancellation makes no calls. Successful and failed decisions are shown individually, and settled proposals leave the local pending list. The governor requires the original proposal key at settlement; correlation IDs are fresh per request.

RememberThisEntry opens an explicit owner-turn draft without a network request. Its proposal call uses `/v1/memory/transactions/propose`. The selected-turn adapter re-reads the live owner-scoped turn, refuses assistant turns, and ignores no client-provided replacement text: only conversation/turn IDs are accepted. It uses ingestOwnerStatement under the existing memory.correct purpose to admit the exact owner's words as PRIVATE supporting source evidence. Migration 0031 deliberately does not enqueue automatic processing for that purpose. Conversation alone still creates neither evidence nor proposals. Source creation occurs only on explicit Create proposal, as disclosed in the draft; cancellation before proposing writes nothing.

The adapter pins the configured registryReleaseId and proposes the existing ADD_CLAIM operation with the genuine sourceAnchorId. A conversation-turn UUID is never an evidence anchor. Until explicit commit there are no new claims, propositions, assessments or owner overlays. Confirmation stores an unbound CANDIDATE claim, as required by recordClaim for a statement without a proposition. It does not guess a predicate, invent structured interpretation, or declare the statement accepted or factual. The UI states that interpretation is pending. Rejection settles the proposal without mutating memory; the explicitly admitted source record remains evidence. Unsupported assistant assertions cannot be relabelled as owner statements.

## Assigned acceptance, retained verbatim
- [verify-a7-remember] Remember this opens the existing proposal and confirmation flow; any omission is recorded in an ADR dated before implementation.
- [verify-d1-actions] Confirm, correct, reject, keep uncertain, suppress, archive, delete and merge/split review use the existing operations without reimplementation; confirm, correct, reject, suppress, archive and delete each issue one appropriate route call with purpose, correlation id and idempotency key.
- [verify-d1-belief] Opening a memory item displays its current certainty and opens its existing supporting sources.
- [verify-d1-find] At /admin/memory the owner can locate fixture items using search and each of the four browse dimensions.
- [verify-d2-inbox] Pending proposed memories appear in the inbox and selecting multiple proposals supports both batch confirmation and batch rejection through existing operations.
- [verify-d3-delete] A delete flow presents the preview before committing and presents the resulting audited receipt after success.
- [verify-r04-proposal] Explicitly remembering a statement uses /v1/memory/transactions/propose and requires confirmation before memory changes.

## Verification and ownership

Exact criterion IDs appear in the component, interaction and production-path tests. Added production checks exercise selected-turn provenance, no automatic processing, proposal-before-confirmation, cancellation/read-only drafting, rejection without memory writes, actual cross-owner isolation, committed-state refusal, reject-versus-commit interleaving, all five fixture discovery cases, and truthful audited deletion receipts. Existing regressions retain memory operations, outcomes, belief policy, merge/split, lifecycle and permission coverage.

Required gate: all seven assigned criteria and `pnpm test`. A fresh result is recorded in the review submission; the daemon's independent verifier supplies acceptance. `pnpm typecheck` is an additional useful check, not a substitute gate. Product-wide shell, launch, accessibility, speech and release checks remain with their sealed-plan owners. No criterion was waived or attributed away. This report is not an omission ADR and makes no product-boundary acceptance claim.
