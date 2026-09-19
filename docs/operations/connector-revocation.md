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
