# Credential rotation

Follow [ADR 0043 D6](../docs/adr/0043-production-deployment-target.md#d6-secrets-layout-and-handles)
and the [Secrets procedure](README.md#secrets). Commands are for root Bash in
`/opt/unai/current`; replace placeholders. Turn off tracing and terminal recording.
Never put a secret in argv, Git or logs. Use `read -rs v` and builtin `printf`:

```bash
read -rs v && printf '%s' "$v" | UNAI_SECRETS_MOUNT=/etc/unai/secrets/api pnpm secret:put '<name>' --replace
unset v
```

Select the appropriate mount. Every `--replace` writes a **fresh root-owned
0600 file**: restore root:unai-\<process\> 0640 with `chown`/`chmod`, then
`install -o root -g unai-<other> -m 0640 '<source>' '<other-copy>'` for shared
secrets. Do not use `install` with the source and destination being the same file.
Recheck modes and readiness before retiring old issuer credentials.

For database passwords, use a brief maintenance window: stop both timers and
wait for active backup/drill services first, as [the upgrade cautions](README.md#upgrade)
require. Generate a new value with `openssl rand -hex 32`, never in a command
argument. Change the matching `\set` line in `/root/unai-provision.psql` using a
root-only editor with swap/backup files disabled, then re-run:

```sh
cat /root/unai-provision.psql /opt/unai/current/deploy/postgres/provision.sql \
  | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -f -
```

That sets all five passwords; unchanged values keep their logins working.
If the variables file is gone, use `sudo -u postgres psql -X -c '\password <role>'`
and type the new value at its prompt; do not re-run an obsolete variables file
later. A password change preserves established PostgreSQL connections but
rejects new connections with the old password. Restore timers when done.

## unai_api_login database password

**Change.** Provisioning is the issuer. First replace
`/etc/unai/secrets/api/api-database-url` using `pnpm secret:put api-database-url --replace`
and the common stdin recipe. Keep login `unai_api_login`, loopback/database and
TLS unchanged. Set 0640/root:unai-api; then update `api_login_password` and run
the provisioning pipeline with the same new password.

**Restart.** Immediately `systemctl restart unai-api.service`; its database URL
is resolved once at startup. Confirm API readiness. File replacement alone
does not update the running pool.

**Invalidated.** Old-password new connections fail after provisioning. Existing
connections live until closed; session rows and evidence are not erased.

## unai_worker_login database password

**Change.** First replace `/etc/unai/secrets/worker/worker-database-url` with
`pnpm secret:put worker-database-url --replace` in the worker mount, retaining
login `unai_worker_login`. Restore root:unai-worker 0640. Update
`worker_login_password`, then re-run provisioning.

**Restart.** Immediately `systemctl restart unai-worker.service`; the worker
resolves its URL once, when creating its pool. Require its readiness check.

**Invalidated.** Old credentials cannot open new connections. Existing ones
persist until shutdown. Durable jobs and processing checkpoints remain.

## unai_auth_login database password

**Change.** First replace `/etc/unai/secrets/api/auth-database-url` using
`pnpm secret:put auth-database-url --replace`, retain `unai_auth_login`, set
root:unai-api 0640, and install the same value at
`/etc/unai/secrets/web/auth-database-url` as root:unai-web 0640. Update
`auth_login_password`, then run provisioning.

**Restart.** Immediately `systemctl restart unai-api.service unai-web.service`.
API resolves the URL at startup; web caches one auth pool per process
(`apps/web/lib/server.ts`). Require API readiness and a successful signin read.

**Invalidated.** New connections with the old password fail. Existing database
sessions are not revoked; the application pool restart does not delete them.

## unai_migrator database password

**Change.** Update `migrator_password` and re-run provisioning. Update both
`/root/.pgpass` and `/etc/unai/restore-drill/pgpass` to that password using the
README's private stdin recipe, retaining root:root 0600. The former names
database `unai`; the latter uses `*`. Never put the password in migrate.env.

**Restart.** None: migration, publication and drill invocations read pgpass
on each run. Let in-flight operations finish before changing the files.

**Invalidated.** Old-password new migrator connections fail; existing
connections continue. Migrations and published registry releases stay intact.

## unai_backup database password

**Change.** Update `backup_password`, run provisioning, then update
`/etc/unai/backup/pgpass` (unai-backup:unai-backup 0600), retaining database
`unai` and role `unai_backup`.

**Restart.** None; each backup reads pgpass. Finish any active backup first,
then run one manual backup after rotation and require PASS.

**Invalidated.** Old-password new connections fail. Existing archives and
their decryption keys are unaffected.

## NEXTAUTH_SECRET

**Change.** Generate and pipe a new value directly into the web mount:

```sh
openssl rand -hex 32 | UNAI_SECRETS_MOUNT=/etc/unai/secrets/web pnpm secret:put nextauth-secret --replace
chown root:unai-web /etc/unai/secrets/web/nextauth-secret
chmod 0640 /etc/unai/secrets/web/nextauth-secret
```

**Restart.** `authOptions` resolves it on every auth request, so restart is not
needed to pick it up. Nevertheless `systemctl restart unai-web.service` runs
the startup `--check` against the replacement.

**Invalidated.** In-progress sign-in state/PKCE cookies and CSRF tokens depend
on this secret (NextAuth 4.24.15); retry sign-in and refresh forms. **Existing
sessions do not end**: `packages/auth/src/index.ts` uses database sessions, not
JWT sessions. To end one, sign out on that device; rotation is not a substitute
for session revocation in an incident.

## Google sign-in client secret

**Change.** In Google Cloud's **Uai sign-in** Web application client, create a
second secret. Replace `/etc/unai/secrets/web/google-signin-client-secret`
using `pnpm secret:put google-signin-client-secret --replace` in the web mount;
restore root:unai-web 0640. Verify a fresh sign-in, then disable the old secret.
Do not change the Desktop connector client by mistake.

**Restart.** The secret resolves per auth request, not once. Restart
`unai-web.service` anyway for its preflight validation.

**Invalidated.** Sign-ins straddling the switch can fail; retry them. Existing
database sessions survive. This does not rotate connector refresh tokens.

## Google connector client

**Change.** In the **Uai connectors** Desktop app client, rotate its client
secret. Replace the JSON `google-connector-client` in the api mount using
`pnpm secret:put google-connector-client --replace`, restore root:unai-api 0640,
and install the worker copy as root:unai-worker 0640. Preserve `client_id`
unless deliberately migrating clients. Run one sync for each Google connector
before retiring the old secret when the issuer permits overlap.

**Restart.** None: `googleOAuthClient` resolves the mounted JSON on each token
exchange; the mounted provider reads the file on every resolve. In-flight
exchanges may still hold the old value.

**Invalidated.** A secret-only rotation need not revoke refresh tokens. If a
sync reports `invalid_grant`, repeat `pnpm connect:google --capabilities <ids>
--secret-name connectors/<ownerScopeId>/<label> --replace`, then repair both
copies as below.
A different client ID cannot use the old client's refresh tokens: reauthorize
every Google connector; revoke the old grants separately if retiring that client.

## Connector tokens

**Change.** `<ownerScopeId>` is the id [Connectors](README.md#connectors)
prints. For Google, use the laptop SSH tunnel and root API environment from
there, with `pnpm connect:google --capabilities <ids>
--secret-name connectors/<ownerScopeId>/<label> --replace`. For GitHub, issue a
replacement read-only fine-grained PAT and use
`pnpm secret:put connectors/<ownerScopeId>/github --replace`. For Omi, issue a
developer key limited to `conversations:read` and use
`pnpm secret:put connectors/<ownerScopeId>/omi --replace`. For **all three**,
restore api file ownership/mode and install the matching worker copy before
syncing. A token stored outside `connectors/<ownerScopeId>/` is not rotated in
place: follow the legacy steps in [Connectors](README.md#connectors).

**Restart.** None; tokens resolve on each sync. Verify a sync of every affected
connector. An in-flight sync may finish using its previous token.

**Invalidated.** A new file is not issuer-side revocation. Revoke the old GitHub
PAT after verification. If a Google grant may be compromised, revoke Uai access
at `myaccount.google.com/permissions` **before** the new ceremony; revoking a
shared grant afterwards can invalidate the new token too. Recheck all connectors
for that client/account. Revoke old Omi keys manually in Settings > Developer;
Uai's Disconnect cannot do it. See [revocation](../docs/operations/connector-revocation.md)
and [Omi](../docs/omi-connector.md).

## Model API key

**Change.** Create a new key in the same Anthropic workspace with its spend
limit. In the worker mount, `pnpm secret:put anthropic-api-key --replace`
using private stdin, then root:unai-worker 0640.

**Restart.** `systemctl restart unai-worker.service`: it resolves the model
provider once at startup (`packages/api/src/processing-worker.ts`). Verify
readiness and a permitted processing run before deleting the old key in the
Anthropic Console. A preflight alone is not a live-model verification.

**Invalidated.** Deleting the old issuer key refuses future calls with it.
Previously stored evidence, model-call records and durable jobs remain.

## AWS access keys

**Change.** Create a second IAM access key for the relevant user. Replace only
its shared-credentials file using the private two-prompt recipe in the README,
writing a temporary file with the final owner/mode and moving it over the old
file. There are five users, with distinct keys:

| IAM user | File | Owner/mode |
| --- | --- | --- |
| unai-api | `/etc/unai/secrets/api/aws/credentials` | root:unai-api 0640 |
| unai-worker | `/etc/unai/secrets/worker/aws/credentials` | root:unai-worker 0640 |
| unai-backup | `/etc/unai/backup/aws-credentials` | unai-backup:unai-backup 0600 |
| unai-restore-drill | `/etc/unai/restore-drill/aws-credentials` | root:root 0600 |
| unai-host-unlock | `/etc/unai/pgdata/aws-credentials` | root:root 0400 |

**Restart.** Restart `unai-api.service` or `unai-worker.service` for its key:
their S3 clients retain resolved non-expiring credentials. Backup, drill and
unlock read theirs per invocation, so need no restart. Verify with the actual
operation before deactivating and deleting the old key; do not unmount a live
database merely to test unlock. Use a controlled maintenance/reboot rehearsal.

**Invalidated.** Deactivating the old IAM key prevents later AWS requests using
it. It changes no KMS key, bucket encryption setting, archive key or database
password. Never widen the IAM policy to compensate for a misplaced file.

## Backup key

**Change.** Stop both timers and finish active runs. Preserve the current key's
**offline** copy with its archive date range. Create a replacement atomically:

```bash
(
  set -euo pipefail
  umask 077
  next=$(mktemp /etc/unai/backup/backup.key.new.XXXXXX)
  trap 'rm -f -- "$next"' EXIT
  head -c 32 /dev/urandom > "$next"
  chown unai-backup:unai-backup "$next"
  chmod 0600 "$next"
  mv -- "$next" /etc/unai/backup/backup.key
)
base64 /etc/unai/backup/backup.key
systemctl start unai-backup.service
```

Record the new offline copy privately **before** the backup command. Require
the backup PASS, then run the drill and restore both timers. Keep the old offline
key for at least 35 days after its last archive (longer for any retained archive).
Never put either key in the archive bucket, staging or a runtime secrets mount.

**Restart.** No process restart; the next backup/restore reads the key file.
Run that backup immediately because the drill reads the newest archive with the
current key. Until it completes, the newest archive still needs the old key.

**Invalidated.** Old archives do not change and decrypt only with their original
key. A mismatched key fails `RESTORE_KEY_INVALID`; rotation does not re-encrypt
archives. Losing the old offline key loses recovery of those archives.

## TLS certificates

**Change.** Web: certbot renews automatically and runs the installed hook.
For a forced renewal use `certbot renew --force-renewal --cert-name 'uai.<owner-domain>'`.
For internal leaves, renew at least 30 days before expiry (`TLS_CERT_EXPIRING`):

```sh
sudo bash /opt/unai/current/deploy/tls/issue-internal-ca.sh --renew-leaves
systemctl restart unai-api.service
systemctl reload postgresql
```

For a **new CA**, first stop timers and writers for a coordinated maintenance
window. Move both `ca.key` and `ca.pem` from `/etc/unai/tls/ca` to a new
root-only directory under `/root` (or offline storage), then re-run the issuer.
It never replaces an existing CA key; issuing a CA also re-issues both leaves.
Do not leave old private keys beside the public CA where the drill can read them.
Follow [the TLS issuer](tls/issue-internal-ca.sh) on interrupted issuance.

**Restart.** The issuer restarts nothing. For leaves, the commands above restart
API and reload PostgreSQL. The certbot hook restarts web, even if it was stopped.
For a new CA, reload PostgreSQL and restart API, web and worker; their database
pools read the CA at startup. The web API client reads `UNAI_API_CA_FILE` on each
request, but the web auth pool still requires restart. Require readiness before
restarting timers. Verify the actual leaf and expiry, not merely reload exit 0.

**Invalidated.** New connections reject expired or untrusted leaves. A new CA
requires clients to trust the new public CA; existing TLS connections can remain
until closed. Certificate renewal alone revokes neither sessions nor issuer keys.

## Data volume recovery passphrase

**Change.** With slot 1's current recovery passphrase available, run
`cryptsetup luksChangeKey --key-slot 1 '/dev/<volume-device>'` and enter the old
and new passphrases interactively. Verify the new one with
`cryptsetup open --test-passphrase --key-slot 1 '/dev/<volume-device>'`, then
replace the offline record. See [luksChangeKey](https://man7.org/linux/man-pages/man8/cryptsetup-luksChangeKey.8.html).

**Restart.** None; a mapped volume stays open. Keep the KMS-unlocked slot intact.

**Invalidated.** The old slot-1 passphrase no longer opens this header. This does
**not** rotate the volume encryption key or the KMS-wrapped unlocking key.
Old header backups may still accept the old passphrase; handle their custody
as part of the incident/recovery plan rather than claiming data re-encryption.
