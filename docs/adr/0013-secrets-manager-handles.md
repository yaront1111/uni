# ADR 0013: Secrets-manager handles for runtime credentials

Date: 2026-09-18
Status: Implementation decisions recorded with the code

Authority: goal-b2cc3b54-1876-401e-a6a2-527f99b679bc design v1,
contract-uai-v0/rev-uai-v0-001. This ADR records an addition, not a deviation:
PRD section 28 names no secrets component, and adding one removes nothing the
section requires. No graph database and no separate vector database is
introduced, so CRT-NFR-07-A stands unchanged. Earlier ADRs 0001 through 0012
stand unchanged.

The foundation node's objective names a secrets-manager handle for credentials.
Before this decision, every runtime credential was a literal deployment
configuration value: the low-privilege database URLs carried their passwords in
`UNAI_APP_DATABASE_URL` and `UNAI_AUTH_DATABASE_URL`, and the sign-in secrets in
`NEXTAUTH_SECRET` and `GOOGLE_CLIENT_SECRET`. A literal credential in the
environment is readable from a process listing, a container inspect output, a
crash report and any log that dumps configuration, and it cannot be rotated
without restarting with a new environment.

`@unai/secrets` replaces the literal with a handle:
`secret://<provider>/<name>[#<field>]`. The handle is a reference, never
material, so it is safe to record in configuration, in an error and in a
deployment manifest. The optional field selects one member of a structured JSON
secret, which is how AWS Secrets Manager and Vault commonly store a database
credential. Resolution happens once at service startup.

Configuration that holds anything other than a handle is refused with
`SECRET_HANDLE_REQUIRED`, so a pasted password fails the service loudly instead
of quietly becoming the credential. A reference that tries to leave its
provider's namespace is refused by the handle grammar and again by the mounted
provider before any read. Every failure carries a stable code and the handle
only; provider error text is replaced with `SECRET_PROVIDER_FAILED` because it
can quote the file contents it failed on.

The manager stays independent of one secrets vendor, for the same reason the PRD
requires a provider-independent model gateway. Providers are registered by name:
the bundled `mounted` provider reads the directory named by
`UNAI_SECRETS_MOUNT`, which covers a Kubernetes projected secret volume, a Vault
Agent template and a decrypted secret mount, and a deployment on AWS Secrets
Manager or Vault HTTP registers its own provider at startup without changing a
caller. No vendor SDK is therefore a dependency of this package.

Scope boundary: this ADR covers the platform's own runtime credentials, held by
the API service and the web process. Per-connector credentials are a different
thing: PRD section 30.5 (Storage security) is what requires a secrets manager
for connector credentials, and the `connectors` entity and its lifecycle are
bound by the sealed plan to node
`connector-capabilities-required-connectors-and-lifecycle` through
CRT-CON-01-A..CRT-CON-07-A, so that node owns the connector credential
lifecycle. The design places `secret_ref` on the `connectors` entity. That node
can resolve a `secret_ref` through this same manager, and nothing here presumes
its design. The check that no secret reaches a log or a prompt, CRT-SEC-05-A, is
likewise another node's: the sealed plan binds it to
`accessibility-audit-trail-and-security-test-suite`. Which handles a connector
may name is settled by the amendment below.

## Amendment 2026-11-07: the connector-credential namespace (task-745f1c219aa54d7393f626702266082f)

**Threat.** PRD section 31 lists "unauthorized connector token use", and
section 30.5 requires connector credentials to sit in a secrets manager. Until
this amendment a connector's `secret_ref` could name any handle at all. A sync
or a token revocation would then resolve, and send to Google, GitHub or Omi, a
runtime credential such as `secret://mounted/api-database-url` or another
owner's connector token.

**Namespace rule and handle shape.** A connector credential handle is
`secret://<provider>/connectors/<ownerScopeId>/<label>[#<field>]`.

- `<ownerScopeId>` is the owner scope's UUID in lowercase canonical form,
  exactly as PostgreSQL prints a `uuid`. The handle's segment is compared
  exactly and never case-folded: the mounted provider is case-sensitive on
  Linux, the database can compare against
  `'connectors/' || owner_scope_id::text || '/'`, and a cache key cannot fork
  on case.
- `<label>` is one or more name segments under the `@unai/secrets` grammar.
  Any provider and an optional `#<field>` are allowed.
- The rule is code in `@unai/connectors`, not in `@unai/secrets`:
  `packages/connectors/src/credentials.ts` exports `connectorCredentialHandle`,
  which builds a handle, and `isConnectorCredentialHandle`, which decides
  membership. `@unai/secrets` owns only the handle grammar and must not own
  connector credentials (`packages/secrets/CLAUDE.md`).

**Mount layout.** The file is `<mount>/connectors/<ownerScopeId>/<label>` in
both the api and the worker mount, under ADR 0043 D6's rules: one mount per
process, directories root:unai-<process> 0750, files 0640. This supersedes
D6's `secret://mounted/connectors/<name>` row for connector tokens. Slice 4/6
moves the runbook and the deploy rehearsal; the epic's final docs sweep
updates the D6 table.

**Runtime credentials never live under `connectors/`.** Every D6 runtime handle
sits outside it: the database URLs, the sign-in secrets, the Google connector
OAuth client `google-connector-client` and the model key. The namespace and
the runtime handles are therefore disjoint, and a prefix decides membership.

**What the database admits now.** Migration 0048 replaces the
`connectors.secret_ref` CHECK, keeping its name `connectors_secret_ref_check`.
The new check accepts every value the 0018 check accepted, plus every handle
`@unai/secrets` parses (`/`-separated names of up to 256 characters, a field of
up to 64). It still refuses an empty, `.` or `..` segment, a leading or
trailing `/`, and whitespace. It binds no owner: that is layer 2 below.

**Four enforcement layers, added by later slices.** Each refusal carries only
its code, never the handle, the owner scope or database text.

1. Create-time refusal. `createConnector`, and so `POST /v1/connectors`,
   refuses a non-null `secretRef` outside the caller's namespace with
   `CONNECTOR_SECRET_REF_OUT_OF_SCOPE` (403) before any query. The refusal is
   audited like the other connector refusals.
2. A database trigger `BEFORE INSERT OR UPDATE OF secret_ref` on `connectors`.
   It refuses a new non-null value outside `connectors/<owner_scope_id>/`, and
   its SQL agrees with `isConnectorCredentialHandle` over one shared vector
   list. It is a trigger and not a CHECK, so unrelated updates of a legacy row
   (status, cursor, `last_sync_error`) keep working.
3. A connector-only resolver bound to the caller's owner scope. Every provider
   client (Gmail, Calendar, GitHub, Omi) and the token revoker use it, and it
   refuses an out-of-namespace handle before any secret is read.
4. The Google access-token cache is keyed by owner scope plus handle, so an
   access token minted for one owner's handle never serves another.

**Why the handle is not bound to the connector id.** The credential is
provisioned (`pnpm connect:google`, `pnpm secret:put`) before the connector row
and its id exist. The owner scope is already known at provisioning, and it is
the isolation boundary every row policy enforces. Within one owner, which
connector uses which of the owner's credentials is the owner's own consent
decision under `connector.manage`.

**Legacy rule.** A stored handle outside the namespace is never resolved. A
sync refuses it with `CONNECTOR_SECRET_REF_OUT_OF_SCOPE`. A disconnect
completes without resolving or sending it and reports
`CONNECTOR_REVOCATION_MANUAL_REQUIRED`, so the operator revokes that token at
the provider by hand. No migration rewrites stored handles.
