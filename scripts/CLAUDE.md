# scripts

This folder owns the `pnpm test` harness (`test.mjs` plus its storage and TLS helpers), the manual `verifier-rehearsal.mjs` diagnostic and `install-git-hooks.mjs`. It must not own product code or test cases: nothing under `packages/`, `apps/` or `src/` imports from here, and the only entry points are the `test`, `prepare` and `hooks:install` scripts in the root `package.json` and `node scripts/verifier-rehearsal.mjs`.

`install-git-hooks.mjs` runs on every `pnpm install` (the `prepare` script), so it must never fail an install: it sets `core.hooksPath=.githooks` only inside a Git work tree that has `.githooks/pre-commit` and only when no other hooks path is configured, and otherwise prints why it did nothing and exits 0. The hook it activates refuses commits under `corpus/private-local/` (ADR 0027 §3).

## Conventions a change must keep

- Everything is plain `.mjs`, outside both the `tsconfig.json` `include` and the `vitest.config.ts` `include`. Nothing here is typechecked or unit-tested, so `pnpm typecheck` will not notice a broken call. `test.mjs` imports `runMigrations(pool, directory): Promise<string[]>` straight from `packages/postgres/src/migrations.ts` (through a temporary `tsx/esm/api` `register()`); a change to that signature or path surfaces only as a runtime failure of `pnpm test`.
- The root manifest declares neither `pg` nor `@aws-sdk/client-s3`, and pnpm does not hoist them, so a bare import fails. Scripts load them with `createRequire` anchored on `packages/postgres/package.json` and `packages/storage/package.json`; `packages/api/src/reference-stack.test.ts` keeps those two dependencies declared there.
- A storage backend is an object `{description, env, close()}`. `test.mjs` spreads `env` over `process.env` for the vitest child and calls `close()` synchronously in `finally`, so `close` must not return a promise that matters.
- `test.mjs` spawns vitest with `spawn`, never `spawnSync`: the in-process S3 server lives on this process's event loop and must keep answering while the suite runs. The vitest path is relative to the working directory, so the harness only works from the repo root.
- Both harness images (pgvector in `test.mjs`, MinIO in `storage-harness.mjs`) are pinned by `sha256` digest, published on `127.0.0.1` with a random port, run with `--rm` and tmpfs data. `verifier-rehearsal.mjs` deliberately uses the floating `pgvector/pgvector:pg17` tag instead.

## Step order and failure codes

The order in `test.mjs` is fixed: database, readiness probe, migrations, storage, vitest, cleanup. Database and migrations run before any storage backend starts so that a storage problem is never reported as a database or migration failure.

- Steps throw `StepError` and print `<STEP>: <cause>`: `DATABASE_PROVISIONING_FAILED`, `DATABASE_NOT_READY` (120 `SELECT 1` probes with a 2 s connect timeout, 250 ms apart), `MIGRATION_FAILED`, `STORAGE_PROVISIONING_FAILED`. Any error without a `.step` prints as `TEST_HARNESS_FAILED`. A new step needs its own `StepError` name.
- Inner storage causes appear after `STORAGE_PROVISIONING_FAILED:`: `STORAGE_HARNESS_COMMAND_FAILED`, `STORAGE_HARNESS_NOT_READY`, `UNSAFE_TEST_CLEANUP`, and the "Delivered object storage is incomplete" message.
- A failing suite prints no harness code; the vitest exit code is passed through. `STORAGE_CLEANUP_FAILED` and `DATABASE_CLEANUP_FAILED` force exit 1, while `DATABASE_CLEANUP_WARNING` (a leaked scratch database) intentionally leaves the suite's verdict alone.
- Harness messages carry raw Docker and PostgreSQL error text. That is local to this disposable infrastructure; do not copy the pattern into `packages/`, where raw provider text is forbidden.

## Environment contract

- The delivered-server path is chosen by `UNAI_TEST_DATABASE_URL ?? DATABASE_URL`, so an ambient `DATABASE_URL` in the shell is enough to skip Docker and create a `unai_test_<hex>` database on that server. The scratch database exists so that immutable rows from an earlier run (the registry 0.1.0 snapshot) never decide a later run; if `CREATE DATABASE` is refused, the suite runs in the delivered database itself and says so.
- The vitest child always receives `UNAI_TEST_DATABASE_URL`. Test files derive their own logins by replacing the username and password on that URL, and they create databases and roles, so it must be a parseable URL for a login that may do both.
- Delivered storage needs all three of `UNAI_TEST_S3_ENDPOINT`, `UNAI_TEST_S3_BUCKET` and `UNAI_TEST_S3_KMS_KEY_ID`; a partial set throws instead of falling back. `deliveredStorage()` returns an empty `env`, so the runner's own `AWS_*` and `NODE_EXTRA_CA_CERTS` pass through untouched.
- The started backends export `NODE_EXTRA_CA_CERTS`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, an empty `AWS_SESSION_TOKEN` (overriding any ambient one) and the three `UNAI_TEST_S3_*` values. `createEncryptedS3Store` accepts no CA or agent option, so `NODE_EXTRA_CA_CERTS` in the child environment is the only way the harness certificate reaches the production adapter; the file must exist until `close()`.
- Both backends publish the key as `arn:aws:kms:unai-test-key`. The adapter compares the bucket rule and every read/write receipt with the configured id by exact string, so the MinIO key name, the bucket rule and the exported variable must change together.

## Storage backends

`startStorageHarness()` chooses by `docker version` alone: MinIO when a daemon answers, otherwise `startS3ObjectServer`. There is no variable to force the in-process server, so on a machine with Docker (and in CI) it is never exercised by `pnpm test`.

`s3-object-server.mjs` serves only what `packages/storage/src/index.ts` sends: `GetBucketEncryption`, `PutObject` (400 without the matching SSE-KMS headers, 412 for `If-None-Match: *` on an existing key) and `GetObject`; it also answers `HEAD`, which the adapter never sends. Every other method, and any query parameter other than `x-id`, answers 501 `NotImplemented`. It checks the access key in the SigV4 credential, the presence of `x-amz-date` and, when `x-amz-content-sha256` is a hex digest, that it matches the body, but does not recompute the signature; it decodes `STREAMING-*` aws-chunked bodies and keeps objects AES-256-GCM envelope-encrypted in memory.

Checklist when `@unai/storage` starts using another S3 operation: add the route to `s3-object-server.mjs` and return the `x-amz-server-side-encryption` receipt headers the adapter verifies. Otherwise the suite passes on MinIO and fails with 501 only on a runner without Docker.

`temporaryDirectory().remove()` deletes only a direct child of `os.tmpdir()` whose name starts with `unai-s3-`; keep the `mkdtempSync` prefix and that guard in step. The MinIO mount uses the file names `private.key` and `public.crt` that `--certs-dir` expects.

## TLS certificate

`tls-certificate.mjs` builds the certificate in process from hand-written DER: ECDSA P-256, `CN=localhost`, SAN `DNS:localhost` and `IP:127.0.0.1`, critical `CA:TRUE`, valid from one hour ago for one day. No host `openssl` is used in this folder, whatever `docs/evidence-runtime.md` says; the host OpenSSL prerequisite comes from `packages/api/src/index.test.ts`. Endpoints are `https://127.0.0.1:<port>`, so the IP SAN is what verification matches.

## verifier-rehearsal.mjs

This script reproduces how the moe-next daemon verifier provisions its database; the daemon sources named in its header are not in this repo. It starts pgvector with the superuser `app`, mints a certificate with `openssl` inside the container, enables TLS through `ALTER SYSTEM` and `pg_reload_conf()`, and delivers a `postgres://` URL as `DATABASE_URL` and `UNAI_MIGRATION_DATABASE_URL` plus the CA path as `UNAI_DATABASE_CA_PATH` (names overridable with `MOE_VERIFIER_DB_URL_VARS`, `MOE_VERIFIER_DB_CA_VAR`, `MOE_VERIFIER_DB_IMAGE`). It removes `UNAI_TEST_DATABASE_URL` from the child environment, then runs its arguments as shell commands, or `pnpm db:migrate` followed by `pnpm test`, stopping at the first non-zero exit. `pnpm test` therefore takes the delivered-server path there. It needs Docker, and neither `pnpm test` nor CI runs it.

## Checking a change

There are no tests for this folder. The full check is `pnpm test` from the repo root. Two smoke checks need neither Docker nor a database:

```
node -e "import('./scripts/s3-object-server.mjs').then(async m=>{const s=await m.startS3ObjectServer({bucket:'b',kmsKeyId:'k'});console.log(s.endpoint);s.close()})"
node -e "import('./scripts/tls-certificate.mjs').then(m=>console.log(new (require('node:crypto').X509Certificate)(m.createSelfSignedCertificate().certificate).subjectAltName))"
```
