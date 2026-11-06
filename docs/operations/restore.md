# Restore

`pnpm restore` (`scripts/restore.mjs`) restores one encrypted uai-backup/1 archive written by
`pnpm backup` ([backup.md](backup.md)) into an empty PostgreSQL database and an empty prefix of
an evidence bucket. It then verifies every table digest, the migration ledger, the registry
releases and every object against the archive's manifest. It authenticates the whole archive
with the backup key before it touches the target, refuses a target database or prefix that is
not empty, and never deletes, drops or empties anything. Deployment decisions: ADR 0043 D4 (PostgreSQL) and
D9 (backups). Do not restore over a running environment. `pnpm restore:drill` rehearses a
restore into a database and prefix of its own and reads the result through the product's read
path ([Restore drill](#restore-drill)).

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
- **pg_hba** admits the restore role to that database over `hostssl`, so
  `UNAI_RESTORE_DATABASE_URL` names `unai_migrator` at host `127.0.0.1`, never `localhost`, and
  the database `unai`; the restore and its `pg_restore` verify the server certificate against
  `UNAI_DATABASE_CA_FILE`. The shipped `deploy/postgres/pg_hba.conf` (ADR 0043 D4) has exactly
  three lines, with no non-TLS `host` line and no IPv6 line:
  - `hostssl` to the database `unai` for the five logins `unai_api_login`, `unai_worker_login`,
    `unai_auth_login`, `unai_backup` and `unai_migrator`, from `127.0.0.1/32` with `scram-sha-256`;
  - `hostssl` to the drill's per-run databases `unai_restore_drill_<16 lowercase hex>` for
    `unai_migrator` and the probe logins `unai_restore_drill_probe_<16 lowercase hex>`, from
    `127.0.0.1/32` with `scram-sha-256` ([Restore drill](#restore-drill));
  - `local all postgres peer`: the `postgres` superuser connects only through the local socket.
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

## Restore drill

`pnpm restore:drill` (`scripts/restore-drill.mjs`) proves that an archive restores and that
the restored memory answers through the product's own read path, without touching the
production database or evidence bucket. ADR 0043 D9 schedules it monthly (first Sunday, 05:00
UTC). One run:

1. Draws an `<id>` of 16 random lowercase hex characters. Everything the run creates is named
   with it, so two drills never share a database, prefix or login.
2. Connects to `UNAI_RESTORE_DRILL_SERVER_URL`, which must be a superuser (`unai_migrator`),
   and creates the database `unai_restore_drill_<id>` from `template0`.
3. Runs `pnpm restore` as a child with `UNAI_RESTORE_DATABASE_URL` set to that database and
   `UNAI_RESTORE_S3_PREFIX` set to `restore-drill-<id>/`. Every other `pnpm restore` variable
   reaches it unchanged, and it applies every check above, both emptiness checks included. It
   must answer PASS.
4. Creates the login `unai_restore_drill_probe_<id>`:
   - `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 4`, valid for one day, a member of `unai_app` only;
   - its 32 random bytes of password exist only in the drill's memory, and the server receives
     only a SCRAM-SHA-256 verifier.

   The login exists because `withOwnerTransaction` refuses a superuser or BYPASSRLS session,
   so the restoring role cannot run the probes.
5. Probes the restored database as that login. The clock is frozen at the archive's `createdAt`,
   and the newest registry release in the restored database is used. Who and what is probed:
   - every live owner member, by the membership rule `withOwnerTransaction` applies;
   - every data purpose of that scope's live evidence;
   - each of `What did I promise?`, `What is on my calendar?` and `Did my prediction come true?`.

   Each probe asks through Ask (the Context Broker), builds Today, re-reads the persisted packet,
   and opens Why? for every proposition, overlay delta or resolution they cite. An owner scope
   with no live evidence is counted in `ownersWithoutEvidence`, not probed. The probes' own
   receipts (packets, briefings, audit rows) are written to the drill database only.
6. Tears down on every exit, failure and SIGTERM included:
   - the probe login is always dropped;
   - without `--keep`, the database is dropped `WITH (FORCE)`, and every object under the prefix is deleted.

   Only names carrying this run's `<id>` are ever dropped or deleted.

Prerequisites, beyond the `pnpm restore` ones that apply to the archive and the key:

- **The drill server.** It runs PostgreSQL of the archive's major with pgvector and the
  cluster-wide roles of `deploy/postgres/provision.sql` (`unai_app` among them), because
  pg_dump carries no roles.
  - `pg_hba.conf` must admit, over `hostssl`:
    - `unai_migrator` to the database of `UNAI_RESTORE_DRILL_SERVER_URL` and to every `unai_restore_drill_<id>`;
    - each `unai_restore_drill_probe_<id>` to its database.

    The shipped `deploy/postgres/pg_hba.conf` does, only over `hostssl` from `127.0.0.1/32` with
    `scram-sha-256` ([Prerequisites](#prerequisites)). Its first line admits `unai_migrator` to
    `unai`, so `UNAI_RESTORE_DRILL_SERVER_URL` names that database at host `127.0.0.1`, never
    `localhost`. Its second line admits `unai_migrator` and every login matching
    `^unai_restore_drill_probe_[0-9a-f]{16}$` to every database matching
    `^unai_restore_drill_[0-9a-f]{16}$`. Both patterns are anchored, so only exactly 16 lowercase
    hex characters match; pg_hba cannot pair a probe login with its own run's database.
  - `unai_migrator` has a connection limit of 5, and a drill holds at most three of its sessions at once.
- **`PGPASSFILE`** has a line for `unai_migrator` whose database field is `*`, because the
  database name changes every run. `PGPASSWORD` is refused.
- **The drill bucket.** It is `<bucket-prefix>-uai-restore-drill`, permanent, with one
  `aws:kms` rule naming the evidence key and a 2-day expiry.
  - `UNAI_RESTORE_S3_BUCKET` names it.
  - `UNAI_RESTORE_S3_KMS_KEY_ID` names the evidence key's ARN.
  - `UNAI_RESTORE_ARCHIVE` is `s3://<backup bucket>/<prefix>/`, so the newest complete archive is used.
- **IAM user `unai-restore-drill`**, through the SDK default chain, with exactly the ADR 0043
  D9 permissions:
  - on the backup bucket: `s3:ListBucket` and `s3:GetObject`, plus `kms:Decrypt` on the backup key;
  - on the drill bucket: `s3:GetEncryptionConfiguration`, `s3:ListBucket`, `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject`, plus `kms:GenerateDataKey` and `kms:Decrypt` on the evidence key;
  - nothing on the evidence bucket.

The verdict is exactly one JSON line. It never prints a URL, password, path, key, bucket, ARN,
owner id, question or answer text.

- **Success**, exit 0, on stdout:
  `{"event":"restore.drill.completed","verdict":"PASS","drill":"<id>","restore":{"verdict":"PASS","format":"uai-backup/1",…},"probes":{"owners":1,"members":1,"ownersWithoutEvidence":0,"reads":3,"statements":…,"beliefs":…,"explanations":…,"todayItems":…,"digest":"<sha256>"},"kept":null,"durationMs":…}`.
  - `restore` is `pnpm restore`'s success line without its `event`.
  - `reads` is the number of probes.
  - `digest` is the SHA-256 of their comparable outputs, which are free of receipt ids. Two drills of one archive give the same digest.
  - With `--keep`, `kept` is `{"database":"unai_restore_drill_<id>","prefix":"restore-drill-<id>/"}`.
- **Failure**, on stderr, for example
  `{"event":"restore.drill.failed","code":"RESTORE_ARCHIVE_INTEGRITY_FAILED","stage":"restore","drill":"<id>"}`.
  - `drill` appears once the id is drawn.
  - `kept` appears whenever something the run created is still there (`--keep`, or a removal that failed). It names the `database`, `prefix` and `role` that remain.
  - Exit 2 for `RESTORE_DRILL_ARGUMENTS_INVALID`, 1 for every other code.

| Code | Cause | What to do |
| --- | --- | --- |
| `RESTORE_DRILL_ARGUMENTS_INVALID` | any argument other than a lone `--keep` or `--help` | run it with no argument or `--keep` |
| `RESTORE_DRILL_CONFIGURATION_REQUIRED`, `RESTORE_DRILL_CONFIGURATION_INVALID` | the variable in `variable` is unset, or has the wrong form, or is one the drill sets itself (`UNAI_RESTORE_DATABASE_URL`, `UNAI_RESTORE_S3_PREFIX`) | fix or unset it ([environment.md](environment.md)) |
| `RESTORE_DRILL_DATABASE_URL_INVALID` | `UNAI_RESTORE_DRILL_SERVER_URL` is not a password-less `postgres(ql)://user@host[:port]/<database>` without query or fragment | fix the URL; the password belongs in `PGPASSFILE` |
| `RESTORE_DRILL_ROLE_INVALID` | the server login is not a superuser; nothing was created | connect as `unai_migrator` |
| `RESTORE_DRILL_DATABASE_FAILED` | connecting, creating the database or the login, or granting `unai_app` failed | check the server, `pg_hba.conf`, the CA and `PGPASSFILE` |
| any `RESTORE_…` code with `"stage":"restore"` | `pnpm restore` failed with that code (and `variable`) | the table above |
| `RESTORE_DRILL_RESTORE_OUTPUT_INVALID` | `pnpm restore` ended without its one verdict line (killed or crashed) | run the drill again; check the host's memory and disk |
| `RESTORE_DRILL_PROBE_FAILED` | a probe read failed; `probeCode` names the product's stable code when there is one (for example `DATABASE_ROLE_UNSAFE`) | keep the next run (`--keep`) and inspect the read path against it |
| `RESTORE_DRILL_PROBES_EMPTY` | no live owner member has live evidence, so no read was proved | check that the archive is the production one |
| `RESTORE_DRILL_CLEANUP_FAILED` | the drill passed, but a removal failed; `kept` names what remains | remove it as below |
| `RESTORE_DRILL_INTERRUPTED` | SIGINT or SIGTERM: the restore child is stopped first, then the teardown runs | run it again |
| `RESTORE_DRILL_FAILED` | any other failure | run it again; report it if it repeats |

To remove what `--keep` kept, or what a failed teardown left (named in `kept`), use
`unai_migrator` on the drill server:

- `DROP DATABASE "unai_restore_drill_<id>" WITH (FORCE)`;
- `DROP ROLE IF EXISTS "unai_restore_drill_probe_<id>"`;
- delete the objects under `restore-drill-<id>/` in the drill bucket. They also expire after two days.

What a PASS proves:

- the archive authenticates under the backup key and restores into an empty database and an
  empty prefix, with every table digest, the migration ledger, the registry releases and every
  object equal to its manifest (`restore`);
- every live owner member's Ask, Today, persisted-packet and Why? reads answer over the restored
  data through `unai_app`, the product's RLS policies and its membership check (`probes`).

What it does not prove:

- That the restored memory equals production's answers. The drill never reads production, and the
  digest compares drills, not environments; `src/restore.test.ts` is where a drill's probes are
  compared with the source database's.
- That the answers are right. The probes prove that the read path answers, not what it says.
- The manual steps 5 to 7 above: deletion replay, credential and session rotation, and the cutover
  review. A drill database is never cut over.
- The units' startup against a restored environment (secrets, `unai.encryption_at_rest`).

## Executable test procedure

`pnpm restore` is tested by `src/restore.test.ts` in the `operations` stage
(`node scripts/test.mjs --stage operations`, also part of `pnpm test`). It restores a fresh
`pnpm backup` archive of a migrated, seeded scratch database into new scratch databases behind
verified TLS and empty prefixes of an in-process encrypted S3 bucket, from a file, a directory
and an `s3://` location. It also proves the refusals: a tampered archive, a non-empty database
or prefix, a receipt naming another key, a failing `pg_restore`, an inconsistent manifest, a
busy target and bad configuration. `pnpm restore:drill` is tested in the same file
(`describe('pnpm restore:drill')`), against the same archive:
- a PASS leaves no database, login or object behind;
- `--keep` keeps exactly its database and prefix, and still drops the login;
- a tampered archive fails at the restore stage and leaves nothing;
- unsafe configuration, a login that is not a superuser, and every flag but `--keep` and `--help` are refused before anything is created;
- the probes of both PASS runs equal `probeEnvironment` over the untouched source database, with the same frozen clock.

The recovery rehearsal still runs
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
