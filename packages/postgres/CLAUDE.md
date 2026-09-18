# packages/postgres

`@unai/postgres` owns the only sanctioned path to PostgreSQL: the TLS-pinned pool, the owner transaction, the migration runner and the ownership-coverage check. It must not own feature SQL (queries live in the consuming package and run through `tx.query`), HTTP concerns or secret resolution; its only dependencies are `pg`, `@opentelemetry/api` and `@unai/domain`.

## Surface and consumers

- `createDatabasePool(url, ca)` is called by `packages/api/src/server.ts`, `apps/web/lib/server.ts`, `packages/registry/src/cli.ts` and `migrate-cli.ts`. No production code constructs `new Pool` itself; only tests and `scripts/test.mjs` do, because the disposable test server has no TLS.
- `withOwnerTransaction` and the `OwnerTransaction` type are consumed by `@unai/api` (`platform.ts`, `evidence.ts`, `ops.ts`) and `@unai/jobs`.
- `runMigrations` is imported by every database-backed test file, and `scripts/test.mjs` imports `src/migrations.ts` by path, so that file must stay loadable without `index.ts`.
- `assertOwnershipCoverage` runs only in `migrate-cli.ts` and `isolation.test.ts`; `OWNER_SCOPED_TABLES` is exported solely to drive that test.

## Invariants a change must keep

- `createDatabasePool` refuses any query string at all (not only `sslmode`), a non-postgres protocol or a blank CA with `DATABASE_TLS_CONFIG_INVALID`, and always pins `rejectUnauthorized:true`. Connection options therefore cannot travel in the URL; change the `Pool` literal instead. The last test in `isolation.test.ts` covers this.
- `withOwnerTransaction` parses its input with the strict `requestContextSchema`, so an extra key throws before a connection is taken. It sets exactly four settings. The `unai.data_purpose` and `unai.maximum_sensitivity` settings that the evidence policies read are set by the caller inside the transaction (`packages/api/src/evidence.ts`), always with `set_config(..., true)` so nothing survives on a pooled connection ("clears transaction context on a reused application connection").
- The `tx` object is frozen, and `query` and `audit` throw `TRANSACTION_CLOSED` once the callback has returned. `tx.audit` takes owner, actor, purpose and correlation id from the context, never from the event.
- Callback errors, including raw `pg` errors, are rethrown unchanged, so callers map them to stable codes. The span gets the fixed message `DATABASE_OPERATION_FAILED`; never add `recordException`. A callback that swallows a SQL error and returns normally still fails with `TRANSACTION_NOT_COMMITTED` (ADR 0006).
- The unsafe-role check reads both `current_user` and `session_user` plus table ownership, so an admin pool is refused with `DATABASE_ROLE_UNSAFE` even in tests. A test needs its own LOGIN role granted `unai_app`.
- `runMigrations` wants a dedicated privileged pool. It holds session advisory lock `(1970170217, 1)`, sets `statement_timeout='30s'` and destroys its client with `release(true)`. It reduces a failing file to `MIGRATION_FAILED:<file>` and drops the PostgreSQL text on purpose; to see the real error, run the file with `psql` against a throwaway database. Errors before the first file (connect, lock, ledger bootstrap) are not wrapped and propagate as raw `pg` errors.
- `assertOwnershipCoverage` compares exact counts. Every table outside the system schemas must be in `public` and classified; the sole exemption is `unai_migrations.applied`, and only while `unai_app` has no privilege on that schema or table (ADR 0004).

## Checklist: the TypeScript half of a new table

1. Add `[table, ownerColumn]` to `classifiedTables` in `ownership.ts` (`'id'` only for `users` and `owner_scopes`; the column must exist). A table the application must never reach goes into `globalReferenceTables` instead and needs forced RLS, no policy and no `unai_app` privilege.
2. In `isolation.test.ts`, insert a row for both owners inside the `beforeAll` loop (through the admin pool), and add the table to the `readUnfiltered` loop, or give it a dedicated test when its policy gates on purpose, as `jobs` has.
3. Bump the literal `15` in "forces RLS on all application tables"; it counts every `public` table, global ones included.
4. The second CRT-SEC-01-A test ("covers every classified owner-scoped table ...") requires three sets to be equal: tables on which `unai_app` holds SELECT for at least one column, `OWNER_SCOPED_TABLES`, and the tables recorded in `unfiltered`. A classified table without a SELECT grant therefore fails. The `unfiltered` set is filled by the earlier tests, so running that test alone with `-t` fails.

## Running these tests

No test here is pure. Export `UNAI_TEST_DATABASE_URL` for a throwaway pgvector server and run `pnpm exec vitest run packages/postgres` from the repo root: the files resolve `migrations` and `packages/postgres/src/migrate-cli.ts` relative to the working directory, and `isolation.test.ts` and `auth.test.ts` call `runMigrations` themselves in `beforeAll`, so the server need not be migrated beforehand. The login must be a superuser (the harness uses `postgres`), because the files create databases (`migrations.test.ts` creates and drops one per test), create cluster roles, insert fixtures past forced RLS and `SET LOCAL ROLE unai_app`. No `UNAI_TEST_S3_*` variables are needed. `auth.test.ts` lacks the harness guard: without the variable its `Pool` falls back to the `pg` defaults (`PG*` variables, localhost), which normally ends in a connection error instead of the hint.

## Traps

- Test files run in parallel against one shared database (`vitest.config.ts` does not disable file parallelism). Fixtures use random UUIDs, assertions check that every returned row belongs to owner A rather than exact row counts, each file creates its own LOGIN role only when absent, and the registry-weakening test keeps its `GRANT`/`ALTER` uncommitted on one connection.
- `migrate-cli.ts` reads `UNAI_MIGRATION_DATABASE_URL` and `UNAI_DATABASE_CA_PATH` straight from `process.env` (no `secret://` handles), whereas the runtime services read the CA from `UNAI_DATABASE_CA_FILE`. It passes the relative path `migrations`, so it runs from the repo root. Missing variables throw `MIGRATION_TLS_CONFIGURATION_REQUIRED`, and an unreadable CA file or a URL that `createDatabasePool` rejects also throws uncaught. Any failure of the migration run or the coverage check prints only `MIGRATION_OR_OWNERSHIP_VALIDATION_FAILED` and exits 1. `migrations.test.ts` spawns it under plain `tsx` and asserts there is no `ERR_MODULE_NOT_FOUND`.
- The `BEGIN;`/`COMMIT;` stripping in `runMigrations` exists only for `0001_foundation.sql`; do not widen it.
