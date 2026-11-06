# packages/connectors

`@unai/connectors` owns the required V0 connectors (PRD §27.5), their capability
grants and the connector lifecycle. Report: `docs/connectors.md`; decisions:
`docs/adr/0023-connector-capabilities-required-connectors-and-lifecycle.md`.

## Local invariants

- **A connector produces evidence and nothing else.** No file here imports the
  belief-transaction path, a projection, the model gateway or the object store.
  Ingestion and job enqueueing are ports (`SourceIngest`, `ExtractionEnqueue`) the
  API composition supplies, which is what `src/boundaries.test.ts` checks
  (CRT-CON-09-A). That test also treats this package as the plugin runtime
  (CRT-RD-01-A): it may read no memory table itself. Memory reads go through
  `@unai/context` (`buildPluginContextBundle` uses the broker; `hasOpenThread`
  uses `listOpenThreadIds`).
- **Authority is per capability.** `requireCapability(tx, connectorId,
  capabilityId)` is the only enforcement point, it reads one row, and nothing
  widens a grant to a sibling. Adding an implication between capabilities breaks
  CRT-CON-07-A.
- **V0 is read-only.** `assertReadOnly` runs at every provisioning, the manifests
  offer no `WRITE` capability, and the schema refuses a granted one. A write
  capability is refused *by name* (`CONNECTOR_WRITE_SCOPE_REFUSED`) so the consent
  screen can say which.
- **OMI (ADR 0041; report `docs/omi-connector.md`).** `connector.omi` has one READ
  capability, `omi.read_conversations` (scope `conversations:read`). Its client
  only GETs `https://api.omi.me/v1/dev/user/conversations`. The OMI branch of
  `createTokenRevoker` answers `manualRevocationRequired` before it resolves any
  secret (D8): Uai cannot revoke an Omi key.
- **Capability narrowing happens on the raw payload** (`prepareForCapabilities`),
  before parsing and therefore before hashing, so the stored content hash
  describes exactly what was read.
- **Parsers are pure.** Aggregation (the GitHub episode) and threading live in
  `@unai/domain`'s `sources.ts`; nothing here re-derives them.

## Traps

- `runConnectorSync` must run under `connector.sync`. That purpose may move the
  cursor and store evidence, and migration 0018's trigger refuses it any change to
  `secret_ref`, the permission manifest or the disconnect state — so consent
  changes and `markTokenRevoked` run under `connector.manage`.
- A failed run is recorded by `recordSyncFailure` in a **separate** transaction:
  the run it failed has been rolled back.
- Lock order: every lifecycle writer (`setCapabilityGrants`, `markTokenRevoked`,
  `disconnectConnector`) takes the connector row `FOR NO KEY UPDATE` as its first
  read, before its status check, and only then touches grant rows. Never
  `FOR UPDATE`: it conflicts with the `KEY SHARE` locks evidence inserts hold, so
  a writer would wait for a whole multi-page run. The sync's commit point re-reads
  status and then grants under the same lock. `recordSyncFailure` records neither
  `CONNECTOR_INGESTION_STOPPED` nor `CONNECTOR_CAPABILITY_NOT_GRANTED` (see
  `docs/connectors.md`, "Concurrent syncs and lifecycle changes").
- An Omi 429 fails the whole run, which is one transaction: pages read earlier
  roll back and the next run reads them again, suppressed as duplicates. Never
  sleep inside the transaction to wait out `Retry-After`.
- `searchDocuments` relies on the row policies for owner, purpose and sensitivity;
  it adds no `WHERE` for them on purpose, so the isolation suite covers it.
- Adding a capability means adding it to the manifest **and** to every existing
  connector's grant rows through a consent operation; `createConnector` writes the
  rows a manifest declares at provisioning time only.
