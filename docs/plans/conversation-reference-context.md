# Conversation reference resolution implementation plan

**Goal:** Resolve same-thread references without promoting transcript text to factual evidence.
**Architecture:** ConversationService reads owner-scoped, purpose-filtered turns and produces a resolved question. The shared Ask adapter derives the approved optional creditor/due-week or unresolved query restriction and records the original owner wording. Neither transcript records nor provenance are supplied as support; existing evidence and authorization rules remain unchanged.
**Tech Stack:** TypeScript, PostgreSQL RLS, Vitest, Fastify.

## Operator-approved continuation

Decision `4f30483d860ef242914fd93e6038cd35622f81029dfb3251e1a6a1508bbc3cf1` permits the narrow query exception. Preserve existing worker edits.

1. Reproduce the enabled `verify-a2-context` failure with `pnpm test`.
2. Extend the acceptance fixture to assert this-week selection, creditor exclusion, interval boundaries, fresh-thread empty provenance and explicit query backward compatibility; run it failing.
3. Add an optional typed `referenceQuery` to Ask/Context schemas. Resolve exact creditor labels only inside the owner-scoped broker; restrict structured candidates using authorized claims and selected due dates. `UNRESOLVED` retrieves no candidate or semantic/overlay support. Default requests stay unchanged.
4. Derive the query from the current resolved owner question, with UTC Monday week boundaries. Prior owner turns alone establish the temporal template; assistant names are reference aids only.
5. Verify focused tests and the real `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm validate:registry` gates. Document outcomes and the operator decision, then submit durable review and release the claim.

1. Add service tests for week ellipsis, assistant-mentioned names, ambiguous names, thread isolation and purpose checks; observe missing-method failures.
2. Implement a conservative deterministic resolver in `packages/control/src/conversation-references.ts`, called from `ConversationService.resolveReference` after its scoped read. Only carry grammatical names and the owner's question template, never assistant assertions.
3. Wire validated Ask requests through the service under `conversation.read`, using declared data purpose and sensitivity. Preserve original question text in responses and recorded turns.
4. Add real-engine regressions in `packages/api/src/answers.test.ts`: unsupported assistant facts, assistant plus independent source versus independent source alone, selected support and manifests, positive name resolution, and fresh-thread behavior.
5. Run focused tests, then `pnpm test`. Retain both assigned criterion statements in documentation and apply only the later operator-approved query exception documented above.
