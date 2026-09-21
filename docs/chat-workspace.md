# Chat workspace

This node implements the designed **Conversation list and lifecycle /chat**, **Chat thread and composer /chat**, shared **Answer and Why / sources panel in Chat and Talk** components, and **Legacy Ask entry /ask?q=**. It consumes **Conversation**, **ConversationTurn**, and the existing **AnswerProvenance** association. Talk integration and spoken presentation acceptance remain downstream; this report does not claim those boundaries.

`GET /v1/conversations`, `POST /v1/conversations`, `GET /v1/conversations/:id` and `PATCH /v1/conversations/:id` adapt the upstream ConversationService. Create/rename/read are audited. Delete uses the existing preview and confirmed deletion APIs; export and audit links open existing controls. No conversation operation creates memory or evidence.

Migration 0039 stores the pipeline's post-validator answer projection on the assistant turn, under the existing turn RLS and erasure. No rejected candidate is stored. The read route verifies current manifest/source permission before releasing accepted answer bytes; missing historical projections are explicitly unavailable, never reconstructed. Engine statement labels and accepted words are preserved. Source maps are nested by turn then statement, using the existing WhySources renderer and source loader. The manifest retains its packet, grounding result and audit association.

Server page and read API handlers use `identity(req)`; write operations use the existing same-origin proxy with authenticated owner scope, fixed purpose, fresh correlation and idempotency headers. Ask questions use POST /v1/ask. Legacy Ask performs that operation once without a conversation id, then opens the newly recorded thread; it does not regenerate an answer on Chat load. Existing Ask examples remain unchanged.

The responsive grid becomes one column below 40rem. Thread text, sources and controls wrap; the composer has no fixed width or fixed-position overlay. Static CSS/render assertions and accessibility jsdom exercise 320 CSS pixels and a 640 CSS-pixel viewport representing 1280px at 200% zoom. These are repository-convention checks, not a claim of browser screenshot or visual measurement.

## Assigned acceptance checks

Every statement below is retained as assigned. API/service integration tests use real PostgreSQL and platform routes; component tests use static rendering; DOM behavior uses the existing accessibility jsdom/KeyboardUser setup.

- **verify-a4-sources:** Opening Why / sources on each answer displays the existing explanation for that specific turn. Covered by Chat static and DOM tests plus the real Ask-to-Chat source roundtrip in `apps/web/e2e/ask.test.ts`.
- **verify-a5-unavailable:** No grounded support, incomplete state and permission refusal each display a clear inability-to-answer result without substitute invented answer text. Covered by presenter tests, including blocked candidate exclusion.
- **verify-a6-create:** Starting a conversation creates a new owner-scoped thread that accepts a first turn. Covered by real API lifecycle tests and Chat DOM controls.
- **verify-a6-delete:** After deletion neither the conversation nor its turns remain, an audit record exists, and a following export omits it. Covered by real API lifecycle tests and confirmed deletion controls.
- **verify-a6-list:** A conversation receiving the latest activity precedes older conversations in the list. Covered by real API lifecycle tests creating a newer inactive thread before answering the older thread.
- **verify-a6-rename:** A changed title persists after reloading the conversation list. Covered by real API lifecycle tests and Chat DOM controls.
- **verify-b1-keys:** Keyboard tests verify Enter submits, Shift+Enter adds a newline without submission, and focus is in the composer after send. Covered by Composer and full Chat DOM tests.
- **verify-b1-thread:** Opening /chat shows ordered owner and assistant turns and an operable text composer. Covered by real page handler, static rendering and DOM tests.
- **verify-b2-expired:** An expired-session response causes navigation to exactly /signin?reason=expired. Covered by actual page handlers and client request navigation tests.
- **verify-b2-failure:** A failed request renders the fixed failure message rather than raw exception content. Covered by rejected request and read API tests.
- **verify-b2-pending:** With an unresolved answer request the thread visibly indicates that the turn is pending. Covered by deferred-fetch DOM tests, including duplicate-submit prevention.
- **verify-b3-layout:** At 320 px width and at 200 percent zoom the owner can read the thread, compose and send a turn, and open sources. Covered by responsive CSS/render assertions and narrow-viewport DOM controls; jsdom does not compute visual geometry.
- **verify-b4-examples:** An empty thread offers the questions already listed by Ask, or a pre-implementation ADR records the deviation. Covered by exact existing example enumeration; no deviation.
- **verify-b5-ask:** Visiting /ask?q= with a question creates a new conversation containing the same grounded answer produced for that question. Covered by actual legacy page handler and real Ask-to-Chat persistence/source roundtrip.

## Verification

The node's required gate is `pnpm test`, run on the stable completed workspace before submission. `pnpm typecheck` is an additional useful check. Migration replay retains its exact expected migration list, extended with 0039. Final execution results are reported with the durable review submission; this document does not substitute for daemon verification or claim whole-product acceptance.
