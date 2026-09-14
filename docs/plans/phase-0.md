# Phase 0 foundation implementation plan
**Goal:** Implement the approved foundation, with product authority required for authentication and phone delivery.
**Architecture:** Framework-free domain contracts are composed with PostgreSQL and storage adapters by the API; the web app consumes public schemas. PostgreSQL independently enforces owner boundaries.
**Tech Stack:** TypeScript, pnpm, Next.js, Fastify, Zod, PostgreSQL/pgvector, encrypted S3-compatible storage.

## Storage response lifecycle correction (ADR 0007)

1. In packages/storage/src/index.test.ts, return a real Node Readable response
   body with an incorrect KMS receipt from the test-only SDK stub. Expect the
   fixed STORAGE_OPERATION_FAILED error, no body consumption, and destroyed=true.
   Also cover a stream whose transformToByteArray rejects.
2. Run pnpm exec vitest run packages/storage/src/index.test.ts and confirm the
   destroyed assertions fail before implementation.
3. In packages/storage/src/index.ts, retain the GetObject response body and
   destroy Node streams in finally, without allowing cleanup errors to expose
   provider details or overwrite the fixed error.
4. Run pnpm test, pnpm typecheck, and pnpm validate:registry; preserve outstanding
   product decisions and the missing canonical release as submission findings.

Authority: contract-uai-v0 / rev-uai-v0-001 and design goal-2cf9472a-d972-4e97-88cf-1734639d9700@v1. Initial ADRs 0001 and 0002 precede implementation.

1. Establish real PostgreSQL tests for migration ownership coverage, cross-owner reads without filters, writes, pool-context reuse and append-only audit enforcement. Tests must run as a non-owner, non-BYPASSRLS role.
2. Add Git SQL migrations for users, owner_scopes, owner_scope_members, devices and audit_events. Keep user identity actor-scoped; explicitly scope devices to owners, preserving their user relation.
3. Add transaction-local actor/owner/purpose/correlation context and application membership checks. Never accept caller-supplied actor identity as authentication.
4. Add an append-only audit adapter and tracing primitives; retain public IDs and bounded metadata only.
5. Establish the pnpm workspace, shared schemas, Fastify composition and Next.js shell. Implement sign-in and device registration only after the requested product decision is recorded in an ADR.
6. Configure TLS and encrypted storage, local infrastructure and CI. Verify storage/database encryption using deployment evidence.
7. Run pnpm test, typecheck, registry validation and security integration tests. Report incomplete requirements explicitly and submit through the offered review command; daemon acceptance remains authoritative.

Product decision pending: sign-in provider/method, session issuance/expiry/revocation policy, and responsive phone web delivery. No implicit approval is inferred from this plan.

## Commit receipt correction (ADR 0006)

1. Add a real database regression to packages/postgres/src/isolation.test.ts:
   append an audit event, catch SELECT 1/0, and return a success value. Expect
   withOwnerTransaction to reject with TRANSACTION_NOT_COMMITTED, no persisted
   audit row, and a successful subsequent transaction for the other owner.
2. Run pnpm test and observe the regression fail because the callback result is
   returned after PostgreSQL answers COMMIT with ROLLBACK.
3. In packages/postgres/src/index.ts, inspect the result of client.query('COMMIT');
   clear transaction state and throw TRANSACTION_NOT_COMMITTED unless its command
   equals COMMIT. Only then record success and return the callback result.
4. Run pnpm test, pnpm typecheck and pnpm validate:registry. Preserve and report
   the known missing production registry rather than manufacturing a release.

Implemented independent increments: transactional migration runner and CLI (ADR 0004), Fastify request-boundary port, S3 encryption boundary (ADR 0005), and registry structural loader/CLI. Each implementation followed failing tests. Full-suite evidence is recorded in docs/foundation.md and the submission report; registry release absence remains a phase-exit failure, not an empty successful validation.

## Approved authentication delivery (ADR 0008)

Goal: compose the approved Google identity and absolute database sessions with
responsive Sign-in and device registration and the common navigation.
Architecture: Auth.js runs the OAuth ceremony; a PostgreSQL adapter uses narrowly
granted auth functions. Fastify uses the token resolver plus owner transactions.
The web consumes only public DTOs. Domain code imports no providers or UI.

1. Add real PostgreSQL tests in packages/postgres/src/auth.test.ts for distinct
   subjects sharing email, absolute expiration, logout, sign-out-all, disabled
   accounts, device removal, forbidden auth table access and unfiltered RLS.
   Run pnpm test and observe missing auth migration assertions before code.
2. Add migrations/0002_authentication.sql and packages/postgres/src/auth.ts;
   extend ownership.ts classifications and isolation.test.ts fixtures. Preserve
   existing migration bytes. Re-run the full suite and typecheck.
3. Add packages/auth for the stable Auth.js adapter/config, testing identity-only
   scopes, secure cookies and immutable expiry. Add authenticated device service
   and Fastify composition with purpose checks and transactional audit.
4. Add apps/web Pages Router shell, TLS server, Sign-in and device registration
   states and navigation. Add render/state tests and exercise the real auth
   library with a controlled OAuth server only in tests. Run the Next.js build.
5. Document configuration, migration roles, TLS, encryption requirements and
   actual verification. Run pnpm test, pnpm typecheck and pnpm validate:registry.
   Keep the required registry check unchanged; report its actual result using
   the sealed ownership map, without manufacturing a descendant release.

## Current handoff

ADR 0008 resolves the previously pending choices; its web, Auth.js, database
session and device composition steps are implemented with tests. The common
navigation marks downstream screens unavailable. ADR 0009 is an unimplemented
proposal rejected by automatic approval review; no role migration was applied.
Full current operation and verification limits are in docs/foundation.md.
