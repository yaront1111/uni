# Connector revocation

Use a synthetic connector in the isolated test environment, or a disposable real
test account whose token is explicitly authorized for revocation. Record the
connector ID, granted capabilities and ingestion cursor; never record its token.

1. Open Connected sources (`/connectors`), review retained-evidence choices and
   disconnect the connector. The owner request is
   POST /v1/connectors/{id}/disconnect with purpose connector.manage.
2. Verify provider revocation succeeded, the secret handle was destroyed, all
   capability grants were revoked and connector status is DISCONNECTED. A failed
   provider revocation is not a completed disconnect and must be investigated.
   The exception is OMI: Uai never revokes an Omi key, so its receipt reports no
   provider revocation by design (see Omi below).
3. Trigger a subsequent sync and confirm no provider request or new ingestion
   occurs. Verify retained evidence stays readable unless the separate Deletion
   workflow was explicitly selected. Record the revocation audit event.
4. Recovery is explicit reauthorization with a new secret handle and newly
   reviewed grants; never resurrect a revoked token from backup. Verify a resumed
   sync uses the retained cursor and duplicate suppression.

Test execution: `node scripts/test.mjs --stage connector-integration` or
`pnpm test` runs connectors.test.ts's CRT-CON-06-A second-sync/disconnect case.
It uses the real API/database with a simulated provider revocation receipt.
The separate connectors.live.test.ts requires the documented real-account secret
handles and UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION=true. Its default skips are not
evidence of live provider revocation and must remain reported as such.

## Omi (connector type OMI)

This implements ADR 0041 D8. Uai never revokes an Omi developer key:
DELETE /v1/dev/keys/{key_id} needs a Firebase ID token, which Uai does not hold.

The disconnect receipt is 200 with tokensRevokedAtProvider false,
secretReferenceDestroyed true and providerRevocationNotice
CONNECTOR_REVOCATION_MANUAL_REQUIRED. That is the expected answer, not a failed
revocation. Uai stops ingestion, revokes every capability grant and forgets the
handle without resolving the key or calling Omi. Connected sources then shows
/connectors?disconnected=<id>&notice=CONNECTOR_REVOCATION_MANUAL_REQUIRED with
the D8 sentence.

1. The owner revokes the key in the Omi app under Settings > Developer.
2. The operator removes the stored secret that the handle named from the
   deployment's secret store, for example the mounted file. @unai/secrets has no
   delete operation.
3. Trigger a sync and confirm it answers 409 CONNECTOR_INGESTION_STOPPED and
   makes no provider request.

Test execution: omi-connector.test.ts case 7, now in the connector-integration
stage, and omi-pipeline.test.ts case 4 (disconnect while SYNC_FAILED). The live
case ADR-0041-LIVE-A never disconnects.
