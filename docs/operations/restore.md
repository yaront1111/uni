# Restore

`pnpm restore` (`scripts/restore.mjs`) restores one encrypted uai-backup/1 archive written by
`pnpm backup` ([backup.md](backup.md)) into an empty PostgreSQL database and an empty prefix of
an evidence bucket. It then verifies every table digest, the migration ledger, the registry
releases and every object against the archive's manifest. It authenticates the whole archive
with the backup key before it touches the target, refuses a target database or prefix that is
not empty, and never deletes, drops or empties anything. Deployment decisions: ADR 0043 D4 (PostgreSQL) and
D9 (backups). Do not restore over a running environment.

## Prerequisites

- **PostgreSQL of the archive's major version** (the manifest's `serverVersionNum`; ADR 0043
  D4 runs 17) with pgvector available, and `pg_restore` of that same major.
- **A target database provisioned by `deploy/postgres/provision.sql`**: the roles, the database
  owned by `unai_migrator`, `CREATE EXTENSION vector` and
  `ALTER DATABASE … SET unai.encryption_at_rest`. `pg_dump` carries neither roles nor
  database-level settings, so the restore cannot create them. Do not run `pnpm db:migrate`
  first: the archive carries the schema and its migration ledger, and a migrated database is
  not empty. Deploy an application release whose `migrations/` includes the archive's
  `migrationHead` (named in `<archive>.manifest.json`).
- **pg_hba** admits the restore role to that database over `hostssl`. The shipped
  `deploy/postgres/pg_hba.conf` admits only the database `unai`.
- **The restore role `unai_migrator`** (LOGIN SUPERUSER, ADR 0043 D4), its password in a 0600
  `PGPASSFILE`. `PGPASSWORD` is refused.
- **An empty target bucket** whose single `aws:kms` default-encryption rule names
  `UNAI_RESTORE_S3_KMS_KEY_ID`. Give it the **source** evidence key: every restored
  `evidence_object_keys.encryption_key_ref` still reads `kms:<source key>`, so the API's
  `UNAI_S3_KMS_KEY_ID` must stay that key, or the next `pnpm backup` refuses with
  `BACKUP_EVIDENCE_PROVIDER_UNKNOWN`.
- **An empty `UNAI_RESTORE_S3_PREFIX` in production**, because the API reads each object at its
  recorded key. A prefix is for drills.
- **The backup key**: the 32-byte `backup.key` recovered from the owner's offline copy (ADR 0043
  D9, key custody), in a regular file of mode 0600 outside the archive's directory and the
  staging directory. The tool reads it once and never copies it.
- **AWS credentials from the SDK default chain**, supplied by the operator at restore time
  (ADR 0043 D9):
  - for an `s3://` archive: `s3:ListBucket` and `s3:GetObject` on the backup bucket, plus
    `kms:Decrypt` on the backup key;
  - on the target bucket: `s3:GetEncryptionConfiguration`, `s3:ListBucket`, `s3:PutObject` and
    `s3:GetObject`, plus `kms:GenerateDataKey` and `kms:Decrypt` on its key.
- **The units stopped** (`unai-api`, `unai-worker`, `unai-web`) and connectors disabled.

## Procedure

1. Stop the units and set the variables listed under `### pnpm restore` in
   [environment.md](environment.md). Record their names only, never their values.
2. Run `pnpm restore` with no arguments (`--help` prints the usage and reads nothing). In order:
   - **Archive selection.** `UNAI_RESTORE_ARCHIVE` names one archive; or a local directory
     ending in `/`, whose newest archive that has both sidecars is used; or
     `s3://<bucket>/<prefix>/` with an optional archive name, else the newest complete archive
     directly under that prefix. An `s3://` archive and its two sidecars are downloaded into
     `UNAI_RESTORE_STAGING_DIR`, which must be empty at the start and is emptied on every exit.
   - **Pass 1, before the target is touched.** Both sidecars must agree with the file, and the
     whole archive must authenticate under the key while every entry's name, size and SHA-256
     are recorded. The authenticated manifest must match the entry list.
   - **Target checks.** The role must be a superuser, and the server and `pg_restore` must be
     of the archive's major. A per-database restore lock refuses a second concurrent run. The
     database must hold no schema besides `public` and no relation in `public` (extension
     objects such as `vector`'s types do not count). The bucket's encryption rule must name the
     key, and no object may exist under the prefix (in the whole bucket when there is none).
     No flag skips these checks.
   - **Apply.** The archive is read again, and every entry is used only when it matches its
     pass-1 record. The dump streams into one `pg_restore --exit-on-error --single-transaction`,
     which must succeed before the first object is written. Each object is then written at
     `<prefix><key>` under SSE-KMS with the key and `If-None-Match: *`, and its receipt must
     name the key.
   - **Verify.** One snapshot compares every table digest, the migration ledger and the registry
     releases with the manifest. Every object is then read back and its SHA-256 compared.
3. Read the verdict. It is exactly one JSON line. No URL, password, path, key, bucket, prefix,
   object key, KMS ARN or error text is ever printed.
   - **Success**, exit 0, on stdout:
     `{"event":"restore.completed","verdict":"PASS","format":"uai-backup/1","archive":…,"createdAt":…,"sha256":…,"bytes":…,"tables":…,"tablesVerified":…,"rows":…,"objects":…,"objectsVerified":…,"deletedObjects":…,"dumpParts":…,"migrationHead":…,"migrations":…,"registryReleases":[…],"durationMs":…}`.
     `createdAt` is when the backup was taken, the watermark for step 5. `tablesVerified`
     equals `tables` and `objectsVerified` equals `objects`.
   - **Failure**, on stderr: `{"event":"restore.failed","code":"RESTORE_…"}`. Only
     `RESTORE_CONFIGURATION_REQUIRED` and `RESTORE_CONFIGURATION_INVALID` add `variable`, the
     name of the variable at fault. Exit 2 for `RESTORE_ARGUMENTS_INVALID`, 1 for every other
     code.

   | Code | Cause | What to do |
   | --- | --- | --- |
   | `RESTORE_ARGUMENTS_INVALID` | any argument other than a lone `--help` | run `pnpm restore` with no arguments |
   | `RESTORE_CONFIGURATION_REQUIRED` | the variable in `variable` is unset or blank | set it |
   | `RESTORE_CONFIGURATION_INVALID` | the variable in `variable` has the wrong form (its row in environment.md): for example `PGPASSWORD` set, a staging directory that is not empty, the archive's bucket as the target, a key alias, or a prefix too long for an object key | fix it; empty a staging directory only after checking what is in it |
   | `RESTORE_DATABASE_URL_INVALID` | the URL is not a password-less `postgres(ql)://user@host[:port]/<database>` without query or fragment, or the database name is outside `[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}` | fix the URL; the password belongs in `PGPASSFILE` |
   | `RESTORE_KEY_LOCATION_INVALID` | the key file is missing, a symlink or not a regular file, readable by group or others, or inside the archive's or staging directory | put the key in a 0600 regular file elsewhere |
   | `RESTORE_KEY_INVALID` | the key file is not exactly 32 bytes, or it does not match the archive's header (another key, or an altered header) | use this archive's backup key from the offline copy; if that is already the key, treat the archive as damaged and restore an older one |
   | `RESTORE_ARCHIVE_NOT_FOUND` | the local directory or the named archive does not exist, or no archive with both sidecars exists in the directory or under the prefix | check the location |
   | `RESTORE_ARCHIVE_INCOMPLETE` | the named archive lacks a sidecar (an interrupted backup) | name an older archive, or give the directory or prefix |
   | `RESTORE_ARCHIVE_UNAVAILABLE` | the archive, its directory or the backup bucket could not be read | check permissions, credentials and the endpoint, then retry |
   | `RESTORE_ARCHIVE_INTEGRITY_FAILED` | a sidecar disagrees with the file or exceeds 64 KiB, the archive is damaged or altered and fails authentication, or an entry changed between the two passes | restore an older archive; never edit an archive or its sidecars |
   | `RESTORE_MANIFEST_INVALID` | the archive authenticates, but its manifest does not match its entries | restore another archive and report this one |
   | `RESTORE_DATABASE_FAILED` | connecting to or querying the target database failed | check the server, `pg_hba.conf`, the CA and `PGPASSFILE` |
   | `RESTORE_DATABASE_ROLE_INVALID` | the role is not a superuser | connect as `unai_migrator` |
   | `RESTORE_SERVER_VERSION_MISMATCH` | the server's major differs from the archive's | restore onto a server of the archive's major |
   | `RESTORE_PG_RESTORE_UNAVAILABLE` | `pg_restore --version` could not run | install it or set `UNAI_RESTORE_PG_RESTORE` |
   | `RESTORE_PG_RESTORE_VERSION_MISMATCH` | `pg_restore`'s major differs from the server's | point `UNAI_RESTORE_PG_RESTORE` at the server's major, for example `/usr/lib/postgresql/17/bin/pg_restore` |
   | `RESTORE_TARGET_BUSY` | another restore holds this database's restore lock | wait for it; never run two restores into one database |
   | `RESTORE_TARGET_NOT_EMPTY` | the database holds a schema besides `public` or a relation in `public`, or an object exists under the prefix | step 4 |
   | `RESTORE_TARGET_STORE_UNAVAILABLE` | the bucket's encryption is not a single `aws:kms` rule naming the key, or the bucket could not be read | fix the bucket's encryption rule or the credentials |
   | `RESTORE_DATABASE_APPLY_FAILED` | `pg_restore` failed; its single transaction rolled back, and no object was written | check the roles and the `vector` extension (provision.sql) and the server log, then retry |
   | `RESTORE_OBJECT_WRITE_FAILED` | an object write failed or its receipt named another key | step 4 |
   | `RESTORE_TABLE_DIGEST_MISMATCH`, `RESTORE_MIGRATION_LEDGER_MISMATCH`, `RESTORE_REGISTRY_RELEASE_MISMATCH` | the restored database differs from the manifest | step 4; never cut over |
   | `RESTORE_OBJECT_UNREADABLE`, `RESTORE_OBJECT_MISMATCH` | an object could not be read back with a receipt naming the key, or its SHA-256 differs | step 4; never cut over |
   | `RESTORE_INTERRUPTED` | SIGINT or SIGTERM; `pg_restore` is killed, so its open transaction rolls back | step 4 |
   | `RESTORE_FAILED` | any other failure | step 4 |

4. After a failure, fix the cause and run `pnpm restore` again. A failure before the apply
   leaves the target as it was. A failure during or after the apply can leave a partial
   target, and the retry then answers `RESTORE_TARGET_NOT_EMPTY`. The tool never deletes,
   drops or empties anything: drop the database and provision it again
   (`deploy/postgres/provision.sql`), empty the bucket or prefix (or use a new one), then retry.
5. Before any user read, apply every deletion request newer than the verdict's `createdAt`
   through the owner deletion workflow ([deletion.md](deletion.md)), and verify that the
   cascade leaves no searchable or retrievable payload. The archive predates those deletions,
   and a restore must never resurrect what the owner erased.
6. Replace or revoke the restored sessions and credentials; runtime secrets are re-issued by
   their issuers (ADR 0043 D6). Connectors stay disabled until the owner re-authorises them.
7. Cutover review. Activate the restored environment only after the operator has reviewed the
   verdict (its counts against `<archive>.manifest.json`) and the read checks: the units start
   cleanly against the restored database and bucket, and known items read back through Today,
   Ask and Why?. Any mismatch blocks cutover: keep the target for diagnosis and restore again
   into a new one.

## Executable test procedure

`pnpm restore` is tested by `src/restore.test.ts` in the `operations` stage
(`node scripts/test.mjs --stage operations`, also part of `pnpm test`). It restores a fresh
`pnpm backup` archive of a migrated, seeded scratch database into new scratch databases behind
verified TLS and empty prefixes of an in-process encrypted S3 bucket, from a file, a directory
and an `s3://` location. It also proves the refusals: a tampered archive, a non-empty database
or prefix, a receipt naming another key, a failing `pg_restore`, an inconsistent manifest, a
busy target and bad configuration. The recovery rehearsal still runs
in `pnpm test`, as part of the default command. It creates a unique empty database, proves
there are no application tables, and performs pg_restore with exit-on-error and a single
transaction. It creates an independent empty encrypted object store, recovers the separately
saved backup key, reads the saved archive, re-encrypts objects under the target KMS and
verifies every byte. All database table contents are compared before generating any new read
receipts.

The original AC44.01–AC44.20 scenarios must have passed in the source. Their
persisted fixture owners are queried through fresh Today, Ask and Why calls in
both environments, with identical questions, purposes, clock and timezone. The
comparator retains facts, source identifiers, policy verdicts, selection reasons,
watermarks, completeness and explanation data. It excludes only new packet and
briefing receipt IDs, their derived packet hash and the new read-policy receipt
ID; the production persisted-packet reader independently checks each hash.
AC44.10 includes both historical interpretations of August 7, and AC44.05 includes
the owner-wide phone assertion/verification read even after later control tests.
No fixture is reseeded in the target, and no model/network phrasing is required.

These are comparisons of the existing fixtures' terminal persisted states.
Synthetic in-memory evidence ports used while preparing some fixtures are
identified as test doubles, not live storage verification. The real encrypted
store is separately restored and byte-checked. Record every fixture digest pair
from the generated receipt; do not replace it with a count of passed tests.

Executed 2026-09-19: [execution record](execution-2026-09-19.json). The dated
[recovery receipt](coordinated-recovery-2026-09-19.json) is historical evidence;
`ops:report` requires a fresh receipt for the current workspace before showing
backup or restore as passed. Restore credentials are synthetic, no workers or
real connectors run, and all temporary databases/stores are destroyed afterward.
