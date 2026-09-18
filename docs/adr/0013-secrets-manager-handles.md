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
`accessibility-audit-trail-and-security-test-suite`.
