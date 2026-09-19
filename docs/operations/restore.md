# Restore

Prerequisites: a completed encrypted backup manifest, recovery principal, matching
PostgreSQL/pgvector versions, an empty isolated database and empty evidence store,
the pinned application commit and registry tags, and network isolation from real
connectors. Do not restore over a running environment.

1. Check archive/snapshot checksums before opening them. Recover backup and KMS
   keys from the secrets manager under the documented recovery policy. Verify
   source commit and registry hashes. Refuse absent or mismatched artifacts.
2. Verify the target has no application tables or objects. Create required roles
   from the pinned SQL migrations on a separate bootstrap database if necessary;
   restore role definitions/grants without restoring source login credentials.
3. With PGSSLMODE=verify-full and the trusted CA, restore the database using
   `pg_restore --exit-on-error --single-transaction --dbname "$UNAI_RESTORE_DATABASE_URL" database.dump`.
   The target must be empty. Never use --clean against an existing environment.
4. Restore the versioned object snapshot into the empty encrypted target store.
   Map the recovered KMS key handles in the target secrets manager. For every live
   object-key mapping, read/decrypt the target object and compare its content hash.
   Compare canonical tables, migrations, immutable registry snapshots, owner
   sequences and projection/overlay watermarks against the manifest.
5. Apply deletion requests newer than the backup watermark before any user read;
   verify that the deletion cascade leaves no searchable or retrievable payload.
   Keep connectors disabled and replace/revoke restored sessions and credentials.
6. Using the same frozen clock, timezone, identities and fixture inputs, run every
   AC44.01 through AC44.20 read against source and restored environments. Compare
   Today output, Ask statements, certainty labels, source links, explanation,
   packets and manifests. Strip only explicitly documented request IDs/timing
   fields, never facts, sources, outcomes, labels or completeness watermarks.
   Record one pair of SHA-256 digests per fixture plus the comparator version.
7. Publish the metadata-only restore receipt. Any mismatch blocks cutover; retain
   the isolated target for diagnosis and recover from a new backup. Activate the
   restored environment only after the operator reviews all comparisons.

## Executable test procedure

Run `pnpm test`; the restore assertion is part of the default command. It creates
a unique empty database, proves there are no application tables, and performs
pg_restore with exit-on-error and a single transaction. It creates an independent
empty encrypted object store, recovers the separately saved backup key, reads the
saved archive, re-encrypts objects under the target KMS and verifies every byte.
All database table contents are compared before generating any new read receipts.

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
