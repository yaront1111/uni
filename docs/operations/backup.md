# Backup

Scope: coordinated PostgreSQL, raw-object and key-recovery backup. An owner data
export alone is not a system backup. Perform the first rehearsal on synthetic
data in an isolated test deployment; record its version and source commit.
Deployment decisions: ADR 0043 D9 (backups) and D11 (maintenance mode).

1. Enter maintenance mode (ADR 0043 D11). `unai-backup.service` stops
   `unai-worker` first (connector polling, extraction, initiative and cleanup),
   then `unai-api` (owner writes, ingestion, erasure), through `+`-prefixed
   `ExecStartPre` commands, so the `unai-backup` user never holds systemctl
   rights. `unai-web` stays up; proxied calls answer 503 `SERVICE_UNAVAILABLE`.
   `systemctl stop` waits for the SIGTERM handlers.
2. Run `pnpm backup` as the `unai-backup` user with the backup environment file.
   Every variable is listed under `### pnpm backup` in
   [environment.md](environment.md); the password comes only from `PGPASSFILE`.
   - **Checks, in order, before anything is written.** The configuration, then
     the D11 precondition: `systemctl is-active` reports `inactive` or `failed`
     for both `unai-api` and `unai-worker`, and no `pg_stat_activity` backend
     belongs to `unai_api_login` or `unai_worker_login`. `--assume-quiescent`
     skips only the systemd check, on a host without systemd; it never belongs in
     the unit, and the backend check always runs. The role must be superuser or
     BYPASSRLS, and `pg_dump`'s major version must equal the server's.
   - **One snapshot.** A SERIALIZABLE READ ONLY DEFERRABLE transaction exports
     its snapshot; the table digests, migration head, registry releases and
     evidence rows are read in it, and `pg_dump --snapshot` dumps exactly that
     state. Each live `evidence_object_keys` row is read through the verified
     encrypted-store adapter, and its SHA-256 must equal
     `source_items.content_hash`. Erased rows are counted and never read.
   - **Output.** In `UNAI_BACKUP_DESTINATION`: `uai-backup-<UTC>.tar.enc`, a
     uai-backup/1 archive (format: `scripts/CLAUDE.md`, `## lib/backup-archive.mjs`)
     holding `manifest.json`, the `database.dump.NNNNNN` parts and
     `objects/NNNNNN`; `<archive>.sha256`, checkable with `sha256sum -c`; and
     `<archive>.manifest.json` with counts, migration head and release versions
     but no digests, object keys or paths. The archive is decrypted and checked
     against what was written before the sidecars appear. Only then, if
     `UNAI_BACKUP_RETENTION_DAYS` is set, archives (and their sidecars) older
     than that many days are pruned, judged by the UTC time in the name; the newest
     archive is always kept and other files are never touched.
   - **S3 destination** (`s3://<bucket>/<prefix>/`, ADR 0043 D9). The three files are
     written and verified exactly as above, but in `UNAI_BACKUP_STAGING_DIR`, which
     must be empty when the run starts. They are then uploaded to
     `<prefix><archive>`, `<prefix><archive>.sha256` and, last,
     `<prefix><archive>.manifest.json`, so a bucket holding an archive without its
     manifest marks an incomplete run. Every write carries SSE-KMS under
     `UNAI_BACKUP_S3_KMS_KEY_ID` and `If-None-Match: *`. A file above 8 MiB goes up as
     a multipart upload in 8 MiB parts, and any failure aborts that upload. Every
     receipt (PutObject, CreateMultipartUpload, each UploadPart,
     CompleteMultipartUpload, HeadObject) must name `aws:kms` and that key ARN, and a
     HeadObject after each file must report its staged size. The staged files are
     removed on success and on every failure. The script never deletes and never
     lists in the backup bucket; the abort only discards an unfinished upload's parts.
     A receipt refused after a PUT or a Complete has finished leaves that object in
     the bucket, which the principal cannot delete: the lifecycle rule expires it,
     and the missing manifest marks it incomplete. `retentionRemoved` is always 0.
   - **Result.** Exit 0 prints one line on stdout:
     `{"event":"backup.completed","format":"uai-backup/1","archive":…,"bytes":…,"sha256":…,"quiescence":"systemd"|"assumed","tables":…,"rows":…,"objects":…,"deletedObjects":…,"dumpParts":…,"migrationHead":…,"registryReleases":[…],"retentionRemoved":…,"durationMs":…}`.
     Any failure prints one line on stderr, `{"event":"backup.failed","code":…}`,
     and exits 1 (2 for bad flags). No URL, path, key, object key or error text
     is ever printed.
   - **A failed run leaves no archive** (except `BACKUP_RETENTION_FAILED`, below).
     It is unusable and is retried from maintenance mode, never combined with
     another run.

   | Code | Meaning |
   | --- | --- |
   | `BACKUP_ARGUMENTS_INVALID` | unknown or repeated flag (exit 2) |
   | `BACKUP_CONFIGURATION_REQUIRED` | the `variable` field names an unset or blank variable |
   | `BACKUP_CONFIGURATION_INVALID` | `PGPASSWORD` is set, the CA file is unreadable or empty, `UNAI_BACKUP_PG_DUMP` is malformed, or, with an `s3://` destination: the staging directory is missing, relative, unwritable or not empty, `UNAI_BACKUP_RETENTION_DAYS` is set, the backup endpoint is not an https URL, or the backup key is an alias (`variable` says which) |
   | `BACKUP_DESTINATION_INVALID` | not an existing, writable, absolute directory; or an `s3://` destination that is malformed, names the evidence bucket, or whose key equals `UNAI_S3_KMS_KEY_ID` |
   | `BACKUP_KEY_LOCATION_INVALID` | key file missing, not a regular file, a symlink, readable by group or others, or inside the destination |
   | `BACKUP_KEY_INVALID` | key file is not exactly 32 bytes |
   | `BACKUP_RETENTION_INVALID` | retention is not a whole number of days from 1 to 3650 |
   | `BACKUP_DATABASE_URL_INVALID` | URL is not `postgres(ql)://user@host[:port]/database`, carries a password, query, fragment or malformed `%` escape, or its TLS settings are refused |
   | `BACKUP_PRECONDITION_FAILED` | a unit is not stopped, systemctl is missing, or an API or worker backend is connected |
   | `BACKUP_DATABASE_FAILED` | connection, authentication, TLS verification or a query failed |
   | `BACKUP_DATABASE_ROLE_INVALID` | the role is neither superuser nor BYPASSRLS |
   | `BACKUP_PG_DUMP_UNAVAILABLE` | pg_dump could not be started |
   | `BACKUP_PG_DUMP_VERSION_MISMATCH` | pg_dump's major differs from the server's |
   | `BACKUP_PG_DUMP_FAILED` | pg_dump exited non-zero or produced no custom-format dump |
   | `BACKUP_TABLE_DIGEST_FAILED` | a table could not be digested |
   | `BACKUP_EVIDENCE_STORE_UNAVAILABLE` | the bucket's encryption rule or a read receipt does not match `UNAI_S3_KMS_KEY_ID`, or the storage configuration is refused |
   | `BACKUP_EVIDENCE_DELETION_STATE_MISMATCH` | an object key row and its source item disagree about erasure |
   | `BACKUP_EVIDENCE_PROVIDER_UNKNOWN` | a live row is not encrypted under `kms:<UNAI_S3_KMS_KEY_ID>` |
   | `BACKUP_EVIDENCE_OBJECT_UNREADABLE` | an object could not be read or access was denied |
   | `BACKUP_EVIDENCE_OBJECT_MISMATCH` | an object's SHA-256 differs from its content hash |
   | `BACKUP_ARCHIVE_EXISTS` | an archive with this second's name already exists, in the directory or, for `s3://`, in the bucket (412) |
   | `BACKUP_DESTINATION_ENCRYPTION_INVALID` | an upload or HeadObject receipt does not name `aws:kms` and `UNAI_BACKUP_S3_KMS_KEY_ID` |
   | `BACKUP_DESTINATION_UPLOAD_FAILED` | an upload request failed, a staged file could not be read, or HeadObject reported another size |
   | `BACKUP_ARCHIVE_WRITE_FAILED`, `BACKUP_ARCHIVE_TOO_LARGE` | the archive or a sidecar could not be written |
   | `BACKUP_ARCHIVE_INTEGRITY_FAILED` | the written archive did not verify; it is deleted |
   | `BACKUP_RETENTION_FAILED` | pruning failed **after** a verified archive and sidecars were written; that backup is kept and usable, fix the directory before the next run |
   | `BACKUP_INTERRUPTED` | SIGINT or SIGTERM; pg_dump is stopped and partial files removed |
   | `BACKUP_FAILED` | any other failure |
3. Restart the services whatever the outcome: `ExecStopPost` starts `unai-api`,
   then `unai-worker`. Check the API probe (ADR 0043 D10) before leaving.
4. Key custody (ADR 0043 D9). `backup.key` is 32 random bytes
   (`head -c 32 /dev/urandom`), owned by `unai-backup`, mode 0600, in
   `/etc/unai/backup`, outside every destination. Before the first backup the
   owner records an offline copy (paper in a safe and/or a password manager off
   this host). The key never goes in the destination or backup bucket, the
   runtime mounts, Git, logs or the manifest. Runtime secrets are not backed up:
   each is re-issued by its issuer.
5. Off-host copy. Production sets `UNAI_BACKUP_DESTINATION=s3://<bucket-prefix>-uai-backup/<host-name>/`
   (ADR 0043 D9): a versioned bucket in another region with one SSE-KMS default
   rule under its own key, written by the `unai-backup` IAM user, which cannot
   delete. Set `UNAI_BACKUP_STAGING_DIR`, `UNAI_BACKUP_S3_ENDPOINT`,
   `UNAI_BACKUP_S3_REGION` and `UNAI_BACKUP_S3_KMS_KEY_ID` (the key ARN, not the
   alias); credentials come from `AWS_SHARED_CREDENTIALS_FILE`. Retention there is
   the bucket's lifecycle rule only; `UNAI_BACKUP_RETENTION_DAYS` applies only to
   local directories and is refused with `s3://`. A local destination is on the
   same host and must be copied off it after each run, together with the two
   sidecars. A run killed hard (SIGKILL, power loss) can leave files in the
   staging directory, and the next run then refuses it as not empty: check that
   no backup is running, remove the leftovers, and run again. The script never
   cleans a directory it did not fill in that run.
6. A backup counts as usable only after a restore drill has restored one of its
   archives (task-0029882ff3c84cef89ffa6b150c03bb0, docs/operations/restore.md).
   Erased evidence survives in archives until they expire; a restore replays
   deletion requests newer than the backup before any read.

## Executable test procedure

`node scripts/test.mjs --stage operations` runs `src/backup.test.ts`: it runs `scripts/backup.mjs` against a scratch database
behind a TLS terminator and the harness bucket, decrypts the archive with the key
file, and checks the manifest's table digests, migration head and objects against
freshly computed values, the refusals, retention and that no output carries a
secret. Its `s3://` cases run against a second in-process S3 server with its own
bucket and key ARN, reached through the harness's credentials: the configuration
refusals before any database or object read, a small archive (PutObject and
HeadObject in order), a multipart upload above 8 MiB, refused receipts at every
upload step with the abort where an upload was unfinished, the downloaded archive
verified with the key file against fresh digests, and an empty staging directory
after each run.

Run `pnpm test`. Once every suite worker has exited successfully, the harness
freezes writes and takes pg_dump plus a complete live-object logical snapshot.
Each mapping for the configured store must have bytes matching its source item's
content hash. The existing kms:test, kms:test-double and kms:live-test fixture
providers are counted separately, never as recovered objects; unknown provider
references fail the rehearsal. The test store is unversioned; the production
backup bucket keeps the version history described in ADR 0043 D9.

The logical snapshot uses source KMS authorization to decrypt object bytes into
the same uai-backup/1 archive `pnpm backup` writes (`scripts/lib/backup-archive.mjs`:
manifest, dump parts and objects under AES-256-GCM). It saves the separate backup
key in a dedicated temporary recovery location, clears the original key buffer,
proves that a random key and a tampered copy are refused, then restores from the
saved archive and recovered key. The target store uses its own independent KMS
key. This logical recovery path needs the backup key, not continued access to the
source KMS principal. Temporary test keys are destroyed after the rehearsal.

`test-results/operations/coordinated-roundtrip.json` records the archive digest,
empty-target checks, table digests, object count and fixture output digest pairs.
Any missing object, changed byte, failed key recovery or fixture mismatch fails
`pnpm test`. PostgreSQL clients must match the server major version. The default
Docker harness uses its pinned clients; delivered databases use host clients or
the pinned tooling container. A configured database never silently skips recovery.

Executed 2026-09-19: see [execution record](execution-2026-09-19.json) and the
[coordinated recovery receipt](coordinated-recovery-2026-09-19.json). The archived
test key is intentionally removed after verified recovery; this synthetic test
artifact is not a reusable production backup.
