# Operations runbooks

The authenticated **Operations runbooks** screen is `/ops/runbooks`. It reads a
validated metadata report, uses `Cache-Control: no-store`, and renders the six
procedures without performing administrative writes. Set
`UNAI_OPERATIONS_REPORT_FILE` to the published report's absolute path.

No new design entity is introduced. These operations exercise existing
connectors, registry_migration_manifests, projection_rebuild_receipts,
retention_and_deletion_requests, source_items, evidence_object_keys,
context_packets, answer_manifests, briefing_editions and briefing_items.

## Executed procedures

All six were executed on 2026-09-19 in a synthetic test environment using the
required default `pnpm test`. An earlier successful
`node scripts/verifier-rehearsal.mjs 'pnpm test'` run also exercised the delivered
PostgreSQL server used by the verifier. It exited 0: 925 passed, four live-provider skips, all twenty
original acceptance scenarios passed, and the coordinated restore passed.

| Procedure | Runbook | Result |
| --- | --- | --- |
| Backup | [backup.md](backup.md) | PASS: coordinated encrypted database and live-object archive; independent recovery-key read. |
| Restore | [restore.md](restore.md) | PASS: empty database and independent empty encrypted store; 79 tables, 103 objects and 20 answer digest pairs matched. |
| Deletion | [deletion.md](deletion.md) | PASS: AC44.18 export/deletion, derived-data invalidation and no-retrieval assertions. |
| Registry migration | [registry-migration.md](registry-migration.md) | PASS: migrating release and its manifest persisted in a disposable database. |
| Projection rebuild | [projection-rebuild.md](projection-rebuild.md) | PASS: drop/recreate/replay reproduced projection rows. |
| Connector revocation | [connector-revocation.md](connector-revocation.md) | PASS: real API/database, simulated provider revocation; subsequent sync refused. |

[Execution record](execution-2026-09-19.json) includes each command, UTC date,
result and test name. [Recovery record](coordinated-recovery-2026-09-19.json)
retains table digests, object count, archive digest and the twenty distinct
source/restored digest pairs. These dated records describe an observed run;
the publisher requires fresh evidence bound to the current workspace.

## Recovery regression and scope

The default `pnpm test` now always performs coordinated recovery after its full
suite passes. There is no opt-in flag and no configured-database skip. Missing
backup tools, a failed restore, a missing fixture or any output mismatch fails
the command. A delivered server uses host PostgreSQL clients, or the pinned
PostgreSQL tooling image when those clients are absent. A runner without Docker
can use delivered PostgreSQL, installed matching clients and the TLS/KMS fallback
object store; that store now supports complete snapshot enumeration.

The source is quiescent after all suite workers finish. Recovery reads the saved
AES-GCM archive and a separately saved backup key into a genuinely empty database
and independent encrypted store. It checks every table and every snapshotted
object byte before calling the same Context Broker, deterministic Ask composer,
Today builder and Why readers against each environment. Fixture state is never
reseeded in the target. Both environments use the same clock, frozen after source
fixture writes, identities, timezone, questions and purposes.

The twenty probes map explicitly to the owners populated by the original
AC44.01–AC44.20 suites in `scripts/recovery-acceptance.mjs`. They compare the
fixtures' terminal persisted states, not a rerun that invents fresh identities.
AC44.05 also compares the owner-wide assertion read and its independent-verification flag. AC44.10 additionally compares corrected-historical and historical-belief reads
for 2025-08-07. Complete packet bodies, selections, source IDs, facts, certainty
labels, supplied-context manifests, watermarks, Today output and Why panels are
compared. Only newly generated packet/briefing receipt IDs and the derived packet
hash differ; each persisted packet's hash is independently checked by the
production reader. The new packet's policy receipt ID is normalized separately;
the policy verdict and reason remain in the comparison. Existing persisted
answer manifests are also included in the exact database snapshot comparison.

Fixtures include synthetic and test-double evidence ports. The coordinated
archive preserves the actual test store's live objects; synthetic in-memory
ports from earlier fixture setup are not represented as production object-store
verification. The latest execution separately counted 285 such mappings and
verified all 103 configured-store mappings against source content hashes.
Unknown provider references fail the rehearsal. The logical object snapshot is re-encrypted under the target KMS;
source KMS credentials are not needed during recovery. The test key is removed
after recovery. This retained test archive is not a production recovery package.
Production version history, deletion watermarks, credential rotation and
provider key custody remain covered by the runbooks.

## Publishing and release gate

```text
node scripts/local-policy-audit.mjs
pnpm test
pnpm ops:report
pnpm check:v0-release
```

`ops:report` publishes `test-results/operations/status.json`. Test and dependency
receipts must match the current workspace fingerprint. Backup/restore execution
requires the current coordinated receipt and archive checksum; malformed,
partial, stale or missing evidence cannot show PASS. `release-input.json` holds
operator-supplied ADR, defect and hosted-CI evidence. The dated recovery record
above is not silently substituted for a fresh run.

[ADR index](../adr/INDEX.md) and [128-requirement inventory](adr-inventory.json)
retain the initial decisions, explicit deviations, test links and available Git
history. [ADR 0035](../adr/0035-historical-deviation-inventory.md) is explicitly
retrospective. No ADR was backdated. The defect tracker query returned zero open
issues, including zero P0/P1 correctness or security defects; see the
[dated tracker observation](defect-triage-2026-09-19.json).

The workflow defines lint, unit, property-based, registry lint, registry contract,
connector integration, security, corpus and end-to-end stages. It retains build,
shadow-diff, private-corpus protection, status and artifact checks. Local policy
inspection checks installed dependencies as well as manifests and lockfile;
Cordum and CAP are not required.

Two assigned boundary checks remain **UNVERIFIED**, **MINOR**, deferred to the
operator-run phase-exit gate, **not waived**, under the recorded operator ruling:

- `hosted-main-pipeline-deferred` (CRT-QA-01-A): the complete hosted `master`
  pipeline can only certify this change after integration and publication.
- `adr-predating-unsatisfiable` (CRT-OPS-02-A): a new record cannot predate an
  already implemented change. The dated inventory records that limitation.

The release checker continues to fail on those missing boundary proofs; it has
not been weakened to turn deferral into PASS. This node's gate remains its six
assigned criteria and `pnpm test`, with those operator-authorized deferrals
reported durably. The daemon's independent verifier supplies acceptance proof.
Real-account connector and private-corpus verification remain separate dependency
and product checks; their absence is never counted as successful live evidence.


[Local CI execution record](local-ci-2026-09-19.json): all nine named stages and
the retained build, shadow-diff and corpus-status checks exited 0. Hosted default-branch
certification remains deferred, not inferred from these local results.
