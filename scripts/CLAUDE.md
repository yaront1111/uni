# scripts

This folder owns the `pnpm test` harness (`test.mjs` plus its storage and TLS helpers), the manual `verifier-rehearsal.mjs` diagnostic, `install-git-hooks.mjs`, the other tools that root `package.json` scripts name, and `lib/`, which holds libraries shared by the harness and the operator tools (`lib/backup-archive.mjs`). It must not own product code or test cases. Nothing under `packages/` or `apps/` imports from here. Under `src/`, tests import scripts to unit-test them (`src/recovery-output.test.ts`, `src/recovery-storage.test.ts`, `src/backup-archive.test.ts` and others), behind `// @ts-expect-error`, and `src/operations/report.ts` shares `workspace-evidence.mjs`.

`install-git-hooks.mjs` runs on every `pnpm install` (the `prepare` script), so it must never fail an install: it sets `core.hooksPath=.githooks` only inside a Git work tree that has `.githooks/pre-commit` and only when no other hooks path is configured, and otherwise prints why it did nothing and exits 0. The hook it activates refuses commits under `corpus/private-local/` (ADR 0031 §3).

## Conventions a change must keep

- Everything is plain `.mjs`, outside both the `tsconfig.json` `include` and the `vitest.config.ts` `include`. Nothing here is typechecked, and only what a `src/*.test.ts` imports is unit-tested, so `pnpm typecheck` will not notice a broken call. `test.mjs` imports `runMigrations(pool, directory): Promise<string[]>` straight from `packages/postgres/src/migrations.ts` (through a temporary `tsx/esm/api` `register()`); a change to that signature or path surfaces only as a runtime failure of `pnpm test`.
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

## lib/backup-archive.mjs

Format `uai-backup/1`, the one archive format of the recovery rehearsal, the backup CLI and the restore. It uses `node:` built-ins only, never logs, and every thrown message is a bare code. An archive file is a 34-byte header, then AES-256-GCM ciphertext, then the 16-byte tag. The header is:

| Bytes | Content |
| --- | --- |
| 0-4 | ASCII `UAIBK` |
| 5 | version `0x01` |
| 6-17 | random 12-byte IV |
| 18-29 | key check: the first 12 bytes of HMAC-SHA256(key, utf8 `uai-backup/1 key-check` + IV) |
| 30-33 | header checksum: the first 4 bytes of SHA-256(bytes 0-29) |

All 34 header bytes are the GCM AAD, and the key is exactly 32 bytes. The reader checks, in order: size at least 50, magic and version, header checksum, key check, and the tag (read from the end first, verified after the last byte). A flipped header byte therefore fails as integrity, and only a well-formed header under another key fails `BACKUP_KEY_INVALID`. The task description had proposed a 16-byte key check; it was split into 12 + 4 so that those two failures stay distinct.

The plaintext is a POSIX ustar stream written in process: no tar binary, no dependency, no plaintext temp file.
- Entries are regular files (typeflag `0`). A name is segments of `[A-Za-z0-9._-]` joined by `/`, at most 100 bytes, with no `.` or `..` segment; the prefix field is unused.
- Each header has mode `0000600`, uid, gid and mtime 0, the size as 11 octal digits plus NUL (at most 8 GiB - 1), and the checksum as 6 octal digits, NUL, space. Magic is `ustar\0`, version `00`.
- Data is zero-padded to 512 bytes. The stream ends with two zero blocks, and nothing may follow them.
- Plaintext over 2^36 - 32 bytes, the GCM limit, is refused.

Entry order:
1. `manifest.json`: format, createdAt, tables, and `objects: [{entry, key, sha256}]`, because object keys can reach 1024 bytes.
2. `database.dump.000000` onward: parts of at most `DUMP_PART_BYTES` (64 MiB), since pg_dump's size is not known in advance.
3. `objects/000000` onward.

Archive names are `uai-backup-<YYYYMMDDTHHMMSSZ>.tar.enc` in UTC (`archiveName(date)`, `ARCHIVE_NAME`), with the sidecars `<name>.sha256` and `<name>.manifest.json`.

API and codes:
- `await createArchiveWriter(path, key)` resolves `{add(name, bytes), finish(), abort()}`. The key is used only inside this call, so the caller may zero it afterwards.
  - It opens `<path>.partial` exclusively with mode 0600. Calls run in order through an internal chain, and memory is bounded by one entry.
  - `finish` fsyncs, hard-links the partial to `path`, unlinks the partial, fsyncs the directory, and resolves `{sha256, bytes, entries}`.
  - `abort` is idempotent and never removes a published archive.
  - Codes: `BACKUP_KEY_INVALID`, `BACKUP_ARCHIVE_EXISTS` (target or partial exists, or a target appeared before the link), `BACKUP_ARCHIVE_ENTRY_INVALID`, `BACKUP_ARCHIVE_TOO_LARGE`, `BACKUP_ARCHIVE_WRITER_CLOSED`, `BACKUP_ARCHIVE_WRITE_FAILED`.
- `readArchive(path, key, onEntry)` awaits `onEntry({name, size, bytes})` once per entry, in order, and resolves `{sha256, entries}` only after the tag verifies.
  - Everything delivered before it resolves is untrusted. A restore collects or verifies first and applies only after resolution; the rehearsal does this.
  - Codes: `BACKUP_KEY_INVALID`, `BACKUP_ARCHIVE_INTEGRITY_FAILED` (envelope, tag, tar or truncation), `BACKUP_ARCHIVE_UNREADABLE` (open, stat or read I/O, or a non-regular file). An error thrown by `onEntry` is rethrown unchanged.
- `verifyArchive(path, key)` makes the same pass and discards the plaintext.
- `readBackupKey(path, {outside})` resolves the 32-byte Buffer, which the caller zero-fills.
  - `BACKUP_KEY_LOCATION_INVALID` unless the path is a regular file, not a symlink. It is opened with `O_NOFOLLOW`, and the inode is re-checked.
  - `BACKUP_KEY_LOCATION_INVALID` on POSIX if any group or other mode bit is set. Windows has no POSIX mode and relies on ACLs, so that check is skipped there.
  - `BACKUP_KEY_LOCATION_INVALID` if the realpath lies inside an `outside` directory. Each `outside` directory is compared both as given and resolved.
  - `BACKUP_KEY_INVALID` unless it holds exactly 32 bytes.
- `pruneArchives(directory, days, now)` resolves the removed archive names, sorted.
  - It removes a regular-file `ARCHIVE_NAME` match whose name time is older than `days` whole days: sidecars first, then the archive.
  - It never reads mtime, never removes the newest archive, never follows a symlink and never touches any other name.
  - Codes: `BACKUP_RETENTION_INVALID` (`days` not an integer of at least 1), `BACKUP_RETENTION_FAILED`.
- `tableDigests(client)` returns `[{table, digest, rows}]` for public and unai_private.
  - Each table is hashed as `'[' + rows joined by ', ' + ']'`, with each row as `to_jsonb(t)::text` in text order. Those are exactly the bytes the old `jsonb_agg` formula produced, so old reports stay comparable.
  - Rows are streamed through a server-side cursor (`FETCH FORWARD 1000`), because a single jsonb value is capped at 255 MB. The client must therefore be inside an open transaction: DECLARE fails outside one.

Changing the format:
1. Bump the version byte.
2. Keep a reader for version 1.
3. Update the independent sealer, unsealer and ustar parser in `src/backup-archive.test.ts`, which re-implement the layout above rather than calling the library.
4. Run `pnpm exec vitest run src/backup-archive.test.ts`.

## database-roundtrip.mjs (the recovery rehearsal)

`test.mjs` calls it only after a fully green, unstaged suite. The rehearsal:
1. Digests every table inside a REPEATABLE READ, READ ONLY transaction. Once on the source, it also recomputes the old `jsonb_agg` formula and requires equal digests (`BACKUP_TABLE_DIGEST_MISMATCH`).
2. Writes `test-results/operations/coordinated-backup.tar.enc` through the writer (manifest, dump parts, objects) and keeps the key in a 0600 temp file outside `test-results/`.
3. Recovers the key with `readBackupKey`. It then proves that a random key is refused with `BACKUP_KEY_INVALID`, and that a copy with one flipped ciphertext byte is refused with `BACKUP_ARCHIVE_INTEGRITY_FAILED` (else `RECOVERY_NEGATIVE_CHECK_FAILED`).
4. Reads the archive back only through `readArchive`, and feeds `pg_restore` and `restoreObjects` only after it resolves.
5. Writes `test-results/operations/coordinated-roundtrip.json` in format `unai-coordinated-roundtrip/2`, with `archiveFormat: 'uai-backup/1'`, `wrongKeyRefused` and `tamperRefused`.

Its consumers are `src/operations/evidence.ts` (`recoveryEvidence` accepts only that format) and `src/operations/report.ts` (expects that `archiveRef` and re-hashes the archive). Change all three together.

## verifier-rehearsal.mjs

This script reproduces how the moe-next daemon verifier provisions its database; the daemon sources named in its header are not in this repo. It starts pgvector with the superuser `app`, mints a certificate with `openssl` inside the container, enables TLS through `ALTER SYSTEM` and `pg_reload_conf()`, and delivers a `postgres://` URL as `DATABASE_URL` and `UNAI_MIGRATION_DATABASE_URL` plus the CA path as `UNAI_DATABASE_CA_PATH` (names overridable with `MOE_VERIFIER_DB_URL_VARS`, `MOE_VERIFIER_DB_CA_VAR`, `MOE_VERIFIER_DB_IMAGE`). It removes `UNAI_TEST_DATABASE_URL` from the child environment, then runs its arguments as shell commands, or `pnpm db:migrate` followed by `pnpm test`, stopping at the first non-zero exit. `pnpm test` therefore takes the delivered-server path there. It needs Docker, and neither `pnpm test` nor CI runs it.

## Checking a change

Only the helpers a `src/*.test.ts` imports have unit tests: `pnpm exec vitest run src/backup-archive.test.ts` needs neither Docker nor a database. The full check is `pnpm test` from the repo root, which also runs the recovery rehearsal. Two smoke checks need neither Docker nor a database:

```
node -e "import('./scripts/s3-object-server.mjs').then(async m=>{const s=await m.startS3ObjectServer({bucket:'b',kmsKeyId:'k'});console.log(s.endpoint);s.close()})"
node -e "import('./scripts/tls-certificate.mjs').then(m=>console.log(new (require('node:crypto').X509Certificate)(m.createSelfSignedCertificate().certificate).subjectAltName))"
```
