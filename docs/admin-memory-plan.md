# Admin memory completion plan
**Goal:** Complete all seven assigned memory criteria without replacing stored memory models.
**Architecture:** Owner-scoped adapters read existing transactions and broker packets; individual decisions reuse the governor. Explicit selected-turn drafting never writes memory before confirmation.
**Tech Stack:** TypeScript, React/Next, Fastify, PostgreSQL, Vitest.

1. Add production-route tests for proposal listing, terminal rejection, ownership, idempotency and reject/commit races; observe failure. Implement thin adapters and recheck terminal state inside the commit lock.
2. Add inbox component tests for selection, review, individual commit/reject requests and cancellation; observe failure. Add server read and same-origin proxy mappings and wire ProposalInbox into AdminMemory.
3. Trace evidence admission and registry operations. Add selected-turn proposal/confirmation tests before implementing RememberThisEntry; preserve original evidence provenance and prevent assistant assertions from becoming owner evidence.
4. Add broker-backed fixture discovery tests for text/person/topic/time/kind; observe failure. Wire existing context request and projections to the memory screen.
5. Retain action/source/deletion regression checks, add exact criterion IDs, and correct the deletion report to describe pending audited workflow rather than completed erasure.
6. Run pnpm test; inspect changes and results. Retain every unmet criterion as a review finding, submit using the current offer, then release the claim.
