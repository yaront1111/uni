# Evidence runtime implementation plan

**Goal:** Meet CRT-EVD-01-A, CRT-EVD-02-A/B and CRT-EVD-03-A with synchronous durable storage.
**Architecture:** Reuse authenticated Fastify context and PostgreSQL owner transactions.
Compose encrypted S3 through a transaction-bound resolver. Keep semantic workers independent.
**Tech Stack:** TypeScript, Fastify, Next.js, Zod, PostgreSQL/pgvector, SQL migrations, S3.

1. Record ADR 0010 before source edits; preserve ADR 0008 authority and prior migrations.
2. Add API integration tests in packages/api/src/evidence.test.ts: stopped-worker POST,
   duplicate/concurrent/null-connector identity, direct SQL uniqueness, metadata readback,
   failed PUT rollback, owner/purpose/sensitivity refusal and immutable rows.
   Run pnpm test; expect missing evidence route/schema failures.
3. Add migrations/0004_evidence.sql with connectors, source_items, source_anchors,
   composite ownership FKs, forced RLS and immutable metadata. Extend ownership coverage
   and unfiltered isolation fixtures; retain every existing security check.
4. Add packages/domain/src/evidence.ts schemas and packages/api/src/evidence.ts service;
   register routes in platform.ts and compose S3 in server.ts. Await PUT and COMMIT
   before acknowledging. Tests use a test-only object adapter; production uses real S3.
5. Add the designed upload/source-detail page and shared navigation. Extend the
   same-origin proxy with exact purpose mapping and session-derived actor/owner.
6. Run pnpm test, pnpm typecheck, pnpm build, and the existing registry gate. Document
   observed outcomes and deployment limits in docs/evidence-runtime.md. Inspect diff
   for ownership, private-key leakage, concurrency and response-before-commit issues.
7. Submit the exact daemon review offer with any unresolved findings; release claim.
