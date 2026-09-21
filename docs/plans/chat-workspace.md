# Chat workspace implementation plan
**Goal:** Deliver the designed conversation list, thread/composer, shared accepted answer/source presentation and legacy Ask entry.
**Architecture:** Thin API routes call ConversationService. Persist only the pipeline's validated answer projection on the existing turn, protected by its owner/purpose RLS. Server loaders and the existing same-origin write proxy supply authenticated identity; components never choose owner scope.
**Tech Stack:** TypeScript, React/Next, PostgreSQL, Vitest static rendering and accessibility jsdom.

1. Add failing route/proxy and component tests for lifecycle, persisted answer association, refusals, keyboard/pending/error and legacy redirect. Run focused Vitest tests before implementation.
2. Add migration 0039 for the accepted answer projection and extend the grounded recorder; add conversation read/create/rename routes consuming ConversationService. Deletion/export use existing data controls.
3. Add validated domain view, Chat loader, same-origin proxy mappings, ConversationList, ConversationThread/Composer, AcceptedAnswerPresenter and SourcesPanel. Preserve Ask example constants. Legacy Ask calls the existing engine once and redirects to its new conversation.
4. Add real PostgreSQL/API lifecycle and source association coverage; DOM keyboard, focus and responsive-layout contract checks. Keep unavailable and error copy fixed.
5. Run focused tests, type checking where useful, then the required `pnpm test`. Review the diff and record all assigned criteria and any limits in the delivery report before durable review submission.
