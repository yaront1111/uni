# Backup

Scope: coordinated PostgreSQL, raw-object and key-recovery backup. An owner data
export alone is not a system backup. Perform the first rehearsal on synthetic
data in an isolated test deployment; record its version and source commit.

1. Put the deployment in maintenance mode. Stop connector polling, ingestion,
   extraction, projection and cleanup workers and API writes. Wait for active
   transactions and object writes to finish. Record the maintenance start time.
2. Use the migration/backup principal with verified PostgreSQL TLS and RLS bypass.
   Keep credentials in the operator's secret mount / pgpass file, not arguments:
   `pg_dump --format=custom --file=database.dump "$UNAI_BACKUP_DATABASE_URL"`.
   Set PGSSLMODE=verify-full and PGSSLROOTCERT to the deployment CA. Use the same
   PostgreSQL major version's client. Check the command exit code and archive TOC
   with `pg_restore --list database.dump`.
3. Snapshot the evidence bucket, including object versions and deletion markers,
   with the storage provider's versioned backup facility. The source is the
   bucket configured for the deployment, not a public evidence identifier. For
   each live evidence_object_keys row, verify that its object exists and its
   decrypted SHA-256 equals source_items.content_hash. Missing objects fail the
   backup; do not silently back up only the database.
4. Back up the secrets-manager configuration and KMS recovery material using the
   provider's encrypted recovery procedure. Retain key identifiers and access
   policy versions in the encrypted manifest. Never place key material, session
   credentials or raw evidence in Git, the status report or CI logs.
5. Record database/archive and object-snapshot checksums, registry Git tags and
   hashes, migration versions, source commit, frozen clock/timezone and fixture
   inputs/outputs in an encrypted manifest. Encrypt the archive under a separate
   backup key, store it outside the source environment, and test access using the
   restore principal. Record retention/expiry and deletion-request watermark.
6. Execute the Restore procedure before marking this backup usable. Resume the
   source writers only after snapshot completion; a failed snapshot is unusable
   and must be retried from maintenance mode, not combined with another run.

## Executable test procedure

Run `pnpm test`. Once every suite worker has exited successfully, the harness
freezes writes and takes pg_dump plus a complete live-object logical snapshot.
Each mapping for the configured store must have bytes matching its source item's
content hash. The existing kms:test, kms:test-double and kms:live-test fixture
providers are counted separately, never as recovered objects; unknown provider
references fail the rehearsal. The test store is unversioned; production versioned snapshots must
also preserve the version history and deletion markers described above.

The logical snapshot uses source KMS authorization to decrypt object bytes into
an AES-GCM encrypted archive alongside the database dump. It saves the separate
backup key in a dedicated temporary recovery location, clears the original key
buffer, then restores from the saved archive and recovered key. The target store
uses its own independent KMS key. This logical recovery path needs the backup key,
not continued access to the source KMS principal. Production key custody uses the
operator's secret manager; temporary test keys are destroyed after the rehearsal.

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

