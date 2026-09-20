# Disposable runtime implementation plan

**Goal:** Deliver the initial disposable `pnpm dev:stack` runtime and its five assigned criteria.
**Architecture:** Establish `DisposableStackResources` before allocation; register cleanup before each resource can exist. Reuse the test runner's PostgreSQL image/provisioning primitive and the TLS/encrypted storage helpers. Runtime children receive mounted secret handles and protected TLS paths.
**Tech Stack:** Node ESM, Docker PostgreSQL/pgvector, existing TLS/S3 helpers, Vitest.

1. Add `src/dev-stack.test.ts`: refusal before allocation; reverse cleanup and retry; real owned TLS PostgreSQL and encrypted object roundtrip; runtime handle resolution; normal exit, Ctrl+C, API/web crashes and partial starts preserve unrelated resources. Run focused Vitest and observe missing-runtime failure.
2. Extract the PostgreSQL provisioning primitive from `scripts/test.mjs` into `scripts/postgres-harness.mjs`, retaining one image literal and using the primitive from both runners. Add an explicit private local mode to `scripts/storage-harness.mjs` that reuses `scripts/s3-object-server.mjs` and registers service ownership before listening.
3. Add `scripts/disposable-stack-resources.mjs`, `scripts/dev-stack.mjs`, and `scripts/dev-stack-child.mjs`. Refuse database selectors before filesystem/Docker access; protect temporary files with POSIX permissions or Windows ACLs; supervise startup and child termination; verify cleanup and print only stable codes.
4. Add `dev:stack` to `package.json`. Document the runtime's provisional child boundary, encryption declaration and exact assigned acceptance statements in `docs/disposable-runtime.md`.
5. Run focused lifecycle tests, inspect the diff for ownership races and secret disclosure, then run the required `pnpm test` to completion. Submit the actual result through the offered review command and release the claim.

No migrations, fixture seeding, session bootstrap or assembled-product verification is claimed here; the sealed plan assigns those downstream. No checks are removed or weakened.
