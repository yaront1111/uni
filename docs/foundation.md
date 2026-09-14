# Phase 0 foundation status and operation

The foundation is partially implemented. It is not a completed Phase 0 delivery.

Latest verification in this delivery: `pnpm test` exits 0 with 166 tests in 15 files;
`pnpm typecheck` exits 0; `pnpm validate:registry` exits 1 with
`REGISTRY_RELEASE_MISSING`. Authentication and phone-delivery authority remain
unresolved. New implementation increments had observed failing tests before code
was added. The architecture check additionally enforces domain dependency limits.

## Authority and scope

Authority is approved contract contract-uai-v0 / rev-uai-v0-001 (digest 22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339) and design goal-2cf9472a-d972-4e97-88cf-1734639d9700@v1. Existing ADRs 0001 and 0002 preceded this work; ADR 0003 precedes the explicit device owner column.

Implemented database entities: users, owner_scopes, owner_scope_members, devices, audit_events. No screen is implemented. Sign-in and device registration remains the only assigned screen. Audit log UI and whole-system audit coverage belong to production-operations.

The monorepo contains the existing kernel, a shared Zod domain package, a PostgreSQL provider, a Fastify request-boundary package, an encrypted S3 provider and a structural registry loader. Domain imports neither UI nor provider code. The Next.js shell and application composition remain outstanding. The Fastify package requires explicit authentication and authorization ports; it does not ship a fabricated session verifier or public business routes.

## Local verification

Use Node 24, pnpm 11.0.8, OpenSSL and a running Docker engine. Windows TLS tests use Git for Windows' bundled OpenSSL; Linux CI uses `openssl` on PATH:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm validate:registry
```

The full test command starts an isolated PostgreSQL 17/pgvector container on a random loopback port with ephemeral storage, applies every SQL migration in filename order, runs all tests and stops the container. The committed password is only for this disposable test instance. Never use it for a persistent database. Direct Vitest invocation without the harness fails; security integration tests cannot silently skip.

The tests use a separate non-superuser, non-BYPASSRLS application login, verify actual unfiltered queries with data for two owners, and exercise cross-owner insert refusal, membership expiry, audit write-once permissions, rollback and pooled-connection context cleanup. Every application table must be classified in packages/postgres/src/ownership.ts. Adding a table requires a migration and fixtures/assertions in isolation.test.ts. The guard rejects unclassified tables, missing owner columns, absent policies and disabled/unforced RLS. It also inspects schemas outside public to prevent evasion by moving tables.

`pnpm validate:registry` invokes the structural registry loader. It checks manifest hashes, bounded YAML without aliases or duplicate keys, required frame/predicate fields, modalities, duplicate IDs and safe local filenames. It currently fails with `REGISTRY_RELEASE_MISSING` because no production `registry/releases/0.1.0/manifest.json` exists. Synthetic contracts live only in tests. Structural lint does not replace corpus, identity, transition or projection-replay validation, and callers must load an immutable Git checkout. The foundation workflow and `pnpm check:phase-exit` include this failing gate; Phase 0 cannot be declared complete.

## Database deployment requirements

Use `pnpm db:migrate` with `UNAI_MIGRATION_DATABASE_URL` and `UNAI_DATABASE_CA_PATH` set explicitly for the intended deployment. The CLI verifies PostgreSQL TLS, serializes runners with an advisory lock, applies trusted Git SQL in filename order and records each SHA-256 digest atomically in `unai_migrations.applied`. It refuses edited, removed or reordered applied history. Failed DDL and its ledger entry roll back together. The existing outer BEGIN/COMMIT envelope is supported; do not embed additional transaction-control statements in migration bodies. The exact deployment ledger is exempt from owner RLS only while the application role has no schema or table access. All other tables remain subject to the coverage guard.

0001_foundation.sql creates the NOLOGIN unai_app authorization role. Provision a separate application login through the deployment secrets manager and grant it unai_app; never give it SUPERUSER, BYPASSRLS, table ownership or migration credentials. Do not grant application access to the migration principal. The CLI runs ownership validation after migrations. No migration has been run against an external deployment during this work; all database tests use disposable containers.

The narrowly scoped SECURITY DEFINER membership function is owned by the privileged migration principal, has a fixed search path and performs no dynamic SQL. It evaluates active membership, user disablement and owner deletion. PostgreSQL RLS independently enforces actor and owner boundaries, while withOwnerTransaction performs an explicit membership check. Actor identity must come from authenticated session verification, never from JSON or an unverified header.

createDatabasePool requires a CA and verifies the database TLS certificate. SQL request context is transaction-local. Await every operation inside the transaction callback; transaction query and audit capabilities refuse use after callback completion. Returned database errors must be mapped to stable public error codes by API composition, never exposed or logged verbatim.

Production deployment still needs provisioned TLS, encrypted database volumes/backups, an encrypted S3-compatible bucket and encryption evidence. The disposable test database uses local plaintext transport and memory-backed storage; it is not production encryption evidence. CRT-SEC-08-A is not yet satisfied for a deployed application.

The Fastify boundary checks the actual socket for TLS and ignores forwarded-protocol claims. Before body parsing it verifies an actor through the injected session verifier, validates `x-owner-scope-id`, `x-purpose` and `x-correlation-id`, and invokes the owner/purpose authorization port. Writes require a bounded `idempotency-key`; endpoint transaction services must still implement durable replay handling. A header alone is not idempotency. Handlers must use `withOwnerTransaction` for independent RLS/application enforcement and audit material operations. Errors use fixed codes, private responses are not cacheable, and logs contain only correlation ID, status and duration. Tests include real certificate-verified HTTPS; no production authentication provider is configured.

The S3 adapter checks bucket default SSE-KMS encryption at initialization and explicitly requests the configured key on uploads. It verifies encryption receipts on reads and writes. Its resolver must authorize actor, owner, purpose and operation against canonical evidence metadata before returning a private storage key. Upload receipts contain only a public UUID; provider errors never expose raw keys. Deployment credentials use the SDK credential chain and must come from the secrets/identity system. Configure a bucket policy that denies insecure transport and incorrect encryption keys. Use the same canonical KMS key identifier in configuration, bucket settings and responses. Evidence-service resolver composition and real bucket verification remain outstanding. SDK mocks occur only in tests; those tests are not encryption-at-rest deployment evidence.

The S3 read lifecycle correction (ADR 0007) closes Node response streams after
encryption receipt rejection, body-read failure, or successful consumption. Two
regressions using real Node Readable bodies and test-only SDK stubs failed on
undestroyed streams before the fix, then passed. The full suite subsequently
passed 166 tests in 15 files and type checking exited 0 on 2026-09-14. Registry
validation still exited 1 with REGISTRY_RELEASE_MISSING. This correction adds
no screen or entity and does not establish deployed encryption evidence.

## Audit and observability

withOwnerTransaction supplies a bounded append-only audit method. Successful material work and its audit receipt should use the same transaction. Rollback removes both. The application role cannot UPDATE, DELETE or TRUNCATE audit_events. Audit references contain public UUIDs and field names, not evidence content or object storage keys; Zod rejects extra properties.

Failed/refused work needs a separately authorized audit transaction after rollback. Callers must explicitly audit material operations; coverage is not automatic. Cross-owner refusals require a product-approved audit ownership policy before API composition.

The PostgreSQL adapter emits OpenTelemetry spans with owner scope, purpose, correlation ID, code version and outcome, plus transaction-duration metrics. The API boundary emits response spans, request-duration metrics and allowlisted structured response records through its log sink. Both exclude error details and payloads. Deployment must supply the OpenTelemetry SDK/exporter and log sink. These primitives do not establish whole-system audit or trace coverage.

The owner transaction adapter now verifies PostgreSQL's COMMIT command tag before
returning a successful result or emitting success telemetry (ADR 0006, recorded
before the code change). PostgreSQL can return ROLLBACK without throwing when the
callback catches an earlier SQL error. That case now raises
TRANSACTION_NOT_COMMITTED. A real database regression first reproduced the false
success, then passed after the fix; it also checks audit rollback and reuse of
the connection for a different owner. This increment adds no entity or screen.

## Product authority needed

Design v1 explicitly leaves sign-in method and session model unspecified, and does not decide whether phones use responsive web. Product authority has been asked for the provider/method, session issuance/expiry/revocation policy and phone delivery choice. No answer was available during this work. No authentication ceremony or native-mobile scope was invented.

Remaining delivery includes the product decision ADR, Next.js shell/common navigation, session-provider/application composition, all sign-in/device states, evidence-service storage authorization composition, verified production database/bucket encryption, the real canonical registry release and semantic/corpus gates. No screen is implemented. Passing the current full test suite does not imply these requirements are implemented.

