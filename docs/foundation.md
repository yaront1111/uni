# Phase 0 foundation: implementation and remaining verification

Authority: contract-uai-v0 / rev-uai-v0-001, digest
22027aaaeea527eb7b1d2ae3dab70bfabda8ff13c660bf0e0839356f91fe1339;
design goal-2cf9472a-d972-4e97-88cf-1734639d9700@v1. All approved
contract and design pages were read with revision pins. ADR 0008 records the
operator's delegated authentication and responsive-web choices before code.
ADR 0001's open-choice blocker is resolved. No native-mobile scope is added.

## Delivered surfaces and entities

The assigned Sign-in and device registration screen has signed-out, signing-in,
desktop, phone, expired-session and refused-authentication states. The Next.js
Pages Router app has responsive styles, labeled forms, keyboard focus, status
announcements and the common navigation shell. Future surfaces are visibly
disabled until their owning nodes deliver them; no additional screen is invented.

Implemented design entities: users, owner_scopes, owner_scope_members, devices,
and shared audit_events. auth_identities and auth_sessions are authentication
infrastructure recorded by ADR 0008, not new product screens. The phone and
desktop resolve the same personal owner scope through issuer/subject identity.
Owner-sequence allocation remains with uai-overlay-projections (CRT-RYW-01-A);
this node does not fabricate that downstream behavior or a completed journey.
Audit log UI and whole-system audit coverage remain with uai-production-operations.

The stack includes TypeScript/pnpm, Next.js, Fastify, Zod, PostgreSQL/pgvector,
Git SQL migrations, the encrypted S3 adapter and OpenTelemetry primitives. Domain
code is independent of UI/provider packages. Production composition is in
packages/api/src/platform.ts and apps/web. Mocks and controlled OAuth credentials
exist only in tests.

## Authentication and devices

Google Auth.js requests only openid/email/profile. Google issuer and subject
identify accounts; matching email never merges accounts. Auth.js verifies OAuth
state, PKCE and nonce. Production discovery is pinned to Google; the local
identity server in oauth.test.ts is a test-only override.

The __Host-unai.session cookie is Secure, HttpOnly, SameSite=Lax and Path=/.
Database storage contains only a SHA-256 digest of its random 256-bit token.
The database caps expiry at seven days; adapter updateSession cannot extend it.
Auth.js may refresh the browser cookie expiry, but the server rejects the token
at its original database deadline. Logout revokes one session, sign-out-all
revokes all, disabled users lose every session permanently, and device removal
atomically tombstones the device and revokes associated sessions.

The auth login is granted unai_auth, which has only fixed-function EXECUTE grants
and no direct application-table privileges. The application login is granted
unai_app, with no ownership, superuser or BYPASSRLS authority. Forced RLS protects
all seven application tables. Application membership and exact route purpose
checks run independently of authentication. Session tokens/digests are absent
from public DTOs and audit payloads.

Device APIs: GET /v1/devices (device.list), POST /v1/devices (device.register),
POST /v1/devices/{id}/revoke (device.remove), and POST /v1/sessions/revoke-all
(auth.sign_out_all). Each requires the session cookie, x-owner-scope-id,
x-purpose and UUID x-correlation-id; writes also require idempotency-key.
Registration serializes on the session row: retries return its existing device,
and changed registration input is refused. The same-origin web proxy derives
owner scope from the verified session and rejects cross-origin writes.

Successful device operations and audit events commit together. Session creation
and revocation also append real audit rows. Existing transaction commit-tag,
rollback, closed-capability and pool-reuse protections remain intact. API and
database telemetry contains bounded identifiers and outcomes, never payloads,
cookies or raw provider errors. Deployment supplies the OpenTelemetry exporter.

## Run and configure

Prerequisites: Node 24, pnpm 11.0.8, Docker and OpenSSL. The full test command
starts disposable PostgreSQL/pgvector with temporary storage and test-only
credentials; it is not the persistent development or production database. A
runner that provisions its own throwaway PostgreSQL/pgvector server instead sets
UNAI_TEST_DATABASE_URL or DATABASE_URL, and pnpm test migrates and runs the whole
suite against that server rather than starting its own container. The suite
creates and drops databases and roles, so never point it at a real database.

On a delivered server each run creates a disposable database of its own,
migrates it, and drops it afterwards, so the run never inherits rows an earlier
run left behind: the registry 0.1.0 snapshot is immutable and its version is
unique, so a release published once could otherwise decide whether a later run
passes. A server that refuses the database falls back to the delivered one and
says so. Database roles are cluster-global rather than per-database, so
migrations 0001 and 0002 create unai_app and unai_auth only when absent and then
assert their attributes unconditionally, which also repairs a role a cluster
already carries with weaker attributes than the owner boundary requires.

Object storage is delivered the same way. A runner that provisions its own
throwaway encrypted S3-compatible bucket sets UNAI_TEST_S3_ENDPOINT,
UNAI_TEST_S3_BUCKET and UNAI_TEST_S3_KMS_KEY_ID, plus its credentials and
NODE_EXTRA_CA_CERTS, and pnpm test uses that bucket and starts no MinIO
container. Delivering only part of that set is refused rather than silently
half-used. The suite writes and deletes test objects, so never point it at a
real bucket. Without a delivered bucket pnpm test serves real TLS and
KMS-encrypted object storage itself: disposable MinIO when a container daemon
answers, and the in-process S3-compatible server in scripts/s3-object-server.mjs
when none does. The storage tests always run against a real endpoint over TLS;
none of these is a production store. Database probing and the Git migrations run
before any harness starts, and each provisioning step fails under its own name,
so a storage failure is never reported as a database or migration failure.

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm validate:registry
```

pnpm validate:registry lints the Git registry release 0.1.0 against its recorded
content hash. Registry release, tagging and snapshot publication are documented
in docs/registry.md and ADR 0011.

For a persistent environment, provision self-managed PostgreSQL/pgvector on an
encrypted volume with encrypted backups, TLS and a privileged migration owner.
The existing SECURITY DEFINER functions require that trusted owner to bypass
forced RLS. Never use its credentials for either runtime login. The prospective
managed-database role change in ADR 0009 was rejected by automatic approval
review and was not implemented. Managed RDS compatibility is not established.

Run pnpm db:migrate with UNAI_MIGRATION_DATABASE_URL and UNAI_DATABASE_CA_PATH.
The CLI applies every Git migration, checks immutable migration digests, and
validates ownership coverage. Create separate LOGIN roles granted only unai_app
or unai_auth, with credentials supplied through the deployment secret system.

Credentials are configured as secrets-manager handles, never as literal values
(ADR 0013). A handle is `secret://<provider>/<name>[#<field>]`; the optional
field selects one member of a structured JSON secret. The bundled `mounted`
provider reads the directory named by UNAI_SECRETS_MOUNT, which covers a
Kubernetes projected secret volume, a Vault Agent template and a decrypted
secret mount. A deployment on a different secrets manager registers its own
provider with createSecretsManager and changes no caller. A runtime service
refuses to start when a credential variable holds anything but a handle, so a
password cannot reach a process listing or a crash report through configuration.

Set these application environment variables before starting services:

- UNAI_SECRETS_MOUNT: directory where the deployment's secrets manager exposes
  secrets to the `mounted` provider.
- UNAI_APP_DATABASE_URL and UNAI_AUTH_DATABASE_URL: handles for the respective
  low-privilege URLs, for example
  `secret://mounted/runtime/app-database#url`. The resolved URL carries no query
  option that downgrades certificate verification.
- UNAI_DATABASE_CA_FILE: trusted PostgreSQL CA file for runtime services.
- NEXTAUTH_URL: canonical HTTPS web origin, including the port when nonstandard.
- NEXTAUTH_SECRET: handle for a session secret of at least 32 characters.
- GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET: configured Google OAuth application;
  the client identifier is plain configuration and the client secret is a handle.
  Register NEXTAUTH_URL + /api/auth/callback/google as its callback URL.
- UNAI_WEB_TLS_KEY_FILE and UNAI_WEB_TLS_CERT_FILE: web listener TLS files.
- UNAI_API_TLS_KEY_FILE and UNAI_API_TLS_CERT_FILE: API listener TLS files.
- UNAI_API_ORIGIN: HTTPS API origin (default listener port is 3443).
- UNAI_API_CA_FILE: CA used to verify the API certificate.
- Optional UNAI_API_PORT, UNAI_API_BIND and UNAI_WEB_BIND; binds default to loopback.

Run pnpm start:api and pnpm dev:web in separate terminals for local development;
use pnpm build followed by pnpm start:web for production. Web and API use actual
TLS listeners. Forwarded headers cannot turn plaintext into an authorized API
connection. The deployed hostname must match the configured web origin. Obtain
trusted certificates for the chosen development hostname; no TLS bypass exists.

For S3, create a private bucket encrypted with the configured KMS key, deny
insecure transport and uploads without that key, and grant only the deployment
identity's necessary permissions. The existing adapter verifies bucket settings
and each read/write encryption receipt. Its resolver must authorize owner and
purpose and map public UUIDs to private keys. The evidence-owned resolver remains
with the later evidence service; the foundation does not manufacture source_items.
Actual bucket policy, encrypted-volume and backup evidence is not available.

## Verification and acceptance limits

Latest observed checks on 2026-09-18: pnpm test passed 325 tests in 31 files,
both against its own container and against a delivered UNAI_TEST_DATABASE_URL;
pnpm typecheck passed for backend and web; the optimized Next.js build passed.
The delivered-server run was observed repeatedly on one server, including against
a database already migrated and already holding a conflicting registry 0.1.0
release and a cluster already carrying unai_app and unai_auth: 325 passed and
exit 0 each time, and a unai_app left with BYPASSRLS and SUPERUSER was returned
to NOBYPASSRLS and NOSUPERUSER by the migration.
New schema/lifecycle, adapter, device-route and screen tests were observed failing
before their implementations. The controlled OAuth test performs a real HTTP
token exchange, signed ID-token verification, tampered-state refusal and logout
against PostgreSQL. Restricted-login and unfiltered cross-owner checks cover the
new auth tables and deny digest access. These are not a production Google login,
browser end-to-end acceptance or deployment-encryption receipt.

pnpm validate:registry now exits 0 and lints release 0.1.0 with its recorded
content hash, so the earlier REGISTRY_RELEASE_MISSING phase-exit failure recorded
here no longer reproduces. No configured check was skipped or replaced, and no
synthetic release was created. Registry release contracts themselves remain the
registry node's criteria (CRT-REG-01-A/B, CRT-REG-03-A, CRT-OUT-01-A), not a
foundation deliverable.

Assigned criteria remain CRT-NFR-07-A, CRT-OPS-02-A, CRT-SEC-01-A and CRT-SEC-08-A.
The latter still needs real encrypted database/backup and object-store deployment
configuration evidence. The reference-stack requirement also mentions the
PostgreSQL queue owned by uai-evidence-jobs (CRT-NFR-02-A); its absence is not
represented as implemented here. Node acceptance, phase exit and whole-product
acceptance are distinct. The daemon's independent verifier remains authoritative.
