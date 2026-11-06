# Uai single-owner deployment

This is the operator procedure for the three-process, in-process-TLS host in
[ADR 0043](../docs/adr/0043-production-deployment-target.md). It prepares real
infrastructure; a passing disposable test is not deployment or real-data proof.

Use a root Bash shell (`sudo -i`), with tracing and terminal recording **off**.
Replace every `<placeholder>` before running a command. Commands run from
`/opt/unai/current` once installed, except where stated. Type secrets with
`read -rs v` and pipe them using Bash's builtin `printf`, never put them in argv,
shell history, Git, tickets or logs. Use no swap, or encrypted swap. Stop on any
failed command; do not continue with partially written configuration.

| Bundle | Purpose |
| --- | --- |
| `deploy/install.sh` | Idempotent first install, no service activation |
| `deploy/aws/provision.sh` | Buckets and least-privilege IAM policies |
| `deploy/tls/issue-internal-ca.sh` | CA and API/PostgreSQL leaves |
| `deploy/postgres/unai.conf`, `deploy/postgres/pg_hba.conf` | Loopback TLS PostgreSQL |
| `deploy/postgres/provision.sql` | Roles, database and encryption declaration |
| `deploy/env/*.env.example` | Contract-derived non-secret configuration |
| `deploy/systemd/unai-*.service`, `deploy/systemd/unai-*.timer` | Supervision and scheduled recovery checks |
| `deploy/certbot-deploy-hook.sh` | Web certificate installation and restart |
| [rotate.md](rotate.md) | Rotation, restart and invalidation rules |

Order matters: PostgreSQL configuration needs the packages and mounted data
volume; worker identities exist only after first sign-in; timers start only
after the worker, because backup cleanup starts that worker.

## Before you start

Use Ubuntu Server 24.04 x86_64, UTC, a static IPv4, at least 2 vCPU/4 GB RAM
(8 GB recommended), and an attachable block volume at least 2.5 times the
database size, with room for evidence and backup staging. Keep an offline
place for the backup key and LUKS recovery passphrase.

DNS: A record `uai.<owner-domain>` to `<host-ipv4>`; no AAAA unless IPv6 works
end to end; CAA `0 issue "letsencrypt.org"`. Keep the current SSH session open
while enabling the firewall; if SSH uses a nonstandard port, allow it first.

```sh
timedatectl set-timezone UTC
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

In Google Cloud enable Gmail API and Google Calendar API. Create two clients:
**Uai sign-in**, Web application, origin `https://uai.<owner-domain>`, callback
`https://uai.<owner-domain>/api/auth/callback/google`, scopes `openid email profile`;
and **Uai connectors**, Desktop app. Use an Internal consent screen if eligible,
otherwise External, **In production**, not Testing; see [D6](../docs/adr/0043-production-deployment-target.md#d6-secrets-layout-and-handles).
In Anthropic Console create a workspace/key and set a monthly spend limit.
Prepare a selected-repository fine-grained GitHub PAT only if connecting GitHub.
Create customer-managed symmetric KMS keys `alias/unai-evidence` and
`alias/unai-pgdata` in `<aws-region>`, and `alias/unai-backup` in a different
`<backup-region>`, retaining their default key policies.

## AWS buckets and IAM users

On an administrator workstation with AWS CLI v2 and a checkout of the chosen
release, run this dry run, then the same command without `--dry-run`:

```sh
bash deploy/aws/provision.sh --region '<aws-region>' --backup-region '<backup-region>' \
  --bucket-prefix '<bucket-prefix>' --evidence-key-arn '<evidence-key-arn>' \
  --backup-key-arn '<backup-key-arn>' --pgdata-key-arn '<pgdata-key-arn>' \
  --host-ipv4 '<host-ipv4>' --dry-run
```

It converges evidence, backup and restore-drill buckets and five IAM users:
`unai-api`, `unai-worker`, `unai-backup`, `unai-host-unlock`, `unai-restore-drill`.
It creates no KMS or access keys. Refusals use `AWS_PROVISION_*`; do not broaden
policies to bypass them. Create each user's access key in IAM and place it in
the separate file specified under [Secrets](#secrets). The unlock key is needed
earlier, for the next section's volume setup.

## Install the release

On the host, obtain the tagged installer (install `git` first if absent):

```sh
apt-get update && apt-get install -y git
git clone --depth 1 --branch '<tag>' '<repo-url>' /root/uai-install
sudo bash /root/uai-install/deploy/install.sh --tag '<tag>' --repo '<repo-url>' --dry-run
sudo bash /root/uai-install/deploy/install.sh --tag '<tag>' --repo '<repo-url>'
cd /opt/unai/current
```

The installer pins Node/pnpm, builds, copies units/env examples, reloads systemd
and starts nothing. It defers PostgreSQL until the data volume is mounted.
Do not re-clone over an existing `/root/uai-install`; verify its tag instead.
Refusals: `INSTALL_USAGE`, `INSTALL_TAG_INVALID`, `INSTALL_ROOT_REQUIRED`,
`INSTALL_UNSUPPORTED_OS`, `INSTALL_UNSUPPORTED_ARCH`, `INSTALL_REPO_REQUIRED`,
`INSTALL_ALREADY_INSTALLED`, `INSTALL_RELEASE_MISMATCH`, `INSTALL_PGVECTOR_VERSION`,
`INSTALL_NODE_CHECKSUM_MISMATCH`, `INSTALL_TOOLCHAIN_MISMATCH`,
`INSTALL_UNITS_MISSING`, `INSTALL_DEPLOY_ROOT_DRY_RUN_ONLY`.
After a killed clone, `INSTALL_RELEASE_MISMATCH` requires inspecting the exact
`/opt/unai/releases/<tag>` path: remove that incomplete directory **only** when
`readlink -f /opt/unai/current` does not name it, then re-run. Never remove an
active release. An installed host uses [Upgrade](#upgrade), not a new install.

## Encrypted data volume

**Destructive, first install only:** verify the unused attached device with
`lsblk -f`; never format a device holding data. This bundle does **not** unlock
the volume at boot. No fstab or crypttab entry is installed. After each reboot,
unlock and mount as below, then `systemctl restart postgresql`, then restart
`unai-api` and `unai-worker`. Keep timers stopped until the mount is confirmed.
See [D4](../docs/adr/0043-production-deployment-target.md#d4-postgresql).

Install AWS CLI v2 using its [Linux installation procedure](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html);
`aws --version` must print `aws-cli/2.`. Install `cryptsetup` and make the key directory:

```sh
apt-get install -y cryptsetup
install -d -o root -g root -m 0700 /etc/unai/pgdata
```

Place the `unai-host-unlock` AWS credentials at `/etc/unai/pgdata/aws-credentials`
(root:root 0400), using the [Secrets](#secrets) AWS recipe. For **formatting only**,
use an administrator AWS profile via `AWS_PROFILE` on the single command below;
the unlock identity can decrypt but cannot generate keys. Remove that temporary
administrator profile from the host when formatting is complete.

```bash
(
  set -euo pipefail
  umask 0377
  test ! -e /etc/unai/pgdata/volume-key.enc
  test -b '/dev/<volume-device>'
  if cryptsetup isLuks '/dev/<volume-device>'; then
    printf 'VOLUME_ALREADY_FORMATTED\n' >&2
    exit 1
  fi
  material=$(AWS_PROFILE='<admin-profile>' aws kms generate-data-key \
    --region '<aws-region>' --key-id alias/unai-pgdata --number-of-bytes 64 \
    --query '[CiphertextBlob,Plaintext]' --output text)
  trap 'unset material ciphertext plaintext' EXIT
  read -r ciphertext plaintext <<< "$material"
  test -n "$ciphertext" && test -n "$plaintext"
  printf '%s' "$ciphertext" | base64 -d > /etc/unai/pgdata/volume-key.enc
  printf '%s' "$plaintext" | base64 -d | cryptsetup luksFormat --batch-mode \
    --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id \
    --key-file=- '/dev/<volume-device>'
)
```

One [GenerateDataKey call](https://docs.aws.amazon.com/cli/latest/reference/kms/generate-data-key.html)
supplies both halves. Plaintext travels only through shell memory and pipes;
only ciphertext reaches disk. If interrupted, preserve `volume-key.enc` and
inspect the device; do not generate a replacement key or blindly reformat.
Unlock now and after each reboot (the region is explicit):

```bash
set -o pipefail
AWS_SHARED_CREDENTIALS_FILE=/etc/unai/pgdata/aws-credentials AWS_EC2_METADATA_DISABLED=true \
  aws kms decrypt --region '<aws-region>' --key-id '<pgdata-key-arn>' \
  --ciphertext-blob fileb:///etc/unai/pgdata/volume-key.enc --query Plaintext --output text \
  | base64 -d | cryptsetup open --type luks2 --key-file=- '/dev/<volume-device>' unai-pgdata
```

Run `mkfs.ext4 -L unai-pgdata /dev/mapper/unai-pgdata` **once, only immediately
after this first successful format**; never on reboot. Then:

```sh
install -d -m 0755 /var/lib/postgresql
mount /dev/mapper/unai-pgdata /var/lib/postgresql
findmnt /var/lib/postgresql
```

Add the offline recovery passphrase to slot 1 once (Bash process substitution
keeps the existing key off disk; the new passphrase is prompted at the terminal):

```bash
cryptsetup luksAddKey --key-slot 1 --key-file <(
  AWS_SHARED_CREDENTIALS_FILE=/etc/unai/pgdata/aws-credentials AWS_EC2_METADATA_DISABLED=true \
    aws kms decrypt --region '<aws-region>' --key-id '<pgdata-key-arn>' \
    --ciphertext-blob fileb:///etc/unai/pgdata/volume-key.enc --query Plaintext --output text | base64 -d
) '/dev/<volume-device>'
```

Record the passphrase offline; verify it with `cryptsetup open --test-passphrase
--key-slot 1 '/dev/<volume-device>'`. Keep the D4 evidence (`cryptsetup status`,
`findmnt`, KMS ARN) with the deployment record, never the plaintext key. Re-run
the same installer/tag: it now installs PostgreSQL 17, pgvector and backup staging.
Only **after confirming the mount**, create drill staging:

```sh
sudo bash /root/uai-install/deploy/install.sh --tag '<tag>' --repo '<repo-url>'
install -d -o root -g root -m 0700 /var/lib/postgresql/unai-restore-drill-staging
```

## Internal CA and PostgreSQL

Issue leaves before enabling PostgreSQL TLS; otherwise PostgreSQL cannot start.

```sh
sudo bash /opt/unai/current/deploy/tls/issue-internal-ca.sh --dry-run
sudo bash /opt/unai/current/deploy/tls/issue-internal-ca.sh
install -o root -g root -m 0644 deploy/postgres/unai.conf /etc/postgresql/17/main/conf.d/unai.conf
install -o postgres -g postgres -m 0640 deploy/postgres/pg_hba.conf /etc/postgresql/17/main/pg_hba.conf
systemctl restart postgresql
```

The shipped pg_hba admits the five logins on `unai`, plus
`unai_restore_drill_<16 lowercase hex>` for `unai_migrator` and matching
`unai_restore_drill_probe_<16 lowercase hex>` login patterns, only with TLS,
SCRAM and `127.0.0.1/32`; local `postgres` uses peer authentication. Use
`127.0.0.1`, never `localhost`: there is no IPv6 admission. An invalid file
prevents startup; an invalid reload leaves the old rules active.

Create `/root/unai-provision.psql` as root:root 0600, once; generate each of
the five passwords using `openssl rand -hex 32`. A safe creation recipe is:

```bash
(
  set -euo pipefail
  umask 077
  set -o noclobber
  {
    for name in migrator_password api_login_password worker_login_password auth_login_password backup_password; do
      v=$(openssl rand -hex 32)
      printf "\\set %s '%s'\n" "$name" "$v"
      unset v
    done
    printf "\\set encryption_at_rest '%s'\n" 'volume-kms:<pgdata-key-arn>'
  } > /root/unai-provision.psql
)
cat /root/unai-provision.psql /opt/unai/current/deploy/postgres/provision.sql \
  | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -f -
```

Keep the variables file; re-running that pipeline is the password rotation path.
`PROVISION_VARIABLE_REQUIRED:<name>` refuses a missing input before changes.
Do not enable statement logging while provisioning; the script suppresses it
for its session. Re-use those passwords in the files below, never in commands.

## Secrets

[D6](../docs/adr/0043-production-deployment-target.md#d6-secrets-layout-and-handles)
defines separate api/web/worker mounts. The installer creates their directories
root:unai-\<process\> 0750, including `connectors/` and `aws/`. Use this recipe
for each runtime value, substituting the mount/name/process from the table:

```bash
read -rs v && printf '%s' "$v" | UNAI_SECRETS_MOUNT=/etc/unai/secrets/api pnpm secret:put '<name>'
unset v
chown 'root:unai-<process>' '<mount>/<name>'
chmod 0640 '<mount>/<name>'
```

Substitute the actual mount for `/etc/unai/secrets/api` as needed. Check the
command succeeded before changing modes. The CLI refuses terminal
stdin and existing files; it writes a fresh root-owned 0600 file. For a shared
secret, install its second copy with `install -o root -g unai-<other> -m 0640
'<source>' '<other-mount>/<name>'`; never share groups or broaden the mount.

| File below `/etc/unai/secrets/` | Content and issuer |
| --- | --- |
| `api/api-database-url` | `postgresql://unai_api_login:<password>@127.0.0.1:5432/unai`, provisioning |
| `worker/worker-database-url` | `postgresql://unai_worker_login:<password>@127.0.0.1:5432/unai`, provisioning |
| `api/auth-database-url`, `web/auth-database-url` | Same `postgresql://unai_auth_login:<password>@127.0.0.1:5432/unai`, provisioning |
| `web/nextauth-secret` | Generate with `openssl rand -hex 32`, pipe directly into the CLI |
| `web/google-signin-client-secret` | Google Cloud Uai sign-in secret |
| `api/google-connector-client`, `worker/google-connector-client` | One-line JSON `{"client_id":"<client-id>","client_secret":"<client-secret>"}`, Uai connectors Desktop app |
| `worker/anthropic-api-key` | Anthropic workspace key |
| `api/aws/credentials`, `worker/aws/credentials` | Distinct IAM keys for unai-api and unai-worker, not duplicate keys |
| `api/connectors/<name>`, `worker/connectors/<name>` | Matching per-connector tokens, installed in [Connectors](#connectors) |

AWS files contain `[default]`, `aws_access_key_id = <access-key-id>` and
`aws_secret_access_key = <secret-access-key>`. For each distinct IAM user,
capture both fields without echo, write its file (first creation only), then
apply the owner/mode in the table. Do this for the unlock user before volume setup.

```bash
(
  set -euo pipefail
  umask 077
  set -o noclobber
  trap 'unset id v' EXIT
  read -rs id
  read -rs v
  printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$v" > '<credentials-file>'
)
```

| Outside-mount file | Content / IAM user | Owner, mode |
| --- | --- | --- |
| `/root/.pgpass` | `127.0.0.1:5432:unai:unai_migrator:<password>` | root:root 0600 |
| `/etc/unai/backup/pgpass` | `127.0.0.1:5432:unai:unai_backup:<password>` | unai-backup:unai-backup 0600 |
| `/etc/unai/backup/aws-credentials` | unai-backup | unai-backup:unai-backup 0600 |
| `/etc/unai/restore-drill/pgpass` | `127.0.0.1:5432:*:unai_migrator:<password>` | root:root 0600 |
| `/etc/unai/restore-drill/aws-credentials` | unai-restore-drill | root:root 0600 |
| `/etc/unai/pgdata/aws-credentials` | unai-host-unlock | root:root 0400 |

Create `/etc/unai/restore-drill` using `install -d -o root -g root -m 0700`.
The drill pgpass needs database field `*` for per-run databases. Write each
pgpass with `read -rs v` and builtin `printf '127.0.0.1:5432:<database>:<role>:%s\n'
"$v" > '<pgpass-file>'` under `umask 077`, unset `v`, and apply its mode/owner.
The generated hex passwords need no pgpass escaping.

Create the backup key **only once**, and record its offline copy privately:

```bash
(
  set -euo pipefail
  umask 077
  set -o noclobber
  head -c 32 /dev/urandom > /etc/unai/backup/backup.key
  chown unai-backup:unai-backup /etc/unai/backup/backup.key
  chmod 0600 /etc/unai/backup/backup.key
)
base64 /etc/unai/backup/backup.key
stat -c '%U:%G %a %n' /root/.pgpass /etc/unai/backup/* /etc/unai/restore-drill/*
find /etc/unai/secrets -type f -exec stat -c '%U:%G %a %n' {} +
```

No other on-host copy of the backup key is allowed. Keep the offline copy and
LUKS recovery passphrase apart from this host and its archive bucket. Runtime
credentials are re-issued, not backed up. See [rotation](rotate.md).

## Environment files

The installer copies absent examples only, never over a filled file. Fill
`/etc/unai/api.env`, `/etc/unai/web.env`, `/etc/unai/worker.env`,
`/etc/unai/backup.env`, `/etc/unai/restore-drill.env` from the
[environment contract](../docs/operations/environment.md). All are root:root 0600.
`/etc/unai/migrate.env` is generated with a password-free migrator URL and
`UNAI_DATABASE_CA_FILE` (the canonical name, not the deprecated CA_PATH alias).
Registry ids wait for the next section; worker owner ids wait for first sign-in.
Use identical evidence region/bucket/key settings across API, worker and backup;
the drill uses its separate bucket and the evidence KMS key. Keep archive region,
destination and key path aligned between backup and drill. No refused variable
may be assigned, even empty. Quote values containing shell metacharacters when
they will be sourced; never leave placeholders in an active service.

```sh
grep -nE '^[A-Z0-9_]+=.*<' /etc/unai/*.env
```

This lists unfilled placeholders; exit 1 means none matched, not a failure.
Also review commented defaults, worker model pricing and purpose/sensitivity.

## Web certificate

With DNS propagated and port 80 free:

```sh
certbot certonly --standalone --key-type ecdsa -d 'uai.<owner-domain>'
RENEWED_LINEAGE='/etc/letsencrypt/live/uai.<owner-domain>' /etc/letsencrypt/renewal-hooks/deploy/unai-web.sh
```

The hook restarts (and can start) the web now; sign-in is usable only after
migration. `certbot.timer` runs the deploy hook on renewal. Confirm it is enabled
with `systemctl status certbot.timer`; the hook copies the pair to the web TLS
directory. No API TLS termination or trusted proxy headers are introduced.

## Migrate and publish the registry release

```sh
set -a; . /etc/unai/migrate.env; set +a
pnpm db:migrate
pnpm uai registry tags --require
pnpm uai registry publish --version '<x.y.z>'
```

The CLI uses `/root/.pgpass`, never a password in argv. `REGISTRY_TAGS_INCOMPLETE`
means the required local tags are absent or mismatched: follow owner-only
[Gate 3](../docs/operations/real-data-gates.md), including the named tag pushes,
then fetch those named tags into this release and re-check. No agent pushes tags
as part of this procedure. Copy `releaseId` from the publish PASS line to
`UNAI_REGISTRY_RELEASE_ID` and the version to `UNAI_REGISTRY_RELEASE` in API and
worker env files, as the contract requires. Publish is immutable; later changes
use the [registry migration runbook](../docs/operations/registry-migration.md).

## Preflight checks

Run as each unit's user, with its env file and dependency variables, not with
root's AWS identity. The API must be stopped so the probe-port test can bind:

```sh
systemd-run --wait --pipe --quiet --uid=unai-api --gid=unai-api \
  --working-directory=/opt/unai/current --property=EnvironmentFile=/etc/unai/api.env \
  --setenv=NODE_ENV=production --setenv=AWS_SHARED_CREDENTIALS_FILE=/etc/unai/secrets/api/aws/credentials \
  --setenv=AWS_EC2_METADATA_DISABLED=true /usr/local/bin/node --import tsx packages/api/src/server.ts --check
```

After the API starts in the next section, run the web check; before that its
`api` check can warn `API_UNREACHABLE` (not evidence of healthy connectivity):

```sh
systemd-run --wait --pipe --quiet --uid=unai-web --gid=unai-web \
  --working-directory=/opt/unai/current/apps/web --property=EnvironmentFile=/etc/unai/web.env \
  --setenv=NODE_ENV=production /usr/local/bin/node --import tsx server.ts --check
```

The worker check follows first sign-in below. Each preflight prints
`{"check":"<name>","status":"ok|warn|fail","code":"<CODE>"}`; exit 0 means
no failed check, not that warnings disappeared. `TLS_CERT_EXPIRING` warns
within 30 days. Each unit runs the same `--check` as ExecStartPre on every start.
These transient commands validate user/configuration access, not the complete
unit sandbox; the operator rehearsal must exercise the actual units too.

## Start the API and the web

```sh
systemctl enable --now unai-api.service
```

Wait for API `/readyz` below to report ready, then run the web preflight above
and `systemctl enable --now unai-web.service`. If the certificate hook already
started the web, restart it after any configuration changes. Keep worker and
timers stopped until the identities in the next sections are configured.

## Health and readiness

```sh
curl -fsS http://127.0.0.1:9101/healthz
curl -fsS http://127.0.0.1:9101/readyz
curl -fsS -o /dev/null -w '%{http_code}\n' \
  --resolve 'uai.<owner-domain>:443:127.0.0.1' 'https://uai.<owner-domain>/signin'
```

Liveness is `{"status":"ok"}`; readiness is
`{"status":"ready|not-ready","checks":{"<fixed name>":"ok|fail"}}`, with
status words only, not owner data. Never bypass certificate checks with `-k`.
Worker probes are on `127.0.0.1:9102` after startup below. Inspect JSON logs
with `journalctl -u '<unit>' -o cat` and failures with `systemctl --failed`.
See [D10](../docs/adr/0043-production-deployment-target.md#d10-health-probes-deviation).

## First sign-in, the worker and the timers

Sign in at `https://uai.<owner-domain>/signin`. Today any Google account that
completes sign-in receives its own empty owner scope; other rows are possible.
This is not a sign-in allowlist. Select the owner's actual row, never the first
row in the database. As postgres, read:

```sh
sudo -u postgres psql -X -d unai -At -c "SELECT m.owner_scope_id, m.user_id FROM owner_scope_members m JOIN users u ON u.id = m.user_id WHERE u.auth_email = '<owner-email>' AND m.role = 'OWNER' AND m.valid_to IS NULL"
```

Require exactly the intended live membership. Put the two ids into worker.env
as `UNAI_PROCESSING_OWNER_SCOPE_ID` and `UNAI_PROCESSING_ACTOR_ID`. Set
`UNAI_PROCESSING_DATA_PURPOSE` and `UNAI_PROCESSING_MAXIMUM_SENSITIVITY` explicitly
per [processing runtime](../docs/processing-runtime.md); do not broaden them
merely to make a check pass. With the worker still stopped:

```sh
systemd-run --wait --pipe --quiet --uid=unai-worker --gid=unai-worker \
  --working-directory=/opt/unai/current --property=EnvironmentFile=/etc/unai/worker.env \
  --setenv=NODE_ENV=production --setenv=AWS_SHARED_CREDENTIALS_FILE=/etc/unai/secrets/worker/aws/credentials \
  --setenv=AWS_EC2_METADATA_DISABLED=true /usr/local/bin/node --import tsx packages/api/src/processing-worker.ts --check
systemctl enable --now unai-worker.service
curl -fsS http://127.0.0.1:9102/readyz
systemctl enable --now unai-backup.timer unai-restore-drill.timer
systemctl list-timers 'unai-*'
```

Proceed past the curl only when ready. Persistent timers can catch up immediately:
an empty deployment's drill fails until the first evidence-bearing backup. Complete
the first sync and manual backup/drill below; never count an empty drill as PASS.

## Connectors

For Gmail and Calendar use [the connector procedure](../docs/connectors.md).
First, on your laptop: `ssh -L 8765:127.0.0.1:8765 '<host>'`. Keep that tunnel
open. On the host in `/opt/unai/current`, run the CLI as root, then open its
printed consent URL in the laptop browser:

```sh
sh -c 'set -a; . /etc/unai/api.env; set +a; pnpm connect:google --capabilities gmail.read_content,gmail.search --secret-name connectors/gmail --port 8765'
sh -c 'set -a; . /etc/unai/api.env; set +a; pnpm connect:google --capabilities calendar.read --secret-name connectors/calendar --port 8765'
```

Each ceremony writes one root-owned 0600 file. Fix permissions and install the
worker copy for **each** name, here `gmail` (repeat with `calendar`):

```sh
chown root:unai-api /etc/unai/secrets/api/connectors/gmail
chmod 0640 /etc/unai/secrets/api/connectors/gmail
install -o root -g unai-worker -m 0640 /etc/unai/secrets/api/connectors/gmail /etc/unai/secrets/worker/connectors/gmail
```

On Connected sources enter `secret://mounted/connectors/gmail` or the Calendar
equivalent and grant the selected capabilities. The CLI default is
`secret://mounted/connectors/google`; distinct names/ceremonies avoid sharing a
token between connector rows, but revoking a Google grant may still affect other
tokens for the same client/account. Recheck both after any disconnect.
`CONNECT_SCOPES_NOT_GRANTED`: grant every requested scope; if extra scopes persist,
remove Uai's access at `myaccount.google.com/permissions` and retry.
`invalid_grant` during sync: repeat the ceremony with `--replace`, then restore
0640 ownership and both copies. See [rotation](rotate.md#connector-tokens).

GitHub: create a fine-grained PAT with Metadata, Issues and Pull requests **read**,
selected repositories only, expiring within a year. Use the [Secrets](#secrets)
recipe with `pnpm secret:put connectors/github`, fix both mounts, and enter its
handle on Connected sources. Never grant an external write capability.

Omi is delivered: obtain a developer key restricted to `conversations:read`,
use `pnpm secret:put connectors/omi` with the same recipe and both mounts, then
connect with `secret://mounted/connectors/omi`. Follow [Omi's runbook](../docs/omi-connector.md).
Disconnect stops Uai ingestion but cannot revoke the key: revoke it yourself in
the Omi app under Settings > Developer. Live provider behavior still requires
the owner-only checks. After a first sync, take a backup and run the drill.

## Upgrade

Follow [ADR 0043 D12](../docs/adr/0043-production-deployment-target.md#d12-upgrade-and-rollback-order).
From `/opt/unai/current`, preview the plan, then run the same command without
`--dry-run`. Only the operator runs the real upgrade on the deployed host:

```sh
sudo bash deploy/upgrade.sh '<tag>' --dry-run
```

- `--repo <url>` overrides the current release's Git origin. Dry-run without it
  prints `<origin-url>` without invoking Git. Do not put credentials in the URL.
- `--registry-version x.y.z` changes the common API/worker registry pin. When it
  differs, publish creates the database release or returns the already-published
  ID, then rewrites only `UNAI_REGISTRY_RELEASE` and `UNAI_REGISTRY_RELEASE_ID` in
  `/etc/unai/api.env` and `/etc/unai/worker.env`, retaining root-only
  `<file>.pre-<tag>` copies. No flag, or the same version, leaves the pin untouched.
  The `registry-v<x.y.z>` tag must already be pushed; this is an
  [owner gate](../docs/operations/real-data-gates.md), not something the script does.
- `--dry-run` prints commands without executing or writing them. It validates
  installed files, not the unfetched release, database, credentials or readiness.

The script first stops previously active `unai-backup.timer` and
`unai-restore-drill.timer`, then refuses an active/activating backup or drill.
Stopping a timer does not stop its running service. D12 then runs in this order:

1. Fetch the tag into a **new** `/opt/unai/releases/<tag>`; verify its HEAD and any requested registry tag.
2. Run `pnpm install --frozen-lockfile`, `pnpm build`, then write the build-complete marker; check units and required env variables, naming missing variables without values, before stopping writers.
3. Stop the worker, then API (D11); leave web up.
4. Take the old release's backup using `node scripts/backup.mjs` in a transient unit as unai-backup, with its backup.env, pgpass and AWS settings; abort on failure.
5. Run `pnpm db:migrate` from the new release with migrate.env and `/root/.pgpass`.
6. Publish and re-pin only if `--registry-version` changes the pin.
7. Run all three new-release preflights as their service users (the web API warning is expected while API is stopped).
8. Atomically swap the relative current link; copy the new units and certbot hook, and reload systemd. Never enable units here.
9. Start API and check port 9101 readyz, restart web and check signin with `curl --resolve`, then start worker and check port 9102 readyz; each retry has a 120-second window and bounded individual curl requests. Restart previously active timers only after success.

Before migration, rollback re-points current, restarts the previous API/worker
if maintenance began, restarts the stopped timers, and removes the new release
directory this run created. An interrupted transient backup is stopped first.
Check any `rollback incomplete` warning; it does not promise services recovered.

**From migration on there is no automatic rollback.** Either
[restore the step-4 backup](../docs/operations/restore.md) into an empty database
and empty store, restore `.pre-<tag>` env files if the pin moved, re-point current
at the old release and reinstall/start its units; or fix forward. For a failed
preflight, correct the env file, rerun that check, then swap/start in D12 order.
Both timers stay stopped on D12-step failures: start them only after recovery and
readiness checks. The failed release directory is retained, so simply rerunning
the upgrade with the same tag is refused.

If D12 succeeds but the final timer restart fails or is interrupted, timer state
is **unknown** (a multi-unit start can partially succeed). The script reports
this separately; inspect both timers and backup/drill services before recovery.
An interrupted migration/preflight transient unit may still be running: inspect
systemd jobs before fixing forward, never race an unfinished migration.

Never `systemctl start unai-backup.service` during an upgrade: its ExecStopPost
starts the **current** release's API and worker. Do not run competing manual
backups/drills or edit the deployment while upgrading. Persistent timers may fire
a missed run immediately on restart. Old releases remain under `/opt/unai/releases`;
prune manually only when a release and its backup are no longer your rollback point.

## Backup and restore

The daily timer starts at 03:30 UTC plus a fixed per-host delay up to 10 minutes
(and systemd scheduling accuracy); Persistent catches missed runs. It enters
[D11 maintenance](../docs/adr/0043-production-deployment-target.md#d11-maintenance-mode-for-backups-definition):
worker stops first, then API; web stays up with unavailable states. Cleanup
attempts API then worker startup even on failure. A failed API check does not
prevent the worker start attempt; inspect `systemctl --failed`. The run timeout
is four hours and cleanup allows seven minutes for two 180-second starts.

**When intentionally holding writers down, stop both timers and let active runs
finish first.** Otherwise backup cleanup can undo the hold. Restore the timers
afterwards. Systemd serializes starts of each oneshot service, but a second CLI
process bypasses that protection: never run competing manual backups or drills
against shared staging. Drill database/prefix names are per-run; staging must
still be empty. Missing staging fails closed; never create it under an unmounted
data-volume mount point. Check free space before a run.

The backup service runs `node scripts/backup.mjs`, the same entry as `pnpm backup`:

```sh
systemctl start unai-backup.service
journalctl -u unai-backup.service -o cat -n 20
```

Require the completed PASS verdict, not merely an archive's existence. Archives
expire after 30 days, noncurrent versions after another 5; RPO target is 24 hours.
See [backup operations](../docs/operations/backup.md) for failures and key custody.

The drill runs monthly on the first Sunday at 05:00 UTC plus the fixed delay,
without maintenance; it restores the newest complete archive in its isolated
database and bucket prefix. The timer's later time is not a completion dependency
on a long-running backup. To run the same entry as `pnpm restore:drill`:

```sh
systemctl start unai-restore-drill.service
journalctl -u unai-restore-drill.service -o cat -n 20
```

Require `restore.drill.completed` with `verdict: PASS`; `restore.drill.failed`
carries a refusal code. The first drill requires at least one evidence item in
the newest archive: zero probe reads fail `RESTORE_DRILL_PROBES_EMPTY`. After
the first sync, manually run a backup, require PASS, then run the drill. A hard
kill can leave a database, role or prefix: use [Restore drill](../docs/operations/restore.md#restore-drill)
for verdict shape and exact cleanup; never delete by a broad prefix.

After loss, the operator runs `pnpm restore` as root per the
[restore procedure](../docs/operations/restore.md#procedure), using the offline key
and the contract's `### pnpm restore` variables, empty targets and operator-supplied
credentials. Replay newer deletions before any read. The scheduled drill is not
a production rollback, nor evidence that a specific host-loss recovery was done.

## Runbooks

- [Backup](../docs/operations/backup.md): archive preconditions and failure handling.
- [Restore](../docs/operations/restore.md): empty-target restore, verification and drill cleanup.
- [Deletion](../docs/operations/deletion.md): erasure and post-restore deletion replay.
- [Registry migration](../docs/operations/registry-migration.md): immutable release changes.
- [Projection rebuild](../docs/operations/projection-rebuild.md): governed replay.
- [Connector revocation](../docs/operations/connector-revocation.md): stop ingestion and revoke at the issuer.
- [Real-data gates](../docs/operations/real-data-gates.md): owner-only evidence, tags and live checks.
- [Rotation](rotate.md): every credential's copies, restart needs and invalidation.
