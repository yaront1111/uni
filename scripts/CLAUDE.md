# scripts

This folder owns the `pnpm test` harness (`test.mjs` plus its storage and TLS helpers), the manual `verifier-rehearsal.mjs` diagnostic, `install-git-hooks.mjs`, `pnpm backup` (`backup.mjs`), `pnpm restore` (`restore.mjs`), the other tools that root `package.json` scripts name, and `lib/`, which holds libraries shared by the harness and the operator tools (`lib/backup-archive.mjs`). It must not own product code or test cases. Nothing under `packages/` or `apps/` imports from here. Under `src/`, tests import scripts to unit-test them (`src/recovery-output.test.ts`, `src/recovery-storage.test.ts`, `src/backup-archive.test.ts` and others), behind `// @ts-expect-error`, and `src/operations/report.ts` shares `workspace-evidence.mjs`.

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
- Harness messages carry raw Docker and PostgreSQL error text. That is local to this disposable infrastructure; do not copy the pattern into `packages/`, where raw provider text is forbidden. `backup.mjs` and `restore.mjs` are the tools here that run against real infrastructure, so they follow the product rules instead (stable codes only, see below).

## Environment contract

- The delivered-server path is chosen by `UNAI_TEST_DATABASE_URL ?? DATABASE_URL`, so an ambient `DATABASE_URL` in the shell is enough to skip Docker and create a `unai_test_<hex>` database on that server. The scratch database exists so that immutable rows from an earlier run (the registry 0.1.0 snapshot) never decide a later run; if `CREATE DATABASE` is refused, the suite runs in the delivered database itself and says so.
- The vitest child always receives `UNAI_TEST_DATABASE_URL`. Test files derive their own logins by replacing the username and password on that URL, and they create databases and roles, so it must be a parseable URL for a login that may do both.
- Delivered storage needs all three of `UNAI_TEST_S3_ENDPOINT`, `UNAI_TEST_S3_BUCKET` and `UNAI_TEST_S3_KMS_KEY_ID`; a partial set throws instead of falling back. `deliveredStorage()` returns an empty `env`, so the runner's own `AWS_*` and `NODE_EXTRA_CA_CERTS` pass through untouched.
- The started backends export `NODE_EXTRA_CA_CERTS`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, an empty `AWS_SESSION_TOKEN` (overriding any ambient one) and the three `UNAI_TEST_S3_*` values. `createEncryptedS3Store` accepts no CA or agent option, so `NODE_EXTRA_CA_CERTS` in the child environment is the only way the harness certificate reaches the production adapter; the file must exist until `close()`.
- Both backends publish the key as `arn:aws:kms:unai-test-key`. The adapter compares the bucket rule and every read/write receipt with the configured id by exact string, so the MinIO key name, the bucket rule and the exported variable must change together.

## Worker start under load (DrvFs checkouts)

- **Symptom.** `[vitest-pool]: Failed to start forks worker for test files <file>`, caused by `[vitest-pool-runner]: Timeout waiting for worker to respond`, under "Unhandled Errors". The file is missing from the Test Files count (44 of 47 on 2026-11-02) and from the JSON report's `testResults`, and vitest exits 1, which the harness passes through. `numTotalTestSuites` counts describe blocks, so count files with `testResults.length`.
- **Cause.** vitest 4.1.11's pool runner gives every fork a fixed `START_TIMEOUT = 6e4` (and `STOP_TIMEOUT`), `node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:2861-2862`, used through `withTimeout` at `:2973`. It covers the fork spawn, the worker's static imports and `setupBaseEnvironment` (jsdom for `apps/web/components`). No option reaches it: this repro still fails at 60.04 s with `--testTimeout=600000 --hookTimeout=600000`. Only forked children have `process.send`, so the main process is not stalled:
  `d=$(mktemp -d); printf 'if (process.send) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 61000);\n' > "$d/slow-fork.cjs"; NODE_OPTIONS="--require $d/slow-fork.cjs" node node_modules/vitest/vitest.mjs run src/kernel/clock.test.ts --testTimeout=600000 --hookTimeout=600000`
- **Evidence.** Three unit-stage runs on /mnt/d at `--maxWorkers=4` on 2026-11-02, host load about 30 on 16 cores: over the 47 files, environment setup took 140-188 s and imports 206-332 s in total. One run lost `Talk`, `MemoryActionsInteractions` and `ProposalInbox` to the timer. All three also ended `WORKSPACE_CHANGED_DURING_TEST` because other sessions edited the shared checkout, so none recorded `<report>.provenance.json` with `exitCode` 0.
- **Mitigations.** (1) Preferred: run the harness from a clone on the native Linux filesystem (WSL home or `/tmp`, not `/mnt/<drive>`): this avoids the DrvFs cold-start cost and keeps concurrent edits out of the evidence tree. (2) On a DrvFs checkout, set `UNAI_TEST_MAX_WORKERS=2` (or 1; accepted 1-64, default 4, anything else is `TEST_MAX_WORKERS_INVALID` before any provisioning). Fewer forks cold-start at once; this lowers the risk without removing it and lengthens the run.
- **Not a fix.** Raising `testTimeout`, `hookTimeout` or `teardownTimeout` does not help this failure (measured by the repro above), so do not answer it with a `vitest.config.ts` timeout.

## Storage backends

`startStorageHarness()` chooses by `docker version` alone: MinIO when a daemon answers, otherwise `startS3ObjectServer`. There is no variable to force the in-process server, so on a machine with Docker (and in CI) it is never exercised by `pnpm test`.

`s3-object-server.mjs` serves what `packages/storage/src/index.ts`, the recovery rehearsal, `backup.mjs` and `restore.mjs` send: `GetBucketEncryption`, `ListObjectsV2` (unpaged, and it ignores `Prefix`: every key comes back, so a caller filters by prefix itself, as `restore.mjs`'s `keysUnder` does), `PutObject` (400 without the matching SSE-KMS headers, 412 for `If-None-Match: *` on an existing key), `GetObject`, `HeadObject` and `DeleteObject`, plus multipart upload: `CreateMultipartUpload` (the PutObject SSE rule), `UploadPart` (404 `NoSuchUpload`, 400 for a part number outside 1-10000), `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` below 5 MiB for any part but the last, 412 for `If-None-Match: *`) and `AbortMultipartUpload` (204). Every other operation, and any other query parameter besides `x-id`, answers 501 `NotImplemented`. Options: `credentials` replaces the random access key pair, so a second server can accept the pair the SDK default chain already holds; `commonName` gives its certificate a subject of its own, because OpenSSL picks a trust anchor by subject and two `CN=localhost` certificates in one `NODE_EXTRA_CA_CERTS` bundle cannot both verify; `logOperations` records each request's operation name in the returned `operations` (opt-in, so the dev stack's long-lived server keeps no log). It also returns `receiptOverrides`, a mutable map from operation name to the key id its receipt names (tests only, empty by default), and a `pendingUploads` getter. It checks the access key in the SigV4 credential, the presence of `x-amz-date` and, when `x-amz-content-sha256` is a hex digest, that it matches the body, but does not recompute the signature; it decodes `STREAMING-*` aws-chunked bodies and keeps objects AES-256-GCM envelope-encrypted in memory.

Checklist when `@unai/storage` starts using another S3 operation: add the route to `s3-object-server.mjs` and return the `x-amz-server-side-encryption` receipt headers the adapter verifies. Otherwise the suite passes on MinIO and fails with 501 only on a runner without Docker.

`temporaryDirectory().remove()` deletes only a direct child of `os.tmpdir()` whose name starts with `unai-s3-`; keep the `mkdtempSync` prefix and that guard in step. The MinIO mount uses the file names `private.key` and `public.crt` that `--certs-dir` expects.

## TLS certificate

`tls-certificate.mjs` builds the certificate in process from hand-written DER: ECDSA P-256, `CN=localhost` (or the optional `commonName`), SAN `DNS:localhost` and `IP:127.0.0.1`, critical `CA:TRUE`, valid from one hour ago for one day. No host `openssl` is used in this folder, whatever `docs/evidence-runtime.md` says; the host OpenSSL prerequisite comes from `packages/api/src/index.test.ts`. Endpoints are `https://127.0.0.1:<port>`, so the IP SAN is what verification matches.

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

## backup.mjs (pnpm backup)

The production backup of ADR 0043 D9/D11; the operator procedure is `docs/operations/backup.md`, the variables are under `### pnpm backup` in `docs/operations/environment.md`.
- **Output contract.** Exactly one JSON line: `backup.completed` on stdout (exit 0) or `{"event":"backup.failed","code":"BACKUP_…"}` on stderr (exit 1; 2 for flags). Only `BACKUP_CONFIGURATION_REQUIRED`/`_INVALID` add `variable`. Foreign errors are mapped through `MAPPED` (storage and TLS codes) or become `BACKUP_FAILED`; raw text, URLs, paths, keys and object keys never reach the output. pg_dump's stderr is discarded unread, and `process.noDeprecation` silences pg's pgpass notice. `--help` reads no variable.
- **Configuration order** (`configuration()`), all before any network work: destination (absolute, real, writable; or the `s3://<bucket>/<prefix>/` grammar), for `s3://` the staging directory (absolute, real, writable, empty), key (`readBackupKey` with the destination or the staging directory as `outside`), retention (refused with `s3://`), URL (no password: `PGPASSFILE` only, `PGPASSWORD` refused), CA file, `UNAI_S3_*`, for `s3://` `backupBucketOf()` (https endpoint, region, a key that is no alias, then bucket and key inequality with the evidence bucket), `UNAI_BACKUP_PG_DUMP`. Every read stays a literal `process.env.NAME` for the env-contract guard; the pg_dump child's environment is an `Object.entries` filter (every `PG*` but `PGPASSFILE` dropped), so it reads no member.
- **Precondition.** `systemctl is-active` per unit must exit 3/4 **and** print `inactive`/`failed` (an `activating` restart loop is not stopped); `--assume-quiescent` skips only that. The `pg_stat_activity` check for `unai_api_login`/`unai_worker_login` always runs, then a superuser-or-BYPASSRLS check.
- **One exported snapshot.** The coordinator transaction is SERIALIZABLE READ ONLY DEFERRABLE with `row_security`, `statement_timeout` and `idle_in_transaction_session_timeout` off; it reads the digests, ledger, releases and evidence rows, and `pg_dump --snapshot=<id>` imports the same snapshot while the transaction idles. Do not move a manifest read outside it.
- **`UNAI_BACKUP_PG_DUMP`** is one path or a JSON argv prefix (the test passes `docker run … pg_dump`); its `--version` major must equal the server's.
- **Ordering of effects.** `state.archive` is set only after the writer's `finish` (the link-based publish), so a lost name race never deletes another run's archive; sidecars are `wx` 0600 `.partial` files renamed into place; retention runs last and only after success. A `BACKUP_RETENTION_FAILED` keeps the verified archive.
- **S3 destination.** The archive and sidecars are staged and verified as for a local directory, then `upload()` sends the archive, `.sha256` and `.manifest.json` (last) with SSE-KMS and `IfNoneMatch: '*'`; above `UPLOAD_PART_BYTES` (8 MiB) through `putParts()`. `state.upload` is set as soon as CreateMultipartUpload returns, before its receipt is checked, and cleared once Complete returns, so `cleanup()` aborts every unfinished upload (SIGTERM included). Every receipt goes through `sealed()` (`BACKUP_DESTINATION_ENCRYPTION_INVALID`), each file ends with a HeadObject size check, and one `send` wrapper maps 412 to `BACKUP_ARCHIVE_EXISTS` and anything else to `BACKUP_DESTINATION_UPLOAD_FAILED`. The staged files stay in `state` so `cleanup()` empties the staging directory. The script names no Delete or List command (a test scans the source). Its tests start a second `startS3ObjectServer` with the harness's `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` as `credentials`, its own `commonName`, and pass the harness CA plus that certificate as one `NODE_EXTRA_CA_CERTS` bundle to the spawned script; the block is skipped only when delivered storage exported no such pair.
- **Test** (`src/backup.test.ts`, stage `operations`). A scratch `unai_backup_<hex>` database is migrated; the harness PostgreSQL has no TLS, so the test runs an in-process TLS terminator with a `createSelfSignedCertificate` CA, and a 0600 pgpass for the password-less URL. pg_dump is the host's `/usr/lib/postgresql/<major>/bin/pg_dump`, else a PATH pg_dump of the server's major, else `docker run --network host` of `POSTGRES_IMAGE` with the temp root mounted read-only. A fake `systemctl` on `PATH` logs its arguments. The script is always spawned asynchronously, because the in-process S3 server lives on the test's event loop.

## restore.mjs (pnpm restore)

The production restore of ADR 0043 D9: one uai-backup/1 archive into an empty database and an empty prefix of an evidence bucket. The operator procedure is `docs/operations/restore.md`; the variables are under `### pnpm restore` in `docs/operations/environment.md`.
- **Output contract.** Exactly one JSON line: `{"event":"restore.completed","verdict":"PASS",…}` on stdout (exit 0) or `{"event":"restore.failed","code":"RESTORE_…"}` on stderr (exit 1; 2 for `RESTORE_ARGUMENTS_INVALID`). Only `RESTORE_CONFIGURATION_REQUIRED`/`_INVALID` add `variable`. Foreign errors go through `MAPPED` (archive-library, storage and TLS codes) or become `RESTORE_FAILED`; raw text, URLs, paths, keys, buckets, prefixes, object keys and ARNs never reach the output. No pg_restore output is read except the `--version` probe's stdout, and `process.noDeprecation` silences pg's pgpass notice. `--help` is the only flag and reads no variable. The restore drill (task-0029882f) relies on the success line's `createdAt`, `tables`, `tablesVerified`, `objects` and `objectsVerified`, on the failure's `code` and `variable`, and on the exit statuses: keep them.
- **Configuration order** (`configuration()`), all before any network or database work: the archive location (`archiveOf`: an absolute archive path, an absolute directory ending in a separator, or the `s3://<bucket>/<prefix>/[<name>]` grammar); for `s3://`, the staging directory (absolute, real, writable and empty: leftovers are refused, never cleaned), then the archive endpoint and region; the key (`readBackupKey` with the archive's directory, or the staging directory, as `outside`); the URL (`databaseUrlOf`); `PGPASSWORD` refused; the CA file; `targetOf()` (https endpoint, region, a bucket other than the archive's, a key ARN that is no alias, the prefix grammar); `UNAI_RESTORE_PG_RESTORE`. Every read stays a literal `process.env.NAME` for the env-contract guard, and the pg_restore child's environment is the same `Object.entries` filter as backup's.
- **Phases and their invariants** (`restore()`), in order:
  - *Selection* (`localArchive`, `s3Archive`): the named archive, else the newest `ARCHIVE_NAME` whose `.sha256` and `.manifest.json` both exist (a nested S3 prefix never counts). Each staged file enters `state.staged` before its first byte and is written `wx` 0600.
  - *Pass 1* (`authenticate`, `manifestOf`), before any contact with the target: both sidecars (at most 64 KiB) agree with the file, `readArchive` authenticates the whole archive under the key while each entry's name, size and SHA-256 are recorded, and the inner manifest must match the entry list (manifest, `database.dump.NNNNNN` parts starting `PGDMP`, one `objects/NNNNNN` per live object with its digest).
  - *Target checks* (`openTarget`, `openStore`): superuser, the manifest's server major, pg_restore of that major, the per-database `pg_try_advisory_lock(hashtextextended('uai-restore',0))` (`RESTORE_TARGET_BUSY`), then no schema besides `public` and no relation in `public`; the adapter's bucket-encryption check, then no key under the prefix. Nothing is written, and no flag skips either emptiness check (a test refuses `--force` and scans the source for any other flag).
  - *Apply* (`apply`): `readArchive` again, and an entry is used only when its name, size and digest equal pass 1's entry at the same index (`RESTORE_ARCHIVE_INTEGRITY_FAILED`). Dump parts go to one `pg_restore --exit-on-error --single-transaction --no-password` with each write awaited (backpressure), and it must exit 0 before the first object reaches the adapter's `put` (SSE-KMS, `IfNoneMatch`, receipt check) at `<prefix><key>`. Every buffer is zeroed after use.
  - *Verify* (`verify`): one REPEATABLE READ, READ ONLY snapshot with `row_security` off compares `tableDigests`, the migration ledger and the registry releases with the manifest; then every object is read back through the adapter's `get` and hash-checked.
- **Never.** It never deletes, drops, truncates or empties anything and never reads `UNAI_S3_*` (a test scans the source for both), and it never copies the key. `cleanup()` runs on every exit, SIGINT and SIGTERM (`RESTORE_INTERRUPTED`) included: it kills pg_restore with SIGKILL (its transaction rolls back), destroys both S3 clients, closes the store and the pool (releasing the lock), removes every staged file and zeroes the key.
- **The `--dbname` trap.** libpq reads a `--dbname` value that contains `=` or starts with `postgres://` or `postgresql://` as a connection string whose settings win over the `PG*` environment, so `databaseUrlOf` admits only a database name matching `[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}`. Host, port, user, TLS mode and CA reach pg_restore only as `PG*` variables; never pass the URL itself.
- **Test** (`src/restore.test.ts`, stage `operations`). `beforeAll` migrates and seeds a scratch source database and backs it up once with `pnpm backup`, retrying only `BACKUP_PRECONDITION_FAILED` (backup.test.ts's busy case briefly holds `unai_api_login` on the shared cluster), at most 20 times, 3 s apart. Everything above the first `it` is file-scope setup that the drill's `describe('pnpm restore:drill')`, appended at the end of the file, reuses: keep it outside any `describe` under the same names, and never write to the source after the backup. The harness PostgreSQL is plain TCP, so a test TLS terminator fronts it, with a 0600 pgpass whose database field is `*`. Two in-process S3 servers (the target bucket, and an archive bucket for `s3://` locations) accept one test-owned AWS pair, never the harness's, which the child reads through the SDK env chain; each has its own `commonName`, so both certificates verify from one `NODE_EXTRA_CA_CERTS` bundle, and no case is skipped. pg_restore is the host's `/usr/lib/postgresql/<major>/bin/pg_restore`, else one of the server's major on PATH, else `docker run` of `POSTGRES_IMAGE`, which needs `--interactive` because pg_restore reads the dump on stdin. A failing pg_restore needs no double: an event trigger on `CREATE INDEX` (a function in `public` is no relation, so the target still counts as empty) fails it after every table is loaded, and the case proves that the single transaction leaves nothing and no object was written. Every child also gets sentinel `UNAI_S3_*` values, and the last test checks that no output of the file names any sentinel (URL, password, key path, object key, bucket, prefix, ARN or endpoint).

## verifier-rehearsal.mjs

This script reproduces how the moe-next daemon verifier provisions its database; the daemon sources named in its header are not in this repo. It starts pgvector with the superuser `app`, mints a certificate with `openssl` inside the container, enables TLS through `ALTER SYSTEM` and `pg_reload_conf()`, and delivers a `postgres://` URL as `DATABASE_URL` and `UNAI_MIGRATION_DATABASE_URL` plus the CA path as `UNAI_DATABASE_CA_PATH` (names overridable with `MOE_VERIFIER_DB_URL_VARS`, `MOE_VERIFIER_DB_CA_VAR`, `MOE_VERIFIER_DB_IMAGE`). It removes `UNAI_TEST_DATABASE_URL` from the child environment, then runs its arguments as shell commands, or `pnpm db:migrate` followed by `pnpm test`, stopping at the first non-zero exit. `pnpm test` therefore takes the delivered-server path there. It needs Docker, and neither `pnpm test` nor CI runs it.

## Checking a change

Only the helpers a `src/*.test.ts` imports have unit tests: `pnpm exec vitest run src/backup-archive.test.ts` needs neither Docker nor a database. `node scripts/test.mjs --stage <name>` runs one stage of `test-stages.mjs` behind its own database and storage, with its report in `test-results/acceptance/<name>.json` and no rehearsal; `--stage operations` covers `backup.mjs`, `restore.mjs`, the archive library and the recovery helpers. The full check is `pnpm test` from the repo root, which also runs the recovery rehearsal. Two smoke checks need neither Docker nor a database:

```
node -e "import('./scripts/s3-object-server.mjs').then(async m=>{const s=await m.startS3ObjectServer({bucket:'b',kmsKeyId:'k'});console.log(s.endpoint);s.close()})"
node -e "import('./scripts/tls-certificate.mjs').then(m=>console.log(new (require('node:crypto').X509Certificate)(m.createSelfSignedCertificate().certificate).subjectAltName))"
```
